// VR in-flight-GUI-dialog test without a headset.
//
// Boots into a free flight, forces the engine into VR+multiview mode (same
// hook as scripts/smoke-mv.mjs / smoke-vrhud.mjs -- vr.forceMultiview), then
// opens the autopilot menu THROUGH THE LEFT DIAL -- the exact same gesture a
// real pilot uses (select the dial's 'left' sector, pull the left trigger --
// see LEFT_DIAL.left = AP, Backspace, in fswebxr.cpp) -- rather than firing a
// raw synthetic Backspace KeyboardEvent directly. This matters because the
// owner-hand model (Feature 4) attributes an opening dialog to whichever
// hand's dial tap plausibly opened it (vr.ctl.lastDialTapHand ->
// vr.ctl.guiOwner, see processControllerPlain's doc comment); going through
// the real dial is what lets this test exercise that attribution instead of
// just falling back to its 'left' default.
//
// In VR, SimDrawGuiDialog (the function that draws this dialog in flat 2D
// play) is entirely skipped -- see fssimulation.cpp's
// `if(0==FsVrIsActive()) SimDrawGuiDialog();` -- so before this feature the
// menu would open and grab input while being completely invisible and
// un-closeable. Two engine-side pieces make it usable without ever drawing a
// 3D dialog quad:
//   - FsSimulation::SimComputeVrGuiState runs every VR frame UNCONDITIONALLY
//     (not just while a GUI composite quad happens to be allocated) and
//     publishes dialogVisible/apMenu (fsvr.h's FsVrGuiDataPointer) plus the
//     REAL, ordered option-label list of whatever dialog is open (fsvr.h's
//     FsVrGuiMenuPointer, see SimSerializeVrGuiMenu / FsGuiDialog::GetItem).
//   - The web layer's OWNER-HAND selection GUIDE (drawGuiDialGuide, driven by
//     computeGuiMenuLayout in fswebxr.cpp) reads that real label list and is
//     enough on its own to both show AND operate the menu -- the 3D quad
//     rendering of the dialog itself (setupGui/SimDrawVrGui) is opt-in,
//     default OFF (Module.ysfwVrOptions.guiPanel, ?vrpanel=1), and only
//     force-enabled when the guide itself determines the current dialog does
//     not fit (more real options than GUI_DIAL_CAPACITY=8, or not a
//     hotkey-driven dialog at all). The guide dial is N-WAY -- one sector per
//     real option, up to 8 -- so a 6- or 7-option menu never needs the panel;
//     see PHASE 3 below.
//
// Feature 4 (owner-hand model) is the core of THIS revision: the dialog is
// now driven ENTIRELY by whichever hand's dial opened it (vr.ctl.guiOwner) --
// AP lives on the left dial, so opening it that way makes 'left' the owner --
// while the OTHER (right) hand keeps its completely normal flight controls
// (dial, trigger, A/B, grip) the whole time the dialog is open. That is the
// main thing this test now proves that the old, right-hand-hardcoded version
// could not: a right-hand dial tap while the AP menu is open must still fire
// Gun/WeaponSelect/Gear/Brake normally, NOT be swallowed by the dialog.
//
// Assertions -- PHASE 1, default (?vrpanel NOT set, guiPanel defaults off):
//   - GUI composite is NOT allocated once multiview engages (guiData[0]==0)
//     -- proves the quad costs nothing by default.
//   - dialogVisible/apMenu both start at 0 (no dialog open yet).
//   - Opening the AP menu through the LEFT dial's AP sector (thumb-left +
//     left-trigger tap -- the exact real gesture, not a raw keyboard event)
//     makes dialogVisible/apMenu both 1, guiData[0] still 0 (6 real options
//     fits the dial, no forced panel), and vr.ctl.guiOwner === 'left' --
//     proving the attribution mechanism (not just its default) actually
//     works.
//   - The engine's real option-label list, read from the LEFT dial's
//     .guiMenu now (computeGuiMenuLayout/FsVrGuiMenuPointer), has exactly 6
//     options plus a separate cancel entry with the AP menu's real text
//     (English or ja.uitxt Japanese, locale-independent), drivable, no
//     overflow.
//   - Discoverability: the LEFT dial is forced visible with guiMode 'ap';
//     the RIGHT dial's guiMode stays null (it is not a guide -- it is the
//     bystander hand) and is NOT force-visible.
//   - The bystander (right) hand's dial, trigger, and B button all keep
//     firing their ordinary flight functions (Gear/KeyG, Brake/KeyB) while
//     the dialog is open on the left -- and do NOT get routed to the
//     dialog's Digit3 -- proving "the other hand fully reverts to its normal
//     functions".
//   - The owner (left) hand's stick-sector + trigger dispatches the
//     dialog's real positional hotkey for that N-way sector (N=6 for this
//     menu, so "down" is sector 3 -> Digit4, "4...Takeoff") instead of its
//     normal Flap-Down key (KeyF), closing the dialog end to end (same
//     FsGuiAutoPilotDialog::TakeOff side effect as before).
//   - The right grip stick (aileron) still overrides flight control while
//     the dialog is open, regardless of which hand owns it.
//   - The owner hand's A/B (left X/Y here) dispatch the truthful extra
//     hotkeys Digit5/Digit0 (apMenu mode) instead of Escape unconditionally
//     (the old cross-hand-cancel wording) -- and instead of their own normal
//     flap keys.
//   - The owner hand's thumbstick click is the new truthful cancel binding
//     (dispatches Escape, closes the dialog) -- the RIGHT hand's thumbstick
//     click, meanwhile, still just toggles the help placards (unaffected,
//     since it is not the owner).
//   - TRIGGER_THRESHOLD (Feature 1) applies to the GUI-dialog routing too: a
//     0.6 trigger value (below the old 0.75 GRAB_THRESHOLD, above the new
//     0.5) still fires the owner hand's dial-confirm dispatch.
//   - dumpDialLayer('left') (the guide) and dumpDialLayer('right') (the
//     bystander's normal face) are both dumped for a human to eyeball.
//
// Assertions -- PHASE 2, ?vrpanel=1 (forces the quad on regardless):
//   - GUI composite IS allocated + correctly sized (640x360) once multiview
//     engages.
//   - Opening the AP menu (again via the left dial) draws real content into
//     the GUI texture on both multiview layers (nonzero alpha, bigger
//     fraction than the old 1024x640 texture gave).
//
// Assertions -- PHASE 3, N-way sectors beyond the AP menu's 6 options: the
// wingman-command radio-comm menu (up to 8 real options: 7 numbered
// commands + an explicit "0...Don't send") needs a live AI wingman in
// formation to reach headlessly, which is well beyond what this smoke test
// scripts -- so this phase fabricates the engine's option-label list via
// vr.pokeGuiMenu/vr.clearGuiOverride (see fswebxr.cpp's vr.testGuiOverride
// doc comment) instead, exercising the SAME parseMenuLabel/
// computeGuiMenuLayout/updateDialStick/guiDialEngagedFor code a real dialog
// would drive, just skipping the (unrelated) engine-side wingman/formation
// setup:
//   - A fabricated 8-option menu (exactly at GUI_DIAL_CAPACITY) is fully
//     drivable: sector 0 (up), 2 (right), 4 (down), 6 (left) each dispatch
//     THEIR OWN option's real hotkey (Digit1/3/5/7, not a fixed table), and
//     guiForced/the on-quad panel are NOT triggered (guiData[0] stays 0).
//   - A fabricated 7-option menu is also fully drivable with no forced
//     panel (the raised >8 threshold, not the old >6).
//   - A fabricated 9-option menu (one past the cap) still shows/dispatches
//     its first 8 options via the guide, but overflows -- guiMenu.overflow
//     is true and the on-quad panel DOES get force-enabled (guiData[0]
//     becomes 1), proving the raised threshold's ceiling is real.
//   - dumpDialLayer for the 7-option case is dumped to nway-guide.png for a
//     human to eyeball legibility at 256px.
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

const IDENTITY_QUAT = [0, 0, 0, 1];
// Sector-select thumbstick vectors -- see fswebxr.cpp's updateDialStick doc
// comment (upY=-thumb[1], canvas-angle sector split). Cross-checked against
// scripts/smoke-vrdial.mjs's existing up/down picks.
const SECTOR_THUMB = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };

function poke(page, list) {
  return page.evaluate((l) => {
    globalThis.Module.ysfwVr.setPresenting(true);
    globalThis.Module.ysfwVr.pokeControllerFrame(l);
  }, list);
}
function resetKeys(page) {
  return page.evaluate(() => { window.__vrguiKeys = []; });
}
function readKeys(page) {
  return page.evaluate(() => window.__vrguiKeys.slice());
}
function installKeyListener(page) {
  return page.evaluate(() => {
    window.__vrguiKeys = [];
    window.addEventListener('keydown', (e) => window.__vrguiKeys.push('down:' + e.code));
    window.addEventListener('keyup', (e) => window.__vrguiKeys.push('up:' + e.code));
  });
}

// Opens the autopilot menu the SAME way a real left-handed pilot does: pick
// the left dial's 'left' sector (LEFT_DIAL.left = AP, Backspace tap) and
// pull the left trigger -- NOT a raw synthetic Backspace KeyboardEvent. This
// is what lets vr.ctl.lastDialTapHand/guiOwner attribution (Feature 4) be
// exercised for real instead of just falling back to its 'left' default.
async function openApViaLeftDial(page, triggerValue) {
  const t = (undefined !== triggerValue) ? triggerValue : 1;
  await poke(page, [{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // clean 0-edge
  await poke(page, [{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: SECTOR_THUMB.left, buttons: {} }]); // select AP sector
  await poke(page, [{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // sticky recentre
  await poke(page, [{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: t, thumb: [0, 0], buttons: {} }]); // trigger edge 0->t: Backspace tap dispatched THROUGH the dial
  // The running (non-XR) render loop keeps ticking the engine on its own
  // schedule in the background (forceMultiview never pauses it) -- give it
  // real wall-clock time to process the Backspace keydown/keyup and open
  // FsGuiAutoPilotDialog before we poke again.
  await page.waitForTimeout(500);
  await poke(page, [{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // release trigger -- this poke's processControllerPlain call is what detects the dialogVisible false->true transition and assigns vr.ctl.guiOwner
}

const browser = await chromium.launch({
  executablePath: process.env.YSFW_CHROMIUM || undefined,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=gl']
});

// =========================================================================
// PHASE 1: default (guiPanel off) -- the owner-hand guide alone must drive
// the AP menu, and the bystander (right) hand must stay fully normal.
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

// ---- GUI composite NOT allocated by default -------------------------------
let guiData = await page.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('default (?vrpanel unset): GUI composite quad is NOT allocated (guiData[0]==0)', guiData[0] === 0, 'guiData=' + JSON.stringify(guiData));

// ---- no dialog open yet ----------------------------------------------------
check('dialogVisible==0 before opening any dialog', guiData[5] === 0, 'dialogVisible=' + guiData[5]);
check('apMenu==0 before opening any dialog', guiData[6] === 0, 'apMenu=' + guiData[6]);
check('guiOwner defaults to "left" before any dialog has ever opened', 'left' === (await page.evaluate(() => globalThis.Module.ysfwVr.ctl.guiOwner)), 'guiOwner=' + (await page.evaluate(() => globalThis.Module.ysfwVr.ctl.guiOwner)));

await installKeyListener(page);

// ---- Open the autopilot menu THROUGH THE LEFT DIAL ------------------------
await openApViaLeftDial(page);

// ---- dialog now open, reported as the autopilot family, quad STILL off ----
guiData = await page.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('dialogVisible==1 after opening the AP menu via the left dial', guiData[5] === 1, 'dialogVisible=' + guiData[5]);
check('apMenu==1 (autopilot menu family)', guiData[6] === 1, 'apMenu=' + guiData[6]);
check('AP menu (<=6 real options) never needed to force the panel on: guiData[0] still 0', guiData[0] === 0, 'guiData=' + JSON.stringify(guiData));

// ---- guiOwner attribution (Feature 4 core) --------------------------------
const guiOwner = await page.evaluate(() => globalThis.Module.ysfwVr.ctl.guiOwner);
check('guiOwner === "left": the dial that actually opened the dialog is attributed correctly', guiOwner === 'left', 'guiOwner=' + guiOwner);

// ---- real option labels, read from the OWNER (left) dial's guiMenu -------
// Poke a neutral frame on BOTH hands so processControllerPlain runs at
// least once for each and freshly (re)computes rdial.guiMode/ldial.guiMode
// (guiMode starts undefined at page load and is only assigned inside each
// hand's own branch, which only runs on a poke for that hand -- the left
// hand was already poked by openApViaLeftDial, but the right hand has not
// been touched at all yet this session).
await poke(page, [
  { hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} },
  { hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }
]);
let dialState = await page.evaluate(() => {
  const vr = globalThis.Module.ysfwVr;
  return {
    left: { guiMode: vr.ctl.dial.left.guiMode, guiMenu: vr.ctl.dial.left.guiMenu, visible: vr.ctl.dial.left.visible },
    right: { guiMode: vr.ctl.dial.right.guiMode, visible: vr.ctl.dial.right.visible }
  };
});
const menu = dialState.left.guiMenu;
check('left (owner) dial guiMenu has 6 real options + a separate cancel', !!menu && menu.options.length === 6 && !!menu.cancel, 'menu=' + JSON.stringify(menu));
check('left (owner) dial guiMenu.drivable with no overflow', !!menu && menu.drivable === true && menu.overflow === false, 'menu=' + JSON.stringify(menu));
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
  check('left dial guiMenu.options[' + w.i + '] contains "' + w.en + '" or "' + w.ja + '"', text.includes(w.en) || text.includes(w.ja), 'text=' + JSON.stringify(text));
}
const cancelText = (menu && menu.cancel && menu.cancel.text) || '';
check('left dial guiMenu.cancel contains "Cancel" or the ja.uitxt cancel text', cancelText.includes('Cancel') || cancelText.includes('取り消し') || cancelText.includes('取消'), 'cancelText=' + JSON.stringify(cancelText));

// ---- discoverability: OWNER (left) dial forced guide, RIGHT untouched ----
check('AP menu open: LEFT (owner) dial forced visible', dialState.left.visible === true, 'dialState=' + JSON.stringify(dialState));
check('AP menu open: LEFT (owner) dial guiMode is "ap"', dialState.left.guiMode === 'ap', 'dialState=' + JSON.stringify(dialState));
check('AP menu open: RIGHT (bystander) dial guiMode stays null -- not a guide', dialState.right.guiMode === null, 'dialState=' + JSON.stringify(dialState));
check('AP menu open: RIGHT (bystander) dial is NOT force-visible (normal thumbstick-engagement rule)', dialState.right.visible === false, 'dialState=' + JSON.stringify(dialState));

// Dump both dials' canvases -- a headless readback of the EXACT
// drawDial/drawGuiDialGuide the real quad layers would show: the left one
// must be the dialog guide, the right one must be its ordinary RIGHT_DIAL
// face, independent of any WebXR quad-layer support (unavailable headless).
const guideDump = await page.evaluate(() => globalThis.Module.ysfwVr.dumpDialLayer('left'));
if (guideDump) {
  const b64 = guideDump.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(outDir + '/gui-guide-left.png', Buffer.from(b64, 'base64'));
  console.log('wrote ' + outDir + '/gui-guide-left.png');
}
check('vr.dumpDialLayer("left") (the owner guide) returned a PNG data URL', typeof guideDump === 'string' && guideDump.startsWith('data:image/png'), 'guideDump=' + (guideDump ? guideDump.slice(0, 30) + '...' : guideDump));
const bystanderDump = await page.evaluate(() => globalThis.Module.ysfwVr.dumpDialLayer('right'));
if (bystanderDump) {
  const b64 = bystanderDump.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(outDir + '/gui-bystander-right.png', Buffer.from(b64, 'base64'));
  console.log('wrote ' + outDir + '/gui-bystander-right.png');
}
check('vr.dumpDialLayer("right") (the bystander, normal face) returned a PNG data URL', typeof bystanderDump === 'string' && bystanderDump.startsWith('data:image/png'), 'bystanderDump=' + (bystanderDump ? bystanderDump.slice(0, 30) + '...' : bystanderDump));

// ---- Bystander (right) hand: fully normal, untouched by the dialog -------
await resetKeys(page);
await poke(page, [{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // clean 0-edge
await poke(page, [{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: SECTOR_THUMB.down, buttons: {} }]); // select Gear (normal RIGHT_DIAL.down)
await poke(page, [{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // sticky recentre
await poke(page, [{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 1, thumb: [0, 0], buttons: {} }]); // trigger edge 0->1
await page.waitForTimeout(120);
let keys = await readKeys(page);
check('bystander (right) hand: right-stick-down + trigger STILL dispatches the normal Gear key (KeyG) while the left-owned dialog is open', keys.includes('down:KeyG') && keys.includes('up:KeyG'), 'keys=' + JSON.stringify(keys));
check('bystander (right) hand: does NOT get rerouted to GUI_DIAL (no Digit3)', !keys.includes('down:Digit3'), 'keys=' + JSON.stringify(keys));
await poke(page, [{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // release trigger

await resetKeys(page);
await poke(page, [{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: { b: false } }]);
await poke(page, [{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: { b: true } }]); // right B press edge
await page.waitForTimeout(120);
keys = await readKeys(page);
check('bystander (right) hand: right-B STILL dispatches the normal air-brake key (KeyB), not Digit0', keys.includes('down:KeyB'), 'keys=' + JSON.stringify(keys));
await poke(page, [{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: { b: false } }]);

guiData = await page.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('dialog still open after exercising the bystander hand (unaffected by it)', guiData[5] === 1, 'dialogVisible=' + guiData[5]);

// ---- Owner (left) hand: stick-select + trigger confirms, closes dialog ---
// N-way guide math (see fswebxr.cpp's updateDialStick doc comment): the AP
// menu has 6 real options, so N=6, wedge=60deg, sector i centred at
// i*60deg clockwise from up. "down" is exactly 180deg -> idx=round(180/60)=3
// -> guiMenu.options[3] ("4...Takeoff") -- NOT the old fixed-4-sector
// GUI_DIAL.down/Digit3 ("3...Landing") that this test asserted before the
// dial went N-way; the sector-to-hotkey mapping now reads the menu's OWN
// positional hotkey instead of a fixed table, so a 6-option menu's "down"
// lands on its 4th option, not always its 3rd.
await resetKeys(page);
await poke(page, [{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // clean 0-edge
await poke(page, [{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: SECTOR_THUMB.down, buttons: {} }]); // N=6 sector index 3 ("4...Takeoff") under the owner
await poke(page, [{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // sticky recentre
await poke(page, [{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 1, thumb: [0, 0], buttons: {} }]); // trigger edge 0->1
await page.waitForTimeout(120);
keys = await readKeys(page);
check('owner (left) hand: left-stick-down + trigger does NOT dispatch the normal Flap-Down key (KeyF)', !keys.includes('down:KeyF'), 'keys=' + JSON.stringify(keys));
check('owner (left) hand: left-stick-down + trigger dispatches Digit4 (N-way sector 3 of 6, "4...Takeoff")', keys.includes('down:Digit4') && keys.includes('up:Digit4'), 'keys=' + JSON.stringify(keys));
await poke(page, [{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // release trigger

// FsGuiAutoPilotDialog::TakeOff (Digit4), like every other option, both
// engages that autopilot mode AND closes the dialog itself.
await page.waitForTimeout(300);
guiData = await page.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('selecting "4...Takeoff" from the owner hand closes the menu itself (dialogVisible back to 0)', guiData[5] === 0, 'dialogVisible=' + guiData[5]);
check('quad still never allocated after a full open/select/close round-trip', guiData[0] === 0, 'guiData=' + JSON.stringify(guiData));

// ---- Right grip stick still flies the plane while the dialog is open ----
await openApViaLeftDial(page);
guiData = await page.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('autopilot menu reopened via the left dial for the remaining checks', guiData[5] === 1 && guiData[6] === 1, 'guiData=' + JSON.stringify(guiData));

const HALF_ROLL_30 = [Math.sin(15 * Math.PI / 180), 0, 0, Math.cos(15 * Math.PI / 180)]; // ~30deg about X (pitch axis in controller-local space)
await poke(page, [{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 1, trigger: 0, thumb: [0, 0], buttons: {} }]); // grab neutral
await poke(page, [{ hand: 'right', pos: [0, 0, 0], quat: HALF_ROLL_30, squeeze: 1, trigger: 0, thumb: [0, 0], buttons: {} }]); // deflect
const ctl = await page.evaluate(() => globalThis.Module.ysfwVr.readControlBlock());
check('right grip stick still overrides flight control while a (left-owned) dialog is open', ctl[0] === 1 && (Math.abs(ctl[1]) > 0.05 || Math.abs(ctl[2]) > 0.05), 'ctl=' + JSON.stringify(ctl.slice(0, 4)));
await poke(page, [{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // release grip

// ---- Owner (left) X/Y: truthful extra hotkeys Digit5/Digit0 -------------
await resetKeys(page);
await poke(page, [{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: { a: false } }]);
await poke(page, [{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: { a: true } }]); // left X press edge
await page.waitForTimeout(120);
keys = await readKeys(page);
check('owner (left) hand: left-X does NOT dispatch the normal flaps-down key (KeyF)', !keys.includes('down:KeyF'), 'keys=' + JSON.stringify(keys));
check('owner (left) hand: left-X dispatches Digit5 (the truthful extra hotkey, apMenu mode) -- not an unconditional Escape', keys.includes('down:Digit5') && keys.includes('up:Digit5'), 'keys=' + JSON.stringify(keys));
await poke(page, [{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: { a: false } }]);

guiData = await page.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('selecting "5...Fly Heading Bug" via left-X closes the menu itself (dialogVisible back to 0)', guiData[5] === 0, 'dialogVisible=' + guiData[5]);

await openApViaLeftDial(page);
await resetKeys(page);
await poke(page, [{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: { b: false } }]);
await poke(page, [{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: { b: true } }]); // left Y press edge
await page.waitForTimeout(120);
keys = await readKeys(page);
check('owner (left) hand: left-Y does NOT dispatch the normal flaps-up key (KeyR)', !keys.includes('down:KeyR'), 'keys=' + JSON.stringify(keys));
check('owner (left) hand: left-Y dispatches Digit0 (the truthful extra hotkey, "0...Disengage")', keys.includes('down:Digit0') && keys.includes('up:Digit0'), 'keys=' + JSON.stringify(keys));
await poke(page, [{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: { b: false } }]);
guiData = await page.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('selecting "0...Disengage" via left-Y closes the menu itself (dialogVisible back to 0)', guiData[5] === 0, 'dialogVisible=' + guiData[5]);

// ---- Owner-hand cancel: thumbstick click, no more cross-hand escape -----
await openApViaLeftDial(page);
await resetKeys(page);
// The RIGHT hand's thumbstick click, meanwhile, is NOT the owner -- it must
// still just toggle the help placards, not touch the dialog at all.
const helpBefore = await page.evaluate(() => globalThis.Module.ysfwVr.help.visible);
await poke(page, [{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: { stick: false } }]);
await poke(page, [{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: { stick: true } }]); // right thumbstick click press edge
keys = await readKeys(page);
const helpAfter = await page.evaluate(() => globalThis.Module.ysfwVr.help.visible);
check('bystander (right) hand thumbstick click: still just toggles help (does not cancel the dialog)', helpAfter !== helpBefore && !keys.includes('down:Escape'), 'before=' + helpBefore + ' after=' + helpAfter + ' keys=' + JSON.stringify(keys));
guiData = await page.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('dialog still open after the bystander hand\'s thumbstick click', guiData[5] === 1, 'dialogVisible=' + guiData[5]);

await resetKeys(page);
await poke(page, [{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: { stick: false } }]);
await poke(page, [{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: { stick: true } }]); // owner (left) thumbstick click press edge -- the truthful cancel binding
await page.waitForTimeout(120); // vrKeyTap's keyup fires ~60ms after keydown
keys = await readKeys(page);
check('owner (left) hand thumbstick click dispatches Escape (the truthful, self-contained cancel binding)', keys.includes('down:Escape') && keys.includes('up:Escape'), 'keys=' + JSON.stringify(keys));
await poke(page, [{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: { stick: false } }]);
await page.waitForTimeout(300);
guiData = await page.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('owner-hand cancel (stick click) closes the dialog (dialogVisible back to 0)', guiData[5] === 0, 'dialogVisible=' + guiData[5]);

// ---- After close: left dial reverts to normal, guiMode clears -----------
// updateDialStick's own thumbstick-engagement fade timer (DIAL_HIDE_DELAY_MS
// = 1200ms, fswebxr.cpp) is what should now govern ldial.visible (the
// owner-forced-visible override is gone once the dialog is closed) -- wait
// past that delay from the LAST real thumbstick engagement (the sector pick
// inside the most recent openApViaLeftDial call, well within this window)
// so the fade timer has actually expired before asserting on it.
await page.waitForTimeout(1300);
await poke(page, [{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]);
dialState = await page.evaluate(() => {
  const vr = globalThis.Module.ysfwVr;
  return { visible: vr.ctl.dial.left.visible, guiMode: vr.ctl.dial.left.guiMode };
});
check('after close: left (former owner) dial guiMode reverts to null', dialState.guiMode === null, 'dialState=' + JSON.stringify(dialState));
check('after close: left dial visibility falls back to thumbstick-engagement rule (no stick held -> invisible)', dialState.visible === false, 'dialState=' + JSON.stringify(dialState));

// ---- TRIGGER_THRESHOLD (Feature 1) applies to GUI-dialog routing too ----
// A 0.6 trigger value is below the OLD 0.75 GRAB_THRESHOLD (which would
// have missed this press) but above the NEW 0.5 TRIGGER_THRESHOLD -- must
// still fire the owner hand's dial-confirm dispatch.
await openApViaLeftDial(page);
await resetKeys(page);
await poke(page, [{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: SECTOR_THUMB.up, buttons: {} }]); // select up (GUI_DIAL.up -> Digit1)
await poke(page, [{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // sticky recentre
await poke(page, [{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0.6, thumb: [0, 0], buttons: {} }]); // trigger edge 0->0.6 (below old 0.75, above new 0.5)
await page.waitForTimeout(120);
keys = await readKeys(page);
check('lowered TRIGGER_THRESHOLD (0.5): a 0.6 trigger pull still confirms the owner hand\'s GUI_DIAL selection (Digit1)', keys.includes('down:Digit1') && keys.includes('up:Digit1'), 'keys=' + JSON.stringify(keys));
await poke(page, [{ hand: 'left', pos: [0, 0, -0.08], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]);
await page.waitForTimeout(300);
guiData = await page.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('quad still never allocated at the end of phase 1 (default guiPanel=false throughout)', guiData[0] === 0, 'guiData=' + JSON.stringify(guiData));

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

let guiData2 = await page2.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('?vrpanel=1: GUI composite quad IS allocated once multiview engages', guiData2[0] === 1, 'guiData=' + JSON.stringify(guiData2));
check('?vrpanel=1: GUI composite sized 640x360', guiData2[3] === 640 && guiData2[4] === 360, 'w=' + guiData2[3] + ' h=' + guiData2[4]);

await openApViaLeftDial(page2);

guiData2 = await page2.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('?vrpanel=1: dialogVisible==1 after opening the AP menu via the left dial', guiData2[5] === 1, 'dialogVisible=' + guiData2[5]);
const guiOwner2 = await page2.evaluate(() => globalThis.Module.ysfwVr.ctl.guiOwner);
check('?vrpanel=1: guiOwner === "left" here too', guiOwner2 === 'left', 'guiOwner=' + guiOwner2);
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

// =========================================================================
// PHASE 3: N-way sectors beyond the AP menu's 6 options. The real dialog
// that goes past 6 (radio-comm's wingman-command menu, up to 8 options)
// needs a live AI wingman in formation to reach -- not worth scripting here
// -- so this phase fabricates the engine's option-label list via
// vr.pokeGuiMenu/vr.clearGuiOverride instead (see fswebxr.cpp's
// vr.testGuiOverride doc comment), exercising the SAME parseMenuLabel/
// computeGuiMenuLayout/updateDialStick/guiDialEngagedFor code a real dialog
// would drive on the RIGHT hand (attributed via the real
// lastDialTapHand->guiOwner mechanism, not hardcoded).
// =========================================================================
const page3 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page3.__url = baseUrl;
page3.on('console', (m) => { const t = m.text(); if (FATAL_PATTERNS.some((re) => re.test(t))) fatal.push('[console] ' + t); });
page3.on('pageerror', (e) => fatal.push('[pageerror] ' + e.message));

if (!(await bootFlight(page3))) { await browser.close(); process.exit(1); }

const forced3 = await forceVr(page3);
if (forced3 !== 'ok') {
  console.error('FAILED to force multiview mode (phase 3): ' + forced3);
  await browser.close();
  process.exit(1);
}
await page3.waitForTimeout(2000);
await installKeyListener(page3);

// thumbFor(deg): the stick vector that selects N-way sector-angle `deg`
// (0=up, clockwise) -- same atan2 convention updateDialStick/
// drawGuiDialGuide use (see SECTOR_THUMB above for the cardinal-only version).
function thumbFor(deg) {
  const rad = deg * Math.PI / 180;
  return [Math.sin(rad), -Math.cos(rad)];
}

// openFabricatedMenu: attribute a fresh fabricated dialog to the RIGHT hand
// via the real dial-tap attribution mechanism (vr.ctl.lastDialTapHand ->
// guiOwner, see processControllerPlain's doc comment -- the SAME mechanism
// openApViaLeftDial exercises for the left hand with a real dialog), then
// fabricate the option list and poke a neutral right-hand frame so
// processControllerPlain sees the dialogVisible false->true transition and
// assigns guiOwner + resets guiSel to 0.
async function openFabricatedMenu(page, lines, opts) {
  await page.evaluate(() => {
    const vr = globalThis.Module.ysfwVr;
    vr.ctl.lastDialTapHand = 'right';
    vr.ctl.lastDialTapAt = performance.now();
  });
  await page.evaluate(([l, o]) => globalThis.Module.ysfwVr.pokeGuiMenu(l, o), [lines, opts || {}]);
  await poke(page, [{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]);
}
function closeFabricatedMenu(page) {
  return page.evaluate(() => globalThis.Module.ysfwVr.clearGuiOverride());
}
// selectSector: the exact real gesture (sector pick, sticky recentre,
// trigger edge, release) mirroring openApViaLeftDial's shape, generalized to
// an arbitrary stick angle instead of just the 4 cardinal SECTOR_THUMB ones.
async function selectSector(page, deg, triggerValue) {
  const t = (triggerValue !== undefined) ? triggerValue : 1;
  const thumb = thumbFor(deg);
  await poke(page, [{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // clean 0-edge
  await poke(page, [{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb, buttons: {} }]); // select sector
  await poke(page, [{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // sticky recentre
  await poke(page, [{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: t, thumb: [0, 0], buttons: {} }]); // trigger edge
  await page.waitForTimeout(120);
  await poke(page, [{ hand: 'right', pos: [0, 0, 0], quat: IDENTITY_QUAT, squeeze: 0, trigger: 0, thumb: [0, 0], buttons: {} }]); // release
}

// ---- 8-option menu (exactly at GUI_DIAL_CAPACITY) -------------------------
const MENU8 = [
  '1...Break and Attack',
  '2...Attack Ground Target',
  '3...Cover Me',
  '4...Form on My Wing',
  '5...Return to Base',
  '6...Stay in Holding Pattern',
  '7...Land, Refuel and Take Off',
  "0...Don't Send",
];
await openFabricatedMenu(page3, MENU8);
let dialR = await page3.evaluate(() => {
  const vr = globalThis.Module.ysfwVr;
  return { guiMode: vr.ctl.dial.right.guiMode, guiMenu: vr.ctl.dial.right.guiMenu, guiOwner: vr.ctl.guiOwner };
});
check('phase3: guiOwner attributed to "right" for the fabricated menu (via lastDialTapHand)', dialR.guiOwner === 'right', 'guiOwner=' + dialR.guiOwner);
check('phase3 (N=8): fabricated menu is drivable with no overflow (exactly at GUI_DIAL_CAPACITY)', !!dialR.guiMenu && dialR.guiMenu.drivable === true && dialR.guiMenu.options.length === 8 && dialR.guiMenu.overflow === false, 'guiMenu=' + JSON.stringify(dialR.guiMenu));
check('phase3 (N=8): right dial guiMode is "ap" for the fabricated menu', dialR.guiMode === 'ap', 'guiMode=' + dialR.guiMode);

// Sector i's centre is at i*45deg (N=8, wedge=360/8=45, all clean multiples
// -- see updateDialStick's doc comment). Each dispatches options[i]'s OWN
// hotkey, not a fixed table.
await resetKeys(page3);
await selectSector(page3, 0);
let keys3 = await readKeys(page3);
check('phase3 (N=8): sector 0 (up, 0deg) dispatches Digit1 (options[0], "1...Break and Attack")', keys3.includes('down:Digit1') && keys3.includes('up:Digit1'), 'keys=' + JSON.stringify(keys3));

await resetKeys(page3);
await selectSector(page3, 90);
keys3 = await readKeys(page3);
check('phase3 (N=8): sector 2 (right, 90deg) dispatches Digit3 (options[2], "3...Cover Me")', keys3.includes('down:Digit3') && keys3.includes('up:Digit3'), 'keys=' + JSON.stringify(keys3));

await resetKeys(page3);
await selectSector(page3, 180);
keys3 = await readKeys(page3);
check('phase3 (N=8): sector 4 (down, 180deg) dispatches Digit5 (options[4], "5...Return to Base")', keys3.includes('down:Digit5') && keys3.includes('up:Digit5'), 'keys=' + JSON.stringify(keys3));

await resetKeys(page3);
await selectSector(page3, 270);
keys3 = await readKeys(page3);
check('phase3 (N=8): sector 6 (left, 270deg) dispatches Digit7 (options[6], "7...Land, Refuel and Take Off")', keys3.includes('down:Digit7') && keys3.includes('up:Digit7'), 'keys=' + JSON.stringify(keys3));

await resetKeys(page3);
await selectSector(page3, 315);
keys3 = await readKeys(page3);
check("phase3 (N=8): sector 7 (315deg) dispatches Digit0 (options[7], \"0...Don't Send\")", keys3.includes('down:Digit0') && keys3.includes('up:Digit0'), 'keys=' + JSON.stringify(keys3));

let guiData3 = await page3.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('phase3 (N=8): an exactly-at-cap 8-option menu never forces the on-quad panel (guiData[0]==0)', guiData3[0] === 0, 'guiData=' + JSON.stringify(guiData3));

await closeFabricatedMenu(page3);

// ---- 7-option menu: also fully drivable, no forced panel ------------------
const MENU7 = MENU8.slice(0, 7); // drop the trailing "0...Don't Send" line.
await openFabricatedMenu(page3, MENU7);
dialR = await page3.evaluate(() => ({ guiMenu: globalThis.Module.ysfwVr.ctl.dial.right.guiMenu }));
check('phase3 (N=7): 7-option fabricated menu is drivable with no overflow', !!dialR.guiMenu && dialR.guiMenu.drivable === true && dialR.guiMenu.options.length === 7 && dialR.guiMenu.overflow === false, 'guiMenu=' + JSON.stringify(dialR.guiMenu));

// N=7, wedge=360/7≈51.4286deg. Sector 0 (up) is an exact multiple (0/wedge=0)
// so it is unambiguous for any N; 90deg is round(90/(360/7))=round(1.75)=2 --
// also unambiguous (not a .5 tie) -- see updateDialStick's round()-based pick.
await resetKeys(page3);
await selectSector(page3, 0);
keys3 = await readKeys(page3);
check('phase3 (N=7): sector 0 (up) dispatches Digit1 (options[0])', keys3.includes('down:Digit1') && keys3.includes('up:Digit1'), 'keys=' + JSON.stringify(keys3));

await resetKeys(page3);
await selectSector(page3, 90);
keys3 = await readKeys(page3);
check('phase3 (N=7): sector round(90/(360/7))=2 dispatches Digit3 (options[2])', keys3.includes('down:Digit3') && keys3.includes('up:Digit3'), 'keys=' + JSON.stringify(keys3));

guiData3 = await page3.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('phase3 (N=7): a 7-option menu does NOT force the on-quad panel (guiData[0]==0 -- the raised >8 threshold, not the old >6)', guiData3[0] === 0, 'guiData=' + JSON.stringify(guiData3));

// Dump the 7-option guide for a human to eyeball legibility at 256px.
const nwayDump = await page3.evaluate(() => globalThis.Module.ysfwVr.dumpDialLayer('right'));
if (nwayDump) {
  const b64 = nwayDump.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(outDir + '/nway-guide.png', Buffer.from(b64, 'base64'));
  console.log('wrote ' + outDir + '/nway-guide.png');
}
check('phase3: dumpDialLayer("right") returned a PNG data URL for the 7-option N-way guide', typeof nwayDump === 'string' && nwayDump.startsWith('data:image/png'), 'nwayDump=' + (nwayDump ? nwayDump.slice(0, 30) + '...' : nwayDump));

await closeFabricatedMenu(page3);

// ---- 9-option menu (one past the cap): still drivable up to 8, but -------
// ---- overflow forces the on-quad panel on. --------------------------------
const MENU9 = MENU8.concat(['9...Extra Command Past The Cap']);
await openFabricatedMenu(page3, MENU9);
dialR = await page3.evaluate(() => ({ guiMenu: globalThis.Module.ysfwVr.ctl.dial.right.guiMenu }));
check('phase3 (N=9): fabricated 9-option menu is capped to 8 shown sectors with overflow=true', !!dialR.guiMenu && dialR.guiMenu.options.length === 8 && dialR.guiMenu.overflow === true && dialR.guiMenu.drivable === true, 'guiMenu=' + JSON.stringify(dialR.guiMenu));

guiData3 = await page3.evaluate(() => globalThis.Module.ysfwVr.readGuiData());
check('phase3 (N=9): overflowing past the cap DOES force the on-quad panel on (guiData[0]==1)', guiData3[0] === 1, 'guiData=' + JSON.stringify(guiData3));

await closeFabricatedMenu(page3);
await page3.close();

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
