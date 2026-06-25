// Step-1 metadata-bundle fallback E2E.
//
// Forces the best-effort FULL pull to fail (window.__ysfwPackCorrupt flips a byte ->
// recomputed id mismatches -> rollback), so syncPacksAsJoiner falls back to the
// op:'want-meta' bundle: the host's pack is installed as a SPARSE record (menu + boot
// scan complete, heavy geometry deferred) and the engine boots without it.
//
// PASS == the pre-boot sync reports the pack in `metaInstalled` (NOT `installed`), the
// joiner's list() includes it, and the engine boots with no fatal.
//
//   node scripts/meta-join.mjs <baseUrl/index.html> <ws://sig/signal>
import { chromium } from 'playwright';

const baseUrl = process.argv[2] || 'http://localhost:8936/index.html';
const sigUrl = process.argv[3] || 'ws://localhost:8937/signal';
const ROOM = 'metamp01';
const url = (extra) => baseUrl + '?signal=' + encodeURIComponent(sigUrl) + (extra ? '&' + extra : '');
const FATAL = [/Aborted\(/, /RuntimeError/];

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
function die(msg, logs) {
  console.error('META-JOIN FAILED: ' + msg);
  if (logs) for (const l of logs.slice(-40)) console.error('  ' + l);
  process.exit(1);
}
async function newPage(initScripts) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.addInitScript(() => { window.ysfwPackIce = []; });
  for (const fn of initScripts || []) await p.addInitScript(fn);
  const logs = [];
  p.on('console', (m) => logs.push(m.text()));
  p.on('pageerror', (e) => logs.push('PAGEERR ' + e.message));
  return { p, logs };
}
async function waitForLog(h, re, ms, who) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (h.logs.some((l) => re.test(l))) return h.logs.find((l) => re.test(l));
    await h.p.waitForTimeout(200);
  }
  die(who + ': timed out waiting for ' + re, h.logs);
}
const listIds = (h) =>
  h.p.evaluate(async () => { try { return (await window.ysfwPacks.list()).map((p) => p.id); } catch (e) { return null; } }).catch(() => null);
const overlayHidden = (h, who, ms) =>
  h.p.waitForFunction(() => { const ov = document.getElementById('overlay'); return ov && ov.classList.contains('hidden'); }, { timeout: ms })
    .catch(() => die(who + ': engine did not boot (overlay still visible)', h.logs));

// ---- HOST: install + advertise the test pack -----------------------------------
const host = await newPage();
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

// ---- JOINER: corrupt the full pull -> meta-bundle fallback ----------------------
const join = await newPage([() => { window.__ysfwPackCorrupt = true; }]);
await join.p.goto(url('join=' + ROOM + '&name=MetaTester'));
const syncLine = await waitForLog(join, /\[pack-net join\] pre-boot sync:/, 90000, 'join');
const json = syncLine.slice(syncLine.indexOf('{'));
let r; try { r = JSON.parse(json); } catch (e) { die('could not parse pre-boot sync result: ' + syncLine, join.logs); }
if ((r.installed || []).includes(hostId)) die('pack was FULL-installed; the corrupt hook did not force the meta fallback', join.logs);
if (!(r.metaInstalled || []).includes(hostId)) die('pack not in metaInstalled — meta fallback did not install it: ' + json, join.logs);
const ids = await listIds(join);
if (!ids || !ids.includes(hostId)) die('joiner list() does not include the meta-installed pack: ' + JSON.stringify(ids), join.logs);
await overlayHidden(join, 'join', 90000);
if (join.logs.some((l) => FATAL.some((re) => re.test(l)))) die('fatal output during meta-fallback join', join.logs);
console.log('META-JOIN OK: full pull failed -> pack ' + hostId + ' sparse-installed via meta bundle (in metaInstalled, in list, engine booted)');
console.log('META-JOIN PASSED');
await browser.close();
