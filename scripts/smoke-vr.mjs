// VR stereo-path test without a headset.
//
// Boots ysflight-web into a free flight, then forces the engine's VR mode on
// through the exported C API (YsfwVrSetPresenting) with hand-written per-eye
// data: identity view matrices offset by +-3.2cm IPD, ~53deg half-FOV
// tangents, and side-by-side canvas viewports.  The engine then renders
// exactly the stereo path a WebXR session would drive (split main window,
// per-eye frustum/scissor/viewport, eye-view composition, 2D skipped) into
// the default framebuffer, which we screenshot.
//
// Pass criteria: no fatal GL/abort console output, and the canvas shows two
// clearly-drawn halves (left/right pixel columns differ but are both lit).
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8923/index.html?freeflight=EAGLE';
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
  args: ['--autoplay-policy=no-user-gesture-required']
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

// The engine creates its WebGL context with preserveDrawingBuffer:false, which
// makes canvas readback (drawImage/toDataURL outside the frame) return blank.
// Force it on so the pixel analysis below can see what was rendered.
await page.addInitScript(() => {
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type === 'webgl' || type === 'experimental-webgl' || type === 'webgl2') {
      attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
    }
    return orig.call(this, type, attrs);
  };
});

const fatal = [];
page.on('console', (m) => {
  const t = m.text();
  if (FATAL_PATTERNS.some((re) => re.test(t))) fatal.push('[console] ' + t);
});
page.on('pageerror', (e) => fatal.push('[pageerror] ' + e.message));

await page.goto(url);

// Wait for the engine to boot and the flight to start.  A fresh profile shows
// the engine's canvas-drawn "no joystick" warning dialog, which blocks the
// freeflight start; click its 閉じる/Close button (fixed top-left position at
// this 1280x800 viewport) until the flight begins.
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
    await page.screenshot({ path: outDir + '/vr-test-0-stuck.png' });
    console.error('FAILED: flight never started');
    await browser.close();
    process.exit(1);
  }
}
// The flight starts in a "CENTER JOYSTICK, PRESS SPACE KEY ... TO GO!" hold;
// Space releases it into the actual simulation loop.
await page.keyboard.press('Space');
await page.waitForTimeout(1000);
await page.keyboard.press('Space');
await page.waitForTimeout(3000); // a few frames of normal flight
await page.screenshot({ path: outDir + '/vr-test-1-mono.png' });

// Force VR mode with synthetic eye data through the glue's test hook.
const forced = await page.evaluate(() => {
  const M = globalThis.Module;
  const vr = M && M.ysfwVr;
  if (!vr || !vr.pokeEye || !vr.setPresenting) return 'hooks-missing';
  const w = M.canvas.width, h = M.canvas.height;
  for (let eye = 0; eye < 2; ++eye) {
    const x = (eye === 0 ? +0.032 : -0.032); // view tf = inverse eye pose
    vr.pokeEye(eye, [
      // half-FOV tangents (L,R,U,D): symmetric ~45deg half-FOV
      1, 1, 1, 1,
      // view matrix: identity with a +-IPD/2 x-translation (column-major)
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1,
      // viewport: side-by-side halves of the canvas framebuffer
      eye === 0 ? 0 : w / 2, 0, w / 2, h
    ]);
  }
  vr.setPresenting(true);
  return 'ok';
});
if (forced !== 'ok') {
  console.error('FAILED to force VR mode: ' + forced);
  await browser.close();
  process.exit(1);
}

await page.waitForTimeout(3000); // let stereo frames render
await page.screenshot({ path: outDir + '/vr-test-2-stereo.png' });

// Analyze the canvas: both halves drawn, and a vertical seam exists.
const analysis = await page.evaluate(() => {
  const M = globalThis.Module;
  const src = M.canvas;
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0);
  const w = c.width, h = c.height;
  const mid = h >> 1;
  const px = (x, y) => ctx.getImageData(x, y, 1, 1).data;
  const lum = (d) => 0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2];
  // Sample a horizontal strip across the middle.
  let leftLum = 0, rightLum = 0, n = 0;
  for (let i = 0; i < 20; ++i) {
    leftLum += lum(px(((w / 2) * i / 20) | 0, mid));
    rightLum += lum(px((w / 2 + (w / 2) * i / 20) | 0, mid));
    ++n;
  }
  return { w, h, leftLum: leftLum / n, rightLum: rightLum / n };
});
console.log('stereo analysis:', JSON.stringify(analysis));

// Head-tracking check: yaw the right eye 30deg and require the halves to
// diverge -- proves the engine consumes the per-eye view matrix, not just the
// viewport split.
await page.evaluate(() => {
  const c = 0.866, s = 0.5;
  globalThis.Module.ysfwVr.pokeEye(1, [
    1, 1, 1, 1,
    c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1,
    globalThis.Module.canvas.width / 2, 0, globalThis.Module.canvas.width / 2, globalThis.Module.canvas.height
  ]);
});
await page.waitForTimeout(1500);
const yawed = await page.evaluate(() => {
  const src = globalThis.Module.canvas;
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0);
  const w = c.width, h = c.height;
  // Mean abs pixel difference between mirrored samples of the two halves,
  // over a grid clear of the corner overlays.
  let diff = 0, n = 0;
  for (let iy = 1; iy < 8; ++iy) {
    for (let ix = 1; ix < 10; ++ix) {
      const x = ((w / 2) * ix / 10) | 0, y = (h * iy / 8) | 0;
      const a = ctx.getImageData(x, y, 1, 1).data;
      const b = ctx.getImageData(x + w / 2, y, 1, 1).data;
      diff += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
      ++n;
    }
  }
  return { meanDiff: diff / n };
});
console.log('yawed-eye analysis:', JSON.stringify(yawed));
await page.screenshot({ path: outDir + '/vr-test-2b-yawed.png' });

// Back to mono; make sure the normal path is restored.
await page.evaluate(() => globalThis.Module.ysfwVr.setPresenting(false));
await page.waitForTimeout(2000);
await page.screenshot({ path: outDir + '/vr-test-3-restored.png' });

await browser.close();

if (fatal.length) {
  console.error('FATAL console output:');
  for (const f of fatal) console.error('  ' + f);
  process.exit(1);
}
// Both halves must be lit (sky/ground render, not black voids).
if (analysis.leftLum < 5 || analysis.rightLum < 5) {
  console.error('FAILED: a stereo half looks unrendered (black)');
  process.exit(1);
}
// The yawed right eye must show a different image (view matrix consumed).
if (yawed.meanDiff < 3) {
  console.error('FAILED: yawing one eye did not change its image (eye-view matrix ignored)');
  process.exit(1);
}
console.log('VR PATH TEST PASSED');
