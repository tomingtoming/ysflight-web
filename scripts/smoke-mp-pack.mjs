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

// --disable-features=WebRtcHideLocalIpsWithMdns: headless Chromium otherwise masks
// loopback host candidates behind mDNS .local names that don't resolve across two
// browser contexts, so the ICE handshake never completes (transfer times out) even
// though both pages are in the same process.  Exposing raw 127.0.0.1 candidates makes
// the loopback transfer deterministic — required for this to run in CI.
const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'],
});

function die(msg, ...logSets) {
  console.error('SMOKE-MP-PACK FAILED: ' + msg);
  for (const logs of logSets) {
    if (!logs) continue;
    console.error('  --- ' + (logs.label || 'page') + ' ---');
    for (const l of logs.slice(-30)) console.error('  ' + l);
  }
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
join.logs.label = 'joiner'; host.logs.label = 'host';
if (!(result.installed || []).includes(hostId)) die('joiner did not install the host pack', join.logs, host.logs);
if (!after.some((p) => p.id === hostId)) die('host pack absent from joiner index after transfer', join.logs, host.logs);
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

// ---- MULTI-PACK: a host with SEVERAL enabled packs -> a joiner syncs them ALL ----
// Guards two regressions at once, end-to-end through the real sig-stub hub:
//   (1) 224db83 — the advertised manifest must survive the hub with many packs
//       (a re-bloat would be dropped and the joiner would sync nothing); and
//   (2) the OPFS-serve fix — each pack's heavy payload is only metadata-resident on
//       the host (boot/install materialize .lst/.dat/.stp only), so serving by walking
//       MEMFS would ship partial zips and EVERY id would mismatch.  The joiner uses the
//       manifest path (syncAsJoiner: read manifest over the hub -> diff -> P2P pull).
const ROOM2 = 'testmp02';
const mhost = await newPage();
await mhost.p.goto(url());
await ready(mhost, 'multi-host');
const multiIds = await mhost.p.evaluate(async (a) => {
  const { zipSync } = await import('/vendor/fflate.js');
  const E = (s) => new TextEncoder().encode(s);
  const ids = [];
  // one real community pack ...
  const tr = await fetch('/test-pack.zip');
  ids.push((await window.ysfwPacks.installFromBytes(new Uint8Array(await tr.arrayBuffer()), 'toming')).id);
  // ... plus several synthesized DISTINCT aircraft packs (unique bytes -> unique ids).
  // .dnm/.srf are payload (OPFS-only after install), .dat/.lst are metadata.
  for (let i = 0; i < a.n; i++) {
    const tag = 'synth' + i + '-' + Math.random().toString(36).slice(2, 9);
    const zip = zipSync({
      'aircraft/air_s.lst': E('aircraft/s.dnm aircraft/s.srf aircraft/s.dat\n'),
      'aircraft/s.dnm': E('DNM-' + tag), 'aircraft/s.srf': E('SRF-' + tag), 'aircraft/s.dat': E('DAT-' + tag),
    });
    ids.push((await window.ysfwPacks.installFromBytes(zip, 'synth ' + i)).id);
  }
  // Host only AFTER every pack is installed, so the build-once manifest advertises all.
  window.__h = window.ysfwPackNet.host(a.room);
  return ids;
}, { room: ROOM2, n: 3 });
await waitForLog(mhost, /hosting /, 15000, 'multi-host');
console.log('multi-host serving ' + multiIds.length + ' packs');

const mjoin = await newPage();
await mjoin.p.goto(url());
await ready(mjoin, 'multi-join');
if ((await mjoin.p.evaluate(async () => (await window.ysfwPacks.list()).length)) !== 0) {
  die('multi-joiner started with packs already present', mjoin.logs);
}
const sync2 = await mjoin.p.evaluate(async (room) => await window.ysfwPackNet.syncAsJoiner(room), ROOM2);
console.log('multi-join sync: ' + JSON.stringify(sync2));
const after2 = await mjoin.p.evaluate(async () => (await window.ysfwPacks.list()).map((p) => p.id));
mjoin.logs.label = 'multi-joiner'; mhost.logs.label = 'multi-host';
for (const id of multiIds) {
  if (!(sync2.installed || []).includes(id)) die('multi-join: pack not synced: ' + id, mjoin.logs, mhost.logs);
  if (!after2.includes(id)) die('multi-join: synced pack absent from joiner index: ' + id, mjoin.logs, mhost.logs);
}
console.log('MULTI-PACK OK: joiner synced all ' + multiIds.length + ' packs via the manifest path (hub + per-pack OPFS serve)');

console.log('SMOKE-MP-PACK PASSED');
await browser.close();
