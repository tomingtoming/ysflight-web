// VR HUD-in-multiview test without a headset.
//
// Boots into a free flight and switches the engine into VR+multiview mode
// through the same test hook as smoke-mv.mjs (vr.forceMultiview).  That hook
// now also allocates the off-screen two-layer multiview HUD framebuffer + RGBA8
// texture array (fswebxr.cpp setupHud) and publishes them to the engine, which
// renders the primary flying HUD into that texture once per frame (both layers
// identical) and composites it onto a cockpit-anchored quad in the scene.
//
// Reads back:
//   - the HUD enable flag (must be 1 once multiview engages),
//   - both HUD texture-array layers (must have nonzero mean alpha AND nonzero
//     mean luminance -- proof the HUD text/lines actually drew, not just a
//     transparent clear), and that the two layers are identical-ish,
//   - the scene texture-array layers (must still be lit and still differ per
//     eye, i.e. the cockpit quad did not break the stereo scene render).
//
//   node scripts/smoke-vrhud.mjs [url] [outDir]
import { chromium } from 'playwright';

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
    await page.screenshot({ path: outDir + '/vrhud-test-0-stuck.png' });
    console.error('FAILED: flight never started');
    await browser.close();
    process.exit(1);
  }
}
await page.keyboard.press('Space');
await page.waitForTimeout(1000);
await page.keyboard.press('Space');
await page.waitForTimeout(3000);

// Enter multiview mode, same synthetic eye data as smoke-mv (full-size
// viewports on both eyes; eye 1 yawed ~5deg so the scene layers differ).
const W = 512, H = 512;
const forced = await page.evaluate(([W, H]) => {
  const M = globalThis.Module;
  const vr = M && M.ysfwVr;
  if (!vr || !vr.pokeEye || !vr.forceMultiview) return 'hooks-missing';
  const s = Math.sin(5 * Math.PI / 180), c = Math.cos(5 * Math.PI / 180);
  vr.pokeEye(0, [
    1, 1, 1, 1,
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, +0.032, 0, 0, 1,
    0, 0, W, H
  ]);
  vr.pokeEye(1, [
    1, 1, 1, 1,
    c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, -0.032, 0, 0, 1,
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

const stats = await page.evaluate(() => {
  const vr = globalThis.Module.ysfwVr;
  return {
    hudData: vr.readHudData(),
    hud0: vr.readHudLayerStats(0),
    hud1: vr.readHudLayerStats(1),
    scene0: vr.readMultiviewStats(0),
    scene1: vr.readMultiviewStats(1),
    sceneDiff: vr.diffMultiviewLayers()
  };
});
console.log('vrhud analysis:', JSON.stringify(stats));
await page.screenshot({ path: outDir + '/vrhud-test-1-during.png' });

let failed = false;
if (fatal.length) {
  console.error('FATAL console output:'); fatal.forEach((f) => console.error('  ' + f));
  failed = true;
}

// (a) HUD enable flag readable and set once multiview engaged.
if (!(stats.hudData && stats.hudData[0] === 1)) {
  console.error('FAILED: HUD enable flag not set (hudData=' + JSON.stringify(stats.hudData) + ')');
  failed = true;
} else {
  console.log('PASS: HUD enabled (fbo=' + stats.hudData[1] + ' texArray=' + stats.hudData[2] +
              ' ' + stats.hudData[3] + 'x' + stats.hudData[4] + ')');
}

// (b) both HUD layers have nonzero alpha AND nonzero luminance.
for (const [i, s] of [[0, stats.hud0], [1, stats.hud1]]) {
  if (!(s.alpha > 0.05 && s.lum > 0.05)) {
    console.error('FAILED: HUD layer ' + i + ' looks empty (alpha=' + s.alpha + ' lum=' + s.lum + ')');
    failed = true;
  } else {
    console.log('PASS: HUD layer ' + i + ' drawn (alpha=' + s.alpha.toFixed(3) + ' lum=' + s.lum.toFixed(3) + ')');
  }
}

// (c) the two HUD layers are identical-ish (same content drawn to both).
{
  const dLum = Math.abs(stats.hud0.lum - stats.hud1.lum);
  const dAlpha = Math.abs(stats.hud0.alpha - stats.hud1.alpha);
  if (!(dLum < 0.5 && dAlpha < 0.5)) {
    console.error('FAILED: HUD layers differ (dLum=' + dLum + ' dAlpha=' + dAlpha + ')');
    failed = true;
  } else {
    console.log('PASS: HUD layers identical-ish (dLum=' + dLum.toFixed(4) + ' dAlpha=' + dAlpha.toFixed(4) + ')');
  }
}

// (d) the scene layers are still lit and still differ per eye (quad composite
// did not break the stereo scene render, nor make the eyes identical).
if (!(stats.scene0.lum >= 5 && stats.scene1.lum >= 5)) {
  console.error('FAILED: a scene layer is unlit (scene0=' + stats.scene0.lum + ' scene1=' + stats.scene1.lum + ')');
  failed = true;
} else {
  console.log('PASS: scene layers lit (lum ' + stats.scene0.lum.toFixed(1) + ' / ' + stats.scene1.lum.toFixed(1) + ')');
}
if (!(stats.sceneDiff.meanDiff >= 0.5)) {
  console.error('FAILED: scene layers do not differ per eye (meanDiff=' + stats.sceneDiff.meanDiff + ')');
  failed = true;
} else {
  console.log('PASS: scene layers differ per eye (meanDiff=' + stats.sceneDiff.meanDiff.toFixed(3) + ')');
}

await browser.close();
if (failed) { console.error('VR HUD TEST FAILED'); process.exit(1); }
console.log('VR HUD TEST PASSED');
