// Multiplayer add-on-pack distribution for ysflight-web (v2).
//
// A host advertises the packs it has ENABLED; a joining client diffs that
// against its own installed packs and pulls the missing ones BEFORE the YSFLIGHT
// log-on, so a joiner ends up with the host's packs with no manual install.
//
// Transport is a SHELL-OWNED WebRTC connection (a separate RTCPeerConnection +
// 'ysf-pack' DataChannel), NOT the engine's game channel: the engine's peer
// connection does not exist until after main(), but pack sync must finish during
// the pre-boot run-dependency gate, so the pack connection must be shell-owned
// and independent of the engine.  It reuses the same Cloudflare signaling hub on
// a DERIVED room string.  Full design: docs/addon-packs.md section 5.
//
// This module is built up across milestones:
//   M4 (this file): the pure, engine-independent CORE below — room derivation,
//       the host's advertised manifest, and the joiner's diff.
//   M5: WebRTC signaling + a chunked/backpressured 'ysf-pack' transfer (host push).
//   M6: wire the joiner sync into the pre-boot run-dependency gate (no reload).
//   M7: Option-B URL self-fetch + field-priority + obtain-failure UX.
// Keep browser-only APIs (WebSocket/RTCPeerConnection) inside functions added in
// later milestones so this module stays importable under Node for unit tests.

import { zipSync } from './vendor/fflate.js';

// The engine host claims the plain room (<=16 chars, an 8-digit code in the web
// build); the pack channel needs a DISTINCT room both sides can derive from data
// they already have (globalThis.ysfwRtc.host.room on the host, ?join= on the
// joiner).  A 2-char suffix keeps it within the Worker's 16-char room-key limit.
export function derivePackRoom(gameRoom) {
  const base = String(gameRoom == null ? '' : gameRoom);
  const suffix = '~p';
  const room = base + suffix;
  return room.length <= 16 ? room : base.slice(0, 16 - suffix.length) + suffix;
}

// Build the host's advertised manifest from the installed-pack index + each
// pack's stored manifest.json.  Only ENABLED packs are advertised.  Pure aside
// from the injected accessors, so it is unit-testable:
//   list()               -> array of index entries {id,name,enabled,categories,...}
//   readManifestJson(id) -> packs/<id>/manifest.json object {files:[{path,size,sha256}],sourceUrl?} | null
export async function buildRoomManifest({ list, readManifestJson }) {
  const index = (await list()) || [];
  const out = [];
  for (const e of index) {
    if (!e || e.enabled === false) continue;
    let files = [];
    let sourceUrl;
    const mf = await readManifestJson(e.id);
    if (mf && Array.isArray(mf.files)) {
      files = mf.files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 }));
      if (mf.sourceUrl) sourceUrl = mf.sourceUrl;
    }
    const pack = { id: e.id, name: e.name, categories: e.categories || [], files };
    if (sourceUrl) pack.sourceUrl = sourceUrl;
    out.push(pack);
  }
  return out;
}

// Diff a received room manifest against the joiner's local index.  Packs are
// content-addressed (id = hash of contents), so an identical id means identical
// bytes.  Returns:
//   missing   : host packs whose id the joiner lacks (must be obtained)
//   present   : host pack ids the joiner already has
//   conflicts : host packs whose NAME matches a locally-installed pack of a
//               DIFFERENT id (same-name/different-hash).  Policy (decided): the
//               host version wins for the session — handled at install time (M6).
export function diffManifest(roomManifest, localIndex) {
  const room = Array.isArray(roomManifest) ? roomManifest : [];
  const local = Array.isArray(localIndex) ? localIndex : [];
  const localIds = new Set(local.map((e) => e && e.id));
  const localByName = new Map();
  for (const e of local) if (e && e.name != null) localByName.set(e.name, e);

  const missing = [];
  const present = [];
  const conflicts = [];
  for (const p of room) {
    if (!p || !p.id) continue;
    if (localIds.has(p.id)) {
      present.push(p.id);
      continue;
    }
    missing.push(p);
    const byName = localByName.get(p.name);
    if (byName && byName.id !== p.id) {
      conflicts.push({ hostId: p.id, hostName: p.name, localId: byName.id });
    }
  }
  return { missing, present, conflicts };
}

// Order a missing-set so REQUIRED field/scenery packs come first.  A missing
// field is fatal in the engine (CLIENT_FATAL_FIELD_UNAVAILABLE), whereas missing
// aircraft/ground degrade to a substitute — so the joiner must obtain fields
// before releasing the boot gate (M6/M7), aircraft/ground are best-effort.
export function prioritizeMissing(missing) {
  const isField = (p) => (p.categories || []).includes('scenery');
  const required = [];
  const bestEffort = [];
  for (const p of missing || []) (isField(p) ? required : bestEffort).push(p);
  return { required, bestEffort };
}

// ---------------------------------------------------------------------------
// M5: shell-owned WebRTC transport for pack bytes ('ysf-pack' DataChannel).
//
// A host serves its installed packs; a joiner pulls the ones it wants, over a
// SEPARATE RTCPeerConnection from the engine's game channel, on the derived
// pack-room, reusing the same signaling relay.  Pack bytes flow P2P; the Worker
// only relays SDP/ICE.  We own onmessage on this channel, so message boundaries
// are preserved (unlike the engine's flattened drain) and the wire protocol is:
//   joiner -> host : {op:'want', id}
//   host -> joiner : {op:'begin', id, size} , <binary chunks...> , {op:'end', id}
//                  | {op:'error', id, reason}
// Each pack ships as a single zip (its packs/<id>/ tree minus the regenerated
// manifest.json), so the joiner installs it through the existing
// installFromBytes pipeline and the RECOMPUTED content-hash id must equal the
// requested id (integrity by content-addressing — a corrupted transfer yields a
// different id, or fails to unzip, and is rejected).

const PACK_CHUNK = 60 * 1024; // <= the safe single-message size for a DataChannel
const PACK_BUFFER_HIGH = 8 * 1024 * 1024; // pause sending above this bufferedAmount
const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

// Reconstruct a pack's original archive (its packs/<id>/ tree minus the
// generated manifest.json) as a zip the joiner can install verbatim.  Pure;
// excluding manifest.json keeps the recomputed content-hash id stable.
export function zipPackFiles(files) {
  const tree = {};
  for (const path of Object.keys(files)) {
    if (path === 'manifest.json') continue;
    tree[path] = files[path];
  }
  return zipSync(tree, { level: 0 }); // store: model data is already compact; fast + deterministic
}

function concatChunks(chunks, total) {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// Walk packs/<id>/ in the Emscripten FS into { relPath: Uint8Array } (browser).
function walkPackFiles(FS, userDir, id) {
  const root = userDir + '/packs/' + id;
  const out = {};
  (function rec(abs, rel) {
    let st;
    try { st = FS.stat(abs); } catch (e) { return; }
    if (FS.isDir(st.mode)) {
      for (const n of FS.readdir(abs)) {
        if (n === '.' || n === '..') continue;
        rec(abs + '/' + n, rel ? rel + '/' + n : n);
      }
    } else {
      out[rel] = FS.readFile(abs, { encoding: 'binary' });
    }
  })(root, '');
  return out;
}

// Read packs/<id>/manifest.json from the Emscripten FS as an object (browser).
function readPackManifestJson(FS, userDir, id) {
  try {
    const raw = FS.readFile(userDir + '/packs/' + id + '/manifest.json', { encoding: 'binary' });
    return JSON.parse(new TextDecoder().decode(raw));
  } catch (e) {
    return null;
  }
}

function openSignal(url) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const ping = setInterval(() => { try { ws.send(JSON.stringify({ t: 'ping' })); } catch (e) {} }, 25000);
  ws.addEventListener('close', () => clearInterval(ping));
  return ws;
}

// A per-session id that lets a reconnecting host RECLAIM its pack-room from the
// signaling hub (see worker/signal.js) instead of being rejected with host-taken.
// Not a security boundary (rooms are guessable 8-digit codes already) -- just
// enough entropy to distinguish the same host reconnecting from a code collision.
function randomToken() {
  return (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 24);
}

async function sendZipChunked(ch, id, zip) {
  ch.send(JSON.stringify({ op: 'begin', id, size: zip.length }));
  ch.bufferedAmountLowThreshold = PACK_BUFFER_HIGH / 2;
  for (let off = 0; off < zip.length; off += PACK_CHUNK) {
    if (ch.bufferedAmount > PACK_BUFFER_HIGH) {
      await new Promise((res) => {
        const onLow = () => { ch.removeEventListener('bufferedamountlow', onLow); res(); };
        ch.addEventListener('bufferedamountlow', onLow);
      });
    }
    ch.send(zip.subarray(off, Math.min(off + PACK_CHUNK, zip.length)));
  }
  ch.send(JSON.stringify({ op: 'end', id }));
}

// HOST: claim the derived pack-room and serve installed packs to joiners.
// opts: { signalUrl, iceServers?, listPackFiles(id)->Promise<{relPath:bytes}>,
//         buildManifest()->Promise<manifest>?, log? }
export function startPackHost(gameRoom, opts) {
  const { signalUrl, iceServers = DEFAULT_ICE, listPackFiles, buildManifest, log = () => {} } = opts;
  const room = derivePackRoom(gameRoom);
  const token = randomToken();
  const peers = new Map(); // peerId -> { pc, remoteSet, iceQ }
  let ws = null, ping = null, stopped = false, reconnectTimer = null, backoff = 0;
  let manifestBuilt = false, manifestVal; // build once, resend verbatim on reclaim
  const sig = (o) => { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); } catch (e) {} };

  async function serve(ch, peer, id) {
    try {
      const files = await listPackFiles(id);
      if (!files || Object.keys(files).length === 0) {
        ch.send(JSON.stringify({ op: 'error', id, reason: 'not-found' }));
        return;
      }
      const zip = zipPackFiles(files);
      log('serving pack ' + id + ' (' + zip.length + 'B) to peer ' + peer);
      await sendZipChunked(ch, id, zip);
    } catch (e) {
      try { ch.send(JSON.stringify({ op: 'error', id, reason: String((e && e.message) || e) })); } catch (e2) {}
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(15000, 1000 * Math.pow(2, backoff));
    reconnectTimer = setTimeout(() => { reconnectTimer = null; backoff += 1; connect(); }, delay);
  }
  // Resume after a frozen/backgrounded tab: the reconnect backoff timer is frozen
  // too, so kick an immediate reconnect when the page becomes visible and the
  // socket is not open.  Idempotent.
  function reconnectNow() {
    if (stopped) return;
    if (ws && ws.readyState === 1) return;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    backoff = 0; connect();
  }
  const onVisible = () => { if (typeof document === 'undefined' || document.visibilityState === 'visible') reconnectNow(); };

  function connect() {
    if (stopped) return;
    const sock = new WebSocket(signalUrl);
    ws = sock;
    sock.binaryType = 'arraybuffer';
    let myPing = null;   // per-socket so a stale socket's timer can't outlive it
    sock.addEventListener('open', async () => {
      myPing = setInterval(() => { try { sock.send(JSON.stringify({ t: 'ping' })); } catch (e) {} }, 25000);
      ping = myPing;     // expose the current socket's ping so stop() can clear it
      // Publish the pack manifest alongside the host claim so a joiner can read it
      // from join-ok (§5.5) and diff BEFORE booting — only control metadata flows
      // through the signaling hub; pack bytes still go P2P.  Built once and resent
      // verbatim on a reclaim so a joiner arriving after a host reconnect still sees
      // it.  token lets the hub treat this reconnect as a reclaim, not host-taken.
      if (!manifestBuilt) { try { manifestVal = buildManifest ? await buildManifest() : undefined; } catch (e) {} manifestBuilt = true; }
      try { if (sock.readyState === 1) sock.send(JSON.stringify({ t: 'host', room, token, manifest: manifestVal })); } catch (e) {}
    });
    sock.addEventListener('close', () => {
      if (myPing) { clearInterval(myPing); if (ping === myPing) ping = null; myPing = null; }
      // Resume race: reconnectNow() may have opened a newer socket before this stale
      // close arrived.  Only the current socket drives reconnect, else a stale close
      // would schedule a redundant reconnect storm.
      if (ws !== sock) return;
      if (stopped) return;
      scheduleReconnect();   // a dropped pack-host socket would otherwise make late joiners miss pack sync
    });
    sock.addEventListener('message', async (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'host-ok') { backoff = 0; log('hosting ' + room); return; }
      if (m.t === 'host-taken') { log('pack-room taken: ' + room); return; }
      if (m.t === 'peer') {
        const pc = new RTCPeerConnection({ iceServers });
        const st = { pc, remoteSet: false, iceQ: [] };
        peers.set(m.peer, st);
        pc.onicecandidate = (e) => { if (e.candidate) sig({ t: 'ice', peer: m.peer, data: e.candidate }); };
        const ch = pc.createDataChannel('ysf-pack', { ordered: true });
        ch.binaryType = 'arraybuffer';
        ch.onmessage = (e) => {
          if (typeof e.data !== 'string') return;
          let mm; try { mm = JSON.parse(e.data); } catch (er) { return; }
          if (mm.op === 'want' && mm.id) serve(ch, m.peer, mm.id);
        };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sig({ t: 'sdp', peer: m.peer, data: offer });
      } else if (m.t === 'sdp') {
        const st = peers.get(m.peer); if (!st) return;
        await st.pc.setRemoteDescription(m.data);
        st.remoteSet = true;
        for (const c of st.iceQ) { try { await st.pc.addIceCandidate(c); } catch (e) {} }
        st.iceQ = [];
      } else if (m.t === 'ice') {
        const st = peers.get(m.peer); if (!st) return;
        if (st.remoteSet) { try { await st.pc.addIceCandidate(m.data); } catch (e) {} }
        else st.iceQ.push(m.data);
      } else if (m.t === 'peer-left') {
        const st = peers.get(m.peer);
        if (st) { try { st.pc.close(); } catch (e) {} peers.delete(m.peer); }
      }
    });
  }

  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  if (typeof window !== 'undefined') window.addEventListener('pageshow', onVisible);
  connect();

  return {
    room,
    reconnect: reconnectNow,
    stop() {
      stopped = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ping) { clearInterval(ping); ping = null; }
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
      if (typeof window !== 'undefined') window.removeEventListener('pageshow', onVisible);
      try { if (ws) ws.close(); } catch (e) {}
      for (const [, st] of peers) { try { st.pc.close(); } catch (e) {} }
      peers.clear();
    },
  };
}

// JOINER: connect to the host's pack-room and pull the wanted pack ids.
// opts: { signalUrl, iceServers?, installFromBytes(bytes)->Promise<{id}>, uninstall(id)?, corrupt?, log? }
// Resolves to { installed:[ids], failed:[{id,reason}] }.
export function joinPackHost(gameRoom, wantedIds, opts) {
  const { signalUrl, iceServers = DEFAULT_ICE, installFromBytes, uninstall, corrupt = false, timeoutMs = 30000, log = () => {}, onInstalled = () => {} } = opts;
  const room = derivePackRoom(gameRoom);
  return new Promise((resolve) => {
    const ws = openSignal(signalUrl);
    const sig = (o) => { try { ws.send(JSON.stringify(o)); } catch (e) {} };
    let pc = null, ch = null, remoteSet = false;
    const iceQ = [];
    const installed = [], failed = [];
    const want = wantedIds.slice();
    let current = null, chunks = [], received = 0, done = false, guard = null;

    const finish = () => {
      if (done) return;
      done = true;
      if (guard) { clearTimeout(guard); guard = null; }
      try { ws.close(); } catch (e) {}
      try { if (pc) pc.close(); } catch (e) {}
      resolve({ installed, failed });
    };
    // Overall safety timeout: STUN-only with no TURN, an unreachable peer never
    // completes the ICE handshake and the transfer would hang forever.  Mark the
    // outstanding wants failed (so a missing REQUIRED field surfaces in the
    // obtain-failure UX rather than a silent hang) and resolve.  Per design,
    // TURN is out of scope; this makes the unreachable case visible (M7).
    guard = setTimeout(() => {
      log('transfer timed out after ' + timeoutMs + 'ms');
      if (current !== null) { failed.push({ id: current, reason: 'timeout' }); current = null; }
      for (const id of want) failed.push({ id, reason: 'timeout' });
      want.length = 0;
      finish();
    }, timeoutMs);
    const requestNext = () => {
      if (current !== null) return;
      if (want.length === 0) { finish(); return; }
      current = want.shift();
      chunks = []; received = 0;
      ch.send(JSON.stringify({ op: 'want', id: current }));
    };

    async function onChMessage(data) {
      if (typeof data === 'string') {
        let m; try { m = JSON.parse(data); } catch (e) { return; }
        if (m.op === 'begin') { chunks = []; received = 0; }
        else if (m.op === 'error') { failed.push({ id: m.id, reason: m.reason }); current = null; requestNext(); }
        else if (m.op === 'end') {
          const zip = concatChunks(chunks, received);
          // test hook: flip a MIDDLE byte so the corruption lands in stored file
          // content.  Flipping zip[0] only hits the first local-header signature,
          // which fflate ignores (it locates entries via the central directory at
          // the tail) — the bytes would extract unchanged, the recomputed id would
          // still match, and a "corrupt" transfer would wrongly pass.
          if (corrupt && zip.length) zip[(zip.length / 2) | 0] ^= 0xff;
          const wanted = current;
          // Release `current` synchronously BEFORE the async install so a guard
          // timeout firing mid-install can't see it as outstanding and double-count
          // it into both installed and failed.
          current = null;
          try {
            const res = await installFromBytes(zip);
            if (done) return; // the guard timeout already resolved us — leave the result arrays alone
            if (res && res.id === wanted) { installed.push(wanted); log('installed ' + wanted); onInstalled(); }
            else {
              // A mismatched id means installFromBytes already persisted the bytes
              // under the WRONG (recomputed) id — roll that bogus pack back so a
              // corrupted or forged transfer leaves no trace on the joiner.
              if (res && res.id && uninstall) { try { await uninstall(res.id); } catch (e) {} }
              failed.push({ id: wanted, reason: 'id-mismatch:' + (res && res.id) });
            }
          } catch (e) {
            if (done) return;
            failed.push({ id: wanted, reason: String((e && e.message) || e) });
          }
          requestNext();
        }
      } else {
        const u = data instanceof Uint8Array ? data : new Uint8Array(data);
        chunks.push(u); received += u.length;
      }
    }

    ws.addEventListener('open', () => sig({ t: 'join', room }));
    ws.addEventListener('message', async (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'no-room') { for (const id of want) failed.push({ id, reason: 'no-room' }); want.length = 0; finish(); }
      else if (m.t === 'sdp') {
        pc = new RTCPeerConnection({ iceServers });
        pc.onicecandidate = (e) => { if (e.candidate) sig({ t: 'ice', data: e.candidate }); };
        pc.ondatachannel = (e) => {
          if (e.channel.label !== 'ysf-pack') return;
          ch = e.channel;
          ch.binaryType = 'arraybuffer';
          ch.onopen = () => requestNext();
          ch.onmessage = (ev2) => onChMessage(ev2.data);
        };
        await pc.setRemoteDescription(m.data);
        remoteSet = true;
        for (const c of iceQ) { try { await pc.addIceCandidate(c); } catch (e) {} }
        iceQ.length = 0;
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sig({ t: 'sdp', data: answer });
      } else if (m.t === 'ice') {
        if (pc && remoteSet) { try { await pc.addIceCandidate(m.data); } catch (e) {} }
        else iceQ.push(m.data);
      } else if (m.t === 'host-left') {
        for (const id of want) failed.push({ id, reason: 'host-left' });
        want.length = 0; finish();
      }
    });
  });
}

// JOINER (pre-boot, step 1): read the host's advertised manifest for the derived
// pack-room WITHOUT pulling bytes — a control-only join that returns the manifest
// the host published (§5.5), then closes.  Resolves to the manifest array, or
// null when there is no host / no manifest / it times out.
export function fetchHostManifest(gameRoom, opts) {
  const { signalUrl, timeoutMs = 8000, log = () => {} } = opts;
  const room = derivePackRoom(gameRoom);
  return new Promise((resolve) => {
    const ws = openSignal(signalUrl);
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { ws.close(); } catch (e) {} resolve(v); };
    ws.addEventListener('open', () => { try { ws.send(JSON.stringify({ t: 'join', room })); } catch (e) {} });
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'join-ok') { const mf = m.manifest || []; log('manifest: ' + mf.length + ' pack(s)'); finish(mf); }
      else if (m.t === 'no-room') { log('no pack host for room'); finish(null); }
    });
    setTimeout(() => finish(null), timeoutMs);
  });
}

// JOINER (Option B, M7): self-fetch one pack's bytes from its advertised
// sourceUrl instead of pulling them P2P from the host — this offloads the host
// when the pack lives at a stable URL.  Integrity is still gated by
// content-addressing: the recomputed id must equal the wanted id, otherwise the
// bytes are rolled back and we return false so the caller falls back to Option A
// (host push).  Pure aside from the injected fetch/install/uninstall, so it is
// unit-testable under Node.
//   opts: { fetchImpl?, installFromBytes(bytes)->Promise<{id}>, uninstall(id)?,
//           urlTimeoutMs?, log? }
// Resolves true on a verified install, false otherwise (never throws).
export async function fetchPackFromUrl(pack, opts) {
  const {
    fetchImpl = (typeof fetch !== 'undefined' ? fetch : null),
    installFromBytes, uninstall, urlTimeoutMs = 15000, log = () => {},
  } = opts;
  if (!pack || !pack.sourceUrl || !fetchImpl || !installFromBytes) return false;
  const wanted = pack.id;
  let controller = null, timer = null;
  try {
    if (typeof AbortController !== 'undefined') {
      controller = new AbortController();
      timer = setTimeout(() => { try { controller.abort(); } catch (e) {} }, urlTimeoutMs);
    }
    const resp = await fetchImpl(pack.sourceUrl, controller ? { signal: controller.signal } : {});
    if (!resp || !resp.ok) { log('url fetch ' + wanted + ' failed: HTTP ' + (resp && resp.status)); return false; }
    const bytes = new Uint8Array(await resp.arrayBuffer());
    // Record the origin URL on the install so a joiner that later HOSTS can
    // re-advertise it and offload ITS joiners via Option B too (the chain would
    // otherwise break after one hop).  Harmless for the id (sourceUrl lives only
    // in manifest.json, which is excluded from the content-hash).
    const res = await installFromBytes(bytes, undefined, pack.sourceUrl);
    if (res && res.id === wanted) { log('installed ' + wanted + ' via URL'); return true; }
    // Wrong id => the URL served forged/stale bytes; installFromBytes persisted
    // them under the recomputed id, so roll that back (same guard as the P2P path).
    if (res && res.id && uninstall) { try { await uninstall(res.id); } catch (e) {} }
    log('url fetch ' + wanted + ' id-mismatch: ' + (res && res.id));
    return false;
  } catch (e) {
    log('url fetch ' + wanted + ' error: ' + ((e && e.message) || e));
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// JOINER (pre-boot): full pack sync from the host before main().  Reads the host
// manifest, diffs it against the locally installed packs, and obtains the missing
// ones (fields first — a missing field is fatal in the engine) so the engine's
// one-time template scan finds them with no reload.  Each pack is obtained via
// Option B (self-fetch its sourceUrl) when advertised, falling back to Option A
// (host P2P push) on any B failure; packs with no URL go straight to A.
// opts: { signalUrl, iceServers?, list()->Promise<index>, installFromBytes(),
//         uninstall(id)?, fetchImpl?, log? }
// Resolves to { installed, failed, missing, conflicts, requiredFailed } where
// requiredFailed lists the REQUIRED (field/scenery) packs neither path obtained —
// the caller must NOT boot silently into the session when it is non-empty (M7).
export async function syncPacksAsJoiner(gameRoom, opts) {
  const { list, log = () => {}, onProgress } = opts;
  const manifest = await fetchHostManifest(gameRoom, opts);
  if (!manifest || manifest.length === 0) return { installed: [], failed: [], missing: 0, conflicts: [], requiredFailed: [] };
  const localIndex = (await list()) || [];
  const { missing, conflicts } = diffManifest(manifest, localIndex);
  if (missing.length === 0) { log('all host packs already present'); return { installed: [], failed: [], missing: 0, conflicts, requiredFailed: [] }; }
  const { required, bestEffort } = prioritizeMissing(missing);
  const ordered = [...required, ...bestEffort]; // fields first
  const requiredIds = new Set(required.map((p) => p.id));
  log('obtaining ' + ordered.length + ' pack(s) (' + required.length + ' required-first)');

  const installed = [];
  const failed = [];
  const needP2P = [];
  // Progress for the joiner's loading overlay (optional; no-op for Node/unit tests):
  // report a 0/total baseline now, then tick on each obtained pack across BOTH paths.
  let doneCount = 0;
  if (onProgress) onProgress(doneCount, ordered.length);
  // Option B first: any pack advertising a sourceUrl is self-fetched (offloads the
  // host).  Any B failure (network/404/integrity) falls through to Option A.
  for (const p of ordered) {
    if (p.sourceUrl) {
      const ok = await fetchPackFromUrl(p, opts);
      if (ok) { installed.push(p.id); doneCount++; if (onProgress) onProgress(doneCount, ordered.length); continue; }
      log('Option B failed for ' + p.id + ' — falling back to host push (Option A)');
    }
    needP2P.push(p);
  }
  // Option A (M5 transport): pull whatever Option B did not satisfy.  Thread a
  // per-install tick through joinPackHost so the overlay advances during the pull.
  if (needP2P.length) {
    const res = await joinPackHost(gameRoom, needP2P.map((p) => p.id),
      { ...opts, onInstalled: () => { doneCount++; if (onProgress) onProgress(doneCount, ordered.length); } });
    for (const id of res.installed) installed.push(id);
    for (const f of res.failed) failed.push(f);
  }
  const got = new Set(installed);
  // Carry each failed pack's reason (timeout / no-room / host-left / id-mismatch / …)
  // onto requiredFailed so the obtain-failure UX can explain WHY and make Retry an
  // informed choice rather than a blind guess.
  const reasonById = new Map();
  for (const f of failed) if (f && f.id != null && !reasonById.has(f.id)) reasonById.set(f.id, f.reason);
  const requiredFailed = ordered
    .filter((p) => requiredIds.has(p.id) && !got.has(p.id))
    .map((p) => ({ id: p.id, name: p.name, categories: p.categories || [], reason: reasonById.get(p.id) }));
  return { installed, failed, missing: ordered.length, conflicts, requiredFailed };
}

// Browser wiring: host/join that pull deps from the page (Module.FS,
// window.ysfwPacks, Module.ysfwSignalUrl).  Guarded so Node import stays safe.
if (typeof window !== 'undefined') {
  const signalUrlOf = () =>
    (window.Module && window.Module.ysfwSignalUrl) ||
    ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/signal');
  const userDirOf = () =>
    (window.Module && window.Module.__ysfwUserDir) || '/home/web_user/Documents/YSFLIGHT.COM/YSFLIGHT';
  const iceOf = () => window.ysfwPackIce || DEFAULT_ICE; // tests may set [] for loopback determinism
  window.ysfwPackNet = {
    host(gameRoom) {
      return startPackHost(gameRoom, {
        signalUrl: signalUrlOf(),
        iceServers: iceOf(),
        listPackFiles: async (id) => walkPackFiles(window.Module.FS, userDirOf(), id),
        buildManifest: () => buildRoomManifest({
          list: () => window.ysfwPacks.list(),
          readManifestJson: (id) => readPackManifestJson(window.Module.FS, userDirOf(), id),
        }),
        log: (s) => console.log('[pack-net host] ' + s),
      });
    },
    join(gameRoom, wantedIds) {
      return joinPackHost(gameRoom, wantedIds, {
        signalUrl: signalUrlOf(),
        iceServers: iceOf(),
        installFromBytes: (bytes) => window.ysfwPacks.installFromBytes(bytes),
        uninstall: (id) => window.ysfwPacks.uninstall(id),
        corrupt: !!window.__ysfwPackCorrupt,
        log: (s) => console.log('[pack-net join] ' + s),
      });
    },
    // Pre-boot join sync (M6): read the host manifest, diff, pull the missing
    // packs, install — the boot gate releases when this resolves.
    syncAsJoiner(gameRoom, onProgress) {
      return syncPacksAsJoiner(gameRoom, {
        signalUrl: signalUrlOf(),
        iceServers: iceOf(),
        list: () => window.ysfwPacks.list(),
        // Forward sourceUrl so an Option-B self-fetch records the pack's origin
        // (P2P pulls pass it undefined -> no URL recorded, which is correct).
        installFromBytes: (bytes, name, sourceUrl) => window.ysfwPacks.installFromBytes(bytes, name, sourceUrl),
        uninstall: (id) => window.ysfwPacks.uninstall(id),
        corrupt: !!window.__ysfwPackCorrupt, // test hook: corrupt the P2P transfer
        // Optional progress sink for the loading overlay; absent for Node/smoke.
        onProgress: typeof onProgress === 'function' ? onProgress : undefined,
        log: (s) => console.log('[pack-net join] ' + s),
      });
    },
  };
}

export const _internals = { derivePackRoom, buildRoomManifest, diffManifest, prioritizeMissing, zipPackFiles, concatChunks };
