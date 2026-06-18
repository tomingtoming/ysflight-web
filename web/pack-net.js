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

function openSignal(url) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const ping = setInterval(() => { try { ws.send(JSON.stringify({ t: 'ping' })); } catch (e) {} }, 25000);
  ws.addEventListener('close', () => clearInterval(ping));
  return ws;
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
// opts: { signalUrl, iceServers?, listPackFiles(id)->Promise<{relPath:bytes}>, log? }
export function startPackHost(gameRoom, opts) {
  const { signalUrl, iceServers = DEFAULT_ICE, listPackFiles, log = () => {} } = opts;
  const room = derivePackRoom(gameRoom);
  const peers = new Map(); // peerId -> { pc, remoteSet, iceQ }
  const ws = openSignal(signalUrl);
  const sig = (o) => { try { ws.send(JSON.stringify(o)); } catch (e) {} };

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

  ws.addEventListener('open', () => sig({ t: 'host', room }));
  ws.addEventListener('message', async (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.t === 'host-ok') { log('hosting ' + room); return; }
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

  return {
    room,
    stop() {
      try { ws.close(); } catch (e) {}
      for (const [, st] of peers) { try { st.pc.close(); } catch (e) {} }
      peers.clear();
    },
  };
}

// JOINER: connect to the host's pack-room and pull the wanted pack ids.
// opts: { signalUrl, iceServers?, installFromBytes(bytes)->Promise<{id}>, uninstall(id)?, corrupt?, log? }
// Resolves to { installed:[ids], failed:[{id,reason}] }.
export function joinPackHost(gameRoom, wantedIds, opts) {
  const { signalUrl, iceServers = DEFAULT_ICE, installFromBytes, uninstall, corrupt = false, log = () => {} } = opts;
  const room = derivePackRoom(gameRoom);
  return new Promise((resolve) => {
    const ws = openSignal(signalUrl);
    const sig = (o) => { try { ws.send(JSON.stringify(o)); } catch (e) {} };
    let pc = null, ch = null, remoteSet = false;
    const iceQ = [];
    const installed = [], failed = [];
    const want = wantedIds.slice();
    let current = null, chunks = [], received = 0, done = false;

    const finish = () => {
      if (done) return;
      done = true;
      try { ws.close(); } catch (e) {}
      try { if (pc) pc.close(); } catch (e) {}
      resolve({ installed, failed });
    };
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
          try {
            const res = await installFromBytes(zip);
            if (res && res.id === wanted) { installed.push(wanted); log('installed ' + wanted); }
            else {
              // A mismatched id means installFromBytes already persisted the bytes
              // under the WRONG (recomputed) id — roll that bogus pack back so a
              // corrupted or forged transfer leaves no trace on the joiner.
              if (res && res.id && uninstall) { try { await uninstall(res.id); } catch (e) {} }
              failed.push({ id: wanted, reason: 'id-mismatch:' + (res && res.id) });
            }
          } catch (e) {
            failed.push({ id: wanted, reason: String((e && e.message) || e) });
          }
          current = null; requestNext();
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
  };
}

export const _internals = { derivePackRoom, buildRoomManifest, diffManifest, prioritizeMissing, zipPackFiles, concatChunks };
