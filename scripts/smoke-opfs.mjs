// OPFS content-addressed pack-store smoke test (real browser, via Playwright).
//
// Serves web/ and verifies, in a real secure context, the foundation of the
// Path-A OPFS pack store (web/opfs-store.js + analyzePack in web/packs.js):
//   - file-level dedup: a file shared by two packs is stored once
//   - re-install of the same pack is fully deduped
//   - materialize() writes payload + generated lists into a (mock) engine FS
//   - gc() reclaims only blobs no longer referenced by any pack (refcount)
//
// Run: node scripts/smoke-opfs.mjs   (needs playwright; CI installs it)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { zipSync } from '../web/vendor/fflate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };

const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const f = path.join(WEB, p);
  if (!f.startsWith(WEB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const E = (s) => new TextEncoder().encode(s);
// Two minimal valid aircraft packs that SHARE aircraft/shared.dnm (byte-identical).
const SHARED = E('shared geometry bytes -- identical across packs');
const packA = zipSync({ 'aircraft/air_a.lst': E('aircraft/shared.dnm aircraft/a.srf aircraft/a.dat\n'), 'aircraft/shared.dnm': SHARED, 'aircraft/a.srf': E('A surface'), 'aircraft/a.dat': E('A data') });
const packB = zipSync({ 'aircraft/air_b.lst': E('aircraft/shared.dnm aircraft/b.srf aircraft/b.dat\n'), 'aircraft/shared.dnm': SHARED, 'aircraft/b.srf': E('B surface'), 'aircraft/b.dat': E('B data') });

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto(`http://localhost:${port}/index.html`, { waitUntil: 'domcontentloaded' });

const r = await page.evaluate(async ({ aBytes, bBytes }) => {
  const opfs = await import('/opfs-store.js');
  const { analyzePack } = await import('/packs.js');
  const sha256 = async (u8) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', u8)))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const A = await analyzePack(new Uint8Array(aBytes), { sha256, name: 'A' });
  const B = await analyzePack(new Uint8Array(bBytes), { sha256, name: 'B' });
  const sharedHash = A.hashed.find((h) => h.path === 'aircraft/shared.dnm').sha256;

  const sa = await opfs.storeAnalyzedPack(A);
  const sb = await opfs.storeAnalyzedPack(B);   // shared.dnm must dedup
  const sa2 = await opfs.storeAnalyzedPack(A);  // re-store -> full dedup

  const writes = {};
  const adapter = { async mkdirp() {}, async writeFile(p, b) { writes[p] = b.length; }, async exists() { return false; } };
  await opfs.materialize(await opfs.getRecord(A.id), adapter);

  const list = await opfs.listRecords();
  const gc1 = await opfs.gc();                   // both referenced -> 0
  await opfs.removeRecord(B.id);
  const gc2 = await opfs.gc();                   // B-only blobs gone, shared stays
  const sharedStill = await opfs.hasBlob(sharedHash);

  return { aFiles: A.hashed.length, bFiles: B.hashed.length, saNew: sa.newBlobs, sbNew: sb.newBlobs, sa2New: sa2.newBlobs,
    matKeys: Object.keys(writes), aId: A.id, listCount: list.length, gc1: gc1.removed, gc2: gc2.removed, sharedStill };
}, { aBytes: Array.from(packA), bBytes: Array.from(packB) });

await browser.close();
await new Promise((res) => server.close(res));

const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); console.log((c ? 'ok   - ' : 'FAIL - ') + m); };
ok(r.aFiles === 4 && r.bFiles === 4, 'each pack has 4 files');
ok(r.saNew === 4, 'pack A stores 4 fresh blobs');
ok(r.sbNew === 3, 'pack B dedups the shared file (3 new blobs)');
ok(r.sa2New === 0, 're-install is fully deduped');
ok(r.matKeys.includes('packs/' + r.aId + '/aircraft/shared.dnm'), 'materialize writes payload into the engine FS');
ok(r.matKeys.some((k) => /aircraft\/air[0-9a-f]+\.lst$/.test(k)), 'materialize writes the generated air<id>.lst');
ok(r.listCount === 2, 'two pack records listed');
ok(r.gc1 === 0, 'gc keeps blobs while referenced');
ok(r.gc2 === 3 && r.sharedStill, 'gc reclaims only unreferenced blobs (shared survives)');

if (fails.length) { console.error('\n' + fails.length + ' OPFS store check(s) FAILED'); process.exit(1); }
console.log('\nOPFS store smoke: all checks passed');
