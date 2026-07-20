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
  for (const k of [
    'forceVrMenu', 'readMenuData', 'readMenuStats', 'teardownMenuForTest',
    'intersectRayWithAnchoredQuad', 'fitMenuTextureSize', 'menuQuadMetricSize',
    'chooseMenuRayHand', 'menuUvToPixel', 'cursorOverlayPoint', 'beamPoseFor',
  ]) {
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

// ---- Pure ray-vs-quad intersection math (no XR state needed) ---------------
// vr.intersectRayWithAnchoredQuad is the exact function processMenuRayInput
// uses to turn a controller ray into menu UV coordinates; it is pure math
// (same test-hook pattern as vr.yawOnlyQuatFromOrientation), so headless CI
// can pin down the geometry: centre hit, edge precision, arbitrary-yaw
// anchors, and backface/behind-origin rejection.
// Quad: 1.6m x 1.2m.  u/v convention: u,v in [0,1], v=0 at the TOP edge.
const rayTests = await page.evaluate(() => {
  const isect = globalThis.Module.ysfwVr.intersectRayWithAnchoredQuad;
  const I = { x: 0, y: 0, z: 0, w: 1 };            // identity quat
  const yaw90 = { x: 0, y: Math.sin(Math.PI / 4), z: 0, w: Math.cos(Math.PI / 4) }; // +90deg yaw: local -Z -> world -X
  const yaw180 = { x: 0, y: 1, z: 0, w: 0 };       // 180deg yaw: local -Z -> world +Z
  const W = 1.6, H = 1.2;
  const front = { x: 0, y: 0, z: -1.8 };           // quad 1.8m in front, facing +Z
  const side = { x: -1.8, y: 0, z: 0 };            // quad 1.8m to the left, facing +X
  return {
    centre: isect({ x: 0, y: 0, z: 0 }, I, front, I, W, H),
    edge: isect({ x: -0.7999, y: 0.5999, z: 0 }, I, front, I, W, H),
    yawed: isect({ x: 0, y: 0, z: 0 }, yaw90, side, yaw90, W, H),
    backface: isect({ x: 0, y: 0, z: -3.6 }, yaw180, front, I, W, H),
    behind: isect({ x: 0, y: 0, z: 0 }, yaw180, front, I, W, H),
  };
});
{
  const c = rayTests.centre;
  check('ray-quad: head-on ray hits quad centre (u,v ~ 0.5)',
    c !== null && Math.abs(c.u - 0.5) < 0.001 && Math.abs(c.v - 0.5) < 0.001,
    'hit=' + JSON.stringify(c));
  // 0.1mm inside the top-left corner: u = ( -0.7999 + 0.8 ) / 1.6 = 6.25e-5
  // and v = ( 0.6 - 0.5999 ) / 1.2 ~ 8.33e-5 -- on an 800x600 texture that is
  // u*800 = 0.05px / v*600 = 0.05px, i.e. within the outermost pixel, so the
  // whole quad surface is reachable down to the last pixel.
  const e = rayTests.edge;
  check('ray-quad: ray 0.1mm inside the top-left corner still hits, within the edge pixel',
    e !== null && e.u > 0 && e.u < 1 / 800 && e.v > 0 && e.v < 1 / 600,
    'hit=' + JSON.stringify(e));
  // Anchor yawed 90deg (quad face normal = world +X), ray from the origin
  // aimed -X with the same yaw: must be a head-on centre hit -- the math may
  // not assume an axis-aligned anchor.
  const y = rayTests.yawed;
  check('ray-quad: 90deg-yawed anchor hit head-on lands at centre',
    y !== null && Math.abs(y.u - 0.5) < 0.001 && Math.abs(y.v - 0.5) < 0.001,
    'hit=' + JSON.stringify(y));
  check('ray-quad: ray from behind the quad (backface) is rejected',
    rayTests.backface === null, 'hit=' + JSON.stringify(rayTests.backface));
  check('ray-quad: ray aimed away from the quad is rejected',
    rayTests.behind === null, 'hit=' + JSON.stringify(rayTests.behind));
}

// ---- Quest-size menu fit + full-edge pixel mapping -----------------------
// A high-DPI Quest canvas can exceed 2048px on both axes.  Both dimensions
// must use one scale factor: independent clamps turned 3200x1800 into
// 2048x1800 (nearly square), shrinking the usable ray area toward the centre.
const menuGeometryTests = await page.evaluate(() => {
  const vr = globalThis.Module.ysfwVr;
  const fitted = vr.fitMenuTextureSize(3200, 1800, 2048);
  const metric = vr.menuQuadMetricSize(fitted.w, fitted.h);
  return {
    fitted,
    metric,
    topLeft: vr.menuUvToPixel(0, 0, fitted.w, fitted.h),
    bottomRight: vr.menuUvToPixel(1, 1, fitted.w, fitted.h),
    cursorTopLeft: vr.cursorOverlayPoint(0, 0, 1024, 576),
    cursorBottomRight: vr.cursorOverlayPoint(1, 1, 1024, 576),
  };
});
check('menu fit: high-DPI 16:9 canvas keeps aspect while capping at 2048px',
  menuGeometryTests.fitted.w === 2048 && menuGeometryTests.fitted.h === 1152,
  'fit=' + JSON.stringify(menuGeometryTests.fitted));
check('menu fit: physical quad keeps the same 16:9 aspect',
  Math.abs(menuGeometryTests.metric.w - 1.6) < 1e-9 && Math.abs(menuGeometryTests.metric.h - 0.9) < 1e-9,
  'metric=' + JSON.stringify(menuGeometryTests.metric));
check('menu ray: UV corners map inside the first/last valid texture pixels',
  menuGeometryTests.topLeft.x === 0 && menuGeometryTests.topLeft.y === 0 &&
  menuGeometryTests.bottomRight.x === 2047 && menuGeometryTests.bottomRight.y === 1151,
  'pixels=' + JSON.stringify(menuGeometryTests));
check('menu cursor: overlay uses the same full-range UV corners (no central-square transform)',
  menuGeometryTests.cursorTopLeft.x === 0 && menuGeometryTests.cursorTopLeft.y === 0 &&
  menuGeometryTests.cursorBottomRight.x === 1023 && menuGeometryTests.cursorBottomRight.y === 575,
  'cursorPixels=' + JSON.stringify({ topLeft: menuGeometryTests.cursorTopLeft, bottomRight: menuGeometryTests.cursorBottomRight }));

// ---- Controller laser beam pose (pure math) ------------------------------
// vr.beamPoseFor orients a thin quad so its local +Y runs along the ray and
// its +Z faces the head (billboarded ribbon).  Checked here: midpoint
// placement, +Y alignment with the ray, +Z toward the head, and unit quat.
const beamTests = await page.evaluate(() => {
  const vr = globalThis.Module.ysfwVr;
  const rot = (v, q) => {
    // quat rotate (same math as the implementation's rotateVecByQuat).
    const x = q.x, y = q.y, z = q.z, w = q.w;
    const tx = 2 * (y * v.z - z * v.y), ty = 2 * (z * v.x - x * v.z), tz = 2 * (x * v.y - y * v.x);
    return {
      x: v.x + w * tx + (y * tz - z * ty),
      y: v.y + w * ty + (z * tx - x * tz),
      z: v.z + w * tz + (x * ty - y * tx)
    };
  };
  // Hand at (0.2, 1.2, 0), pointing straight at -Z, head behind at (0, 1.6, 0.3).
  const bp = vr.beamPoseFor({ x: 0.2, y: 1.2, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1.6, z: 0.3 }, 2.0);
  if (!bp) return { bp: null };
  const yAxis = rot({ x: 0, y: 1, z: 0 }, bp.quat);
  const zAxis = rot({ x: 0, y: 0, z: 1 }, bp.quat);
  const qLen = Math.sqrt(bp.quat.x ** 2 + bp.quat.y ** 2 + bp.quat.z ** 2 + bp.quat.w ** 2);
  const toHead = { x: 0 - bp.pos.x, y: 1.6 - bp.pos.y, z: 0.3 - bp.pos.z };
  const zDotHead = zAxis.x * toHead.x + zAxis.y * toHead.y + zAxis.z * toHead.z;
  const degenerate = vr.beamPoseFor({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1.6, z: 0 }, 2.0);
  return { bp, yAxis, qLen, zDotHead, degenerate };
});
check('beam pose: midpoint sits halfway along the ray',
  beamTests.bp && Math.abs(beamTests.bp.pos.x - 0.2) < 1e-6 && Math.abs(beamTests.bp.pos.y - 1.2) < 1e-6 && Math.abs(beamTests.bp.pos.z - (-1.0)) < 1e-6,
  'bp=' + JSON.stringify(beamTests.bp));
check('beam pose: local +Y runs along the ray direction',
  beamTests.bp && Math.abs(beamTests.yAxis.x) < 1e-6 && Math.abs(beamTests.yAxis.y) < 1e-6 && Math.abs(beamTests.yAxis.z - (-1)) < 1e-6,
  'yAxis=' + JSON.stringify(beamTests.yAxis));
check('beam pose: unit quaternion, +Z faces the head',
  beamTests.bp && Math.abs(beamTests.qLen - 1) < 1e-6 && beamTests.zDotHead > 0,
  'qLen=' + beamTests.qLen + ' zDotHead=' + beamTests.zDotHead);
check('beam pose: degenerate zero-direction input returns null',
  beamTests.degenerate === null, 'got ' + JSON.stringify(beamTests.degenerate));

// ---- Two-hand pointer arbitration ----------------------------------------
// Both hits remain visible; the engine mouse has one owner.  A fresh trigger
// edge from either hand must claim it, while an active drag cannot be stolen.
const handTests = await page.evaluate(() => {
  const pick = globalThis.Module.ysfwVr.chooseMenuRayHand;
  const idle = { right: false, left: false };
  return {
    onlyLeft: pick({ right: null, left: { trig: false } }, null, false, idle),
    stableRight: pick({ right: { trig: false }, left: { trig: false } }, 'right', false, idle),
    leftClaims: pick({ right: { trig: false }, left: { trig: true } }, 'right', false, idle),
    rightClaims: pick({ right: { trig: true }, left: { trig: false } }, 'left', false, idle),
    dragKeepsLeft: pick({ right: { trig: true }, left: { trig: true } }, 'left', true, idle),
    leftMovementClaimsHover: pick(
      { right: { trig: false }, left: { trig: false } }, 'right', false, idle,
      { right: false, left: true }),
    rightMovementClaimsHover: pick(
      { right: { trig: false }, left: { trig: false } }, 'left', false, idle,
      { right: true, left: false }),
  };
});
check('menu ray: left hand works when it is the only hit', handTests.onlyLeft === 'left', JSON.stringify(handTests));
check('menu ray: hover owner remains stable while both hands point', handTests.stableRight === 'right', JSON.stringify(handTests));
check('menu ray: fresh left trigger claims the pointer', handTests.leftClaims === 'left', JSON.stringify(handTests));
check('menu ray: fresh right trigger claims the pointer', handTests.rightClaims === 'right', JSON.stringify(handTests));
check('menu ray: an active left drag cannot be stolen by right', handTests.dragKeepsLeft === 'left', JSON.stringify(handTests));
check('menu ray: moving the left hand transfers hover ownership', handTests.leftMovementClaimsHover === 'left', JSON.stringify(handTests));
check('menu ray: moving the right hand transfers hover ownership', handTests.rightMovementClaimsHover === 'right', JSON.stringify(handTests));

// ---- Text-input bridge (system-keyboard summon machinery) -----------------
// Drives the hidden-input bridge without a headset: the summon gate
// (menuData[6] + a recent menu click), the soft-keyboard event forwarding
// (insertText/deleteContentBackward as 'input' events, Enter as a keydown),
// and the put-away path (flag drop -> blur).  Engine-side delivery is the
// same FsPushKey/FsPushChar pair flat typing uses (FsPushTextEdit), counted
// here via the bridge's stats.
const textBridge = await page.evaluate(() => {
  const M = globalThis.Module;
  const vr = M.ysfwVr;
  const el = vr.textBridgeEnsure();
  const st = vr.textBridgeState();
  const out = {};

  // Summon gate: focus flag up + recent click -> input takes focus.
  vr.pokeMenuData(6, 1);
  st.lastMenuClickAt = performance.now();
  vr.textBridgeUpdate(true);
  out.focusedOnClick = (document.activeElement === el);

  // No fresh click -> no re-summon after a dismissal.
  el.blur();
  vr.textBridgeUpdate(true);
  out.noResummonWithoutClick = (document.activeElement !== el);

  // Typing: soft-keyboard-style events while focused.
  st.lastMenuClickAt = performance.now();
  vr.textBridgeUpdate(true);
  const chars0 = st.stats.chars, edits0 = st.stats.edits;
  el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'ab' }));
  out.charsForwarded = (st.stats.chars - chars0);
  el.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward' }));
  el.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' }));
  out.editsForwarded = (st.stats.edits - edits0);
  out.sentinelRefilled = (el.value.length > 0);

  // Put-away: engine focus flag drops -> input blurs (keyboard dismissed).
  vr.pokeMenuData(6, 0);
  vr.textBridgeUpdate(true);
  out.blurredOnFlagDrop = (document.activeElement !== el);
  return out;
});
check('text bridge: click + focus flag summons (focuses) the hidden input', textBridge.focusedOnClick === true, JSON.stringify(textBridge));
check('text bridge: a dismissed keyboard is not re-summoned without a fresh click', textBridge.noResummonWithoutClick === true, JSON.stringify(textBridge));
check('text bridge: insertText forwards each character to the engine', textBridge.charsForwarded === 2, JSON.stringify(textBridge));
check('text bridge: backspace + Enter forward as edit actions', textBridge.editsForwarded === 2, JSON.stringify(textBridge));
check('text bridge: sentinel text is refilled so backspace always has a target', textBridge.sentinelRefilled === true, JSON.stringify(textBridge));
check('text bridge: focus-flag drop puts the keyboard away (input blurred)', textBridge.blurredOnFlagDrop === true, JSON.stringify(textBridge));

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
