#!/usr/bin/env node
// WebRTC signaling server for ysflight-web multiplayer Phase 2.
//
// Browser hosts register a room code; joining browsers exchange SDP/ICE
// through this server, then all game traffic flows peer-to-peer over
// WebRTC DataChannels.  This server never sees game data.
//
// Usage:
//   npm install
//   node signal.mjs [--listen 7917] [--cert fullchain.pem --key privkey.pem]
//
// Pages served over https need wss:// (use --cert/--key or a TLS proxy).
import { WebSocketServer } from 'ws';
import https from 'node:https';
import fs from 'node:fs';

const args = process.argv.slice(2);
function opt(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
}
const listenPort = parseInt(opt('listen', '7917'), 10);
const certFile = opt('cert', null);
const keyFile = opt('key', null);

let wss;
if (certFile && keyFile) {
  const httpsServer = https.createServer({
    cert: fs.readFileSync(certFile),
    key: fs.readFileSync(keyFile)
  });
  wss = new WebSocketServer({ server: httpsServer });
  httpsServer.listen(listenPort);
  console.log(`signal: wss://0.0.0.0:${listenPort}`);
} else {
  wss = new WebSocketServer({ port: listenPort });
  console.log(`signal: ws://0.0.0.0:${listenPort}`);
}

// room -> { host: ws, peers: Map<peerId, ws>, nextPeer: number }
const rooms = new Map();

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws) => {
  let role = null;     // 'host' | 'peer'
  let room = null;
  let peerId = 0;

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.t === 'host' && typeof m.room === 'string' && m.room.length <= 16) {
      if (rooms.has(m.room)) {
        send(ws, { t: 'host-taken' });
        return;
      }
      role = 'host';
      room = m.room;
      rooms.set(room, { host: ws, peers: new Map(), nextPeer: 1 });
      send(ws, { t: 'host-ok', room });
      console.log(`room ${room}: hosted`);

    } else if (m.t === 'join' && typeof m.room === 'string') {
      const r = rooms.get(m.room);
      if (!r) {
        send(ws, { t: 'no-room' });
        return;
      }
      role = 'peer';
      room = m.room;
      peerId = r.nextPeer++;
      r.peers.set(peerId, ws);
      send(ws, { t: 'join-ok', peer: peerId });
      send(r.host, { t: 'peer', peer: peerId });
      console.log(`room ${room}: peer ${peerId} joined`);

    } else if ((m.t === 'sdp' || m.t === 'ice') && room) {
      const r = rooms.get(room);
      if (!r) return;
      if (role === 'host') {
        send(r.peers.get(m.peer), { t: m.t, peer: 0, data: m.data });
      } else {
        send(r.host, { t: m.t, peer: peerId, data: m.data });
      }
    }
  });

  ws.on('close', () => {
    if (!room) return;
    const r = rooms.get(room);
    if (!r) return;
    if (role === 'host') {
      for (const [, pws] of r.peers) send(pws, { t: 'host-left' });
      rooms.delete(room);
      console.log(`room ${room}: closed`);
    } else {
      r.peers.delete(peerId);
      send(r.host, { t: 'peer-left', peer: peerId });
      console.log(`room ${room}: peer ${peerId} left`);
    }
  });
});
