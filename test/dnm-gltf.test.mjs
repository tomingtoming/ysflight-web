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
  // Bright (SRF 'B') faces — the afterburner flames — must survive as B, in
  // their original colors, on BOTH afterburner nodes.  (Losing B shades the
  // flame by scene light: the broken-looking afterburner bug.)
  for (const label of ['Afterburner-1', 'AfterBurner-2']) {
    const srf = b.srfByName.get(b.nodes.get(label).srf);
    assert.ok(srf.faces.length > 0, label + ' has faces');
    assert.ok(srf.faces.every((f) => f.unlit), label + ': every flame face is bright');
    const colors = new Set(srf.faces.map((f) => f.color.join(',')));
    assert.ok(colors.has('255,0,0') && colors.has('255,255,255'), label + ' keeps red+white: ' + [...colors]);
    // ZA translucency survives: stock flame = white core ZA 120 (alpha .53),
    // red cone ZA 200 (alpha .22).  Losing this renders opaque cones.
    for (const f of srf.faces) {
      const expect = f.color[1] === 0 ? (255 - 200) / 255 : (255 - 120) / 255;
      assert.ok(Math.abs(f.alpha - expect) < 0.01,
        label + ' ' + f.color.join(',') + ' alpha ' + f.alpha + ' ≈ ' + expect);
    }
  }
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
