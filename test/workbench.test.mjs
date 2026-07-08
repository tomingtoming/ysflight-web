// Unit tests for the browser workbench core (web/workbench.js): classify a
// loose-file pile into aircraft slots, assemble a normal-form zip, and prove
// the result round-trips through the EXISTING import pipeline (analyzePack)
// with the aircraft registered and its .lst.idx sidecar carrying IDENTIFY.
// The loose fixture is peeled out of testpack.zip (real .dat/.dnm/.srf bytes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyLoose, assembleAircraftZip } from '../web/workbench.js';
import { analyzePack } from '../web/packs.js';
import { unzipSync } from '../web/vendor/fflate.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = unzipSync(readFileSync(join(here, 'fixtures', 'testpack.zip')));

const sha256 = (bytes) =>
  Promise.resolve(createHash('sha256').update(Buffer.from(bytes)).digest('hex'));

// Loose files as a user would drop them: basenames only, real bytes.
const loose = (path) => ({ name: path.split('/').pop(), bytes: FIXTURE[path] });
const test1 = {
  dat: loose('user/toming/test1.dat'),
  dnm: loose('user/toming/test1.dnm'),
  coll: loose('user/toming/test1coll.srf'),
};
const test2cockpit = loose('user/toming/test2cockpit.srf');

test('classifyLoose: stock naming conventions land in the right slots', () => {
  const { candidates, guess, ignored } = classifyLoose([
    test1.dat, test1.dnm, test1.coll, test2cockpit,
    { name: 'readme.txt', bytes: new Uint8Array([65]) },
  ]);
  assert.equal(guess.dat, 'test1.dat');
  assert.equal(guess.visual, 'test1.dnm');
  assert.equal(guess.collision, 'test1coll.srf');
  assert.equal(guess.cockpit, 'test2cockpit.srf');
  assert.equal(guess.coarse, null);
  assert.equal(candidates.srf.length, 2);
  assert.deepEqual(ignored, ['readme.txt']);
});

test('classifyLoose: two unhinted dnm -> larger is visual, smaller is coarse', () => {
  const big = { name: 'plane.dnm', bytes: new Uint8Array(1000) };
  const small = { name: 'plane2.dnm', bytes: new Uint8Array(100) };
  const { guess } = classifyLoose([test1.dat, big, small, test1.coll]);
  assert.equal(guess.visual, 'plane.dnm');
  assert.equal(guess.coarse, 'plane2.dnm');
});

test('assembleAircraftZip: required slots enforced', () => {
  assert.throws(() => assembleAircraftZip({ visual: test1.dnm, collision: test1.coll }), /missing \.dat/);
  assert.throws(() => assembleAircraftZip({ dat: test1.dat, collision: test1.coll }), /missing visual/);
  assert.throws(() => assembleAircraftZip({ dat: test1.dat, visual: test1.dnm }), /missing collision/);
});

test('assembleAircraftZip: coarse without cockpit is dropped with a warning', () => {
  const coarse = { name: 'test1coarse.dnm', bytes: FIXTURE['user/toming/test1.dnm'] };
  const asm = assembleAircraftZip({ dat: test1.dat, visual: test1.dnm, collision: test1.coll, coarse });
  assert.ok(asm.warnings.includes('coarse-needs-cockpit'));
  assert.equal(asm.lstLine.trim().split(/\s+/).length, 3); // dat dnm coll only
});

test('assemble -> analyzePack round-trip: aircraft registers with IDENTIFY sidecar', async () => {
  const asm = assembleAircraftZip({
    name: 'my Test Pack',
    dat: test1.dat, visual: test1.dnm, collision: test1.coll, cockpit: test2cockpit,
  });
  assert.equal(asm.identify, 'YSFW_TEST1');
  assert.equal(asm.packName, 'my_Test_Pack');
  assert.equal(asm.lstLine.trim().split(/\s+/).length, 4); // + cockpit

  const a = await analyzePack(asm.zipBytes, { sha256 });
  assert.deepEqual(a.categories, ['aircraft']);
  assert.match(a.id, /^[0-9a-f]{16}$/);
  const lst = a.generated.find((g) => !g.idx);
  assert.equal(lst.entries, 1);
  const idx = a.generated.find((g) => g.idx);
  assert.ok(idx, 'expected a .lst.idx sidecar (ASCII IDENTIFY present)');
  assert.match(idx.text, /\tYSFW_TEST1\tATTACKER\n/);
  // Nothing the assembled lists reference is missing.
  assert.equal(a.diagnostics.missing, 0);
  assert.ok(a.diagnostics.refs >= 4);
});

test('assemble is deterministic: same slots -> same pack id', async () => {
  const mk = () => assembleAircraftZip({ dat: test1.dat, visual: test1.dnm, collision: test1.coll });
  const [a, b] = [await analyzePack(mk().zipBytes, { sha256 }), await analyzePack(mk().zipBytes, { sha256 })];
  assert.equal(a.id, b.id);
});

test('analyzePack surfaces unresolved references as diagnostics', async () => {
  // A pack whose list references a file the archive does not contain.
  const { zipSync } = await import('../web/vendor/fflate.js');
  const zip = zipSync({
    'aircraft/air_broken.lst': new TextEncoder().encode('aircraft/ghost.dat aircraft/ghost.dnm aircraft/ghostcoll.srf\naircraft/real.dat aircraft/real.dnm aircraft/realcoll.srf\n'),
    'aircraft/real.dat': FIXTURE['user/toming/test1.dat'],
    'aircraft/real.dnm': FIXTURE['user/toming/test1.dnm'],
    'aircraft/realcoll.srf': FIXTURE['user/toming/test1coll.srf'],
  });
  const a = await analyzePack(zip, { sha256 });
  assert.equal(a.diagnostics.missing, 3);
  assert.ok(a.diagnostics.samples.includes('aircraft/ghost.dat'));
});
