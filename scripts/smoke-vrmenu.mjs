// VR main-menu-in-VR test without a headset.
//
// Boots the BARE page (no ?freeflight -- presses the pack panel's Play button
// like a user) and switches the engine into VR-presenting mode through
// vr.forceVrMenu.  Unlike the other VR smokes (which use vr.forceMultiview and
// therefore need a real multiview-capable GPU, so they run locally), the menu
// FBO is a plain mono RGBA texture and DrawMenu's off-screen pass never
// touches the multiview machinery -- so this smoke needs no OVR_multiview2
// and runs on CI's GPU-less runners.  Verifies:
//
//   1. The VR test hooks / wasm exports are accessible.
//   2. After forceVrMenu, menuData[0] === 1 (FBO allocated, enable flag set).
//   3. menuData[3] and menuData[4] are the canvas width/height (FBO size).
//   4. After a few engine ticks, menuData[5] becomes 1 (DrawMenu wrote to FBO).
//   5. The menu FBO contains non-trivial content (mean luminance > 0).
//   6. DrawMenu feeds the watchdog: FsVrConsumeSimDrawnFrames() > 0 while the
//      menu is being rendered (FsVrMarkSimDrawn each menu frame).
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
// Ring buffer of recent console output for boot-failure diagnostics: when the
// engine never boots there is no assertion to point at the cause, so the boot
// wait's catch block dumps this instead.
const consoleTail = [];
page.on('console', (m) => {
  const t = m.text();
  consoleTail.push(t.length > 300 ? t.slice(0, 300) + '...' : t);
  if (consoleTail.length > 60) consoleTail.shift();
  if (FATAL_PATTERNS.some((re) => re.test(t))) fatal.push('[console] ' + t);
});
page.on('pageerror', (e) => fatal.push('[pageerror] ' + e.message));
page.on('requestfailed', (r) => {
  // Only same-origin failures are diagnostic: third-party analytics (e.g.
  // cloudflareinsights.com) are expected to fail from localhost and must not
  // fail the smoke.
  let sameOrigin = false;
  try { sameOrigin = new URL(r.url()).origin === new URL(baseUrl).origin; } catch (e) {}
  if (sameOrigin) fatal.push('[requestfailed] ' + r.url() + ' -- ' + (r.failure() ? r.failure().errorText : '?'));
});

// ---- Boot to the main menu (NOT a free flight) ----------------------------
// The bare page (no ?freeflight/?join/?replay) holds the engine boot at the
// pre-boot pack panel by design: index.html's preRun keeps the 'ysfw-packs'
// run dependency until packs-ui.js's start() -- i.e. until the user presses
// "▶ Play" (#ysfw-pack-play).  So do what a user does: wait for the panel's
// Play button and click it, THEN wait for the engine to reach the main menu.
await page.goto(baseUrl);
await page.waitForSelector('#ysfw-pack-play', { timeout: 30000 });
await page.click('#ysfw-pack-play');
// `globalThis.Module` exists long before the wasm engine finishes booting (it
// is the plain config object the HTML shell defines up front), so waiting for
// it plus a fixed sleep raced the boot on CI ("VR menu test hooks missing").
// Wait for the actual VR test hooks instead: Module.ysfwVr and its helpers
// are installed by YsfwInstallWebXR during engine startup, right before the
// main-menu loop begins.
try {
  await page.waitForFunction(() => {
    const M = globalThis.Module;
    const vr = M && M.ysfwVr;
    return !!(vr && vr.forceMultiview && vr.readMenuData && vr.readMenuStats);
  }, null, { timeout: 120000 });
} catch (e) {
  // Boot never reached the VR-hook install (FsAfterOpenWindow).  Dump enough
  // state to diagnose from the CI log alone: page errors / failed requests,
  // the console tail, and a probe of how far the shell got.
  console.error('FAILED: engine boot did not reach the VR hooks in 120s');
  const probe = await page.evaluate(() => {
    const M = globalThis.Module;
    return {
      readyState: document.readyState,
      engineScripts: Array.from(document.querySelectorAll('script[src]')).map((s) => s.src.split('/').pop()),
      hasCanvas: !!document.getElementById('canvas'),
      overlayShown: (() => { const o = document.getElementById('overlay'); return o ? getComputedStyle(o).display : 'no-overlay'; })(),
      moduleKeys: M ? Object.keys(M).slice(0, 30) : null,
      calledRun: !!(M && M.calledRun),
      ysfwVr: !!(M && M.ysfwVr),
      inFlight: globalThis.ysfwInFlight,
    };
  }).catch((err) => 'probe failed: ' + err.message);
  console.error('probe: ' + JSON.stringify(probe, null, 1));
  if (fatal.length) {
    console.error('fatal events:');
    for (const f of fatal) console.error('  ' + f);
  }
  console.error('console tail (' + consoleTail.length + ' lines):');
  for (const l of consoleTail) console.error('  | ' + l);
  await page.screenshot({ path: outDir + '/vrmenu-timeout.png' });
  console.error('wrote ' + outDir + '/vrmenu-timeout.png');
  await browser.close();
  process.exit(1);
}
// Let the engine settle into the main-menu draw loop.
await page.waitForTimeout(1000);

await page.screenshot({ path: outDir + '/vrmenu-test-0-menu.png' });
console.log('wrote ' + outDir + '/vrmenu-test-0-menu.png');

// ---- Check VR test hooks are present ---------------------------------------
// The vr.* hooks are guaranteed by the boot wait above; this additionally
// verifies the wasm function exports are attached to Module (function exports
// are, unlike runtime views such as HEAPF32 -- hence all block reads/writes
// below go through the vr.* helpers), and names the missing hook on failure.
const missingHook = await page.evaluate(() => {
  const M = globalThis.Module;
  const vr = M && M.ysfwVr;
  if (!vr) return 'Module.ysfwVr';
  for (const k of ['forceVrMenu', 'readMenuData', 'readMenuStats', 'teardownMenuForTest']) {
    if (!vr[k]) return 'vr.' + k;
  }
  if (typeof M._YsfwVrMenuDataPointer !== 'function') return 'Module._YsfwVrMenuDataPointer';
  if (typeof M._YsfwVrConsumeSimDrawnFrames !== 'function') return 'Module._YsfwVrConsumeSimDrawnFrames';
  return null;
});
if (missingHook) {
  console.error('FAILED: VR menu test hook missing: ' + missingHook);
  await browser.close();
  process.exit(1);
}

// ---- menuData should start at all zeros before VR engages ------------------
let menuData = await page.evaluate(() => globalThis.Module.ysfwVr.readMenuData());
check('menuData all zeros before forceVrMenu', menuData.every((v) => v === 0), 'menuData=' + JSON.stringify(menuData));

// ---- Enter VR-presenting mode (menu path only, NO multiview) ---------------
// The menu FBO is a plain mono texture and DrawMenu's off-screen pass never
// touches the multiview scene machinery, so this smoke uses forceVrMenu --
// which does not require OVR_multiview2 -- and therefore runs on CI's
// GPU-less runners (forceMultiview and the other VR smokes need a real GPU
// and run locally instead).
const forced = await page.evaluate(() => {
  const vr = globalThis.Module.ysfwVr;
  return vr.forceVrMenu();
});
check('forceVrMenu returned ok', forced === 'ok', 'result=' + forced);
if (forced !== 'ok') {
  console.error('FAILED to force VR menu mode: ' + forced);
  await browser.close();
  process.exit(1);
}

// ---- menuData[0] must be 1 (FBO allocated) immediately after forceVrMenu ---
menuData = await page.evaluate(() => globalThis.Module.ysfwVr.readMenuData());
check('menuData[0] (enable) === 1 after forceVrMenu (FBO allocated)', menuData[0] === 1, 'menuData=' + JSON.stringify(menuData));
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
while (Date.now() - pollT0 < 15000) {
  // readMenuData reads the block from the EM_JS glue scope (page scripts
  // cannot touch Module.HEAPF32 -- not an exported runtime method).  Nothing
  // clears [5] in test mode (updateMenuLayer only runs in a real XR session),
  // so polling the helper is exact.
  const drawn = await page.evaluate(() => globalThis.Module.ysfwVr.readMenuData()[5] !== 0);
  if (drawn) { menuDrawn = true; break; }
  await page.waitForTimeout(200);
}
check('menuData[5] (menuDrawn) becomes 1 after engine ticks (DrawMenu rendered into FBO)', menuDrawn, 'menuDrawn=' + menuDrawn);

// ---- FBO content: mean luminance and alpha should be non-zero -------------
// The main menu draws at least a background colour + the title bitmap; even
// in headless mode without texture assets the background fill is non-trivial.
const stats = await page.evaluate(() => globalThis.Module.ysfwVr.readMenuStats());
check('menu FBO has non-zero mean luminance (content was drawn)', stats.lum > 0.5, 'lum=' + stats.lum.toFixed(2));

// ---- Sky: never allocated on this path --------------------------------------
// forceVrMenu does not call setupSky (the sky needs a real XR layers binding);
// this just verifies nothing on the menu path allocated it by accident.
const skyRes = await page.evaluate(() => {
  const s = globalThis.Module.ysfwVr.skyRes;
  return s === null || s === undefined ? 'unset' : JSON.stringify(s);
});
check('skyRes stays unset on the menu-only test path', skyRes === 'unset', 'skyRes=' + skyRes);

// ---- Watchdog feed: DrawMenu marks every menu frame as sim-drawn -----------
// FsVrMarkSimDrawn increments the engine-side counter that onXRFrame's
// watchdog consumes (FsVrConsumeSimDrawnFrames): a positive value here is the
// direct proof that menu frames keep a real session alive.  (Consuming it in
// the test is safe -- no onXRFrame loop runs in test mode.)
const simFed = await page.evaluate(() => globalThis.Module._YsfwVrConsumeSimDrawnFrames());
check('FsVrMarkSimDrawn fed the watchdog (consumed > 0 menu frames)', simFed > 0, 'consumed=' + simFed);

await page.screenshot({ path: outDir + '/vrmenu-test-1-vr.png' });
console.log('wrote ' + outDir + '/vrmenu-test-1-vr.png');

// ---- teardownMenu: menuData cleared on session teardown -------------------
// Run the REAL teardown (vr.teardownMenuForTest wraps teardownMenu): it must
// zero the whole data block and free the GL resources -- the same code a real
// session end runs.
await page.evaluate(() => globalThis.Module.ysfwVr.teardownMenuForTest());
menuData = await page.evaluate(() => globalThis.Module.ysfwVr.readMenuData());
check('menuData cleared to zeros after teardown', menuData.every((v) => v === 0), 'menuData=' + JSON.stringify(menuData));
const menuResAfter = await page.evaluate(() => !!globalThis.Module.ysfwVr.menuRes);
check('menuRes released after teardown', menuResAfter === false, 'menuRes=' + menuResAfter);

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
