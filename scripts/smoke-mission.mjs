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

console.log('endurance leg passed (in-flight + Esc handover)');
// The handover navigated page1 to the TOP page, which boots ANOTHER engine
// (held at the pack panel).  Close it so the intercept leg doesn't share the
// software GPU with a second instance.
await page.close();

// ---- Intercept leg: ?intercept= must also reach in-flight untouched ---------
// Lighter check than the endurance leg (no Esc loop): the deep link resolves,
// the mission sets up (needs the fork's i-relative -intercept index fix), and
// the engine takes off with zero interaction.
const page2 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page2.on('console', (m) => {
  const t = m.text();
  logs.push(t);
  if (FATAL.some((re) => re.test(t))) fatal.push('[console2] ' + t);
});
page2.on('pageerror', (e) => fatal.push('[pageerror2] ' + e.message));
await page2.goto(base + '?intercept=F-15J_EAGLE,SMALL_MAP,0,0,1,1,1,0');
// Intercept sets a victory condition, so the engine shows a "== Your Mission =="
// briefing on the flight screen before takeoff (an in-flight dialog we keep on
// the engine side, like endurance's CONTINUE?).  Reaching the briefing at all
// already proves the fork's -intercept arg-index fix (a broken parse spawns the
// wrong mission or none).  Dismiss it via its OK button (top-left; the dialog
// does not respond to Enter) and confirm takeoff follows.
await page2.waitForTimeout(8000);
await page2.mouse.click(20, 57);
await page2
  .waitForFunction(() => globalThis.ysfwInFlight === true, { timeout: 30000 })
  .catch(() => die('intercept deep link did not reach in-flight after the mission briefing'));
if (fatal.length) die('fatal console/page errors during the intercept leg');
await page2.close();

// ---- Landing-practice leg: ?landing= boots the fork's -landingpractice ------
// (web-shell increment 10).  The engine sets up the approach and shows the
// traffic-pattern info screen (YSRUNMODE_SHOWLANDINGPRACTICEINFO); Space
// dismisses it (FsShowLandingPracticeInfo::RunOneStep) and the engine takes
// off onto the approach.  Reaching in-flight proves the whole chain: URL ->
// -landingpractice -> level table -> SetUpLandingPracticeMode (field+ILS
// resolve) -> info screen -> takeoff.
const page3 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page3.on('console', (m) => {
  const t = m.text();
  logs.push(t);
  if (FATAL.some((re) => re.test(t))) fatal.push('[console3] ' + t);
});
page3.on('pageerror', (e) => fatal.push('[pageerror3] ' + e.message));
await page3.goto(base + '?landing=1');
{
  // The info screen has no JS-visible flag; boot, then keep tapping Space
  // until the engine reports in-flight (each tap is harmless pre-boot, and
  // dismisses the info screen once it is up).
  const t0 = Date.now();
  let flying = false;
  while (Date.now() - t0 < 90000) {
    await page3.keyboard.press('Space');
    await page3.waitForTimeout(1000);
    if (await page3.evaluate(() => globalThis.ysfwInFlight === true)) { flying = true; break; }
  }
  if (!flying) die('landing practice never reached in-flight (?landing=1 -> -landingpractice)');
}
if (fatal.length) die('fatal console/page errors during the landing leg');
await page3.close();

// ---- Auto-demo leg: ?demo=1 boots the kiosk demo loop (-demoforever) --------
// (web-shell increment 11).  No in-flight flag to wait on (FLY_DEMOMODE is not
// an in-flight run mode) and the loop never exits by design — assert the boot
// itself: no pack panel, engine boots (overlay hidden), and it survives a few
// seconds without fatals.
const page4 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page4.on('console', (m) => {
  const t = m.text();
  logs.push(t);
  if (FATAL.some((re) => re.test(t))) fatal.push('[console4] ' + t);
});
page4.on('pageerror', (e) => fatal.push('[pageerror4] ' + e.message));
await page4.goto(base + '?demo=1');
await page4.waitForTimeout(3000);
if (await page4.evaluate(() => !!document.getElementById('ysfw-pack-panel'))) {
  die('pack panel appeared on a ?demo=1 deep link (should boot straight in)');
}
await page4
  .waitForFunction(() => { const ov = document.getElementById('overlay'); return ov && ov.classList.contains('hidden'); }, { timeout: 90000 })
  .catch(() => die('auto demo never booted (overlay still visible)'));
await page4.waitForTimeout(6000);
if (fatal.length) die('fatal console/page errors during the demo leg');

await browser.close();
console.log('SMOKE-MISSION PASSED (endurance: in-flight + Esc handover; intercept: in-flight; landing practice: in-flight; auto demo: boots + stable)');
