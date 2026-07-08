// Workbench smoke test: proves the loose-file assembly flow works end-to-end in
// a real browser against the actual wasm engine — drop-equivalent loose
// .dat/.dnm/.srf bytes -> assemble -> install through the normal pipeline ->
// reload with ?freeflight=<IDENTIFY> -> the ENGINE resolves the assembled
// aircraft to a loaded template ("Airplane:<name>" prints only on success; see
// smoke-pack.mjs for the negative control).
//
//   node scripts/smoke-workbench.mjs <url> [waitMs]
//
// The loose fixture is served as /test-pack.zip (the community fixture); the
// page unzips it and hands the test1 aircraft's raw files to the workbench as
// if they were dropped without any zip or .lst.
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8926/index.html';
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
  console.error('SMOKE-WORKBENCH FAILED: ' + msg);
  for (const f of fatal.slice(0, 20)) console.error('  ' + f);
  console.error('--- last console lines ---');
  for (const l of logs.slice(-25)) console.error('  ' + l);
  process.exit(1);
}

await page.goto(url);
await page
  .waitForFunction(() => window.ysfwPacks && window.ysfwPacks.fsReady === true, { timeout: 60000 })
  .catch(() => die('pack layer never became ready (window.ysfwPacks.fsReady)'));

// 1. Assemble + install from LOOSE bytes through the public workbench API (the
//    same function the UI's "Assemble & import" button calls).
const res = await page
  .evaluate(async () => {
    const { unzipSync } = await import('./vendor/fflate.js');
    const r = await fetch('/test-pack.zip');
    const z = unzipSync(new Uint8Array(await r.arrayBuffer()));
    const f = (p) => ({ name: p.split('/').pop(), bytes: z[p] });
    return await window.ysfwPacks.workbenchAssembleInstall({
      name: 'wbsmoke',
      dat: f('user/toming/test1.dat'),
      visual: f('user/toming/test1.dnm'),
      collision: f('user/toming/test1coll.srf'),
    });
  })
  .catch((e) => die('workbench assemble/install threw: ' + e.message));

console.log('assembled+installed: ' + JSON.stringify({ id: res.id, identify: res.identify, templates: res.templates }));
if (!res || !/^[0-9a-f]{16}$/.test(res.id)) die('install returned no valid pack id');
if (res.identify !== 'YSFW_TEST1') die('expected identify YSFW_TEST1, got ' + res.identify);
if (res.templates !== 1) die('expected 1 template, got ' + res.templates);
if ((res.warnings || []).length !== 0) die('unexpected warnings: ' + JSON.stringify(res.warnings));

// 2. The installed pack's identities are readable (what the test-fly button uses).
const ids = await page.evaluate((id) => window.ysfwPacks.aircraftIdentities(id), res.id);
if (JSON.stringify(ids) !== JSON.stringify(['YSFW_TEST1'])) {
  die('aircraftIdentities mismatch: ' + JSON.stringify(ids));
}

// 2b. The .dat wizard: derive a renamed, re-tuned .dat from a STOCK aircraft
//     (readable pre-boot from the /ysflight preload) and assemble it with the
//     fixture's visual/collision into a second aircraft.
const wiz = await page
  .evaluate(async () => {
    const stock = window.ysfwPacks.workbenchListStock();
    if (!stock.length) throw new Error('no stock aircraft listed');
    const f15 = stock.find((a) => a.identify === 'F-15C_EAGLE') || stock[0];
    const dat = window.ysfwPacks.workbenchMakeDat(f15.datPath, 'WB_CUSTOM1', { engine: 2 });
    const { unzipSync } = await import('./vendor/fflate.js');
    const z = unzipSync(new Uint8Array(await (await fetch('/test-pack.zip')).arrayBuffer()));
    const f = (p) => ({ name: p.split('/').pop(), bytes: z[p] });
    const r = await window.ysfwPacks.workbenchAssembleInstall({
      name: 'wbcustom',
      dat: { name: 'wb_custom1.dat', bytes: dat.bytes },
      visual: f('user/toming/test1.dnm'),
      collision: f('user/toming/test1coll.srf'),
    });
    return { stockCount: stock.length, identify: r.identify, id: r.id };
  })
  .catch((e) => die('dat wizard flow threw: ' + e.message));
console.log('dat wizard: ' + JSON.stringify(wiz));
if (wiz.identify !== 'WB_CUSTOM1') die('expected WB_CUSTOM1, got ' + wiz.identify);
if (wiz.stockCount < 50) die('stock list suspiciously small: ' + wiz.stockCount);

// 2c. The scenery wizard: a minimal ocean field pack, installed like any other.
const scn = await page
  .evaluate(() => window.ysfwPacks.workbenchCreateScenery({
    name: 'WB_ISLAND', ground: [40, 90, 60], sky: [23, 106, 189], startAltM: 800,
  }))
  .catch((e) => die('scenery wizard flow threw: ' + e.message));
console.log('scenery wizard: ' + JSON.stringify({ id: scn.id, ident: scn.ident, start: scn.start }));
if (scn.ident !== 'WB_ISLAND' || scn.start !== 'START01') die('scenery wizard returned unexpected ident/start');

// 3. Reload straight into a flight with the assembled aircraft.  "Airplane:
//    YSFW_TEST1" prints ONLY when freeflight resolved it to a loaded template.
logs.length = 0;
fatal.length = 0;
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
{
  const t0 = Date.now();
  let loaded = false;
  while (Date.now() - t0 < 30000) {
    if (logs.some((l) => /Airplane:\s*YSFW_TEST1/.test(l))) { loaded = true; break; }
    await page.waitForTimeout(250);
  }
  if (!loaded) die('engine never set up a flight with the assembled aircraft "YSFW_TEST1"');
}
if (fatal.length) die('fatal engine output while flying the assembled aircraft');
console.log('workbench: assembled pack flew via ?freeflight (real engine)');

// 4. The wizard-made aircraft flies ON the wizard-made field: the full
//    kid-loop payoff (my plane, my island) in one freeflight boot.
logs.length = 0;
fatal.length = 0;
const ff2 = new URL(url);
ff2.searchParams.set('freeflight', 'WB_CUSTOM1,WB_ISLAND,START01');
await page.goto(ff2.toString());
await page
  .waitForFunction(
    () => {
      const ov = document.getElementById('overlay');
      return ov && ov.classList.contains('hidden');
    },
    { timeout: bootMs },
  )
  .catch(() => die('engine did not boot on the custom-field freeflight reload'));
{
  const t0 = Date.now();
  let fieldLoaded = false, airLoaded = false;
  while (Date.now() - t0 < 30000 && !(fieldLoaded && airLoaded)) {
    fieldLoaded = fieldLoaded || logs.some((l) => /Field:\s*WB_ISLAND/.test(l));
    airLoaded = airLoaded || logs.some((l) => /Airplane:\s*WB_CUSTOM1/.test(l));
    await page.waitForTimeout(250);
  }
  if (!fieldLoaded) die('engine never loaded the wizard-made field "WB_ISLAND"');
  if (!airLoaded) die('field loaded but the wizard-made aircraft "WB_CUSTOM1" did not fly');
}
if (fatal.length) die('fatal engine output while flying the wizard-made aircraft on the wizard-made field');

await browser.close();
console.log('workbench: wizard-made aircraft flew on wizard-made field (real engine)');
console.log('SMOKE-WORKBENCH PASSED');
