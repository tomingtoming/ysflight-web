// Unit tests for the Pack Studio's pure core (web/studio-pack-core.js): member
// snapshot namespacing, recipe round-trip (incl. backward compat with recipes
// written by older studios), and pack composition.  Plain node --test, like
// packs.test.mjs; the composed entries are fed through the real analyzer
// (packs.js analyzePack) to prove the studio's output stays installable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  sanitize, uniqueSan, namespaceSnapshot, buildRecipe, parseRecipe,
  composeEntries, fmtBytes, summarize, memberState, refreshPlan, memberFlight,
} from '../web/studio-pack-core.js';
import { RECIPE_FILE } from '../web/workbench.js';
import { analyzePack } from '../web/packs.js';
import { zipSync } from '../web/vendor/fflate.js';

const E = (s) => new TextEncoder().encode(s);
const D = (b) => new TextDecoder().decode(b);
const sha256 = (bytes) =>
  Promise.resolve(createHash('sha256').update(Buffer.from(bytes)).digest('hex'));

// A minimal aircraft-creation payload the way the aircraft studio ships it.
const aircraftFiles = () => [
  { path: 'aircraft/air_f15.lst', bytes: E('aircraft/f15.dat aircraft/f15.dnm aircraft/f15coll.srf\n') },
  { path: 'aircraft/f15.dat', bytes: E('IDENTIFY "WB_F15"\nCATEGORY "FIGHTER"\n') },
  { path: 'aircraft/f15.dnm', bytes: E('DNM') },
  { path: 'aircraft/f15coll.srf', bytes: E('SRF') },
];
const sceneryFiles = () => [
  { path: 'scenery/sce_isle.lst', bytes: E('WB_ISLE scenery/isle.fld scenery/isle.stp\n') },
  { path: 'scenery/isle.fld', bytes: E('FIELD') },
  { path: 'scenery/isle.stp', bytes: E('N START01') },
];
const mkMember = (name, kind, files, san) => ({ sourceId: 'src_' + name, san: san || sanitize(name), name, kind, files });

test('sanitize and uniqueSan produce collision-free member prefixes', () => {
  assert.equal(sanitize('My F-15! 改'), 'My_F-15');
  assert.equal(uniqueSan('f15', []), 'f15');
  assert.equal(uniqueSan('f15', ['f15']), 'f15_2');
  assert.equal(uniqueSan('f15', ['f15', 'f15_2']), 'f15_3');
});

test('namespaceSnapshot prefixes every file and keeps the air/sce/gro list lead', () => {
  const out = namespaceSnapshot(aircraftFiles(), 'eagle');
  const paths = out.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    'aircraft/air_eagle_f15.lst',
    'aircraft/eagle_f15.dat',
    'aircraft/eagle_f15.dnm',
    'aircraft/eagle_f15coll.srf',
  ]);
  // References inside the member's own .lst are rewritten to the new names.
  const lst = D(out.find((f) => /\.lst$/.test(f.path)).bytes);
  assert.equal(lst, 'aircraft/eagle_f15.dat aircraft/eagle_f15.dnm aircraft/eagle_f15coll.srf\n');
});

test('namespaceSnapshot: scenery list keeps its sce lead and rewritten quoted-safe refs', () => {
  const out = namespaceSnapshot(sceneryFiles(), 'isle');
  assert.ok(out.some((f) => f.path === 'scenery/sce_isle_isle.lst'));
  const lst = D(out.find((f) => /\.lst$/.test(f.path)).bytes);
  assert.equal(lst, 'WB_ISLE scenery/isle_isle.fld scenery/isle_isle.stp\n');
});

test('recipe round-trips through buildRecipe -> JSON -> parseRecipe', () => {
  const members = [
    { ...mkMember('F-15', 'aircraft', []), addedAt: 1700000000000 },
    mkMember('Isle', 'scenery', []), // no addedAt (legacy member) — stays null
  ];
  const back = parseRecipe(JSON.parse(JSON.stringify(buildRecipe('MyPack', members))));
  assert.equal(back.packName, 'MyPack');
  assert.deepEqual(back.members.map((m) => [m.sourceId, m.san, m.name, m.kind, m.addedAt]), [
    ['src_F-15', 'F-15', 'F-15', 'aircraft', 1700000000000],
    ['src_Isle', 'Isle', 'Isle', 'scenery', null],
  ]);
});

test('parseRecipe tolerates an old-studio recipe (missing optional fields)', () => {
  // Exactly the shape the pre-QoL studio wrote: no addedAt/credit/attribution.
  const old = { type: 'pack', packName: 'Legacy', members: [{ sourceId: 'a1', san: 'x', name: 'X', kind: 'aircraft' }] };
  const back = parseRecipe(old);
  assert.equal(back.packName, 'Legacy');
  assert.equal(back.members.length, 1);
  assert.equal(back.members[0].sourceId, 'a1');
});

test('composeEntries -> zip -> analyzePack: the studio output stays installable', async () => {
  const members = [
    mkMember('F-15', 'aircraft', namespaceSnapshot(aircraftFiles(), 'f15'), 'f15'),
    mkMember('Isle', 'scenery', namespaceSnapshot(sceneryFiles(), 'isle'), 'isle'),
  ];
  const entries = composeEntries(members, 'QoLPack');
  assert.ok(entries[RECIPE_FILE], 'recipe rides in the zip');
  const a = await analyzePack(zipSync(entries), { sha256, name: 'QoLPack', now: 1700000000000 });
  assert.deepEqual(a.categories.slice().sort(), ['aircraft', 'scenery']);
  // The recipe survives the analyzer as an ordinary payload file and parses back.
  const recipeHashed = a.hashed.find((h) => h.path === RECIPE_FILE);
  assert.ok(recipeHashed, 'recipe is content-hashed like everything else');
  const recipe = JSON.parse(D(a.files.find((f) => f.path === RECIPE_FILE).bytes));
  const back = parseRecipe(recipe);
  assert.equal(back.packName, 'QoLPack');
  assert.equal(back.members.length, 2);
});

test('composeEntries serializes an unchanged pack to identical recipe bytes (stable id)', () => {
  const members = [mkMember('F-15', 'aircraft', namespaceSnapshot(aircraftFiles(), 'f15'), 'f15')];
  const a = D(composeEntries(members, 'P')[RECIPE_FILE]);
  const b = D(composeEntries(members, 'P')[RECIPE_FILE]);
  assert.equal(a, b);
  // and matches the exact legacy shape, so re-saving an old pack is a no-op
  assert.equal(a, JSON.stringify({
    type: 'pack', packName: 'P',
    members: [{ sourceId: 'src_F-15', san: 'f15', name: 'F-15', kind: 'aircraft' }],
  }));
});

test('memberState: content-hash id comparison yields fresh / stale / orphan', () => {
  // Library newest-first, as listCreations returns it.
  const creations = [
    { id: 'new_f15', name: 'F-15', kind: 'aircraft' },
    { id: 'isle_1', name: 'Isle', kind: 'scenery' },
  ];
  // fresh: the member's snapshot id still exists (same content hash)
  assert.deepEqual(memberState({ sourceId: 'isle_1', name: 'Isle', kind: 'scenery' }, creations),
    { state: 'fresh', currentId: 'isle_1' });
  // stale: the id vanished (work was edited -> new content hash) but the same
  // name+kind creation exists — that successor is the ↺ target
  assert.deepEqual(memberState({ sourceId: 'old_f15', name: 'F-15', kind: 'aircraft' }, creations),
    { state: 'stale', currentId: 'new_f15' });
  // name matches but kind differs -> NOT a successor
  assert.deepEqual(memberState({ sourceId: 'old_x', name: 'Isle', kind: 'aircraft' }, creations),
    { state: 'orphan', currentId: null });
  // orphan: deleted work
  assert.deepEqual(memberState({ sourceId: 'gone', name: 'Zero', kind: 'aircraft' }, creations),
    { state: 'orphan', currentId: null });
});

test('refreshPlan drives the bulk-↺ summary (stale targets + counts)', () => {
  const creations = [
    { id: 'new_f15', name: 'F-15', kind: 'aircraft' },
    { id: 'isle_1', name: 'Isle', kind: 'scenery' },
  ];
  const members = [
    { sourceId: 'old_f15', name: 'F-15', kind: 'aircraft' }, // stale
    { sourceId: 'isle_1', name: 'Isle', kind: 'scenery' },   // fresh
    { sourceId: 'gone', name: 'Zero', kind: 'aircraft' },    // orphan
  ];
  const plan = refreshPlan(members, creations);
  assert.deepEqual(plan.stale, [{ index: 0, name: 'F-15', currentId: 'new_f15' }]);
  assert.deepEqual(plan.orphans, ['Zero']);
  assert.equal(plan.fresh, 1);
});

test('memberFlight reads launch targets from the snapshot bytes', () => {
  // aircraft: IDENTIFY from the namespaced .dat
  const air = mkMember('F-15', 'aircraft', namespaceSnapshot(aircraftFiles(), 'f15'));
  assert.deepEqual(memberFlight(air), { identities: ['WB_F15'], sceneryIdent: null });
  // scenery: the (possibly quoted) first token of the sce list
  const sce = mkMember('Isle', 'scenery', namespaceSnapshot(sceneryFiles(), 'isle'));
  assert.deepEqual(memberFlight(sce), { identities: [], sceneryIdent: 'WB_ISLE' });
  const quoted = mkMember('Q', 'scenery', [{ path: 'scenery/sce_q.lst', bytes: E('"MY FIELD" scenery/q.fld scenery/q.stp\n') }]);
  assert.equal(memberFlight(quoted).sceneryIdent, 'MY FIELD');
  // a .dat without an ASCII IDENTIFY yields no launchable identity
  const noIdn = mkMember('X', 'aircraft', [{ path: 'aircraft/x.dat', bytes: E('WEIGHCLN 5t\n') }]);
  assert.deepEqual(memberFlight(noIdn).identities, []);
});

test('fmtBytes / summarize', () => {
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(1536), '1.5 KB');
  const members = [mkMember('A', 'aircraft', [{ path: 'x', bytes: new Uint8Array(10) }, { path: 'y', bytes: new Uint8Array(5) }])];
  assert.deepEqual(summarize(members), { works: 1, files: 2, bytes: 15 });
});
