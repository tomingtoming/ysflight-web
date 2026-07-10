// Round-trip tests for the Blender bridge core (web/dnm-gltf.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

let dnmToGlb, glbToDnm, dnmToCollisionSrf, parseDnm;
try {
  ({ dnmToGlb, glbToDnm, dnmToCollisionSrf } = await import('../web/dnm-gltf.js'));
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

// Strip extras from a GLB we made ourselves — simulates a foreign model whose
// parts are named but carry no YSFLIGHT wiring (the FlightGear/fr24 case).
function stripExtras(glb) {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
  for (const n of json.nodes) delete n.extras;
  const enc = new TextEncoder();
  const j0 = enc.encode(JSON.stringify(json));
  const pad = (4 - (j0.length % 4)) % 4;
  const j = new Uint8Array(j0.length + pad).fill(0x20);
  j.set(j0);
  const rest = glb.subarray(20 + jsonLen); // BIN chunk header + data, unchanged
  const out = new Uint8Array(20 + j.length + rest.length);
  out.set(glb.subarray(0, 12));
  const odv = new DataView(out.buffer);
  odv.setUint32(8, out.length, true);
  odv.setUint32(12, j.length, true);
  odv.setUint32(16, 0x4e4f534a, true);
  out.set(j, 20);
  out.set(rest, 20 + j.length);
  return out;
}

test('name-based auto-wiring: bare foreign glb gets movable parts back', { skip: !dnmToGlb }, () => {
  const glb = readFileSync(join(here, '..', 'templates', 'aircraft-starter.glb'));
  const res = glbToDnm(stripExtras(new Uint8Array(glb)));
  const byLabel = Object.fromEntries((res.wired || []).map((w) => [w.label, w.name]));
  // Template node names are exactly the FG-style names the matcher targets.
  assert.equal(byLabel.Elevator, 'Elevator');
  assert.equal(byLabel.Rudder, 'Rudder');
  assert.equal(byLabel.NoseGear, 'Gear');
  assert.equal(byLabel.FlapL, 'Flap');
  assert.equal(byLabel.AileronL, 'Aileron');
  const p = parseDnm(res.dnm);
  const el = p.nodes.get('Elevator');
  assert.equal(el.cla, 6);
  assert.equal(el.sta.length, 3, 'elevator NST 3');
  assert.ok(Math.abs(el.cnt[2]) > 1, 'hinge derived from bbox, not origin: ' + el.cnt);
  const gear = p.nodes.get('NoseGear');
  assert.equal(gear.sta[0][6], 0, 'gear retracted state hidden');
});

test('collision shell bakes visible rest geometry, skips retracted gear', { skip: !dnmToCollisionSrf }, () => {
  const dnm = readFileSync(join(here, '..', 'templates', 'aircraft-starter.dnm'));
  const total = (new TextDecoder().decode(dnm).match(/^F$/gm) || []).length;
  const coll = new TextDecoder().decode(dnmToCollisionSrf(dnm));
  assert.match(coll, /^SURF\n/, 'starts with SURF');
  const collFaces = (coll.match(/^F$/gm) || []).length;
  assert.ok(collFaces > 0, 'has faces');
  // The three gear nodes are hidden at rest (STA0 vis=0) and must be excluded.
  assert.ok(collFaces < total, 'fewer faces than the full model: ' + collFaces + ' < ' + total);
});
