// Settings smoke test: proves the web Settings page's choices reach the engine.
//
//   studio-settings.html: toggle a curated flight.cfg option -> localStorage
//   index.html:           preRun merges localStorage settings into the engine's
//                         flight.cfg (settings.js mergeFlightCfg) before main()
//
// Verifies the merged flight.cfg on the engine's virtual FS reflects the choice
// AND that a non-managed line the engine would write is preserved.  Same origin
// across the two pages, so localStorage carries the setting.
//
//   node scripts/smoke-settings.mjs <index-url> [waitMs]
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:8923/index.html';
const waitMs = parseInt(process.argv[3] || '90000', 10);
const setUrl = new URL(base);
setUrl.pathname = setUrl.pathname.replace(/index\.html$/, 'studio-settings.html');

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const logs = [];
const fatal = [];
const FATAL = [/Aborted\(/, /RuntimeError/, /\[settings\]/];
page.on('console', (m) => { const t = m.text(); logs.push(t); if (FATAL.some((re) => re.test(t))) fatal.push('[console] ' + t); });
page.on('pageerror', (e) => fatal.push('[pageerror] ' + e.message));

function die(msg) {
  console.error('SMOKE-SETTINGS FAILED: ' + msg);
  for (const f of fatal.slice(0, 20)) console.error('  ' + f);
  console.error('--- last console lines ---');
  for (const l of logs.slice(-25)) console.error('  ' + l);
  process.exit(1);
}

// ---- Settings page: shadows OFF, visibility to min, airplane LOD to coarse --
await page.goto(setUrl.toString());
await page.waitForFunction(() => window.ysfwSettingsReady === true, { timeout: 30000 }).catch(() => die('Settings page never became ready'));
// Drive the real UI for each control type: checkbox click, slider keyboard
// (Home -> engine min 800m), select option (2 = Always Coarse).
await page.getByText(/Draw shadows|影を描画/).click();
await page.locator('input[type=range]').focus();
await page.keyboard.press('Home');
await page.locator('select').selectOption('2');
const stored = await page.evaluate(() => localStorage.getItem('ysfwSettings'));
if (!stored || !/"DRWSHADOW":false/.test(stored)) die('toggling shadows did not persist DRWSHADOW:false to localStorage (' + stored + ')');
if (!/"VISIBILIT":800/.test(stored)) die('slider Home did not persist VISIBILIT:800 to localStorage (' + stored + ')');
if (!/"AIRLVODTL":2/.test(stored)) die('selecting Always Coarse did not persist AIRLVODTL:2 to localStorage (' + stored + ')');

// ---- index.html: boot a freeflight; flight.cfg must carry DRWSHADOW FALSE ---
const flyUrl = new URL(base);
flyUrl.searchParams.set('freeflight', 'F-15J_EAGLE,SMALL_MAP,RW36_01');
await page.goto(flyUrl.toString());
await page.waitForFunction(() => globalThis.ysfwInFlight === true, { timeout: waitMs }).catch(() => die('freeflight never reached in-flight'));

const cfg = await page.evaluate(() => {
  try { return Module.FS.readFile('/home/web_user/Documents/YSFLIGHT.COM/YSFLIGHT/config/flight.cfg', { encoding: 'utf8' }); }
  catch (e) { return '<<no flight.cfg: ' + e.message + '>>'; }
});
if (!/DRWSHADOW FALSE/.test(cfg)) die('engine flight.cfg does not carry DRWSHADOW FALSE:\n' + cfg);
// Numeric + enum options must land in the engine's own save formats.
if (!/VISIBILIT 800\.00m/.test(cfg)) die('engine flight.cfg does not carry VISIBILIT 800.00m:\n' + cfg);
if (!/AIRLVODTL 2/.test(cfg)) die('engine flight.cfg does not carry AIRLVODTL 2:\n' + cfg);
// The deep-link JSWARNING seed is a non-managed line; it must survive the merge.
if (!/JSWARNING FALSE/.test(cfg)) die('the merge dropped the non-managed JSWARNING line:\n' + cfg);
if (fatal.length) die('fatal console/page errors');

await browser.close();
console.log('SMOKE-SETTINGS PASSED (Settings page -> flight.cfg DRWSHADOW FALSE + VISIBILIT 800.00m + AIRLVODTL 2, JSWARNING preserved)');
