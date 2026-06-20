// Unit tests for the add-on pack engine (web/packs.js).  Runs in plain node
// with `node --test` (or scripts/test.sh) — no browser, no Emscripten.  The FS
// adapter is backed by a temp directory, and the realistic fixture is the
// `testpack.zip` community pack (two aircraft, model files under user/toming/,
// list paths in the wrong case, CRLF endings, and __MACOSX/.DS_Store cruft).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installPack, setEnabled, uninstall, analyzePack, analyzePackStreaming, _internals } from '../web/packs.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(here, 'fixtures', 'testpack.zip'));

const sha256 = (bytes) =>
  Promise.resolve(createHash('sha256').update(Buffer.from(bytes)).digest('hex'));

// A node-fs adapter rooted at a fresh temp dir = the YSFLIGHT user dir.
function makeAdapter() {
  const root = mkdtempSync(join(tmpdir(), 'ysfw-packs-'));
  const abs = (p) => join(root, p);
  return {
    root,
    async exists(p) {
      try {
        await fsp.access(abs(p));
        return true;
      } catch {
        return false;
      }
    },
    async mkdirp(p) {
      await fsp.mkdir(abs(p), { recursive: true });
    },
    async writeFile(p, bytes) {
      await fsp.mkdir(dirname(abs(p)), { recursive: true });
      await fsp.writeFile(abs(p), Buffer.from(bytes));
    },
    async readFile(p) {
      return new Uint8Array(await fsp.readFile(abs(p)));
    },
    async rename(from, to) {
      await fsp.mkdir(dirname(abs(to)), { recursive: true });
      await fsp.rename(abs(from), abs(to));
    },
    async rmrf(p) {
      await fsp.rm(abs(p), { recursive: true, force: true });
    },
  };
}

async function walk(dir) {
  const out = [];
  async function rec(d, prefix) {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await rec(join(d, e.name), rel);
      else out.push(rel);
    }
  }
  await rec(dir, '');
  return out;
}

test('installs the real toming pack into the isolated, registered layout', async () => {
  const fs = makeAdapter();
  const res = await installPack(FIXTURE, { fs, sha256, now: 1700000000000 });

  assert.match(res.id, /^[0-9a-f]{16}$/, 'pack id is a 16-hex content hash');
  assert.deepEqual(res.categories, ['aircraft']);
  assert.equal(res.templates, 2, 'amp + domo');
  assert.deepEqual(res.lists, [`aircraft/air${res.id}.lst`]);

  // The generated list is in the scanned dir and points into packs/<id>/.
  const listText = new TextDecoder().decode(await fs.readFile(`aircraft/air${res.id}.lst`));
  const lines = listText.split('\n').filter((l) => l.trim() !== '');
  assert.equal(lines.length, 2, 'one entry per aircraft');
  assert.ok(!listText.includes('\r'), 'CRLF normalized to LF');

  const prefix = `packs/${res.id}/user/toming/`;
  for (const line of lines) {
    for (const tok of line.split(/\s+/)) {
      assert.ok(tok.startsWith(prefix), `entry token rewritten under packs/<id>/: ${tok}`);
      assert.ok(await fs.exists(tok), `referenced file exists (case-resolved): ${tok}`);
    }
  }

  // Payload landed under packs/<id>/ with the original (lower) case + size.
  assert.ok(await fs.exists(`packs/${res.id}/user/toming/test1.dnm`));
  const amp = await fs.readFile(`packs/${res.id}/user/toming/test1.dnm`);
  assert.equal(amp.length, 122069);

  // No archive cruft made it to disk.
  const all = await walk(fs.root);
  assert.ok(!all.some((p) => p.includes('__MACOSX')), 'no __MACOSX');
  assert.ok(!all.some((p) => p.split('/').pop() === '.DS_Store'), 'no .DS_Store');

  // index.json records the install.
  const index = JSON.parse(new TextDecoder().decode(await fs.readFile('packs/index.json')));
  assert.equal(index.length, 1);
  assert.equal(index[0].id, res.id);
  assert.equal(index[0].enabled, true);
  assert.deepEqual(index[0].categories, ['aircraft']);

  // manifest.json carries per-file hashes.
  const manifest = JSON.parse(
    new TextDecoder().decode(await fs.readFile(`packs/${res.id}/manifest.json`)),
  );
  assert.equal(manifest.schema, 1);
  const ampEntry = manifest.files.find((f) => f.path === 'user/toming/test1.dnm');
  assert.ok(ampEntry, 'manifest lists test1.dnm');
  assert.equal(ampEntry.size, 122069);
  assert.match(ampEntry.sha256, /^[0-9a-f]{64}$/);
});

test('re-installing the same bytes is idempotent (same id, no duplicate index entry)', async () => {
  const fs = makeAdapter();
  const a = await installPack(FIXTURE, { fs, sha256, now: 1700000000000 });
  const b = await installPack(FIXTURE, { fs, sha256, now: 1700000000001 });
  assert.equal(a.id, b.id);
  const index = JSON.parse(new TextDecoder().decode(await fs.readFile('packs/index.json')));
  assert.equal(index.length, 1, 'no duplicate entry on re-install');
});

test('rejects an archive with no YSFLIGHT list', async () => {
  // a zip with one stray file and nothing the engine would scan
  const { zipSync } = await import('../web/vendor/fflate.js');
  const zip = zipSync({ 'readme.txt': new TextEncoder().encode('hello') });
  const fs = makeAdapter();
  await assert.rejects(() => installPack(zip, { fs, sha256 }), /no YSFLIGHT list/);
});

test('rejects path traversal in a pack', async () => {
  const { zipSync } = await import('../web/vendor/fflate.js');
  const zip = zipSync({
    'aircraft/airx.lst': new TextEncoder().encode('../../etc/x.dat ../../etc/x.dnm ../../etc/x.srf\n'),
    '../escape.dat': new TextEncoder().encode('x'),
  });
  const fs = makeAdapter();
  await assert.rejects(() => installPack(zip, { fs, sha256 }), /unsafe path/);
});

test('setEnabled toggles the generated list between .lst and .lst.off + index flag', async () => {
  const fs = makeAdapter();
  const r = await installPack(FIXTURE, { fs, sha256, now: 1700000000000 });
  const listPath = `aircraft/air${r.id}.lst`;
  assert.ok(await fs.exists(listPath));

  await setEnabled(r.id, false, { fs });
  assert.ok(!(await fs.exists(listPath)), '.lst removed when disabled');
  assert.ok(await fs.exists(listPath + '.off'), '.lst.off present when disabled');
  let idx = JSON.parse(new TextDecoder().decode(await fs.readFile('packs/index.json')));
  assert.equal(idx[0].enabled, false);

  await setEnabled(r.id, true, { fs });
  assert.ok(await fs.exists(listPath), '.lst restored when enabled');
  assert.ok(!(await fs.exists(listPath + '.off')));
  idx = JSON.parse(new TextDecoder().decode(await fs.readFile('packs/index.json')));
  assert.equal(idx[0].enabled, true);
});

test('uninstall removes the payload, generated lists, and index entry', async () => {
  const fs = makeAdapter();
  const r = await installPack(FIXTURE, { fs, sha256 });
  assert.ok(await fs.exists(`packs/${r.id}`));
  assert.ok(await fs.exists(`aircraft/air${r.id}.lst`));

  await uninstall(r.id, { fs });
  assert.ok(!(await fs.exists(`packs/${r.id}`)), 'payload subtree removed');
  assert.ok(!(await fs.exists(`aircraft/air${r.id}.lst`)), 'generated list removed');
  const idx = JSON.parse(new TextDecoder().decode(await fs.readFile('packs/index.json')));
  assert.equal(idx.length, 0, 'index entry removed');
});

test('uninstall also removes a disabled (.lst.off) list', async () => {
  const fs = makeAdapter();
  const r = await installPack(FIXTURE, { fs, sha256 });
  await setEnabled(r.id, false, { fs });
  assert.ok(await fs.exists(`aircraft/air${r.id}.lst.off`));

  await uninstall(r.id, { fs });
  assert.ok(!(await fs.exists(`aircraft/air${r.id}.lst.off`)), 'disabled list removed');
  assert.ok(!(await fs.exists(`packs/${r.id}`)));
});

test('scenery line: identifier and flight-mode kept, paths rewritten and quoted', () => {
  const files = [
    { path: 'scenery/race.fld', bytes: new Uint8Array() },
    { path: 'scenery/race.stp', bytes: new Uint8Array() },
  ];
  const resolve = _internals.buildResolver(files);
  const out = _internals.rewriteFieldLine(
    'RACING_VALLEY "scenery/race.fld" "scenery/race.stp" "" AIRRACE',
    resolve,
    'packs/abc123',
  );
  assert.equal(
    out.line,
    'RACING_VALLEY "packs/abc123/scenery/race.fld" "packs/abc123/scenery/race.stp" "" AIRRACE',
  );
  assert.equal(out.resolved, 2);
});

test('ground line: every token rewritten case-insensitively', () => {
  const files = [
    { path: 'ground/tower.dat', bytes: new Uint8Array() },
    { path: 'ground/tower.srf', bytes: new Uint8Array() },
  ];
  const resolve = _internals.buildResolver(files);
  // referenced with the wrong case, as real packs do
  const out = _internals.rewriteFilesLine('Ground/Tower.dat Ground/Tower.srf Ground/Tower.srf', resolve, 'packs/p');
  assert.equal(out.line, 'packs/p/ground/tower.dat packs/p/ground/tower.srf packs/p/ground/tower.srf');
  assert.equal(out.missing, 0);
});

// --- analyzePack / analyzePackStreaming parity -------------------------------
// The live UI installs via analyzePackStreaming (packs-ui.js installCore); the
// node corpus regression and installPack use analyzePack.  They are two separate
// implementations sharing chooseLayout/buildGeneratedLists, so a future edit could
// silently desync the content-addressed pack-id between them -- which would break
// OPFS dedup, multiplayer manifest matching, and idempotent re-install.  These
// tests pin them together.

const E = (s) => new TextEncoder().encode(s);
function memPutBlob() {
  const blobs = new Map();
  return async (hash, bytes) => { if (blobs.has(hash)) return false; blobs.set(hash, bytes); return true; };
}
async function assertParity(label, zip) {
  const p = await analyzePack(zip, { sha256, name: label, now: 1700000000000 });
  const s = await analyzePackStreaming(zip, { sha256, putBlob: memPutBlob(), name: label, now: 1700000000000 });
  assert.equal(s.id, p.id, `${label}: same content-addressed id`);
  assert.deepEqual(s.categories, p.categories, `${label}: same categories`);
  assert.deepEqual(s.hashed.map((h) => h.path), p.hashed.map((h) => h.path), `${label}: same (rerooted) paths`);
  assert.equal(s.total, p.total, `${label}: same total bytes`);
  assert.deepEqual(
    s.generated.map((g) => [g.category, g.file, g.text]),
    p.generated.map((g) => [g.category, g.file, g.text]),
    `${label}: same generated lists`,
  );
}

test('analyzePack and analyzePackStreaming produce identical results (parity)', async () => {
  const { zipSync } = await import('../web/vendor/fflate.js');
  // the real community fixture (wrapper-ish layout, wrong-case refs, CRLF, cruft)
  await assertParity('testpack.zip', FIXTURE);
  // standard aircraft layout
  await assertParity('standard', zipSync({
    'aircraft/air_x.lst': E('aircraft/x.dnm aircraft/x.srf aircraft/x.dat\n'),
    'aircraft/x.dnm': E('DNM'), 'aircraft/x.srf': E('SRF'), 'aircraft/x.dat': E('DAT'),
  }));
  // single wrapper folder (Phase 1 reroot)
  await assertParity('wrapper', zipSync({
    'MyPack/aircraft/air_x.lst': E('aircraft/x.dnm aircraft/x.srf aircraft/x.dat\n'),
    'MyPack/aircraft/x.dnm': E('DNM'), 'MyPack/aircraft/x.srf': E('SRF'), 'MyPack/aircraft/x.dat': E('DAT'),
  }));
  // non-standard list location detected by filename (Phase 2 reroot + resolution gate)
  await assertParity('nonstd-list', zipSync({
    'air_x.lst': E('x.dnm x.srf x.dat\n'),
    'x.dnm': E('DNM'), 'x.srf': E('SRF'), 'x.dat': E('DAT'),
  }));
});

test('both analyze paths reject a ".." wrapper identically (traversal parity)', async () => {
  const { zipSync } = await import('../web/vendor/fflate.js');
  // Every file sits under a ".." top dir.  candidatePrefixes can strip that wrapper,
  // so a check on POST-reroot paths alone (the old analyzePack behaviour) accepted
  // this while the streaming UI path rejected it -- same bytes, opposite outcome.
  const zip = zipSync({
    '../aircraft/air_x.lst': E('aircraft/x.dnm aircraft/x.srf aircraft/x.dat\n'),
    '../aircraft/x.dnm': E('DNM'), '../aircraft/x.srf': E('SRF'), '../aircraft/x.dat': E('DAT'),
  });
  await assert.rejects(() => analyzePack(zip, { sha256, name: 'dotdot' }), /unsafe path/);
  await assert.rejects(() => analyzePackStreaming(zip, { sha256, putBlob: memPutBlob(), name: 'dotdot' }), /unsafe path/);
});

test('both analyze paths reject a no-list archive identically', async () => {
  const { zipSync } = await import('../web/vendor/fflate.js');
  const zip = zipSync({ 'readme.txt': E('hello') });
  await assert.rejects(() => analyzePack(zip, { sha256, name: 'x' }), /no YSFLIGHT list/);
  await assert.rejects(() => analyzePackStreaming(zip, { sha256, putBlob: memPutBlob(), name: 'x' }), /no YSFLIGHT list/);
});
