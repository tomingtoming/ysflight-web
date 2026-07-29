// Create-Flight smoke test: proves the engine-less Create-Flight page authors a
// flight the engine then flies — the web-shell replacement for Sim > Create
// Flight (docs/web-shell.md), end to end in a real browser:
//
//   studio-flight.html: pick field, add an AI enemy, "Take off" -> writes a
//                       spec to sessionStorage, navigates to ?createflight=1
//   index.html:         preRun builds the .yfs from the spec (yfs.js) and boots
//                       it with -flyyfs; reaching in-flight proves the whole
//                       chain (spec -> .yfs -> FsWorld::Load -> takeoff)
//
//   node scripts/smoke-createflight.mjs <index-url> [waitMs]
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:8923/index.html';
const waitMs = parseInt(process.argv[3] || '90000', 10);
const flightUrl = new URL(base);
flightUrl.pathname = flightUrl.pathname.replace(/index\.html$/, 'studio-flight.html');

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const logs = [];
const fatal = [];
const FATAL = [/Aborted\(/, /RuntimeError/, /Cannot Load/, /Failed to create WebGL context/, /\[createflight\]/];
page.on('console', (m) => {
  const t = m.text();
  logs.push(t);
  if (FATAL.some((re) => re.test(t))) fatal.push('[console] ' + t);
});
page.on('pageerror', (e) => fatal.push('[pageerror] ' + e.message));

function die(msg) {
  console.error('SMOKE-CREATEFLIGHT FAILED: ' + msg);
  for (const f of fatal.slice(0, 20)) console.error('  ' + f);
  console.error('--- last console lines ---');
  for (const l of logs.slice(-25)) console.error('  ' + l);
  process.exit(1);
}

// ---- Create-Flight page: compose a player + one AI enemy, take off ----------
await page.goto(flightUrl.toString());
await page
  .waitForFunction(() => window.ysfwCreateFlightReady === true, { timeout: 30000 })
  .catch(() => die('Create-Flight page never became ready'));

// Add an AI aircraft row (the enemy), then take off.
await page.getByText(/Add enemy|敵機/).click();
await page.getByRole('button', { name: /Take off|離陸/ }).click();

// ---- index.html: the generated .yfs must boot straight into flight ----------
await page
  .waitForURL((u) => u.searchParams.get('createflight') === '1', { timeout: 15000 })
  .catch(() => die('Take off did not navigate to ?createflight=1'));
await page
  .waitForFunction(() => globalThis.ysfwInFlight === true, { timeout: waitMs })
  .catch(() => die('generated .yfs never reached in-flight (spec -> yfs -> -flyyfs)'));
if (fatal.length) die('fatal console/page errors during the create-flight boot');

await browser.close();
console.log('SMOKE-CREATEFLIGHT PASSED (Create-Flight page -> .yfs -> engine reached in-flight)');
