// The aircraft COMPILER: three-view measurements (a spec JSON, see
// specs/b747-8i.json) -> a complete YSFLIGHT DNM with the movable parts cut
// out and wired at generation time.
//
//   node scripts/gen-aircraft-from-spec.mjs <spec.json> <output.dnm>
//
// The methodology ("silhouette loft"), v2 — classic hand-built DNM richness,
// everything driven by the spec so a new airliner is a JSON file, not code:
//   fuselage  : Catmull-Rom densified stations x N-point rings, upper-lobe
//               narrowing where a hump rises above the aft crown, two-tone
//               belly, nose/tail caps
//   decals    : cheatline / individual windows / doors / cockpit glass
//               (spec.decals, optional) — thin quads floated 4cm off the skin
//   wing/tails: airfoil-section lofts; control surfaces split off as wedge
//               lofts with a 5cm hinge gap (coplanar hinge faces z-fight)
//   engines   : shaped nacelles (lip/cowl/core/exhaust) + fan disc + pylons
//               that follow the wing dihedral
//   gear      : spec.gear.posts (nose / 4-wheel bogie, mirrored), or the
//               classic 3-post fallback from the old {nose, mains} schema
//   lights    : beacon (spec.beacon) + auto wingtip nav + tail strobe,
//               B (self-lit) faces
//
// Every face gets an explicit 'N <center> <normal>' line: YSFLIGHT lights by
// the ASSIGNED normal and flips the winding to match it (ysvisual.cpp,
// FixOrientationBasedOnAssignedNormal) — a face without N keeps a zero
// normal and falls back to two-sided camera-facing shading.  Winding is kept
// outward anyway so the glTF preview path (which derives normals from
// winding) agrees.
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
const DEG = (d) => Math.round(d * 32768 / 180);

const COL = {
  body: [237, 238, 238], belly: [186, 190, 196], stripe: [25, 70, 140],
  win: [35, 40, 52], glass: [22, 28, 40], door: [215, 217, 219],
  wing: [204, 207, 212], wingB: [178, 183, 190], fair: [196, 200, 206],
  engine: [156, 160, 168], engDark: [55, 60, 70], pylon: [172, 176, 182],
  dark: [70, 74, 82], tire: [40, 42, 46], strut: [128, 132, 138],
  red: [225, 30, 30], green: [30, 205, 60], white: [255, 255, 255],
  ...(spec.colors || {}),
};

// --- geometry buckets ---------------------------------------------------------------

const mkGeo = () => ({ v: [], r: [], faces: [] });
const addFace = (g, idx, color, opts) => g.faces.push({ idx, color, ...(opts || {}) });
// smooth=true marks the vertex 'R' (round): the engine shades it with the
// averaged normal of adjacent polygons — free curvature on low-poly lofts.
const addV = (g, x, y, z, smooth) => (g.r.push(!!smooth), g.v.push([x, y, z]) - 1);
const merge = (...gs) => {
  const out = mkGeo();
  for (const g of gs) {
    const base = out.v.length;
    out.v.push(...g.v);
    out.r.push(...g.r);
    out.faces.push(...g.faces.map((f) => ({ ...f, idx: f.idx.map((i) => i + base) })));
  }
  return out;
};
const mirrorX = (g) => ({
  v: g.v.map(([x, y, z]) => [-x, y, z]),
  r: g.r.slice(),
  faces: g.faces.map((f) => ({ ...f, idx: f.idx.slice().reverse() })),
});

// --- fuselage stations (clamped Catmull-Rom over zn) ---------------------------------

const ST = spec.fuselage.stations;
function crSample(knots, key, zn) {
  let i = 0;
  while (i + 1 < knots.length && knots[i + 1].zn < zn) i++;
  if (i + 1 >= knots.length) return knots[knots.length - 1][key];
  const p1 = knots[i], p2 = knots[i + 1];
  const p0 = knots[Math.max(0, i - 1)], p3 = knots[Math.min(knots.length - 1, i + 2)];
  const t = (zn - p1.zn) / (p2.zn - p1.zn);
  const m1 = (p2[key] - p0[key]) / (p2.zn - p0.zn) * (p2.zn - p1.zn);
  const m2 = (p3[key] - p1[key]) / (p3.zn - p1.zn) * (p2.zn - p1.zn);
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p1[key] + (t3 - 2 * t2 + t) * m1 +
         (-2 * t3 + 3 * t2) * p2[key] + (t3 - t2) * m2;
}
const stationAt = (zn) => ({
  zn,
  top: crSample(ST, 'top', zn),
  bottom: crSample(ST, 'bottom', zn),
  w: Math.max(0.02, crSample(ST, 'w', zn)),
});
const denseZn = [];
for (let i = 0; i + 1 < ST.length; i++) {
  denseZn.push(ST[i].zn);
  const gap = ST[i + 1].zn - ST[i].zn, n = Math.floor(gap / 1.6);
  for (let k = 1; k <= n; k++) denseZn.push(ST[i].zn + (gap * k) / (n + 1));
}
denseZn.push(ST[ST.length - 1].zn);

// Hump detection: the baseline crown is the lowest 'top' over the aft half;
// stations rising above it (in the front half) get their upper lobe narrowed
// — the 747 upper deck is slimmer than the main deck.
const aftCrown = Math.min(...ST.filter((s) => s.zn > L * 0.45 && s.zn < L * 0.8).map((s) => s.top));
const humpNarrow = (st) =>
  (st.zn < L * 0.5 ? Math.min(1, Math.max(0, (st.top - (aftCrown + 0.15)) / 1.0)) * 0.24 : 0);

// Skin half-width at (zn, y) — used to place decals just off the skin.
function skinX(zn, y) {
  const s = stationAt(zn);
  const yc = (s.top + s.bottom) / 2, aUp = s.top - yc, aDn = yc - s.bottom;
  const a = y >= yc ? aUp : aDn;
  const sy = Math.min(1, Math.abs((y - yc) / Math.max(a, 1e-6)));
  const cx = Math.sqrt(Math.max(0, 1 - sy * sy));
  const nar = y > yc ? 1 - humpNarrow(s) * sy * sy : 1;
  return s.w * cx * nar;
}

// --- fuselage loft -------------------------------------------------------------------

function fuselage() {
  const g = mkGeo();
  const N = spec.fuselage.ringPoints || 32;
  const rings = denseZn.map((zn) => {
    const s = stationAt(zn);
    const yc = (s.top + s.bottom) / 2, aUp = s.top - yc, aDn = yc - s.bottom;
    const nar = humpNarrow(s);
    const ring = [];
    for (let i = 0; i < N; i++) {
      const th = (i / N) * Math.PI * 2;
      const sy = Math.sin(th);
      const y = yc + (sy >= 0 ? aUp : aDn) * sy;
      const x = s.w * Math.cos(th) * (sy > 0 ? 1 - nar * sy * sy : 1);
      ring.push({ i: addV(g, x, y, zys(zn), true), y });
    }
    return ring;
  });
  const bellyY = spec.fuselage.bellyY ?? -2.5;
  for (let r = 0; r + 1 < rings.length; r++) {
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const quad = [rings[r + 1][i], rings[r + 1][j], rings[r][j], rings[r][i]];
      const avgY = quad.reduce((s_, q) => s_ + q.y, 0) / 4;
      addFace(g, quad.map((q) => q.i), avgY < bellyY ? COL.belly : COL.body);
    }
  }
  addFace(g, rings[0].map((q) => q.i), COL.body);                          // nose cap (+z)
  addFace(g, rings[rings.length - 1].map((q) => q.i).reverse(), COL.dark); // APU exhaust (-z)
  return g;
}

// --- decals (spec.decals: cheatline / windows / doors / cockpit) ---------------------

function decals() {
  const g = mkGeo();
  const D = spec.decals;
  if (!D) return g;
  const strip = (zn0, zn1, y0, y1, color, step) => {
    const n = Math.max(1, Math.round((zn1 - zn0) / step));
    for (let k = 0; k < n; k++) {
      const a = zn0 + ((zn1 - zn0) * k) / n, b = zn0 + ((zn1 - zn0) * (k + 1)) / n;
      for (const sgn of [1, -1]) {
        const q = [
          addV(g, sgn * (skinX(a, y0) + 0.04), y0, zys(a)),
          addV(g, sgn * (skinX(b, y0) + 0.04), y0, zys(b)),
          addV(g, sgn * (skinX(b, y1) + 0.04), y1, zys(b)),
          addV(g, sgn * (skinX(a, y1) + 0.04), y1, zys(a)),
        ];
        addFace(g, sgn > 0 ? q : q.slice().reverse(), color);
      }
    }
  };
  const doors = D.doors ? D.doors.zn : [];
  if (D.cheatline) {
    const c = D.cheatline;
    strip(c.znFrom, c.znTo, c.y0, c.y1, COL.stripe, 2.2);
  }
  for (const row of D.windowRows || []) {
    for (let zn = row.znFrom; zn < row.znTo; zn += row.pitch || 1.15) {
      if (row.skipDoors && doors.some((d) => Math.abs(zn - d) < 1.0)) continue;
      strip(zn, zn + 0.55, row.y0, row.y1, COL.win, 1);
    }
  }
  if (D.doors) {
    for (const d of doors) strip(d - D.doors.halfW, d + D.doors.halfW, D.doors.y0, D.doors.y1, COL.door, 2);
  }
  if (D.cockpit) {
    const c = D.cockpit;
    strip(c.znFrom, c.znTo, c.y0, c.y1, COL.glass, 1);       // side glass
    if (c.front) {
      const f = c.front, xw = skinX((c.znFrom + c.znTo) / 2, (c.y0 + c.y1) / 2);
      const q = [
        addV(g, -xw * 0.55, f.y0, zys(f.zn)), addV(g, xw * 0.55, f.y0, zys(f.zn)),
        addV(g, xw * 0.42, f.y1, zys(f.zn + f.dz)), addV(g, -xw * 0.42, f.y1, zys(f.zn + f.dz)),
      ];
      addFace(g, q, COL.glass);
    }
  }
  return g;
}

// --- airfoil lofts --------------------------------------------------------------------
// chord fraction / upper / lower (fractions of half-thickness)

const PROF = [
  [0.0, 0.0, 0.0], [0.03, 0.55, -0.38], [0.10, 0.82, -0.48], [0.30, 1.0, -0.5],
  [0.60, 0.74, -0.3], [0.85, 0.34, -0.1], [1.0, 0.05, -0.02],
];
// sections: [{span, znLE, chord, off}]; spanAxis 'x' (wing/h-stab) or 'y' (fin)
function foilLoft(sections, thickness, colorT, colorB, spanAxis) {
  const g = mkGeo();
  const rootChord = sections[0].chord;
  const pt = (sp, off, z) => (spanAxis === 'x' ? [sp, off, z] : [off, sp, z]);
  const rings = sections.map((s) => {
    const t = (thickness * Math.max(0.3, s.chord / rootChord)) / 2;
    const off = s.off || 0;
    const up = [], dn = [];
    for (const [cf, uT, uB] of PROF) {
      const z = zys(s.znLE + s.chord * cf);
      up.push(addV(g, ...pt(s.span, off + uT * t, z), true));
      dn.push(addV(g, ...pt(s.span, off + uB * t, z), true));
    }
    return { up, dn };
  });
  const flipped = spanAxis === 'x';
  const F = (idx, c) => addFace(g, flipped ? idx : idx.slice().reverse(), c);
  for (let r = 0; r + 1 < rings.length; r++) {
    const A = rings[r], B = rings[r + 1];
    for (let i = 0; i + 1 < PROF.length; i++) {
      F([A.up[i], B.up[i], B.up[i + 1], A.up[i + 1]], colorT);          // upper
      F([A.dn[i + 1], B.dn[i + 1], B.dn[i], A.dn[i]], colorB);          // lower
    }
    const last = PROF.length - 1;
    F([A.up[last], B.up[last], B.dn[last], A.dn[last]], colorB);        // TE close
  }
  // root cap omitted — it sits inside the fuselage and z-fights the skin
  const tp = rings[rings.length - 1];
  const capIdx = (ring) => [...ring.up, ...ring.dn.slice().reverse()];
  addFace(g, flipped ? capIdx(tp) : capIdx(tp).reverse(), colorB);      // tip cap
  return g;
}

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

// Movable control surface: wedge loft over the cut region.  +0.05 hinge gap:
// a wedge LE face exactly coplanar with the fixed TE face z-fights (sawtooth
// flicker at distance — found by bisection render).
function wedge(sections, cut, thickness, color, spanAxis) {
  const inner = sectionAt(sections, cut.spanFrom), outer = sectionAt(sections, cut.spanTo);
  const inRange = sections.filter((s) => s.span > cut.spanFrom && s.span < cut.spanTo);
  const secs = [inner, ...inRange, outer].filter(Boolean).map((s) => ({
    ...s,
    znLE: s.znLE + s.chord * (1 - cut.chordFrac) + 0.05,
    chord: s.chord * cut.chordFrac - 0.05,
  }));
  const g = mkGeo();
  const pt = (sp, off, z) => (spanAxis === 'x' ? [sp, off, z] : [off, sp, z]);
  const rows = secs.map((s) => {
    const t = (thickness * 0.55) / 2, off = s.off || 0;
    return [
      addV(g, ...pt(s.span, off + t, zys(s.znLE))),
      addV(g, ...pt(s.span, off - t, zys(s.znLE))),
      addV(g, ...pt(s.span, off, zys(s.znLE + s.chord))),
    ];
  });
  const flipped = spanAxis === 'x';
  const F = (idx, c) => addFace(g, flipped ? idx : idx.slice().reverse(), c);
  for (let r = 0; r + 1 < rows.length; r++) {
    const [a0, a1, a2] = rows[r], [b0, b1, b2] = rows[r + 1];
    F([a0, b0, b2, a2], color); F([a2, b2, b1, a1], color); F([a1, b1, b0, a0], color);
  }
  addFace(g, flipped ? rows[0].slice().reverse() : rows[0], color);
  addFace(g, flipped ? rows[rows.length - 1] : rows[rows.length - 1].slice().reverse(), color);
  const mid = sectionAt(secs, (cut.spanFrom + cut.spanTo) / 2) || secs[0];
  const hinge = spanAxis === 'x'
    ? [(cut.spanFrom + cut.spanTo) / 2, mid.off || 0, zys(mid.znLE)]
    : [0, (cut.spanFrom + cut.spanTo) / 2, zys(mid.znLE)];
  return { geo: g, hinge };
}

// Fixed surface with the cut regions' chords shortened.  Epsilon-doubled
// boundary sections make crisp chord steps instead of long diagonals.
function fixedWithCuts(sections, cuts, thickness, colorT, colorB, spanAxis) {
  const marks = cuts.flatMap((c) => [c.spanFrom - 0.02, c.spanFrom, c.spanTo, c.spanTo + 0.02]);
  const all = [...sections];
  for (const m of marks) {
    const s = sectionAt(sections, m);
    if (s && !all.some((q) => Math.abs(q.span - m) < 1e-6)) all.push(s);
  }
  all.sort((p, q) => p.span - q.span);
  const out = all.map((s) => {
    const c = cuts.find((c_) => s.span >= c_.spanFrom - 1e-9 && s.span <= c_.spanTo + 1e-9);
    return c ? { ...s, chord: s.chord * (1 - c.chordFrac) } : s;
  });
  return foilLoft(out, thickness, colorT, colorB, spanAxis);
}

// --- flap track fairings (spec.wing.fairings, optional) -------------------------------

function fairings(wingSecs) {
  const g = mkGeo();
  const FA = spec.wing.fairings;
  if (!FA) return g;
  const R = FA.radius || 0.36, len = FA.length || 4.5, drop = FA.drop || 0.52;
  for (const sp of FA.spans) {
    const s = sectionAt(wingSecs, sp);
    if (!s) continue;
    const te = s.znLE + s.chord, y = (s.off || 0) - drop;
    const zn0 = te - len * 0.69;
    const prof = [[0, 0.28], [0.16, 0.75], [0.42, 1.0], [0.7, 0.83], [0.9, 0.44], [1, 0.08]];
    const N = 8;
    const rings = prof.map(([f, rr]) => {
      const ring = [];
      for (let i = 0; i < N; i++) {
        const th = (i / N) * Math.PI * 2;
        ring.push(addV(g, sp + R * rr * Math.cos(th) * 0.85, y + R * rr * Math.sin(th), zys(zn0 + len * f), true));
      }
      return ring;
    });
    for (let r = 0; r + 1 < rings.length; r++) {
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        addFace(g, [rings[r + 1][i], rings[r + 1][j], rings[r][j], rings[r][i]], COL.fair);
      }
    }
    addFace(g, rings[0], COL.fair);                                  // front cap (+z)
    addFace(g, rings[rings.length - 1].slice().reverse(), COL.fair); // rear cap (-z)
  }
  return g;
}

// --- engines ---------------------------------------------------------------------------

function engine(p, wingSecs) {
  const g = mkGeo();
  const N = 18, R = spec.engines.diameter / 2, EL = spec.engines.length;
  const ring = (zf, rf) => {
    const out = [];
    for (let i = 0; i < N; i++) {
      const th = (i / N) * Math.PI * 2;
      out.push(addV(g, p.x + R * rf * Math.cos(th), p.y + R * rf * Math.sin(th), zys(p.zn + EL * zf), true));
    }
    return out;
  };
  const shape = [[0, 0.86], [0.1, 1.0], [0.5, 0.97], [0.7, 0.84], [0.71, 0.52], [0.93, 0.33], [1.0, 0.15], [1.1, 0.02]];
  const rings = shape.map(([zf, rf]) => ring(zf, rf));
  for (let r = 0; r + 1 < rings.length; r++) {
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      addFace(g, [rings[r + 1][i], rings[r + 1][j], rings[r][j], rings[r][i]],
        r >= 4 ? COL.engDark : COL.engine);
    }
  }
  // intake: inner lip ring + fan disc (both face forward, +z)
  const lipIn = ring(0.04, 0.72);
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    addFace(g, [lipIn[j], lipIn[i], rings[0][i], rings[0][j]], COL.engine);
  }
  addFace(g, lipIn, COL.engDark); // fan
  // pylon: shaped plate nacelle top -> wing underside (follow the dihedral)
  const px = 0.22, zA = p.zn + EL * 0.18, zB = p.zn + EL * 0.95, zC = p.zn + EL * 0.55;
  const wsec = sectionAt(wingSecs, Math.abs(p.x));
  const y0 = p.y + R * 0.8, y1 = (wsec ? wsec.off : p.y + R + 2.4) + 0.25;
  const side = (sgn) => [
    addV(g, p.x + sgn * px, y0, zys(zA)), addV(g, p.x + sgn * px, y0, zys(zB)),
    addV(g, p.x + sgn * px, y1, zys(zB + 1.6)), addV(g, p.x + sgn * px, y1, zys(zC)),
  ];
  const Lp = side(1), Rp = side(-1);
  addFace(g, Lp, COL.pylon); addFace(g, Rp.slice().reverse(), COL.pylon);
  addFace(g, [Lp[3], Lp[0], Rp[0], Rp[3]], COL.pylon);                    // leading edge
  addFace(g, [Rp[2], Rp[1], Lp[1], Lp[2]], COL.pylon);                    // trailing edge
  return g;
}

// --- gear (outward-wound boxes / wheels) -----------------------------------------------

function wheel(g, cx, cy, cz, r, w) {
  const N = 12, a = [], b = [];
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2;
    a.push(addV(g, cx - w / 2, cy + r * Math.sin(th), cz + r * Math.cos(th), true));
    b.push(addV(g, cx + w / 2, cy + r * Math.sin(th), cz + r * Math.cos(th), true));
  }
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    addFace(g, [b[i], b[j], a[j], a[i]], COL.tire);
  }
  addFace(g, a, COL.dark);                   // left cap (-x)
  addFace(g, b.slice().reverse(), COL.dark); // right cap (+x)
}
function box(g, x0, x1, y0, y1, z0, z1, color) {
  const b = [
    addV(g, x0, y0, z0), addV(g, x1, y0, z0), addV(g, x1, y1, z0), addV(g, x0, y1, z0),
    addV(g, x0, y0, z1), addV(g, x1, y0, z1), addV(g, x1, y1, z1), addV(g, x0, y1, z1),
  ];
  // outward winding (each quad CCW seen from outside the box)
  for (const q of [[3, 2, 1, 0], [6, 7, 4, 5], [7, 3, 0, 4], [2, 6, 5, 1], [7, 6, 2, 3], [0, 1, 5, 4]]) {
    addFace(g, q.map((i) => b[i]), color);
  }
}
function bogie(x, zn, topY, axleY) {
  const g = mkGeo();
  const z = zys(zn);
  box(g, x - 0.16, x + 0.16, axleY + 0.35, topY, z - 0.16, z + 0.16, COL.strut);         // strut
  box(g, x - 0.14, x + 0.14, axleY + 0.15, axleY + 0.55, z - 1.85, z + 1.85, COL.strut); // beam
  for (const dz of [-1.35, 1.35]) {
    wheel(g, x - 0.56, axleY, z + dz, 0.58, 0.46);
    wheel(g, x + 0.56, axleY, z + dz, 0.58, 0.46);
  }
  return g;
}
function noseGear(x, zn, topY, axleY) {
  const g = mkGeo();
  const z = zys(zn);
  box(g, x - 0.14, x + 0.14, axleY, topY, z - 0.14, z + 0.14, COL.strut);
  wheel(g, x - 0.42, axleY, z, 0.5, 0.4);
  wheel(g, x + 0.42, axleY, z, 0.5, 0.4);
  return g;
}
// spec.gear.posts, or synthesize the classic 3-post layout from {nose, mains}
const gearPosts = spec.gear.posts || [
  { type: 'nose', label: 'NoseGear', x: 0, zn: spec.gear.nose.zn, topY: spec.gear.nose.topY, axleY: spec.gear.nose.bottomY + 0.5 },
  { type: 'bogie', label: 'MainGear', mirror: true, x: spec.gear.mains.x, zn: spec.gear.mains.zn, topY: spec.gear.mains.topY, axleY: spec.gear.mains.bottomY + 0.58 },
];

// --- lights ------------------------------------------------------------------------------

function lightBox(x, y, z, s, color) {
  const g = mkGeo();
  box(g, x - s, x + s, y - s, y + s, z - s, z + s, color);
  g.faces.forEach((f) => (f.bright = true));
  return g;
}

// --- assemble ----------------------------------------------------------------------------

const zero = [0, 0, 0, 0, 0, 0, 1];
const rot = (h, p, b, vis = 1) => [0, 0, 0, h, p, b, vis];
const parts = [];
const P = (label, cla, geo, hinge, sta, children) =>
  parts.push({ label, cla, geo, hinge: hinge || [0, 0, 0], sta: sta || [zero, zero], children: children || [] });

const wingSecs = [];
{ // densify wing sections (midpoints between the measured ones -> smoother loft)
  const src = spec.wing.sections.map((s) => ({ span: s.x, znLE: s.znLE, chord: s.chord, off: s.y }));
  for (let i = 0; i < src.length; i++) {
    wingSecs.push(src[i]);
    if (i + 1 < src.length) {
      const m = sectionAt(src, (src[i].span + src[i + 1].span) / 2);
      if (m) wingSecs.push(m);
    }
  }
}
const wingFixed = fixedWithCuts(wingSecs, [spec.wing.flaps, spec.wing.ailerons], spec.wing.thickness, COL[spec.wing.color] || COL.wing, COL.wingB, 'x');
const flap = wedge(wingSecs, spec.wing.flaps, spec.wing.thickness, COL.wingB, 'x');
const ail = wedge(wingSecs, spec.wing.ailerons, spec.wing.thickness, COL[spec.wing.color] || COL.wing, 'x');

const hsSecs = spec.hstab.sections.map((s) => ({ span: s.x, znLE: s.znLE, chord: s.chord, off: s.y }));
const hsFixed = fixedWithCuts(hsSecs, [spec.hstab.elevator], spec.hstab.thickness, COL[spec.hstab.color] || COL.wing, COL.wingB, 'x');
const elev = wedge(hsSecs, spec.hstab.elevator, spec.hstab.thickness, COL[spec.hstab.color] || COL.wing, 'x');

const finSecs = spec.fin.sections.map((s) => ({ span: s.y, znLE: s.znLE, chord: s.chord, off: 0 }));
const finFixed = fixedWithCuts(finSecs, [spec.fin.rudder], spec.fin.thickness, COL[spec.fin.color] || COL.body, COL[spec.fin.color] || COL.body, 'y');
const rud = wedge(finSecs, spec.fin.rudder, spec.fin.thickness, COL[spec.fin.color] || COL.body, 'y');

// dorsal fillet: thin triangle prism crown -> fin LE (spec.fin.dorsal, optional)
const dorsal = (() => {
  const g = mkGeo();
  const D = spec.fin.dorsal;
  if (!D) return g;
  const t = 0.18;
  const a = { z: zys(D.znFrom), y: D.yBase }, b = { z: zys(D.znTo), y: D.yBase - 0.03 }, c = { z: zys(D.znTo + 0.4), y: D.yTop };
  for (const sgn of [1, -1]) {
    const q = [addV(g, sgn * t, a.y, a.z), addV(g, sgn * t, b.y, b.z), addV(g, sgn * t, c.y, c.z)];
    addFace(g, sgn > 0 ? q : q.slice().reverse(), COL[spec.fin.color] || COL.body);
  }
  const l0 = addV(g, t, a.y, a.z), l1 = addV(g, t, c.y, c.z), r0 = addV(g, -t, a.y, a.z), r1 = addV(g, -t, c.y, c.z);
  addFace(g, [l0, l1, r1, r0], COL[spec.fin.color] || COL.body); // leading face (up-forward)
  return g;
})();

const tipSec = spec.wing.sections[spec.wing.sections.length - 1];
const lastSt = ST[ST.length - 1];
const staticGeo = merge(
  fuselage(), decals(),
  wingFixed, mirrorX(wingFixed),
  fairings(wingSecs), mirrorX(fairings(wingSecs)),
  hsFixed, mirrorX(hsFixed),
  finFixed, dorsal,
  ...spec.engines.positions.map((p) => engine(p, wingSecs)),
  // nav lights: wingtips (red left / green right) + tail strobe
  lightBox(-tipSec.x + 0.1, tipSec.y, zys(tipSec.znLE + 0.4), 0.14, COL.red),
  lightBox(tipSec.x - 0.1, tipSec.y, zys(tipSec.znLE + 0.4), 0.14, COL.green),
  lightBox(0, (lastSt.top + lastSt.bottom) / 2, zys(lastSt.zn + 0.1), 0.12, COL.white),
);

const beaconGeo = lightBox(0, stationAt(spec.beacon.zn).top + 0.1, zys(spec.beacon.zn), 0.13, COL.red);

const gearLabels = gearPosts.flatMap((p) => (p.mirror ? [p.label + 'L', p.label + 'R'] : [p.label]));
P('Fuselage', 0, staticGeo, null, null, [
  'FlapL', 'FlapR', 'AileronL', 'AileronR', 'ElevatorL', 'ElevatorR', 'Rudder',
  ...gearLabels, 'Beacon',
]);
P('FlapL', 5, flap.geo, flap.hinge, [zero, rot(0, DEG(22), 0)]);
P('FlapR', 5, mirrorX(flap.geo), [-flap.hinge[0], flap.hinge[1], flap.hinge[2]], [zero, rot(0, DEG(22), 0)]);
P('AileronL', 7, ail.geo, ail.hinge, [zero, rot(0, DEG(-12), 0), rot(0, DEG(12), 0)]);
P('AileronR', 7, mirrorX(ail.geo), [-ail.hinge[0], ail.hinge[1], ail.hinge[2]], [zero, rot(0, DEG(12), 0), rot(0, DEG(-12), 0)]);
P('ElevatorL', 6, elev.geo, elev.hinge, [zero, rot(0, DEG(-18), 0), rot(0, DEG(18), 0)]);
P('ElevatorR', 6, mirrorX(elev.geo), [-elev.hinge[0], elev.hinge[1], elev.hinge[2]], [zero, rot(0, DEG(-18), 0), rot(0, DEG(18), 0)]);
P('Rudder', 8, rud.geo, rud.hinge, [zero, rot(DEG(-18), 0, 0), rot(DEG(18), 0, 0)]);

const gearRetract = rot(0, DEG(-100), 0, 0);
for (const post of gearPosts) {
  const mk = (x) => (post.type === 'nose' ? noseGear(x, post.zn, post.topY, post.axleY) : bogie(x, post.zn, post.topY, post.axleY));
  if (post.mirror) {
    P(post.label + 'L', 0, mk(-post.x), [-post.x, post.topY, zys(post.zn)], [gearRetract, zero]);
    P(post.label + 'R', 0, mk(post.x), [post.x, post.topY, zys(post.zn)], [gearRetract, zero]);
  } else {
    P(post.label, 0, mk(post.x), [post.x, post.topY, zys(post.zn)], [gearRetract, zero]);
  }
}
P('Beacon', 30, beaconGeo, null, [zero, zero]);

// --- DNM writer -------------------------------------------------------------------------

const f6 = (v) => (Math.abs(v) < 5e-7 ? '0' : String(Math.round(v * 1e6) / 1e6));
const out = ['DYNAMODEL', 'DNMVER 2'];
for (const p of parts) {
  const lines = ['SURF'];
  p.geo.v.forEach((v, i) => lines.push('V ' + v.map(f6).join(' ') + (p.geo.r[i] ? ' R' : '')));
  for (const f of p.geo.faces) {
    lines.push('F');
    if (f.bright) lines.push('B');
    lines.push('V ' + f.idx.join(' '));
    // explicit N (center + Newell normal) — see the header note
    const vs = f.idx.map((i) => p.geo.v[i]);
    let cx = 0, cy = 0, cz = 0, nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < vs.length; i++) {
      const [x0, y0, z0] = vs[i], [x1, y1, z1] = vs[(i + 1) % vs.length];
      cx += x0; cy += y0; cz += z0;
      nx += (y0 - y1) * (z0 + z1);
      ny += (z0 - z1) * (x0 + x1);
      nz += (x0 - x1) * (y0 + y1);
    }
    const nl = Math.hypot(nx, ny, nz) || 1, m = vs.length;
    lines.push('N ' + [cx / m, cy / m, cz / m, nx / nl, ny / nl, nz / nl].map(f6).join(' '));
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
