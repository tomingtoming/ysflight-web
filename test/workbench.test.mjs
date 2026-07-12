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

import { classifyLoose, assembleAircraftZip, makeDatFromBase, sanitizeIdentify, assembleSceneryZip, SCENERY_START, extractDnmColors, repaintDnm } from '../web/workbench.js';
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

test('makeDatFromBase: renames IDENTIFY and scales knob keys in place', () => {
  const base = new TextEncoder().encode(
    'REM TEST BASE\nIDENTIFY "OLD_NAME"\nCATEGORY FIGHTER\nTHRAFTBN 22.6t\nTHRMILIT 16.0t\nWEIGHCLN 12.0t\nMAXSPEED 2.0MACH\nCPITMANE 8.0\nAFTBURNR TRUE\n',
  );
  const dat = makeDatFromBase(base, { identify: 'my kid plane', knobs: { engine: 2, weight: 0.5 } });
  assert.equal(dat.identify, 'MY_KID_PLANE');
  const text = new TextDecoder().decode(dat.bytes);
  assert.match(text, /^IDENTIFY "MY_KID_PLANE"$/m);
  assert.match(text, /^THRAFTBN 45.2t$/m);      // ×2, unit preserved
  assert.match(text, /^THRMILIT 32t$/m);         // ×2
  assert.match(text, /^WEIGHCLN 6t$/m);          // ×0.5
  assert.match(text, /^MAXSPEED 2.0MACH$/m);     // untouched knob (no speed scale)
  assert.match(text, /^CPITMANE 8.0$/m);         // untouched
  assert.match(text, /^AFTBURNR TRUE$/m);        // non-knob keys byte-identical
  assert.deepEqual(dat.applied.sort(), ['THRAFTBN', 'THRMILIT', 'WEIGHCLN']);
});

test('makeDatFromBase: real stock-shaped .dat from the fixture round-trips through analyzePack', async () => {
  const dat = makeDatFromBase(FIXTURE['user/toming/test1.dat'], { identify: 'WB_CUSTOM1', knobs: { engine: 1.5 } });
  assert.equal(dat.identify, 'WB_CUSTOM1');
  const asm = assembleAircraftZip({
    dat: { name: 'wb_custom1.dat', bytes: dat.bytes },
    visual: test1.dnm, collision: test1.coll,
  });
  assert.equal(asm.identify, 'WB_CUSTOM1');
  const a = await analyzePack(asm.zipBytes, { sha256 });
  const idx = a.generated.find((g) => g.idx);
  assert.match(idx.text, /\tWB_CUSTOM1\t/);
});

test('sanitizeIdentify mirrors the engine: space/quote -> _, uppercase, 31 chars', () => {
  assert.equal(sanitizeIdentify('my "cool" plane'), 'MY__COOL__PLANE');
  assert.equal(sanitizeIdentify('a'.repeat(40)).length, 31);
  assert.equal(sanitizeIdentify('日本語x'), '___X');
});

test('assembleSceneryZip: minimal ocean field round-trips through analyzePack as scenery', async () => {
  const asm = assembleSceneryZip({ name: 'My Island', ground: [40, 90, 60], sky: [23, 106, 189], startAltM: 800 });
  assert.equal(asm.ident, 'MY_ISLAND');
  const a = await analyzePack(asm.zipBytes, { sha256 });
  assert.deepEqual(a.categories, ['scenery']);
  assert.equal(a.diagnostics.missing, 0);
  const lst = a.generated.find((g) => !g.idx);
  assert.equal(lst.entries, 1);
  assert.match(lst.text, /^MY_ISLAND "packs\/[0-9a-f]{16}\/scenery\/my_island\.fld" "packs\/[0-9a-f]{16}\/scenery\/my_island\.stp"$/m);
  // The generated field/start files carry the wizard's values.
  const fld = new TextDecoder().decode(asm.zipBytes && (await import('../web/vendor/fflate.js')).unzipSync(asm.zipBytes)['scenery/my_island.fld']);
  assert.match(fld, /^FIELD$/m);
  assert.match(fld, /^GND 40 90 60$/m);
  assert.match(fld, /^SKY 23 106 189$/m);
  const stp = new TextDecoder().decode((await import('../web/vendor/fflate.js')).unzipSync(asm.zipBytes)['scenery/my_island.stp']);
  assert.match(stp, new RegExp('^N ' + SCENERY_START + '$', 'm'));
  assert.match(stp, /^C POSITION 0\.00m 800\.00m 0\.00m$/m);
});

test('assembleSceneryZip with islands: PC2 visual + PST AREA LAND, exact PCK line count', async () => {
  const tri = [[-500, -500], [500, -500], [0, 500]];
  const blob = [[-1000, 2000], [-800, 2400], [-400, 2500], [-200, 2100], [-600, 1900]];
  const asm = assembleSceneryZip({
    name: 'DRAWN', islands: [{ points: tri }, { points: blob, color: [200, 180, 120] }],
  });
  const { unzipSync } = await import('../web/vendor/fflate.js');
  const fld = new TextDecoder().decode(unzipSync(asm.zipBytes)['scenery/drawn.fld']);

  // PCK count must equal the embedded pc2 line count EXACTLY (loader counts
  // lines back to OUTSIDE state; a mismatch corrupts everything after it).
  const m = fld.match(/^PCK "00000000\.pc2" (\d+)$/m);
  assert.ok(m, 'PCK header present');
  const lines = fld.split('\n');
  const pckAt = lines.findIndex((l) => l.startsWith('PCK '));
  const declared = parseInt(m[1], 10);
  const embedded = lines.slice(pckAt + 1, pckAt + 1 + declared);
  assert.equal(embedded[0], 'Pict2');
  assert.equal(embedded[embedded.length - 1], 'ENDPICT');
  assert.equal(embedded.filter((l) => l === 'PLG').length, 2);
  assert.equal(embedded.filter((l) => l.startsWith('VER ')).length, tri.length + blob.length);
  assert.ok(embedded.includes('COL 200 180 120'), 'per-island color');

  // The visible polygon is referenced once, and each island gets a LAND loop.
  assert.match(fld, /^PC2\nFIL "00000000\.pc2"\nPOS 0\.00 0\.00 0\.00 0\.00 0\.00 0\.00\nID 0\nEND$/m);
  assert.equal((fld.match(/^AREA LAND$/gm) || []).length, 2);
  assert.equal((fld.match(/^PNT /gm) || []).length, tri.length + blob.length);
  assert.match(fld, /^PNT -500\.00 0\.00 -500\.00$/m);

  // Still a valid pack through the normal pipeline.
  const a = await analyzePack(asm.zipBytes, { sha256 });
  assert.deepEqual(a.categories, ['scenery']);
  assert.equal(a.diagnostics.missing, 0);

  // The start position moves upwind so the drawn islands sit ahead of the nose.
  const stp = new TextDecoder().decode(unzipSync(asm.zipBytes)['scenery/drawn.stp']);
  assert.match(stp, /^C POSITION 0\.00m 1000\.00m 6000\.00m$/m);
});

test('assembleSceneryZip without islands stays the proven 8-line header', async () => {
  const asm = assembleSceneryZip({ name: 'PLAIN' });
  const { unzipSync } = await import('../web/vendor/fflate.js');
  const fld = new TextDecoder().decode(unzipSync(asm.zipBytes)['scenery/plain.fld']);
  assert.doesNotMatch(fld, /PCK|PC2|PST/);
  assert.equal(fld.trim().split('\n').length, 8);
});

test('assembleSceneryZip rich: GOB objects, TER mountains, extra starts', async () => {
  const asm = assembleSceneryZip({
    name: 'RICH',
    islands: [{ points: [[-2000, -2000], [2000, -2000], [0, 2000]] }],
    objects: [
      { nam: 'AIRCRAFTCARRIER', x: 3000, z: -1000, headingDeg: 90 },
      { nam: 'ELEVATED_RUNWAY_1000X60', x: 0, z: 0 },
    ],
    mountains: [{ x: 500, z: -500, radiusM: 1000, heightM: 200 }],
    starts: [{ x: 3000, z: -1000, altM: 40, speedMS: 0, headingDeg: 180, name: 'DECK' }],
  });
  const { unzipSync } = await import('../web/vendor/fflate.js');
  const z = unzipSync(asm.zipBytes);
  const fld = new TextDecoder().decode(z['scenery/rich.fld']);
  const stp = new TextDecoder().decode(z['scenery/rich.stp']);

  // GOB: static placement (no MPN/MPS), heading in 32768=pi units (90deg -> 16384).
  assert.match(fld, /^GOB\nPOS 3000\.00 0\.00 -1000\.00 16384 0 0\nID 0\nTAG "WB_OBJ_0"\nNAM AIRCRAFTCARRIER\nIFF 0\nFLG 0\nEND$/m);
  assert.match(fld, /^NAM ELEVATED_RUNWAY_1000X60$/m);
  assert.doesNotMatch(fld, /^MPN /m);

  // TER: exact PCK line count, grid origin shifted by -radius to center it.
  const m = fld.match(/^PCK "00000000\.ter" (\d+)$/m);
  assert.ok(m, 'mountain PCK present');
  const lines = fld.split('\n');
  const at = lines.findIndex((l) => l.startsWith('PCK "00000000.ter"'));
  const declared = parseInt(m[1], 10);
  const ter = lines.slice(at + 1, at + 1 + declared);
  assert.equal(ter[0], 'TerrMesh');
  assert.equal(ter[ter.length - 1], 'END');
  assert.equal(ter.filter((l) => l.startsWith('BLO ')).length, 17 * 17);
  assert.ok(ter.includes('BLO 200.00 R 1 34 139 34 1 34 139 34'), 'peak node at full height');
  assert.match(fld, /^TER\nFIL "00000000\.ter"\nPOS -500\.00 0\.00 -1500\.00 0 0 0\nID 0\nEND$/m);

  // Extra start: named, low+slow => throttle 0, gear down.
  assert.match(stp, /^N DECK$/m);
  assert.match(stp, /^C POSITION 3000\.00m 40\.00m -1000\.00m$/m);
  assert.match(stp, /^C ATTITUDE 180\.00deg 0\.00deg 0\.00deg$/m);
  assert.match(stp, /^C CTLLDGEA TRUE$/m);
  assert.match(stp, /^N START01$/m); // the default start is still first

  // Still a valid pack through the normal pipeline.
  const a = await analyzePack(asm.zipBytes, { sha256 });
  assert.deepEqual(a.categories, ['scenery']);
  assert.equal(a.diagnostics.missing, 0);
});

test('assembleSceneryZip runways: pavement PLGs + landable pad + threshold spawn', async () => {
  const asm = assembleSceneryZip({
    name: 'RWY',
    runways: [{ x: 1000, z: -2000, headingDeg: 90, lengthM: 2000, widthM: 45 }],
  });
  const { unzipSync } = await import('../web/vendor/fflate.js');
  const z = unzipSync(asm.zipBytes);
  const fld = new TextDecoder().decode(z['scenery/rwy.fld']);
  const stp = new TextDecoder().decode(z['scenery/rwy.stp']);

  // Pavement rides the shared .pc2 even with zero islands, PCK count exact.
  const m = fld.match(/^PCK "00000000\.pc2" (\d+)$/m);
  assert.ok(m, 'pc2 PCK present');
  const lines = fld.split('\n');
  const at = lines.findIndex((l) => l.startsWith('PCK "00000000.pc2"'));
  const pc2 = lines.slice(at + 1, at + 1 + parseInt(m[1], 10));
  assert.equal(pc2[0], 'Pict2');
  assert.equal(pc2[pc2.length - 1], 'ENDPICT');
  // grey base + 2 threshold bars + centerline dashes
  assert.equal(pc2.filter((l) => l === 'COL 88 90 94').length, 1);
  assert.ok(pc2.filter((l) => l === 'COL 230 232 235').length >= 10);
  // heading 90 = runway along +X: base corners span x 0..2000 at z ~ -2000
  assert.ok(pc2.includes('VER 2000.00 -2022.50'), 'east end corner');
  assert.ok(pc2.includes('VER 0.00 -1977.50'), 'west end corner');

  // Landable pad: a PST AREA LAND loop with a 10m margin.
  assert.match(fld, /^PST\nISLOOP TRUE\nAREA LAND\nPNT 2010\.00 0\.00 -1967\.50$/m);

  // Threshold spawn: on the ground at the approach end, rolling heading 90.
  assert.match(stp, /^N RUNWAY01$/m);
  assert.match(stp, /^C POSITION 60\.00m 0\.00m -2000\.00m$/m);
  assert.match(stp, /^C ATTITUDE 90\.00deg 0\.00deg 0\.00deg$/m);
  assert.match(stp, /^C CTLLDGEA TRUE$/m);

  const a = await analyzePack(asm.zipBytes, { sha256 });
  assert.deepEqual(a.categories, ['scenery']);
  assert.equal(a.diagnostics.missing, 0);
});

test('makeDatFromBase extras: SET knobs replace-or-append, smoke gets a generator', () => {
  const base = new TextEncoder().encode(
    'IDENTIFY "X"\nCATEGORY FIGHTER\nSTRENGTH 10\nGUNINTVL 0.075\n',
  );
  const dat = makeDatFromBase(base, {
    identify: 'Y',
    extras: { strength: 25, radarCross: 0.1, gunInterval: 0.03, smoke: [255, 80, 80] },
  });
  const text = new TextDecoder().decode(dat.bytes);
  assert.match(text, /^STRENGTH 25$/m);          // existing line replaced
  assert.match(text, /^RADARCRS 0\.1$/m);        // absent key appended (known keyword = safe)
  assert.match(text, /^GUNINTVL 0\.03$/m);
  assert.match(text, /^SMOKEGEN 0\.0m 0\.0m -6\.0m$/m); // base had none -> generator added
  assert.match(text, /^SMOKECOL ALL 255 80 80$/m);
  assert.equal((text.match(/^STRENGTH /gm) || []).length, 1); // no duplicates
});

test('paint shop: real stock f15.dnm — extract palette, repaint, lights protected', () => {
  const f15 = readFileSync(join(here, '..', 'upstream', 'YSFLIGHT', 'runtime', 'aircraft', 'f15.dnm'));
  const colors = extractDnmColors(f15);
  assert.ok(colors.length >= 5 && colors.length <= 24, 'sane palette size: ' + colors.length);
  const main = colors[0]; // most-used = the airframe color (82,139,172 on stock f15)
  assert.equal(main.key, '82,139,172');
  // NOTE: pure red/green also live in the CLA-2 afterburner blocks, which stay
  // paintable ON PURPOSE (blue flames are a feature) — light-class protection
  // is asserted deterministically on the synthetic DNM below.

  const out = repaintDnm(f15, { '82,139,172': [255, 0, 255] });
  assert.ok(out.replaced > 100, 'the airframe color covers many faces: ' + out.replaced);
  const text = new TextDecoder().decode(out.bytes);
  assert.doesNotMatch(text, /^C 82 139 172$/m);
  assert.match(text, /^C 255 0 255$/m);
  // Same number of lines — pure line surgery.
  assert.equal(text.split('\n').length, new TextDecoder().decode(f15).split('\n').length);
  // The repainted dnm still lists the SAME palette shape (new color replaces old).
  const colors2 = extractDnmColors(out.bytes);
  assert.ok(colors2.some((c) => c.key === '255,0,255'));
  assert.ok(!colors2.some((c) => c.key === '82,139,172'));
});

test('paint shop: packed 15-bit C <n> colors decode and repaint (amp.dnm form)', () => {
  // C 24558 -> GGGGG RRRRR BBBBB: R=255 G=189 B=115 (Anpanman skin); C 960 -> R=246 G=0 B=0.
  const dnm = [
    'DYNAMODEL', 'DNMVER 1',
    'PCK body.srf 12', // SURF + 3V + (F V C E) x2 = 12 lines
    'SURF', 'V 0 0 0', 'V 1 0 0', 'V 0 1 0',
    'F', 'V 0 1 2', 'C 24558', 'E',
    'F', 'V 0 1 2', 'C 960', 'E',
    'SRF "Body"', 'FIL body.srf', 'CLA 0',
    'END', '',
  ].join('\n');
  const bytes = new TextEncoder().encode(dnm);
  const colors = extractDnmColors(bytes);
  const keys = colors.map((c) => c.key);
  assert.ok(keys.includes('255,189,115'), 'packed skin decoded: ' + JSON.stringify(keys));
  assert.ok(keys.includes('247,0,0'), 'packed red decoded: ' + JSON.stringify(keys)); // 30*255/31=246.8->247
  // Repaint by decoded key; matched packed line becomes a triplet, line count kept.
  const out = repaintDnm(bytes, { '255,189,115': [10, 20, 30] });
  assert.equal(out.replaced, 1);
  const text = new TextDecoder().decode(out.bytes);
  assert.match(text, /^C 10 20 30$/m);
  assert.match(text, /^C 960$/m); // untouched packed color stays packed
  void colors;
  assert.equal(text.split('\n').length, dnm.split('\n').length); // same line count
});

test('paint shop: CLA 30-34 light blocks are protected (synthetic DNM)', () => {
  const dnm = [
    'DYNAMODEL', 'DNMVER 1',
    'PCK body.srf 6',
    'Surf', 'V 0 0 0', 'F', 'C 10 20 30', 'E', 'ENDO',
    'PCK light.srf 6',
    'Surf', 'V 0 0 0', 'F', 'C 200 0 0', 'E', 'ENDO',
    'SRF "Body"', 'FIL body.srf', 'CLA 0',
    'SRF "Nav"', 'FIL light.srf', 'CLA 30',
    'END', '',
  ].join('\n');
  const bytes = new TextEncoder().encode(dnm);
  const colors = extractDnmColors(bytes);
  assert.deepEqual(colors.map((c) => c.key), ['10,20,30']); // light-block color excluded
  const out = repaintDnm(bytes, { '10,20,30': [1, 2, 3], '200,0,0': [9, 9, 9] });
  const text = new TextDecoder().decode(out.bytes);
  assert.match(text, /^C 1 2 3$/m);      // body repainted
  assert.match(text, /^C 200 0 0$/m);    // light untouched even when mapped
  assert.equal(out.replaced, 1);
});

test('recipe embedding: workbench.json rides the pack and survives the pipeline', async () => {
  const scenery = { name: 'REDO', ground: [1, 2, 3], sky: [4, 5, 6], land: [7, 8, 9], startAltM: 500, islands: [{ points: [[-100, -100], [100, -100], [0, 100]] }] };
  const withRecipe = assembleSceneryZip({ ...scenery, recipe: { scenery } });
  const without = assembleSceneryZip(scenery);
  const { unzipSync } = await import('../web/vendor/fflate.js');
  const recipeBytes = unzipSync(withRecipe.zipBytes)['workbench.json'];
  assert.ok(recipeBytes, 'workbench.json embedded');
  const parsed = JSON.parse(new TextDecoder().decode(recipeBytes));
  assert.equal(parsed.type, 'scenery');
  assert.deepEqual(parsed.scenery.islands, scenery.islands);

  const a = await analyzePack(withRecipe.zipBytes, { sha256 });
  assert.ok(a.hashed.some((f) => f.path === 'workbench.json'), 'recipe survives analyze as payload');
  assert.deepEqual(a.categories, ['scenery']); // recipe never becomes a scanned list
  const b = await analyzePack(without.zipBytes, { sha256 });
  assert.notEqual(a.id, b.id); // recipe is content -> different id (replace semantics rely on this)

  const ac = assembleAircraftZip({
    dat: test1.dat, visual: test1.dnm, collision: test1.coll,
    recipe: { packName: 'x', slots: { dat: 'test1.dat' } },
  });
  const acr = JSON.parse(new TextDecoder().decode(unzipSync(ac.zipBytes)['workbench.json']));
  assert.equal(acr.type, 'aircraft');
  assert.equal(acr.slots.dat, 'test1.dat');
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
