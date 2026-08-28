// Real-shape VR controller model smoke test (no headset).
//
// Boots into a free flight, forces multiview mode (same path as
// scripts/smoke-mv.mjs), then drives the REAL hand write path
// (vr.pokeControllerFrame -> writeHandPoseBlock + tracked flags [9]/[10])
// with two ungrabbed hands parked right in front of the viewer.  The engine
// must draw misc/vrctl_right.dnm / vrctl_left.dnm there (fssimulation's
// ungrabbed-hand block), which this script detects as a luminance shift on
// both multiview layers -- two dark ~12cm models at 0.3m cover a large part
// of a 90deg-FOV frame.  Clearing the poke (empty hand list) must drop the
// tracked flags and remove the models again: that A/B/A is the gate that
// distinguishes "model drawn" from "scene happened to change".
//
// Pass criteria: tracked flags follow the pokes (white-box), the ON frame
// differs from both OFF frames on BOTH layers (render), no fatal GL output.
//
// DEGRADED MODE: on a runner whose headless GL exposes no OVR_multiview2
// (GitHub Actions with --use-angle=gl -- the same reason smoke-mv.mjs is not
// in CI), forceMultiview fails and the render gates are SKIPPED; the
// tracked-flag white-box (the web-side logic this PR adds) still runs and
// still gates.  The full render check needs a real-GPU environment
// (locally: swap in --use-angle=vulkan, see the ops notes).
//
//   node scripts/smoke-vrctlmodel.mjs [url] [outDir]
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
    await page.screenshot({ path: outDir + '/vrctlmodel-0-stuck.png' });
    console.error('FAILED: flight never started');
    await browser.close();
    process.exit(1);
  }
}
await page.keyboard.press('Space');
await page.waitForTimeout(1000);
await page.keyboard.press('Space');
await page.waitForTimeout(3000);

const W = 512, H = 512;
const forced = await page.evaluate(([W, H]) => {
  const M = globalThis.Module;
  const vr = M && M.ysfwVr;
  if (!vr || !vr.pokeEye || !vr.forceMultiview || !vr.pokeControllerFrame) return 'hooks-missing';
  vr.pokeEye(0, [1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, +0.032, 0, 0, 1, 0, 0, W, H]);
  vr.pokeEye(1, [1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -0.032, 0, 0, 1, 0, 0, W, H]);
  return vr.forceMultiview(W, H);
}, [W, H]);
if (forced === 'hooks-missing') {
  console.error('FAILED: test hooks missing (pokeEye/forceMultiview/pokeControllerFrame)');
  await browser.close();
  process.exit(1);
}
const mvOk = (forced === 'ok');
if (!mvOk) {
  console.log('SKIP render gates: forceMultiview said "' + forced + '" -- white-box flags only');
}
await page.waitForTimeout(2000);

// Both hands ungrabbed (squeeze 0), dead ahead and slightly below the view
// centre.  The viewer pose is identity here, so grip == viewer space.
const HANDS = [
  { hand: 'right', pos: [0.06, -0.05, -0.22], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: {} },
  { hand: 'left', pos: [-0.06, -0.05, -0.22], quat: [0, 0, 0, 1], squeeze: 0, trigger: 0, buttons: {} },
];

async function sampleLum(label) {
  // Average a few frames: the parked scene is near-static, this just smooths
  // dithering and the engine's own animation remainder.
  const s = { l0: 0, l1: 0, n: 0 };
  for (let i = 0; i < 3; ++i) {
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      const vr = globalThis.Module.ysfwVr;
      return { l0: vr.readMultiviewStats(0).lum, l1: vr.readMultiviewStats(1).lum };
    });
    s.l0 += r.l0; s.l1 += r.l1; s.n++;
  }
  s.l0 /= s.n; s.l1 /= s.n;
  console.log(label + ': layer0=' + s.l0.toFixed(2) + ' layer1=' + s.l1.toFixed(2));
  return s;
}

const base = mvOk ? await sampleLum('baseline (no hands)') : null;

const flagsOn = await page.evaluate((hands) => {
  const vr = globalThis.Module.ysfwVr;
  vr.pokeControllerFrame(hands);
  const cb = vr.readControlBlock();
  return { right: cb[9], left: cb[10], stickGrabbed: cb[0], throttleGrabbed: cb[4] };
}, HANDS);
const on = mvOk ? await sampleLum('hands tracked (models expected)') : null;
if (mvOk) await page.screenshot({ path: outDir + '/vrctlmodel-1-on.png' });

const flagsOff = await page.evaluate(() => {
  const vr = globalThis.Module.ysfwVr;
  vr.pokeControllerFrame([]);
  const cb = vr.readControlBlock();
  return { right: cb[9], left: cb[10] };
}, []);
const off = mvOk ? await sampleLum('hands cleared') : null;

let failed = false;
function check(name, ok, detail) {
  if (!ok) { console.error('FAILED: ' + name + (detail ? ' (' + detail + ')' : '')); failed = true; }
  else console.log('ok: ' + name);
}
check('tracked flags rise with the poked hands ([9]/[10])',
  1 === flagsOn.right && 1 === flagsOn.left, JSON.stringify(flagsOn));
check('poked hands are ungrabbed (the path under test)',
  0 === flagsOn.stickGrabbed && 0 === flagsOn.throttleGrabbed, JSON.stringify(flagsOn));
check('tracked flags drop on an empty frame',
  0 === flagsOff.right && 0 === flagsOff.left, JSON.stringify(flagsOff));
if (mvOk) {
  // The clear-side gate is RELATIVE to the measured on-side shift: the
  // absolute shift depends on scene content under the models (runway vs sky
  // vs panel), but removing them must undo most of whatever appearing did.
  // A fixed absolute threshold here was measured flaky-by-margin on first
  // run (on=1.95/1.77, off=1.59/1.41 against a 1.5 cutoff).
  const dOn0 = Math.abs(on.l0 - base.l0), dOn1 = Math.abs(on.l1 - base.l1);
  const dOff0 = Math.abs(off.l0 - on.l0), dOff1 = Math.abs(off.l1 - on.l1);
  check('models change both layers when tracked',
    dOn0 >= 1.0 && dOn1 >= 1.0, 'd0=' + dOn0.toFixed(2) + ' d1=' + dOn1.toFixed(2));
  check('models leave both layers when cleared',
    dOff0 >= 0.5 * dOn0 && dOff1 >= 0.5 * dOn1,
    'off d0=' + dOff0.toFixed(2) + '/' + dOff1.toFixed(2) + ' vs on d0=' + dOn0.toFixed(2) + '/' + dOn1.toFixed(2));
}
if (fatal.length) {
  console.error('FATAL console output:'); fatal.forEach((f) => console.error('  ' + f));
  failed = true;
}
await browser.close();
if (failed) { console.error('VRCTL MODEL TEST FAILED'); process.exit(1); }
console.log(mvOk ? 'VRCTL MODEL TEST PASSED' : 'VRCTL MODEL TEST PASSED (white-box only, no multiview here)');
