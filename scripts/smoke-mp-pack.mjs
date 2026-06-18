// Headline v2 smoke (milestone M5): two real browsers, one hosts with a pack,
// the other joins with NO pack and must end up with it — purely peer-to-peer
// over a shell-owned 'ysf-pack' WebRTC DataChannel.  Plus a negative control:
// a corrupted transfer must be rejected (content-hash id mismatch / unzip fail).
//
//   node scripts/smoke-mp-pack.mjs <baseUrl/index.html> <ws://sig/signal>
//
// Loopback WebRTC uses host candidates only (window.ysfwPackIce=[]) so it needs
// no STUN/internet.  Signaling is the local sig-stub.  The engine never boots
// here — M5 verifies the transport in isolation; pre-boot join wiring is M6.
import { chromium } from 'playwright';

const baseUrl = process.argv[2] || 'http://localhost:8934/index.html';
const sigUrl = process.argv[3] || 'ws://localhost:8935/signal';
const ROOM = 'testmp01';
const url = () => baseUrl + '?signal=' + encodeURIComponent(sigUrl);

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

function die(msg, logs) {
  console.error('SMOKE-MP-PACK FAILED: ' + msg);
  if (logs) for (const l of logs.slice(-25)) console.error('  ' + l);
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

// ---- HOST: install the test pack, then serve it on the derived pack-room ----
const host = await newPage();
await host.p.goto(url());
await ready(host, 'host');
const hostId = await host.p.evaluate(async (room) => {
  const r = await fetch('/test-pack.zip');
  const res = await window.ysfwPacks.installFromBytes(new Uint8Array(await r.arrayBuffer()), 'toming');
  window.__h = window.ysfwPackNet.host(room);
  return res.id;
}, ROOM);
await waitForLog(host, /hosting /, 15000, 'host'); // wait until the pack-room is claimed
console.log('host serving pack id=' + hostId);

// ---- JOIN (happy path): no pack -> pull hostId over P2P ----
const join = await newPage();
await join.p.goto(url());
await ready(join, 'join');
if ((await join.p.evaluate(async () => (await window.ysfwPacks.list()).length)) !== 0) {
  die('joiner started with packs already present', join.logs);
}
const result = await join.p.evaluate(async (a) => await window.ysfwPackNet.join(a.room, [a.id]), { room: ROOM, id: hostId });
console.log('join result: ' + JSON.stringify(result));
const after = await join.p.evaluate(async () => await window.ysfwPacks.list());
if (!(result.installed || []).includes(hostId)) die('joiner did not install the host pack', join.logs);
if (!after.some((p) => p.id === hostId)) die('host pack absent from joiner index after transfer', join.logs);
console.log('HAPPY PATH OK: joiner received + installed pack ' + hostId + ' over P2P (no manual install)');

// ---- NEGATIVE: a corrupted transfer must be rejected, not installed ----
const bad = await newPage([() => { window.__ysfwPackCorrupt = true; }]);
await bad.p.goto(url());
await ready(bad, 'bad');
const badRes = await bad.p.evaluate(async (a) => await window.ysfwPackNet.join(a.room, [a.id]), { room: ROOM, id: hostId });
const badCount = await bad.p.evaluate(async () => (await window.ysfwPacks.list()).length);
if ((badRes.installed || []).length !== 0 || badCount !== 0) {
  die('corrupted transfer was NOT rejected (it installed): ' + JSON.stringify(badRes), bad.logs);
}
console.log('NEGATIVE OK: corrupted transfer rejected (' + JSON.stringify(badRes.failed) + ')');

console.log('SMOKE-MP-PACK PASSED');
await browser.close();
