// VR dial RENDERED-FACE test without a headset -- the user-visible half.
//
// WHY THIS EXISTS: the "stale GUN highlight" device bug survived three fix
// rounds because every previous smoke assertion checked internal PICK state
// (dial.sel, vr.dialRedrawKey) while the user-visible RENDER path --
// updateDialLayers' redraw gate, its drawnSel bookkeeping, and the
// visible/inLayers lifecycle -- never ran headless at all (early-out on
// !vr.mvBinding, which needs a live WebXR session).  This script drives the
// REAL per-frame pipeline end-to-end:
//
//   pokeControllerFrame (Quest-Touch-shaped entries -- full buttons +
//   thumbstick, through the exact processControllerPlain the live loop
//   uses; no vr.ctl poking)
//     -> vr.tickDialFace() (the REAL updateDialLayers, with a canvas-only
//        resource so only the GL upload/renderState steps are skipped)
//     -> vr.readRenderedDialPatch / vr.dumpRenderedDialFace (the canvas AS
//        THE GATE LAST PAINTED IT -- no repaint, unlike vr.dumpDialLayer)
//
// and asserts on the PIXELS of the selection accent (amber tick/arrowhead,
// only ever painted on the selected sector) through the exact gesture from
// the device report: deflect to GUN (up), trigger-confirm (hold mode: press
// AND release), rest (both the ~200ms brief variant and the >1.2s
// full-hide variant), deflect to 武器切替 (up-right, 60deg), and WITHOUT
// confirming check several consecutive frames of what the face shows.
//
//   node scripts/smoke-vrdialface.mjs [url] [outDir]
//
// Evidence PNGs (face-*.png) are written into outDir per phase.
import { chromium } from 'playwright';
import fs from 'fs';

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
    console.error('FAILED: flight never started');
    await browser.close();
    process.exit(1);
  }
}
await page.keyboard.press('Space');
await page.waitForTimeout(1000);
await page.keyboard.press('Space');
await page.waitForTimeout(2000);

const hooksOk = await page.evaluate(() => {
  const vr = globalThis.Module && globalThis.Module.ysfwVr;
  return !!(vr && vr.pokeControllerFrame && vr.tickDialFace && vr.readRenderedDialPatch && vr.dumpRenderedDialFace && vr.dialFaceDebug);
});
if (!hooksOk) {
  console.error('FAILED: dial-face harness hooks missing');
  await browser.close();
  process.exit(1);
}
await page.evaluate(() => globalThis.Module.ysfwVr.setPresenting(true));

// One simulated XR frame: full Quest-Touch-shaped entries for BOTH hands
// (the real loop streams both every frame), then the REAL updateDialLayers.
function frame(thumb, trigger) {
  return page.evaluate((args) => {
    const vr = globalThis.Module.ysfwVr;
    vr.pokeControllerFrame([
      { hand: 'right', pos: [0.2, -0.25, -0.4], quat: [0, 0, 0, 1], squeeze: 0, trigger: args.trigger, thumb: args.thumb, buttons: { a: false, b: false, stick: false } },
      { hand: 'left', pos: [-0.2, -0.25, -0.4], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, thumb: [0, 0], buttons: { a: false, b: false, stick: false } }
    ]);
    vr.tickDialFace();
    return vr.dialFaceDebug('right');
  }, { thumb, trigger });
}

// Selection-accent pixel probes on the 384px canvas (cx=cy=192): drawDial
// paints the amber tick (radius 31..41) + arrowhead (to ~47) ONLY on the
// selected sector; unselected ticks are faint gray-blue and END at radius
// 37.  Probing a 6px-half patch at radius 39 along each sector's centre
// angle therefore sees amber pixels ONLY when that sector is selected.
// Sector i centre = -90deg + i*60deg in canvas terms.
function probePos(sector) {
  const a = (-90 + sector * 60) * Math.PI / 180;
  return [Math.round(192 + Math.cos(a) * 39), Math.round(192 + Math.sin(a) * 39)];
}
function readAccent(sector) {
  const [x, y] = probePos(sector);
  return page.evaluate((p) => globalThis.Module.ysfwVr.readRenderedDialPatch('right', p[0], p[1], 6), [x, y]);
}
async function savePng(name) {
  const dataUrl = await page.evaluate(() => globalThis.Module.ysfwVr.dumpRenderedDialFace('right'));
  if (dataUrl) fs.writeFileSync(outDir + '/' + name, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
  return !!dataUrl;
}

// Thumbstick vectors (xr-standard axes: y NEGATIVE = pushed up/away).
const THUMB_UP = [0, -1];                                        // GUN (sector 0)
const THUMB_UPRIGHT = [Math.sin(Math.PI / 3), -Math.cos(Math.PI / 3)]; // 武器切替 (sector 1, 60deg)
const REST = [0, 0];

// ---- Phase 1: deflect to GUN, verify the FACE shows GUN highlighted ------
for (let i = 0; i < 3; ++i) await frame(REST, 0);
await frame([0, -0.6], 0); // deflection ramp, as a real stick sweeps
let dbg = null;
for (let i = 0; i < 4; ++i) dbg = await frame(THUMB_UP, 0);
console.log('phase1 trace:', JSON.stringify(dbg));
let acc0 = await readAccent(0), acc1 = await readAccent(1);
check('phase1: face shows GUN (sector 0) accent after deflecting up', acc0 && 0 < acc0.accent, 'acc0=' + JSON.stringify(acc0));
check('phase1: face shows NO accent on 武器切替 (sector 1) yet', acc1 && 0 === acc1.accent, 'acc1=' + JSON.stringify(acc1));
await savePng('face-1-gun.png');

// ---- Phase 2: trigger-confirm GUN (hold mode: press AND release) ---------
await frame(REST, 0);
await frame(REST, 0);
for (let i = 0; i < 4; ++i) await frame(REST, 1.0); // hold: GUN firing
await frame(REST, 0);                               // release
await frame(REST, 0);

// ---- Phase 3 (variant a): BRIEF rest (~200ms), dial still visible --------
for (let i = 0; i < 13; ++i) {
  await frame(REST, 0);
  await page.waitForTimeout(15);
}
const visA = await page.evaluate(() => globalThis.Module.ysfwVr.ctl.dial.right.visible);
check('phase3a setup: dial still visible after the brief rest', true === visA, 'visible=' + visA);

// Deflect to 武器切替 and WITHOUT confirming, check several consecutive
// frames of the rendered face.
await frame([0.3, -0.17], 0); // ramp
let stale = false, traces = [];
for (let f = 0; f < 4; ++f) {
  const d = await frame(THUMB_UPRIGHT, 0);
  traces.push(d);
  const a0 = await readAccent(0), a1 = await readAccent(1);
  if (!(a1 && 0 < a1.accent) || (a0 && 0 < a0.accent)) stale = true;
  check('phase3a frame ' + f + ': face highlights 武器切替 (sector 1), not GUN', (a1 && 0 < a1.accent) && (a0 && 0 === a0.accent), 'acc0=' + JSON.stringify(a0) + ' acc1=' + JSON.stringify(a1));
}
console.log('phase3a traces:', JSON.stringify(traces));
await savePng(stale ? 'face-2a-STALE-after-brief-rest.png' : 'face-2a-ok-after-brief-rest.png');

// ---- Phase 4 (variant b): FULL hide (>1.2s real rest) ---------------------
// Re-select + confirm GUN again, then really wait out DIAL_HIDE_DELAY_MS.
await frame(REST, 0);
await frame([0, -0.6], 0);
for (let i = 0; i < 3; ++i) await frame(THUMB_UP, 0);
await frame(REST, 0);
for (let i = 0; i < 3; ++i) await frame(REST, 1.0);
await frame(REST, 0);
for (let i = 0; i < 30; ++i) {
  await frame(REST, 0);
  await page.waitForTimeout(50); // 1.5s of real rest
}
const visB = await page.evaluate(() => globalThis.Module.ysfwVr.ctl.dial.right.visible);
check('phase4b setup: dial fully hidden after the >1.2s rest', false === visB, 'visible=' + visB);

// FAST flick, deliberately NO ramp frame: rest -> full up-right deflection
// within a single simulated frame, the way a snappy thumb crosses both the
// visible (0.3) and select (0.5) thresholds inside one 72Hz frame.  This is
// the exact window where the pre-fix code wasted its ONE redraw+upload on
// the same frame that re-added the quad to the render state (the upload
// never got presented; the compositor kept showing the pre-hide GUN buffer,
// and the closed gate never re-uploaded) -- the device's stale-GUN repro.
// Phase 3a above keeps a ramp frame, covering the slow-deflection shape.
//
// Frame 0 (the re-add frame itself) is exempt from the pixel check: the
// quad is not yet in the APPLIED render state that frame, so the user sees
// NO dial at all for that one ~14ms frame -- whatever its buffer holds is
// off-screen (updateRenderState takes effect on the next frame).  From
// frame 1 the dial is actually displayed, and the fix's every-presented-
// frame upload guarantees it shows the live selection immediately.
let staleB = false, tracesB = [];
for (let f = 0; f < 4; ++f) {
  const d = await frame(THUMB_UPRIGHT, 0);
  tracesB.push(d);
  if (0 === f) continue; // buffer not on screen this frame -- see above.
  const a0 = await readAccent(0), a1 = await readAccent(1);
  if (!(a1 && 0 < a1.accent) || (a0 && 0 < a0.accent)) staleB = true;
  check('phase4b frame ' + f + ' (fast flick, first DISPLAYED frames): face highlights 武器切替 (sector 1), not GUN', (a1 && 0 < a1.accent) && (a0 && 0 === a0.accent), 'acc0=' + JSON.stringify(a0) + ' acc1=' + JSON.stringify(a1));
}
console.log('phase4b traces:', JSON.stringify(tracesB));
await savePng(staleB ? 'face-3b-STALE-after-full-hide.png' : 'face-3b-ok-after-full-hide.png');

await browser.close();

if (fatal.length) {
  console.error('FATAL console output:');
  for (const f of fatal) console.error('  ' + f);
  process.exit(1);
}
const failed = results.filter((r) => !r.pass);
if (failed.length) {
  console.error('VR DIAL FACE TEST FAILED (' + failed.length + '/' + results.length + ' assertions failed)');
  process.exit(1);
}
console.log('VR DIAL FACE TEST PASSED (' + results.length + '/' + results.length + ' assertions)');
