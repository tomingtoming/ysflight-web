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

await browser.close();
console.log('Polygon Crest booted in the browser (main loop + input alive)');
console.log('SMOKE-MODELER PASSED');
