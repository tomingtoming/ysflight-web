// v2 milestone M7 smoke: Option-B URL self-fetch, B->A fallback, and the
// required-field obtain-failure UX.  Three cases, each with a fresh host+joiner
// (clean IDBFS) on its own pack-room:
//
//   1. B SUCCESS   host advertises a pack with a working sourceUrl; the joiner
//                  self-fetches it over HTTP and never touches the host P2P path.
//   2. B->A FALL   host advertises a DEAD sourceUrl; the joiner's URL fetch fails
//                  and it falls back to Option A (host P2P push), still installing.
//   3. FAIL UX     host advertises a REQUIRED field/scenery pack the joiner cannot
//                  obtain (no URL + a corrupted P2P transfer); instead of booting
//                  silently the joiner shows the Retry / Solo panel.  Retry re-runs
//                  the sync; Solo drops the join and boots single-player.
//
//   node scripts/smoke-mp-optb.mjs <baseUrl/index.html> <ws://sig/signal>
//
// Loopback WebRTC uses host candidates only (window.ysfwPackIce=[]) -> no STUN.
import { chromium } from 'playwright';
import { zipSync } from '../web/vendor/fflate.js';

const baseUrl = process.argv[2] || 'http://localhost:8938/index.html';
const sigUrl = process.argv[3] || 'ws://localhost:8939/signal';
const url = (extra) => baseUrl + '?signal=' + encodeURIComponent(sigUrl) + (extra ? '&' + extra : '');
const FATAL = [/Aborted\(/, /RuntimeError/];

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

function die(msg, logs) {
  console.error('SMOKE-MP-OPTB FAILED: ' + msg);
  if (logs) for (const l of logs.slice(-40)) console.error('  ' + l);
  process.exit(1);
}

async function newPage(initScripts) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.addInitScript(() => { window.ysfwPackIce = []; }); // host-only ICE -> deterministic loopback
  for (const fn of initScripts || []) await p.addInitScript(fn);
  const logs = [];
  p.on('console', (m) => logs.push(m.text()));
  p.on('pageerror', (e) => logs.push('PAGEERR ' + e.message));
  return { p, logs };
}

const ready = (h, who) =>
  h.p.waitForFunction(() => window.ysfwPacks && window.ysfwPacks.fsReady && window.ysfwPackNet, { timeout: 60000 })
    .catch(() => die(who + ': pack layer not ready', h.logs));

async function waitForLog(h, re, ms, who) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (h.logs.some((l) => re.test(l))) return;
    await h.p.waitForTimeout(150);
  }
  die(who + ': timed out waiting for ' + re, h.logs);
}
const hasLog = (h, re) => h.logs.some((l) => re.test(l));
const countLog = (h, re) => h.logs.filter((l) => re.test(l)).length;

async function listIds(h) {
  return h.p.evaluate(async () => {
    try { return (await window.ysfwPacks.list()).map((p) => p.id); } catch (e) { return null; }
  }).catch(() => null);
}

// Spin up a host that installs a pack (installFn(arg) -> id, run in the page) and
// advertises it on the pack-room for `room` via the SAME wiring index.html uses
// while hosting (setting ysfwRtc.host starts the shell-owned pack host, which
// publishes the manifest with its room claim).  Returns the host page handle + id.
async function startHost(room, installFn, installArg, who) {
  const h = await newPage();
  await h.p.goto(url());
  await ready(h, who);
  const hostId = await h.p.evaluate(installFn, installArg);
  await h.p.evaluate((r) => { globalThis.ysfwRtc = { host: { room: r, ok: true, failed: false } }; }, room);
  await waitForLog(h, /hosting /, 15000, who);
  return { h, hostId };
}

// ===== Case 1: Option B success (joiner self-fetches the URL, no P2P) =========
{
  const ROOM = 'optb0001';
  const { h: host, hostId } = await startHost(ROOM, async () => {
    const r = await fetch('/test-pack.zip');
    // Advertise a WORKING same-origin URL so the joiner self-fetches it.
    return (await window.ysfwPacks.installFromBytes(
      new Uint8Array(await r.arrayBuffer()), 'toming', location.origin + '/test-pack.zip')).id;
  }, null, 'case1 host');
  console.log('case1 host advertising ' + hostId + ' with a working sourceUrl');

  const join = await newPage();
  await join.p.goto(url('join=' + ROOM + '&name=Tester'));
  await waitForLog(join, /\[pack-net join\] pre-boot sync:/, 90000, 'case1 join');
  if (!hasLog(join, new RegExp('installed ' + hostId + ' via URL'))) die('case1: Option B path not taken (no "via URL" log)', join.logs);
  const ids = await listIds(join);
  if (!ids || !ids.includes(hostId)) die('case1: joiner did not install via URL: ' + JSON.stringify(ids), join.logs);
  // The joiner must RECORD the sourceUrl on its self-fetched pack so that, if it
  // later hosts, it can re-advertise the URL and offload its own joiners (the
  // Option-B chain must survive past one hop).
  // Read sourceUrl through the SAME function a re-hosting joiner uses to re-advertise
  // (packMetaForHost -> durable OPFS record), NOT a MEMFS packs/<id>/manifest.json:
  // under the lazy-pack scheme the install path keeps geometry (and the manifest) in
  // OPFS until materialized and never writes that MEMFS file, so a Module.FS probe
  // spuriously ENOENTs even though the Option-B chain is intact.  This asserts the
  // real chain — exactly what startPackHost reads to re-advertise the URL.
  const joinerUrl = await join.p.evaluate(async (id) => {
    try {
      const meta = await window.ysfwPacks.packMetaForHost(id);
      return (meta && meta.sourceUrl) || null;
    } catch (e) { return 'ERR:' + e; }
  }, hostId);
  if (!joinerUrl || !/test-pack\.zip/.test(joinerUrl)) die('case1: joiner did not record sourceUrl on its self-fetched pack (chain breaks): ' + joinerUrl, join.logs);
  if (hasLog(host, /serving pack/)) die('case1: host served bytes P2P though Option B should have offloaded it', host.logs);
  if (hasLog(join, /falling back to host push/)) die('case1: joiner fell back to A but B should have succeeded', join.logs);
  if (join.logs.some((l) => FATAL.some((re) => re.test(l)))) die('case1: fatal during join', join.logs);
  console.log('CASE 1 OK: Option B self-fetch installed ' + hostId + ' from URL; host P2P untouched');
  await host.p.context().close();
  await join.p.context().close();
}

// ===== Case 2: Option B fails -> Option A (host P2P push) fallback ============
{
  const ROOM = 'optb0002';
  const { h: host, hostId } = await startHost(ROOM, async () => {
    const r = await fetch('/test-pack.zip');
    // Advertise a DEAD URL: the joiner's self-fetch 404s and must fall back to A.
    return (await window.ysfwPacks.installFromBytes(
      new Uint8Array(await r.arrayBuffer()), 'toming', location.origin + '/no-such-pack.zip')).id;
  }, null, 'case2 host');
  console.log('case2 host advertising ' + hostId + ' with a dead sourceUrl');

  const join = await newPage();
  await join.p.goto(url('join=' + ROOM + '&name=Tester'));
  await waitForLog(join, /\[pack-net join\] pre-boot sync:/, 90000, 'case2 join');
  if (!hasLog(join, new RegExp('Option B failed for ' + hostId))) die('case2: expected an Option B failure log', join.logs);
  if (!hasLog(join, /falling back to host push/)) die('case2: expected an A fallback log', join.logs);
  if (!hasLog(host, new RegExp('serving pack ' + hostId))) die('case2: host did not serve the pack P2P (A fallback did not happen)', host.logs);
  const ids = await listIds(join);
  if (!ids || !ids.includes(hostId)) die('case2: joiner did not install via A fallback: ' + JSON.stringify(ids), join.logs);
  if (join.logs.some((l) => FATAL.some((re) => re.test(l)))) die('case2: fatal during join', join.logs);
  console.log('CASE 2 OK: Option B 404 -> Option A host push installed ' + hostId);
  await host.p.context().close();
  await join.p.context().close();
}

// ===== Case 3: required field cannot be obtained -> Retry / Solo UX ===========
{
  const ROOM = 'optb0003';
  // A minimal but real SCENERY pack (categorized 'scenery' => REQUIRED), built
  // here with fflate and installed in the host browser from bytes (no sourceUrl,
  // so Option B is skipped and the joiner must use Option A).
  const fieldZip = zipSync({
    'scenery/scefield.lst': new TextEncoder().encode('TESTFIELD scenery/f.fld scenery/f.stp\n'),
    'scenery/f.fld': new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
    'scenery/f.stp': new Uint8Array([8, 9, 10, 11]),
  }, { level: 0 });
  const fieldBytes = Array.from(fieldZip);

  const { h: host, hostId } = await startHost(ROOM, async (bytes) =>
    (await window.ysfwPacks.installFromBytes(new Uint8Array(bytes), 'testfield')).id, fieldBytes, 'case3 host');
  const cat = await host.p.evaluate(async () => (await window.ysfwPacks.list())[0].categories);
  if (!cat || !cat.includes('scenery')) die('case3: host pack is not scenery (required): ' + JSON.stringify(cat), host.logs);
  console.log('case3 host advertising REQUIRED scenery pack ' + hostId);

  // Joiner with a corrupted transfer -> Option A install fails -> required field
  // unobtained -> the obtain-failure panel must appear (not a silent boot).
  const join = await newPage([() => { window.__ysfwPackCorrupt = true; }]);
  await join.p.goto(url('join=' + ROOM + '&name=Tester'));
  await join.p.waitForFunction(() => !!document.getElementById('ysfw-join-failure'), { timeout: 90000 })
    .catch(() => die('case3: obtain-failure panel never appeared', join.logs));
  const ux = await join.p.evaluate(() => {
    const panel = document.getElementById('ysfw-join-failure');
    return {
      retry: !!document.getElementById('ysfw-join-retry'),
      solo: !!document.getElementById('ysfw-join-solo'),
      text: panel ? panel.textContent : '',
    };
  });
  if (!ux.retry || !ux.solo) die('case3: panel missing Retry/Solo buttons: ' + JSON.stringify(ux), join.logs);
  if (!/testfield/.test(ux.text)) die('case3: panel does not name the failed required field: ' + ux.text, join.logs);
  console.log('case3 obtain-failure panel shown with Retry/Solo, names "testfield"');

  // Retry must re-run the sync (still corrupt -> panel reappears).
  const before = countLog(join, /pre-boot sync:/);
  await join.p.click('#ysfw-join-retry');
  {
    const t0 = Date.now();
    while (countLog(join, /pre-boot sync:/) <= before) {
      if (Date.now() - t0 > 60000) die('case3: Retry did not re-run the sync', join.logs);
      await join.p.waitForTimeout(150);
    }
  }
  await join.p.waitForFunction(() => !!document.getElementById('ysfw-join-failure'), { timeout: 90000 })
    .catch(() => die('case3: panel did not reappear after a failed Retry', join.logs));
  console.log('case3 Retry re-ran the sync and re-showed the panel');

  // Solo must drop the join and boot single-player (overlay hides, no -client).
  const stillClient = await join.p.evaluate(() => (window.Module && Module.arguments || []).indexOf('-client') >= 0);
  if (!stillClient) die('case3: expected -client args before Solo', join.logs);
  await join.p.click('#ysfw-join-solo');
  await join.p.waitForFunction(() => { const ov = document.getElementById('overlay'); return ov && ov.classList.contains('hidden'); }, { timeout: 90000 })
    .catch(() => die('case3: Solo did not boot the engine (overlay still visible)', join.logs));
  const afterClient = await join.p.evaluate(() => (window.Module && Module.arguments || []).indexOf('-client') >= 0);
  if (afterClient) die('case3: Solo booted but kept the -client join args (not single-player)', join.logs);
  if (join.logs.some((l) => FATAL.some((re) => re.test(l)))) die('case3: fatal after Solo boot', join.logs);
  console.log('CASE 3 OK: required-field failure showed Retry/Solo; Retry re-ran; Solo booted single-player');
  await host.p.context().close();
  await join.p.context().close();
}

// ===== Case 4: a BEST-EFFORT (aircraft) failure must NOT hold the gate ========
// Field-first means ONLY required (field/scenery) failures stop the boot; a
// failed aircraft/ground pack degrades to an engine substitute and the join
// proceeds.  This guards against a regression to "ANY failure holds the gate".
{
  const ROOM = 'optb0004';
  const { h: host, hostId } = await startHost(ROOM, async () => {
    const r = await fetch('/test-pack.zip'); // testpack.zip == aircraft (best-effort), no sourceUrl
    return (await window.ysfwPacks.installFromBytes(new Uint8Array(await r.arrayBuffer()), 'toming')).id;
  }, null, 'case4 host');
  const cat = await host.p.evaluate(async () => (await window.ysfwPacks.list())[0].categories);
  if (cat && cat.includes('scenery')) die('case4: fixture is scenery; need a best-effort (aircraft) pack', host.logs);
  console.log('case4 host advertising BEST-EFFORT pack ' + hostId + ' (categories ' + JSON.stringify(cat) + ')');

  // Corrupt the transfer so Option A fails; because the pack is best-effort the
  // gate must still release and the engine must boot (no failure panel).
  const join = await newPage([() => { window.__ysfwPackCorrupt = true; }]);
  await join.p.goto(url('join=' + ROOM + '&name=Tester'));
  await waitForLog(join, /\[pack-net join\] pre-boot sync:/, 90000, 'case4 join');
  const panelUp = await join.p.evaluate(() => !!document.getElementById('ysfw-join-failure'));
  if (panelUp) die('case4: obtain-failure panel appeared for a BEST-EFFORT pack (should not hold the gate)', join.logs);
  // The corrupt FULL pull MUST have failed — that is the failure path this case guards.
  // Under metadata-first a best-effort pack whose full pull failed may STILL surface via
  // a SPARSE meta-bundle install (menu complete, geometry deferred), by design, so
  // "appears in list()" is no longer a valid proxy for "fully installed".  Assert on the
  // sync result's installed[] (full installs) instead, which corruption must keep empty.
  const sync = (() => {
    const line = [...join.logs].reverse().find((l) => /pre-boot sync:/.test(l));
    try { return line ? JSON.parse(line.slice(line.indexOf('{'))) : null; } catch (e) { return null; }
  })();
  if (!sync) die('case4: could not read the pre-boot sync result', join.logs);
  if ((sync.installed || []).includes(hostId)) die('case4: corrupt FULL transfer was fully installed; failure path not exercised', join.logs);
  console.log('case4 corrupt full pull failed as designed (installed=' + JSON.stringify(sync.installed) + ' metaInstalled=' + JSON.stringify(sync.metaInstalled) + ')');
  await join.p.waitForFunction(() => { const ov = document.getElementById('overlay'); return ov && ov.classList.contains('hidden'); }, { timeout: 90000 })
    .catch(() => die('case4: gate did not release on a best-effort failure (engine never booted)', join.logs));
  if (join.logs.some((l) => FATAL.some((re) => re.test(l)))) die('case4: fatal after best-effort-failure boot', join.logs);
  console.log('CASE 4 OK: best-effort pack failure released the gate and booted (no panel)');
  await host.p.context().close();
  await join.p.context().close();
}

console.log('SMOKE-MP-OPTB PASSED');
await browser.close();
