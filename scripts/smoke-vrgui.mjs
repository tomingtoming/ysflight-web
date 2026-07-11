// VR in-flight-GUI-dialog test without a headset.
//
// Boots into a free flight, forces the engine into VR+multiview mode (same
// hook as scripts/smoke-mv.mjs / smoke-vrhud.mjs -- vr.forceMultiview), then
// opens the autopilot menu the same way the left dial's AP sector does in
// real play: a synthetic Backspace keydown+keyup dispatched on window
// (FSBTF_OPENAUTOPILOTMENU -> FsSimulation::ToggleAutoPilotDialog).
//
// In VR, SimDrawGuiDialog (the function that draws this dialog in flat 2D
// play) is entirely skipped -- see fssimulation.cpp's
// `if(0==FsVrIsActive()) SimDrawGuiDialog();` -- so before this feature the
// menu would open and grab input while being completely invisible and
// un-closeable. Two engine-side pieces now make it usable without ever
// drawing a 3D dialog quad:
//   - FsSimulation::SimComputeVrGuiState runs every VR frame UNCONDITIONALLY
//     (not just while a GUI composite quad happens to be allocated) and
//     publishes dialogVisible/apMenu (fsvr.h's FsVrGuiDataPointer) plus the
//     REAL, ordered option-label list of whatever dialog is open (fsvr.h's
//     FsVrGuiMenuPointer, see SimSerializeVrGuiMenu / FsGuiDialog::GetItem).
//   - The web layer's right-dial selection GUIDE (drawGuiDialGuide, driven
//     by computeGuiMenuLayout in fswebxr.cpp) reads that real label list and
//     is enough on its own to both show AND operate the menu -- the 3D quad
//     rendering of the dialog itself (setupGui/SimDrawVrGui) is now opt-in,
//     default OFF (Module.ysfwVrOptions.guiPanel, ?vrpanel=1), and only
//     force-enabled when the guide itself determines the current dialog does
//     not fit (more real options than the dial's 6 slots, or not a
//     hotkey-driven dialog at all).
//
// Assertions -- PHASE 1, default (?vrpanel NOT set, guiPanel defaults off):
//   (a) GUI composite is NOT allocated once multiview engages (guiData[0]==0)
//       -- proves the quad costs nothing by default.
//   (b) dialogVisible/apMenu both start at 0 (no dialog open yet).
//   (c) after the Backspace tap, dialogVisible==1 AND apMenu==1 (the
//       autopilot menu is one of the dialogs FsGuiAutoPilotDialog's family
//       accepts direct Digit1..5/Digit0/Escape hotkeys on, see fsvr.h) --
//       AND guiData[0] is STILL 0: the AP menu has only 6 real options, well
//       within the dial's capacity, so the guide never needed to force the
//       panel on.
//   (d) the engine's real option-label list (vr.ctl.dial.right.guiMenu,
//       parsed from fsvr.h's FsVrGuiMenuPointer) has exactly 6 options plus
//       a separate cancel entry, in the dialog's own order, containing the
//       EXACT strings FsGuiAutoPilotDialog::Make() puts on-screen (read from
//       fsguiinfltdlg.cpp and the loaded language resource -- checked
//       against BOTH the English default and the ja.uitxt Japanese text, so
//       this holds regardless of which the test browser's locale loads),
//       and is marked drivable with no overflow.
//   (e) a right-stick "down" flick while the menu is open does NOT dispatch
//       the dial's normal Gear key (KeyG) -- the dial-selection logic must
//       be suppressed/rerouted, not merely left alone by coincidence.
//   (f) the right trigger, with that same "down" pick, dispatches Digit3
//       (GUI_DIAL.down -- the AP menu's 3rd option, "Landing") instead --
//       proving the routing works end to end with the quad never allocated.
//   (g) the right grip stick (aileron) still works while the dialog is open
//       -- flying the plane is never blocked by an open dialog.
//   (h) an Escape tap (mirroring the right-B/left-X/Y reroute) closes the
//       dialog: dialogVisible falls back to 0.
//   (i) discoverability guide (fswebxr.cpp's rdial.guiMode/drawGuiDialGuide):
//       while the AP menu is open, the right dial is FORCED visible
//       (regardless of thumbstick engagement) and its guiMode is 'ap'; the
//       left dial is hidden outright (its functions are suppressed anyway).
//       vr.dumpDialLayer('right') (a headless readback of the SAME
//       drawDial/drawGuiDialGuide the real quad would use) is dumped to
//       gui-guide.png for a human to eyeball the real labels rendered.
//
// Assertions -- PHASE 2, ?vrpanel=1 (forces the quad on regardless):
//   (j) GUI composite IS allocated + correctly sized (640x360) once
//       multiview engages.
//   (k) opening the AP menu draws real content into the GUI texture on both
//       multiview layers (nonzero alpha, bigger fraction than the old
//       1024x640 texture gave -- same check as the original single-phase
//       version of this test).
//
//   node scripts/smoke-vrgui.mjs [url] [outDir]
import { chromium } from 'playwright';
import fs from 'fs';

const baseUrl = process.argv[2] || 'http://localhost:8923/index.html?freeflight=F-15C_EAGLE';
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

async function bootFlight(page) {
  await page.goto(page.__url);
  await page.waitForFunction(() => !!globalThis.Module, null, { timeout: 90000 });
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
    console.error('FAILED: flight never started (' + page.__url + ')');
    return false;
  }
  await page.keyboard.press('Space');
  await page.waitForTimeout(1000);
  await page.keyboard.press('Space');
  await page.waitForTimeout(2000);
  return true;
}

async function forceVr(page) {
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
  return forced;
}

function openApMenu(page) {
  return page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Backspace', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Backspace', bubbles: true }));
  });
}

const browser = await chromium.launch({
  executablePath: process.env.YSFW_CHROMIUM || undefined,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=gl']
});

// =========================================================================
// PHASE 1: default (guiPanel off) -- the guide alone must drive the AP menu.
// =========================================================================
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.__url = baseUrl;
page.on('console', (m) => { const t = m.text(); if (FATAL_PATTERNS.some((re) => re.test(t))) fatal.push('[console] ' + t); });
page.on('pageerror', (e) => fatal.push('[pageerror] ' + e.message));

if (!(await bootFlight(page))) { await browser.close(); process.exit(1); }

const hooksOk = await page.evaluate(() => {
  const M = globalThis.Module;
  const vr = M && M.ysfwVr;
  return !!(vr && vr.pokeEye && vr.forceMultiview && vr.readGuiData && vr.readGuiLayerStats &&
    vr.pokeControllerFrame && vr.readControlBlock && vr.dumpDialLayer);
});
if (!hooksOk) {
  console.error('FAILED: VR GUI test hooks missing');
  await browser.close();
  process.exit(1);
}

const forced1 = await forceVr(page);
if (forced1 !== 'ok') {
  console.error('FAILED to force multiview mode: ' + forced1);
  await browser.close();
  process.exit(1);
}
await page.waitForTimeout(2000); // several single-pass stereo frames

// ---- (a) GUI composite NOT allocated by default --------------------------
let guiData = await page.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('default (?vrpanel unset): GUI composite quad is NOT allocated (guiData[0]==0)', guiData[0] === 0, 'guiData=' + JSON.stringify(guiData));

// ---- (b) no dialog open yet -----------------------------------------------
check('dialogVisible==0 before opening any dialog', guiData[5] === 0, 'dialogVisible=' + guiData[5]);
check('apMenu==0 before opening any dialog', guiData[6] === 0, 'apMenu=' + guiData[6]);

// ---- Open the autopilot menu, same as the left dial's AP tap -------------
await openApMenu(page);
await page.waitForTimeout(500);

// ---- (c) dialog now open, reported as the autopilot family, quad STILL off
guiData = await page.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('dialogVisible==1 after Backspace (autopilot menu) tap', guiData[5] === 1, 'dialogVisible=' + guiData[5]);
check('apMenu==1 (autopilot menu family)', guiData[6] === 1, 'apMenu=' + guiData[6]);
check('AP menu (<=6 real options) never needed to force the panel on: guiData[0] still 0', guiData[0] === 0, 'guiData=' + JSON.stringify(guiData));

// ---- (d) real option labels, read straight from the engine ----------------
// Poke a neutral controller frame so processControllerPlain runs and
// populates vr.ctl.dial.right.guiMenu from the (already-open) dialog.
await page.evaluate(() => {
  globalThis.Module.ysfwVr.setPresenting(true);
  globalThis.Module.ysfwVr.pokeControllerFrame([{ hand: 'right', pos: [0, 0, 0], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]);
});
let dialState = await page.evaluate(() => {
  const vr = globalThis.Module.ysfwVr;
  return { guiMode: vr.ctl.dial.right.guiMode, guiMenu: vr.ctl.dial.right.guiMenu };
});
const menu = dialState.guiMenu;
check('guiMenu parsed from the engine has 6 real options + a separate cancel', !!menu && menu.options.length === 6 && !!menu.cancel, 'menu=' + JSON.stringify(menu));
check('guiMenu.drivable (hotkey-driven, fits the dial) with no overflow', !!menu && menu.drivable === true && menu.overflow === false, 'menu=' + JSON.stringify(menu));
// FsGuiAutoPilotDialog::Make (fsguiinfltdlg.cpp) puts these exact option
// texts on-screen, via FsGetTextResource("dlg/autopilot/...", <English
// default>) -- checked against BOTH that English default AND the ja.uitxt
// Japanese text it falls back to when the loaded language resource has an
// entry, so this holds regardless of which the test browser's locale loads.
const wants = [
  { i: 0, en: 'Circle', ja: '旋回' },
  { i: 1, en: 'Straight', ja: '水平' },
  { i: 2, en: 'Landing', ja: '着陸' },
  { i: 3, en: 'Takeoff', ja: '離陸' },
  { i: 4, en: 'Heading', ja: 'ヘディング' },
  { i: 5, en: 'Disengage', ja: '解除' },
];
for (const w of wants) {
  const text = menu && menu.options[w.i] && menu.options[w.i].text || '';
  check('guiMenu.options[' + w.i + '] contains "' + w.en + '" or "' + w.ja + '"', text.includes(w.en) || text.includes(w.ja), 'text=' + JSON.stringify(text));
}
const cancelText = (menu && menu.cancel && menu.cancel.text) || '';
check('guiMenu.cancel contains "Cancel" or the ja.uitxt cancel text', cancelText.includes('Cancel') || cancelText.includes('取り消し') || cancelText.includes('取消'), 'cancelText=' + JSON.stringify(cancelText));

// ---- (i, part 1) discoverability guide: right dial forced visible --------
await page.evaluate(() => {
  globalThis.Module.ysfwVr.pokeControllerFrame([{ hand: 'left', pos: [0, 0, -0.08], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]);
});
dialState = await page.evaluate(() => {
  const vr = globalThis.Module.ysfwVr;
  return {
    right: { visible: vr.ctl.dial.right.visible, guiMode: vr.ctl.dial.right.guiMode },
    left: { visible: vr.ctl.dial.left.visible }
  };
});
check('AP menu open: right dial forced visible with no thumbstick engagement', dialState.right.visible === true, 'dialState=' + JSON.stringify(dialState));
check('AP menu open: right dial guiMode is "ap"', dialState.right.guiMode === 'ap', 'dialState=' + JSON.stringify(dialState));
check('AP menu open: left dial hidden', dialState.left.visible === false, 'dialState=' + JSON.stringify(dialState));

// Dump the right dial's guide canvas -- a headless readback of the EXACT
// drawDial/drawGuiDialGuide the real quad layer would show, independent of
// any WebXR quad-layer support (unavailable headless) -- for a human to
// eyeball that it now shows the real option text, not stale hand-transcribed
// captions.
const dialDump = await page.evaluate(() => globalThis.Module.ysfwVr.dumpDialLayer('right'));
if (dialDump) {
  const b64 = dialDump.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(outDir + '/gui-guide.png', Buffer.from(b64, 'base64'));
  console.log('wrote ' + outDir + '/gui-guide.png');
}
check('vr.dumpDialLayer("right") returned a PNG data URL', typeof dialDump === 'string' && dialDump.startsWith('data:image/png'), 'dialDump=' + (dialDump ? dialDump.slice(0, 30) + '...' : dialDump));

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

await resetKeys();
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // clean 0-edge
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 1], buttons: {} }]); // push down (same geometry as smoke-vrdial's Gear pick)
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // sticky recentre
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 1, thumb: [0, 0], buttons: {} }]); // trigger edge 0->1
await page.waitForTimeout(120);
let keys = await readKeys();
// ---- (e) ----
check('menu open: right-stick-down + trigger does NOT dispatch the normal Gear key (KeyG)', !keys.includes('down:KeyG'), 'keys=' + JSON.stringify(keys));
// ---- (f) ----
check('menu open: right-stick-down + trigger dispatches Digit3 (GUI_DIAL.down, "3...Landing") -- routing works with the quad OFF', keys.includes('down:Digit3') && keys.includes('up:Digit3'), 'keys=' + JSON.stringify(keys));
await poke([{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // release trigger

// The AP menu's "3...Landing" option, like every other option in
// FsGuiAutoPilotDialog, both engages that autopilot mode AND closes the
// dialog itself (FsGuiAutoPilotDialog::Landing calls
// sim->SetCurrentInFlightDialog(NULL) -- see fsguiinfltdlg.cpp) -- i.e. the
// Digit3 dispatch above didn't just reach the dialog, it actually drove it
// end to end, same as a real keypress would, with the quad never allocated.
await page.waitForTimeout(300);
guiData = await page.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('selecting "3...Landing" closes the menu itself (dialogVisible back to 0)', guiData[5] === 0, 'dialogVisible=' + guiData[5]);
check('quad still never allocated after a full open/select/close round-trip', guiData[0] === 0, 'guiData=' + JSON.stringify(guiData));

await openApMenu(page);
await page.waitForTimeout(500);
guiData = await page.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('autopilot menu reopened for the remaining checks', guiData[5] === 1 && guiData[6] === 1, 'guiData=' + JSON.stringify(guiData));

// ---- (g) Grip stick (aileron/elevator) still flies the plane -------------
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

await openApMenu(page);
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

// ---- (h) ----
guiData = await page.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('dialogVisible==0 after Escape closes the autopilot menu', guiData[5] === 0, 'dialogVisible=' + guiData[5]);
check('quad still never allocated at the end of phase 1 (default guiPanel=false throughout)', guiData[0] === 0, 'guiData=' + JSON.stringify(guiData));

// ---- (i, part 2) dial mode reverts once the dialog is gone ---------------
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
await page.close();

// =========================================================================
// PHASE 2: ?vrpanel=1 -- explicit opt-in, quad allocates and actually draws.
// =========================================================================
const sep = baseUrl.includes('?') ? '&' : '?';
const page2 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page2.__url = baseUrl + sep + 'vrpanel=1';
page2.on('console', (m) => { const t = m.text(); if (FATAL_PATTERNS.some((re) => re.test(t))) fatal.push('[console] ' + t); });
page2.on('pageerror', (e) => fatal.push('[pageerror] ' + e.message));

if (!(await bootFlight(page2))) { await browser.close(); process.exit(1); }

const forced2 = await forceVr(page2);
if (forced2 !== 'ok') {
  console.error('FAILED to force multiview mode (phase 2): ' + forced2);
  await browser.close();
  process.exit(1);
}
await page2.waitForTimeout(2000);

// ---- (j) ----
let guiData2 = await page2.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('?vrpanel=1: GUI composite quad IS allocated once multiview engages', guiData2[0] === 1, 'guiData=' + JSON.stringify(guiData2));
check('?vrpanel=1: GUI composite sized 640x360', guiData2[3] === 640 && guiData2[4] === 360, 'w=' + guiData2[3] + ' h=' + guiData2[4]);

await openApMenu(page2);
await page2.waitForTimeout(500);

// ---- (k) ----
guiData2 = await page2.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('?vrpanel=1: dialogVisible==1 after opening the AP menu', guiData2[5] === 1, 'dialogVisible=' + guiData2[5]);
const guiLayer0 = await page2.evaluate(() => globalThis.Module.ysfwVr.readGuiLayerStats(0));
const guiLayer1 = await page2.evaluate(() => globalThis.Module.ysfwVr.readGuiLayerStats(1));
check('?vrpanel=1: GUI layer 0 has drawn content (nonzero alpha)', guiLayer0.alpha > 0.05, 'alpha=' + guiLayer0.alpha.toFixed(3));
check('?vrpanel=1: GUI layer 1 has drawn content (nonzero alpha)', guiLayer1.alpha > 0.05, 'alpha=' + guiLayer1.alpha.toFixed(3));
// The old 1024x640 texture measured a mean alpha of ~11.35 for this exact
// AP-menu layout (same absolute-pixel content, just a bigger, mostly-empty
// texture around it); the 640x360 texture measures ~32.3 -- comfortably
// above a 20 threshold placed between the two, proving the dialog covers a
// bigger FRACTION of the texture (and therefore of the composited quad),
// not just that something nonzero got drawn.
check('?vrpanel=1: GUI layer 0 alpha fraction is bigger than the old 1024x640 texture gave (~11.35)', guiLayer0.alpha > 20, 'alpha=' + guiLayer0.alpha.toFixed(3));

const guiDump = await page2.evaluate(() => globalThis.Module.ysfwVr.dumpGuiLayer(0));
if (guiDump) {
  const b64 = guiDump.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(outDir + '/gui-apmenu.png', Buffer.from(b64, 'base64'));
  console.log('wrote ' + outDir + '/gui-apmenu.png');
}
check('vr.dumpGuiLayer(0) returned a PNG data URL', typeof guiDump === 'string' && guiDump.startsWith('data:image/png'), 'guiDump=' + (guiDump ? guiDump.slice(0, 30) + '...' : guiDump));
await page2.screenshot({ path: outDir + '/vrgui-test-3-vrpanel1.png' });

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
