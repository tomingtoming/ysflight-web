// Boot smoke test for ysflight-web across GPU/driver backends.
//
// Usage: node scripts/smoke-test.mjs <url> [backend] [waitMs]
//   backend: default | strict | vulkan | swiftshader | gl
//
// Loads the page, waits for the engine to boot, and fails on shader
// compile/link errors, aborts, or uncaught exceptions.
//
// "strict" runs the system Chrome HEADED on the native Mesa GL stack
// (--use-angle=gl).  Real Mesa drivers lower mediump to fp16 and reject
// cross-stage precision mismatches that software rasterizers (and even
// headless contexts) silently tolerate — run it locally before pushing
// renderer changes.  Needs a display and /usr/bin/google-chrome
// (override with SMOKE_CHROME).
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8901/index.html';
const backend = process.argv[3] || 'default';
const waitMs = parseInt(process.argv[4] || '70000', 10);

const BACKEND_FLAGS = {
  default: [],
  strict: ['--use-angle=gl'],
  vulkan: ['--use-angle=vulkan', '--enable-features=Vulkan'],
  swiftshader: ['--use-angle=swiftshader'],
  gl: ['--use-angle=gl']
};

const FATAL_PATTERNS = [
  /Link Status 0/,
  /Compile Status 0/,
  /declared as type/,          // precision/type mismatch between stages
  /Error Message: error/,
  /Aborted\(/,
  /Failed to create WebGL context/,
  /Feedback loop/,             // texture bound while being rendered to
  /invalid internalformat/,    // GL1-style internalformat (e.g. "4")
  /INVALID_ENUM/,              // desktop-only caps/enums on GLES2
  /does not match uniform method/  // glUniform type/size mismatch
];

const flags = BACKEND_FLAGS[backend];
if (!flags) {
  console.error(`unknown backend: ${backend}`);
  process.exit(2);
}

const isStrict = backend === 'strict';
const browser = await chromium.launch({
  executablePath: isStrict
    ? (process.env.SMOKE_CHROME || '/usr/bin/google-chrome')
    : (process.env.YSFW_CHROMIUM || undefined),
  headless: !isStrict,  // headed contexts expose the full driver feature set
  args: ['--autoplay-policy=no-user-gesture-required', ...flags]
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const fatal = [];
const check = (tag, t) => {
  if (FATAL_PATTERNS.some((re) => re.test(t))) fatal.push(`[${tag}] ` + t);
};
page.on('console', (m) => check('console', m.text()));
page.on('pageerror', (e) => fatal.push('[pageerror] ' + e.message));
// Driver-level messages ("[.WebGL-...] GL_INVALID_OPERATION: ...") do NOT
// surface through the console event; they only arrive via the CDP Log domain.
const cdp = await page.context().newCDPSession(page);
await cdp.send('Log.enable');
cdp.on('Log.entryAdded', (e) => check('driver', e.entry.text));

await page.goto(url);

// A pre-boot pack panel (packs-ui.js, milestone M2) now gates startup until the
// user presses "play".  Release it so this boot/GPU smoke proceeds; harmless on
// builds without the pack layer (we then just fall through to the auto-boot).
for (let i = 0; i < 60; i++) {
  const go = await page.evaluate(() => {
    if (window.ysfwPacks && window.ysfwPacks.fsReady) {
      window.ysfwPacks.start();
      return true;
    }
    const ov = document.getElementById('overlay');
    return !!(ov && ov.classList.contains('hidden'));
  });
  if (go) break;
  await page.waitForTimeout(500);
}

await page.waitForTimeout(waitMs);

// Dismiss the first-start dialog (button position differs per language) so
// the title demo runs unobstructed — several GL paths (e.g. shadow maps)
// only execute once the demo is actually being simulated and drawn.
await page.mouse.click(42, 263);
await page.mouse.click(61, 169);
await page.waitForTimeout(30000);

const renderer = await page.evaluate(() => {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch (e) { return 'unknown'; }
});
const booted = await page.evaluate(() => {
  const ov = document.getElementById('overlay');
  return !!ov && ov.classList.contains('hidden');
});
await browser.close();

console.log(`backend=${backend}`);
console.log(`renderer=${renderer}`);
console.log(`booted=${booted}`);
if (!booted) fatal.push('engine did not finish booting (loading overlay still visible)');
if (fatal.length) {
  console.error('SMOKE TEST FAILED:');
  for (const f of fatal.slice(0, 20)) console.error('  ' + f);
  process.exit(1);
}
console.log('SMOKE TEST PASSED');
