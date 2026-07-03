// Add-on pack smoke test (milestone M2): proves the pre-boot pack flow works
// end-to-end in a real browser against the actual wasm engine.
//
//   node scripts/smoke-pack.mjs <url> [waitMs]
//
// Steps: load the page (gate held, pack panel shown) -> install the served test
// pack via window.ysfwPacks -> press play (release the gate) -> wait for boot ->
// confirm the engine SCANNED the generated list and loaded it without error.
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8924/index.html';
const bootMs = parseInt(process.argv[3] || '90000', 10);

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const logs = [];
const fatal = [];
const FATAL = [/Aborted\(/, /RuntimeError/, /Cannot Load/];
page.on('console', (m) => {
  const t = m.text();
  logs.push(t);
  if (FATAL.some((re) => re.test(t))) fatal.push('[console] ' + t);
});
page.on('pageerror', (e) => fatal.push('[pageerror] ' + e.message));

function die(msg) {
  console.error('SMOKE-PACK FAILED: ' + msg);
  for (const f of fatal.slice(0, 20)) console.error('  ' + f);
  console.error('--- last console lines ---');
  for (const l of logs.slice(-25)) console.error('  ' + l);
  process.exit(1);
}

await page.goto(url);

// 1. Pre-boot: FS synced, gate held, panel ready.
await page
  .waitForFunction(() => window.ysfwPacks && window.ysfwPacks.fsReady === true, { timeout: 60000 })
  .catch(() => die('pack layer never became ready (window.ysfwPacks.fsReady)'));

const gateHeld = await page.evaluate(() => !!(window.Module && window.Module.__ysfwGateHeld));
if (!gateHeld) die('run-dependency gate was not held pre-boot');

// 2. Install the served test pack through the real public API.
const res = await page
  .evaluate(async () => {
    const r = await fetch('/test-pack.zip');
    const b = new Uint8Array(await r.arrayBuffer());
    return await window.ysfwPacks.installFromBytes(b, 'testpack');
  })
  .catch((e) => die('install threw: ' + e.message));

console.log('installed: ' + JSON.stringify(res));
if (!res || !/^[0-9a-f]{16}$/.test(res.id)) die('install returned no valid pack id');
if (res.templates !== 2) die('expected 2 templates (test1+test2), got ' + res.templates);
if (JSON.stringify(res.categories) !== JSON.stringify(['aircraft'])) {
  die('expected categories [aircraft], got ' + JSON.stringify(res.categories));
}

// install must have persisted an index entry
const indexLen = await page.evaluate(async () => (await window.ysfwPacks.list()).length);
if (indexLen !== 1) die('expected 1 pack in index.json, got ' + indexLen);

// 3. Press play -> release the gate -> engine boots.
await page.evaluate(() => window.ysfwPacks.start());
await page
  .waitForFunction(
    () => {
      const ov = document.getElementById('overlay');
      return ov && ov.classList.contains('hidden');
    },
    { timeout: bootMs },
  )
  .catch(() => die('engine did not boot after releasing the gate (overlay still visible)'));

await page.waitForTimeout(3000);
if (fatal.length) die('fatal output during pre-boot install / first boot');

// 3b. Regression guard for the run-dependency ordering race.  Once the service
//     worker is controlling, a reload serves the .data preload from cache (it
//     resolves instantly), so the IDBFS syncfs finishes AFTER it.  preRun must
//     keep the run-dependency count > 0 across that transition; otherwise
//     Emscripten schedules main() early and aborts with "cannot call main when
//     async dependencies remain".  (This is the exact crash the gate ordering
//     fix addresses; a fresh first load does not reproduce it.)
await page
  .waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, { timeout: 30000 })
  .catch(() => {});
logs.length = 0;
fatal.length = 0;
await page.goto(url);
await page
  .waitForFunction(() => window.ysfwPacks && window.ysfwPacks.fsReady === true, { timeout: 60000 })
  .catch(() => die('cached reload: pack layer not ready'));
await page.evaluate(() => window.ysfwPacks.start());
await page
  .waitForFunction(
    () => {
      const ov = document.getElementById('overlay');
      return ov && ov.classList.contains('hidden');
    },
    { timeout: bootMs },
  )
  .catch(() => die('cached reload did not boot (run-dependency ordering race?)'));
if (fatal.length) die('abort on SW-cached reload: ' + fatal.join(' | '));
console.log('SW-cached reload booted cleanly (run-dependency ordering guarded)');

// Reload straight into a flight with an aircraft that ONLY this pack provides
// (test1.dat: IDENTIFY "YSFW_TEST1"). ?freeflight auto-launches (no gate); the
// engine loads the IDBFS-persisted pack at boot.  The engine prints
// "Airplane:<name>" ONLY when freeflight resolved the aircraft to a loaded
// template (negative control: with no pack, freeflight=YSFW_TEST1 prints
// "Field:..." but NO "Airplane:" line).  So that line is proof of load.
async function freeflightLoadsTest1() {
  logs.length = 0;
  const ff = new URL(url);
  ff.searchParams.set('freeflight', 'YSFW_TEST1,ATSUGI_AIRBASE,NORTH3000');
  await page.goto(ff.toString());
  await page
    .waitForFunction(
      () => {
        const ov = document.getElementById('overlay');
        return ov && ov.classList.contains('hidden');
      },
      { timeout: bootMs },
    )
    .catch(() => die('engine did not boot on the freeflight reload'));
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    if (logs.some((l) => /Airplane:\s*YSFW_TEST1/.test(l))) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

// 4. Enabled pack -> the engine loads it with no reload.
if (!(await freeflightLoadsTest1())) {
  die('engine never set up a flight with pack-only aircraft "YSFW_TEST1" — the persisted pack was not loaded');
}
if (fatal.length) die('engine logged a fatal / Cannot-Load while loading the pack');
console.log('enabled pack: engine loaded pack-only aircraft "YSFW_TEST1" via freeflight (no reload)');

// 5. M3 toggle: disable the pack (window.ysfwPacks is available on this page
//    too), then the same freeflight must NOT load YSFW_TEST1 (.lst -> .lst.off so
//    the engine's air*.lst glob skips it).
await page
  .waitForFunction(() => window.ysfwPacks && window.ysfwPacks.fsReady === true, { timeout: 30000 })
  .catch(() => die('pack layer not ready to disable'));
const disabled = await page.evaluate(async (id) => {
  await window.ysfwPacks.setEnabled(id, false);
  return (await window.ysfwPacks.list()).find((p) => p.id === id);
}, res.id);
if (!disabled || disabled.enabled !== false) die('setEnabled(false) did not update the index');

if (await freeflightLoadsTest1()) {
  die('disabled pack was STILL loaded — the .lst.off rename was not honored by the engine');
}
console.log('disabled pack: engine did NOT load "YSFW_TEST1" (.lst.off honored)');

// 6. Bulk actions (setEnabledAll / uninstallAll): the one-click "back to plain
//    YSFLIGHT" and "wipe the library" the panel exposes.  Drive the API directly.
//    Each freeflightLoadsTest1() navigates, so re-wait for the pack layer (fsReady)
//    before every evaluate that follows a navigation.
const waitFsReady = () => page
  .waitForFunction(() => window.ysfwPacks && window.ysfwPacks.fsReady === true, { timeout: 30000 })
  .catch(() => die('pack layer not ready for bulk ops'));
await waitFsReady();

// 6a. setEnabledAll(true) re-enables everything -> the pack loads again.
const bulkEnabled = await page.evaluate(async () => {
  const r = await window.ysfwPacks.setEnabledAll(true);
  const list = await window.ysfwPacks.list();
  return { r, allOn: list.length > 0 && list.every((p) => p.enabled !== false) };
});
if (!bulkEnabled.allOn) die('setEnabledAll(true) did not re-enable every pack: ' + JSON.stringify(bulkEnabled));
if (!(await freeflightLoadsTest1())) die('after setEnabledAll(true) the engine did not load "YSFW_TEST1"');
console.log('bulk enable: setEnabledAll(true) re-enabled all packs; engine loaded "YSFW_TEST1"');

// 6b. setEnabledAll(false) -> plain YSFLIGHT (no pack aircraft).
await waitFsReady();
const bulkDisabled = await page.evaluate(async () => {
  await window.ysfwPacks.setEnabledAll(false);
  const list = await window.ysfwPacks.list();
  return list.length > 0 && list.every((p) => p.enabled === false);
});
if (!bulkDisabled) die('setEnabledAll(false) did not disable every pack');
if (await freeflightLoadsTest1()) die('after setEnabledAll(false) the engine STILL loaded "YSFW_TEST1"');
console.log('bulk disable: setEnabledAll(false) disabled all packs; engine did NOT load "YSFW_TEST1"');

// 6c. uninstallAll() -> empty index, and the payload aircraft is gone.
await waitFsReady();
const bulkRemoved = await page.evaluate(async () => {
  const r = await window.ysfwPacks.uninstallAll();
  return { r, remaining: (await window.ysfwPacks.list()).length };
});
if (bulkRemoved.remaining !== 0) die('uninstallAll() left packs behind: ' + JSON.stringify(bulkRemoved));
if (await freeflightLoadsTest1()) die('after uninstallAll() the engine STILL loaded "YSFW_TEST1"');
console.log('bulk uninstall: uninstallAll() emptied the index; engine did NOT load "YSFW_TEST1"');

console.log('SMOKE-PACK PASSED');
await browser.close();
