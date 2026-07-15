// The DNM/SRF text parser — the pure layer under dnm-preview.js (Three.js
// viewer), dnm-gltf.js (Blender bridge) and dnm-lint.js (geometry linter).
// No DOM, no Three.js, no Node APIs: importable from the browser, Node tests
// and the Deno CLI alike.  Extracted verbatim from dnm-preview.js so every
// consumer keeps reading the exact same geometry.
//
// DNM text layout (see fsdnm / ysshelldnmtemplate):
//   DYNAMODEL / DNMVER n
//   PCK "<srf>" <N>            embeds an SRF as the next N lines:
//     SURF / V x y z [R] / F..E blocks { V idx.. ; N cx cy cz nx ny nz ; C r g b [a] ; [B] }
//   SRF "<label>" / FIL <srf> / CLA <class> / NST <n> / STA x y z h p b vis /
//     POS x y z h p b [vis] / CNT cx cy cz / CLD "<child>"..    (node tree)
// Angles (h,p,b in STA/POS) are 32768 = pi radians.  Axes: X east, Y up, Z south.

const b2s = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
};

// Decode an SRF `C` color line's tokens (everything after "C").  Two forms:
//   C r g b [a]   direct 0..255 RGB(A)
//   C <n>         packed 15-bit GGGGG RRRRR BBBBB (YsColor::Set15BitRGB) — the
//                 old format still used by legacy models (e.g. amp.dnm).
// Returns [r,g,b] in 0..255.
export function decodeSrfColor(tok) {
  if (tok.length >= 3) return [+tok[0], +tok[1], +tok[2]];
  const c = (parseInt(tok[0], 10) || 0) & 32767;
  // Rounded so face-color keys match the paint shop's (workbench.js cLineRgb).
  return [((c >> 5) & 31) * 255 / 31, ((c >> 10) & 31) * 255 / 31, (c & 31) * 255 / 31]
    .map((v) => Math.round(v));
}

// Parse the embedded SRF text (the N lines after a PCK header) into geometry:
// { vertices: [[x,y,z],...], faces: [{idx:[...], color:[r,g,b], unlit}] }.
export function parseSrf(lines) {
  const vertices = [];
  const smooth = [];   // per-vertex 'R' flag: engine shades these with the
                       // averaged normal of adjacent polygons (round vertex)
  const faces = [];
  let rawFace = 0;
  const byRaw = new Map(); // raw polygon index (what ZA refers to) -> faces[] index
  let i = 0;
  for (; i < lines.length; i++) {
    const t = lines[i].trim().split(/\s+/);
    if (t[0] === 'V') {
      vertices.push([parseFloat(t[1]), parseFloat(t[2]), parseFloat(t[3])]);
      smooth.push(t.length >= 5 && (t[4] === 'R' || t[4] === 'r'));
    }
    else if (t[0] === 'F') {
      const face = { idx: [], color: [200, 200, 200], unlit: false, alpha: 1 };
      for (i++; i < lines.length; i++) {
        const f = lines[i].trim().split(/\s+/);
        if (f[0] === 'E') break;
        if (f[0] === 'V') face.idx = f.slice(1).map(Number);
        else if (f[0] === 'C') face.color = decodeSrfColor(f.slice(1));
        else if (f[0] === 'B') face.unlit = true;
        else if (f[0] === 'N') {
          // 'N cx cy cz nx ny nz' (or bare 'N nx ny nz'): the ASSIGNED normal.
          // The engine lights by this and flips winding to match it, so keep
          // it — converters orient their triangles by it.
          const n = f.length >= 7 ? f.slice(4, 7).map(Number) : f.slice(1, 4).map(Number);
          if (n[0] || n[1] || n[2]) face.nom = n;
        }
      }
      if (face.idx.length >= 3) { byRaw.set(rawFace, faces.length); faces.push(face); }
      rawFace++;
    } else if (t[0] === 'ZA') {
      // Per-polygon transparency: '<polygon index> <value>' pairs, and the
      // engine maps alpha = (255-value)/255 (ysshellextio.cpp).  This is what
      // makes stock afterburner flames translucent — losing it renders them
      // as opaque cones.
      for (let k = 1; k + 1 < t.length; k += 2) {
        const fi = byRaw.get(Number(t[k]));
        if (fi !== undefined) faces[fi].alpha = (255 - (Number(t[k + 1]) || 0)) / 255;
      }
    }
  }
  return { vertices, smooth, faces };
}

// Oriented face normal: Newell over the polygon, flipped to agree with the
// assigned 'N' normal when one is present (the engine's authoritative side).
export function faceNormal(srf, face) {
  let nx = 0, ny = 0, nz = 0;
  const idx = face.idx;
  for (let i = 0; i < idx.length; i++) {
    const a = srf.vertices[idx[i]], b = srf.vertices[idx[(i + 1) % idx.length]];
    if (!a || !b) continue;
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  if (face.nom && nx * face.nom[0] + ny * face.nom[1] + nz * face.nom[2] < 0) {
    nx = -nx; ny = -ny; nz = -nz;
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

// Per-vertex averaged normals for the 'R' (round) vertices: the engine shades
// an R vertex with the mean of its adjacent polygon normals (Gouraud), so both
// the preview and the glTF conversion bake the same thing.
export function smoothVertexNormals(srf) {
  const acc = new Map(); // vertex index -> [nx, ny, nz] accumulator
  if (!(srf.smooth || []).some(Boolean)) return acc;
  for (const f of srf.faces) {
    const n = faceNormal(srf, f);
    for (const vi of f.idx) {
      if (!srf.smooth[vi]) continue;
      const a = acc.get(vi) || [0, 0, 0];
      a[0] += n[0]; a[1] += n[1]; a[2] += n[2];
      acc.set(vi, a);
    }
  }
  for (const a of acc.values()) {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    a[0] /= l; a[1] /= l; a[2] /= l;
  }
  return acc;
}

// Parse a whole DNM: PCK-embedded SRFs + the node tree.  Returns
// { nodes: [{label, srf, cla, cnt, pos, sta, children}], roots: [label] }.
export function parseDnm(bytes) {
  const lines = b2s(bytes).split('\n');
  const srfByName = new Map();
  const nodes = new Map();
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim().split(/\s+/);
    if (t[0] === 'PCK') {
      const name = t[1].replace(/^"|"$/g, '');
      const n = parseInt(t[2], 10);
      srfByName.set(name, parseSrf(lines.slice(i + 1, i + 1 + n)));
      i += n;
    } else if (t[0] === 'SRF' && t.length >= 2) {
      cur = { label: t[1].replace(/^"|"$/g, ''), srf: null, cla: 0, cnt: [0, 0, 0], pos: [0, 0, 0, 0, 0, 0], sta: [], children: [] };
      nodes.set(cur.label, cur);
    } else if (!cur) {
      continue;
    } else if (t[0] === 'FIL') cur.srf = t[1].replace(/^"|"$/g, '');
    else if (t[0] === 'CLA') cur.cla = parseInt(t[1], 10);
    else if (t[0] === 'CNT') cur.cnt = [parseFloat(t[1]), parseFloat(t[2]), parseFloat(t[3])];
    else if (t[0] === 'POS') cur.pos = t.slice(1, 7).map(Number);
    else if (t[0] === 'STA') cur.sta.push(t.slice(1, 8).map(Number)); // x y z h p b vis
    else if (t[0] === 'CLD') cur.children.push(t[1].replace(/^"|"$/g, ''));
  }
  // Roots = nodes that are nobody's child.
  const child = new Set();
  for (const n of nodes.values()) for (const c of n.children) child.add(c);
  const roots = [...nodes.keys()].filter((k) => !child.has(k));
  return { nodes, srfByName, roots };
}
