// VR collimated gunsight-reticle test without a headset.
//
// Boots into free flight, forces VR+multiview (same test hook as smoke-mv /
// smoke-vrhud), then verifies the collimated-reticle fix:
//
//   (a) the gun crosshair is GONE from the shared flat HUD texture -- the
//       center region (where FsHeadUpDisplay::DrawCrossHair used to draw, at
//       texture coords (W/2, H*2/3)) now has ~zero alpha, while the rest of the
//       HUD (readHudLayerStats) still has its normal alpha/luminance (the rest
//       of the symbology is untouched -- crosshair suppression is surgical).
//
//   (b) the crosshair is now a real world-space cross drawn 2000 m dead ahead
//       in the per-eye stereo SCENE pass: sample a small center patch of scene
//       layer 0 AND layer 1, assert HUD-green reticle pixels are present in
//       both, AND that their centroid lands at the SAME pixel position in both
//       layers (ZERO disparity -- the whole point of the collimated fix).  The
//       synthetic eyes carry +/-32 mm IPD-like translations (no yaw here, so
//       the only per-eye difference is that baseline): a 20 m-distant point
//       would show a visible pixel disparity, but the 2000 m reticle must land
//       within ~1-2 px of the same position in both eyes.
//
//   node scripts/smoke-vrreticle.mjs [url] [outDir]
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const url = process.argv[2] || 'http://localhost:8923/index.html?freeflight=F-15C_EAGLE';
const outDir = process.argv[3] || '.';

const FATAL_PATTERNS = [
  /Link Status 0/, /Compile Status 0/, /declared as type/, /Error Message: error/,
  /Aborted\(/, /Failed to create WebGL context/, /Feedback loop/,
  /invalid internalformat/, /INVALID_ENUM/, /does not match uniform method/,
  /GL_INVALID/, /RuntimeError/, /number of views/i,
];

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
    await page.screenshot({ path: outDir + '/vrreticle-test-0-stuck.png' });
    console.error('FAILED: flight never started');
    await browser.close();
    process.exit(1);
  }
}
await page.keyboard.press('Space');
await page.waitForTimeout(1000);
await page.keyboard.press('Space');
await page.waitForTimeout(3000);

// Enter multiview mode with a CLEAN stereo baseline: identity eye rotation on
// both eyes (unlike smoke-vrhud, which yaws eye 1 by 5deg to make the scenes
// obviously differ); the only per-eye difference is the +/-32 mm IPD-like x
// translation.  That is exactly the setup the zero-disparity assertion needs:
// a point at infinity projects to the same pixel in both eyes, a near point
// does not.
const W = 512, H = 512;
const forced = await page.evaluate(([W, H]) => {
  const M = globalThis.Module;
  const vr = M && M.ysfwVr;
  if (!vr || !vr.pokeEye || !vr.forceMultiview) return 'hooks-missing';
  // Frustum tangents 0.3 (a ~33 deg FOV, narrower than smoke-vrhud's 90 deg):
  // the reticle subtends a fixed ~0.6 deg, so a narrower FOV resolves it as a
  // proper little cross (~9 px) instead of a sub-pixel blob -- clearer for the
  // detection AND the evidence PNG, and it AMPLIFIES near-field disparity (a
  // 20 m point would shift ~2.7 px between the eyes) so a truly zero-disparity
  // 2000 m reticle is a strong assertion, not a lucky sub-pixel coincidence.
  vr.pokeEye(0, [
    0.3, 0.3, 0.3, 0.3,
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, +0.032, 0, 0, 1,
    0, 0, W, H
  ]);
  vr.pokeEye(1, [
    0.3, 0.3, 0.3, 0.3,
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -0.032, 0, 0, 1,
    0, 0, W, H
  ]);
  return vr.forceMultiview(W, H);
}, [W, H]);
if (forced !== 'ok') {
  console.error('FAILED to force multiview mode: ' + forced);
  await browser.close();
  process.exit(1);
}
await page.waitForTimeout(3000); // several single-pass stereo frames

// The flat HUD is 768x432 (setupHud); FsHeadUpDisplay lays the crosshair at
// window coords (W/2, H*2/3) -> (384, 288) in top-down texture space.
const HUD_CX = 384, HUD_CY = 288, HUD_HALF = 30;
// Scene center patch: +/-16 px around the layer center.  The reticle subtends
// ~0.6 deg -> ~3 px at 512 px / 90 deg FOV and is guaranteed dead-center (2000 m
// on the boresight), so a tight patch captures the whole reticle while keeping
// out the occasional sunlit-grass pixel that saturates to g=255 farther out.
const PATCH_HALF = 16;

const data = await page.evaluate(([hudCx, hudCy, hudHalf, patchHalf]) => {
  const vr = globalThis.Module.ysfwVr;
  return {
    hudData: vr.readHudData(),
    hudFull0: vr.readHudLayerStats(0),
    hudCenter0: vr.readHudPatchStats(0, hudCx, hudCy, hudHalf),
    hudCenter1: vr.readHudPatchStats(1, hudCx, hudCy, hudHalf),
    patch0: vr.readMultiviewCenterPatch(0, patchHalf),
    patch1: vr.readMultiviewCenterPatch(1, patchHalf),
    // Tight 40x40 center crop, 8x nearest-neighbor upscale (-> 320x320) so the
    // ~3 px reticle reads clearly against the terrain for the evidence PNG.
    pngLayer0: vr.dumpMultiviewLayer(0, 20, 8)
  };
}, [HUD_CX, HUD_CY, HUD_HALF, PATCH_HALF]);

// Save the reticle evidence PNG (center-crop of scene layer 0).
{
  const b64 = data.pngLayer0.split(',')[1];
  writeFileSync(outDir + '/reticle.png', Buffer.from(b64, 'base64'));
  // Coordinator-specified evidence path (best-effort; ignore if unwritable).
  try {
    writeFileSync(
      '/tmp/claude-1000/-home-toming-keel/2d1970ae-c3d5-4a82-ab5d-179f7d84b43c/scratchpad/reticle.png',
      Buffer.from(b64, 'base64'));
  } catch (e) { /* outDir copy is the fallback */ }
}

// Find HUD-green reticle pixels in a patch and return their centroid.
function reticleCentroid(patch) {
  const { w, h, px } = patch;
  let n = 0, sx = 0, sy = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      // HUD green is EXACTLY (100,255,100): drawn un-fogged, un-shaded, fully
      // opaque, so its pixels have g=255.  Terrain grass tops out around
      // g~220 (e.g. (86,220,86)), so g>240 cleanly isolates the reticle from
      // the lit ground filling the rest of the frame.
      if (g > 240 && g - r > 100 && g - b > 100) { n++; sx += x; sy += y; }
    }
  }
  return n > 0 ? { n, x: sx / n, y: sy / n } : { n: 0, x: NaN, y: NaN };
}

const c0 = reticleCentroid(data.patch0);
const c1 = reticleCentroid(data.patch1);

console.log('vrreticle analysis:', JSON.stringify({
  hudData: data.hudData,
  hudFull0: data.hudFull0,
  hudCenter0: data.hudCenter0,
  hudCenter1: data.hudCenter1,
  reticle0: c0,
  reticle1: c1
}));
await page.screenshot({ path: outDir + '/vrreticle-test-1-during.png' });

let failed = false;
if (fatal.length) {
  console.error('FATAL console output:'); fatal.forEach((f) => console.error('  ' + f));
  failed = true;
}

// Preconditions: HUD composite + reticle both enabled.
if (!(data.hudData && data.hudData[0] === 1)) {
  console.error('FAILED: HUD enable flag not set (hudData=' + JSON.stringify(data.hudData) + ')');
  failed = true;
}
if (!(data.hudData && data.hudData[6] === 1)) {
  console.error('FAILED: reticle enable flag (hudData[6]) not set (hudData=' + JSON.stringify(data.hudData) + ')');
  failed = true;
}

// (a) crosshair removed from the flat HUD texture: center region ~zero alpha,
//     while the whole-HUD alpha is still at its normal level (rest intact).
for (const [i, s] of [[0, data.hudCenter0], [1, data.hudCenter1]]) {
  if (!(s.alpha < 2.0)) {
    console.error('FAILED: HUD layer ' + i + ' crosshair region still has content (alpha=' + s.alpha + ')');
    failed = true;
  } else {
    console.log('PASS: HUD layer ' + i + ' crosshair region cleared (center alpha=' + s.alpha.toFixed(3) + ')');
  }
}
if (!(data.hudFull0.alpha > 2.0 && data.hudFull0.alpha > data.hudCenter0.alpha)) {
  console.error('FAILED: HUD overall alpha not at normal level (full=' + data.hudFull0.alpha +
                ' center=' + data.hudCenter0.alpha + ')');
  failed = true;
} else {
  console.log('PASS: rest of HUD intact (full alpha=' + data.hudFull0.alpha.toFixed(3) +
              ' >> center=' + data.hudCenter0.alpha.toFixed(3) + ')');
}

// (b) reticle present in BOTH scene layers.
for (const [i, c] of [[0, c0], [1, c1]]) {
  if (!(c.n >= 2)) {
    console.error('FAILED: no reticle green found in scene layer ' + i + ' (n=' + c.n + ')');
    failed = true;
  } else {
    console.log('PASS: reticle present in scene layer ' + i + ' (' + c.n + ' green px @ ' +
                c.x.toFixed(2) + ',' + c.y.toFixed(2) + ')');
  }
}

// (b cont.) ZERO disparity: same pixel position in both eyes (2000 m ~= optical
// infinity -> IPD baseline produces no measurable parallax).
if (c0.n >= 2 && c1.n >= 2) {
  const dx = c0.x - c1.x, dy = c0.y - c1.y;
  const d = Math.hypot(dx, dy);
  if (!(d <= 2.0)) {
    console.error('FAILED: reticle disparity too large (dx=' + dx.toFixed(3) +
                  ' dy=' + dy.toFixed(3) + ' |d|=' + d.toFixed(3) + ' px)');
    failed = true;
  } else {
    console.log('PASS: zero disparity (layer0 @ ' + c0.x.toFixed(2) + ',' + c0.y.toFixed(2) +
                ' | layer1 @ ' + c1.x.toFixed(2) + ',' + c1.y.toFixed(2) +
                ' | delta=' + d.toFixed(3) + ' px)');
  }
}

await browser.close();
if (failed) { console.error('VR RETICLE TEST FAILED'); process.exit(1); }
console.log('VR RETICLE TEST PASSED');
