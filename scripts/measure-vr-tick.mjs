// Measure engine main-thread cost per tick (ms) in flight, mono and VR-forced.
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(process.argv[2]);
await page.waitForFunction(() => !!globalThis.Module, null, { timeout: 90000 });
for (let i = 0; i < 40; ++i) {
  if (await page.evaluate(() => globalThis.ysfwInFlight === true)) break;
  await page.mouse.click(61, 169);
  await page.waitForTimeout(2000);
}
await page.keyboard.press('Space');
await page.waitForTimeout(1000);
await page.keyboard.press('Space');
await page.waitForTimeout(8000); // settle
const mono = await page.evaluate(() => globalThis.Module._YsfwGetTickMs());
// Force VR (stereo) and measure again.
await page.evaluate(() => {
  const M = globalThis.Module, w = M.canvas.width, h = M.canvas.height;
  for (let eye = 0; eye < 2; ++eye) {
    M.ysfwVr.pokeEye(eye, [1,1,1,1, 1,0,0,0, 0,1,0,0, 0,0,1,0, (eye===0?0.032:-0.032),0,0,1, eye===0?0:w/2, 0, w/2, h]);
  }
  M.ysfwVr.setPresenting(true);
});
await page.waitForTimeout(8000);
const stereo = await page.evaluate(() => globalThis.Module._YsfwGetTickMs());
console.log(JSON.stringify({ monoTickMs: +mono.toFixed(2), stereoTickMs: +stereo.toFixed(2) }));
await browser.close();
