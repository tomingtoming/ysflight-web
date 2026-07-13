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

// Rotation axis direction of an STA Euler triple: R = Ry(-h)·Rx(-p)·Rz(b),
// axis from the skew-symmetric part (R - Rᵀ)/2 = sinθ·[u]×.
function staAxisDir(sta) {
  const a = -sta[3] * A2R, b = -sta[4] * A2R, g = sta[5] * A2R;
  const cy = Math.cos(a), sy = Math.sin(a), cx = Math.cos(b), sx = Math.sin(b), cz = Math.cos(g), sz = Math.sin(g);
  const m = [
    [cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx],
    [cx * sz, cx * cz, -sx],
    [-sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx],
  ];
  const w = [m[2][1] - m[1][2], m[0][2] - m[2][0], m[1][0] - m[0][1]];
  const l = Math.hypot(w[0], w[1], w[2]) || 1;
  return w.map((v) => v / l);
}

test('control surfaces hinge about their own swept leading edge', { skip: !parseDnm }, () => {
  // Recompute each wedge's hinge line from the spec (LE of the cut region,
  // +0.05 hinge gap) and check the STA rotation axis is parallel to it and
  // CNT sits on it.  The old bug rotated about plain model-axis pitch.
  const spec = JSON.parse(readFileSync(join(here, '..', 'specs', 'b747-8i.json'), 'utf8'));
  const zys = (zn) => spec.length / 2 - zn;
  const secAt = (sections, sp) => {
    for (let i = 0; i + 1 < sections.length; i++) {
      const a = sections[i], b = sections[i + 1];
      const [sa, sb] = [a.x !== undefined ? a.x : a.y, b.x !== undefined ? b.x : b.y];
      if (sp >= sa && sp <= sb) {
        const t = (sp - sa) / (sb - sa), L = (k, d) => (a[k] !== undefined ? a[k] : d) + ((b[k] !== undefined ? b[k] : d) - (a[k] !== undefined ? a[k] : d)) * t;
        return { znLE: L('znLE', 0), chord: L('chord', 0), off: a.x !== undefined ? L('y', 0) : 0 };
      }
    }
    throw new Error('span out of range: ' + sp);
  };
  const line = (sections, cut, spanAxis) => [cut.spanFrom, cut.spanTo].map((sp) => {
    const s = secAt(sections, sp);
    const z = zys(s.znLE + s.chord * (1 - cut.chordFrac) + 0.05);
    return spanAxis === 'x' ? [sp, s.off, z] : [0, sp, z];
  });
  const cases = [
    ['Flap1', line(spec.wing.sections, spec.wing.flaps[0], 'x')],
    ['Flap2', line(spec.wing.sections, spec.wing.flaps[1], 'x')],
    ['Aileron', line(spec.wing.sections, spec.wing.ailerons, 'x')],
    ['Elevator', line(spec.hstab.sections, spec.hstab.elevator, 'x')],
    ['Rudder', line(spec.fin.sections.map((s) => ({ y: s.y, znLE: s.znLE, chord: s.chord })), spec.fin.rudder, 'y')],
  ];
  for (const [base, ln] of cases) {
    for (const side of base === 'Rudder' ? [''] : ['L', 'R']) {
      const [p0, p1] = side === 'R' ? ln.map(([x, y, z]) => [-x, y, z]) : ln;
      const n = dnm.nodes.get(base + side);
      assert.ok(n, base + side + ' exists');
      const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
      const dl = Math.hypot(d[0], d[1], d[2]);
      const u = d.map((v) => v / dl);
      for (const sta of n.sta.slice(1)) {
        const ax = staAxisDir(sta);
        const dot = Math.abs(ax[0] * u[0] + ax[1] * u[1] + ax[2] * u[2]);
        assert.ok(dot > 0.9998, base + side + ' rotation axis is the hinge line (|dot| ' + dot.toFixed(4) + ')');
      }
      // CNT on the line: cross((cnt-p0), u) ~ 0
      const c = [n.cnt[0] - p0[0], n.cnt[1] - p0[1], n.cnt[2] - p0[2]];
      const cr = Math.hypot(c[1] * u[2] - c[2] * u[1], c[2] * u[0] - c[0] * u[2], c[0] * u[1] - c[1] * u[0]);
      assert.ok(cr < 0.01, base + side + ' CNT sits on the hinge line (off by ' + cr.toFixed(3) + ' m)');
    }
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
