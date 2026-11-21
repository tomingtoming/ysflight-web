#!/usr/bin/env node
// Watch the first kilobyte of the engine's memory through an intercept mission.
//
// Nothing lives there.  The engine's legacy list code (ysclass YsList and others) is
// called on null pointers and tests `this==NULL` itself; built without
// -fno-delete-null-pointer-checks (scripts/build.sh) the compiler drops the test, an
// "append to an empty list" writes a heap address into those bytes, and the next one
// follows it into freed memory.  2026-11-21, ysflight-xrift (same engine): bytes 60 and
// 124 filled in within two minutes of the mission in every tab; a page could then stop
// answering inside YsSword::ConvexnizeGo.  With the flag they stay zero.
//
//   node scripts/lowmem-watch.mjs [dist-dir] [tabs] [seconds]
// Exit 0: every tab stayed clean and kept answering.  Exit 1 otherwise.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'dist');
const tabs = parseInt(process.argv[3] || '4', 10);
const seconds = parseInt(process.argv[4] || '240', 10);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.data': 'application/octet-stream', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, path.normalize(p));
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r)); // the system picks a free port
const url = `http://127.0.0.1:${server.address().port}/index.html?intercept=F-16C_FIGHTINGFALCON,ATSUGI_AIRBASE`;

const args = ['--autoplay-policy=no-user-gesture-required', ...(process.env.YSFW_CHROME_ARGS ? process.env.YSFW_CHROME_ARGS.split(' ') : [])];
const browser = await chromium.launch({ args });
const pages = [];
for (let k = 0; k < tabs; k++) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  // The engine does not export its heap: keep the memory object as it is instantiated.
  await page.addInitScript(() => {
    const keep = (r) => { const i = r.instance || r; const m = i.exports && Object.values(i.exports).find((v) => v instanceof WebAssembly.Memory); if (m) window.__ysfwMem = m; return r; };
    const a = WebAssembly.instantiate, b = WebAssembly.instantiateStreaming;
    WebAssembly.instantiate = function (...x) { return a.apply(this, x).then(keep); };
    if (b) WebAssembly.instantiateStreaming = function (...x) { return b.apply(this, x).then(keep); };
  });
  const logs = [];
  page.on('console', (m) => { logs.push(m.text().slice(0, 160)); if (logs.length > 8) logs.shift(); });
  page.on('pageerror', (e) => logs.push('[pageerror] ' + String(e).slice(0, 160)));
  await page.goto(url);
  pages.push({ page, logs, dirty: '', stuck: 0, stopped: false, flew: false, going: false });
}
console.log(`[lowmem] ${tabs} tabs, intercept mission, ${seconds} s (${root})`);
for (let i = 0; i < seconds / 5; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  for (const [k, t] of pages.entries()) {
    if (t.stopped) continue;
    const a = await Promise.race([
      // Bytes 0-3 are Emscripten's own marker at address zero ('emsc'); everything after must be zero.
      t.page.evaluate(() => { const m = window.__ysfwMem; if (!m) return 'no memory yet'; const h = new Uint8Array(m.buffer, 0, 1024); const d = []; for (let o = 4; o < 1024 && d.length < 24; o++) if (h[o] !== 0) d.push([o, h[o]]); return (globalThis.ysfwInFlight ? 'F' : '-') + (d.length ? JSON.stringify(d) : ''); }),
      new Promise((r) => setTimeout(() => r('NO ANSWER'), 3000)),
    ]);
    if (a === 'NO ANSWER') { if (++t.stuck >= 2) { t.stopped = true; console.log(`[lowmem] tab ${k} stopped answering at about +${(i + 1) * 5}s`); } continue; }
    t.stuck = 0;
    if (a === 'no memory yet') continue;
    if (a[0] === 'F') t.flew = true;
    // The intercept mission first shows its briefing ("Your Mission", one button): confirm it.
    if (!t.flew && i >= 2) { await t.page.mouse.click(20, 57).catch(() => {}); await t.page.keyboard.press('Enter').catch(() => {}); }
    // The flight opens behind "PRESS SPACE TO GO": let it go once.
    if (t.flew && !t.going) { t.going = true; await t.page.keyboard.press('Space').catch(() => {}); }
    const d = a.slice(1);
    if (d && !t.dirty) console.log(`[lowmem] tab ${k} at about +${(i + 1) * 5}s: not all zero, [offset, byte] ${d}`);
    if (d) t.dirty = d;
  }
}
const dirty = pages.filter((t) => t.dirty).length, stopped = pages.filter((t) => t.stopped).length, flew = pages.filter((t) => t.flew).length;
for (const [k, t] of pages.entries()) if (!t.flew) console.log(`[lowmem] tab ${k} never flew; its last lines: ${JSON.stringify(t.logs.slice(-4))}`);
console.log(`[lowmem] end: ${flew} of ${tabs} tabs flew; ${dirty} with something in the first kilobyte, ${stopped} stopped answering`);
await browser.close().catch(() => {});
server.close();
process.exit(dirty === 0 && stopped === 0 && flew === tabs ? 0 : 1);
