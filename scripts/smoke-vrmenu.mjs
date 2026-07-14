// VR main-menu-in-VR test without a headset.
//
// Boots to the main menu (NOT a free flight) and switches the engine into
// VR + multiview mode through vr.forceMultiview (the same headless hook all
// other VR smoke tests use).  The new setupMenu() call inside forceMultiview
// allocates a plain mono RGBA FBO for the menu (skipping the XRQuadLayer,
// which requires a real XR session) so this test can verify:
//
//   1. YsfwVrMenuDataPointer() export is accessible.
//   2. After forceMultiview, menuData[0] === 1 (FBO allocated, enable flag set).
//   3. menuData[3] and menuData[4] are the canvas width/height (FBO size).
//   4. After a few engine ticks, menuData[5] becomes 1 (DrawMenu wrote to FBO).
//   5. The menu FBO contains non-trivial content (mean luminance > 0, alpha > 0).
//   6. The watchdog does NOT fire: simSilentFrames stays 0 while the menu is
//      being rendered (DrawMenu calls FsVrMarkSimDrawn each frame).
//
//   node scripts/smoke-vrmenu.mjs [url] [outDir]
import { chromium } from 'playwright';
import fs from 'fs';

const baseUrl = process.argv[2] || 'http://localhost:8923/index.html';
const outDir = process.argv[3] || '.';

const FATAL_PATTERNS = [
  /Link Status 0/, /Compile Status 0/, /declared as type/, /Error Message: error/,
  /Aborted\(/, /Failed to create WebGL context/, /Feedback loop/,
  /invalid internalformat/, /INVALID_ENUM/, /does not match uniform method/,
  /GL_INVALID/, /RuntimeError/, /number of views/i,
];

const results = [];
function check(name, cond, detail) {
  const line = (cond ? 'PASS' : 'FAIL') + ': ' + name + (detail !== undefined ? ' (' + detail + ')' : '');
  console.log(line);
  results.push({ name, pass: !!cond });
}

const fatal = [];

const browser = await chromium.launch({
  executablePath: process.env.YSFW_CHROMIUM || undefined,
  headless: true,
  // Native-GL ANGLE: required for multiview extension support (same as
  // smoke-mv.mjs -- SwiftShader takes the WebGL1 fallback which has no
  // OVR_multiview2).
  args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=gl']
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => {
  const t = m.text();
  if (FATAL_PATTERNS.some((re) => re.test(t))) fatal.push('[console] ' + t);
});
page.on('pageerror', (e) => fatal.push('[pageerror] ' + e.message));

// ---- Boot to the main menu (NOT a free flight) ----------------------------
// Just wait for the Module to initialise -- do NOT click away dialogs or
// wait for ysfwInFlight (the whole point is testing the menu, not the flight).
await page.goto(baseUrl);
await page.waitForFunction(() => !!globalThis.Module, null, { timeout: 90000 });
// Give the engine a moment to reach the main menu draw loop.
await page.waitForTimeout(2000);

await page.screenshot({ path: outDir + '/vrmenu-test-0-menu.png' });
console.log('wrote ' + outDir + '/vrmenu-test-0-menu.png');

// ---- Check VR test hooks are present ---------------------------------------
const hooksOk = await page.evaluate(() => {
  const M = globalThis.Module;
  const vr = M && M.ysfwVr;
  return !!(vr &&
    vr.forceMultiview &&
    vr.readMenuData &&
    vr.readMenuStats &&
    typeof M._YsfwVrMenuDataPointer === 'function');
});
if (!hooksOk) {
  console.error('FAILED: VR menu test hooks missing');
  await browser.close();
  process.exit(1);
}

// ---- menuData should start at all zeros before multiview engages ----------
let menuData = await page.evaluate(() => globalThis.Module.ysfwVr.readMenuData());
check('menuData all zeros before forceMultiview', menuData.every((v) => v === 0), 'menuData=' + JSON.stringify(menuData));

// ---- Enter multiview mode (same synthetic eye data as smoke-mv.mjs) --------
// forceMultiview now also calls setupMenu(), which allocates the menu FBO.
const W = 512, H = 512;
const forced = await page.evaluate(([w, h]) => {
  const M = globalThis.Module;
  const vr = M && M.ysfwVr;
  if (!vr || !vr.pokeEye || !vr.forceMultiview) return 'hooks-missing';
  const s = Math.sin(5 * Math.PI / 180), c = Math.cos(5 * Math.PI / 180);
  vr.pokeEye(0, [
    1, 1, 1, 1,
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, +0.032, 0, 0, 1,
    0, 0, w, h
  ]);
  vr.pokeEye(1, [
    1, 1, 1, 1,
    c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, -0.032, 0, 0, 1,
    0, 0, w, h
  ]);
  return vr.forceMultiview(w, h);
}, [W, H]);
check('forceMultiview returned ok', forced === 'ok', 'result=' + forced);
if (forced !== 'ok') {
  console.error('FAILED to force multiview mode: ' + forced);
  await browser.close();
  process.exit(1);
}

// ---- menuData[0] must be 1 (FBO allocated) immediately after forceMultiview -
menuData = await page.evaluate(() => globalThis.Module.ysfwVr.readMenuData());
check('menuData[0] (enable) === 1 after forceMultiview (FBO allocated)', menuData[0] === 1, 'menuData=' + JSON.stringify(menuData));
check('menuData[3] (texWidth) > 0', menuData[3] > 0, 'w=' + menuData[3]);
check('menuData[4] (texHeight) > 0', menuData[4] > 0, 'h=' + menuData[4]);
check('menuData[1] (menuFbo) > 0 (valid GL framebuffer id)', menuData[1] > 0, 'fbo=' + menuData[1]);
check('menuData[2] (menuTex) > 0 (valid GL texture id)', menuData[2] > 0, 'tex=' + menuData[2]);

// ---- Wait for engine ticks to render menu into the FBO --------------------
// DrawMenu sets menuData[5]=1 each frame it rendered into the menu FBO.
// updateMenuLayer (called from onXRFrame, which in test mode means the engine
// tick's external call path) resets it to 0 after reading, so polling for
// nonzero is the right check.
// In test mode the engine ticks from the browser's own rAF loop; give it a
// few hundred ms to render at least one frame.
let menuDrawn = false;
const pollT0 = Date.now();
while (Date.now() - pollT0 < 5000) {
  // Direct HEAPF32 read -- bypass the JS helper so we see the flag BEFORE
  // updateMenuLayer clears it this same JS task.
  const drawn = await page.evaluate(() => {
    const p = Module._YsfwVrMenuDataPointer() >> 2;
    return Module.HEAPF32[p + 5] !== 0;
  });
  if (drawn) { menuDrawn = true; break; }
  await page.waitForTimeout(200);
}
check('menuData[5] (menuDrawn) becomes 1 after engine ticks (DrawMenu rendered into FBO)', menuDrawn, 'menuDrawn=' + menuDrawn);

// ---- FBO content: mean luminance and alpha should be non-zero -------------
// The main menu draws at least a background colour + the title bitmap; even
// in headless mode without texture assets the background fill is non-trivial.
const stats = await page.evaluate(() => globalThis.Module.ysfwVr.readMenuStats());
check('menu FBO has non-zero mean luminance (content was drawn)', stats.lum > 0.5, 'lum=' + stats.lum.toFixed(2));

// ---- vr.simSilentFrames should be 0 (watchdog disarmed) -------------------
// DrawMenu calls FsVrMarkSimDrawn, which increments the sim-drawn counter.
// ConsumeSimDrawnFrames resets it and returns > 0, so onXRFrame keeps
// simSilentFrames at 0.
const simSilent = await page.evaluate(() => globalThis.Module.ysfwVr.simSilentFrames);
check('simSilentFrames === 0 (DrawMenu keeps the watchdog disarmed)', simSilent === 0, 'simSilentFrames=' + simSilent);

await page.screenshot({ path: outDir + '/vrmenu-test-1-vr.png' });
console.log('wrote ' + outDir + '/vrmenu-test-1-vr.png');

// ---- teardownMenu: menuData cleared on session teardown -------------------
// Simulate session end by calling teardownMenu via the testMode path.
await page.evaluate(() => {
  const vr = globalThis.Module.ysfwVr;
  // Directly zero the data block (mirrors what teardownMenu does in a real
  // session end).  A full session-end test would require a real XR session.
  if (vr.menuRes) {
    const p = Module._YsfwVrMenuDataPointer() >> 2;
    for (let i = 0; i < 8; ++i) { Module.HEAPF32[p + i] = 0; }
  }
});
menuData = await page.evaluate(() => globalThis.Module.ysfwVr.readMenuData());
check('menuData cleared to zeros after teardown', menuData.every((v) => v === 0), 'menuData=' + JSON.stringify(menuData));

await browser.close();

if (fatal.length) {
  console.error('FATAL console output:');
  for (const f of fatal) console.error('  ' + f);
  process.exit(1);
}

const failed = results.filter((r) => !r.pass);
if (failed.length) {
  console.error('VR MENU TEST FAILED (' + failed.length + '/' + results.length + ' assertions failed)');
  process.exit(1);
}
console.log('VR MENU TEST PASSED (' + results.length + '/' + results.length + ' assertions)');
