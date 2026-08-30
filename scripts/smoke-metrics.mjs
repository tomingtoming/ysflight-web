// Usage-metrics smoke test: proves the counter actually fires in a real browser.
//
//   node scripts/smoke-metrics.mjs <index-url> [timeoutMs]
//
// The chain under test is web/diag.js (the one poller that watches
// globalThis.ysfwInFlight) -> its subscriber web/metrics.js -> POST /metric ->
// Analytics Engine.  Unit tests (test/metrics.test.mjs) cover the two ends;
// what only a browser can show is that the middle is CONNECTED -- that the
// subscription fires, the batch timer flushes, and the payload carries the
// fields the SQL in docs/metrics.md selects on.
//
// This is the guard against the failure mode that matters for a metric: it
// stops counting and nothing looks wrong.  A dashboard reading zero is
// indistinguishable from nobody playing.
//
// No engine boot: with no deep link, index.html holds at the pack panel, so
// the flight flag is flipped directly.  Whether the ENGINE sets that flag is
// what the mission/create-flight/host smokes already prove.
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:8931/index.html';
const timeoutMs = parseInt(process.argv[3] || '20000', 10);

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

const posted = [];   // every event of every /metric batch, in order
const batches = [];
await context.route('**/metric', async (route, request) => {
  try {
    const body = JSON.parse(request.postData() || '{}');
    batches.push(body);
    for (const ev of body.events || []) posted.push({ ...ev, _vid: body.vid, _sid: body.sid, _aud: body.aud, _build: body.build });
  } catch (e) { /* recorded as a missing event below */ }
  await route.fulfill({ status: 204, body: '' });
});

const page = await context.newPage();
const fatal = [];
page.on('pageerror', (e) => fatal.push('[pageerror] ' + e.message));

function die(msg) {
  console.error('SMOKE-METRICS FAILED: ' + msg);
  for (const f of fatal.slice(0, 10)) console.error('  ' + f);
  console.error('--- events seen (' + posted.length + ') ---');
  for (const p of posted) console.error('  ' + JSON.stringify(p));
  process.exit(1);
}

// Wait until an event matching `pred` has been POSTed.
async function waitFor(what, pred) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = posted.find(pred);
    if (hit) return hit;
    await page.waitForTimeout(250);
  }
  die('no ' + what + ' event was posted within ' + timeoutMs + 'ms');
}

// ---- 1. arriving on the page is one session ---------------------------------
await page.goto(base);
await page.waitForFunction(() => !!(globalThis.ysfwMetrics && globalThis.ysfwMetrics.sid), { timeout: 30000 })
  .catch(() => die('metrics.js never wired up (ysfwMetrics.sid missing)'));

const session = await waitFor('session', (e) => e.e === 'session');
if (session.visits !== 1) die('first visit should report visits=1, got ' + session.visits);
if (session.launch !== 'menu') die('a bare load should report launch=menu, got ' + session.launch);
if (session._aud !== 'public') die('default audience should be public, got ' + session._aud);
if (!session._vid || !session._sid) die('session carried no visitor/session id');
if (!session._build) die('session carried no build id (ASSET read too early?)');

// ---- 2. a flight is counted at both ends, with a duration --------------------
await page.evaluate(() => { globalThis.ysfwInFlight = true; });
const start = await waitFor('flight-start', (e) => e.e === 'flight-start');
if (start._sid !== session._sid) die('flight-start belongs to a different session id');
await page.waitForTimeout(3000);
await page.evaluate(() => { globalThis.ysfwInFlight = false; });
const end = await waitFor('flight-end', (e) => e.e === 'flight-end');
if (!(end.secs >= 2)) die('flight-end reported ' + end.secs + 's for a ~3s flight');
if (end.reason !== 'ended') die('flight-end reason should be "ended", got ' + end.reason);

// ---- 2b. time spent hidden does not count as flight time --------------------
// The chain: diag.js's visibilitychange listener -> its 'vis' breadcrumb ->
// metrics.js's accumulator -> the `hidden` field on the wire.  Unit tests drive
// onDiag() directly, so this is the only place the LISTENER is proven wired.
//
// visibilityState is a readonly accessor, so a plain assignment is silently a
// no-op (same trap as navigator.xr in the VR probes) -- it has to be replaced
// with defineProperty.  What this does NOT prove is that a real browser fires
// the event when a tab is backgrounded; that is spec behaviour, and headless
// Chromium will not actually hide a page (bringToFront leaves it 'visible').
const setHidden = (hidden) => page.evaluate((h) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
  document.dispatchEvent(new Event('visibilitychange'));
}, hidden);

const beforeHiddenFlight = posted.length;
await page.evaluate(() => { globalThis.ysfwInFlight = true; });
await waitFor('second flight-start', (e, i) => i >= beforeHiddenFlight && e.e === 'flight-start');
await page.waitForTimeout(2000);
await setHidden(true);
await page.waitForTimeout(4000);
await setHidden(false);
await page.waitForTimeout(2000);
await page.evaluate(() => { globalThis.ysfwInFlight = false; });
const hiddenEnd = await waitFor('second flight-end', (e, i) => i >= beforeHiddenFlight && e.e === 'flight-end');
if (typeof hiddenEnd.hidden !== 'number') die('flight-end carried no `hidden` field (double7 would be silently 0)');
if (!(hiddenEnd.hidden >= 3 && hiddenEnd.hidden <= 6)) die('~4s hidden was reported as ' + hiddenEnd.hidden + 's');
if (!(hiddenEnd.secs >= 3 && hiddenEnd.secs <= 6)) die('~4s of visible flight was reported as ' + hiddenEnd.secs + 's (hidden time not subtracted?)');

// ---- 3. the same browser coming back is the SAME visitor ---------------------
// This is the whole point of the localStorage id: it separates "ten visits by
// one person" from "ten people".
const before = posted.length;
await page.goto(base + (base.includes('?') ? '&' : '?') + 'again=1');
const second = await waitFor('second session', (e, i) => i >= before && e.e === 'session');
if (second._vid !== session._vid) die('visitor id changed across a reload');
if (second.visits !== 2) die('a returning browser should report visits=2, got ' + second.visits);

// ---- 4. ?metrics=off really is off ------------------------------------------
// Last, because the opt-out is sticky by design.
const beforeOff = posted.length;
await page.goto(base + (base.includes('?') ? '&' : '?') + 'metrics=off');
await page.waitForFunction(() => !!globalThis.ysfwMetrics, { timeout: 30000 }).catch(() => {});
await page.evaluate(() => { globalThis.ysfwInFlight = true; });
await page.waitForTimeout(6000);
if (posted.length !== beforeOff) die('?metrics=off still posted ' + (posted.length - beforeOff) + ' event(s)');

await browser.close();
if (fatal.length) die('page errors during the run');
console.log(`batches=${batches.length} events=${posted.length}`);
console.log(`visitor=${session._vid} build=${session._build} flight=${end.secs}s`);
console.log(`backgrounded flight: flown=${hiddenEnd.secs}s hidden=${hiddenEnd.hidden}s (hidden must not be billed as flight time)`);
console.log('SMOKE-METRICS PASSED');
