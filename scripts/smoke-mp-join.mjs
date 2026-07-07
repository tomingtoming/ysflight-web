// Headline v2 smoke (milestone M6): pre-boot join integration end-to-end.
//
// A host advertises its installed pack on the derived pack-room (via the SAME
// production wiring index.html uses while hosting); a second browser opens an
// invite link ?join=<room> and must end up with the host's pack installed
// BEFORE the engine's one-time template scan — no manual install, no reload —
// then the engine actually loads that pack's aircraft.
//
//   node scripts/smoke-mp-join.mjs <baseUrl/index.html> <ws://sig/signal>
//
// Loopback WebRTC uses host candidates only (window.ysfwPackIce=[]) so it needs
// no STUN/internet.  Signaling is the local sig-stub.
import { chromium } from 'playwright';

const baseUrl = process.argv[2] || 'http://localhost:8934/index.html';
const sigUrl = process.argv[3] || 'ws://localhost:8935/signal';
const ROOM = 'joinmp01';
const url = (extra) => baseUrl + '?signal=' + encodeURIComponent(sigUrl) + (extra ? '&' + extra : '');
const FATAL = [/Aborted\(/, /RuntimeError/];

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

function die(msg, logs) {
  console.error('SMOKE-MP-JOIN FAILED: ' + msg);
  if (logs) for (const l of logs.slice(-30)) console.error('  ' + l);
  process.exit(1);
}

async function newPage(initScripts) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.addInitScript(() => { window.ysfwPackIce = []; }); // host-only ICE for deterministic loopback
  for (const fn of initScripts || []) await p.addInitScript(fn);
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

async function listIds(h) {
  return h.p
    .evaluate(async () => {
      try { return (await window.ysfwPacks.list()).map((p) => p.id); } catch (e) { return null; }
    })
    .catch(() => null);
}

const overlayHidden = (h, who, ms) =>
  h.p
    .waitForFunction(() => { const ov = document.getElementById('overlay'); return ov && ov.classList.contains('hidden'); }, { timeout: ms })
    .catch(() => die(who + ': engine did not boot (overlay still visible)', h.logs));

// ---- HOST: install the test pack, then advertise it via the production wiring -
const host = await newPage();
await host.p.goto(url());
await ready(host, 'host');
const hostId = await host.p.evaluate(async () => {
  const r = await fetch('/test-pack.zip');
  return (await window.ysfwPacks.installFromBytes(new Uint8Array(await r.arrayBuffer()), 'toming')).id;
});
// Drive the SAME path index.html uses while hosting: setting ysfwRtc.host makes
// the host-advertise watcher start the shell-owned pack host (which publishes
// the manifest with its room claim).
await host.p.evaluate((room) => { globalThis.ysfwRtc = { host: { room, ok: true, failed: false } }; }, ROOM);
await waitForLog(host, /hosting /, 15000, 'host'); // host-ok received => manifest stored in the room
console.log('host advertising pack ' + hostId + ' on the pack-room for ' + ROOM);

// ---- JOINER: open the invite link; the pre-boot gate must sync the pack -------
const join = await newPage();
// packsync=1: the pre-boot pack sync is opt-in since the v1 descope
// (index.html MP_PACK_SYNC); without it the joiner boots vanilla and this
// smoke's whole subject never runs.
await join.p.goto(url('join=' + ROOM + '&name=Tester&packsync=1'));
await waitForLog(join, /\[pack-net join\] pre-boot sync:/, 90000, 'join'); // sync ran + persisted
const ids = await listIds(join);
if (!ids || !ids.includes(hostId)) die('joiner did not install the host pack via ?join pre-boot sync: ' + JSON.stringify(ids), join.logs);
const panelShown = await join.p.evaluate(() => !!document.getElementById('ysfw-pack-panel'));
if (panelShown) die('pack management panel was shown during a ?join sync (should be hidden)', join.logs);
if (join.logs.some((l) => FATAL.some((re) => re.test(l)))) die('fatal output during join pre-boot sync', join.logs);
console.log('JOIN OK: ?join pre-boot sync installed pack ' + hostId + ' (no manual install, no reload); panel hidden');

// ---- ENGINE LOAD: the join-delivered pack actually loads in the engine --------
// Reload the SAME context straight into a flight with an aircraft that ONLY this
// pack provides (test1.dat: IDENTIFY "YSFW_TEST1").  The pack persisted to IDBFS
// during the sync, so freeflight boots and loads it.  The engine prints
// "Airplane:<name>" only when freeflight resolved the aircraft to a loaded
// template — proof the pack is live in the engine.
join.logs.length = 0;
await join.p.goto(url('freeflight=YSFW_TEST1,ATSUGI_AIRBASE,NORTH3000'));
await overlayHidden(join, 'join-freeflight', 90000);
{
  const t0 = Date.now();
  let loaded = false;
  while (Date.now() - t0 < 30000) {
    if (join.logs.some((l) => /Airplane:\s*YSFW_TEST1/.test(l))) { loaded = true; break; }
    await join.p.waitForTimeout(250);
  }
  if (!loaded) die('engine never loaded join-delivered pack aircraft "YSFW_TEST1" via freeflight', join.logs);
}
if (join.logs.some((l) => FATAL.some((re) => re.test(l)))) die('engine logged a fatal while loading the join-delivered pack', join.logs);
console.log('ENGINE LOAD OK: join-delivered pack aircraft "YSFW_TEST1" loaded in-engine (no reload of the install)');

console.log('SMOKE-MP-JOIN PASSED');
await browser.close();
