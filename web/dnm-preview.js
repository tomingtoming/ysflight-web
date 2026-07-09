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

// Parse the embedded SRF text (the N lines after a PCK header) into geometry:
// { vertices: [[x,y,z],...], faces: [{idx:[...], color:[r,g,b], unlit}] }.
function parseSrf(lines) {
  const vertices = [];
  const faces = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const t = lines[i].trim().split(/\s+/);
    if (t[0] === 'V') vertices.push([parseFloat(t[1]), parseFloat(t[2]), parseFloat(t[3])]);
    else if (t[0] === 'F') {
      const face = { idx: [], color: [200, 200, 200], unlit: false };
      for (i++; i < lines.length; i++) {
        const f = lines[i].trim().split(/\s+/);
        if (f[0] === 'E') break;
        if (f[0] === 'V') face.idx = f.slice(1).map(Number);
        else if (f[0] === 'C') face.color = [+f[1], +f[2], +f[3]];
        else if (f[0] === 'B') face.unlit = true;
      }
      if (face.idx.length >= 3) faces.push(face);
    }
  }
  return { vertices, faces };
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

// Movable part CLA classes we expose sliders for (name -> class ids).  These are
// the ones a kid recognizes; the rest animate at 0 (rest pose).
export const MOVABLE = {
  gear: [16], // landing gear (down at STA0, up at STA-last)
  flap: [5],
  vgw: [1],   // variable-geometry wing
  elevator: [6], aileron: [7], rudder: [8],
};
const CLA_GROUP = {};
for (const [g, ids] of Object.entries(MOVABLE)) for (const id of ids) CLA_GROUP[id] = g;

function faceColor(face) {
  const c = face.color, mx = Math.max(c[0], c[1], c[2]);
  const s = mx > 1 ? 1 / 255 : 1; // some DNM use 0..1
  return [c[0] * s, c[1] * s, c[2] * s];
}

// Build a THREE.Group tree from a parsed DNM.  Each node becomes a Group holding
// its mesh; movable groups are tagged with userData.claGroup for the sliders.
// Returns { object3d, movableGroups: {gear:[Group],...}, meshesByLabel }.
export function buildObject(parsed) {
  const { nodes, srfByName } = parsed;
  const movableGroups = {};
  const meshesByLabel = new Map();

  const buildNode = (label) => {
    const n = nodes.get(label);
    if (!n) return null;
    const group = new THREE.Group();
    // POS: translation + h/p/b rotation (32768 = pi).  Applied about the node origin.
    group.position.set(n.pos[0], n.pos[1], n.pos[2]);
    group.rotation.set(n.pos[4] * A2R, n.pos[3] * A2R, n.pos[5] * A2R, 'YXZ');

    if (n.srf && srfByName.has(n.srf)) {
      const mesh = srfToMesh(srfByName.get(n.srf));
      if (mesh) { group.add(mesh); meshesByLabel.set(label, { mesh, srf: srfByName.get(n.srf) }); }
    }
    const g = CLA_GROUP[n.cla];
    if (g && n.sta.length >= 2) {
      group.userData.sta = n.sta;
      group.userData.cnt = n.cnt;
      (movableGroups[g] = movableGroups[g] || []).push(group);
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
  const pos = [], col = [], litFlag = [];
  const push = (v, c) => { pos.push(v[0], v[1], v[2]); col.push(c[0], c[1], c[2]); };
  for (const f of srf.faces) {
    const c = faceColor(f);
    for (let k = 1; k + 1 < f.idx.length; k++) {
      const a = srf.vertices[f.idx[0]], b = srf.vertices[f.idx[k]], d = srf.vertices[f.idx[k + 1]];
      if (!a || !b || !d) continue;
      push(a, c); push(b, c); push(d, c);
      litFlag.push(f.unlit ? 0 : 1, f.unlit ? 0 : 1, f.unlit ? 0 : 1);
    }
  }
  if (!pos.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  // A single mesh with a lambert material reads well enough for a preview; unlit
  // faces would ideally be flat, but mixing materials per-face needs groups —
  // preview keeps it one material (the game is the source of truth for shading).
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.srf = srf;
  return mesh;
}

// --- animation ------------------------------------------------------------------

// Drive a movable group to t in [0,1]: interpolate STA[0]->STA[last] rotation
// about CNT.  (Translation states exist too but rotation covers gear/flap/wing.)
export function setMovable(group, t) {
  const sta = group.userData.sta, cnt = group.userData.cnt;
  if (!sta) return;
  const a = sta[0], b = sta[sta.length - 1];
  const lerp = (i) => (a[i] + (b[i] - a[i]) * t);
  // Rotate about CNT: translate pivot to origin, rotate, translate back — folded
  // into the group's matrix via a small pivot child would be cleaner, but for a
  // preview we set rotation and nudge position to keep the pivot fixed.
  const h = lerp(3) * A2R, p = lerp(4) * A2R, bnk = lerp(5) * A2R;
  const e = new THREE.Euler(p, h, bnk, 'YXZ');
  const q = new THREE.Quaternion().setFromEuler(e);
  const pivot = new THREE.Vector3(cnt[0], cnt[1], cnt[2]);
  const basePos = group.userData.basePos || (group.userData.basePos = group.position.clone());
  // world = base + (pivot - R*pivot)
  const rp = pivot.clone().applyQuaternion(q);
  group.quaternion.copy(q);
  group.position.copy(basePos).add(pivot).sub(rp);
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
  scene.add(built.object3d);

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
    dispose: () => {
      cancelAnimationFrame(raf);
      renderer.dispose();
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
}
