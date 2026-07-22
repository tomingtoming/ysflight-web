// Controls smoke test: proves the web Controller Setup page's choices reach
// the engine's ctlassign.cfg (web-shell increment 13).
//
//   studio-controls.html: "Apply gamepad defaults" writes the model to
//                         localStorage (works with no physical pad — the
//                         capture flow needs one, the preset does not);
//                         the elevator dead-zone slider is driven too.
//   index.html:           preRun merges the model into ctlassign.cfg
//                         (controls.js mergeCtlAssign) before main().
//
// Asserts the engine-side file carries the pad lines AND the full default
// keyboard map (the file replaces ALL bindings once it exists, so a partial
// file would silently kill the keyboard — the exact regression this guards).
//
//   node scripts/smoke-controls.mjs <index-url> [waitMs]
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:8923/index.html';
const waitMs = parseInt(process.argv[3] || '90000', 10);
const ctlUrl = new URL(base);
ctlUrl.pathname = ctlUrl.pathname.replace(/index\.html$/, 'studio-controls.html');

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const logs = [];
const fatal = [];
const FATAL = [/Aborted\(/, /RuntimeError/, /\[controls\]/];
page.on('console', (m) => { const t = m.text(); logs.push(t); if (FATAL.some((re) => re.test(t))) fatal.push('[console] ' + t); });
page.on('pageerror', (e) => fatal.push('[pageerror] ' + e.message));

function die(msg) {
  console.error('SMOKE-CONTROLS FAILED: ' + msg);
  for (const f of fatal.slice(0, 20)) console.error('  ' + f);
  console.error('--- last console lines ---');
  for (const l of logs.slice(-25)) console.error('  ' + l);
  process.exit(1);
}

// ---- Controls page: apply the gamepad preset + max the elevator dead zone ---
await page.goto(ctlUrl.toString());
await page.waitForFunction(() => window.ysfwControlsReady === true, { timeout: 30000 }).catch(() => die('Controls page never became ready'));
await page.locator('#ysfw-ctl-preset').click();
await page.locator('#ysfw-ctl-dz-elv').focus();
await page.keyboard.press('End');   // slider max = 0.2
const stored = await page.evaluate(() => localStorage.getItem('ysfwControls'));
if (!stored || !/"func":"THROTTLEUPDOWN","rev":true/.test(stored)) die('preset did not persist the reversed rate-throttle axis (' + stored + ')');
if (!/"elv":0\.2/.test(stored)) die('dead-zone slider did not persist elv:0.2 (' + stored + ')');

// ---- index.html: boot a freeflight; ctlassign.cfg must carry it all ---------
const flyUrl = new URL(base);
flyUrl.searchParams.set('freeflight', 'F-15J_EAGLE,SMALL_MAP,RW36_01');
await page.goto(flyUrl.toString());
await page.waitForFunction(() => globalThis.ysfwInFlight === true, { timeout: waitMs }).catch(() => die('freeflight never reached in-flight'));

const cfg = await page.evaluate(() => {
  try { return Module.FS.readFile('/home/web_user/Documents/YSFLIGHT.COM/YSFLIGHT/config/ctlassign.cfg', { encoding: 'utf8' }); }
  catch (e) { return '<<no ctlassign.cfg: ' + e.message + '>>'; }
});
// Web pad bindings (the SetDefaultGamePad-shaped preset on pad 0).
if (!/AXS 0 3 THROTTLEUPDOWN REV/.test(cfg)) die('ctlassign.cfg lacks the reversed rate throttle:\n' + cfg);
if (!/TRG 0 7 AUTOTRIM/.test(cfg)) die('ctlassign.cfg lacks the preset button map:\n' + cfg);
// Dead zone from the slider.
if (!/DZELV2 0\.200/.test(cfg)) die('ctlassign.cfg lacks DZELV2 0.200:\n' + cfg);
// The keyboard map MUST survive (partial file would wipe it).
for (const key of [/KEY SPACE FIREWEAPON/, /KEY G LANDINGGEAR/, /KEY F1 COCKPITVIEW/, /AXS M 0 TURRETHDG/]) {
  if (!key.test(cfg)) die('ctlassign.cfg lost a default binding ' + key + ':\n' + cfg);
}
if (!/\nEND/.test(cfg)) die('ctlassign.cfg has no END terminator:\n' + cfg);
if (fatal.length) die('fatal console/page errors');

await browser.close();
console.log('SMOKE-CONTROLS PASSED (Controls page -> ctlassign.cfg: pad preset + DZELV2 0.200, keyboard map preserved)');
