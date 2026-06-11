#!/usr/bin/env node
// WebSocket <-> TCP relay for ysflight-web multiplayer (Phase 1).
//
// Browser clients cannot open raw TCP connections.  Emscripten emulates BSD
// sockets over WebSocket, so this relay forwards each WebSocket connection to
// a native YSFLIGHT server (default port 7915) running on this host.
//
// Usage:
//   npm install
//   node relay.mjs [--listen 7916] [--target 127.0.0.1:7915]
//                  [--cert fullchain.pem --key privkey.pem]
//
// Plain ws:// works for pages served over http (local testing).  A page
// served over https (e.g. Cloudflare Pages) can only open wss:// connections,
// so pass --cert/--key (or put the relay behind a TLS reverse proxy).
//
// Point the wasm client at the relay with ?server=ws://host:7916 (or wss://).
import { WebSocketServer } from 'ws';
import net from 'node:net';
import https from 'node:https';
import fs from 'node:fs';

const args = process.argv.slice(2);
function opt(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
}

const listenPort = parseInt(opt('listen', '7916'), 10);
const [targetHost, targetPort] = opt('target', '127.0.0.1:7915').split(':');
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
  console.log(`relay: wss://0.0.0.0:${listenPort} -> tcp://${targetHost}:${targetPort}`);
} else {
  wss = new WebSocketServer({ port: listenPort });
  console.log(`relay: ws://0.0.0.0:${listenPort} -> tcp://${targetHost}:${targetPort}`);
}

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
