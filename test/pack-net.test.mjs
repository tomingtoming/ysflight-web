// Unit tests for the v2 multiplayer pack-distribution core (web/pack-net.js).
// Pure functions only (no WebRTC/WS yet — that arrives in M5); runs under
// `node --test` / scripts/test.sh.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { derivePackRoom, buildRoomManifest, diffManifest, prioritizeMissing } from '../web/pack-net.js';

test('derivePackRoom: distinct from the game room and within 16 chars', () => {
  assert.equal(derivePackRoom('12345678'), '12345678~p'); // typical 8-digit web room
  assert.notEqual(derivePackRoom('12345678'), '12345678'); // must not collide with the engine room
  assert.ok(derivePackRoom('1234567890123456').length <= 16); // long room stays within the Worker cap
  assert.equal(derivePackRoom('').length <= 16, true);
});

test('buildRoomManifest: advertises only enabled packs with per-file hashes', async () => {
  const index = [
    { id: 'aaaa', name: 'alpha', enabled: true, categories: ['aircraft'] },
    { id: 'bbbb', name: 'beta', enabled: false, categories: ['scenery'] }, // disabled -> excluded
    { id: 'cccc', name: 'gamma', enabled: true, categories: ['scenery'] },
  ];
  const manifests = {
    aaaa: { files: [{ path: 'packs/aaaa/x.dnm', size: 10, sha256: 'h1' }], sourceUrl: 'https://e/x.zip' },
    cccc: { files: [{ path: 'packs/cccc/y.fld', size: 20, sha256: 'h2' }] },
  };
  const room = await buildRoomManifest({
    list: async () => index,
    readManifestJson: async (id) => manifests[id] || null,
  });
  assert.deepEqual(room.map((p) => p.id), ['aaaa', 'cccc']); // beta (disabled) excluded
  assert.deepEqual(room[0].files, [{ path: 'packs/aaaa/x.dnm', size: 10, sha256: 'h1' }]);
  assert.equal(room[0].sourceUrl, 'https://e/x.zip');
  assert.equal(room[1].sourceUrl, undefined); // no URL -> omitted
  assert.deepEqual(room[1].categories, ['scenery']);
});

test('diffManifest: missing by id, present by id, same-name/different-id conflict', () => {
  const roomManifest = [
    { id: 'A', name: 'alpha', categories: ['aircraft'] },
    { id: 'B', name: 'beta', categories: ['scenery'] },
    { id: 'C2', name: 'gamma', categories: ['aircraft'] }, // joiner has gamma but as id C1
  ];
  const localIndex = [
    { id: 'A', name: 'alpha' }, // already present (same id)
    { id: 'C1', name: 'gamma' }, // same NAME, different id -> conflict
  ];
  const { missing, present, conflicts } = diffManifest(roomManifest, localIndex);
  assert.deepEqual(present, ['A']);
  assert.deepEqual(missing.map((p) => p.id).sort(), ['B', 'C2']);
  assert.deepEqual(conflicts, [{ hostId: 'C2', hostName: 'gamma', localId: 'C1' }]);
});

test('diffManifest: identical sets -> nothing missing', () => {
  const m = [{ id: 'A', name: 'a', categories: [] }];
  const { missing, present, conflicts } = diffManifest(m, [{ id: 'A', name: 'a' }]);
  assert.equal(missing.length, 0);
  assert.deepEqual(present, ['A']);
  assert.equal(conflicts.length, 0);
});

test('prioritizeMissing: field/scenery packs are required-first, others best-effort', () => {
  const missing = [
    { id: 'air1', categories: ['aircraft'] },
    { id: 'fld1', categories: ['scenery'] },
    { id: 'gnd1', categories: ['ground'] },
  ];
  const { required, bestEffort } = prioritizeMissing(missing);
  assert.deepEqual(required.map((p) => p.id), ['fld1']);
  assert.deepEqual(bestEffort.map((p) => p.id).sort(), ['air1', 'gnd1']);
});
