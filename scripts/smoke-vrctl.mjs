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
  args: ['--autoplay-policy=no-user-gesture-required']
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

// ---- Group 5 (extra coverage): face buttons -> gear/brake/flap keys ------
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
    { hand: 'left', pos: [0, 0, -0.08], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: { a: true, b: true } }
  ]);
  return window.__vrctlKeys.slice();
});
check('buttons: gear key ("KeyG") dispatched (right A)', keysAfterButtons.includes('KeyG'), 'keys=' + JSON.stringify(keysAfterButtons));
check('buttons: air-brake key ("KeyB") dispatched (right B)', keysAfterButtons.includes('KeyB'), 'keys=' + JSON.stringify(keysAfterButtons));
check('buttons: flaps-down key ("KeyF") dispatched (left X)', keysAfterButtons.includes('KeyF'), 'keys=' + JSON.stringify(keysAfterButtons));
check('buttons: flaps-up key ("KeyR") dispatched (left Y)', keysAfterButtons.includes('KeyR'), 'keys=' + JSON.stringify(keysAfterButtons));

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
