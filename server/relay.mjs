#!/usr/bin/env node
// WebSocket <-> TCP relay for ysflight-web multiplayer (Phase 1).
//
// Browser clients cannot open raw TCP connections.  Emscripten emulates BSD
// sockets over WebSocket, so this relay forwards each WebSocket connection to
// a native YSFLIGHT server (default port 7915) running on this host.
//
// Usage:
//   npm install ws
//   node relay.mjs [--listen 7916] [--target 127.0.0.1:7915]
//
// Then point the wasm client at ws://<host>:7916 (Module.websocket.url).
import { WebSocketServer } from 'ws';
import net from 'node:net';

const args = process.argv.slice(2);
function opt(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
}

const listenPort = parseInt(opt('listen', '7916'), 10);
const [targetHost, targetPort] = opt('target', '127.0.0.1:7915').split(':');

const wss = new WebSocketServer({ port: listenPort });
console.log(`relay: ws://0.0.0.0:${listenPort} -> tcp://${targetHost}:${targetPort}`);

wss.on('connection', (ws, req) => {
  const peer = req.socket.remoteAddress;
  const tcp = net.connect(parseInt(targetPort, 10), targetHost);
  console.log(`relay: ${peer} connected`);

  tcp.on('connect', () => {
    ws.on('message', (data) => tcp.write(data));
    tcp.on('data', (data) => ws.send(data));
  });

  const close = () => {
    ws.close();
    tcp.destroy();
  };
  ws.on('close', close);
  ws.on('error', close);
  tcp.on('close', close);
  tcp.on('error', close);
});
