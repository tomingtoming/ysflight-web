// MP scenery-pack sync smoke: the reported failure mode is a host selecting a
// FIELD from an add-on pack — a joiner without that pack cannot pick an
// aircraft, a start position, or fly (the engine's ReceiveLoadField fails and
// the client is dead in the water).  This drives the fix end-to-end:
//
//   1. host installs a scenery-only pack (test-unique field YSFW_TEST_OCEAN)
//      and advertises it on the derived pack-room (production wiring);
//   2. a joiner opens the invite link WITH the pack-sync opt-in
//      (?join=<room>&packsync=1) and must receive + install the pack during
//      the pre-boot gate;
//   3. the joiner then boots straight into a flight ON the pack's field —
//      "Field:YSFW_TEST_OCEAN" is printed only when the engine resolved and
//      loaded the field, i.e. exactly the piece a vanilla joiner was missing.
//
//   node scripts/smoke-mp-scenery.mjs <baseUrl/index.html> <ws://sig/signal>
//
// Loopback WebRTC uses host candidates only (window.ysfwPackIce=[]) so it needs
// no STUN/internet.  Signaling is the local sig-stub.
import { chromium } from 'playwright';

const baseUrl = process.argv[2] || 'http://localhost:8938/index.html';
const sigUrl = process.argv[3] || 'ws://localhost:8939/signal';
const ROOM = 'scnmp001';
const FIELD = 'YSFW_TEST_OCEAN';
const AIRCRAFT = 'F-16C_FIGHTINGFALCON'; // stock — the pack carries scenery only
const START = 'NORTH10000_01';           // airborne start present in ocean.stp
const url = (extra) => baseUrl + '?signal=' + encodeURIComponent(sigUrl) + (extra ? '&' + extra : '');
const FATAL = [/Aborted\(/, /RuntimeError/];

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

function die(msg, logs) {
  console.error('SMOKE-MP-SCENERY FAILED: ' + msg);
  if (logs) for (const l of logs.slice(-30)) console.error('  ' + l);
  process.exit(1);
}

async function newPage() {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.addInitScript(() => { window.ysfwPackIce = []; }); // host-only ICE for deterministic loopback
  const logs = [];
  p.on('console', (m) => logs.push(m.text()));
  p.on('pageerror', (e) => logs.push('PAGEERR ' + e.message));
  return { p, logs };
}

const ready = (h, who) =>
  h.p
    .waitForFunction(() => window.ysfwPacks && window.ysfwPacks.fsReady && window.ysfwPackNet, { timeout: 60000 })
    .catch(() => die(who + ': pack layer not ready', h.logs));

async function waitForLog(h, re, ms, who) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (h.logs.some((l) => re.test(l))) return;
    await h.p.waitForTimeout(200);
  }
  die(who + ': timed out waiting for ' + re, h.logs);
}

const overlayHidden = (h, who, ms) =>
  h.p
    .waitForFunction(() => { const ov = document.getElementById('overlay'); return ov && ov.classList.contains('hidden'); }, { timeout: ms })
    .catch(() => die(who + ': engine did not boot (overlay still visible)', h.logs));

// ---- HOST: install the scenery pack, then advertise it (production wiring) ----
const host = await newPage();
await host.p.goto(url());
await ready(host, 'host');
const hostId = await host.p.evaluate(async () => {
  const r = await fetch('/test-scnpack.zip');
  return (await window.ysfwPacks.installFromBytes(new Uint8Array(await r.arrayBuffer()), 'scnpack')).id;
});
await host.p.evaluate((room) => { globalThis.ysfwRtc = { host: { room, ok: true, failed: false } }; }, ROOM);
await waitForLog(host, /hosting /, 15000, 'host');
console.log('host advertising scenery pack ' + hostId + ' on the pack-room for ' + ROOM);

// ---- JOINER: invite link with the pack-sync opt-in must deliver the pack -----
const join = await newPage();
await join.p.goto(url('join=' + ROOM + '&name=Tester&packsync=1'));
await waitForLog(join, /\[pack-net join\] pre-boot sync:/, 90000, 'join');
const ids = await join.p
  .evaluate(async () => { try { return (await window.ysfwPacks.list()).map((p) => p.id); } catch (e) { return null; } })
  .catch(() => null);
if (!ids || !ids.includes(hostId)) die('joiner did not install the host scenery pack via ?join pre-boot sync: ' + JSON.stringify(ids), join.logs);
if (join.logs.some((l) => FATAL.some((re) => re.test(l)))) die('fatal output during join pre-boot sync', join.logs);
console.log('JOIN OK: scenery pack ' + hostId + ' installed on the joiner pre-boot');

// ---- ENGINE LOAD: the joiner can fly ON the pack's field ----------------------
// This is the exact capability the reported bug denies a vanilla joiner: the
// engine resolving the pack field by name and loading its .fld.
join.logs.length = 0;
await join.p.goto(url('freeflight=' + AIRCRAFT + ',' + FIELD + ',' + START));
await overlayHidden(join, 'join-freeflight', 90000);
{
  const t0 = Date.now();
  let fieldLoaded = false, airLoaded = false;
  while (Date.now() - t0 < 30000 && !(fieldLoaded && airLoaded)) {
    fieldLoaded = fieldLoaded || join.logs.some((l) => new RegExp('Field:\\s*' + FIELD).test(l));
    airLoaded = airLoaded || join.logs.some((l) => new RegExp('Airplane:\\s*' + AIRCRAFT).test(l));
    await join.p.waitForTimeout(250);
  }
  if (!fieldLoaded) die('engine never loaded the join-delivered pack FIELD "' + FIELD + '" via freeflight', join.logs);
  if (!airLoaded) die('field loaded but the flight did not start (no Airplane: line)', join.logs);
}
if (join.logs.some((l) => FATAL.some((re) => re.test(l)))) die('engine logged a fatal while flying on the pack field', join.logs);
console.log('ENGINE LOAD OK: joiner flew on join-delivered pack field "' + FIELD + '"');

console.log('SMOKE-MP-SCENERY PASSED');
await browser.close();
