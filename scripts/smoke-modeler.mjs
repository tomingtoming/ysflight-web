// Polygon Crest boot smoke (P0): the editor wasm boots in a real browser,
// reaches the running main loop, and draws without fatal output.  This guards
// the second-wasm-target wiring (ysgebl_web) and the modeler.html shell — the
// editor's actual UI behaviour is beyond a boot smoke.
//
//   node scripts/smoke-modeler.mjs <url> [waitMs]
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8927/modeler.html';
const settleMs = parseInt(process.argv[3] || '8000', 10);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const logs = [];
const fatal = [];
const FATAL = [/Aborted\(/, /RuntimeError/, /abort\(/i];
page.on('console', (m) => {
  const t = m.text();
  logs.push(t);
  if (FATAL.some((re) => re.test(t))) fatal.push('[console] ' + t);
});
page.on('pageerror', (e) => fatal.push('[pageerror] ' + e.message));

function die(msg) {
  console.error('SMOKE-MODELER FAILED: ' + msg);
  for (const f of fatal.slice(0, 20)) console.error('  ' + f);
  console.error('--- last console lines ---');
  for (const l of logs.slice(-25)) console.error('  ' + l);
  process.exit(1);
}

await page.goto(url);
await page
  .waitForFunction(() => window.Module && window.Module.calledRun === true, { timeout: 60000 })
  .catch(() => die('runtime never initialized (Module.calledRun)'));

// Let the main loop run a while — early frames are where GL/shader aborts land.
await page.waitForTimeout(settleMs);
if (fatal.length) die('fatal output during editor boot');

// The boot overlay hides on runtime init; the canvas must be live WebGL.
const state = await page.evaluate(() => ({
  bootHidden: document.getElementById('boot').classList.contains('hidden'),
  canvasW: document.getElementById('canvas').width,
}));
if (!state.bootHidden) die('boot overlay never hid');
if (!(state.canvasW > 0)) die('canvas has no backing size');

// Editor liveliness probe: a click + key must not crash the loop.
await page.mouse.click(640, 400);
await page.keyboard.press('Escape');
await page.waitForTimeout(2000);
if (fatal.length) die('fatal output after input events');
console.log('Polygon Crest booted in the browser (main loop + input alive)');

// ---- file bridge (P1): a save in the modeler reaches the workbench --------------

await page
  .waitForFunction(() => window.__ysfwBridgeReady === true, { timeout: 20000 })
  .catch(() => die('modeler bridge never became ready'));

// Simulate File->Save: write model files into the editor VFS exactly where a
// save would land them.  The polling bridge must push them to OPFS staging.
await page.evaluate(async () => {
  const { unzipSync } = await import('./vendor/fflate.js');
  const z = unzipSync(new Uint8Array(await (await fetch('/test-pack.zip')).arrayBuffer()));
  window.Module.FS.writeFile('/home/web_user/wb_model.dnm', z['user/toming/test1.dnm']);
  window.Module.FS.writeFile('/home/web_user/wb_model_coll.srf', z['user/toming/test1coll.srf']);
});
{
  const t0 = Date.now();
  let staged = [];
  while (Date.now() - t0 < 20000) {
    staged = await page.evaluate(async () => {
      const { listStaged } = await import('./staging.js');
      return (await listStaged()).map((s) => s.name);
    });
    if (staged.includes('wb_model.dnm') && staged.includes('wb_model_coll.srf')) break;
    await page.waitForTimeout(500);
  }
  if (!(staged.includes('wb_model.dnm') && staged.includes('wb_model_coll.srf'))) {
    die('saved files never reached staging: ' + JSON.stringify(staged));
  }
}
console.log('bridge: modeler saves reached OPFS staging');

// The workbench sees the staged files and can assemble a flyable aircraft from
// them (modeler visual+collision + a stock-based .dat).
const wb = new URL(url);
wb.pathname = wb.pathname.replace(/modeler\.html$/, 'workbench.html');
await page.goto(wb.toString());
await page
  .waitForFunction(() => window.ysfwWorkbench && window.ysfwWorkbench.ready === true, { timeout: 30000 })
  .catch(() => die('workbench page never became ready'));
const built = await page
  .evaluate(async () => {
    const staged = (await window.ysfwWorkbench.listStaged()).map((s) => s.name);
    const stock = await window.ysfwWorkbench.listStock();
    const dat = await window.ysfwWorkbench.makeDat(stock[0].file, 'WB_FROM_MODELER', { engine: 1.5 });
    const r = await window.ysfwWorkbench.assembleInstall({
      name: 'from modeler',
      dat: { name: 'wb_from_modeler.dat', bytes: dat.bytes },
      visual: { name: 'wb_model.dnm', bytes: await window.ysfwWorkbench.getStaged('wb_model.dnm') },
      collision: { name: 'wb_model_coll.srf', bytes: await window.ysfwWorkbench.getStaged('wb_model_coll.srf') },
    });
    return { staged, identify: r.identify, id: r.id };
  })
  .catch((e) => die('workbench-side bridge assembly threw: ' + e.message));
if (!built.staged.includes('wb_model.dnm')) die('workbench did not list the staged model');
if (built.identify !== 'WB_FROM_MODELER' || !/^[0-9a-f]{16}$/.test(built.id)) {
  die('bridge assembly failed: ' + JSON.stringify(built));
}
console.log('bridge: workbench assembled an aircraft from modeler-saved files (' + built.id + ')');

// Reverse direction: on the next modeler boot the staged files are imported
// into the editor VFS for File->Open.
await page.goto(url);
await page
  .waitForFunction(() => window.__ysfwBridgeReady === true, { timeout: 60000 })
  .catch(() => die('modeler bridge not ready on reload'));
const imported = await page.evaluate(() => {
  try { return window.Module.FS.readdir('/home/web_user/workbench').filter((n) => n !== '.' && n !== '..'); }
  catch (e) { return []; }
});
if (!imported.includes('wb_model.dnm')) die('staged files were not imported into the modeler VFS: ' + JSON.stringify(imported));
console.log('bridge: staged files imported back into the modeler VFS for File->Open');

await browser.close();
console.log('SMOKE-MODELER PASSED');
