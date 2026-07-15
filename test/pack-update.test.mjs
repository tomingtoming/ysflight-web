// Unit tests for the update-from-zip core (web/pack-update.js): manifest diff,
// two-phase prepare/commit against an in-memory content-addressed store, and
// the state carry-over rules (name / enabled / sourceUrl / attribution).
// Plain node --test like packs.test.mjs; the store is a faithful mock of the
// opfs-store surface pack-update touches (putBlob/getBlob/putRecord/
// removeRecord/gc with real reference-counted blob sweeping).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { diffPackFiles, prepareUpdate, commitUpdate } from '../web/pack-update.js';
import { recordFromAnalysis } from '../web/opfs-store.js';
import { analyzePackStreaming } from '../web/packs.js';
import { RECIPE_FILE } from '../web/workbench.js';
import { zipSync } from '../web/vendor/fflate.js';

const E = (s) => new TextEncoder().encode(s);
const sha256 = (bytes) =>
  Promise.resolve(createHash('sha256').update(Buffer.from(bytes)).digest('hex'));

// In-memory store with the exact surface pack-update uses.  gc() really sweeps
// blobs unreferenced by any record, so retirement is asserted, not assumed.
function memStore() {
  const blobs = new Map();
  const records = new Map();
  return {
    blobs, records, gcRuns: 0,
    putBlob: async (h, b) => { if (!blobs.has(h)) blobs.set(h, b.slice()); },
    getBlob: async (h) => {
      if (!blobs.has(h)) throw new Error('no blob ' + h);
      return blobs.get(h);
    },
    putRecord: async (r) => { records.set(r.id, r); },
    removeRecord: async (id) => { records.delete(id); },
    async gc() {
      this.gcRuns++;
      const referenced = new Set();
      for (const r of records.values()) for (const f of r.files || []) referenced.add(f.sha256);
      for (const h of [...blobs.keys()]) if (!referenced.has(h)) blobs.delete(h);
    },
  };
}

// Minimal installable aircraft zips: v1, v2 (edited dnm + added cockpit,
// dropped nothing except what each test says).
const DAT = 'IDENTIFY "UPD_TEST"\nCATEGORY FIGHTER\n';
const zipV1 = (extra = {}) => zipSync({
  'aircraft/air_p.lst': E('user/p/p.dat user/p/p.dnm user/p/pcoll.srf\n'),
  'user/p/p.dat': E(DAT),
  'user/p/p.dnm': E('DNM v1'),
  'user/p/pcoll.srf': E('SRF'),
  ...extra,
});
const zipV2 = (extra = {}) => zipSync({
  'aircraft/air_p.lst': E('user/p/p.dat user/p/p.dnm user/p/pcockpit.srf\n'),
  'user/p/p.dat': E(DAT),
  'user/p/p.dnm': E('DNM v2 -- repainted'),   // changed
  'user/p/pcockpit.srf': E('COCKPIT'),        // added
  ...extra,                                    // (pcoll.srf removed)
});

// Install v1 into the store the way the live path does, returning its record.
async function installOld(store, name, patch = {}) {
  const a = await analyzePackStreaming(zipV1(patch.zipExtra || {}), {
    sha256, putBlob: store.putBlob, name,
  });
  const rec = { ...recordFromAnalysis(a, patch.enabled !== false), ...patch.record };
  await store.putRecord(rec);
  return rec;
}

test('diffPackFiles: added / removed / changed / unchanged by path+sha', () => {
  const oldF = [
    { path: 'a', sha256: '1' }, { path: 'b', sha256: '2' }, { path: 'c', sha256: '3' },
  ];
  const newF = [
    { path: 'a', sha256: '1' },   // unchanged
    { path: 'b', sha256: '9' },   // changed
    { path: 'd', sha256: '4' },   // added
  ];                              // c removed
  const d = diffPackFiles(oldF, newF);
  assert.deepEqual(d, { added: ['d'], removed: ['c'], changed: ['b'], unchanged: 1 });
  assert.deepEqual(diffPackFiles([], []), { added: [], removed: [], changed: [], unchanged: 0 });
});

test('prepareUpdate: diff against the old record, name identity preserved', async () => {
  const store = memStore();
  const oldRec = await installOld(store, 'mypack');
  const prep = await prepareUpdate(oldRec, zipV2(), { sha256, store });
  assert.equal(prep.sameId, false);
  assert.equal(prep.analysis.name, 'mypack', 'zip name never overrides the pack identity');
  assert.deepEqual(prep.diff.added, ['user/p/pcockpit.srf']);
  assert.deepEqual(prep.diff.removed, ['user/p/pcoll.srf']);
  assert.deepEqual(prep.diff.changed.sort(), ['aircraft/air_p.lst', 'user/p/p.dnm']);
  assert.equal(prep.diff.unchanged, 1); // the untouched .dat
});

test('prepareUpdate: identical bytes -> sameId (nothing to update)', async () => {
  const store = memStore();
  const oldRec = await installOld(store, 'mypack');
  const prep = await prepareUpdate(oldRec, zipV1(), { sha256, store });
  assert.equal(prep.sameId, true);
  assert.equal(prep.diff.added.length + prep.diff.removed.length + prep.diff.changed.length, 0);
});

test('commitUpdate: successor written, old id retired, orphan blobs GC-able and swept', async () => {
  const store = memStore();
  const oldRec = await installOld(store, 'mypack');
  const oldDnmSha = oldRec.files.find((f) => f.path === 'user/p/p.dnm').sha256;
  const prep = await prepareUpdate(oldRec, zipV2(), { sha256, store });
  const rec = await commitUpdate(oldRec, prep.analysis, { store });

  assert.notEqual(rec.id, oldRec.id);
  assert.equal(store.records.has(oldRec.id), false, 'old record retired');
  assert.equal(store.records.get(rec.id).name, 'mypack');
  assert.equal(rec.enabled, true, 'enabled state carried');
  // The old dnm's blob is unreferenced after retirement and swept by gc();
  // the unchanged .dat blob is shared and survives.
  assert.equal(store.blobs.has(oldDnmSha), false, 'orphan blob reclaimed');
  const datSha = rec.files.find((f) => f.path === 'user/p/p.dat').sha256;
  assert.ok(store.blobs.has(datSha), 'shared blob survives gc');
  assert.ok(store.gcRuns >= 1);
});

test('commitUpdate: disabled stays disabled; sourceUrl carried when absent', async () => {
  const store = memStore();
  const oldRec = await installOld(store, 'mypack', {
    record: { enabled: false, sourceUrl: 'https://example.com/mypack.zip' },
  });
  const prep = await prepareUpdate(oldRec, zipV2(), { sha256, store });
  const rec = await commitUpdate(oldRec, prep.analysis, { store });
  assert.equal(rec.enabled, false);
  assert.equal(rec.sourceUrl, 'https://example.com/mypack.zip');
});

test('commitUpdate: attribution carried onto the record when the new zip has no recipe', async () => {
  const store = memStore();
  const attribution = { author: 'toming', policy: 'redist-nomod', terms: '', url: '' };
  const recipe = JSON.stringify({ type: 'pack', packName: 'mypack', members: [], attribution });
  const oldRec = await installOld(store, 'mypack', {
    zipExtra: { [RECIPE_FILE]: E(recipe) },
  });
  const prep = await prepareUpdate(oldRec, zipV2(), { sha256, store }); // v2: no recipe
  assert.equal(prep.newHasRecipe, false);
  const rec = await commitUpdate(oldRec, prep.analysis, { store });
  assert.deepEqual(rec.attribution, attribution);

  // A previously-carried record-level attribution survives a second update too.
  const prep2 = await prepareUpdate(rec, zipV1(), { sha256, store });
  const rec2 = await commitUpdate(rec, prep2.analysis, { store });
  assert.deepEqual(rec2.attribution, attribution);
});

test('commitUpdate: a new zip WITH a recipe is the authority — no attribution carry', async () => {
  const store = memStore();
  const attribution = { author: 'toming', policy: 'no-redist', terms: '', url: '' };
  const oldRecipe = JSON.stringify({ type: 'pack', packName: 'mypack', members: [], attribution });
  const oldRec = await installOld(store, 'mypack', { zipExtra: { [RECIPE_FILE]: E(oldRecipe) } });
  const newRecipe = JSON.stringify({ type: 'pack', packName: 'mypack', members: [] }); // deliberately none
  const prep = await prepareUpdate(oldRec, zipV2({ [RECIPE_FILE]: E(newRecipe) }), { sha256, store });
  assert.equal(prep.newHasRecipe, true);
  assert.equal(prep.newRecipeType, 'pack');
  const rec = await commitUpdate(oldRec, prep.analysis, { store });
  assert.equal(rec.attribution, undefined, 'content recipe wins, even when empty');
});

test('cancel path: prepared blobs are orphans that gc() reclaims', async () => {
  const store = memStore();
  const oldRec = await installOld(store, 'mypack');
  const before = store.blobs.size;
  await prepareUpdate(oldRec, zipV2(), { sha256, store });
  assert.ok(store.blobs.size > before, 'prepare streamed new blobs in');
  await store.gc(); // what the UI does on cancel
  assert.equal(store.blobs.size, before, 'cancel leaves the store as it was');
});
