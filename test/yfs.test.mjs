// Unit tests for web/yfs.js — the .yfs flight generator.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../web/yfs.js';

const { buildYfs, YFS_VERSION } = globalThis.ysfwYfs;

test('minimal solo flight', () => {
  const yfs = buildYfs({
    field: 'SMALL_MAP',
    aircraft: [{ id: 'F-15J_EAGLE', player: true, startPos: 'RW36_01' }],
  });
  assert.equal(yfs, [
    'YFSVERSI ' + YFS_VERSION,
    'FIELDNAM SMALL_MAP 0 0 0 0 0 0 TRUE LOADAIR:FALSE',
    'ENVIRONM DAY',
    'ALLOWGUN TRUE', 'ALLOWAAM TRUE', 'ALLOWAGM TRUE', 'ALLOWBOM TRUE', 'ALLOWRKT TRUE',
    'AIRPLANE F-15J_EAGLE TRUE',
    'STARTPOS NA RW36_01',
    'IDENTIFY 0',
    '',
  ].join('\n'));
});

test('player + enemy with night + weapon restrictions', () => {
  const yfs = buildYfs({
    field: 'HAWAII',
    env: 'NIGHT',
    weapons: { gun: true, aam: true, agm: false, bomb: false, rocket: false },
    aircraft: [
      { id: 'F-18C_HORNET', player: true, startPos: 'NORTH10000_01' },
      { id: 'MIG-29_FULCRUM', player: false, iff: 1, startPos: 'SOUTH10000_01' },
    ],
  });
  const lines = yfs.trimEnd().split('\n');
  assert.equal(lines[2], 'ENVIRONM NIGHT');
  assert.equal(lines[5], 'ALLOWAGM FALSE');
  assert.equal(lines[6], 'ALLOWBOM FALSE');
  assert.equal(lines[7], 'ALLOWRKT FALSE');
  assert.deepEqual(lines.slice(8), [
    'AIRPLANE F-18C_HORNET TRUE', 'STARTPOS NA NORTH10000_01', 'IDENTIFY 0',
    'AIRPLANE MIG-29_FULCRUM FALSE', 'STARTPOS NA SOUTH10000_01', 'IDENTIFY 1',
  ]);
});

test('iff is clamped to 0..3 and non-player defaults to 1', () => {
  const yfs = buildYfs({
    field: 'F',
    aircraft: [
      { id: 'P', player: true },
      { id: 'E1', player: false },            // default iff 1
      { id: 'E2', player: false, iff: 9 },    // clamp to 3
    ],
  });
  const idents = yfs.trimEnd().split('\n').filter((l) => l.startsWith('IDENTIFY'));
  assert.deepEqual(idents, ['IDENTIFY 0', 'IDENTIFY 1', 'IDENTIFY 3']);
});

test('startPos defaults to an airborne start when omitted', () => {
  const yfs = buildYfs({ field: 'F', aircraft: [{ id: 'P', player: true }] });
  assert.match(yfs, /STARTPOS NA NORTH10000_01/);
});

test('identifiers and start positions are sanitized against injection', () => {
  const yfs = buildYfs({
    field: 'F\nAIRPLANE evil TRUE',
    aircraft: [{ id: 'P x', player: true, startPos: 'RW01\n IDENTIFY 3' }],
  });
  // The real security property: newlines/spaces are stripped, so a spec value
  // cannot inject a NEW command line.  (The stripped chars collapse the token,
  // which the engine then just fails to resolve — harmless.)
  assert.equal((yfs.match(/^AIRPLANE /gm) || []).length, 1);
  assert.equal((yfs.match(/^IDENTIFY /gm) || []).length, 1);
  assert.match(yfs, /STARTPOS NA RW01IDENTIFY3/);
});

test('rejects specs that could not boot', () => {
  assert.throws(() => buildYfs({ aircraft: [{ id: 'P', player: true }] }), /field is required/);
  assert.throws(() => buildYfs({ field: 'F', aircraft: [] }), /at least one aircraft/);
  assert.throws(() => buildYfs({ field: 'F', aircraft: [{ id: 'A', player: false }] }), /exactly one player/);
  assert.throws(() => buildYfs({ field: 'F', aircraft: [
    { id: 'A', player: true }, { id: 'B', player: true },
  ] }), /exactly one player/);
});

// ---- Ground objects (web-shell increment 8) ---------------------------------

const PLAYER = [{ id: 'P', player: true }];

test('ground objects emit the engine save grammar after the aircraft', () => {
  const yfs = buildYfs({ field: 'F', aircraft: PLAYER, ground: [
    { id: 'AAA', x: 3792, y: 1, z: 1325, h: 180, iff: 1 },
  ] });
  assert.match(yfs, /GROUNDOB AAA FALSE\nIDENTIFY 1\nGNDPOSIT 3792m 1m 1325m\nGNDATTIT 180deg 0deg 0deg\n/);
  // Ground blocks come after the airplane block, mirroring FsSimulation::Save.
  assert.ok(yfs.indexOf('AIRPLANE ') < yfs.indexOf('GROUNDOB '));
});

test('ground positions are rounded to 2 decimals; heading defaults to 0', () => {
  const yfs = buildYfs({ field: 'F', aircraft: PLAYER, ground: [
    { id: 'ASPAM', x: 1.005, y: 0.333, z: -2.999 },
  ] });
  assert.match(yfs, /GNDPOSIT 1m 0\.33m -3m/);
  assert.match(yfs, /GNDATTIT 0deg 0deg 0deg/);
  assert.match(yfs, /GROUNDOB ASPAM FALSE\nIDENTIFY 1\n/);  // iff defaults hostile
});

test('ground identifiers are sanitized and bad entries throw', () => {
  const yfs = buildYfs({ field: 'F', aircraft: PLAYER, ground: [
    { id: 'AAA\nGROUNDOB evil', x: 0, y: 0, z: 0 },
  ] });
  assert.equal((yfs.match(/^GROUNDOB /gm) || []).length, 1);
  assert.throws(() => buildYfs({ field: 'F', aircraft: PLAYER, ground: [{ x: 0, y: 0, z: 0 }] }), /has no id/);
  assert.throws(() => buildYfs({ field: 'F', aircraft: PLAYER, ground: [{ id: 'AAA', x: 'junk', y: 0, z: 0 }] }), /non-numeric position/);
});

test('no ground key -> no GROUNDOB lines (back-compat)', () => {
  assert.doesNotMatch(buildYfs({ field: 'F', aircraft: PLAYER }), /GROUNDOB/);
});
