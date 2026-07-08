// Workbench smoke test: proves the loose-file assembly flow works end-to-end in
// a real browser against the actual wasm engine — drop-equivalent loose
// .dat/.dnm/.srf bytes -> assemble -> install through the normal pipeline ->
// reload with ?freeflight=<IDENTIFY> -> the ENGINE resolves the assembled
// aircraft to a loaded template ("Airplane:<name>" prints only on success; see
// smoke-pack.mjs for the negative control).
//
//   node scripts/smoke-workbench.mjs <url> [waitMs]
//
// The loose fixture is served as /test-pack.zip (the community fixture); the
// page unzips it and hands the test1 aircraft's raw files to the workbench as
// if they were dropped without any zip or .lst.
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8926/index.html';
const bootMs = parseInt(process.argv[3] || '90000', 10);

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const logs = [];
const fatal = [];
const FATAL = [/Aborted\(/, /RuntimeError/, /Cannot Load/];
page.on('console', (m) => {
  const t = m.text();
  logs.push(t);
  if (FATAL.some((re) => re.test(t))) fatal.push('[console] ' + t);
});
page.on('pageerror', (e) => fatal.push('[pageerror] ' + e.message));

function die(msg) {
  console.error('SMOKE-WORKBENCH FAILED: ' + msg);
  for (const f of fatal.slice(0, 20)) console.error('  ' + f);
  console.error('--- last console lines ---');
  for (const l of logs.slice(-25)) console.error('  ' + l);
  process.exit(1);
}

await page.goto(url);
await page
  .waitForFunction(() => window.ysfwPacks && window.ysfwPacks.fsReady === true, { timeout: 60000 })
  .catch(() => die('pack layer never became ready (window.ysfwPacks.fsReady)'));

// 1. Assemble + install from LOOSE bytes through the public workbench API (the
//    same function the UI's "Assemble & import" button calls).
const res = await page
  .evaluate(async () => {
    const { unzipSync } = await import('./vendor/fflate.js');
    const r = await fetch('/test-pack.zip');
    const z = unzipSync(new Uint8Array(await r.arrayBuffer()));
    const f = (p) => ({ name: p.split('/').pop(), bytes: z[p] });
    return await window.ysfwPacks.workbenchAssembleInstall({
      name: 'wbsmoke',
      dat: f('user/toming/test1.dat'),
      visual: f('user/toming/test1.dnm'),
      collision: f('user/toming/test1coll.srf'),
    });
  })
  .catch((e) => die('workbench assemble/install threw: ' + e.message));

console.log('assembled+installed: ' + JSON.stringify({ id: res.id, identify: res.identify, templates: res.templates }));
if (!res || !/^[0-9a-f]{16}$/.test(res.id)) die('install returned no valid pack id');
if (res.identify !== 'YSFW_TEST1') die('expected identify YSFW_TEST1, got ' + res.identify);
if (res.templates !== 1) die('expected 1 template, got ' + res.templates);
if ((res.warnings || []).length !== 0) die('unexpected warnings: ' + JSON.stringify(res.warnings));

// 2. The installed pack's identities are readable (what the test-fly button uses).
const ids = await page.evaluate((id) => window.ysfwPacks.aircraftIdentities(id), res.id);
if (JSON.stringify(ids) !== JSON.stringify(['YSFW_TEST1'])) {
  die('aircraftIdentities mismatch: ' + JSON.stringify(ids));
}

// 3. Reload straight into a flight with the assembled aircraft.  "Airplane:
//    YSFW_TEST1" prints ONLY when freeflight resolved it to a loaded template.
logs.length = 0;
fatal.length = 0;
const ff = new URL(url);
ff.searchParams.set('freeflight', 'YSFW_TEST1,ATSUGI_AIRBASE,NORTH3000');
await page.goto(ff.toString());
await page
  .waitForFunction(
    () => {
      const ov = document.getElementById('overlay');
      return ov && ov.classList.contains('hidden');
    },
    { timeout: bootMs },
  )
  .catch(() => die('engine did not boot on the freeflight reload'));
{
  const t0 = Date.now();
  let loaded = false;
  while (Date.now() - t0 < 30000) {
    if (logs.some((l) => /Airplane:\s*YSFW_TEST1/.test(l))) { loaded = true; break; }
    await page.waitForTimeout(250);
  }
  if (!loaded) die('engine never set up a flight with the assembled aircraft "YSFW_TEST1"');
}
if (fatal.length) die('fatal engine output while flying the assembled aircraft');

await browser.close();
console.log('workbench: assembled pack flew via ?freeflight (real engine)');
console.log('SMOKE-WORKBENCH PASSED');
