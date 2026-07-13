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

test('R (round vertex) flags survive dnm -> glb -> dnm', { skip: !dnmToGlb }, () => {
  // Synthetic model: an octagonal prism whose 16 vertices are all R (smooth),
  // plus one flat-shaded but TWISTED quad with plain vertices.  Through the
  // round trip the prism vertices' baked smooth normals deviate from their
  // face normals (22.5deg), so the converter must re-emit R on them — and
  // must NOT invent R on the flat quad: fanning a twisted quad makes each
  // triangle's geometric normal deviate from the authored face normal, which
  // is exactly how flat tapered wing panels once grew spurious R (dark
  // patches in flight).  The intra-triangle normal-variance gate keeps them
  // flat.
  const V = [], F = [];
  for (const z of [0, 2]) for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    V.push('V ' + Math.cos(a).toFixed(4) + ' ' + Math.sin(a).toFixed(4) + ' ' + z + ' R');
  }
  for (let k = 0; k < 8; k++) {
    const k2 = (k + 1) % 8, a = ((k + 0.5) * Math.PI) / 4;
    F.push('F', 'C 200 200 200',
      'N 0 0 1 ' + Math.cos(a).toFixed(4) + ' ' + Math.sin(a).toFixed(4) + ' 0',
      'V ' + k + ' ' + k2 + ' ' + (8 + k2) + ' ' + (8 + k), 'E');
  }
  V.push('V -1 -1 -4', 'V 1 -1 -4', 'V 1 1 -4', 'V -1 1 -3.6'); // twisted!
  F.push('F', 'C 200 200 200', 'N 0 0 -3.9 0 0 -1', 'V 16 17 18 19', 'E');
  const srfLines = ['SURF', ...V, ...F, 'E'];
  const dnm = ['DYNAMODEL', 'DNMVER 2', 'PCK prism.srf ' + srfLines.length, ...srfLines,
    'SRF "Body"', 'FIL prism.srf', 'CLA 0', 'NST 1', 'STA 0 0 0 0 0 0 1',
    'POS 0 0 0 0 0 0 1', 'CNT 0 0 0', 'REL DEP', 'NCH 0', 'END', 'END', ''].join('\n');

  const back = glbToDnm(dnmToGlb(new TextEncoder().encode(dnm)).glb);
  const p = parseDnm(back.dnm);
  const srf = [...p.srfByName.values()][0];
  assert.equal(tris(p), 18, 'triangle count');
  const rOn = (pred) => srf.vertices.filter((v, i) => pred(v) && srf.smooth[i]).length;
  assert.equal(rOn((v) => v[2] > -1), 16, 'all 16 prism vertices keep R');
  assert.equal(rOn((v) => v[2] < -1), 0, 'flat quad vertices stay non-R');
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
