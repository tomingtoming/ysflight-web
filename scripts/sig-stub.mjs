// Standalone WebSocket signaling relay for LOCAL/CI tests only — a Node mirror of
// worker/signal.js's SignalHub (production uses the Cloudflare Worker).  Lets the
// 2-browser pack-distribution smoke (scripts/smoke-mp-pack.mjs) run /signal
// without wrangler.  Needs the `ws` package (smoke-mp-pack.sh installs it).
//
// Mirrors the worker's host-loss GRACE (a closed host socket leaves the room
// hostless for GRACE_MS awaiting a token reclaim or a fresh-token takeover;
// joins during the window are queued and flushed as {t:'peer'} on reclaim) and
// the server-driven KEEPALIVE ping.  Both are env-overridable like the worker:
// SIGNAL_GRACE_MS, SIGNAL_KEEPALIVE_MS.
//
//   node scripts/sig-stub.mjs [port]
import { WebSocketServer } from 'ws';

const port = parseInt(process.argv[2] || '8935', 10);
const GRACE_MS = Number(process.env.SIGNAL_GRACE_MS) > 0 ? Number(process.env.SIGNAL_GRACE_MS) : 90000;
const KEEPALIVE_MS = Number(process.env.SIGNAL_KEEPALIVE_MS) > 0 ? Number(process.env.SIGNAL_KEEPALIVE_MS) : 30000;
// room -> { host, peers: Map<id,ws>, nextPeer, manifest, manifestDropped, token,
//           pending: Set<id>, graceTimer }   (host === null -> grace window)
const rooms = new Map();
const conns = new Set();
const send = (ws, obj) => { try { if (ws) ws.send(JSON.stringify(obj)); } catch (e) {} };
const MAX_MANIFEST_BYTES = 256 * 1024; // mirror worker/signal.js

setInterval(() => { for (const s of conns) send(s, { t: 'ping' }); }, KEEPALIVE_MS);

// Mirror of SignalHub.reclaimRoom: flush queued hostless-window joiners.
function reclaimRoom(r, ws) {
  if (r.graceTimer !== null) { clearTimeout(r.graceTimer); r.graceTimer = null; }
  for (const id of r.pending) { if (r.peers.has(id)) send(ws, { t: 'peer', peer: id }); }
  r.pending.clear();
}

// Mirror of SignalHub.expireRoom: grace ran out with no reclaim.
function expireRoom(room) {
  const r = rooms.get(room);
  if (!r || r.host) return;
  for (const [, p] of r.peers) send(p, { t: 'host-left' });
  rooms.delete(room);
}

const wss = new WebSocketServer({ port });
wss.on('connection', (ws) => {
  conns.add(ws);
  const conn = { role: null, room: null, peerId: 0, closed: false };
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (m.t === 'ping') return;

    if (m.t === 'host' && typeof m.room === 'string' && m.room.length <= 16) {
      let manifest = null, hasManifest = false, dropped = false, bytes = 0;
      if (m.manifest != null) {
        hasManifest = true;
        try { bytes = JSON.stringify(m.manifest).length; if (bytes <= MAX_MANIFEST_BYTES) manifest = m.manifest; else dropped = true; } catch (e) {}
      }
      const hostOk = (room) => dropped
        ? { t: 'host-ok', room, manifestDropped: true, manifestBytes: bytes, manifestCap: MAX_MANIFEST_BYTES }
        : { t: 'host-ok', room };
      const token = (typeof m.token === 'string' && m.token.length <= 64) ? m.token : null;
      const existing = rooms.get(m.room);
      if (existing) {
        // Reconnecting host reclaims its room with a matching token (mirror of
        // worker/signal.js).
        if (token && existing.token && token === existing.token) {
          const old = existing.host;
          existing.host = ws;
          if (old && old !== ws) { try { old.close(); } catch (e) {} }
          conn.role = 'host';
          conn.room = m.room;
          if (hasManifest) { existing.manifest = manifest; existing.manifestDropped = dropped; }
          send(ws, hostOk(m.room));
          reclaimRoom(existing, ws);
          return;
        }
        // Fresh-token takeover of a HOSTLESS room (host reloaded during grace).
        if (!existing.host) {
          for (const [id, p] of existing.peers) {
            if (!existing.pending.has(id)) { send(p, { t: 'host-left' }); existing.peers.delete(id); }
          }
          existing.host = ws;
          existing.token = token;
          existing.manifest = manifest;
          existing.manifestDropped = dropped;
          conn.role = 'host';
          conn.room = m.room;
          send(ws, hostOk(m.room));
          reclaimRoom(existing, ws);
          return;
        }
        send(ws, { t: 'host-taken' });
        return;
      }
      conn.role = 'host';
      conn.room = m.room;
      rooms.set(m.room, { host: ws, peers: new Map(), nextPeer: 1, manifest, manifestDropped: dropped, token, pending: new Set(), graceTimer: null });
      send(ws, hostOk(m.room));

    } else if (m.t === 'join' && typeof m.room === 'string') {
      const r = rooms.get(m.room);
      if (!r) { send(ws, { t: 'no-room' }); return; }
      conn.role = 'peer';
      conn.room = m.room;
      conn.peerId = r.nextPeer++;
      r.peers.set(conn.peerId, ws);
      send(ws, { t: 'join-ok', peer: conn.peerId, manifest: r.manifest || null, manifestDropped: r.manifestDropped || undefined });
      if (r.host) send(r.host, { t: 'peer', peer: conn.peerId });
      else r.pending.add(conn.peerId);

    } else if ((m.t === 'sdp' || m.t === 'ice') && conn.room) {
      const r = rooms.get(conn.room);
      if (!r) return;
      if (conn.role === 'host') send(r.peers.get(m.peer), { t: m.t, peer: 0, data: m.data });
      else if (r.host) send(r.host, { t: m.t, peer: conn.peerId, data: m.data });
    }
  });
  ws.on('close', () => {
    conns.delete(ws);
    if (conn.closed || !conn.room) return;
    conn.closed = true;
    const r = rooms.get(conn.room);
    if (!r) return;
    if (conn.role === 'host') {
      if (r.host !== ws) return;  // a newer socket reclaimed this room; ignore the stale close
      r.host = null;              // grace window: await reclaim/takeover instead of deleting
      const room = conn.room;
      r.graceTimer = setTimeout(() => expireRoom(room), GRACE_MS);
    } else {
      r.peers.delete(conn.peerId);
      r.pending.delete(conn.peerId);
      if (r.host) send(r.host, { t: 'peer-left', peer: conn.peerId });
    }
  });
});
console.log('sig-stub on ws://localhost:' + port + '/signal');
