// CPU-profile capture for VR (single-pass multiview) vs flat rendering.
//
// Boots a free flight the same way scripts/detshot.mjs does, then (unless
// --novr) forces the engine into single-pass stereo the same way
// scripts/smoke-mv.mjs does (pokeEye both eyes with full-size viewports,
// then vr.forceMultiview) so the multiview render path is actually
// exercised while the profiler samples.  Captures a raw V8 CPU profile via
// the Chrome DevTools Protocol Profiler domain, and prints
// Module._YsfwGetTickMs() (the engine's own EMA of per-tick CPU ms, see
// src/port/fslazywindow/fslazywindow_emscripten.cpp) before and after the
// capture window as an independent cross-check.
//
// Usage:
//   node scripts/profile-vr.mjs <url> <out.cpuprofile> [--seconds N] [--novr]
//
// Feed <out.cpuprofile> to scripts/profile-report.mjs for a self-time
// breakdown.
import { chromium } from 'playwright';

const rawArgs = process.argv.slice(2);
const novr = rawArgs.includes('--novr');
const secondsIdx = rawArgs.indexOf('--seconds');
const seconds = secondsIdx !== -1 ? Number(rawArgs[secondsIdx + 1]) : 10;
const positional = rawArgs.filter((a, i) => a !== '--novr' && (secondsIdx === -1 || (i !== secondsIdx && i !== secondsIdx + 1)));
const [url, out] = positional;
if (!url || !out) {
  console.error('usage: node scripts/profile-vr.mjs <url> <out.cpuprofile> [--seconds N] [--novr]');
  process.exit(2);
}

const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=gl']
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

await page.goto(url);
await page.waitForFunction(() => !!globalThis.Module, null, { timeout: 90000 });

// A fresh profile shows the engine's "no joystick" dialog over the flight;
// click its 閉じる (fixed position at this viewport) until the flight starts.
{
  const t0 = Date.now();
  let inFlight = false;
  while (Date.now() - t0 < 90000) {
    inFlight = await page.evaluate(() => globalThis.ysfwInFlight === true).catch(() => false);
    if (inFlight) break;
    await page.mouse.click(61, 169).catch(() => {});
    await page.waitForTimeout(1500);
  }
  if (!inFlight) {
    console.error('FATAL: never reached flight (bad aircraft id in ?freeflight=?)');
    await browser.close();
    process.exit(1);
  }
}

// Release the pre-Space hold, then let the flight settle to steady state.
await page.keyboard.press('Space');
await page.waitForTimeout(3000);

if (!novr) {
  // Force single-pass stereo (OVR_multiview2) the same way scripts/smoke-mv.mjs
  // does: pokeEye both eyes with full-size viewports, then forceMultiview.
  const W = page.viewportSize().width, H = page.viewportSize().height;
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
    console.error('FATAL: failed to force multiview mode: ' + forced);
    await browser.close();
    process.exit(1);
  }
  await page.waitForTimeout(2000); // let multiview engage before sampling
}

const tickMsBefore = await page.evaluate(() => globalThis.Module._YsfwGetTickMs());

const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
await cdp.send('Profiler.start');
await page.waitForTimeout(seconds * 1000);
const { profile } = await cdp.send('Profiler.stop');

const tickMsAfter = await page.evaluate(() => globalThis.Module._YsfwGetTickMs());

const fs = await import('node:fs');
fs.writeFileSync(out, JSON.stringify(profile));

console.log(JSON.stringify({ mode: novr ? 'flat' : 'vr-multiview', tickMsBefore: +tickMsBefore.toFixed(2), tickMsAfter: +tickMsAfter.toFixed(2), seconds, out }));

await browser.close();
