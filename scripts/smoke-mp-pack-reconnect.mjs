// Client-side reconnect smoke for the shell-owned pack host (web/pack-net.js
// startPackHost).  Browser-free: Node v18+ exposes a global WebSocket, so we drive
// the real startPackHost against a sig-stub, KILL the hub, bring it back, and
// assert the pack host reconnected and RE-HOSTED its room (so late joiners stop
// getting no-room).  Complements scripts/smoke-mp-reconnect.mjs (which proves the
// SERVER reclaim contract); this proves the CLIENT actually reconnects.
//
//   node scripts/smoke-mp-pack-reconnect.mjs
//
// Exits 0 if every assertion holds, 1 otherwise.
import { spawn } from 'node:child_process';
import { WebSocket as WS } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The pack host opens an RTCPeerConnection when a peer joins; Node has none, and
// we only test the signaling reconnect (not the WebRTC pack transfer), so stub it
// just enough that the host's {t:'peer'} path does not throw.
globalThis.RTCPeerConnection = class {
  createDataChannel() { return { send() {}, binaryType: '', set onmessage(v) {} }; }
  createOffer() { return Promise.resolve({ type: 'offer', sdp: '' }); }
  setLocalDescription() { return Promise.resolve(); }
  setRemoteDescription() { return Promise.resolve(); }
  addIceCandidate() { return Promise.resolve(); }
  close() {}
  set onicecandidate(v) {}
};
process.on('unhandledRejection', () => {});

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = 8943;
const SIG = `ws://127.0.0.1:${PORT}/signal`;
const GAME = 'RECON01';
const PACKROOM = GAME + '~p';

let failures = 0;
const ok = (c, l) => { console.log((c ? 'PASS ' : 'FAIL ') + l); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const startStub = () => spawn('node', [join(ROOT, 'scripts/sig-stub.mjs'), String(PORT)], { stdio: 'ignore' });

// A control-only joiner: connect, ask to join the pack-room, resolve with the
// first join-ok / no-room (mirrors pack-net fetchHostManifest).
function probe() {
  return new Promise((resolve) => {
    const ws = new WS(SIG);
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { ws.close(); } catch (e) {} resolve(v); };
    const to = setTimeout(() => finish({ t: '<timeout>' }), 2500);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', room: PACKROOM })));
    ws.on('message', (raw) => { let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; } if (m.t === 'join-ok' || m.t === 'no-room') { clearTimeout(to); finish(m); } });
    ws.on('error', () => { clearTimeout(to); finish({ t: '<error>' }); });
  });
}

async function main() {
  const { startPackHost } = await import(join(ROOT, 'web/pack-net.js'));
  let stub = startStub();
  await sleep(800);

  const host = startPackHost(GAME, {
    signalUrl: SIG, iceServers: [],
    buildManifest: async () => [{ id: 'pk1', name: 'p1', categories: [], files: [] }],
    listPackFiles: async () => ({}),
    log: () => {},
  });
  await sleep(600);

  const r1 = await probe();
  ok(r1.t === 'join-ok' && Array.isArray(r1.manifest) && r1.manifest.length === 1,
    '1. pack host advertising before drop (join-ok + 1-pack manifest)');

  // Kill the hub: the host's signaling socket closes -> client reconnect loop arms.
  stub.kill('SIGKILL');
  await sleep(800);
  const during = await probe();
  ok(during.t !== 'join-ok', '2. while hub is down, nothing answers (sanity)');

  // Bring the hub back; the pack host must reconnect (backoff) and RE-HOST its room.
  stub = startStub();
  await sleep(5000);
  const r2 = await probe();
  ok(r2.t === 'join-ok' && Array.isArray(r2.manifest) && r2.manifest.length === 1,
    '3. pack host RECONNECTED and re-hosted after the hub returned (join-ok + manifest)');

  try { host.stop(); } catch (e) {}
  try { stub.kill('SIGKILL'); } catch (e) {}
}

main().then(() => {
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}).catch((e) => { console.error('ERROR', e); process.exit(1); });
