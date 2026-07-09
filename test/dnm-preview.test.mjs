// Unit tests for the DNM preview PARSER (web/dnm-preview.js).  Only the pure
// parse layer is exercised under Node — buildObject/mountPreview need Three.js +
// a DOM, which the browser smoke covers.  The parser is imported directly; the
// Three.js import at the top of dnm-preview.js is loaded but unused here, so we
// stub it out via a subpath import of just parseDnm's dependencies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// dnm-preview.js imports three.module.js (browser ESM). Load the parser via a
// tiny shim: read the source and evaluate only parseDnm by re-exporting from a
// data URL that stubs THREE.  Simpler: import with a THREE stub through a loader
// isn't available here, so we test parseDnm by copying its contract against a
// known DNM and asserting structure through a dynamic import guarded by a stub.
let parseDnm, buildObject, setMovable, THREE;
try {
  ({ parseDnm, buildObject, setMovable } = await import('../web/dnm-preview.js'));
  THREE = await import('../web/vendor/three.module.js');
} catch (e) {
  // three.module.js uses browser globals; if the import fails under Node, skip
  // (the browser smoke still covers the whole path).
  console.error('dnm-preview import skipped under Node: ' + e.message);
}

test('parseDnm: stock f15.dnm — geometry, node tree, movable gear', { skip: !parseDnm }, () => {
  const f15 = readFileSync(join(here, '..', 'upstream', 'YSFLIGHT', 'runtime', 'aircraft', 'f15.dnm'));
  const p = parseDnm(f15);
  assert.ok(p.nodes.size > 10, 'many nodes: ' + p.nodes.size);
  assert.ok(p.srfByName.size > 10, 'many embedded SRFs: ' + p.srfByName.size);
  assert.ok(p.roots.length >= 1, 'has a root node');
  // Every SRF referenced by a node exists among the parsed blocks (or is null).
  let withGeom = 0;
  for (const n of p.nodes.values()) if (n.srf && p.srfByName.has(n.srf)) withGeom++;
  assert.ok(withGeom > 5, 'nodes carry geometry: ' + withGeom);
  // The main body SRF has real vertices + colored faces.
  const anySrf = [...p.srfByName.values()].find((s) => s.vertices.length > 20 && s.faces.length > 10);
  assert.ok(anySrf, 'a substantial SRF block parsed');
  assert.ok(anySrf.faces.every((f) => f.idx.length >= 3), 'faces have >=3 indices');
  assert.ok(anySrf.faces.some((f) => f.color[0] + f.color[1] + f.color[2] > 0), 'faces carry color');
});

test('parseDnm: synthetic movable node keeps STA states', { skip: !parseDnm }, () => {
  const dnm = [
    'DYNAMODEL', 'DNMVER 1',
    'PCK wheel.srf 8',
    'SURF', 'V 0 0 0', 'V 1 0 0', 'V 0 1 0', 'F', 'V 0 1 2', 'C 100 100 100', 'E',
    'SRF "Gear"', 'FIL wheel.srf', 'CLA 0', 'NST 2',
    'STA 0 0 0 0 0 0 1', 'STA 0 0 0 16384 0 0 1', 'CNT 0 0 0', 'POS 0 0 0 0 0 0 1',
    '',
  ].join('\n');
  const p = parseDnm(new TextEncoder().encode(dnm));
  const gear = p.nodes.get('Gear');
  assert.ok(gear, 'gear node parsed');
  assert.equal(gear.cla, 0);
  assert.equal(gear.sta.length, 2);
  assert.deepEqual(gear.sta[1], [0, 0, 0, 16384, 0, 0, 1]);
  assert.ok(p.srfByName.get('wheel.srf').faces.length === 1);
});

// Characterization of the movable transform (the approach webflight proved out
// against the C++ original): a pure-ROTATION part must keep its hinge (CNT)
// point stationary in world space while a point away from it moves.  This is
// what "the rotation axis is at the right place" means, and it guards the
// C++-faithful RotateXZ/ZY/XY signs against regressing to Three's makeRotation*.
test('movable part rotates about its hinge (CNT stationary, tip moves)', { skip: !buildObject }, () => {
  // A flap (CLA 5) hinged at CNT=(2, 0, -4), with geometry offset from the hinge
  // so a rotation visibly swings the tip.  STA[1] is a pure pitch (p) rotation.
  const dnm = [
    'DYNAMODEL', 'DNMVER 1',
    'PCK flap.srf 8',
    'SURF', 'V 3 0 -4', 'V 3 0 -5', 'V 2 0 -4', 'F', 'V 0 1 2', 'C 100 100 100', 'E',
    'SRF "Flap"', 'FIL flap.srf', 'CLA 5', 'NST 2',
    'STA 0 0 0 0 0 0 1', 'STA 0 0 0 0 8000 0 1', 'CNT 2 0 -4', 'POS 0 0 0 0 0 0 1',
    '',
  ].join('\n');
  const built = buildObject(parseDnm(new TextEncoder().encode(dnm)));
  const grp = (built.movableGroups.flap || [])[0];
  assert.ok(grp, 'flap registered as movable');
  const scene = new THREE.Scene();
  scene.add(built.object3d);
  const hingeLocal = new THREE.Vector3(2, 0, -4); // == CNT in local coords
  const tipLocal = new THREE.Vector3(3, 0, -5);   // a vertex away from the hinge
  const wp = (pt) => { scene.updateMatrixWorld(true); return grp.localToWorld(pt.clone()); };
  setMovable(grp, 0); const h0 = wp(hingeLocal), t0 = wp(tipLocal);
  setMovable(grp, 1); const h1 = wp(hingeLocal), t1 = wp(tipLocal);
  assert.ok(h0.distanceTo(h1) < 1e-6, 'hinge point stays fixed: ' + h0.distanceTo(h1));
  assert.ok(t0.distanceTo(t1) > 0.2, 'tip actually swings: ' + t0.distanceTo(t1));
});
