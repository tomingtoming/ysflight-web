// glTF (.glb) -> DNM converter: bring Blender-edited (or Blender-born) models
// back into YSFLIGHT.  Phase 2 of the Blender bridge (dnm2gltf.mjs is phase 1).
//
//   node scripts/gltf2dnm.mjs <input.glb> <output.dnm>
//
// Mapping:
//   - glTF node tree -> DNM node tree (labels from node names)
//   - extras.ysflight (round-tripped by Blender as custom properties) restores
//     CLA / POS / all STA states / CNT / the embedded srf name VERBATIM —
//     geometry edits round-trip; re-pivoting a movable part is out of scope
//     (edit extras or redo it in the workbench).
//   - nodes WITHOUT extras (made fresh in Blender): static part — CLA 0 with
//     two identical zero STAs (the stock-file idiom for "does not move"),
//     POS from the node's translation+rotation (decomposed into the engine's
//     h/p/b convention), CNT 0.
//   - mesh primitives -> SRF faces; face color from the primitive material's
//     baseColorFactor; positions welded back into shared vertices.  Flat
//     shading only (no R vertex flags) in this version.
//   - meshless nodes get the 3-line stub PCK stock files use for pure pivots.
//
// Supports the GLB container with indexed or non-indexed float32 POSITION,
// u8/u16/u32 indices, interleaved bufferViews, node matrix or TRS.

import { readFileSync, writeFileSync } from 'node:fs';

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error('usage: node scripts/gltf2dnm.mjs <input.glb> <output.dnm>');
  process.exit(2);
}

// --- GLB container ----------------------------------------------------------------

const glb = readFileSync(inPath);
if (glb.readUInt32LE(0) !== 0x46546c67) { console.error('not a GLB (magic mismatch)'); process.exit(1); }
let off = 12, json = null, bin = null;
while (off < glb.length) {
  const len = glb.readUInt32LE(off), type = glb.readUInt32LE(off + 4);
  const body = glb.subarray(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8'));
  else if (type === 0x004e4942) bin = body;
  off += 8 + len;
}
if (!json) { console.error('GLB has no JSON chunk'); process.exit(1); }

const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(ix) {
  const a = json.accessors[ix];
  const n = NCOMP[a.type], Arr = COMP[a.componentType];
  const out = new Array(a.count);
  const bv = a.bufferView !== undefined ? json.bufferViews[a.bufferView] : null;
  const base = bv ? (bv.byteOffset || 0) + (a.byteOffset || 0) : 0;
  const stride = bv && bv.byteStride ? bv.byteStride : n * Arr.BYTES_PER_ELEMENT;
  for (let i = 0; i < a.count; i++) {
    const el = new Array(n);
    for (let c = 0; c < n; c++) {
      const byteOff = base + i * stride + c * Arr.BYTES_PER_ELEMENT;
      el[c] = new Arr(bin.buffer, bin.byteOffset + byteOff, 1)[0];
    }
    out[i] = n === 1 ? el[0] : el;
  }
  return out;
}

// --- transforms --------------------------------------------------------------------

const A2R = Math.PI / 32768;
// node matrix (column-major glTF) or TRS -> row-major 3x3 rotation + translation
function nodeRT(node) {
  if (node.matrix) {
    const m = node.matrix; // column-major
    return {
      R: [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]],
      t: [m[12], m[13], m[14]],
    };
  }
  const t = node.translation || [0, 0, 0];
  const q = node.rotation || [0, 0, 0, 1]; // x,y,z,w
  const [x, y, z, w] = q;
  const R = [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
  // scale is intentionally ignored (DNM has no per-node scale) — warn if not 1.
  const s = node.scale || [1, 1, 1];
  if (s.some((v) => Math.abs(v - 1) > 1e-4)) console.warn('warning: node "' + (node.name || '?') + '" has scale ' + s + ' — DNM cannot represent it; apply scale in Blender (Ctrl+A) first');
  return { R, t };
}

// R = RotXZ(h)·RotZY(p)·RotXY(b) == Ry(-h)·Rx(-p)·Rz(b); decompose back.
function rotToHPB(R) {
  const beta = Math.asin(Math.max(-1, Math.min(1, -R[5])));   // row1,col2
  const alpha = Math.atan2(R[2], R[8]);                        // row0col2, row2col2
  const gamma = Math.atan2(R[3], R[4]);                        // row1col0, row1col1
  return [Math.round(-alpha / A2R), Math.round(-beta / A2R), Math.round(gamma / A2R)];
}

// --- extras.ysflight (may arrive as an object, or as a JSON string) ----------------

function ysExtras(node) {
  const e = node.extras && node.extras.ysflight;
  if (!e) return null;
  if (typeof e === 'string') { try { return JSON.parse(e); } catch (_) { return null; } }
  return e;
}

// --- geometry: primitives -> SRF text ----------------------------------------------

const f6 = (v) => (Math.abs(v) < 5e-7 ? 0 : v).toFixed(6).replace(/\.?0+$/, (m) => (m[0] === '.' ? '' : m)).replace(/^-0$/, '0') || '0';

function srfText(mesh) {
  const verts = [];
  const vmap = new Map(); // welded: 'x,y,z' -> index
  const faces = [];
  for (const prim of mesh.primitives || []) {
    if (prim.mode !== undefined && prim.mode !== 4) continue; // triangles only
    if (prim.attributes.POSITION === undefined) continue;
    const pos = readAccessor(prim.attributes.POSITION);
    const idx = prim.indices !== undefined ? readAccessor(prim.indices) : pos.map((_, i) => i);
    const mat = prim.material !== undefined ? json.materials[prim.material] : null;
    const bc = (mat && mat.pbrMetallicRoughness && mat.pbrMetallicRoughness.baseColorFactor) || [0.8, 0.8, 0.8, 1];
    const color = bc.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v * 255))));
    const vix = (p) => {
      const key = p.map((v) => Math.round(v * 1e6) / 1e6).join(',');
      let ix = vmap.get(key);
      if (ix === undefined) { ix = verts.length; verts.push(p); vmap.set(key, ix); }
      return ix;
    };
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const tri = [pos[idx[t]], pos[idx[t + 1]], pos[idx[t + 2]]];
      if (tri.some((p) => !p)) continue;
      faces.push({ idx: tri.map(vix), color, tri });
    }
  }
  const lines = ['SURF'];
  for (const v of verts) lines.push('V ' + v.map(f6).join(' '));
  for (const f of faces) {
    const [a, b, c] = f.tri;
    const cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3, cz = (a[2] + b[2] + c[2]) / 3;
    let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    let ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    let nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    lines.push('F');
    lines.push('V ' + f.idx.join(' '));
    lines.push('N ' + [cx, cy, cz, nx, ny, nz].map(f6).join(' '));
    lines.push('C ' + f.color.join(' '));
    lines.push('E');
  }
  return { text: lines.join('\n') + '\n', lineCount: lines.length, tris: faces.length, verts: verts.length };
}

// --- walk nodes, collect PCK + node blocks -----------------------------------------

const usedLabels = new Set();
const usedSrfNames = new Set();
const uniq = (set, base) => {
  let name = base, n = 2;
  while (set.has(name)) name = base + '_' + (n++);
  set.add(name);
  return name;
};

const pcks = [];   // {name, text, lineCount}
const blocks = []; // node block text
let stats = { nodes: 0, tris: 0 };

function walk(nix) {
  const node = json.nodes[nix];
  const label = uniq(usedLabels, (node.name || 'node').replace(/"/g, ''));
  const ys = ysExtras(node);
  let srfName;
  if (node.mesh !== undefined) {
    const s = srfText(json.meshes[node.mesh]);
    srfName = uniq(usedSrfNames, ((ys && ys.srf) || label.replace(/[^A-Za-z0-9_.-]+/g, '_').toLowerCase() + '.srf').replace(/\s+/g, '_'));
    pcks.push({ name: srfName, ...s });
    stats.tris += s.tris;
  } else {
    srfName = uniq(usedSrfNames, label.replace(/[^A-Za-z0-9_.-]+/g, '_').toLowerCase() + '.srf');
    pcks.push({ name: srfName, text: 'SURF\n\n\n', lineCount: 3 }); // stock stub for pure pivots
  }
  let cla, pos, cnt, sta;
  if (ys) {
    cla = ys.cla || 0;
    pos = (ys.pos && ys.pos.length >= 6 ? ys.pos.slice(0, 6) : [0, 0, 0, 0, 0, 0]);
    cnt = (ys.cnt && ys.cnt.length >= 3 ? ys.cnt.slice(0, 3) : [0, 0, 0]);
    sta = (ys.sta && ys.sta.length ? ys.sta : [[0, 0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 0, 1]]);
  } else {
    const { R, t } = nodeRT(node);
    cla = 0;
    pos = [...t, ...rotToHPB(R)];
    cnt = [0, 0, 0];
    sta = [[0, 0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 0, 1]];
  }
  const childLabels = (node.children || []).map(walk);
  const b = [];
  b.push('SRF "' + label + '"');
  b.push('FIL ' + srfName);
  b.push('CLA ' + cla);
  b.push('NST ' + sta.length);
  for (const s of sta) {
    b.push('STA ' + s.slice(0, 3).map(f6).join(' ') + ' ' + s.slice(3, 6).map((v) => Math.round(v)).join(' ') + ' ' + (s[6] !== undefined ? s[6] : 1));
  }
  b.push('POS ' + pos.slice(0, 3).map(f6).join(' ') + ' ' + pos.slice(3, 6).map((v) => Math.round(v)).join(' ') + ' 1');
  b.push('CNT ' + cnt.map(f6).join(' '));
  b.push('PAX 0 0 0');
  b.push('REL DEP');
  b.push('NCH ' + childLabels.length);
  for (const c of childLabels) b.push('CLD "' + c + '"');
  b.push('END');
  blocks.push(b.join('\n'));
  stats.nodes++;
  return label;
}

const scene = json.scenes[json.scene || 0];
for (const nix of scene.nodes || []) walk(nix);
if (!stats.nodes) { console.error('no nodes in the glTF scene'); process.exit(1); }

const out = ['DYNAMODEL', 'DNMVER 2'];
for (const p of pcks) {
  out.push('PCK ' + p.name + ' ' + p.lineCount);
  out.push(p.text.replace(/\n$/, ''));
}
out.push(...blocks);
out.push('END');
writeFileSync(outPath, out.join('\n') + '\n');
console.log(JSON.stringify({ out: outPath, nodes: stats.nodes, srfs: pcks.length, triangles: stats.tris }));
