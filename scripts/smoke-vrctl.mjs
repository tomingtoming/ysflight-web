// VR controller path test without a headset.
//
// Boots ysflight-web into a free flight, then drives Module.ysfwVr's headless
// controller test hook (vr.pokeControllerFrame) to exercise the whole
// controller -> control-block pipeline documented in
// upstream/YSFLIGHT/src/graphics/common/fsvr.h and implemented in
// src/port/platform_emscripten/fswebxr.cpp:
//   - right grip = virtual stick (grab + wrist deflection -> aileron/
//     elevator/rudder)
//   - left grip  = virtual throttle lever (grab + forward push -> throttle)
//   - right trigger = fire-gun key (synthetic KeyboardEvent)
//
// The control block is read back through vr.readControlBlock(), a small
// test-only hook in fswebxr.cpp that reads _YsfwVrControlDataPointer()'s
// HEAPF32 slots from inside the EM_JS closure (the read-side counterpart of
// the existing pokeEye write hook).  NOTE: a first guess would be to read
// Module.HEAPF32 / Module.wasmMemory directly from here, but neither is
// exported by this build -- EXPORTED_RUNTIME_METHODS does not list them, and
// Module.wasmMemory throws Emscripten's "not exported, add it to
// EXPORTED_RUNTIME_METHODS" guard at access time (confirmed by trying it).
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8923/index.html?freeflight=F-15C_EAGLE';
const outDir = process.argv[3] || '.';

const FATAL_PATTERNS = [
  /Link Status 0/, /Compile Status 0/, /declared as type/, /Error Message: error/,
  /Aborted\(/, /Failed to create WebGL context/, /Feedback loop/,
  /invalid internalformat/, /INVALID_ENUM/, /does not match uniform method/,
  /GL_INVALID/, /RuntimeError/
];

const results = [];
function check(name, cond, detail) {
  const line = (cond ? 'PASS' : 'FAIL') + ': ' + name + (detail !== undefined ? ' (' + detail + ')' : '');
  console.log(line);
  results.push({ name, pass: !!cond });
}

const browser = await chromium.launch({
  executablePath: process.env.YSFW_CHROMIUM || undefined,
  headless: true,
  // Native-GL ANGLE: SwiftShader's default backend lacks OVR_multiview2, which
  // Group 11 (help placards) needs via vr.forceMultiview -- same flag as
  // scripts/smoke-mv.mjs/smoke-vrdial.mjs/smoke-vrhud.mjs.
  args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=gl']
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const fatal = [];
page.on('console', (m) => {
  const t = m.text();
  if (FATAL_PATTERNS.some((re) => re.test(t))) fatal.push('[console] ' + t);
});
page.on('pageerror', (e) => fatal.push('[pageerror] ' + e.message));

await page.goto(url);

// Boot flow copied from scripts/smoke-vr.mjs: dismiss the "no joystick"
// dialog until the flight has spawned, then release the "CENTER JOYSTICK...
// TO GO!" hold with a real Space press.
await page.waitForFunction(() => !!globalThis.Module, null, { timeout: 90000 });
{
  const t0 = Date.now();
  let inFlight = false;
  while (Date.now() - t0 < 120000) {
    inFlight = await page.evaluate(() => globalThis.ysfwInFlight === true);
    if (inFlight) break;
    await page.mouse.click(61, 169); // engine dialog 閉じる button
    await page.waitForTimeout(2000);
  }
  if (!inFlight) {
    await page.screenshot({ path: outDir + '-0-stuck.png' });
    console.error('FAILED: flight never started');
    await browser.close();
    process.exit(1);
  }
}
await page.keyboard.press('Space');
await page.waitForTimeout(1000);
await page.keyboard.press('Space');
await page.waitForTimeout(2000);

// Confirm the test hooks exist before relying on them.
const hooksOk = await page.evaluate(() => {
  const M = globalThis.Module;
  const vr = M && M.ysfwVr;
  return !!(vr && vr.pokeControllerFrame && vr.setPresenting && vr.readControlBlock);
});
if (!hooksOk) {
  console.error('FAILED: controller test hooks missing (pokeControllerFrame / setPresenting / readControlBlock)');
  await browser.close();
  process.exit(1);
}

// Install a keydown listener before the trigger test needs it.
await page.evaluate(() => {
  window.__vrctlKeys = [];
  window.addEventListener('keydown', (e) => window.__vrctlKeys.push(e.code));
});

function readCtl() {
  return globalThis.Module.ysfwVr.readControlBlock();
}

// ---- Group 1: pitch -> elevator -----------------------------------------
// Grab the right (stick) hand at an identity grip pose, then move the grip
// to +22.5deg about the local X axis -- half of the 45deg max deflection.
// Per fswebxr.cpp's deflectionFromDeltaQ, a positive rotation about the
// local X axis tilts the controller's front (-Z) upward, which is the wrist
// pitching back (nose-up intent) -- elevator is +pitch directly (no sign
// flip), so this should read out as elevator ~= +0.5, aileron/rudder ~= 0.
const g1 = await page.evaluate((halfAngle) => {
  const M = globalThis.Module;
  const vr = M.ysfwVr;
  vr.setPresenting(true);
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 1, trigger: 0, buttons: {} }]);
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: [Math.sin(halfAngle), 0, 0, Math.cos(halfAngle)], squeeze: 1, trigger: 0, buttons: {} }]);
  return true;
}, 11.25 * Math.PI / 180);
void g1;
const b1 = await page.evaluate(readCtl);
console.log('pitch-test block:', JSON.stringify(b1));
check('pitch: stickGrabbed=1', 1 === b1[0], 'got ' + b1[0]);
check('pitch: elevator ~= +0.5 (wrist pitched back = nose up)', Math.abs(b1[2] - 0.5) < 0.08, 'got ' + b1[2]);
check('pitch: aileron ~= 0 (pure pitch)', Math.abs(b1[1]) < 0.05, 'got ' + b1[1]);
check('pitch: rudder ~= 0 (pure pitch)', Math.abs(b1[3]) < 0.05, 'got ' + b1[3]);

// ---- Group 2: roll -> aileron -------------------------------------------
// Release (springs to neutral), fresh-grab at identity, then rotate the
// grip +22.5deg about the local Z axis with the SIGN CHOSEN to represent
// "wrist rolls right": per fswebxr.cpp's comments, a positive Z rotation
// (positive quat z-component) swings the right-reference vector UP, which
// is the wrist rolling LEFT as the user sees it looking down their own arm
// -- so "wrist rolls right" is a NEGATIVE z-component here, and aileron
// should read out positive (~+0.5) for it.
const b2 = await page.evaluate((halfAngle) => {
  const M = globalThis.Module;
  const vr = M.ysfwVr;
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: {} }]); // release
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 1, trigger: 0, buttons: {} }]); // fresh grab
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: [0, 0, -Math.sin(halfAngle), Math.cos(halfAngle)], squeeze: 1, trigger: 0, buttons: {} }]);
  return vr.readControlBlock();
}, 11.25 * Math.PI / 180);
console.log('roll-test block:', JSON.stringify(b2));
check('roll: stickGrabbed=1', 1 === b2[0], 'got ' + b2[0]);
check('roll: aileron ~= +0.5 (wrist rolled right)', Math.abs(b2[1] - 0.5) < 0.08, 'got ' + b2[1]);
check('roll: elevator ~= 0 (pure roll)', Math.abs(b2[2]) < 0.05, 'got ' + b2[2]);

// ---- Group 3: throttle ----------------------------------------------------
// Release the right/stick hand, grab the left/throttle hand at the origin,
// then push it 0.08m along the default (identity-viewer) forward direction
// (0,0,-1) -- expect throttle ~= 0.08*6 = 0.48.  Release and confirm the
// value stays latched (not reset to 0), throttleGrabbed drops to 0, and
// throttleEverGrabbed stays 1.
const g3 = await page.evaluate(() => {
  const M = globalThis.Module;
  const vr = M.ysfwVr;
  const read = () => vr.readControlBlock();
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: {} }]); // tidy up the right hand
  vr.pokeControllerFrame([{ hand: 'left', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 1, trigger: 0, buttons: {} }]); // grab-begin at origin
  vr.pokeControllerFrame([{ hand: 'left', pos: [0, 0, -0.08], quat: [0, 0, 0, 1], squeeze: 1, trigger: 0, buttons: {} }]); // push forward 0.08m
  const afterPush = read();
  vr.pokeControllerFrame([{ hand: 'left', pos: [0, 0, -0.08], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: {} }]); // release
  const afterRelease = read();
  return { afterPush, afterRelease };
});
console.log('throttle-test blocks:', JSON.stringify(g3));
check('throttle: throttleGrabbed=1 while grabbed', 1 === g3.afterPush[4], 'got ' + g3.afterPush[4]);
check('throttle: value ~= 0.48 after 0.08m push', Math.abs(g3.afterPush[5] - 0.48) < 0.06, 'got ' + g3.afterPush[5]);
check('throttle: throttleGrabbed=0 after release', 0 === g3.afterRelease[4], 'got ' + g3.afterRelease[4]);
check('throttle: value stays latched (~0.48) after release', Math.abs(g3.afterRelease[5] - 0.48) < 0.06, 'got ' + g3.afterRelease[5]);
check('throttle: throttleEverGrabbed=1 after release', 1 === g3.afterRelease[6], 'got ' + g3.afterRelease[6]);

// ---- Group 4: trigger -> synthetic fire-gun key --------------------------
// Default fire key per SetDefaultKeyAssign (fscontrol.cpp) is FSKEY_SPACE
// (FSBTF_FIREWEAPON); fssimplewindow_emscripten.cpp's keyCodeMapping maps
// the DOM code string "Space" to FSKEY_SPACE.
const keysAfterTrigger = await page.evaluate(() => {
  const M = globalThis.Module;
  const vr = M.ysfwVr;
  window.__vrctlKeys = [];
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: {} }]); // ensure a clean 0-edge
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 0, trigger: 1, buttons: {} }]); // trigger edge 0->1
  return window.__vrctlKeys.slice();
});
check('trigger: fire-gun key ("Space") dispatched', keysAfterTrigger.includes('Space'), 'keys=' + JSON.stringify(keysAfterTrigger));

// ---- Group 5 (extra coverage): face buttons -> brake / view-cycle keys ---
// Right A no longer fires gear on the bare press edge (see Feature 1 / Group
// 6 below): a press with no release yet must NOT dispatch KeyG immediately.
// Left Y (Fix B) is different: it dispatches its view-cycle tap on the PRESS
// EDGE itself (not on release, unlike X/A's tap-vs-hold pattern -- see
// fswebxr.cpp's left-hand branch), so this bare press already fires it. This
// is the FIRST-ever Y interaction in this whole script, starting from the
// freeflight spawn's default cockpit view (aircraft-state block slot [6] ==
// 0, fsvr.h), so the dispatched key must specifically be F2 (advance into
// the external-view chain) -- later groups, after this one has already
// nudged the view-cycle state, only assert "a view key", not which one. X is
// deliberately left unpressed here (only a/b on the RIGHT hand, only b on
// the LEFT hand) so this frame's key list stays unambiguous for the Y
// assertion; X's own (lack of) tap behaviour is Group 6b's job in isolation.
const keysAfterButtons = await page.evaluate(() => {
  const M = globalThis.Module;
  const vr = M.ysfwVr;
  window.__vrctlKeys = [];
  vr.pokeControllerFrame([
    { hand: 'right', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { a: false, b: false } },
    { hand: 'left', pos: [0, 0, -0.08], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { a: false, b: false } }
  ]);
  vr.pokeControllerFrame([
    { hand: 'right', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { a: true, b: true } },
    { hand: 'left', pos: [0, 0, -0.08], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { a: false, b: true } }
  ]);
  return window.__vrctlKeys.slice();
});
check('buttons: air-brake key ("KeyB") dispatched (right B)', keysAfterButtons.includes('KeyB'), 'keys=' + JSON.stringify(keysAfterButtons));
check('buttons: left Y press edge dispatches the view-cycle key ("F2" from the default cockpit view)', keysAfterButtons.includes('F2'), 'keys=' + JSON.stringify(keysAfterButtons));
check('buttons: right A press-only does NOT immediately fire gear (tap/recenter semantics, see Group 6)', !keysAfterButtons.includes('KeyG'), 'keys=' + JSON.stringify(keysAfterButtons));
// Release right A/B and left Y so nothing lingers into Group 6/6b -- right A
// is expected to fire its own delayed KeyG tap of its own, which is fine,
// it's not asserted on here.
await page.evaluate(() => {
  globalThis.Module.ysfwVr.pokeControllerFrame([
    { hand: 'right', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { a: false, b: false } },
    { hand: 'left', pos: [0, 0, -0.08], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { a: false, b: false } }
  ]);
});

// ---- Group 6: right A press/hold/release -> gear tap vs recenter --------
// Feature 1: a quick press+release (<A_TAP_MAX_MS=400ms, fswebxr.cpp) still
// taps the gear key exactly as before; holding it >=A_RECENTER_MS=1000ms
// instead attempts a recenter (vr.recenterAttempts increments even headless,
// where there is no real baseRefSpace/pose so vrRecenter is a guarded
// no-op) and suppresses the gear tap on the eventual release.
await page.evaluate(() => { window.__vrctlKeys = []; });
await page.evaluate(() => {
  const vr = globalThis.Module.ysfwVr;
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { a: true, b: false } }]);
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { a: false, b: false } }]);
});
let keysAfterQuickTap = await page.evaluate(() => window.__vrctlKeys.slice());
check('right A: quick press+release (<400ms) still taps gear ("KeyG")', keysAfterQuickTap.includes('KeyG'), 'keys=' + JSON.stringify(keysAfterQuickTap));

await page.evaluate(() => { window.__vrctlKeys = []; });
const recenterBefore = await page.evaluate(() => globalThis.Module.ysfwVr.recenterAttempts);
// Fabricate the hold duration (vr.ctl.aBtn.pressAt is a plain, test-visible
// field) instead of a real >=1s wait: deterministic and fast.
const longHoldResult = await page.evaluate(() => {
  const vr = globalThis.Module.ysfwVr;
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { a: true, b: false } }]); // press edge
  vr.ctl.aBtn.pressAt = performance.now() - 1100; // pretend it has been held 1.1s
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { a: true, b: false } }]); // still held -> crosses A_RECENTER_MS
  const keysWhileHeld = window.__vrctlKeys.slice();
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { a: false, b: false } }]); // release
  return { keysWhileHeld, keysAfterRelease: window.__vrctlKeys.slice() };
});
const recenterAfter = await page.evaluate(() => globalThis.Module.ysfwVr.recenterAttempts);
check('right A: long hold (>=1s) attempts recenter (vr.recenterAttempts increments)', recenterAfter > recenterBefore, 'before=' + recenterBefore + ' after=' + recenterAfter);
check('right A: long hold does not fire gear while still held', !longHoldResult.keysWhileHeld.includes('KeyG'), 'keys=' + JSON.stringify(longHoldResult.keysWhileHeld));
check('right A: long hold does not fire gear on release either (suppressed by recenter)', !longHoldResult.keysAfterRelease.includes('KeyG'), 'keys=' + JSON.stringify(longHoldResult.keysAfterRelease));

// ---- Group 6b: left X press/hold/release -> help toggle ONLY, no tap ----
// Fix B removed X's quick-tap action entirely (view control moved to Y,
// Group 6c below) -- X now drives only the long-press help toggle (see
// Group 11 below, which asserts the actual visibility-flip). A quick
// press+release must therefore dispatch NO key at all.
await page.evaluate(() => { window.__vrctlKeys = []; });
await page.evaluate(() => {
  const vr = globalThis.Module.ysfwVr;
  vr.pokeControllerFrame([{ hand: 'left', pos: [0, 0, -0.08], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { a: true, b: false } }]);
  vr.pokeControllerFrame([{ hand: 'left', pos: [0, 0, -0.08], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { a: false, b: false } }]);
});
const keysAfterXQuickTap = await page.evaluate(() => window.__vrctlKeys.slice());
check('left X: quick press+release (<400ms) dispatches NO key (tap action removed, view moved to Y)', 0 === keysAfterXQuickTap.length, 'keys=' + JSON.stringify(keysAfterXQuickTap));

// ---- Group 6c: left Y -> view-cycle tap on press edge, no repeat while held --
// Fires exactly on the press EDGE (unlike X/A's tap-on-release pattern): a
// bare press dispatches a view key immediately, and holding it (no new
// edge) must NOT dispatch a second one.
await page.evaluate(() => { window.__vrctlKeys = []; });
await page.evaluate(() => {
  globalThis.Module.ysfwVr.pokeControllerFrame([{ hand: 'left', pos: [0, 0, -0.08], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { a: false, b: true } }]);
});
const keysAfterYPress = await page.evaluate(() => window.__vrctlKeys.slice());
// Order-agnostic here: Group 5 above already pinned "the very first tap ==
// F2"; this group's view-cycle state may already have advanced past cockpit
// by the time it runs, so just assert A view key was tapped, not which one.
check('left Y: press edge dispatches a view-cycle key (F1 or F2)', keysAfterYPress.includes('F1') || keysAfterYPress.includes('F2'), 'keys=' + JSON.stringify(keysAfterYPress));

await page.evaluate(() => { window.__vrctlKeys = []; });
await page.evaluate(() => {
  // Still held (no release in between) -> not a fresh press edge -> must not refire.
  globalThis.Module.ysfwVr.pokeControllerFrame([{ hand: 'left', pos: [0, 0, -0.08], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { a: false, b: true } }]);
});
const keysWhileYHeld = await page.evaluate(() => window.__vrctlKeys.slice());
check('left Y: holding (no new press edge) does not refire a view-cycle tap', !keysWhileYHeld.includes('F1') && !keysWhileYHeld.includes('F2'), 'keys=' + JSON.stringify(keysWhileYHeld));
await page.evaluate(() => {
  globalThis.Module.ysfwVr.pokeControllerFrame([{ hand: 'left', pos: [0, 0, -0.08], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { a: false, b: false } }]); // release
});

// ---- Group 7: rudder-only yaw deadzone (Feature 3) -----------------------
// Default yawDeadzoneDeg=6 (fswebxr.cpp DEFAULT_YAW_DEADZONE_DEG): a wrist
// twist under that reads as rudder==0 exactly; halfway between the deadzone
// and MAX_ANGLE (45deg) -- (25.5-6)/(45-6) = 0.5 -- after the linear remap.
// yawQuat(deg): a pure rotation about the local Y axis. Per
// deflectionFromDeltaQ's derivation (yaw=atan2(-f.x,-f.z) of the rotated
// forward vector), this reads out as yaw=+deg directly, so positive deg
// gives positive rudder here.
function yawQuat(deg) {
  const half = (deg * Math.PI / 180) / 2;
  return [0, Math.sin(half), 0, Math.cos(half)];
}
const b4 = await page.evaluate((q) => {
  const vr = globalThis.Module.ysfwVr;
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: {} }]); // release
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 1, trigger: 0, buttons: {} }]); // fresh grab, q0=identity
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: q, squeeze: 1, trigger: 0, buttons: {} }]);
  return vr.readControlBlock();
}, yawQuat(4));
check('yaw deadzone: ~4deg wrist twist -> rudder == 0 (inside the 6deg deadzone)', 0 === b4[3], 'rudder=' + b4[3]);

const b255 = await page.evaluate((q) => {
  const vr = globalThis.Module.ysfwVr;
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: {} }]); // release
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 1, trigger: 0, buttons: {} }]); // fresh grab, q0=identity
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: q, squeeze: 1, trigger: 0, buttons: {} }]);
  return vr.readControlBlock();
}, yawQuat(25.5));
check('yaw deadzone: ~25.5deg (halfway past the deadzone) -> rudder ~= 0.5', Math.abs(b255[3] - 0.5) < 0.05, 'rudder=' + b255[3]);

// ---- Group 8: sticky grab (Feature 2, double-squeeze latch) --------------
// Squeeze-release-squeeze-release quickly (within STICKY_DOUBLE_MS=250ms of
// each other -- trivially true for back-to-back synchronous pokes below)
// latches a persistent grab: deflections must then keep being written even
// with squeeze=0 (no physical grip). One more squeeze+release ends the
// latch and deflections stop (and zero, the existing spring-to-neutral
// release behavior).
await page.evaluate(() => {
  // Reset first: an earlier group's own release-then-immediate-regrab
  // pattern (all within a single synchronous evaluate(), i.e. effectively
  // 0ms apart) could otherwise have already tripped the double-squeeze
  // window and left the latch engaged, which would make this group's
  // starting state ambiguous.
  const sticky = globalThis.Module.ysfwVr.ctl.stick.sticky;
  sticky.latched = false; sticky.disengageArmed = false; sticky.prevPhys = false; sticky.lastReleaseAt = 0;
});
await page.evaluate(() => {
  const vr = globalThis.Module.ysfwVr;
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: {} }]); // clean 0-edge
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 1, trigger: 0, buttons: {} }]); // press 1
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: {} }]); // release 1
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 1, trigger: 0, buttons: {} }]); // press 2 (within window) -> latches
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: {} }]); // release 2 -> stays latched
});
const stickyRot = yawQuat(20); // past the yaw deadzone, so rudder reads a clear nonzero value
const bSticky = await page.evaluate((q) => {
  const vr = globalThis.Module.ysfwVr;
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: q, squeeze: 0, trigger: 0, buttons: {} }]); // squeeze=0, still latched
  return vr.readControlBlock();
}, stickyRot);
check('sticky grab: stickGrabbed stays 1 with squeeze=0 after the double-squeeze latch', 1 === bSticky[0], 'block=' + JSON.stringify(bSticky));
check('sticky grab: deflections still written while latched (nonzero rudder)', Math.abs(bSticky[3]) > 0.1, 'block=' + JSON.stringify(bSticky));

const bAfterEnd = await page.evaluate((q) => {
  const vr = globalThis.Module.ysfwVr;
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: q, squeeze: 1, trigger: 0, buttons: {} }]); // squeeze again -> arms the disengage
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: q, squeeze: 0, trigger: 0, buttons: {} }]); // release -> disengages
  return vr.readControlBlock();
}, stickyRot);
check('sticky grab: one more squeeze+release ends the latch (stickGrabbed=0)', 0 === bAfterEnd[0], 'block=' + JSON.stringify(bAfterEnd));
check('sticky grab: deflections zeroed after the latch ends (spring-to-neutral)', 0 === bAfterEnd[1] && 0 === bAfterEnd[2] && 0 === bAfterEnd[3], 'block=' + JSON.stringify(bAfterEnd));

// ---- Group 9: afterburner detent (Feature 4, left/throttle hand) ---------
// Shoving the grabbed throttle past its 1.0 stop (>=AB_OVERSHOOT_M=0.03m at
// a deliberate shove speed, see fswebxr.cpp) taps the engine's default
// afterburner key (Tab, FSBTF_AFTERBURNER -- a toggle, see
// upstream/YSFLIGHT/src/core/fscontrol.cpp); pulling back below
// AB_DISENGAGE_VALUE=0.95 taps it again to disengage.
const abEngageState = await page.evaluate(() => {
  const vr = globalThis.Module.ysfwVr;
  const th = vr.ctl.thr;
  // Deterministic baseline: force the throttle value to 0 (rather than
  // whatever Group 3 left it at) so the push distances below map to known
  // values, and reset the AB tracking state.
  th.value = 0; th.ever = true; th.abEngaged = false;
  window.__vrctlKeys = [];
  vr.pokeControllerFrame([{ hand: 'left', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: {} }]); // clean 0-edge
  vr.pokeControllerFrame([{ hand: 'left', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 1, trigger: 0, buttons: {} }]); // grab-begin, base=0 (also resets lastPushM/lastT)
  // Fabricate a "one frame ago" baseline 100ms in the past at a partial push
  // (0.05m -> value 0.30), so the next poke's frame-to-frame shove speed is
  // deterministic instead of depending on real wall-clock timing between
  // page.evaluate calls: (0.30-0.05)/0.1s = 2.5 m/s, well past
  // AB_SHOVE_SPEED_MPS=0.15.
  th.lastPushM = 0.05; th.lastT = performance.now() - 100;
  vr.pokeControllerFrame([{ hand: 'left', pos: [0, 0, -0.30], quat: [0, 0, 0, 1], squeeze: 1, trigger: 0, buttons: {} }]); // fast shove past 1.0
  return { keys: window.__vrctlKeys.slice(), abEngaged: th.abEngaged, block: vr.readControlBlock() };
});
check('AB detent: fast shove past throttle max taps the afterburner key ("Tab")', abEngageState.keys.includes('Tab'), 'keys=' + JSON.stringify(abEngageState.keys));
check('AB detent: engaged flag set after the shove', true === abEngageState.abEngaged, 'abEngaged=' + abEngageState.abEngaged);
check('AB detent: throttle value still clamped to 1.0 while overshooting', 1 === abEngageState.block[5], 'throttle=' + abEngageState.block[5]);

const abDisengageState = await page.evaluate(() => {
  const vr = globalThis.Module.ysfwVr;
  window.__vrctlKeys = [];
  vr.pokeControllerFrame([{ hand: 'left', pos: [0, 0, -0.10], quat: [0, 0, 0, 1], squeeze: 1, trigger: 0, buttons: {} }]); // pull back to value 0.6 (< 0.95)
  return { keys: window.__vrctlKeys.slice(), abEngaged: vr.ctl.thr.abEngaged };
});
check('AB detent: pulling back below 0.95 taps the afterburner key again ("Tab")', abDisengageState.keys.includes('Tab'), 'keys=' + JSON.stringify(abDisengageState.keys));
check('AB detent: engaged flag cleared after pulling back', false === abDisengageState.abEngaged, 'abEngaged=' + abDisengageState.abEngaged);

// Tidy up: release the throttle so a re-run (or later manual poking) starts clean.
await page.evaluate(() => {
  globalThis.Module.ysfwVr.pokeControllerFrame([{ hand: 'left', pos: [0, 0, -0.10], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: {} }]);
});

// ---- Group 10: yawOnlyQuatFromOrientation pure function (recenter math) --
// Exercised directly (no session needed -- it's a pure function, exposed by
// fswebxr.cpp specifically so this is possible): a pure yaw quat must pass
// through unchanged, and pitch mixed into the input must be stripped, only
// the yaw surviving.
const pureYaw15 = yawQuat(15);
const yawExtractPure = await page.evaluate((q) => globalThis.Module.ysfwVr.yawOnlyQuatFromOrientation(q), pureYaw15);
check('yawOnlyQuatFromOrientation: a pure yaw quat passes through unchanged',
  Math.abs(yawExtractPure[1] - pureYaw15[1]) < 1e-6 && Math.abs(yawExtractPure[0]) < 1e-9 && Math.abs(yawExtractPure[2]) < 1e-9 && Math.abs(yawExtractPure[3] - pureYaw15[3]) < 1e-6,
  'out=' + JSON.stringify(yawExtractPure));

// Combine a 20deg pitch (about local X) with the 15deg yaw above (quaternion
// multiply reimplemented locally, matching fswebxr.cpp's quatMultiply/
// convention: q=qYaw*qPitch applies the pitch first, then the yaw, in world
// terms) -- the extracted yaw must still read ~15deg, with the pitch
// stripped out entirely.
function quatMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  ];
}
const pitchQuat20 = [Math.sin(10 * Math.PI / 180), 0, 0, Math.cos(10 * Math.PI / 180)]; // 20deg about local X
const pitchYawCombined = quatMul(pureYaw15, pitchQuat20);
const yawExtractCombined = await page.evaluate((q) => globalThis.Module.ysfwVr.yawOnlyQuatFromOrientation(q), pitchYawCombined);
check('yawOnlyQuatFromOrientation: pitch mixed into the input is stripped, yaw survives (~15deg)',
  Math.abs(yawExtractCombined[1] - pureYaw15[1]) < 0.01 && Math.abs(yawExtractCombined[0]) < 1e-9 && Math.abs(yawExtractCombined[2]) < 1e-9,
  'out=' + JSON.stringify(yawExtractCombined) + ' expectedY=' + pureYaw15[1]);

// NOTE ON THE "HOLD TO START" BONUS CHECK (spec's optional bonus item):
// deliberately not attempted.  The pre-flight "CENTER JOYSTICK... TO GO!"
// screen is a separate state machine (FsCenterJoystick, fscontrol.cpp) that
// this smoke test already drives past with a real Space keypress before any
// of the above, and there is no exposed JS flag that distinguishes "still on
// the hold screen" from "flight running" other than globalThis.ysfwInFlight,
// which is already true even while the hold screen is showing (see the
// dialog-dismiss loop above). Re-testing it faithfully would mean re-booting
// a second page instance and asserting on the multi-stage, ~2s-timed
// WAITING_FOR_RELEASE transition inside FsCenterJoystick -- not something
// that can be checked cleanly without either a dedicated flag or fragile
// timing/pixel assertions, so it is skipped rather than faked.

// ---- Group 11: help placards -- visibility timer + left-X long-press ----
// Feature: per-hand controller help placards (fswebxr.cpp showHelp/
// toggleHelp/updateHelpAutoHide/updateHelpLayers). The quad-layer visuals
// can't run headless (no real WebXR session here), but the visibility/
// toggle state (vr.help) is kept plain and pokeable exactly for this
// reason. vr.forceMultiview -- the same headless multiview-entry hook
// scripts/smoke-mv.mjs, smoke-vrdial.mjs and smoke-vrhud.mjs already use --
// doubles as a "session started" stand-in here and calls showHelp() the
// same way vr.enter does when a real session begins (hence this group runs
// last: forceMultiview recompiles the shared renderers for multiview, same
// as those other scripts do as their own final/only state change).
const helpAfterEnter = await page.evaluate(() => {
  const vr = globalThis.Module.ysfwVr;
  const forced = vr.forceMultiview(512, 512);
  return { forced, visible: vr.help.visible };
});
check('help: forceMultiview succeeded (native-GL ANGLE, OVR_multiview2 present)', 'ok' === helpAfterEnter.forced, 'forced=' + helpAfterEnter.forced);
check('help: placards auto-show on session start', true === helpAfterEnter.visible, 'visible=' + helpAfterEnter.visible);

// Toggling now lives on the LEFT hand's X button, held >=A_RECENTER_MS --
// thumbstick click no longer does anything at all (physically jolting the
// stick to press it is awkward in VR, see Group 6b above and the stick-noop
// check below). Fabricate the hold duration (vr.ctl.xBtn.pressAt is a
// plain, test-visible field -- same trick Group 6 uses for aBtn) instead of
// a real >=1s wait.
const xHelpToggleOff = await page.evaluate(() => {
  const vr = globalThis.Module.ysfwVr;
  vr.pokeControllerFrame([{ hand: 'left', pos: [0, 0, -0.08], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { a: false, b: false } }]); // clean 0-edge
  vr.pokeControllerFrame([{ hand: 'left', pos: [0, 0, -0.08], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { a: true, b: false } }]); // press edge
  vr.ctl.xBtn.pressAt = performance.now() - 1100; // pretend it has been held 1.1s
  vr.pokeControllerFrame([{ hand: 'left', pos: [0, 0, -0.08], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { a: true, b: false } }]); // still held -> crosses A_RECENTER_MS -> toggles help off
  return vr.help.visible;
});
check('help: left-X long-press (>=1s) toggles placards off', false === xHelpToggleOff, 'visible=' + xHelpToggleOff);

const xHelpToggleHeld = await page.evaluate(() => {
  const vr = globalThis.Module.ysfwVr;
  vr.pokeControllerFrame([{ hand: 'left', pos: [0, 0, -0.08], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { a: true, b: false } }]); // still held, no new edge
  return vr.help.visible;
});
check('help: holding left-X (no new edge) does not re-toggle', false === xHelpToggleHeld, 'visible=' + xHelpToggleHeld);

const xHelpToggleOn = await page.evaluate(() => {
  const vr = globalThis.Module.ysfwVr;
  vr.pokeControllerFrame([{ hand: 'left', pos: [0, 0, -0.08], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { a: false, b: false } }]); // release
  vr.pokeControllerFrame([{ hand: 'left', pos: [0, 0, -0.08], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { a: true, b: false } }]); // fresh press edge
  vr.ctl.xBtn.pressAt = performance.now() - 1100; // pretend it has been held 1.1s again
  vr.pokeControllerFrame([{ hand: 'left', pos: [0, 0, -0.08], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { a: true, b: false } }]); // crosses threshold again -> toggles back on
  return vr.help.visible;
});
check('help: a second left-X long-press toggles placards back on', true === xHelpToggleOn, 'visible=' + xHelpToggleOn);
await page.evaluate(() => {
  globalThis.Module.ysfwVr.pokeControllerFrame([{ hand: 'left', pos: [0, 0, -0.08], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { a: false, b: false } }]); // release, tidy up
});

// Thumbstick click is now completely INERT: a press edge on either hand
// must not toggle help, dispatch any key, or do anything else observable.
const helpBeforeStickTest = await page.evaluate(() => globalThis.Module.ysfwVr.help.visible);
await page.evaluate(() => { window.__vrctlKeys = []; });
const stickNoop = await page.evaluate(() => {
  const vr = globalThis.Module.ysfwVr;
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { stick: false } }]); // clean 0-edge
  vr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { stick: true } }]); // right stick click press edge
  vr.pokeControllerFrame([{ hand: 'left', pos: [0, 0, -0.08], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { stick: false } }]);
  vr.pokeControllerFrame([{ hand: 'left', pos: [0, 0, -0.08], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { stick: true } }]); // left stick click press edge
  return { visible: vr.help.visible, keys: window.__vrctlKeys.slice() };
});
check('help: thumbstick click is inert -- visibility unchanged (either hand)', stickNoop.visible === helpBeforeStickTest, 'before=' + helpBeforeStickTest + ' after=' + stickNoop.visible);
check('help: thumbstick click is inert -- no keys dispatched', 0 === stickNoop.keys.length, 'keys=' + JSON.stringify(stickNoop.keys));

await page.screenshot({ path: outDir + '-final.png' });
await browser.close();

if (fatal.length) {
  console.error('FATAL console output:');
  for (const f of fatal) console.error('  ' + f);
  process.exit(1);
}

const failed = results.filter((r) => !r.pass);
if (failed.length) {
  console.error('VR CONTROLLER TEST FAILED (' + failed.length + '/' + results.length + ' assertions failed)');
  process.exit(1);
}
console.log('VR CONTROLLER TEST PASSED (' + results.length + '/' + results.length + ' assertions)');
