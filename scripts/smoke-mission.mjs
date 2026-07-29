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

await browser.close();
console.log('SMOKE-MISSION PASSED (endurance deep link reached in-flight)');
