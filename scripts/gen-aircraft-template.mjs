// Generates the "start an aircraft from scratch in Blender" template:
//   templates/aircraft-starter.dnm   (the source of truth, stock-convention DNM)
//   templates/aircraft-starter.glb   (what you actually open in Blender —
//                                     produced by scripts/dnm2gltf.mjs, so it
//                                     arrives with hierarchy, extras.ysflight
//                                     custom properties AND the movable-part
//                                     animations already in place)
//
//   node scripts/gen-aircraft-template.mjs
//
// The template is a boxy ~13m fighter with every standard movable class wired
// the way stock files do it (verified against f22.dnm):
//   - nose = +Z, up = +Y, meters
//   - geometry authored in AIRCRAFT coordinates; each movable node carries
//     POS = CNT = its hinge point (they cancel at rest, rotate about the hinge)
//   - gear: STA0 = retracted (vis 0), STA1 = deployed (vis 1)
//   - control surfaces: NST 3 = neutral / one way / other way
// Blender users replace the placeholder boxes in Edit Mode (object origins and
// the ysflight custom properties are what matter) and export with
// Include > Data > Custom Properties checked.

import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEG = (d) => Math.round(d * 32768 / 180);

// --- box geometry in aircraft coords (quads; the glb pipeline triangulates) -----

function box([x0, x1], [y0, y1], [z0, z1], color) {
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const quads = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]];
  return { v, faces: quads.map((idx) => ({ idx, color })) };
}
const merge = (...gs) => {
  const v = [], faces = [];
  for (const g of gs) {
    const base = v.length;
    v.push(...g.v);
    faces.push(...g.faces.map((f) => ({ idx: f.idx.map((i) => i + base), color: f.color })));
  }
  return { v, faces };
};

const GRAY = [176, 184, 196], DARK = [96, 104, 118], BLUE = [40, 80, 220], REDC = [220, 40, 40],
  ORANGE = [255, 120, 30], YELLOW = [230, 200, 60];

// --- parts -----------------------------------------------------------------------
// {label, cla, geo, hinge (POS=CNT), sta: [[x,y,z,h,p,b,vis],...], children}

const parts = [];
const P = (label, cla, geo, hinge, sta, children) =>
  parts.push({ label, cla, geo, hinge: hinge || [0, 0, 0], sta: sta || null, children: children || [] });

const zero = [0, 0, 0, 0, 0, 0, 1];
const rot = (h, p, b, vis = 1) => [0, 0, 0, h, p, b, vis];

// Static airframe (root): fuselage + nose taper + canopy + wings + fin.
P('Fuselage', 0,
  merge(
    box([-0.6, 0.6], [-0.5, 0.6], [-5.5, 5.0], GRAY),   // main tube
    box([-0.35, 0.35], [-0.3, 0.3], [5.0, 6.8], GRAY),  // nose cone (boxy)
    box([-0.45, 0.45], [0.6, 1.05], [1.5, 4.0], BLUE),  // canopy
    box([-5.0, -0.6], [-0.06, 0.06], [-2.0, 1.2], GRAY), // wing L
    box([0.6, 5.0], [-0.06, 0.06], [-2.0, 1.2], GRAY),   // wing R
    box([-0.08, 0.08], [0.6, 2.4], [-5.4, -3.6], GRAY),  // vertical fin
    box([-2.2, 2.2], [0.24, 0.36], [-5.4, -4.6], GRAY),  // h-stab (fixed part)
  ),
  null, null,
  ['NoseGear', 'MainGearL', 'MainGearR', 'FlapL', 'FlapR', 'AileronL', 'AileronR',
    'Elevator', 'Rudder', 'AirBrake', 'Afterburner', 'Beacon']);

// Gear (CLA 0): STA0 retracted+hidden, STA1 deployed — the stock convention.
const gearRetract = rot(0, DEG(-100), 0, 0);
P('NoseGear', 0, merge(
  box([-0.06, 0.06], [-1.5, -0.4], [3.4, 3.55], DARK),   // strut
  box([-0.1, 0.1], [-1.75, -1.45], [3.3, 3.65], DARK),   // wheel
), [0, -0.4, 3.5], [gearRetract, zero]);
P('MainGearL', 0, merge(
  box([-1.66, -1.54], [-1.4, -0.3], [-0.7, -0.55], DARK),
  box([-1.7, -1.5], [-1.7, -1.35], [-0.8, -0.45], DARK),
), [-1.6, -0.3, -0.6], [gearRetract, zero]);
P('MainGearR', 0, merge(
  box([1.54, 1.66], [-1.4, -0.3], [-0.7, -0.55], DARK),
  box([1.5, 1.7], [-1.7, -1.35], [-0.8, -0.45], DARK),
), [1.6, -0.3, -0.6], [gearRetract, zero]);

// Flaps (CLA 5): neutral -> 20 deg down.  Hinge = the flap's leading edge.
P('FlapL', 5, box([-2.8, -0.8], [-0.05, 0.05], [-2.7, -2.0], DARK), [0, 0, -2.0], [zero, rot(0, DEG(20), 0)]);
P('FlapR', 5, box([0.8, 2.8], [-0.05, 0.05], [-2.7, -2.0], DARK), [0, 0, -2.0], [zero, rot(0, DEG(20), 0)]);

// Ailerons (CLA 7): NST 3 = neutral / deflect / opposite, mirrored L-R.
P('AileronL', 7, box([-4.9, -3.0], [-0.05, 0.05], [-2.7, -2.0], GRAY), [0, 0, -2.0],
  [zero, rot(0, DEG(-15), 0), rot(0, DEG(15), 0)]);
P('AileronR', 7, box([3.0, 4.9], [-0.05, 0.05], [-2.7, -2.0], GRAY), [0, 0, -2.0],
  [zero, rot(0, DEG(15), 0), rot(0, DEG(-15), 0)]);

// Elevator (CLA 6) / Rudder (CLA 8): NST 3, hinged at their leading edge.
P('Elevator', 6, box([-2.2, 2.2], [0.25, 0.35], [-6.4, -5.4], GRAY), [0, 0.3, -5.4],
  [zero, rot(0, DEG(-20), 0), rot(0, DEG(20), 0)]);
P('Rudder', 8, box([-0.07, 0.07], [0.7, 2.3], [-6.3, -5.4], GRAY), [0, 0, -5.4],
  [zero, rot(DEG(-20), 0, 0), rot(DEG(20), 0, 0)]);

// Air brake (CLA 4): spine panel, closed -> 45 deg up.
P('AirBrake', 4, box([-0.4, 0.4], [0.6, 0.68], [-1.2, 0.0], DARK), [0, 0.6, 0.0], [zero, rot(0, DEG(-45), 0)]);

// Afterburner flame (CLA 2): the engine toggles it with the throttle.
P('Afterburner', 2, box([-0.3, 0.3], [-0.35, 0.35], [-6.3, -5.5], ORANGE), null, [zero, zero]);

// Beacon (CLA 30, a nav-light class): the paint shop auto-protects these.
P('Beacon', 30, box([-0.05, 0.05], [1.05, 1.15], [2.6, 2.8], REDC), null, [zero, zero]);

// Wingtip marker so left/right is obvious at a glance in Blender.
parts.find((p) => p.label === 'AileronL').geo =
  merge(parts.find((p) => p.label === 'AileronL').geo, box([-5.0, -4.7], [-0.08, 0.08], [-2.0, -1.6], YELLOW));

// --- DNM text ----------------------------------------------------------------------

const f6 = (v) => (Math.abs(v) < 5e-7 ? '0' : String(Math.round(v * 1e6) / 1e6));
const out = ['DYNAMODEL', 'DNMVER 2'];
for (const p of parts) {
  const lines = ['SURF'];
  for (const v of p.geo.v) lines.push('V ' + v.map(f6).join(' '));
  for (const f of p.geo.faces) {
    lines.push('F');
    lines.push('V ' + f.idx.join(' '));
    lines.push('C ' + f.color.join(' '));
    lines.push('E');
  }
  out.push('PCK ' + p.label.toLowerCase() + '.srf ' + lines.length);
  out.push(lines.join('\n'));
}
for (const p of parts) {
  const sta = p.sta || [zero, zero];
  out.push('SRF "' + p.label + '"');
  out.push('FIL ' + p.label.toLowerCase() + '.srf');
  out.push('CLA ' + p.cla);
  out.push('NST ' + sta.length);
  for (const s of sta) out.push('STA ' + s.slice(0, 3).map(f6).join(' ') + ' ' + s.slice(3, 6).join(' ') + ' ' + s[6]);
  out.push('POS ' + p.hinge.map(f6).join(' ') + ' 0 0 0 1');
  out.push('CNT ' + p.hinge.map(f6).join(' '));
  out.push('PAX 0 0 0');
  out.push('REL DEP');
  out.push('NCH ' + p.children.length);
  for (const c of p.children) out.push('CLD "' + c + '"');
  out.push('END');
}
out.push('END');

mkdirSync(join(root, 'templates'), { recursive: true });
const dnmPath = join(root, 'templates', 'aircraft-starter.dnm');
writeFileSync(dnmPath, out.join('\n') + '\n');
console.log('wrote ' + dnmPath);

// The .glb Blender users actually open: run the standard converter on it.
const glbPath = join(root, 'templates', 'aircraft-starter.glb');
execFileSync(process.execPath, [join(root, 'scripts', 'dnm2gltf.mjs'), dnmPath, glbPath], { stdio: 'inherit' });
