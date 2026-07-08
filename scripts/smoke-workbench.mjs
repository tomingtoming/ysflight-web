// Workbench smoke test: proves the DEDICATED workbench page (workbench.html,
// engine-less) creates packs that the game page then flies — i.e. the OPFS
// bridge between the two pages, end-to-end in a real browser:
//
//   workbench.html:  loose .dat/.dnm/.srf -> assemble -> OPFS record
//                    stock base -> .dat wizard -> second aircraft (WB_CUSTOM1)
//                    drawn islands -> scenery pack (WB_ISLAND, PC2+PST text)
//   index.html:      ?freeflight boots the engine, materializes OPFS records,
//                    and prints "Airplane:<name>" / "Field:<name>" ONLY when it
//                    resolved them to loaded templates (see smoke-pack.mjs for
//                    the negative control).
//
//   node scripts/smoke-workbench.mjs <url> [waitMs]
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8926/index.html';
const bootMs = parseInt(process.argv[3] || '90000', 10);
const wbUrl = new URL(url);
wbUrl.pathname = wbUrl.pathname.replace(/index\.html$/, 'workbench.html');

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

// ---- workbench page: create everything (no engine involved) --------------------
await page.goto(wbUrl.toString());
await page
  .waitForFunction(() => window.ysfwWorkbench && window.ysfwWorkbench.ready === true, { timeout: 30000 })
  .catch(() => die('workbench page never became ready (window.ysfwWorkbench)'));

// 1. Assemble + install from LOOSE bytes (the fixture aircraft's raw files).
const res = await page
  .evaluate(async () => {
    const { unzipSync } = await import('./vendor/fflate.js');
    const r = await fetch('/test-pack.zip');
    const z = unzipSync(new Uint8Array(await r.arrayBuffer()));
    const f = (p) => ({ name: p.split('/').pop(), bytes: z[p] });
    return await window.ysfwWorkbench.assembleInstall({
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

// 2. The .dat wizard: stock base (dist/stock, no wasm preload) -> renamed,
//    re-tuned .dat -> second aircraft with the fixture's visual/collision.
const wiz = await page
  .evaluate(async () => {
    const stock = await window.ysfwWorkbench.listStock();
    if (!stock.length) throw new Error('no stock aircraft listed');
    const f15 = stock.find((a) => a.identify === 'F-15C_EAGLE') || stock[0];
    const dat = await window.ysfwWorkbench.makeDat(f15.file, 'WB_CUSTOM1', { engine: 2 });
    const { unzipSync } = await import('./vendor/fflate.js');
    const z = unzipSync(new Uint8Array(await (await fetch('/test-pack.zip')).arrayBuffer()));
    const f = (p) => ({ name: p.split('/').pop(), bytes: z[p] });
    const r = await window.ysfwWorkbench.assembleInstall({
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

// 3. The island scenery: a DRAWN map (two polygons -> PC2 visual + PST LAND).
const scn = await page
  .evaluate(() => window.ysfwWorkbench.createScenery({
    name: 'WB_ISLAND', ground: [13, 58, 102], sky: [23, 106, 189], land: [60, 140, 80],
    startAltM: 800,
    islands: [
      { points: [[-2000, -1500], [1500, -2200], [2400, 600], [0, 1800], [-2300, 900]] },
      { points: [[3500, 3000], [4500, 2800], [4200, 4000]], color: [200, 180, 120] },
    ],
  }))
  .catch((e) => die('island scenery flow threw: ' + e.message));
console.log('island scenery: ' + JSON.stringify({ id: scn.id, ident: scn.ident, start: scn.start }));
if (scn.ident !== 'WB_ISLAND' || scn.start !== 'START01') die('scenery wizard returned unexpected ident/start');

// 3b. Creations library: everything made above is listed, typed, and editable —
//     and an IMPORTED zip (no recipe) must NOT appear (creations ≠ inventory).
await page.evaluate(async () => {
  const bytes = new Uint8Array(await (await fetch('/test-pack.zip')).arrayBuffer());
  await window.ysfwWorkbench.installZip(bytes, 'imported-community-pack');
});
const lib = await page.evaluate(() => window.ysfwWorkbench.listCreations());
if (lib.some((i) => i.name === 'imported-community-pack')) die('imported zip leaked into the creations library');
if (lib.length !== 3) die('expected 3 creations, got ' + lib.length + ': ' + JSON.stringify(lib.map((i) => i.name)));
if (lib.filter((i) => i.kind === 'aircraft').length !== 2) die('expected 2 aircraft creations');
if (lib.filter((i) => i.kind === 'scenery').length !== 1) die('expected 1 scenery creation');
if (!lib.every((i) => i.recipeSha)) die('every workbench creation should carry a recipe');
console.log('library: 3 creations listed, all with recipes');

// 3c. Edit round-trip: re-open the drawn map from its recipe, add an island,
//     save — the new content-hash id REPLACES the old record (same ident).
const edited = await page
  .evaluate(async (oldId) => {
    const lib = await window.ysfwWorkbench.listCreations();
    const isl = lib.find((i) => i.kind === 'scenery');
    const recipe = await window.ysfwWorkbench.loadRecipe(isl.recipeSha);
    const sc = recipe.scenery;
    sc.islands = sc.islands.concat([{ points: [[-4000, -4000], [-3000, -4000], [-3500, -3000]] }]);
    const res = await window.ysfwWorkbench.createScenery({ ...sc, replaceId: isl.id });
    const after = await window.ysfwWorkbench.listCreations();
    return { oldId: isl.id, newId: res.id, ident: res.ident, count: after.length, oldGone: !after.some((i) => i.id === isl.id) };
  })
  .catch((e) => die('edit round-trip threw: ' + e.message));
console.log('edit round-trip: ' + JSON.stringify(edited));
if (edited.newId === edited.oldId) die('edit produced the same id (content should differ)');
if (!edited.oldGone) die('old version was not replaced');
if (edited.count !== 3) die('library should still hold 3 creations after replace, got ' + edited.count);
if (edited.ident !== 'WB_ISLAND') die('edited map lost its ident');

// 3d. Delete: a disposable creation disappears from the library.
const delCheck = await page.evaluate(async () => {
  const tmp = await window.ysfwWorkbench.createScenery({ name: 'WB_TMP' });
  await window.ysfwWorkbench.deleteCreation(tmp.id);
  const after = await window.ysfwWorkbench.listCreations();
  return { count: after.length, gone: !after.some((i) => i.id === tmp.id) };
});
if (!delCheck.gone || delCheck.count !== 3) die('delete failed: ' + JSON.stringify(delCheck));
console.log('library: delete works (back to 3 creations)');

// ---- game page: fly what the workbench made (the OPFS bridge) -------------------

// 4. The loose-assembled aircraft flies.
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
  if (!loaded) die('engine never set up a flight with the workbench-made aircraft "YSFW_TEST1"');
}
if (fatal.length) die('fatal engine output while flying the assembled aircraft');
console.log('workbench->game: assembled pack flew via ?freeflight (real engine)');

// 5. The wizard-made aircraft flies ON the drawn island map: the full kid-loop
//    payoff (my plane, my island) in one freeflight boot.
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
  if (!fieldLoaded) die('engine never loaded the drawn island field "WB_ISLAND"');
  if (!airLoaded) die('field loaded but the wizard-made aircraft "WB_CUSTOM1" did not fly');
}
if (fatal.length) die('fatal engine output while flying the wizard-made aircraft on the drawn map');

await browser.close();
console.log('workbench->game: wizard-made aircraft flew on the DRAWN island map (real engine)');
console.log('SMOKE-WORKBENCH PASSED');
