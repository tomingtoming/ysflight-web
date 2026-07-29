// Host deep-link smoke test: proves ?host=1&name= boots the engine STRAIGHT
// into multiplayer server mode — the web-shell entry contract for hosting
// (web/deeplink.js -> -server -> fsmain.cpp EXEMODE_SERVER ->
// StartNetServerMode), and that the web port's yssocket layer then claims the
// signaling room (?room= pins the code so we can assert it) against a local
// sig-stub.
//
// The engine reports server mode through globalThis.ysfwInFlight (the fork's
// ChangeRunMode counts YSRUNMODE_FLY_SERVERMODE as in-flight) and the room
// claim through globalThis.ysfwRtc.host.ok (host-ok received from the hub).
//
//   node scripts/smoke-host.mjs <index-url> <ws-signal-url> [waitMs]
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:8927/index.html';
const sigUrl = process.argv[3] || 'ws://localhost:8928/signal';
const waitMs = parseInt(process.argv[4] || '90000', 10);

const ROOM = '87654321'; // pinned via ?room= so the claim is assertable
const url = base + '?host=1&name=SmokeHost&room=' + ROOM +
  '&signal=' + encodeURIComponent(sigUrl);

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
  console.error('SMOKE-HOST FAILED: ' + msg);
  for (const f of fatal.slice(0, 20)) console.error('  ' + f);
  console.error('--- last console lines ---');
  for (const l of logs.slice(-25)) console.error('  ' + l);
  process.exit(1);
}

await page.goto(url);

// A host deep link is a direct boot: no pack panel, no join/host forms.
await page.waitForTimeout(3000);
const extras = await page.evaluate(() => ({
  panel: !!document.getElementById('ysfw-pack-panel'),
  hostForm: !!document.getElementById('ysfw-host-form'),
}));
if (extras.panel) die('pack panel appeared on a ?host= deep link (should boot straight in)');
if (extras.hostForm) die('host form rendered on a ?host= deep link (already decided)');

// The engine must end up in server mode with no interaction at all.
await page
  .waitForFunction(() => globalThis.ysfwInFlight === true, { timeout: waitMs })
  .catch(() => die('engine never reached server mode (ysfwInFlight) within ' + waitMs + 'ms'));

// ...and the yssocket host must claim the pinned room against the sig-stub.
await page
  .waitForFunction(() => {
    const R = globalThis.ysfwRtc;
    return !!(R && R.host && R.host.ok === true && !R.host.failed);
  }, { timeout: 30000 })
  .catch(() => die('yssocket host never claimed the signaling room (ysfwRtc.host.ok)'));
const room = await page.evaluate(() => globalThis.ysfwRtc.host.room);
if (room !== ROOM) die('host claimed room "' + room + '" instead of the ?room=-pinned "' + ROOM + '"');

// Stability: -autoexit rides along on host boots (quitting the session should
// hand back to the shell) — make sure it does NOT misfire while hosting: the
// page must still be on the deep link, in flight, a few seconds later.
await page.waitForTimeout(5000);
const still = await page.evaluate(() => ({
  inFlight: globalThis.ysfwInFlight === true,
  onDeepLink: !!new URLSearchParams(location.search).get('host'),
}));
if (!still.inFlight) die('server mode ended by itself (-autoexit misfire?)');
if (!still.onDeepLink) die('shell navigated away while hosting (-autoexit misfire?)');

if (fatal.length) die('fatal console/page errors while hosting');

await browser.close();
console.log('SMOKE-HOST PASSED (server mode reached, room ' + ROOM + ' claimed, no autoexit misfire)');
