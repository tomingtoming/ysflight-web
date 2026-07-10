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
//     properties and round-trips them, which is the seed of the future
//     glTF -> DNM importer.
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
// glTF wants column-major.
const toColumnMajor = (M) => [
  M[0], M[4], M[8], M[12],
  M[1], M[5], M[9], M[13],
  M[2], M[6], M[10], M[14],
  M[3], M[7], M[11], M[15],
];
const isIdentity = (M) => M.every((v, i) => Math.abs(v - I4()[i]) < 1e-9);

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
function pushFloats(arr, min, max) {
  const bytes = Buffer.from(new Float32Array(arr).buffer);
  const bv = bufferViews.length;
  bufferViews.push({ buffer: 0, byteOffset: binLen, byteLength: bytes.length, target: 34962 });
  binParts.push(bytes);
  binLen += bytes.length; // Float32 triples stay 4-byte aligned
  const acc = accessors.length;
  accessors.push({
    bufferView: bv, componentType: 5126, count: arr.length / 3, type: 'VEC3',
    ...(min && max ? { min, max } : {}),
  });
  return acc;
}

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

function emitNode(label) {
  const n = dnm.nodes.get(label);
  if (!n) return null;
  const node = { name: label };
  const M = nodeMatrix(n.pos || [0, 0, 0, 0, 0, 0], (n.sta && n.sta[0]) || null, n.cnt || [0, 0, 0]);
  if (!isIdentity(M)) node.matrix = toColumnMajor(M);
  const srf = n.srf && dnm.srfByName.get(n.srf);
  if (srf) {
    const mesh = meshFromSrf(srf, n.srf);
    if (mesh) { node.mesh = meshes.length; meshes.push(mesh); }
  }
  node.extras = { ysflight: { cla: n.cla || 0, pos: n.pos || [], cnt: n.cnt || [], sta: n.sta || [], srf: n.srf || null } };
  const children = (n.children || []).map(emitNode).filter((ix) => ix !== null);
  if (children.length) node.children = children;
  const ix = gnodes.length;
  gnodes.push(node);
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
  materials: materials.length, triangles: tris, bytes: 12 + 16 + jsonBytes.length + binBytes.length,
}));
