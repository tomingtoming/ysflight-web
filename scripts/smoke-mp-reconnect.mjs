// Protocol smoke for the host-reconnect / room-reclaim signaling contract
// (worker/signal.js, mirrored by scripts/sig-stub.mjs).  Validates fix B without
// a browser or the wasm engine: a host whose socket drops can reconnect and
// RECLAIM its room with a matching token, the stale old-socket close does NOT
// clobber the reclaimed room, a wrong token is rejected, and a genuine host-left
// still tears the room down.
//
//   node scripts/smoke-mp-reconnect.mjs [ws://host/signal]
//
// With no URL it self-starts scripts/sig-stub.mjs (the Node mirror of the worker)
// so it runs standalone in CI; pass a URL to point it at a live hub instead.
// Exits 0 if every assertion holds, 1 otherwise.
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SELF_PORT = 8939;
const URL = process.argv[2] || `ws://127.0.0.1:${SELF_PORT}/signal`;
const ownStub = !process.argv[2];
let stub = null;
if (ownStub) {
  const here = dirname(fileURLToPath(import.meta.url));
  stub = spawn('node', [join(here, 'sig-stub.mjs'), String(SELF_PORT)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
}
const ROOM = '90000001';
const TOKEN = 'tok-reconnect-aaaa';

let failures = 0;
const ok = (cond, label) => { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) failures++; };

function open() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const t = setTimeout(() => reject(new Error('open timeout')), 4000);
    ws.on('open', () => { clearTimeout(t); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}
// Resolve with the next JSON message, or {t:'<timeout>'} after ms (so an EXPECTED
// silence — e.g. a stale close that must NOT trigger anything — is testable).
function next(ws, ms = 2500) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { ws.off('message', onMsg); resolve({ t: '<timeout>' }); }, ms);
    const onMsg = (raw) => { clearTimeout(t); ws.off('message', onMsg); let m; try { m = JSON.parse(raw.toString()); } catch (e) { m = {}; } resolve(m); };
    ws.on('message', onMsg);
  });
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

  // 4) A different token for an existing room is a genuine collision -> host-taken.
  const intruder = await open();
  send(intruder, { t: 'host', room: ROOM, token: 'wrong-token' });
  ok((await next(intruder)).t === 'host-taken', '4. wrong token -> host-taken');
  intruder.close();

  // 5) When the CURRENT host leaves, the room is torn down -> later join sees no-room.
  host2.close();
  await sleep(400);
  const late = await open();
  send(late, { t: 'join', room: ROOM });
  ok((await next(late)).t === 'no-room', '5. current host left -> no-room');
  late.close();
}

const cleanup = () => { if (stub) { try { stub.kill('SIGKILL'); } catch (e) {} } };
main().then(() => {
  cleanup();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}).catch((e) => { cleanup(); console.error('ERROR', e); process.exit(1); });
