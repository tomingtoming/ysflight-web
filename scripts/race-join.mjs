// Differential test for the WARM-CACHE module-load race fix (index.html preRun).
//
// Simulates the warm-cache condition: the engine's preRun runs BEFORE the deferred
// <script type="module"> files (packs-ui.js -> window.ysfwPacks, pack-net.js ->
// window.ysfwPackNet) have executed.  We force this by DELAYING those two module
// responses on the joiner by ~3.5s via route().
//
//   - BEFORE the fix: runJoinSync sees window.ysfwPackNet undefined and takes the
//     `Promise.resolve(null)` branch -> the boot gate releases in ~2ms, the join
//     sync NEVER runs, and the joiner boots with ZERO host packs.
//   - AFTER the fix: whenModule() polls until the module publishes its API, THEN
//     calls syncAsJoiner -> the pack is installed before boot.
//
// PASS == the `[pack-net join] pre-boot sync:` log appears AND the host pack ends
// up installed, despite the delayed modules.
//
//   node scripts/race-join.mjs <baseUrl/index.html> <ws://sig/signal>
import { chromium } from 'playwright';

const baseUrl = process.argv[2] || 'http://localhost:8936/index.html';
const sigUrl = process.argv[3] || 'ws://localhost:8937/signal';
const ROOM = 'racemp01';
const DELAY_MS = 3500;
const url = (extra) => baseUrl + '?signal=' + encodeURIComponent(sigUrl) + (extra ? '&' + extra : '');
const FATAL = [/Aborted\(/, /RuntimeError/];

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

function die(msg, logs) {
  console.error('RACE-JOIN FAILED: ' + msg);
  if (logs) for (const l of logs.slice(-40)) console.error('  ' + l);
  process.exit(1);
}

async function newPage(delayModules) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.addInitScript(() => { window.ysfwPackIce = []; }); // host-only ICE for deterministic loopback
  if (delayModules) {
    // Delay ONLY the pack modules so the engine (cached .data, instant) wins the
    // boot race exactly like a warm cache does in production.
    await ctx.route('**/packs-ui.js', async (route) => { await new Promise((r) => setTimeout(r, DELAY_MS)); route.continue(); });
    await ctx.route('**/pack-net.js', async (route) => { await new Promise((r) => setTimeout(r, DELAY_MS)); route.continue(); });
  }
  const logs = [];
  p.on('console', (m) => logs.push(m.text()));
  p.on('pageerror', (e) => logs.push('PAGEERR ' + e.message));
  return { p, logs };
}

async function waitForLog(h, re, ms, who) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (h.logs.some((l) => re.test(l))) return;
    await h.p.waitForTimeout(200);
  }
  die(who + ': timed out waiting for ' + re, h.logs);
}
const listIds = (h) =>
  h.p.evaluate(async () => { try { return (await window.ysfwPacks.list()).map((p) => p.id); } catch (e) { return null; } }).catch(() => null);

// ---- HOST: install + advertise the test pack (no module delay) ----------------
const host = await newPage(false);
await host.p.goto(url());
await host.p.waitForFunction(() => window.ysfwPacks && window.ysfwPacks.fsReady && window.ysfwPackNet, { timeout: 60000 })
  .catch(() => die('host: pack layer not ready', host.logs));
const hostId = await host.p.evaluate(async () => {
  const r = await fetch('/test-pack.zip');
  return (await window.ysfwPacks.installFromBytes(new Uint8Array(await r.arrayBuffer()), 'toming')).id;
});
await host.p.evaluate((room) => { globalThis.ysfwRtc = { host: { room, ok: true, failed: false } }; }, ROOM);
await waitForLog(host, /hosting /, 15000, 'host');
console.log('host advertising pack ' + hostId + ' on the pack-room for ' + ROOM);

// ---- JOINER with DELAYED modules (warm-cache race simulation) ------------------
const t0 = Date.now();
const join = await newPage(true);
await join.p.goto(url('join=' + ROOM + '&name=Racer'));
await waitForLog(join, /\[pack-net join\] pre-boot sync:/, 90000, 'join');
const syncAt = Date.now() - t0;
const ids = await listIds(join);
if (!ids || !ids.includes(hostId)) die('joiner did NOT install host pack under delayed-module race: ' + JSON.stringify(ids), join.logs);
if (join.logs.some((l) => FATAL.some((re) => re.test(l)))) die('fatal output during delayed-module join', join.logs);
// Sanity: the sync must have happened AFTER the module delay (i.e. it genuinely
// waited), not instantly — otherwise the test is not exercising the race path.
if (syncAt < DELAY_MS - 500) die('sync completed before the module delay elapsed (' + syncAt + 'ms) — race not actually simulated', join.logs);
console.log('RACE-JOIN OK: pre-boot sync waited for delayed modules (~' + syncAt + 'ms) and installed pack ' + hostId);
console.log('RACE-JOIN PASSED');
await browser.close();
