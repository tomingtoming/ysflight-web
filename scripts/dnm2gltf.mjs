// DNM -> glTF (.glb) converter: opens YSFLIGHT aircraft in Blender (which
// reads glTF natively — no Blender addon to maintain, no API churn).
//
//   node scripts/dnm2gltf.mjs <input.dnm> <output.glb>
//
// What carries over:
//   - the full node hierarchy, with each node's REST transform composed
//     exactly like the engine does (ysshelldnmtemplate.h CacheTransformation,
//     the same math web/dnm-preview.js renders with):
//       T(POS) . RotateXZ(h) . RotateZY(p) . RotateXY(b)
//              . T(STA0.pos) . R(STA0.hpb) . T(-CNT)
//   - geometry per node, triangulated (fan), flat-shaded, one glTF material
//     per distinct face color (so Blender shows the paint immediately)
//   - every YSFLIGHT-specific bit (CLA class, POS, all STA states, CNT) into
//     each node's `extras.ysflight` — Blender imports extras as custom
//     properties and round-trips them, which is what scripts/gltf2dnm.mjs
//     (the way back) reads.
//   - movable parts (STA states that differ) become glTF ANIMATIONS, one per
//     CLA class ("Gear", "Flap", "Elevator", ...), keyframed through every
//     STA state — Blender's timeline plays the gear retracting.  This is why
//     nodes carry TRS instead of a matrix: animation channels target TRS.
//
// Coordinates are exported as-is (DNM is Y-up like glTF; +Z is the tail).

import { readFileSync, writeFileSync } from 'node:fs';
import { parseDnm } from '../web/dnm-preview.js';

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error('usage: node scripts/dnm2gltf.mjs <input.dnm> <output.glb>');
  process.exit(2);
}

// --- tiny row-major 4x4 (column-vector convention, matching the engine) --------

const I4 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mul = (A, B) => {
  const O = new Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      O[r * 4 + c] = A[r * 4] * B[c] + A[r * 4 + 1] * B[4 + c] + A[r * 4 + 2] * B[8 + c] + A[r * 4 + 3] * B[12 + c];
    }
  }
  return O;
};
const T = (x, y, z) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
// YsMatrix4x4 rotations, exact C++ signs (verified via webflight's line-2-line
// port and its characterization tests against the original):
const rotXZ = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; };
const rotZY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; };
const rotXY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; };
const A2R = Math.PI / 32768;

function nodeMatrix(pos, sta, cnt) {
  let M = T(pos[0] || 0, pos[1] || 0, pos[2] || 0);
  M = mul(M, rotXZ((pos[3] || 0) * A2R));
  M = mul(M, rotZY((pos[4] || 0) * A2R));
  M = mul(M, rotXY((pos[5] || 0) * A2R));
  if (sta) {
    M = mul(M, T(sta[0] || 0, sta[1] || 0, sta[2] || 0));
    M = mul(M, rotXZ((sta[3] || 0) * A2R));
    M = mul(M, rotZY((sta[4] || 0) * A2R));
    M = mul(M, rotXY((sta[5] || 0) * A2R));
  }
  M = mul(M, T(-(cnt[0] || 0), -(cnt[1] || 0), -(cnt[2] || 0)));
  return M;
}
// Node matrices here are rigid (rotation+translation only), so every one
// decomposes exactly into glTF translation+rotation — which is REQUIRED for
// animation: glTF animation channels target TRS, never a raw matrix.
function matToTQ(M) {
  const t = [M[3], M[7], M[11]];
  const m00 = M[0], m01 = M[1], m02 = M[2], m10 = M[4], m11 = M[5], m12 = M[6], m20 = M[8], m21 = M[9], m22 = M[10];
  const tr = m00 + m11 + m22;
  let x, y, z, w;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4;
  }
  return { t, q: [x, y, z, w] };
}
const staDiffers = (sta) => sta && sta.length >= 2 &&
  sta[0].slice(0, 6).some((v, i) => Math.abs(v - sta[sta.length - 1][i]) > 1e-6);
// Human-readable animation names per DNM CLA class (ysshelldnmident.h).
const CLA_NAME = {
  0: 'Gear', 1: 'VariableGeometryWing', 2: 'Afterburner', 4: 'AirBrake',
  5: 'Flap', 6: 'Elevator', 7: 'Aileron', 8: 'Rudder', 16: 'Brake',
  17: 'Spoiler', 21: 'Rotor', 22: 'TailRotor',
};

// --- geometry: SRF -> primitives grouped by face color ---------------------------

const materials = [];
const materialIx = new Map(); // 'r,g,b' -> index
function materialFor(color) {
  const key = color.join(',');
  if (materialIx.has(key)) return materialIx.get(key);
  const ix = materials.length;
  materials.push({
    name: 'C_' + key.replace(/,/g, '_'),
    pbrMetallicRoughness: {
      baseColorFactor: [color[0] / 255, color[1] / 255, color[2] / 255, 1],
      metallicFactor: 0,
      roughnessFactor: 0.9,
    },
    doubleSided: true,
  });
  materialIx.set(key, ix);
  return ix;
}

const binParts = [];
let binLen = 0;
const bufferViews = [];
const accessors = [];
const NCOMP = { SCALAR: 1, VEC3: 3, VEC4: 4 };
function pushAcc(arr, type, opts) {
  const bytes = Buffer.from(new Float32Array(arr).buffer);
  const bv = bufferViews.length;
  bufferViews.push({
    buffer: 0, byteOffset: binLen, byteLength: bytes.length,
    ...(opts && opts.vertex ? { target: 34962 } : {}),
  });
  binParts.push(bytes);
  binLen += bytes.length; // Float32 stays 4-byte aligned
  const acc = accessors.length;
  accessors.push({
    bufferView: bv, componentType: 5126, count: arr.length / NCOMP[type], type,
    ...(opts && opts.minmax ? { min: opts.minmax[0], max: opts.minmax[1] } : {}),
  });
  return acc;
}
const pushFloats = (arr, min, max) => pushAcc(arr, 'VEC3', { vertex: true, ...(min && max ? { minmax: [min, max] } : {}) });

function meshFromSrf(srf, name) {
  // color key -> flat position array (non-indexed, flat-shaded triangles)
  const byColor = new Map();
  for (const f of srf.faces) {
    if (f.idx.length < 3) continue;
    const key = (f.color || [128, 128, 128]).join(',');
    let bucket = byColor.get(key);
    if (!bucket) { bucket = { color: f.color || [128, 128, 128], pos: [] }; byColor.set(key, bucket); }
    for (let i = 1; i + 1 < f.idx.length; i++) { // fan triangulation
      for (const vi of [f.idx[0], f.idx[i], f.idx[i + 1]]) {
        const v = srf.vertices[vi];
        if (v) bucket.pos.push(v[0], v[1], v[2]);
      }
    }
  }
  const primitives = [];
  for (const { color, pos } of byColor.values()) {
    if (!pos.length) continue;
    // flat normals per triangle
    const nrm = new Array(pos.length);
    for (let t = 0; t < pos.length; t += 9) {
      const ax = pos[t + 3] - pos[t], ay = pos[t + 4] - pos[t + 1], az = pos[t + 5] - pos[t + 2];
      const bx = pos[t + 6] - pos[t], by = pos[t + 7] - pos[t + 1], bz = pos[t + 8] - pos[t + 2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      for (let k = 0; k < 3; k++) { nrm[t + k * 3] = nx; nrm[t + k * 3 + 1] = ny; nrm[t + k * 3 + 2] = nz; }
    }
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) {
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
    }
    primitives.push({
      attributes: { POSITION: pushFloats(pos, min, max), NORMAL: pushFloats(nrm) },
      material: materialFor(color),
    });
  }
  if (!primitives.length) return null;
  return { name, primitives };
}

// --- walk the DNM node tree -------------------------------------------------------

const dnm = parseDnm(readFileSync(inPath));
const gnodes = [];
const meshes = [];
const animByName = new Map(); // 'Gear' -> {name, samplers, channels}

function emitNode(label) {
  const n = dnm.nodes.get(label);
  if (!n) return null;
  const node = { name: label };
  const pos = n.pos || [0, 0, 0, 0, 0, 0], cnt = n.cnt || [0, 0, 0];
  const rest = matToTQ(nodeMatrix(pos, (n.sta && n.sta[0]) || null, cnt));
  if (rest.t.some((v) => Math.abs(v) > 1e-9)) node.translation = rest.t;
  if (Math.abs(rest.q[3] - 1) > 1e-9) node.rotation = rest.q;
  const srf = n.srf && dnm.srfByName.get(n.srf);
  if (srf) {
    const mesh = meshFromSrf(srf, n.srf);
    if (mesh) { node.mesh = meshes.length; meshes.push(mesh); }
  }
  node.extras = { ysflight: { cla: n.cla || 0, pos, cnt, sta: n.sta || [], srf: n.srf || null } };
  const children = (n.children || []).map(emitNode).filter((ix) => ix !== null);
  if (children.length) node.children = children;
  const ix = gnodes.length;
  gnodes.push(node);

  // Movable part (its STA states differ): one glTF animation per CLA class
  // ("Gear", "Flap", ...) with a keyframe per STA state, 1s apart — Blender
  // imports each as an action and the timeline plays the part through its
  // whole range (gear retracting, flaps dropping, ...).
  if (staDiffers(n.sta)) {
    const name = CLA_NAME[n.cla] || ('Class' + (n.cla || 0));
    let anim = animByName.get(name);
    if (!anim) { anim = { name, samplers: [], channels: [] }; animByName.set(name, anim); }
    const times = [], ts = [], qs = [];
    n.sta.forEach((sta, i) => {
      const { t, q } = matToTQ(nodeMatrix(pos, sta, cnt));
      times.push(i);
      ts.push(...t);
      qs.push(...q);
    });
    const input = pushAcc(times, 'SCALAR', { minmax: [[0], [times.length - 1]] });
    const sT = anim.samplers.length;
    anim.samplers.push({ input, output: pushAcc(ts, 'VEC3'), interpolation: 'LINEAR' });
    anim.channels.push({ sampler: sT, target: { node: ix, path: 'translation' } });
    const sR = anim.samplers.length;
    anim.samplers.push({ input, output: pushAcc(qs, 'VEC4'), interpolation: 'LINEAR' });
    anim.channels.push({ sampler: sR, target: { node: ix, path: 'rotation' } });
  }
  return ix;
}

const rootIx = dnm.roots.map(emitNode).filter((ix) => ix !== null);
if (!rootIx.length) { console.error('no nodes exported (is this a DNM?)'); process.exit(1); }

// --- GLB assembly ------------------------------------------------------------------

const gltf = {
  asset: { version: '2.0', generator: 'ysflight-web dnm2gltf' },
  scene: 0,
  scenes: [{ nodes: rootIx, name: inPath.split(/[\\/]/).pop() }],
  nodes: gnodes,
  meshes,
  materials,
  bufferViews,
  accessors,
  buffers: [{ byteLength: binLen }],
};
if (animByName.size) gltf.animations = [...animByName.values()];

const jsonBytes0 = Buffer.from(JSON.stringify(gltf), 'utf8');
const jsonPad = (4 - (jsonBytes0.length % 4)) % 4;
const jsonBytes = Buffer.concat([jsonBytes0, Buffer.alloc(jsonPad, 0x20)]);
const binBytes0 = Buffer.concat(binParts);
const binPad = (4 - (binBytes0.length % 4)) % 4;
const binBytes = Buffer.concat([binBytes0, Buffer.alloc(binPad)]);

const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); // 'glTF'
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + binBytes.length, 8);
const jsonHdr = Buffer.alloc(8);
jsonHdr.writeUInt32LE(jsonBytes.length, 0);
jsonHdr.writeUInt32LE(0x4e4f534a, 4); // 'JSON'
const binHdr = Buffer.alloc(8);
binHdr.writeUInt32LE(binBytes.length, 0);
binHdr.writeUInt32LE(0x004e4942, 4); // 'BIN\0'

writeFileSync(outPath, Buffer.concat([header, jsonHdr, jsonBytes, binHdr, binBytes]));
const tris = accessors.filter((a, i) => meshes.some((m) => m.primitives.some((p) => p.attributes.POSITION === i)))
  .reduce((n, a) => n + a.count / 3, 0);
console.log(JSON.stringify({
  out: outPath, nodes: gnodes.length, meshes: meshes.length,
  materials: materials.length, triangles: tris,
  animations: (gltf.animations || []).map((a) => a.name + ':' + a.channels.length / 2),
  bytes: 12 + 16 + jsonBytes.length + binBytes.length,
}));
