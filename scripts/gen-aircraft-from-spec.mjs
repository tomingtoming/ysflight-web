// The aircraft COMPILER: three-view measurements (a spec JSON, see
// specs/b747-8.json) -> a complete YSFLIGHT DNM with the movable parts cut out
// and wired at generation time.
//
//   node scripts/gen-aircraft-from-spec.mjs <spec.json> <output.dnm>
//
// The methodology ("silhouette loft"): a low-poly airliner reduces to
//   - fuselage: ellipse-ish rings lofted along Z (top/bottom/halfwidth per
//     station straight off the side + top views; the 747 hump is just a
//     raised 'top' for a few stations)
//   - wings/stabs/fin: ruled plates between span sections (LE + chord + y per
//     section from the top/front views), with the trailing-edge control
//     surfaces SPLIT OFF into their own nodes — the compiler knows exactly
//     where the flap is, so unlike name-guessing this wiring is authoritative
//   - engines: tapered tubes; gear: template-style strut+wheel posts
// Coordinates: aircraft coords (nose +Z, y up); spec distances are "zn" =
// meters from the nose tip, converted here via zys = length/2 - zn.

import { readFileSync, writeFileSync } from 'node:fs';

const [specPath, outPath] = process.argv.slice(2);
if (!specPath || !outPath) {
  console.error('usage: node scripts/gen-aircraft-from-spec.mjs <spec.json> <output.dnm>');
  process.exit(2);
}
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const L = spec.length;
const zys = (zn) => L / 2 - zn;
const COL = spec.colors;
const DEG = (d) => Math.round(d * 32768 / 180);

// --- geometry buckets ---------------------------------------------------------------

const mkGeo = () => ({ v: [], faces: [] });
const addFace = (g, idx, color, opts) => g.faces.push({ idx, color, ...(opts || {}) });
const addV = (g, x, y, z) => (g.v.push([x, y, z]) - 1);
const merge = (...gs) => {
  const out = mkGeo();
  for (const g of gs) {
    const base = out.v.length;
    out.v.push(...g.v);
    out.faces.push(...g.faces.map((f) => ({ ...f, idx: f.idx.map((i) => i + base) })));
  }
  return out;
};

// --- fuselage loft -------------------------------------------------------------------

function fuselage() {
  const g = mkGeo();
  const N = spec.fuselage.ringPoints;
  const rings = spec.fuselage.stations.map((s) => {
    const yc = (s.top + s.bottom) / 2, aUp = s.top - yc, aDn = yc - s.bottom;
    const ring = [];
    for (let i = 0; i < N; i++) {
      const th = (i / N) * Math.PI * 2;
      const sy = Math.sin(th);
      const y = yc + (sy >= 0 ? aUp : aDn) * sy;
      ring.push(addV(g, s.w * Math.cos(th), y, zys(s.zn)));
    }
    return ring;
  });
  for (let r = 0; r + 1 < rings.length; r++) {
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      addFace(g, [rings[r][i], rings[r][j], rings[r + 1][j], rings[r + 1][i]], COL.body);
    }
  }
  addFace(g, rings[0].slice().reverse(), COL.body);          // nose cap
  addFace(g, rings[rings.length - 1], COL.body);             // tail cap
  return g;
}

// --- ruled plates (wing / stab / fin) ------------------------------------------------
// sections: [{span, znLE, chord, off}]  span = position along the span axis,
// off = offset along the third axis (dihedral for wings, 0 for the fin).
// spanAxis 'x': plate in the x/z plane, thickness along y (wings, h-stab).
// spanAxis 'y': plate in the y/z plane, thickness along x (the fin).

function plate(sections, thickness, color, spanAxis) {
  const g = mkGeo();
  const rootChord = sections[0].chord;
  const pt = (span, off, z) => (spanAxis === 'x' ? [span, off, z] : [off, span, z]);
  const rows = sections.map((s) => {
    const t = (thickness * Math.max(0.35, s.chord / rootChord)) / 2;
    const zLE = zys(s.znLE), zTE = zys(s.znLE + s.chord);
    const off = s.off || 0;
    return {
      leT: addV(g, ...pt(s.span, off + t, zLE)), leB: addV(g, ...pt(s.span, off - t, zLE)),
      teT: addV(g, ...pt(s.span, off + t * 0.35, zTE)), teB: addV(g, ...pt(s.span, off - t * 0.35, zTE)),
    };
  });
  for (let r = 0; r + 1 < rows.length; r++) {
    const a = rows[r], b = rows[r + 1];
    addFace(g, [a.leT, b.leT, b.teT, a.teT], color); // top
    addFace(g, [a.teB, b.teB, b.leB, a.leB], color); // bottom
    addFace(g, [a.leB, b.leB, b.leT, a.leT], color); // leading edge
    addFace(g, [a.teT, b.teT, b.teB, a.teB], color); // trailing edge
  }
  const rt = rows[0], tp = rows[rows.length - 1];
  addFace(g, [rt.leT, rt.teT, rt.teB, rt.leB], color); // root cap
  addFace(g, [tp.leB, tp.teB, tp.teT, tp.leT], color); // tip cap
  return g;
}

// Interpolate a section at a given span position.
function sectionAt(sections, span) {
  for (let i = 0; i + 1 < sections.length; i++) {
    const a = sections[i], b = sections[i + 1];
    if (span >= a.span && span <= b.span) {
      const t = (span - a.span) / (b.span - a.span);
      return {
        span,
        znLE: a.znLE + (b.znLE - a.znLE) * t,
        chord: a.chord + (b.chord - a.chord) * t,
        off: (a.off || 0) + ((b.off || 0) - (a.off || 0)) * t,
      };
    }
  }
  return null;
}

// Split a surface into FIXED plate + MOVABLE trailing plate over a span range.
// Returns { fixed, movable, hinge } — hinge = [x,y,z] mid-span on the cut line.
function splitMovable(sections, cut, thickness, colorFixed, colorMov, spanAxis) {
  const clamp = (arr) => arr.filter((s) => s);
  const inner = sectionAt(sections, cut.spanFrom), outer = sectionAt(sections, cut.spanTo);
  const inRange = sections.filter((s) => s.span > cut.spanFrom && s.span < cut.spanTo);
  // fixed: full chord outside the cut, shortened chord inside it
  const fixedSecs = [];
  for (const s of sections) {
    if (s.span < cut.spanFrom || s.span > cut.spanTo) fixedSecs.push(s);
  }
  const shorten = (s) => ({ ...s, chord: s.chord * (1 - cut.chordFrac) });
  const insInner = fixedSecs.filter((s) => s.span < cut.spanFrom);
  const insOuter = fixedSecs.filter((s) => s.span > cut.spanTo);
  const fixedAll = clamp([...insInner, inner && shorten(inner), ...inRange.map(shorten), outer && shorten(outer), ...insOuter]);
  const movSecs = clamp([inner, ...inRange, outer]).map((s) => ({
    ...s,
    znLE: s.znLE + s.chord * (1 - cut.chordFrac),
    chord: s.chord * cut.chordFrac,
  }));
  const fixed = plate(fixedAll, thickness, colorFixed, spanAxis);
  const movable = plate(movSecs, thickness * 0.8, colorMov, spanAxis);
  const mid = sectionAt(movSecs.map((s) => ({ ...s })), (cut.spanFrom + cut.spanTo) / 2) || movSecs[0];
  const hingeSpan = (cut.spanFrom + cut.spanTo) / 2;
  const hinge = spanAxis === 'x'
    ? [hingeSpan, mid.off || 0, zys(mid.znLE)]
    : [0, hingeSpan, zys(mid.znLE)];
  return { fixed, movable, hinge };
}

const mirrorX = (g) => ({
  v: g.v.map(([x, y, z]) => [-x, y, z]),
  faces: g.faces.map((f) => ({ ...f, idx: f.idx.slice().reverse() })),
});

// --- engines -------------------------------------------------------------------------

function engine(p) {
  const g = mkGeo();
  const N = 10, r = spec.engines.diameter / 2;
  const ringAt = (zn, rr) => {
    const ring = [];
    for (let i = 0; i < N; i++) {
      const th = (i / N) * Math.PI * 2;
      ring.push(addV(g, p.x + rr * Math.cos(th), p.y + rr * Math.sin(th), zys(zn)));
    }
    return ring;
  };
  const front = ringAt(p.zn, r), back = ringAt(p.zn + spec.engines.length, r * 0.75);
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    addFace(g, [front[i], front[j], back[j], back[i]], COL.engine);
  }
  addFace(g, front.slice().reverse(), COL.dark); // intake
  addFace(g, back, COL.dark);                    // exhaust
  // pylon: a slim box from the nacelle top up into the wing
  const px = 0.28, z0 = zys(p.zn + 0.8), z1 = zys(p.zn + spec.engines.length * 0.8);
  const y0 = p.y + r * 0.7, y1 = p.y + r + 2.2;
  const b = [
    addV(g, p.x - px, y0, z0), addV(g, p.x + px, y0, z0), addV(g, p.x + px, y1, z0), addV(g, p.x - px, y1, z0),
    addV(g, p.x - px, y0, z1), addV(g, p.x + px, y0, z1), addV(g, p.x + px, y1, z1), addV(g, p.x - px, y1, z1),
  ];
  for (const q of [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7]]) {
    addFace(g, q.map((i) => b[i]), COL.engine);
  }
  return g;
}

// --- gear (template idiom: POS=CNT=hinge, STA0 retracted+hidden) ---------------------

function gearPost(x, zn, topY, bottomY) {
  const g = mkGeo();
  const z = zys(zn), w = 0.28;
  const box = (x0, x1, y0, y1, z0, z1, color) => {
    const b = [
      addV(g, x0, y0, z0), addV(g, x1, y0, z0), addV(g, x1, y1, z0), addV(g, x0, y1, z0),
      addV(g, x0, y0, z1), addV(g, x1, y0, z1), addV(g, x1, y1, z1), addV(g, x0, y1, z1),
    ];
    for (const q of [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]]) {
      addFace(g, q.map((i) => b[i]), color);
    }
  };
  box(x - w, x + w, bottomY + 0.7, topY, z - w, z + w, COL.dark);            // strut
  box(x - 0.45, x + 0.45, bottomY, bottomY + 0.9, z - 0.75, z + 0.75, COL.dark); // wheel block
  return g;
}

// --- assemble the parts list ---------------------------------------------------------

const zero = [0, 0, 0, 0, 0, 0, 1];
const rot = (h, p, b, vis = 1) => [0, 0, 0, h, p, b, vis];
const parts = [];
const P = (label, cla, geo, hinge, sta, children) =>
  parts.push({ label, cla, geo, hinge: hinge || [0, 0, 0], sta: sta || [zero, zero], children: children || [] });

const wingSecs = spec.wing.sections.map((s) => ({ span: s.x, znLE: s.znLE, chord: s.chord, off: s.y }));
// Two cuts on one wing (flaps + ailerons): the FIXED plate shortens its chord
// over BOTH span ranges; each movable comes from its own single cut.
function doubleCut(sections, cutA, cutB, thickness, color, spanAxis) {
  const a = splitMovable(sections, cutA, thickness, color, color, spanAxis);
  const secsBoth = [];
  const marks = [cutA.spanFrom, cutA.spanTo, cutB.spanFrom, cutB.spanTo];
  const all = [...sections];
  for (const m of marks) {
    const s = sectionAt(sections, m);
    if (s && !all.some((q) => Math.abs(q.span - m) < 1e-6)) all.push(s);
  }
  all.sort((p, q) => p.span - q.span);
  for (const s of all) {
    const inA = s.span >= cutA.spanFrom - 1e-9 && s.span <= cutA.spanTo + 1e-9;
    const inB = s.span >= cutB.spanFrom - 1e-9 && s.span <= cutB.spanTo + 1e-9;
    const frac = inA ? cutA.chordFrac : inB ? cutB.chordFrac : 0;
    secsBoth.push(frac ? { ...s, chord: s.chord * (1 - frac) } : s);
  }
  const fixed = plate(secsBoth, thickness, color, spanAxis);
  const b = splitMovable(sections, cutB, thickness, color, color, spanAxis);
  return { fixed, movA: a.movable, hingeA: a.hinge, movB: b.movable, hingeB: b.hinge };
}

const wing = doubleCut(wingSecs, spec.wing.flaps, spec.wing.ailerons, spec.wing.thickness, COL[spec.wing.color], 'x');
const hsSecs = spec.hstab.sections.map((s) => ({ span: s.x, znLE: s.znLE, chord: s.chord, off: s.y }));
const hs = splitMovable(hsSecs, spec.hstab.elevator, spec.hstab.thickness, COL[spec.hstab.color], COL[spec.hstab.color], 'x');
const finSecs = spec.fin.sections.map((s) => ({ span: s.y, znLE: s.znLE, chord: s.chord, off: 0 }));
const fin = splitMovable(finSecs, spec.fin.rudder, spec.fin.thickness, COL[spec.fin.color], COL[spec.fin.color], 'y');

const staticGeo = merge(
  fuselage(),
  wing.fixed, mirrorX(wing.fixed),
  hs.fixed, mirrorX(hs.fixed),
  fin.fixed,
  ...spec.engines.positions.map(engine),
);

const topStation = spec.fuselage.stations.reduce((m, s) => Math.max(m, s.top), 0);
const beaconGeo = (() => {
  const g = mkGeo();
  const z = zys(spec.beacon.zn), y = topStation;
  const b = [
    addV(g, -0.12, y, z - 0.15), addV(g, 0.12, y, z - 0.15), addV(g, 0.12, y, z + 0.15), addV(g, -0.12, y, z + 0.15),
    addV(g, -0.12, y + 0.22, z - 0.15), addV(g, 0.12, y + 0.22, z - 0.15), addV(g, 0.12, y + 0.22, z + 0.15), addV(g, -0.12, y + 0.22, z + 0.15),
  ];
  for (const q of [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [7, 6, 5, 4].reverse(), [4, 5, 1, 0]]) {
    addFace(g, q.map((i) => b[i]), [220, 30, 30], { bright: true });
  }
  return g;
})();

P('Fuselage', 0, staticGeo, null, null, [
  'FlapL', 'FlapR', 'AileronL', 'AileronR', 'ElevatorL', 'ElevatorR', 'Rudder',
  'NoseGear', 'MainGearL', 'MainGearR', 'Beacon',
]);
P('FlapL', 5, wing.movA, wing.hingeA, [zero, rot(0, DEG(22), 0)]);
P('FlapR', 5, mirrorX(wing.movA), [-wing.hingeA[0], wing.hingeA[1], wing.hingeA[2]], [zero, rot(0, DEG(22), 0)]);
P('AileronL', 7, wing.movB, wing.hingeB, [zero, rot(0, DEG(-12), 0), rot(0, DEG(12), 0)]);
P('AileronR', 7, mirrorX(wing.movB), [-wing.hingeB[0], wing.hingeB[1], wing.hingeB[2]], [zero, rot(0, DEG(12), 0), rot(0, DEG(-12), 0)]);
P('ElevatorL', 6, hs.movable, hs.hinge, [zero, rot(0, DEG(-18), 0), rot(0, DEG(18), 0)]);
P('ElevatorR', 6, mirrorX(hs.movable), [-hs.hinge[0], hs.hinge[1], hs.hinge[2]], [zero, rot(0, DEG(-18), 0), rot(0, DEG(18), 0)]);
P('Rudder', 8, fin.movable, fin.hinge, [zero, rot(DEG(-18), 0, 0), rot(DEG(18), 0, 0)]);
const gearRetract = rot(0, DEG(-100), 0, 0);
const gs = spec.gear;
P('NoseGear', 0, gearPost(gs.nose.x, gs.nose.zn, gs.nose.topY, gs.nose.bottomY), [gs.nose.x, gs.nose.topY, zys(gs.nose.zn)], [gearRetract, zero]);
P('MainGearL', 0, gearPost(-gs.mains.x, gs.mains.zn, gs.mains.topY, gs.mains.bottomY), [-gs.mains.x, gs.mains.topY, zys(gs.mains.zn)], [gearRetract, zero]);
P('MainGearR', 0, gearPost(gs.mains.x, gs.mains.zn, gs.mains.topY, gs.mains.bottomY), [gs.mains.x, gs.mains.topY, zys(gs.mains.zn)], [gearRetract, zero]);
P('Beacon', 30, beaconGeo, null, [zero, zero]);

// --- DNM writer (the gen-aircraft-template idiom) ------------------------------------

const f6 = (v) => (Math.abs(v) < 5e-7 ? '0' : String(Math.round(v * 1e6) / 1e6));
const out = ['DYNAMODEL', 'DNMVER 2'];
for (const p of parts) {
  const lines = ['SURF'];
  for (const v of p.geo.v) lines.push('V ' + v.map(f6).join(' '));
  for (const f of p.geo.faces) {
    lines.push('F');
    if (f.bright) lines.push('B');
    lines.push('V ' + f.idx.join(' '));
    lines.push('C ' + f.color.join(' '));
    lines.push('E');
  }
  out.push('PCK ' + p.label.toLowerCase() + '.srf ' + lines.length);
  out.push(lines.join('\n'));
}
for (const p of parts) {
  out.push('SRF "' + p.label + '"');
  out.push('FIL ' + p.label.toLowerCase() + '.srf');
  out.push('CLA ' + p.cla);
  out.push('NST ' + p.sta.length);
  for (const s of p.sta) out.push('STA ' + s.slice(0, 3).map(f6).join(' ') + ' ' + s.slice(3, 6).join(' ') + ' ' + s[6]);
  out.push('POS ' + p.hinge.map(f6).join(' ') + ' 0 0 0 1');
  out.push('CNT ' + p.hinge.map(f6).join(' '));
  out.push('PAX 0 0 0');
  out.push('REL DEP');
  out.push('NCH ' + p.children.length);
  for (const c of p.children) out.push('CLD "' + c + '"');
  out.push('END');
}
out.push('END');
writeFileSync(outPath, out.join('\n') + '\n');
const tris = parts.reduce((n, p) => n + p.geo.faces.reduce((m, f) => m + Math.max(0, f.idx.length - 2), 0), 0);
console.log(JSON.stringify({ out: outPath, name: spec.name, parts: parts.length, triangles: tris }));
