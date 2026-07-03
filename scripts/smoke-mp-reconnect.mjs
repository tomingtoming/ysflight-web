// Protocol smoke for the host-reconnect / room-reclaim signaling contract
// (worker/signal.js, mirrored by scripts/sig-stub.mjs).  Validates fix B without
// a browser or the wasm engine: a host whose socket drops can reconnect and
// RECLAIM its room with a matching token, the stale old-socket close does NOT
// clobber the reclaimed room, a wrong token against a LIVE host is rejected,
// and the host-loss GRACE window holds the room open:
//   - a join during the window is accepted (join-ok) and QUEUED,
//   - the reclaim flushes the queued {t:'peer'} to the returning host,
//   - a fresh-token host may take over a HOSTLESS room (page-reload case),
//   - only grace EXPIRY tears the room down (host-left, then no-room).
//
//   node scripts/smoke-mp-reconnect.mjs [ws://host/signal]
//
// With no URL it self-starts scripts/sig-stub.mjs (the Node mirror of the worker)
// with a short grace/keepalive so the expiry and keepalive assertions run fast;
// pass a URL to point it at a live hub instead (those two assertions are skipped:
// production grace is 90s).  Exits 0 if every assertion holds, 1 otherwise.
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SELF_PORT = 8939;
const URL = process.argv[2] || `ws://127.0.0.1:${SELF_PORT}/signal`;
const ownStub = !process.argv[2];
const GRACE_MS = 2500;       // stub-only; production default is 90s
const KEEPALIVE_MS = 700;    // stub-only; production default is 30s
let stub = null;
if (ownStub) {
  const here = dirname(fileURLToPath(import.meta.url));
  stub = spawn('node', [join(here, 'sig-stub.mjs'), String(SELF_PORT)], {
    stdio: 'ignore',
    env: { ...process.env, SIGNAL_GRACE_MS: String(GRACE_MS), SIGNAL_KEEPALIVE_MS: String(KEEPALIVE_MS) },
  });
  await new Promise((r) => setTimeout(r, 800));
}
const ROOM = '90000001';
const TOKEN = 'tok-reconnect-aaaa';

let failures = 0;
const ok = (cond, label) => { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) failures++; };

// Every socket gets a persistent inbox (attached at open) so back-to-back server
// messages (e.g. host-ok immediately followed by the flushed {t:'peer'}) are never
// lost between two one-shot listeners.  next() drains the inbox in order.
function open() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const t = setTimeout(() => reject(new Error('open timeout')), 4000);
    ws.inbox = [];
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (e) { m = {}; }
      if (m.t === 'ping') return;                       // keepalive noise
      ws.inbox.push(m);
    });
    ws.on('open', () => { clearTimeout(t); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}
// Resolve with the next buffered non-ping message, or {t:'<timeout>'} after ms (so
// an EXPECTED silence — e.g. a stale close that must NOT trigger anything — is
// testable).
async function next(ws, ms = 2500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (ws.inbox.length > 0) return ws.inbox.shift();
    await sleep(25);
  }
  return { t: '<timeout>' };
}
const send = (ws, o) => ws.send(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1) Initial host claim.
  const host1 = await open();
  send(host1, { t: 'host', room: ROOM, token: TOKEN });
  ok((await next(host1)).t === 'host-ok', '1. initial host -> host-ok');

  // 2) Reconnecting host reclaims the SAME room+token (was host-taken before the fix).
  const host2 = await open();
  send(host2, { t: 'host', room: ROOM, token: TOKEN });
  ok((await next(host2)).t === 'host-ok', '2. reconnect same token -> host-ok (reclaim)');

  // 3) The OLD socket's delayed close must NOT delete the reclaimed room.
  host1.close();
  await sleep(400);
  const joiner = await open();
  send(joiner, { t: 'join', room: ROOM });
  ok((await next(joiner)).t === 'join-ok', '3. stale old-socket close did NOT clobber room (join-ok)');
  joiner.close();
  await sleep(200);

  // 4) A different token while the host is LIVE is a genuine collision -> host-taken.
  const intruder = await open();
  send(intruder, { t: 'host', room: ROOM, token: 'wrong-token' });
  ok((await next(intruder)).t === 'host-taken', '4. wrong token vs live host -> host-taken');
  intruder.close();

  // 5) GRACE: the current host drops -> the room is held hostless, so a join
  //    during the window still gets join-ok (was no-room before the fix).
  host2.close();
  await sleep(300);
  const early = await open();
  send(early, { t: 'join', room: ROOM });
  ok((await next(early)).t === 'join-ok', '5. join during host-loss grace -> join-ok (queued)');

  // 6) The reclaiming host receives the QUEUED {t:'peer'} for that joiner.
  const host3 = await open();
  send(host3, { t: 'host', room: ROOM, token: TOKEN });
  ok((await next(host3)).t === 'host-ok', '6a. reclaim during grace -> host-ok');
  const flushed = await next(host3);
  ok(flushed.t === 'peer' && flushed.peer > 0, '6b. reclaim flushed the queued joiner as {t:peer}');

  // 7) Fresh-token TAKEOVER of a hostless room (host reloaded its page): allowed,
  //    and the dead host's already-connected peer is told host-left.
  host3.close();
  await sleep(300);
  const host4 = await open();
  send(host4, { t: 'host', room: ROOM, token: 'fresh-after-reload' });
  ok((await next(host4)).t === 'host-ok', '7a. fresh token vs HOSTLESS room -> host-ok (takeover)');
  ok((await next(early)).t === 'host-left', '7b. old host\'s peer got host-left on takeover');
  early.close();

  if (ownStub) {
    // 8) EXPIRY: no reclaim within grace -> the room dies; a later join sees no-room.
    host4.close();
    await sleep(GRACE_MS + 600);
    const late = await open();
    send(late, { t: 'join', room: ROOM });
    ok((await next(late)).t === 'no-room', '8. grace expired with no reclaim -> no-room');

    // 9) KEEPALIVE: the hub pings connected sockets on its own clock.
    const pinged = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), KEEPALIVE_MS * 3);
      late.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
        if (m.t === 'ping') { clearTimeout(t); resolve(true); }
      });
    });
    ok(pinged, '9. server-driven keepalive ping received');
    late.close();
  } else {
    console.log('SKIP 8./9. (grace-expiry & keepalive timing tests need the local stub; live grace is 90s)');
    host4.close();
  }
}

const cleanup = () => { if (stub) { try { stub.kill('SIGKILL'); } catch (e) {} } };
main().then(() => {
  cleanup();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}).catch((e) => { cleanup(); console.error('ERROR', e); process.exit(1); });
