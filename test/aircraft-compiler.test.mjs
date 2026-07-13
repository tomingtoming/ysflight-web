// Kinematics regression for the compiled B747-8I sample (templates/, the
// checked-in output of scripts/gen-aircraft-from-spec.mjs on specs/b747-8i.json):
//  - control surfaces hinge about their OWN swept leading edge, not a model
//    axis (the old mid-span pitch hinge threw the flap's inner end ~1.8 m)
//  - retracted gear parks fully inside the fuselage envelope, clear of the
//    wing root underside (the old aft pitch swing stuck the wing-gear bogie
//    wheels through the wing)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

let parseDnm;
try {
  ({ parseDnm } = await import('../web/dnm-preview.js'));
} catch (e) {
  console.error('aircraft-compiler test skipped: ' + e.message);
}

// The engine's node transform on local verts (ysshelldnmtemplate.h):
// T(POS)·Ry(-h)Rx(-p)Rz(b)|pos · T(sta.pos)·Ry(-h)Rx(-p)Rz(b)|sta · T(-CNT)
const A2R = Math.PI / 32768;
function applySta(n, sta, v) {
  let [x, y, z] = [v[0] - n.cnt[0], v[1] - n.cnt[1], v[2] - n.cnt[2]];
  const rot = (h, p, b) => {
    let c = Math.cos(b * A2R), s = Math.sin(b * A2R);
    [x, y] = [x * c - y * s, x * s + y * c];
    c = Math.cos(-p * A2R); s = Math.sin(-p * A2R);
    [y, z] = [y * c - z * s, y * s + z * c];
    c = Math.cos(-h * A2R); s = Math.sin(-h * A2R);
    [x, z] = [x * c + z * s, -x * s + z * c];
  };
  rot(sta[3] || 0, sta[4] || 0, sta[5] || 0);
  x += sta[0] || 0; y += sta[1] || 0; z += sta[2] || 0;
  rot(n.pos[3] || 0, n.pos[4] || 0, n.pos[5] || 0);
  return [x + n.pos[0], y + n.pos[1], z + n.pos[2]];
}

const dnm = parseDnm && parseDnm(readFileSync(join(here, '..', 'templates', 'b747-8i.dnm')));

test('control surfaces hinge about their own swept leading edge', { skip: !parseDnm }, () => {
  // Wedge verts are [LEup, LEdn, TE] per section: the four LE end verts sit
  // half-thickness (~0.3 m) off the hinge line, so a correct axis moves them
  // at most 2·0.3·sin(deflection/2) ≈ 0.12 m.  A wrong axis throws meters.
  const surfaces = [...dnm.nodes.keys()].filter((l) => /^(Flap|Aileron|Elevator|Rudder)/.test(l));
  assert.ok(surfaces.length >= 9, 'two flap sections per side: ' + surfaces.join(','));
  for (const label of surfaces) {
    const n = dnm.nodes.get(label);
    const srf = dnm.srfByName.get(n.srf);
    const nsec = srf.vertices.length / 3;
    for (const vi of [0, 1, 3 * (nsec - 1), 3 * (nsec - 1) + 1]) {
      for (const sta of n.sta.slice(1)) {
        const v = srf.vertices[vi], w = applySta(n, sta, v);
        const drift = Math.hypot(w[0] - v[0], w[1] - v[1], w[2] - v[2]);
        assert.ok(drift < 0.2, label + ' LE vert ' + vi + ' drifts ' + drift.toFixed(2) + ' m off the hinge');
      }
    }
    // and it's a real swept hinge, not axis-aligned: h/b (or p for the fin)
    const [, , , h, p, b] = n.sta[n.sta.length - 1];
    assert.ok([h, p, b].filter((a) => Math.abs(a) > 50).length >= 2,
      label + ' deflection uses a combined-Euler swept axis: ' + [h, p, b]);
  }
});

test('retracted gear parks inside the fuselage, clear of the wing', { skip: !parseDnm }, () => {
  for (const label of ['NoseGear', 'WingGearL', 'WingGearR', 'BodyGearL', 'BodyGearR']) {
    const n = dnm.nodes.get(label);
    const srf = dnm.srfByName.get(n.srf);
    assert.equal(n.sta[0][6], 0, label + ' STA0 (retracted) is hidden');
    let maxAbsX = 0, minY = 1e9, maxY = -1e9;
    for (const v of srf.vertices) {
      const w = applySta(n, n.sta[0], v);
      maxAbsX = Math.max(maxAbsX, Math.abs(w[0]));
      minY = Math.min(minY, w[1]); maxY = Math.max(maxY, w[1]);
    }
    assert.ok(maxAbsX < 3.25, label + ' pokes the side: |x| ' + maxAbsX.toFixed(2));
    const floor = label === 'NoseGear' ? -2.72 : -3.55;
    assert.ok(minY > floor, label + ' pokes the belly: y ' + minY.toFixed(2) + ' <= ' + floor);
    if (label.startsWith('WingGear')) {
      // wing root underside sits at ~-2.9 above the stowed bogie
      assert.ok(maxY < -1.5, label + ' reaches y ' + maxY.toFixed(2));
      for (const v of srf.vertices) {
        const w = applySta(n, n.sta[0], v);
        assert.ok(!(Math.abs(w[0]) > 3.24 && w[1] > -2.9), label + ' clips the wing root underside');
      }
    }
  }
});
