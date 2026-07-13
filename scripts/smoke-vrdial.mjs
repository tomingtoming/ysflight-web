// VR radial function-dial test without a headset.
//
// Boots ysflight-web into a free flight (same flow as scripts/smoke-vrctl.mjs)
// and drives Module.ysfwVr's headless controller test hook
// (vr.pokeControllerFrame) to exercise the SaccFlight-style function dial
// implemented in src/port/platform_emscripten/fswebxr.cpp:
//   - each hand's thumbstick (entry.thumb=[x,y], xr-standard gamepad.axes
//     [2],[3]) picks one of RIGHT_DIAL.length/LEFT_DIAL.length sectors
//     (6 today, evenly spaced clockwise from up -- see updateDialStick)
//     once its magnitude passes a threshold; the pick is STICKY (persists
//     once the stick returns to centre)
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
// It also exercises the live aircraft-state block (fsvr.h /
// FsVrAircraftStateDataPointer, forwarded to JS as vr.readAircraftState() --
// no longer painted onto the dial canvases themselves since the 2026-07
// transparent-radial redesign, but still read every frame for the
// haptic-on-change feedback in updateStateHaptics): forcing VR + multiview
// through the same headless hooks as scripts/smoke-mv.mjs flips
// FsVrIsActive() true, which is all the engine needs to start filling the
// block each sim frame (no real XR session/headset required for that part
// either) -- then a Gear tap through the dial must move it.
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

// Sector-center thumbstick vector for the 6-way dial (N=6, wedge=60deg,
// sector i centred at i*60deg clockwise from up -- see fswebxr.cpp's
// updateDialStick/pickDialSector doc comment). thumb=[sin(a),-cos(a)]
// matches its upY=-thumb[1] flip (i=0 -> [0,-1], the existing "up" vector
// used by Groups 1-3 above; i=3 -> [0,1], the existing "down" vector --
// both exact multiples of 60deg, so those groups' literal [0,-1]/[0,1]
// vectors needed no change when RIGHT_DIAL/LEFT_DIAL went from 4 to 6
// sectors). Used below for the two NEW non-cardinal sectors (2 and 5).
function sectorThumb(i) {
  const a = (i * 60) * Math.PI / 180;
  return [Math.sin(a), -Math.cos(a)];
}

// ---- Group 1: right dial defaults to Gun (up), sticky reselect to Gear --
// (down). xr-standard thumbstick: axes[3] (thumb[1]) is POSITIVE when
// pulled toward the user -- fswebxr.cpp flips this (upY=-thumb[1]) so
// thumb=[0,1] (physically "pulled down/toward you") reads as the "down"
// sector (index 3 of 6) here, matching RIGHT_DIAL[3] = Gear (KeyG, tap).
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
// LEFT_DIAL[3] (index 3 of 6, "down") = Flap Down (KeyF, tap). The left
// trigger is new behaviour (previously unused; the left grip already owns
// the throttle lever), so there is no legacy dispatch to preserve here.
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

// ---- Group 7: right dial sector 2 (120deg) = フレア (Digit4, HOLD) -------
// New entry added when RIGHT_DIAL went from a fixed 4-way table to a 6-way
// one (FSBTF_DISPENSEFLARE, level-sensed like Gun above -- see fswebxr.cpp's
// per-entry comment on RIGHT_DIAL[2]).
await resetKeys();
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // clean 0-edge
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: sectorThumb(2), buttons: {} }]); // select フレア
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // sticky recentre
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 1, thumb: [0, 0], buttons: {} }]); // trigger edge 0->1 (hold)
keys = await readKeys();
check('right dial sector 2 (フレア): Digit4 keydown on trigger press', keys.includes('down:Digit4'), 'keys=' + JSON.stringify(keys));
check('right dial sector 2 (フレア): HOLD mode, no premature keyup while trigger held', !keys.includes('up:Digit4'), 'keys=' + JSON.stringify(keys));
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // release trigger
keys = await readKeys();
check('right dial sector 2 (フレア): Digit4 keyup on trigger release (hold mode)', keys.includes('up:Digit4'), 'keys=' + JSON.stringify(keys));

// ---- Group 8: right dial sector 5 (300deg) = レーダー (Digit3, TAP) ------
// FSBTF_RADAR toggles on the press edge -- 'tap', same shape as Gear/Brake.
await resetKeys();
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // clean 0-edge
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: sectorThumb(5), buttons: {} }]); // select レーダー
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // sticky recentre
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 1, thumb: [0, 0], buttons: {} }]); // trigger edge 0->1
await page.waitForTimeout(120);
keys = await readKeys();
check('right dial sector 5 (レーダー): Digit3 tap (down+up)', keys.includes('down:Digit3') && keys.includes('up:Digit3'), 'keys=' + JSON.stringify(keys));
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // release trigger

// ---- Group 9: left dial sector 5 (300deg) = トリム (KeyT, HOLD) ---------
// FSBTF_AUTOTRIM is level-sensed (same virtual-button family as Gun/フレア
// above) -- 'hold'.
await resetKeys();
await poke([{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // clean 0-edge
await poke([{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: sectorThumb(5), buttons: {} }]); // select トリム
await poke([{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // sticky recentre
await poke([{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 1, thumb: [0, 0], buttons: {} }]); // trigger edge 0->1 (hold)
keys = await readKeys();
check('left dial sector 5 (トリム): KeyT keydown on trigger press', keys.includes('down:KeyT'), 'keys=' + JSON.stringify(keys));
check('left dial sector 5 (トリム): HOLD mode, no premature keyup while trigger held', !keys.includes('up:KeyT'), 'keys=' + JSON.stringify(keys));
await poke([{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // release trigger
keys = await readKeys();
check('left dial sector 5 (トリム): KeyT keyup on trigger release (hold mode)', keys.includes('up:KeyT'), 'keys=' + JSON.stringify(keys));

// ---- Group 9b: stale-highlight regression (Bug 1 fix) --------------------
// Field report: confirm Gun (sector 0, "up") on the right dial, let the
// stick return fully to rest until the dial itself goes fully hidden
// (dial.visible=false, DIAL_HIDE_DELAY_MS after re-centring -- fabricated
// below via dial.hideAt, same pattern as vr.ctl.aBtn.pressAt elsewhere in
// this suite), then deflect toward a DIFFERENT sector -- the picked sector
// must be the NEW one immediately on the very first pick, not still read
// Gun. Root cause was pickDialSector's boundary hysteresis: dial.sel
// survived the hide, so the first pick after reactivation still measured
// the new angle against the OLD (Gun) sector's hysteresis band instead of
// starting fresh -- see updateDialStick's fix comment in fswebxr.cpp. The
// angle picked below (34deg clockwise from up, via sectorThumb's own
// (i*60) formula fed a fractional i=34/60) is deliberately INSIDE what
// sector 0's hysteresis band would still cover (half=30deg +
// DIAL_HYSTERESIS_DEG=6deg = 36deg) even though its own NATURAL nearest
// sector is 1 -- exactly the angle where the pre-fix bug kept reading
// sector 0 instead of 1.
await resetKeys();
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // clean 0-edge
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: sectorThumb(0), buttons: {} }]); // select Gun (sector 0)
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 1, thumb: [0, 0], buttons: {} }]); // confirm: trigger edge 0->1 (hold)
const selConfirmed = await page.evaluate(() => globalThis.Module.ysfwVr.ctl.dial.right.sel);
check('Group 9b setup: Gun (sector 0) confirmed on the right dial', 0 === selConfirmed, 'sel=' + selConfirmed);
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // release trigger, stick at rest

// Force the dial fully hidden without a real 1200ms wait: push hideAt into
// the past, then poke once more at rest so updateDialStick's own decay
// check (dial.visible && now>=dial.hideAt) flips visible to false.
await page.evaluate(() => { globalThis.Module.ysfwVr.ctl.dial.right.hideAt = performance.now() - 10; });
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]);
const hiddenNow = await page.evaluate(() => globalThis.Module.ysfwVr.ctl.dial.right.visible);
check('Group 9b setup: dial is fully hidden (visible=false) before the re-deflection', false === hiddenNow, 'visible=' + hiddenNow);

// Re-deflect toward 34deg -- the first pick after reactivation.
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: sectorThumb(34 / 60), buttons: {} }]);
const selAfterReactivate = await page.evaluate(() => globalThis.Module.ysfwVr.ctl.dial.right.sel);
check('stale-highlight fix: re-deflecting after the dial fully hid picks the NEW sector (1) on the first pick, not the old stale one (Gun/0)', 1 === selAfterReactivate, 'sel=' + selAfterReactivate);
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // back to rest for the next group

// ---- Group 10: left dial sector 2 (120deg) = 無線 (Enter, TAP) -----------
// FSBTF_OPENRADIOCOMMMENU opens the radio-comm dialog on the press edge --
// dispatched LAST in this suite (per fswebxr.cpp's per-entry comment on
// LEFT_DIAL[2]) since a successful open would otherwise reroute this
// hand's subsequent dial input through the GUI-guide machinery for the
// rest of the run; closed immediately afterward with a REAL Escape
// keypress (every in-flight dialog's ProcessRawKeyInput treats Escape as
// "close", same as fswebxr.cpp's GUI_ESCAPE_ACTION dispatches) so this
// suite leaves no dangling open dialog behind it.
await resetKeys();
await poke([{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // clean 0-edge
await poke([{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: sectorThumb(2), buttons: {} }]); // select 無線
await poke([{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // sticky recentre
await poke([{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 1, thumb: [0, 0], buttons: {} }]); // trigger edge 0->1
await page.waitForTimeout(150);
await poke([{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // release trigger
keys = await readKeys();
check('left dial sector 2 (無線): Enter tap dispatched (down+up)', keys.includes('down:Enter') && keys.includes('up:Enter'), 'keys=' + JSON.stringify(keys));
await page.keyboard.press('Escape'); // close whatever dialog Enter opened, via a real keypress
await page.waitForTimeout(300);

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
