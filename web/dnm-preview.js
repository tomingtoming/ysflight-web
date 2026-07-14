// Lightweight 3D preview of a YSFLIGHT aircraft model (DNM), for the workbench.
//
// This is a PREVIEW, not the game renderer: it exists so you can spin the model,
// see a paint change instantly, and scrub a landing gear / flap open-and-shut —
// without launching the full editor (Polygon Crest) or flying.  The real look is
// always the engine (the 🛫 button); this is the approachable glance.
//
// A compact self-contained parser (we already understand the DNM/SRF/CLA text
// format from the paint shop in workbench.js) feeds Three.js.  Prior art for the
// full-fidelity loader is tomingtoming/webflight (YSFlightDNMParser /
// DNMToThreeJSConverter); this covers the preview subset: geometry + colors +
// single-axis movable-part animation.
//
// DNM text layout (see fsdnm / ysshelldnmtemplate):
//   DYNAMODEL / DNMVER n
//   PCK "<srf>" <N>            embeds an SRF as the next N lines:
//     SURF / V x y z [R] / F..E blocks { V idx.. ; N cx cy cz nx ny nz ; C r g b [a] ; [B] }
//   SRF "<label>" / FIL <srf> / CLA <class> / NST <n> / STA x y z h p b vis /
//     POS x y z h p b [vis] / CNT cx cy cz / CLD "<child>"..    (node tree)
// Angles (h,p,b in STA/POS) are 32768 = pi radians.  Axes: X east, Y up, Z south.

import * as THREE from './vendor/three.module.js';

const b2s = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
};
const A2R = Math.PI / 32768; // STA/POS angle unit -> radians

// --- parse ----------------------------------------------------------------------

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
function parseSrf(lines) {
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

// --- build Three.js -------------------------------------------------------------

// Movable part CLA classes we expose sliders for (name -> class ids, from
// ysshelldnmident.h).  CLA 0 is overloaded (LANDINGDEVICE *and* the static
// default), so it only counts as gear when its STA states actually differ —
// staDiffers() enforces that below, which also drops the main body (3 identical
// states).  These are the parts a kid recognizes.
export const MOVABLE = {
  gear: [0],      // LANDINGDEVICE
  flap: [5],
  vgw: [1],       // variable-geometry (swing) wing
  airbrake: [4],
  elevator: [6], aileron: [7], rudder: [8],
};
const CLA_GROUP = {};
for (const [g, ids] of Object.entries(MOVABLE)) for (const id of ids) CLA_GROUP[id] = g;

// A node is genuinely animated only if its first and last STA states differ in
// some component (position or angle) — excludes the static body (CLA 0 with
// repeated identical states) and single-state nodes.
function staDiffers(sta) {
  if (!sta || sta.length < 2) return false;
  const a = sta[0], b = sta[sta.length - 1];
  for (let i = 0; i < 6; i++) if (Math.abs((a[i] || 0) - (b[i] || 0)) > 1e-6) return true;
  return false;
}

// The engine's exact rotation matrices (YsMatrix4x4 RotateXZ/ZY/XY, verified
// against the C++ via webflight's characterization tests).  Crucially the SIGNS
// are NOT Three's makeRotationX/Y/Z:
//   RotateXZ(a) = [c 0 -s; 0 1 0; s 0 c]   (= makeRotationY(-a))
//   RotateZY(a) = [1 0 0; 0 c s; 0 -s c]   (= makeRotationX(-a))
//   RotateXY(a) = [c -s 0; s c 0; 0 0 1]   (= makeRotationZ(+a))
// webflight's convertMatrix is IDENTITY (the C++ matrix drives raw SRF verts
// directly; view orientation is the camera's job), so we build in these
// conventions with no coordinate swap.
function rotXZ(THREE, a) { const c = Math.cos(a), s = Math.sin(a); return new THREE.Matrix4().set(c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1); }
function rotZY(THREE, a) { const c = Math.cos(a), s = Math.sin(a); return new THREE.Matrix4().set(1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1); }
function rotXY(THREE, a) { const c = Math.cos(a), s = Math.sin(a); return new THREE.Matrix4().set(c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1); }

// The engine's per-node transform (ysshelldnmtemplate.h CacheTransformation),
// composed onto LOCAL vertices and applied hierarchically (parent * child):
//   T(POS) . RotateXZ(h) . RotateZY(p) . RotateXY(b)
//         . T(STA.pos) . RotateXZ(h) . RotateZY(p) . RotateXY(b) . T(-CNT)
// pos = [x,y,z,h,p,b], sta = [x,y,z,h,p,b] (angles 32768=pi), cnt = [x,y,z].
function nodeMatrix(THREE, pos, sta, cnt) {
  const M = new THREE.Matrix4();
  const T = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
  M.makeTranslation(pos[0], pos[1], pos[2]);
  M.multiply(rotXZ(THREE, pos[3] * A2R));
  M.multiply(rotZY(THREE, pos[4] * A2R));
  M.multiply(rotXY(THREE, pos[5] * A2R));
  M.multiply(T(sta[0], sta[1], sta[2]));
  M.multiply(rotXZ(THREE, sta[3] * A2R));
  M.multiply(rotZY(THREE, sta[4] * A2R));
  M.multiply(rotXY(THREE, sta[5] * A2R));
  M.multiply(T(-cnt[0], -cnt[1], -cnt[2]));
  return M;
}

function faceColor(face) {
  const c = face.color, mx = Math.max(c[0], c[1], c[2]);
  const s = mx > 1 ? 1 / 255 : 1; // some DNM use 0..1
  return [c[0] * s, c[1] * s, c[2] * s];
}

// Build a THREE.Object3D from a parsed DNM by replicating the engine's node
// transform EXACTLY (nodeMatrix) — vertices are LOCAL, each node is a Group whose
// matrix is the composed POS/STA/CNT transform, and children nest under their
// parent (CLD).  This is the correct model: an earlier "flatten + absolute coords"
// shortcut floated any node with a non-zero POS (gear), and "POS + absolute"
// double-applied position (the webflight nightmare).  Movable nodes keep enough
// state to recompute their matrix as a slider scrubs STA[0]->STA[last].
// Returns { object3d, movableGroups:{gear:[Group],...}, meshesByLabel }.
export function buildObject(parsed) {
  const { nodes, srfByName } = parsed;
  const movableGroups = {};
  const meshesByLabel = new Map();

  const buildNode = (label) => {
    const n = nodes.get(label);
    if (!n) return null;
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    const g = CLA_GROUP[n.cla];
    const movable = g && staDiffers(n.sta);
    const sta0 = n.sta[0] || [0, 0, 0, 0, 0, 0];
    group.matrix.copy(nodeMatrix(THREE, n.pos, sta0, n.cnt));
    if (movable) {
      group.userData.pos = n.pos;
      group.userData.sta = n.sta;
      group.userData.cnt = n.cnt;
      (movableGroups[g] = movableGroups[g] || []).push(group);
    }
    if (n.srf && srfByName.has(n.srf)) {
      const mesh = srfToMesh(srfByName.get(n.srf));
      if (mesh) { group.add(mesh); meshesByLabel.set(label, { mesh, srf: srfByName.get(n.srf) }); }
    }
    for (const c of n.children) { const cg = buildNode(c); if (cg) group.add(cg); }
    return group;
  };

  const root = new THREE.Group();
  for (const r of parsed.roots) { const g = buildNode(r); if (g) root.add(g); }
  // YSFLIGHT model space (X east, Y up, Z south/front) -> face the camera nicely.
  root.rotation.y = Math.PI;
  return { object3d: root, movableGroups, meshesByLabel };
}

// One SRF -> a fan-triangulated, vertex-colored mesh.  Unlit (B) faces get their
// own basic material so nav/beacon colors stay flat; the rest are lambert-lit.
function srfToMesh(srf) {
  if (!srf.vertices.length || !srf.faces.length) return null;
  const vtxNom = smoothVertexNormals(srf); // 'R' vertices -> averaged normals
  const pos = [], col = [], nrm = [], litFlag = [];
  for (const f of srf.faces) {
    const c = faceColor(f);
    const fn = faceNormal(srf, f);
    const push = (vi) => {
      const v = srf.vertices[vi];
      pos.push(v[0], v[1], v[2]); col.push(c[0], c[1], c[2]);
      const n = (srf.smooth && srf.smooth[vi] && vtxNom.get(vi)) || fn;
      nrm.push(n[0], n[1], n[2]);
    };
    for (let k = 1; k + 1 < f.idx.length; k++) {
      if (!srf.vertices[f.idx[0]] || !srf.vertices[f.idx[k]] || !srf.vertices[f.idx[k + 1]]) continue;
      push(f.idx[0]); push(f.idx[k]); push(f.idx[k + 1]);
      litFlag.push(f.unlit ? 0 : 1, f.unlit ? 0 : 1, f.unlit ? 0 : 1);
    }
  }
  if (!pos.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  // A single mesh with a lambert material reads well enough for a preview; unlit
  // faces would ideally be flat, but mixing materials per-face needs groups —
  // preview keeps it one material (the game is the source of truth for shading).
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.srf = srf;
  return mesh;
}

// --- animation ------------------------------------------------------------------

// Drive a movable node's Group to t in [0,1] by interpolating its STA[0]->STA[last]
// and recomposing the full engine transform (POS fixed, STA interpolated, CNT
// pivot).  At t=0 it equals the rest matrix built in buildObject, so the part
// stays attached and hinges about its real axis.
export function setMovable(group, t) {
  const { pos, sta, cnt } = group.userData;
  if (!sta) return;
  const a = sta[0], b = sta[sta.length - 1];
  const staT = [0, 1, 2, 3, 4, 5].map((i) => a[i] + (b[i] - a[i]) * t);
  group.matrix.copy(nodeMatrix(THREE, pos, staT, cnt));
  group.matrixWorldNeedsUpdate = true;
  // Engine parity (ysshelldnmtemplate.h SetClassStateRecursive): STA's 7th
  // field is a visibility flag — parked within 1% of a hidden endpoint the
  // node disappears (retracted gear), but stays visible through the transit.
  const va = a[6] === undefined || a[6] !== 0, vb = b[6] === undefined || b[6] !== 0;
  group.visible = (va || t > 0.01) && (vb || t < 0.99);
}

// --- live paint -----------------------------------------------------------------

// Re-tint every mesh whose SRF face colors changed: rebuild the color attribute
// from the (already repainted) srf face colors.  Called after repaintDnm ran on
// the bytes AND the preview holds the same srf objects — but the preview parses
// its own copy, so the workbench passes the mapping and we apply it here too.
export function applyPaint(meshesByLabel, mapping) {
  // mapping: {'r,g,b': [r2,g2,b2]} in 0..255.
  for (const { mesh, srf } of meshesByLabel.values()) {
    let changed = false;
    for (const f of srf.faces) {
      const key = f.color.join(',');
      if (mapping[key]) { f.color = mapping[key].slice(); changed = true; }
    }
    if (!changed) continue;
    const col = [];
    for (const f of srf.faces) {
      const c = faceColor(f);
      for (let k = 1; k + 1 < f.idx.length; k++) col.push(c[0], c[1], c[2], c[0], c[1], c[2], c[0], c[1], c[2]);
    }
    mesh.geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    mesh.geometry.attributes.color.needsUpdate = true;
  }
}

// --- viewer ---------------------------------------------------------------------

// Mount an interactive preview into `container` for DNM `bytes`.  Returns a
// handle: { setPaint(mapping), setMovable(group, t), movable:{gear:[],...},
// dispose() }.  Drag to orbit, wheel to zoom.  Minimal orbit (no OrbitControls
// dependency — keeps the vendor surface to three.module alone).
export function mountPreview(container, bytes) {
  const parsed = parseDnm(bytes);
  const built = buildObject(parsed);

  const w = container.clientWidth || 360, h = container.clientHeight || 260;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1017);
  const cam = new THREE.PerspectiveCamera(45, w / h, 0.1, 2000);

  // Frame the model.
  const box = new THREE.Box3().setFromObject(built.object3d);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 1) * 0.8 + 2;
  built.object3d.position.sub(center); // recenter at origin
  // The engine's world is left-handed; three.js is right-handed.  Mirror the
  // DISPLAY (not the data) so the preview matches the in-game view — without
  // this, liveries and titles read as their mirror image.
  const mirror = new THREE.Group();
  mirror.scale.x = -1;
  mirror.add(built.object3d);
  scene.add(mirror);

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 0.9); key.position.set(1, 2, 1.5); scene.add(key);
  const fill = new THREE.DirectionalLight(0x99bbff, 0.35); fill.position.set(-1, -0.5, -1); scene.add(fill);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(w, h);
  container.appendChild(renderer.domElement);
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:grab';

  // Orbit state.
  let yaw = Math.PI * 0.15, pitch = 0.35, dist = radius * 2.4, dragging = false, lx = 0, ly = 0;
  const place = () => {
    cam.position.set(
      dist * Math.cos(pitch) * Math.sin(yaw),
      dist * Math.sin(pitch),
      dist * Math.cos(pitch) * Math.cos(yaw),
    );
    cam.lookAt(0, 0, 0);
  };
  const el = renderer.domElement;
  el.addEventListener('pointerdown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; el.setPointerCapture(e.pointerId); el.style.cursor = 'grabbing'; });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    yaw -= (e.clientX - lx) * 0.01; pitch = Math.max(-1.4, Math.min(1.4, pitch + (e.clientY - ly) * 0.01));
    lx = e.clientX; ly = e.clientY;
  });
  el.addEventListener('pointerup', (e) => { dragging = false; el.style.cursor = 'grab'; try { el.releasePointerCapture(e.pointerId); } catch (_) {} });
  el.addEventListener('wheel', (e) => { e.preventDefault(); dist = Math.max(radius * 0.6, Math.min(radius * 8, dist * (1 + Math.sign(e.deltaY) * 0.1))); }, { passive: false });

  let raf = 0, spin = true;
  const tick = () => {
    if (spin && !dragging) yaw += 0.004;
    place();
    renderer.render(scene, cam);
    raf = requestAnimationFrame(tick);
  };
  tick();

  return {
    movable: built.movableGroups,
    setMovable: (group, t) => setMovable(group, t),
    setPaint: (mapping) => applyPaint(built.meshesByLabel, mapping),
    setAutoSpin: (on) => { spin = on; },
    // Exposed for studio-paint.js face-picking (scene/camera/built/parsed).
    scene, camera, renderer, built, parsed,
    dispose: () => {
      cancelAnimationFrame(raf);
      renderer.dispose();
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
}
