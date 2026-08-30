// Captures the README hero image: a free flight in an outside (chase) view,
// canvas only, with the DOM shell hidden.  Deterministic enough to re-shoot
// after a renderer change and diff the result by eye.
//
// Usage:
//   node scripts/serve.mjs 8931 dist &
//   node scripts/hero-shot.mjs http://127.0.0.1:8931/?freeflight=F-15C_EAGLE docs/hero.png
//
// The aircraft in ?freeflight= must be a real engine identifier (a bare
// "EAGLE" silently fails to spawn -- see scripts/detshot.mjs).  The default
// position NORTH10000_01 is an air start, so there is no takeoff to wait for.
import { chromium } from 'playwright';
const [url, shot] = process.argv.slice(2);
if (!url || !shot) { console.error('usage: node scripts/hero-shot.mjs <url> <out.png>'); process.exit(2); }

// --use-angle=gl falls back to SwiftShader on some hosts; vulkan keeps the
// real GPU so the clouds and shadow map look like they do for a player.
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=vulkan'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(() => { const o = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, a) { if (/webgl/.test(t)) { a = Object.assign({}, a, { preserveDrawingBuffer: true }); } return o.call(this, t, a); }; });
await page.goto(url);
await page.waitForFunction(() => !!globalThis.Module, null, { timeout: 90000 });

const t0 = Date.now(); let inFlight = false;
while (Date.now() - t0 < 90000) {
  inFlight = await page.evaluate(() => globalThis.ysfwInFlight === true).catch(() => false);
  if (inFlight) break;
  await page.mouse.click(61, 169).catch(() => {});   // engine "no joystick" dialog
  await page.waitForTimeout(1500);
}
if (!inFlight) { console.error('FATAL: never reached flight'); await browser.close(); process.exit(1); }

// The help overlay sits above the canvas for the first moments of a flight and
// would be captured with it (it is also what makes probes miss clicks).
await page.locator('#ysfw-help button').click({ timeout: 3000 }).catch(() => {});
await page.waitForTimeout(1500);
// ysfwInFlight goes true while the engine still holds on the "CENTER JOYSTICK"
// calibration screen (a stick model on a blue backdrop).  Space releases that
// gate; without it the shot is the calibration screen, not the world.
await page.keyboard.press('Space');
await page.waitForTimeout(2000);
await page.keyboard.press('F2');       // FSBTF_OUTSIDEPLAYERVIEW -- chase camera
await page.waitForTimeout(5000);       // let the aircraft cross some scenery
// Bank into a turn so the shot shows the wing planform and a tilted horizon
// instead of a level cruise.  Arrow-key holds do NOT deflect the stick here --
// with no joystick the engine reads the MOUSE as the stick (screen centre is
// neutral), so the input is a pointer parked left of centre.
const cx = 1600 / 2, cy = 900 / 2;
await page.mouse.move(cx, cy);
for (let i = 0; i < 11; ++i) { await page.mouse.move(cx - 90, cy - 30); await page.waitForTimeout(100); }
await page.mouse.move(cx, cy);
await page.waitForTimeout(600);

await page.evaluate(() => { document.querySelectorAll('body > div').forEach(d => { if (d.id !== 'canvas' && !(d.contains && d.contains(globalThis.Module.canvas))) d.style.display = 'none'; }); });
await page.waitForTimeout(400);
const b64 = await page.evaluate(() => {
  const s = globalThis.Module.canvas, c = document.createElement('canvas');
  c.width = s.width; c.height = s.height;
  c.getContext('2d').drawImage(s, 0, 0);
  return c.toDataURL('image/png').split(',')[1];
});
const { writeFileSync } = await import('node:fs');
writeFileSync(shot, Buffer.from(b64, 'base64'));
console.log('wrote', shot);
await browser.close();
