// Standalone WebSocket signaling relay for LOCAL/CI tests only — a Node mirror of
// worker/signal.js's SignalHub (production uses the Cloudflare Worker).  Lets the
// 2-browser pack-distribution smoke (scripts/smoke-mp-pack.mjs) run /signal
// without wrangler.  Needs the `ws` package (smoke-mp-pack.sh installs it).
//
//   node scripts/sig-stub.mjs [port]
import { WebSocketServer } from 'ws';

const port = parseInt(process.argv[2] || '8935', 10);
const rooms = new Map(); // room -> { host, peers: Map<id,ws>, nextPeer, manifest }
const send = (ws, obj) => { try { if (ws) ws.send(JSON.stringify(obj)); } catch (e) {} };

const wss = new WebSocketServer({ port });
wss.on('connection', (ws) => {
  const conn = { role: null, room: null, peerId: 0, closed: false };
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (m.t === 'ping') return;

    if (m.t === 'host' && typeof m.room === 'string' && m.room.length <= 16) {
      let manifest = null, hasManifest = false;
      if (m.manifest != null) {
        hasManifest = true;
        try { if (JSON.stringify(m.manifest).length <= 64 * 1024) manifest = m.manifest; } catch (e) {}
      }
      const token = (typeof m.token === 'string' && m.token.length <= 64) ? m.token : null;
      const existing = rooms.get(m.room);
      if (existing) {
        // Reconnecting host reclaims its room with a matching token (mirror of
        // worker/signal.js); otherwise an existing room is a genuine collision.
        if (token && existing.token && token === existing.token) {
          const old = existing.host;
          existing.host = ws;
          if (old && old !== ws) { try { old.close(); } catch (e) {} }
          conn.role = 'host';
          conn.room = m.room;
          if (hasManifest) existing.manifest = manifest;
          send(ws, { t: 'host-ok', room: m.room });
        } else {
          send(ws, { t: 'host-taken' });
        }
        return;
      }
      conn.role = 'host';
      conn.room = m.room;
      rooms.set(m.room, { host: ws, peers: new Map(), nextPeer: 1, manifest, token });
      send(ws, { t: 'host-ok', room: m.room });

    } else if (m.t === 'join' && typeof m.room === 'string') {
      const r = rooms.get(m.room);
      if (!r) { send(ws, { t: 'no-room' }); return; }
      conn.role = 'peer';
      conn.room = m.room;
      conn.peerId = r.nextPeer++;
      r.peers.set(conn.peerId, ws);
      send(ws, { t: 'join-ok', peer: conn.peerId, manifest: r.manifest || null });
      send(r.host, { t: 'peer', peer: conn.peerId });

    } else if ((m.t === 'sdp' || m.t === 'ice') && conn.room) {
      const r = rooms.get(conn.room);
      if (!r) return;
      if (conn.role === 'host') send(r.peers.get(m.peer), { t: m.t, peer: 0, data: m.data });
      else send(r.host, { t: m.t, peer: conn.peerId, data: m.data });
    }
  });
  ws.on('close', () => {
    if (conn.closed || !conn.room) return;
    conn.closed = true;
    const r = rooms.get(conn.room);
    if (!r) return;
    if (conn.role === 'host') {
      if (r.host !== ws) return;  // a newer socket reclaimed this room; ignore the stale close
      for (const [, p] of r.peers) send(p, { t: 'host-left' });
      rooms.delete(conn.room);
    } else {
      r.peers.delete(conn.peerId);
      send(r.host, { t: 'peer-left', peer: conn.peerId });
    }
  });
});
console.log('sig-stub on ws://localhost:' + port + '/signal');
