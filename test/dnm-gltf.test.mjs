// Round-trip tests for the Blender bridge core (web/dnm-gltf.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

let dnmToGlb, glbToDnm, parseDnm;
try {
  ({ dnmToGlb, glbToDnm } = await import('../web/dnm-gltf.js'));
  ({ parseDnm } = await import('../web/dnm-preview.js'));
} catch (e) {
  console.error('dnm-gltf import skipped under Node: ' + e.message);
}

const tris = (p) => [...p.srfByName.values()]
  .reduce((n, s) => n + s.faces.reduce((m, f) => m + Math.max(0, f.idx.length - 2), 0), 0);
const movables = (p) => [...p.nodes.values()]
  .filter((n) => n.sta.length >= 2 && n.sta[0].slice(0, 6).some((v, i) => Math.abs(v - n.sta[n.sta.length - 1][i]) > 1e-6))
  .map((n) => n.label).sort();

test('dnm -> glb -> dnm round trip preserves the f22 (nodes, tris, movables)', { skip: !dnmToGlb }, () => {
  const src = readFileSync(join(here, '..', 'upstream', 'YSFLIGHT', 'runtime', 'aircraft', 'f22.dnm'));
  const fwd = dnmToGlb(src);
  assert.ok(fwd.nodes > 40, 'f22 exported nodes: ' + fwd.nodes);
  assert.ok(fwd.animations.includes('Gear') && fwd.animations.includes('Flap'), 'animations: ' + fwd.animations);
  const back = glbToDnm(fwd.glb);
  const a = parseDnm(src), b = parseDnm(back.dnm);
  assert.equal(b.nodes.size, a.nodes.size, 'node count');
  assert.equal(tris(b), tris(a), 'triangle count');
  assert.deepEqual(movables(b), movables(a), 'movable node set');
});

test('template glb converts and keeps its movable wiring', { skip: !glbToDnm }, () => {
  const glb = readFileSync(join(here, '..', 'templates', 'aircraft-starter.glb'));
  const res = glbToDnm(glb);
  const p = parseDnm(res.dnm);
  assert.ok(p.nodes.size >= 18, 'template nodes: ' + p.nodes.size);
  const mv = movables(p);
  for (const label of ['NoseGear', 'FlapL', 'Elevator', 'Rudder', 'ReverserL', 'VtolNozzleL']) {
    assert.ok(mv.includes(label), label + ' still movable: ' + mv.join(','));
  }
  // Propeller spins (identical STAs, class-driven) — present as a node, CLA 18.
  assert.equal(p.nodes.get('Propeller').cla, 18);
});
