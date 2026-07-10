// VR in-flight-GUI-dialog test without a headset.
//
// Boots into a free flight, forces the engine into VR+multiview mode (same
// hook as scripts/smoke-mv.mjs / smoke-vrhud.mjs -- vr.forceMultiview, which
// also now allocates the GUI off-screen composite via setupGui, mirroring
// setupHud), then opens the autopilot menu the same way the left dial's AP
// sector does in real play: a synthetic Backspace keydown+keyup dispatched
// on window (FSBTF_OPENAUTOPILOTMENU -> FsSimulation::ToggleAutoPilotDialog).
//
// In VR, SimDrawGuiDialog (the function that draws this dialog in flat 2D
// play) is entirely skipped -- see fssimulation.cpp's
// `if(0==FsVrIsActive()) SimDrawGuiDialog();` -- so before this feature the
// menu would open and grab input while being completely invisible and
// un-closeable. SimDrawVrGui (fssimulation.cpp) is the VR-only replacement
// that both renders the dialog into the GUI composite texture AND reports
// back whether one is open (fsvr.h's FsVrGuiDataPointer block, forwarded to
// JS as vr.readGuiData / guiDialogState in fswebxr.cpp).
//
// Assertions:
//   (a) GUI composite enabled + correctly sized once multiview engages.
//   (b) dialogVisible/apMenu both start at 0 (no dialog open yet).
//   (c) after the Backspace tap, dialogVisible==1 AND apMenu==1 (the
//       autopilot menu is one of the dialogs FsGuiAutoPilotDialog's family
//       accepts direct Digit1..5/Digit0/Escape hotkeys on, see fsvr.h) AND
//       the GUI texture actually has drawn (nonzero alpha) content on BOTH
//       multiview layers.
//   (d) a right-stick "down" flick while the menu is open does NOT dispatch
//       the dial's normal Gear key (KeyG) -- the dial-selection logic must
//       be suppressed/rerouted, not merely left alone by coincidence.
//   (e) the right trigger, with that same "down" pick, dispatches Digit3
//       (GUI_DIAL.down -- the AP menu's "3...Landing" option) instead.
//   (f) the right grip stick (aileron) still works while the dialog is open
//       -- flying the plane is never blocked by an open dialog.
//   (g) an Escape tap (mirroring the right-B/left-X/Y reroute) closes the
//       dialog: dialogVisible falls back to 0.
//   (h) discoverability guide (fswebxr.cpp's rdial.guiMode/drawGuiDialGuide):
//       while the AP menu is open, the right dial is FORCED visible
//       (regardless of thumbstick engagement) and its guiMode is 'ap'; the
//       left dial is hidden outright (its functions are suppressed anyway).
//       Dumping the GUI texture (vr.dumpGuiLayer, mirroring vr.dumpHudLayer)
//       with the menu open must show a bigger alpha fraction than the old
//       1024x640 texture did (the same absolute-pixel dialog layout now
//       covers a bigger share of the smaller 640x360 texture). After the
//       menu closes, guiMode reverts to null and the right dial's
//       visibility falls back to the normal thumbstick-engagement rule
//       (i.e. it goes invisible again, since no stick is being poked).
//
//   node scripts/smoke-vrgui.mjs [url] [outDir]
import { chromium } from 'playwright';
import fs from 'fs';

const url = process.argv[2] || 'http://localhost:8923/index.html?freeflight=F-15C_EAGLE';
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

const browser = await chromium.launch({
  executablePath: process.env.YSFW_CHROMIUM || undefined,
  headless: true,
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
    await page.screenshot({ path: outDir + '/vrgui-test-0-stuck.png' });
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
  return !!(vr && vr.pokeEye && vr.forceMultiview && vr.readGuiData && vr.readGuiLayerStats && vr.pokeControllerFrame && vr.readControlBlock);
});
if (!hooksOk) {
  console.error('FAILED: VR GUI test hooks missing');
  await browser.close();
  process.exit(1);
}

// Enter multiview mode (same synthetic eye data as smoke-vrhud.mjs).
const W = 512, H = 512;
const forced = await page.evaluate(([w, h]) => {
  const M = globalThis.Module;
  const vr = M && M.ysfwVr;
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
if (forced !== 'ok') {
  console.error('FAILED to force multiview mode: ' + forced);
  await browser.close();
  process.exit(1);
}
await page.waitForTimeout(2000); // several single-pass stereo frames

// ---- (a) GUI composite enabled + sized -----------------------------------
let guiData = await page.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('GUI composite enabled once multiview engaged', guiData[0] === 1, 'guiData=' + JSON.stringify(guiData));
check('GUI composite sized 640x360', guiData[3] === 640 && guiData[4] === 360, 'w=' + guiData[3] + ' h=' + guiData[4]);

// ---- (b) no dialog open yet -----------------------------------------------
check('dialogVisible==0 before opening any dialog', guiData[5] === 0, 'dialogVisible=' + guiData[5]);
check('apMenu==0 before opening any dialog', guiData[6] === 0, 'apMenu=' + guiData[6]);

// ---- Open the autopilot menu, same as the left dial's AP tap -------------
await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Backspace', bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Backspace', bubbles: true }));
});
await page.waitForTimeout(500);

// ---- (c) dialog now open, reported as the autopilot family, and drawn ----
guiData = await page.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('dialogVisible==1 after Backspace (autopilot menu) tap', guiData[5] === 1, 'dialogVisible=' + guiData[5]);
check('apMenu==1 (autopilot menu family)', guiData[6] === 1, 'apMenu=' + guiData[6]);

const guiLayer0 = await page.evaluate(() => globalThis.Module.ysfwVr.readGuiLayerStats(0));
const guiLayer1 = await page.evaluate(() => globalThis.Module.ysfwVr.readGuiLayerStats(1));
check('GUI layer 0 has drawn content (nonzero alpha)', guiLayer0.alpha > 0.05, 'alpha=' + guiLayer0.alpha.toFixed(3));
check('GUI layer 1 has drawn content (nonzero alpha)', guiLayer1.alpha > 0.05, 'alpha=' + guiLayer1.alpha.toFixed(3));
// The old 1024x640 texture measured a mean alpha of ~11.35 for this exact
// AP-menu layout (same absolute-pixel content, just a bigger, mostly-empty
// texture around it); the new 640x360 texture measures ~32.3 -- comfortably
// above a 20 threshold placed between the two, proving the dialog now
// covers a bigger FRACTION of the texture (and therefore of the composited
// quad), not just that something nonzero got drawn.
check('GUI layer 0 alpha fraction is bigger than the old 1024x640 texture gave (~11.35)', guiLayer0.alpha > 20, 'alpha=' + guiLayer0.alpha.toFixed(3));
await page.screenshot({ path: outDir + '/vrgui-test-1-menu-open.png' });

// ---- Stick-routing: dial suppressed, GUI_DIAL takes over ------------------
await page.evaluate(() => {
  window.__vrguiKeys = [];
  window.addEventListener('keydown', (e) => window.__vrguiKeys.push('down:' + e.code));
  window.addEventListener('keyup', (e) => window.__vrguiKeys.push('up:' + e.code));
});
function resetKeys() { return page.evaluate(() => { window.__vrguiKeys = []; }); }
function readKeys() { return page.evaluate(() => window.__vrguiKeys.slice()); }
function poke(list) {
  return page.evaluate((l) => {
    globalThis.Module.ysfwVr.setPresenting(true);
    globalThis.Module.ysfwVr.pokeControllerFrame(l);
  }, list);
}
const IDENTITY_QUAT = [0, 0, 0, 1];

// ---- (h) discoverability guide: right dial forced visible + relabelled ---
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]);
await poke([{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]);
let dialState = await page.evaluate(() => {
  const vr = globalThis.Module.ysfwVr;
  return {
    right: { visible: vr.ctl.dial.right.visible, guiMode: vr.ctl.dial.right.guiMode },
    left: { visible: vr.ctl.dial.left.visible }
  };
});
check('AP menu open: right dial forced visible with no thumbstick engagement', dialState.right.visible === true, 'dialState=' + JSON.stringify(dialState));
check('AP menu open: right dial guiMode is "ap"', dialState.right.guiMode === 'ap', 'dialState=' + JSON.stringify(dialState));
check('AP menu open: left dial hidden', dialState.left.visible === false, 'dialState=' + JSON.stringify(dialState));

// Dump the GUI texture with the AP menu open for a human eyeball check of
// whether the menu clips against the smaller 640x360 texture (it should
// not -- FsGuiAutoPilotDialog::Make lays out at ~550x100px, see
// upstream/YSFLIGHT/src/core/fsguiinfltdlg.cpp).
const guiDump = await page.evaluate(() => globalThis.Module.ysfwVr.dumpGuiLayer(0));
if (guiDump) {
  const b64 = guiDump.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(outDir + '/gui-apmenu.png', Buffer.from(b64, 'base64'));
  console.log('wrote ' + outDir + '/gui-apmenu.png');
}
check('vr.dumpGuiLayer(0) returned a PNG data URL', typeof guiDump === 'string' && guiDump.startsWith('data:image/png'), 'guiDump=' + (guiDump ? guiDump.slice(0, 30) + '...' : guiDump));

await resetKeys();
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // clean 0-edge
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 1], buttons: {} }]); // push down (same geometry as smoke-vrdial's Gear pick)
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // sticky recentre
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 1, thumb: [0, 0], buttons: {} }]); // trigger edge 0->1
await page.waitForTimeout(120);
let keys = await readKeys();
check('menu open: right-stick-down + trigger does NOT dispatch the normal Gear key (KeyG)', !keys.includes('down:KeyG'), 'keys=' + JSON.stringify(keys));
check('menu open: right-stick-down + trigger dispatches Digit3 (GUI_DIAL.down, "3...Landing")', keys.includes('down:Digit3') && keys.includes('up:Digit3'), 'keys=' + JSON.stringify(keys));
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // release trigger

// The AP menu's "3...Landing" option, like every other option in
// FsGuiAutoPilotDialog, both engages that autopilot mode AND closes the
// dialog itself (FsGuiAutoPilotDialog::Landing calls
// sim->SetCurrentInFlightDialog(NULL) -- see fsguiinfltdlg.cpp) -- i.e. the
// Digit3 dispatch above didn't just reach the dialog, it actually drove it
// end to end, same as a real keypress would. Confirm the round-trip, then
// reopen the menu (Backspace tap) for the remaining checks.
await page.waitForTimeout(300);
guiData = await page.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('selecting "3...Landing" closes the menu itself (dialogVisible back to 0)', guiData[5] === 0, 'dialogVisible=' + guiData[5]);

await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Backspace', bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Backspace', bubbles: true }));
});
await page.waitForTimeout(500);
guiData = await page.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('autopilot menu reopened for the remaining checks', guiData[5] === 1 && guiData[6] === 1, 'guiData=' + JSON.stringify(guiData));

// ---- Grip stick (aileron/elevator) still flies the plane ------------------
// A ~30deg roll of the controller quat from neutral should read as a
// nonzero aileron deflection in the control block, dialog or no dialog.
await resetKeys();
const HALF_ROLL_30 = [Math.sin(15 * Math.PI / 180), 0, 0, Math.cos(15 * Math.PI / 180)]; // ~30deg about X (pitch axis in controller-local space)
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 1, trigger: 0, thumb: [0, 0], buttons: {} }]); // grab neutral
await poke([{ hand: 'right', pos: [0, 0, 0], quat: HALF_ROLL_30, squeeze: 1, trigger: 0, thumb: [0, 0], buttons: {} }]); // deflect
const ctl = await page.evaluate(() => globalThis.Module.ysfwVr.readControlBlock());
check('grip stick still overrides flight control while a dialog is open', ctl[0] === 1 && (Math.abs(ctl[1]) > 0.05 || Math.abs(ctl[2]) > 0.05), 'ctl=' + JSON.stringify(ctl.slice(0, 4)));
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // release grip

// ---- Right B reroute: apMenu -> Digit0 ("0...Disengage"), not KeyB -------
await resetKeys();
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: { b: false } }]);
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: { b: true } }]); // B press edge
await page.waitForTimeout(120);
keys = await readKeys();
check('menu open: right-B does NOT dispatch the normal air-brake key (KeyB)', !keys.includes('down:KeyB'), 'keys=' + JSON.stringify(keys));
check('menu open: right-B dispatches Digit0 ("0...Disengage", apMenu family)', keys.includes('down:Digit0') && keys.includes('up:Digit0'), 'keys=' + JSON.stringify(keys));
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: { b: false } }]);
await page.waitForTimeout(400);

// FsGuiAutoPilotDialog::Disengage (Digit0), same as every other option,
// also closes the menu itself -- confirm, then reopen once more to exercise
// the generic Escape path (dialogVisible open, but NOT via apMenu-specific
// hotkeys this time -- left X, which always reroutes to Escape regardless
// of apMenu, see fswebxr.cpp).
guiData = await page.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('selecting "0...Disengage" closes the menu itself (dialogVisible back to 0)', guiData[5] === 0, 'dialogVisible=' + guiData[5]);

await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Backspace', bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Backspace', bubbles: true }));
});
await page.waitForTimeout(500);

await resetKeys();
await poke([{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: { a: false } }]);
await poke([{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: { a: true } }]); // left X press edge
await page.waitForTimeout(120);
keys = await readKeys();
check('menu open: left-X does NOT dispatch the normal flaps-down key (KeyF)', !keys.includes('down:KeyF'), 'keys=' + JSON.stringify(keys));
check('menu open: left-X dispatches a generic Escape (works regardless of apMenu)', keys.includes('down:Escape') && keys.includes('up:Escape'), 'keys=' + JSON.stringify(keys));
await poke([{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: { a: false } }]);
await page.waitForTimeout(400);

guiData = await page.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('dialogVisible==0 after Escape closes the autopilot menu', guiData[5] === 0, 'dialogVisible=' + guiData[5]);

// ---- (h continued) dial mode reverts once the dialog is gone -------------
// One more poke with the stick at rest so processControllerPlain runs and
// re-evaluates rdial.guiMode/visible against the now-closed dialog: guiMode
// must go back to null, and with no thumbstick engagement the normal
// thumbstick-engagement rule (updateDialStick's fade timer) leaves the dial
// invisible again -- i.e. the forced-visible override is really gone, not
// just guiMode alone.
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]);
dialState = await page.evaluate(() => {
  const vr = globalThis.Module.ysfwVr;
  return { visible: vr.ctl.dial.right.visible, guiMode: vr.ctl.dial.right.guiMode };
});
check('after close: right dial guiMode reverts to null', dialState.guiMode === null, 'dialState=' + JSON.stringify(dialState));
check('after close: right dial visibility falls back to thumbstick-engagement rule (no stick held -> invisible)', dialState.visible === false, 'dialState=' + JSON.stringify(dialState));

await page.screenshot({ path: outDir + '/vrgui-test-2-closed.png' });
await browser.close();

if (fatal.length) {
  console.error('FATAL console output:');
  for (const f of fatal) console.error('  ' + f);
  process.exit(1);
}

const failed = results.filter((r) => !r.pass);
if (failed.length) {
  console.error('VR GUI TEST FAILED (' + failed.length + '/' + results.length + ' assertions failed)');
  process.exit(1);
}
console.log('VR GUI TEST PASSED (' + results.length + '/' + results.length + ' assertions)');
