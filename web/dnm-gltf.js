// DNM <-> glTF (.glb) conversion, browser-safe (no Node APIs) — the core of
// the Blender bridge.  Blender reads/writes glTF natively, so this module is
// what lets the workbench treat Blender as a first-class modeler:
//
//   dnmToGlb(dnmBytes) -> { glb: Uint8Array, nodes, meshes, animations }
//   glbToDnm(glbBytes) -> { dnm: Uint8Array, nodes, srfs, triangles }
//
// Forward: full node hierarchy with engine-exact rest transforms (the same
// CacheTransformation math dnm-preview.js renders with), fan-triangulated
// flat-shaded geometry, one material per face color, every YSFLIGHT field
// (CLA/POS/STA/CNT/srf) in extras.ysflight (Blender round-trips extras as
// custom properties), and ANIMATIONS: STA-interpolated parts keyframed per
// state, continuous-rotation classes (rotor/propeller/tire) as a 1s spin loop.
//
// Back: extras.ysflight restores the YSFLIGHT fields verbatim; fresh
// Blender-made nodes become static parts (stock idiom: CLA 0, twin zero STAs)
// with POS decomposed from the node transform.  Geometry is welded back into
// shared vertices; meshless nodes get the 3-line stub PCK stock files use.
//
// The scripts/dnm2gltf.mjs and scripts/gltf2dnm.mjs CLIs are thin wrappers
// around this module.

import { parseDnm, faceNormal, smoothVertexNormals } from './dnm-preview.js';

const A2R = Math.PI / 32768;

// --- tiny row-major 4x4 (column-vector convention, matching the engine) --------

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
// YsMatrix4x4 rotations, exact C++ signs (verified against the original via
// webflight's line-2-line port and its characterization tests):
const rotXZ = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; };
const rotZY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; };
const rotXY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; };

export function nodeMatrix(pos, sta, cnt) {
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

// Rigid matrix -> translation + quaternion (exact; our matrices carry no scale).
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

// The full aircraft CLA table (ysshelldnmident.h).
export const CLA_NAME = {
  0: 'Gear', 1: 'VariableGeometryWing', 2: 'Afterburner', 3: 'Rotor',
  4: 'AirBrake', 5: 'Flap', 6: 'Elevator', 7: 'Aileron', 8: 'Rudder',
  9: 'BombBay', 10: 'VtolNozzle', 11: 'ThrustReverser', 12: 'ConcordeNose',
  13: 'ConcordeVisor', 14: 'GearDoor', 15: 'GearRoomWall', 16: 'BrakeOrHook',
  17: 'GearDoorFast', 18: 'PropellerSlow', 20: 'PropellerFast', 21: 'Turret',
  22: 'Tire', 23: 'Steering', 24: 'RotorCustomAxis',
  40: 'LeftDoor', 41: 'RightDoor',
};
// Continuous-rotation classes -> which Euler slot spins ([x,y,z,h,p,b] index).
const SPIN_SLOT = { 3: 3, 18: 5, 20: 5, 22: 4, 24: 3 };

// ============================ DNM -> GLB ===========================================

export function dnmToGlb(dnmBytes) {
  const dnm = parseDnm(dnmBytes);

  const materials = [];
  const materialIx = new Map();
  // Bright (SRF 'B') faces — afterburner flames, glowing bits — become
  // EMISSIVE glTF materials, so Blender shows them glowing and the way back
  // can restore the B flag.  Losing B shades the flame by scene light, which
  // is exactly the broken-looking afterburner bug.
  // Translucent faces (SRF 'ZA') carry their alpha in baseColorFactor[3] with
  // alphaMode BLEND — losing ZA turns the stock flames into opaque cones.
  const materialFor = (color, unlit, alpha) => {
    const a = Math.round((alpha === undefined ? 1 : alpha) * 255) / 255;
    const key = color.join(',') + (unlit ? '|B' : '') + (a < 1 ? '|A' + a : '');
    if (materialIx.has(key)) return materialIx.get(key);
    const ix = materials.length;
    const c = [color[0] / 255, color[1] / 255, color[2] / 255];
    materials.push({
      name: 'C_' + color.join('_') + (unlit ? '_B' : '') + (a < 1 ? '_A' + Math.round(a * 255) : ''),
      pbrMetallicRoughness: {
        baseColorFactor: unlit ? [0, 0, 0, a] : [...c, a],
        metallicFactor: 0, roughnessFactor: 0.9,
      },
      ...(unlit ? { emissiveFactor: c, extras: { ysflight: { bright: true } } } : {}),
      ...(a < 1 ? { alphaMode: 'BLEND' } : {}),
      doubleSided: true,
    });
    materialIx.set(key, ix);
    return ix;
  };

  const binParts = [];
  let binLen = 0;
  const bufferViews = [];
  const accessors = [];
  const NC = { SCALAR: 1, VEC3: 3, VEC4: 4 };
  const pushAcc = (arr, type, opts) => {
    const bytes = new Uint8Array(new Float32Array(arr).buffer);
    const bv = bufferViews.length;
    bufferViews.push({
      buffer: 0, byteOffset: binLen, byteLength: bytes.length,
      ...(opts && opts.vertex ? { target: 34962 } : {}),
    });
    binParts.push(bytes);
    binLen += bytes.length;
    const acc = accessors.length;
    accessors.push({
      bufferView: bv, componentType: 5126, count: arr.length / NC[type], type,
      ...(opts && opts.minmax ? { min: opts.minmax[0], max: opts.minmax[1] } : {}),
    });
    return acc;
  };

  const meshFromSrf = (srf, name) => {
    const vtxNom = smoothVertexNormals(srf); // 'R' vertices -> averaged normals
    const byColor = new Map();
    for (const f of srf.faces) {
      if (f.idx.length < 3) continue;
      const alpha = f.alpha === undefined ? 1 : f.alpha;
      const key = (f.color || [128, 128, 128]).join(',') + (f.unlit ? '|B' : '') + (alpha < 1 ? '|A' + alpha : '');
      let bucket = byColor.get(key);
      if (!bucket) { bucket = { color: f.color || [128, 128, 128], unlit: !!f.unlit, alpha, pos: [], nrm: [] }; byColor.set(key, bucket); }
      // Orient by the assigned 'N' normal when present: the engine lights by
      // N and flips winding to match it (FixOrientationBasedOnAssignedNormal),
      // so a face whose winding disagrees with its N must be reversed here or
      // the glTF (winding-derived) normal comes out inverted.
      const fn = faceNormal(srf, f);
      let idx = f.idx;
      if (f.nom) {
        let nx = 0, ny = 0, nz = 0;
        for (let i = 0; i < idx.length; i++) {
          const a = srf.vertices[idx[i]], b = srf.vertices[idx[(i + 1) % idx.length]];
          if (!a || !b) continue;
          nx += (a[1] - b[1]) * (a[2] + b[2]);
          ny += (a[2] - b[2]) * (a[0] + b[0]);
          nz += (a[0] - b[0]) * (a[1] + b[1]);
        }
        if (nx * f.nom[0] + ny * f.nom[1] + nz * f.nom[2] < 0) idx = idx.slice().reverse();
      }
      for (let i = 1; i + 1 < idx.length; i++) {
        for (const vi of [idx[0], idx[i], idx[i + 1]]) {
          const v = srf.vertices[vi];
          if (!v) continue;
          bucket.pos.push(v[0], v[1], v[2]);
          const n = (srf.smooth && srf.smooth[vi] && vtxNom.get(vi)) || fn;
          bucket.nrm.push(n[0], n[1], n[2]);
        }
      }
    }
    const primitives = [];
    for (const { color, unlit, alpha, pos, nrm } of byColor.values()) {
      if (!pos.length) continue;
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < pos.length; i += 3) {
        for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
      }
      primitives.push({
        attributes: {
          POSITION: pushAcc(pos, 'VEC3', { vertex: true, minmax: [min, max] }),
          NORMAL: pushAcc(nrm, 'VEC3', { vertex: true }),
        },
        material: materialFor(color, unlit, alpha),
      });
    }
    return primitives.length ? { name, primitives } : null;
  };

  const gnodes = [];
  const meshes = [];
  const animByName = new Map();

  const emitNode = (label) => {
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

    const emitAnim = (staList, times) => {
      const name = CLA_NAME[n.cla] || ('Class' + (n.cla || 0));
      let anim = animByName.get(name);
      if (!anim) { anim = { name, samplers: [], channels: [] }; animByName.set(name, anim); }
      const ts = [], qs = [];
      for (const sta of staList) {
        const { t, q } = matToTQ(nodeMatrix(pos, sta, cnt));
        ts.push(...t);
        qs.push(...q);
      }
      const input = pushAcc(times, 'SCALAR', { minmax: [[times[0]], [times[times.length - 1]]] });
      const sT = anim.samplers.length;
      anim.samplers.push({ input, output: pushAcc(ts, 'VEC3'), interpolation: 'LINEAR' });
      anim.channels.push({ sampler: sT, target: { node: ix, path: 'translation' } });
      const sR = anim.samplers.length;
      anim.samplers.push({ input, output: pushAcc(qs, 'VEC4'), interpolation: 'LINEAR' });
      anim.channels.push({ sampler: sR, target: { node: ix, path: 'rotation' } });
    };
    if (SPIN_SLOT[n.cla] !== undefined) {
      const slot = SPIN_SLOT[n.cla];
      const steps = 8;
      const staList = [], times = [];
      for (let i = 0; i <= steps; i++) {
        const sta = [0, 0, 0, 0, 0, 0, 1];
        sta[slot] = (65536 * i) / steps;
        staList.push(sta);
        times.push(i / steps);
      }
      emitAnim(staList, times);
    } else if (staDiffers(n.sta)) {
      emitAnim(n.sta, n.sta.map((_, i) => i));
    }
    return ix;
  };

  const rootIx = dnm.roots.map(emitNode).filter((ix) => ix !== null);
  if (!rootIx.length) throw new Error('no nodes exported (is this a DNM?)');

  const gltf = {
    asset: { version: '2.0', generator: 'ysflight-web dnm-gltf' },
    scene: 0,
    scenes: [{ nodes: rootIx }],
    nodes: gnodes,
    meshes,
    materials,
    bufferViews,
    accessors,
    buffers: [{ byteLength: binLen }],
  };
  if (animByName.size) gltf.animations = [...animByName.values()];

  // GLB container.
  const enc = new TextEncoder();
  const json0 = enc.encode(JSON.stringify(gltf));
  const jsonPad = (4 - (json0.length % 4)) % 4;
  const bin0 = new Uint8Array(binLen);
  { let o = 0; for (const p of binParts) { bin0.set(p, o); o += p.length; } }
  const binPad = (4 - (bin0.length % 4)) % 4;
  const total = 12 + 8 + json0.length + jsonPad + 8 + bin0.length + binPad;
  const glb = new Uint8Array(total);
  const dv = new DataView(glb.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, json0.length + jsonPad, true);
  dv.setUint32(16, 0x4e4f534a, true);
  glb.set(json0, 20);
  glb.fill(0x20, 20 + json0.length, 20 + json0.length + jsonPad);
  const binHdr = 20 + json0.length + jsonPad;
  dv.setUint32(binHdr, bin0.length + binPad, true);
  dv.setUint32(binHdr + 4, 0x004e4942, true);
  glb.set(bin0, binHdr + 8);
  return {
    glb, nodes: gnodes.length, meshes: meshes.length,
    materials: materials.length,
    animations: (gltf.animations || []).map((a) => a.name),
  };
}

// ==================== DNM -> collision SRF (for seamless glb import) ==============

// Bake every rest-visible node's geometry through its hierarchical rest
// transform into ONE aircraft-coordinate SRF — a serviceable collision shell
// for a model that arrived as a bare .glb.  Rest-hidden nodes (retracted gear,
// STA0 vis=0) are skipped, matching what you'd collide with in flight.
export function dnmToCollisionSrf(dnmBytes) {
  const dnm = parseDnm(dnmBytes);
  const f6 = (v) => (Math.abs(v) < 5e-7 ? '0' : String(Math.round(v * 1e6) / 1e6));
  const verts = [], vmap = new Map(), faces = [];
  const addNode = (label, parentM) => {
    const n = dnm.nodes.get(label);
    if (!n) return;
    const sta0 = (n.sta && n.sta[0]) || null;
    const M = mul(parentM, nodeMatrix(n.pos || [0, 0, 0, 0, 0, 0], sta0, n.cnt || [0, 0, 0]));
    const visible = !sta0 || sta0[6] === undefined || sta0[6] !== 0;
    const srf = visible && n.srf && dnm.srfByName.get(n.srf);
    if (srf) {
      const world = srf.vertices.map((v) => [
        M[0] * v[0] + M[1] * v[1] + M[2] * v[2] + M[3],
        M[4] * v[0] + M[5] * v[1] + M[6] * v[2] + M[7],
        M[8] * v[0] + M[9] * v[1] + M[10] * v[2] + M[11],
      ]);
      const vix = (p) => {
        const key = p.map((v) => Math.round(v * 1e5) / 1e5).join(',');
        let ix = vmap.get(key);
        if (ix === undefined) { ix = verts.length; verts.push(p); vmap.set(key, ix); }
        return ix;
      };
      for (const f of srf.faces) {
        if (f.idx.length < 3) continue;
        const idx = f.idx.map((i) => world[i]).filter(Boolean).map(vix);
        if (idx.length >= 3) faces.push(idx);
      }
    }
    for (const c of n.children || []) addNode(c, M);
  };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const r of dnm.roots) addNode(r, I);
  if (!faces.length) throw new Error('no visible geometry for a collision shell');
  const lines = ['SURF'];
  for (const v of verts) lines.push('V ' + v.map(f6).join(' '));
  for (const idx of faces) {
    lines.push('F');
    lines.push('V ' + idx.join(' '));
    lines.push('C 128 128 128');
    lines.push('E');
  }
  lines.push('E');
  return new TextEncoder().encode(lines.join('\n') + '\n');
}

// ============================ GLB -> DNM ===========================================

// glTF 1.0 -> 2.0-shaped JSON (just enough for the reader below).  Version 1
// keys everything by NAME and colors live in KHR_materials_common — seen in
// the wild in Flightradar24's model library, which is too useful a source of
// GPL airliner geometry to turn away.
function normalizeGltf1(g) {
  const ix = (dict) => {
    const names = Object.keys(dict || {});
    return { names, of: new Map(names.map((n, i) => [n, i])) };
  };
  const bvs = ix(g.bufferViews), accs = ix(g.accessors), mats = ix(g.materials),
    mshs = ix(g.meshes), nds = ix(g.nodes);
  const bufferViews = [], accessors = [];
  for (const name of accs.names) {
    const a = g.accessors[name];
    const bv = g.bufferViews[a.bufferView] || {};
    // 1.0 puts byteStride on the ACCESSOR — give each accessor its own view.
    bufferViews.push({
      buffer: 0, byteOffset: (bv.byteOffset || 0) + (a.byteOffset || 0),
      ...(a.byteStride ? { byteStride: a.byteStride } : {}),
    });
    accessors.push({
      bufferView: bufferViews.length - 1, byteOffset: 0,
      componentType: a.componentType, count: a.count, type: a.type,
    });
  }
  const materials = mats.names.map((name) => {
    const m = g.materials[name] || {};
    const values = (m.extensions && m.extensions.KHR_materials_common && m.extensions.KHR_materials_common.values) || m.values || {};
    const d = values.diffuse;
    const color = Array.isArray(d) && d.length >= 3 ? d.slice(0, 4) : [0.8, 0.8, 0.8, 1];
    const em = values.emission;
    return {
      name,
      pbrMetallicRoughness: { baseColorFactor: color.length === 4 ? color : [...color, 1] },
      ...(Array.isArray(em) && Math.max(...em.slice(0, 3)) > 0 ? { emissiveFactor: em.slice(0, 3) } : {}),
    };
  });
  const meshes = mshs.names.map((name) => ({
    name,
    primitives: ((g.meshes[name] || {}).primitives || []).map((p) => ({
      attributes: Object.fromEntries(Object.entries(p.attributes || {}).map(([k, v]) => [k, accs.of.get(v)])),
      ...(p.indices !== undefined ? { indices: accs.of.get(p.indices) } : {}),
      ...(p.material !== undefined ? { material: mats.of.get(p.material) } : {}),
      ...(p.mode !== undefined ? { mode: p.mode } : {}),
    })),
  }));
  // A 1.0 node may carry SEVERAL meshes: merge their primitives into one.
  const nodes = nds.names.map((name) => {
    const n = g.nodes[name] || {};
    const out = { name };
    if (n.matrix) out.matrix = n.matrix;
    if (n.translation) out.translation = n.translation;
    if (n.rotation) out.rotation = n.rotation;
    if (n.scale) out.scale = n.scale;
    if (n.children && n.children.length) out.children = n.children.map((c) => nds.of.get(c)).filter((v) => v !== undefined);
    const meshNames = n.meshes || (n.mesh !== undefined ? [n.mesh] : []);
    if (meshNames.length === 1) out.mesh = mshs.of.get(meshNames[0]);
    else if (meshNames.length > 1) {
      meshes.push({ name: name + '_merged', primitives: meshNames.flatMap((m) => meshes[mshs.of.get(m)].primitives) });
      out.mesh = meshes.length - 1;
    }
    return out;
  });
  const sceneName = g.scene || Object.keys(g.scenes || {})[0];
  const sceneNodes = ((g.scenes || {})[sceneName] || {}).nodes || [];
  return {
    accessors, bufferViews, materials, meshes, nodes,
    scene: 0,
    scenes: [{ nodes: sceneNodes.map((n) => nds.of.get(n)).filter((v) => v !== undefined) }],
  };
}

export function glbToDnm(glbBytes) {
  const u8 = glbBytes instanceof Uint8Array ? glbBytes : new Uint8Array(glbBytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB (.glb) file');
  const version = dv.getUint32(4, true);
  let json = null, binOff = 0, binLen = 0;
  if (version === 1) {
    // glTF 1.0 binary: no chunks — one JSON block, then the body buffer.
    const contentLength = dv.getUint32(12, true);
    json = normalizeGltf1(JSON.parse(new TextDecoder().decode(u8.subarray(20, 20 + contentLength))));
    binOff = 20 + contentLength;
    binLen = u8.length - binOff;
  } else {
    let off = 12;
    while (off < u8.length) {
      const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
      if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(u8.subarray(off + 8, off + 8 + len)));
      else if (type === 0x004e4942) { binOff = off + 8; binLen = len; }
      off += 8 + len;
    }
  }
  if (!json) throw new Error('GLB has no JSON chunk');

  const COMP = { 5120: [1, 'getInt8'], 5121: [1, 'getUint8'], 5122: [2, 'getInt16'], 5123: [2, 'getUint16'], 5125: [4, 'getUint32'], 5126: [4, 'getFloat32'] };
  const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  const readAccessor = (ix) => {
    const a = json.accessors[ix];
    const n = NC[a.type], [sz, getter] = COMP[a.componentType];
    const out = new Array(a.count);
    const bv = a.bufferView !== undefined ? json.bufferViews[a.bufferView] : null;
    const base = binOff + (bv ? (bv.byteOffset || 0) : 0) + (a.byteOffset || 0);
    const stride = bv && bv.byteStride ? bv.byteStride : n * sz;
    for (let i = 0; i < a.count; i++) {
      const el = new Array(n);
      for (let c = 0; c < n; c++) {
        el[c] = sz === 1 ? dv[getter](base + i * stride + c * sz) : dv[getter](base + i * stride + c * sz, true);
      }
      out[i] = n === 1 ? el[0] : el;
    }
    return out;
  };

  // A node's LOCAL matrix (row-major 4x4), from matrix or full TRS (scale
  // included — foreign models get their transforms BAKED into vertices, so
  // scale costs nothing).
  const localMatrix = (node) => {
    if (node.matrix) {
      const m = node.matrix; // column-major
      return [m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14], m[3], m[7], m[11], m[15]];
    }
    const t = node.translation || [0, 0, 0];
    const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
    const s = node.scale || [1, 1, 1];
    const R = [
      1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
      2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
      2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
    ];
    return [
      R[0] * s[0], R[1] * s[1], R[2] * s[2], t[0],
      R[3] * s[0], R[4] * s[1], R[5] * s[2], t[1],
      R[6] * s[0], R[7] * s[1], R[8] * s[2], t[2],
      0, 0, 0, 1,
    ];
  };
  const apply = (M, v) => [
    M[0] * v[0] + M[1] * v[1] + M[2] * v[2] + M[3],
    M[4] * v[0] + M[5] * v[1] + M[6] * v[2] + M[7],
    M[8] * v[0] + M[9] * v[1] + M[10] * v[2] + M[11],
  ];
  const ysExtras = (node) => {
    const e = node.extras && node.extras.ysflight;
    if (!e) return null;
    if (typeof e === 'string') { try { return JSON.parse(e); } catch (_) { return null; } }
    return e;
  };

  const f6 = (v) => (Math.abs(v) < 5e-7 ? '0' : String(Math.round(v * 1e6) / 1e6));

  // Rotate a direction by a bake matrix (no translation) and renormalize —
  // good enough for the rigid/near-uniform node transforms we bake.
  const applyDir = (M, n) => {
    const v = [
      M[0] * n[0] + M[1] * n[1] + M[2] * n[2],
      M[4] * n[0] + M[5] * n[1] + M[6] * n[2],
      M[8] * n[0] + M[9] * n[1] + M[10] * n[2],
    ];
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };

  const srfText = (mesh, bake) => {
    const verts = [], vmap = new Map(), faces = [], smoothV = new Set();
    for (const prim of mesh.primitives || []) {
      if (prim.mode !== undefined && prim.mode !== 4) continue;
      if (prim.attributes.POSITION === undefined) continue;
      let pos = readAccessor(prim.attributes.POSITION);
      if (bake) pos = pos.map((v) => apply(bake, v));
      // Vertex normals mark the 'R' (round) vertices on the way back: where a
      // corner's normal deviates from its flat face normal, the modeler meant
      // smooth shading there (Blender's shade-smooth exports averaged normals).
      let nrms = prim.attributes.NORMAL !== undefined ? readAccessor(prim.attributes.NORMAL) : null;
      if (bake && nrms) nrms = nrms.map((n) => applyDir(bake, n));
      const idx = prim.indices !== undefined ? readAccessor(prim.indices) : pos.map((_, i) => i);
      const mat = prim.material !== undefined ? json.materials[prim.material] : null;
      const bc = (mat && mat.pbrMetallicRoughness && mat.pbrMetallicRoughness.baseColorFactor) || [0.8, 0.8, 0.8, 1];
      // Bright (SRF 'B') faces round-trip as emissive materials — restore the
      // flag, and take the color from the emissive factor when the base color
      // was blacked out (our own convention) or the emissive clearly dominates.
      const em = (mat && mat.emissiveFactor) || [0, 0, 0];
      const matYs = mat && mat.extras && mat.extras.ysflight;
      const unlit = !!(matYs && (typeof matYs === 'string' ? /"bright":\s*true/.test(matYs) : matYs.bright)) ||
        Math.max(...em) > Math.max(...bc.slice(0, 3));
      const src = unlit && Math.max(...em) > 0 ? em : bc;
      const color = src.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v * 255))));
      // Translucency (SRF ZA) comes back from the material's base alpha.
      const alpha = (mat && mat.alphaMode === 'BLEND' && bc.length >= 4) ? bc[3] : 1;
      const vix = (p) => {
        const key = p.map((v) => Math.round(v * 1e6) / 1e6).join(',');
        let ix = vmap.get(key);
        if (ix === undefined) { ix = verts.length; verts.push(p); vmap.set(key, ix); }
        return ix;
      };
      for (let t = 0; t + 2 < idx.length; t += 3) {
        const tri = [pos[idx[t]], pos[idx[t + 1]], pos[idx[t + 2]]];
        if (tri.some((p) => !p)) continue;
        const ids = tri.map(vix);
        if (nrms) {
          // Gate on INTRA-triangle normal variance first: a flat-shaded face
          // exports one identical normal on all three corners, so any spread
          // between corners is the modeler's smooth shading.  Without the
          // gate, fanning a flat-but-twisted quad (a tapered wing panel) makes
          // each tri's geometric normal deviate from the authored face normal
          // and sprays spurious R over surfaces meant to stay flat — which the
          // engine then shades with edge-on averaged normals (dark patches).
          const n0 = nrms[idx[t]], n1 = nrms[idx[t + 1]], n2 = nrms[idx[t + 2]];
          const same = (u, v) => !u || !v || (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) > 0.99999;
          if (!(same(n0, n1) && same(n1, n2) && same(n0, n2))) {
            const [a, b, c] = tri;
            let fx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
            let fy = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
            let fz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
            const fl = Math.hypot(fx, fy, fz) || 1;
            fx /= fl; fy /= fl; fz /= fl;
            for (let k = 0; k < 3; k++) {
              const n = nrms[idx[t + k]];
              if (n && Math.abs(n[0] * fx + n[1] * fy + n[2] * fz) < 0.9995) smoothV.add(ids[k]);
            }
          }
        }
        faces.push({ idx: ids, color, unlit, alpha, tri });
      }
    }
    const lines = ['SURF'];
    verts.forEach((v, i) => lines.push('V ' + v.map(f6).join(' ') + (smoothV.has(i) ? ' R' : '')));
    for (const f of faces) {
      const [a, b, c] = f.tri;
      const cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3, cz = (a[2] + b[2] + c[2]) / 3;
      let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
      let ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
      let nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const l = Math.hypot(nx, ny, nz) || 1;
      lines.push('F');
      if (f.unlit) lines.push('B');
      lines.push('V ' + f.idx.join(' '));
      lines.push('N ' + [cx, cy, cz, nx / l, ny / l, nz / l].map(f6).join(' '));
      lines.push('C ' + f.color.join(' '));
      lines.push('E');
    }
    // Translucent faces -> ZA '<polygon index> <value>' pairs (value = 255 -
    // alpha*255, the engine's convention), chunked like stock files.
    const za = [];
    faces.forEach((f, i) => {
      if (f.alpha !== undefined && f.alpha < 254 / 255) za.push(i, Math.max(0, Math.min(255, Math.round(255 - f.alpha * 255))));
    });
    for (let k = 0; k < za.length; k += 30) {
      lines.push('ZA ' + za.slice(k, k + 30).join(' '));
    }
    return { text: lines.join('\n'), lineCount: lines.length, tris: faces.length };
  };

  const usedLabels = new Set(), usedSrfNames = new Set();
  const uniq = (set, base) => {
    let name = base, n = 2;
    while (set.has(name)) name = base + '_' + (n++);
    set.add(name);
    return name;
  };
  const pcks = [], blocks = [];
  let nodeCount = 0, triCount = 0;

  const I16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  // parentBake: accumulated transform of extras-less ancestors.  Nodes WITH
  // extras.ysflight restore POS/CNT/STA verbatim (round-trip); fresh/foreign
  // nodes get their transform BAKED into the vertices instead — no Euler
  // decomposition (which hits gimbal lock on axis-permutation matrices, e.g.
  // Flightradar24's COLLADA-era exports), and scale comes free.
  const walk = (nix, parentBake) => {
    const node = json.nodes[nix];
    const label = uniq(usedLabels, (node.name || 'node').replace(/"/g, ''));
    const ys = ysExtras(node);
    const bake = ys ? null : mul(parentBake || I16, localMatrix(node));
    let srfName;
    if (node.mesh !== undefined) {
      const s = srfText(json.meshes[node.mesh], bake);
      srfName = uniq(usedSrfNames, ((ys && ys.srf) || label.replace(/[^A-Za-z0-9_.-]+/g, '_').toLowerCase() + '.srf').replace(/\s+/g, '_'));
      pcks.push({ name: srfName, text: s.text, lineCount: s.lineCount });
      triCount += s.tris;
    } else {
      srfName = uniq(usedSrfNames, label.replace(/[^A-Za-z0-9_.-]+/g, '_').toLowerCase() + '.srf');
      pcks.push({ name: srfName, text: 'SURF\n\n', lineCount: 3 });
    }
    let cla, pos, cnt, sta;
    if (ys) {
      cla = ys.cla || 0;
      pos = (ys.pos && ys.pos.length >= 6 ? ys.pos.slice(0, 6) : [0, 0, 0, 0, 0, 0]);
      cnt = (ys.cnt && ys.cnt.length >= 3 ? ys.cnt.slice(0, 3) : [0, 0, 0]);
      sta = (ys.sta && ys.sta.length ? ys.sta : [[0, 0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 0, 1]]);
    } else {
      cla = 0;
      pos = [0, 0, 0, 0, 0, 0]; // transform lives in the baked vertices
      cnt = [0, 0, 0];
      sta = [[0, 0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 0, 1]];
    }
    // Children of an extras node bake relative to it (the engine applies the
    // parent's POS transform through the DNM hierarchy).
    const childLabels = (node.children || []).map((c) => walk(c, ys ? I16 : bake));
    const b = [];
    b.push('SRF "' + label + '"');
    b.push('FIL ' + srfName);
    b.push('CLA ' + cla);
    b.push('NST ' + sta.length);
    for (const s of sta) b.push('STA ' + s.slice(0, 3).map(f6).join(' ') + ' ' + s.slice(3, 6).map((v) => Math.round(v)).join(' ') + ' ' + (s[6] !== undefined ? s[6] : 1));
    b.push('POS ' + pos.slice(0, 3).map(f6).join(' ') + ' ' + pos.slice(3, 6).map((v) => Math.round(v)).join(' ') + ' 1');
    b.push('CNT ' + cnt.map(f6).join(' '));
    b.push('PAX 0 0 0');
    b.push('REL DEP');
    b.push('NCH ' + childLabels.length);
    for (const c of childLabels) b.push('CLD "' + c + '"');
    b.push('END');
    blocks.push(b.join('\n'));
    nodeCount++;
    return label;
  };

  const scene = json.scenes[json.scene || 0];
  for (const nix of scene.nodes || []) walk(nix, I16);
  if (!nodeCount) throw new Error('no nodes in the glTF scene');

  const out = ['DYNAMODEL', 'DNMVER 2'];
  for (const p of pcks) {
    out.push('PCK ' + p.name + ' ' + p.lineCount);
    out.push(p.text);
  }
  out.push(...blocks);
  out.push('END');
  return {
    dnm: new TextEncoder().encode(out.join('\n') + '\n'),
    nodes: nodeCount, srfs: pcks.length, triangles: triCount,
  };
}
