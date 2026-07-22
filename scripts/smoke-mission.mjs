// Mission deep-link smoke test: proves ?endurance= boots the engine STRAIGHT
// into an endurance-mission flight — the web-shell entry contract for
// missions (web/deeplink.js -> -endurance -> fsmain.cpp EXEMODE_ENDURANCE).
//
// The engine reports flight state through globalThis.ysfwInFlight (set by the
// fork's ChangeRunMode for the FLY_* run modes); reaching inFlight means the
// whole chain held: URL parsing, argv, template lookup, mission setup and
// takeoff, with no engine dialog in between.
//
//   node scripts/smoke-mission.mjs <index-url> [waitMs]
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:8923/index.html';
const waitMs = parseInt(process.argv[3] || '90000', 10);

// Bundled aircraft/field only; 0 wingmen + enemy level 1 keeps the sim load
// minimal for software-GPU CI runners.
const url = base + '?endurance=F-15J_EAGLE,SMALL_MAP,0,1,1';

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const logs = [];
const fatal = [];
const FATAL = [/Aborted\(/, /RuntimeError/, /Cannot Load/, /Failed to create WebGL context/];
page.on('console', (m) => {
  const t = m.text();
  logs.push(t);
  if (FATAL.some((re) => re.test(t))) fatal.push('[console] ' + t);
});
page.on('pageerror', (e) => fatal.push('[pageerror] ' + e.message));

function die(msg) {
  console.error('SMOKE-MISSION FAILED: ' + msg);
  for (const f of fatal.slice(0, 20)) console.error('  ' + f);
  console.error('--- last console lines ---');
  for (const l of logs.slice(-25)) console.error('  ' + l);
  process.exit(1);
}

await page.goto(url);

// A deep link must NOT show the pack panel — it boots straight in (index.html
// gates the panel on isDirectBoot).  Give the page a moment, then assert.
await page.waitForTimeout(3000);
const panelShown = await page.evaluate(() => !!document.getElementById('ysfw-pack-panel'));
if (panelShown) die('pack panel appeared on an ?endurance= deep link (should boot straight in)');

// The whole point: the engine ends up IN FLIGHT with no interaction at all.
await page
  .waitForFunction(() => globalThis.ysfwInFlight === true, { timeout: waitMs })
  .catch(() => die('engine never reached in-flight state (ysfwInFlight) within ' + waitMs + 'ms'));

if (fatal.length) die('fatal console/page errors during boot');

// Instant handover: deep links carry -autoexit, so ending the flight (Esc)
// terminates the engine, the port fires 'ysfw-terminated', and the shell
// navigates back to the clean top page — without ever presenting the engine
// menu.  Give the sim a moment to settle, dismiss the one-shot controls
// legend if it is up (it swallows clicks, not keys — closing is just hygiene),
// then press Esc and expect the URL to lose the ?endurance deep link.
await page.waitForTimeout(4000);
await page.evaluate(() => { try { window.__ysfwHelpToggle && window.__ysfwHelpToggle(false); } catch (e) {} });
// The flight opens behind the "CENTER JOYSTICK / PRESS SPACE TO GO" gate,
// which consumes the first key (Space, Esc, or trigger — fsrunloop.cpp:198).
// Release it with Space, then end the flight with TWO Esc presses
// (fssimulation.cpp escKeyCount>=2; the first shows the "press again" prompt).
await page.keyboard.press('Space');
await page.waitForTimeout(800);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await page.keyboard.press('Escape');
// Endurance then asks "CONTINUE FLIGHT?" (an engine dialog on the flight
// screen); 終了(ESC) declines it and returns to the menu — where -autoexit
// takes over.
await page.waitForTimeout(1200);
await page.keyboard.press('Escape');
await page
  .waitForURL((u) => !u.searchParams.get('endurance'), { timeout: 20000 })
  .catch(() => die('flight end did not hand back to the shell (still on the deep link URL)'));

await browser.close();
console.log('SMOKE-MISSION PASSED (endurance deep link reached in-flight; Esc handed back to the shell)');
