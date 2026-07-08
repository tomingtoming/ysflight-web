// Deterministic-scene luminance gate: boots a free flight, reaches a static
// scene, hides the DOM shell, screenshots the canvas and prints region
// luminance (sky / ground / full) to 0.1 precision.  The same build renders
// the same numbers run-to-run, so an A/B against a main-build server catches
// renderer regressions (e.g. the WebGL2 shadow darkening) mechanically —
// no eyeballing.
//
// Usage:
//   node scripts/detshot.mjs <url> <out.png> [--settle]
//
//   default   stay in the pre-Space "CENTER JOYSTICK" hold.  NOTE: this scene
//             is the joystick-calibration visual (stick model on a blue
//             backdrop) — deterministic, but it does NOT exercise terrain or
//             the shadow map.
//   --settle  press Space and let the aircraft sit for 6s.  Use a GROUND
//             start so the scene is static; terrain, buildings and the
//             shadow map are all exercised.  The sky region varies with
//             drifting clouds; the ground region is deterministic.
//
// The aircraft in ?freeflight= must be a real engine identifier
// (F-15C_EAGLE — a bare "EAGLE" silently fails to spawn: AddAirplane returns
// NULL, the engine falls back to the main menu and the run times out).
//
// Reference invocations (against `node scripts/serve.mjs 8931 dist`):
//   hold  : ?freeflight=F-15C_EAGLE                          -> sky/ground/full
//   settle: ?freeflight=F-15C_EAGLE,ATSUGI_AIRBASE,RW01_01   -> ground is the gate
// Gate: run against a main build and the candidate build; 'ground' (and for
// hold, all three) must match to 0.1.
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const settle = args.includes('--settle');
const [url, shot] = args.filter(a => a !== '--settle');
if (!url || !shot) { console.error('usage: node scripts/detshot.mjs <url> <out.png> [--settle]'); process.exit(2); }
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=gl'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
// The engine uses preserveDrawingBuffer:false; force it on so canvas readback works.
await page.addInitScript(() => { const o = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, a) { if (/webgl/.test(t)) { a = Object.assign({}, a, { preserveDrawingBuffer: true }); } return o.call(this, t, a); }; });
await page.goto(url);
await page.waitForFunction(() => !!globalThis.Module, null, { timeout: 90000 });
// A fresh profile shows the engine's "no joystick" dialog over the flight;
// click its 閉じる (fixed position at this viewport) until the flight starts.
const t0 = Date.now(); let inFlight = false;
while (Date.now() - t0 < 90000) {
  inFlight = await page.evaluate(() => globalThis.ysfwInFlight === true).catch(() => false);
  if (inFlight) break;
  await page.mouse.click(61, 169).catch(() => {});
  await page.waitForTimeout(1500);
}
if (!inFlight) { console.error('FATAL: never reached flight (bad aircraft id in ?freeflight=?)'); await page.screenshot({ path: shot }); process.exit(1); }
if (settle) {
  await page.waitForTimeout(1500);
  await page.keyboard.press('Space');  // release the hold; parked aircraft stays put
  await page.waitForTimeout(6000);
} else {
  await page.waitForTimeout(3500);     // stay in the static hold
}
await page.evaluate(() => { document.querySelectorAll('body > div').forEach(d => { if (d.id !== 'canvas' && !(d.contains && d.contains(globalThis.Module.canvas))) d.style.display = 'none'; }); });
await page.waitForTimeout(300);
const r = await page.evaluate(() => {
  const s = globalThis.Module.canvas, c = document.createElement('canvas'); c.width = s.width; c.height = s.height;
  const x = c.getContext('2d'); x.drawImage(s, 0, 0);
  const L = (x0, y0, w, h) => { const d = x.getImageData(x0, y0, w, h).data; let sum = 0; for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; return sum / (d.length / 4); };
  return { sky: +L(0, 0, c.width, 180).toFixed(1), ground: +L(0, c.height - 180, c.width, 180).toFixed(1), full: +L(0, 0, c.width, c.height).toFixed(1) };
});
await page.screenshot({ path: shot });
console.log(JSON.stringify(r));
await browser.close();
