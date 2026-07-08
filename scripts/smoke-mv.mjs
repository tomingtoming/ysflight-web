// Single-pass stereo (OVR_multiview2) test without a headset.
//
// Boots into a free flight, then switches the engine into VR+multiview mode
// through the glue's test hooks: the shared renderers are recompiled with the
// per-view projection array, and the scene is rendered ONCE per frame into a
// two-layer texture-array framebuffer (fsvr.h / fswebxr.cpp).  Reads back
// both layers: each must be lit, and they must differ (the per-view
// projection folds in the eye offset), proving gl_ViewID_OVR routing.
//
// Pass criteria: no fatal GL/abort console output, layer luminance >= 5 on
// both layers, mean per-pixel layer difference >= 0.5.
//
//   node scripts/smoke-mv.mjs [url] [outDir]
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8923/index.html?freeflight=F-15C_EAGLE';
const outDir = process.argv[3] || '.';

const FATAL_PATTERNS = [
  /Link Status 0/, /Compile Status 0/, /declared as type/, /Error Message: error/,
  /Aborted\(/, /Failed to create WebGL context/, /Feedback loop/,
  /invalid internalformat/, /INVALID_ENUM/, /does not match uniform method/,
  /GL_INVALID/, /RuntimeError/
];

const browser = await chromium.launch({
  executablePath: process.env.YSFW_CHROMIUM || undefined,
  headless: true,
  // Native-GL ANGLE: SwiftShader takes the WebGL1 fallback (no multiview).
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
    await page.screenshot({ path: outDir + '/mv-test-0-stuck.png' });
    console.error('FAILED: flight never started');
    await browser.close();
    process.exit(1);
  }
}
await page.keyboard.press('Space');
await page.waitForTimeout(1000);
await page.keyboard.press('Space');
await page.waitForTimeout(3000);

// Enter multiview mode with synthetic eye data.  Both eyes use the SAME
// full-size viewport (texture-array layers), an identity view with a +-IPD/2
// x-translation, and eye 1 additionally yawed ~5deg so the layers differ by
// more than the small IPD parallax.
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
    layer0: vr.readMultiviewStats(0),
    layer1: vr.readMultiviewStats(1),
    diff: vr.diffMultiviewLayers()
  };
});
console.log('multiview analysis:', JSON.stringify(stats));
await page.screenshot({ path: outDir + '/mv-test-1-during.png' });

let failed = false;
if (fatal.length) {
  console.error('FATAL console output:'); fatal.forEach((f) => console.error('  ' + f));
  failed = true;
}
if (!(stats.layer0.lum >= 5 && stats.layer1.lum >= 5)) {
  console.error('FAILED: a layer is unlit (layer0=' + stats.layer0.lum + ' layer1=' + stats.layer1.lum + ')');
  failed = true;
}
if (!(stats.diff.meanDiff >= 0.5)) {
  console.error('FAILED: layers do not differ (meanDiff=' + stats.diff.meanDiff + ')');
  failed = true;
}
await browser.close();
if (failed) { console.error('MULTIVIEW TEST FAILED'); process.exit(1); }
console.log('MULTIVIEW TEST PASSED');
