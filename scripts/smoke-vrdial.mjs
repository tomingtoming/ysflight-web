// VR radial function-dial test without a headset.
//
// Boots ysflight-web into a free flight (same flow as scripts/smoke-vrctl.mjs)
// and drives Module.ysfwVr's headless controller test hook
// (vr.pokeControllerFrame) to exercise the SaccFlight-style function dial
// implemented in src/port/platform_emscripten/fswebxr.cpp:
//   - each hand's thumbstick (entry.thumb=[x,y], xr-standard gamepad.axes
//     [2],[3]) picks one of 4 sectors (up/right/down/left) once its
//     magnitude passes a threshold; the pick is STICKY (persists once the
//     stick returns to centre)
//   - that hand's trigger then dispatches whichever function is currently
//     selected: 'hold' functions mirror the trigger's raw press/release,
//     'tap' functions fire one keydown+keyup pulse on the press edge
//
// The quad-layer VISUALS (RIGHT_DIAL/LEFT_DIAL rendered into a head-locked
// XRQuadLayer) cannot be exercised here: there is no real XR session in a
// headless run, so vr.mvBinding is never set and the quad-layer code path
// (ensureDialResources/updateDialLayers, only called from onXRFrame) never
// runs. That is the point of the split in fswebxr.cpp -- the dial's
// selection + trigger-routing logic lives entirely in processControllerPlain,
// independent of rendering, and this test asserts exactly that: the logic
// works with vr.mvBinding falsy (checked explicitly at the end).
//
// It also exercises the live aircraft-state block the dial canvases read
// (fsvr.h / FsVrAircraftStateDataPointer, forwarded to JS as
// vr.readAircraftState()): forcing VR + multiview through the same headless
// hooks as scripts/smoke-mv.mjs flips FsVrIsActive() true, which is all the
// engine needs to start filling the block each sim frame (no real XR
// session/headset required for that part either) -- then a Gear tap through
// the dial must move it.
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
  // Native-GL ANGLE (see scripts/smoke-mv.mjs): SwiftShader's WebGL1 fallback
  // has no OVR_multiview2, and Group 5/6 below need forceMultiview to work.
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

// Boot flow copied from scripts/smoke-vrctl.mjs: dismiss the "no joystick"
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

await page.evaluate(() => {
  window.__vrdialKeys = [];
  window.addEventListener('keydown', (e) => window.__vrdialKeys.push('down:' + e.code));
  window.addEventListener('keyup', (e) => window.__vrdialKeys.push('up:' + e.code));
});

function resetKeys() {
  return page.evaluate(() => { window.__vrdialKeys = []; });
}
function readKeys() {
  return page.evaluate(() => window.__vrdialKeys.slice());
}
function poke(list) {
  return page.evaluate((l) => {
    globalThis.Module.ysfwVr.setPresenting(true);
    globalThis.Module.ysfwVr.pokeControllerFrame(l);
  }, list);
}

const IDENTITY_QUAT = [0, 0, 0, 1];

// ---- Group 1: right dial defaults to Gun (up), sticky reselect to Gear --
// (down). xr-standard thumbstick: axes[3] (thumb[1]) is POSITIVE when
// pulled toward the user -- fswebxr.cpp flips this (upY=-thumb[1]) so
// thumb=[0,1] (physically "pulled down/toward you") reads as the "down"
// sector here, matching RIGHT_DIAL.down = Gear (KeyG, tap).
await resetKeys();
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // clean 0-edge
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 1], buttons: {} }]); // push down -> select Gear
// Sticky check: return the stick to centre BEFORE pulling the trigger --
// selection must persist.
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]);
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 1, thumb: [0, 0], buttons: {} }]); // trigger edge 0->1
await page.waitForTimeout(120); // tap mode fires keyup ~60ms after keydown
let keys = await readKeys();
check('right dial: thumb-down selects Gear -> KeyG tap (down+up)', keys.includes('down:KeyG') && keys.includes('up:KeyG'), 'keys=' + JSON.stringify(keys));
check('right dial: Gear selection is TAP mode, no sustained Space', !keys.includes('down:Space'), 'keys=' + JSON.stringify(keys));
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // release trigger, clear engaged

// ---- Group 2: reselect Gun (up) and confirm hold semantics --------------
await resetKeys();
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, -1], buttons: {} }]); // push up -> select Gun
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // back to centre (sticky)
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 1, thumb: [0, 0], buttons: {} }]); // trigger edge 0->1 (hold)
keys = await readKeys();
check('right dial: thumb-up reselects Gun -> Space keydown on trigger press', keys.includes('down:Space'), 'keys=' + JSON.stringify(keys));
check('right dial: Gun is HOLD mode, no premature keyup while trigger held', !keys.includes('up:Space'), 'keys=' + JSON.stringify(keys));
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // release trigger
keys = await readKeys();
check('right dial: Space keyup on trigger release (hold mode)', keys.includes('up:Space'), 'keys=' + JSON.stringify(keys));

// ---- Group 3: left dial defaults to Flap+ (up); reselect Flap- (down) ---
// LEFT_DIAL.down = Flap Down (KeyF, tap). The left trigger is new behaviour
// (previously unused; the left grip already owns the throttle lever), so
// there is no legacy dispatch to preserve here.
await resetKeys();
await poke([{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // clean 0-edge
await poke([{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 1], buttons: {} }]); // push down -> select Flap Down
await poke([{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // back to centre (sticky)
await poke([{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 1, thumb: [0, 0], buttons: {} }]); // trigger edge 0->1
await page.waitForTimeout(120);
keys = await readKeys();
check('left dial: thumb-down selects Flap Down -> KeyF tap (down+up)', keys.includes('down:KeyF') && keys.includes('up:KeyF'), 'keys=' + JSON.stringify(keys));
await poke([{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // release

// ---- Group 4: dial logic works without any WebXR layers session --------
// No navigator.xr session was ever requested in this test (only the
// headless pokeControllerFrame/setPresenting hooks), so the layers-only
// state (vr.mvBinding, set exclusively inside vr.enter()) must be unset --
// proving groups 1-3 just passed with the quad-layer code path never
// invoked (updateDialLayers/ensureDialResources are only called from
// onXRFrame, which never ran).
const mvBindingUnset = await page.evaluate(() => !globalThis.Module.ysfwVr.mvBinding);
check('dial logic verified with no WebXR layers session active (mvBinding unset)', mvBindingUnset, 'mvBinding=' + mvBindingUnset);

// ---- Group 5: live aircraft-state block (fsvr.h) -------------------------
// Force VR + multiview via the same headless hooks as scripts/smoke-mv.mjs
// (pokeEye + forceMultiview). That flips FsVrIsActive() true, which is the
// only gate FsSimulation::SimDrawAllScreen checks before filling
// FsVrAircraftStateDataPointer each sim frame -- no real XR session/headset
// needed for this part.
const MV_W = 512, MV_H = 512;
const forced = await page.evaluate(([w, h]) => {
  const M = globalThis.Module;
  const vr = M && M.ysfwVr;
  if (!vr || !vr.pokeEye || !vr.forceMultiview || !vr.readAircraftState) return 'hooks-missing';
  const identity24 = [1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, w, h];
  vr.pokeEye(0, identity24);
  vr.pokeEye(1, identity24);
  return vr.forceMultiview(w, h);
}, [MV_W, MV_H]);
check('VR + multiview forced for aircraft-state test', forced === 'ok', 'forced=' + forced);

await page.waitForTimeout(500); // let a few sim frames run so the block populates
let state = await page.evaluate(() => globalThis.Module.ysfwVr.readAircraftState());
check('aircraft state valid==1 in flight', 1 === state[0], 'state=' + JSON.stringify(state));
check('aircraft state gear in [0,1]', state[1] >= 0 && state[1] <= 1, 'gear=' + state[1]);
check('aircraft state brake in [0,1]', state[2] >= 0 && state[2] <= 1, 'brake=' + state[2]);
check('aircraft state flap in [0,1]', state[3] >= 0 && state[3] <= 1, 'flap=' + state[3]);

// ---- Group 6: a Gear tap through the dial moves the live gear value ------
// Gear transitions take real sim time (not instantaneous), so poll for a few
// seconds rather than asserting a specific end value -- direction-agnostic,
// same as the brief: it just must have left its initial value.
const initialGear = state[1];
await resetKeys();
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // clean 0-edge
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 1], buttons: {} }]); // select Gear
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // sticky recentre
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 1, thumb: [0, 0], buttons: {} }]); // tap: KeyG down+up
await page.waitForTimeout(150);
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // release trigger
keys = await readKeys();
check('Gear dial tap dispatched KeyG (down+up)', keys.includes('down:KeyG') && keys.includes('up:KeyG'), 'keys=' + JSON.stringify(keys));

let gearChanged = false, lastGear = initialGear;
const tGear0 = Date.now();
while (Date.now() - tGear0 < 5000) {
  await page.waitForTimeout(300);
  state = await page.evaluate(() => globalThis.Module.ysfwVr.readAircraftState());
  lastGear = state[1];
  if (Math.abs(lastGear - initialGear) > 0.01) { gearChanged = true; break; }
}
check('Gear dial tap changes the live gear value within a few seconds', gearChanged, 'initial=' + initialGear + ' last=' + lastGear);

await page.screenshot({ path: outDir + '-final.png' });
await browser.close();

if (fatal.length) {
  console.error('FATAL console output:');
  for (const f of fatal) console.error('  ' + f);
  process.exit(1);
}

const failed = results.filter((r) => !r.pass);
if (failed.length) {
  console.error('VR DIAL TEST FAILED (' + failed.length + '/' + results.length + ' assertions failed)');
  process.exit(1);
}
console.log('VR DIAL TEST PASSED (' + results.length + '/' + results.length + ' assertions)');
