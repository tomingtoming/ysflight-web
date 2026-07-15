// Lightweight 3D preview of a YSFLIGHT aircraft model (DNM), for the workbench.
//
// This is a PREVIEW, not the game renderer: it exists so you can spin the model,
// see a paint change instantly, and scrub a landing gear / flap open-and-shut —
// without launching the full editor (Polygon Crest) or flying.  The real look is
// always the engine (the 🛫 button); this is the approachable glance.
//
// The DNM/SRF parser itself lives in dnm-parse.js (pure, no Three.js) so the
// Blender bridge, the linter and the CLIs can share it without dragging in a
// renderer; this module re-exports it for existing importers and feeds it to
// Three.js.  Prior art for the full-fidelity loader is tomingtoming/webflight
// (YSFlightDNMParser / DNMToThreeJSConverter); this covers the preview subset:
// geometry + colors + single-axis movable-part animation.

import * as THREE from './vendor/three.module.js';
import { parseDnm, faceNormal, smoothVertexNormals } from './dnm-parse.js';

export { parseDnm, parseSrf, decodeSrfColor, faceNormal, smoothVertexNormals } from './dnm-parse.js';

const A2R = Math.PI / 32768; // STA/POS angle unit -> radians

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

  // Cockpit eye-point marker: a small cross with a longer arm toward the nose
  // (+Z in YS coords).  Parented INTO the model so the recenter / mirror /
  // face-the-camera rotation all apply — marker coordinates are plain YS
  // aircraft coordinates, the same numbers as the .dat COCKPITP line.
  const ckMarker = new THREE.Group();
  ckMarker.visible = false;
  {
    const s = Math.max(radius * 0.045, 0.25);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([
      -s, 0, 0, s, 0, 0, 0, -s, 0, 0, s, 0, 0, 0, -s, 0, 0, s * 2.4,
    ], 3));
    const cross = new THREE.LineSegments(geo,
      new THREE.LineBasicMaterial({ color: 0xffd24d, depthTest: false }));
    cross.renderOrder = 999; // visible through the hull
    ckMarker.add(cross);
  }
  built.object3d.add(ckMarker);

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 0.9); key.position.set(1, 2, 1.5); scene.add(key);
  const fill = new THREE.DirectionalLight(0x99bbff, 0.35); fill.position.set(-1, -0.5, -1); scene.add(fill);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(w, h);
  container.appendChild(renderer.domElement);
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:grab';

  // Orbit state — plus the first-person cockpit-view state.  In cockpit mode
  // the camera sits AT the marker looking toward the nose, with a simple
  // yaw/pitch look-around on drag (no orbit); meshes are already DoubleSide,
  // so the hull stays visible from inside.
  let yaw = Math.PI * 0.15, pitch = 0.35, dist = radius * 2.4, dragging = false, lx = 0, ly = 0;
  let ckPos = null;                          // {x,y,z} YS coords, or null
  let ckAtt = null;                          // optional {h,p,b} YS view attitude, RADIANS
  let ckMode = false, ckYaw = 0, ckPitch = 0; // look-around angles (0 = the eye's own attitude)
  let downHook = null;                       // sibling tools may claim a pointerdown
  const eye = new THREE.Vector3(), look = new THREE.Vector3();
  const place = () => {
    if (ckMode && ckPos) {
      // World position of the eye point through the model transform chain.
      eye.set(ckPos.x, ckPos.y, ckPos.z);
      built.object3d.updateWorldMatrix(true, false);
      built.object3d.localToWorld(eye);
      cam.position.copy(eye);
      // YS +Z (nose) lands at world -Z, YS +X (starboard) at world +X after
      // the display rotation+mirror, so this dir looks at the nose at 0/0
      // and ckYaw > 0 looks to starboard.
      look.set(
        Math.sin(ckYaw) * Math.cos(ckPitch),
        Math.sin(ckPitch),
        -Math.cos(ckYaw) * Math.cos(ckPitch),
      ).add(eye);
      cam.lookAt(look);
      return;
    }
    cam.position.set(
      dist * Math.cos(pitch) * Math.sin(yaw),
      dist * Math.sin(pitch),
      dist * Math.cos(pitch) * Math.cos(yaw),
    );
    cam.lookAt(0, 0, 0);
  };
  const setCockpitView = (on) => {
    ckMode = !!(on && ckPos);
    if (ckMode) {
      // Start the look-around at the eye's own attitude (EXCAMERA h/p): YS h
      // yaws LEFT for + while ckYaw looks starboard for +, so ckYaw = -h.
      // Bank is not represented in the preview (the truth is the 🛫 flight).
      ckYaw = ckAtt ? -(ckAtt.h || 0) : 0;
      ckPitch = ckAtt ? (ckAtt.p || 0) : 0;
      cam.fov = 60; cam.near = 0.05;
      ckMarker.visible = false; // it would sit right in the lens
    } else {
      cam.fov = 45; cam.near = 0.1;
      ckMarker.visible = !!ckPos;
    }
    cam.updateProjectionMatrix();
  };
  const el = renderer.domElement;
  el.addEventListener('pointerdown', (e) => { if (downHook && downHook(e)) return; dragging = true; lx = e.clientX; ly = e.clientY; el.setPointerCapture(e.pointerId); el.style.cursor = 'grabbing'; });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    if (ckMode) {
      ckYaw += (e.clientX - lx) * 0.005;
      ckPitch = Math.max(-1.4, Math.min(1.4, ckPitch - (e.clientY - ly) * 0.005));
    } else {
      yaw -= (e.clientX - lx) * 0.01; pitch = Math.max(-1.4, Math.min(1.4, pitch + (e.clientY - ly) * 0.01));
    }
    lx = e.clientX; ly = e.clientY;
  });
  el.addEventListener('pointerup', (e) => { dragging = false; el.style.cursor = 'grab'; try { el.releasePointerCapture(e.pointerId); } catch (_) {} });
  el.addEventListener('wheel', (e) => { e.preventDefault(); if (!ckMode) dist = Math.max(radius * 0.6, Math.min(radius * 8, dist * (1 + Math.sign(e.deltaY) * 0.1))); }, { passive: false });

  let raf = 0, spin = true;
  const tick = () => {
    if (spin && !dragging && !ckMode) yaw += 0.004;
    place();
    renderer.render(scene, cam);
    raf = requestAnimationFrame(tick);
  };
  tick();

  return {
    scene,          // Three.js Scene — lets overlays (e.g. gizmos) add objects
    renderer,       // Three.js WebGLRenderer — for future overlay compositing
    parsedDnm: parsed,        // raw parsed structure for node inspection
    builtObject: built,       // { object3d, movableGroups, meshesByLabel }
    movable: built.movableGroups,
    setMovable: (group, t) => setMovable(group, t),
    setPaint: (mapping) => applyPaint(built.meshesByLabel, mapping),
    setAutoSpin: (on) => { spin = on; },
    // Cockpit eye point in YS aircraft coords ({x,y,z} = the COCKPITP value),
    // or null to clear.  Marker shows whenever set (except while inside).
    // p may also carry an EXCAMERA view attitude {h,p,b} in RADIANS (YsAtt3
    // conventions) — the next setCockpitView(true) starts looking that way.
    setCockpit: (p) => {
      ckPos = p && [p.x, p.y, p.z].every(Number.isFinite) ? { x: p.x, y: p.y, z: p.z } : null;
      ckAtt = p && Number.isFinite(p.h) ? { h: p.h, p: p.p || 0, b: p.b || 0 } : null;
      if (ckPos) ckMarker.position.set(ckPos.x, ckPos.y, ckPos.z);
      if (!ckPos && ckMode) setCockpitView(false);
      ckMarker.visible = !!ckPos && !ckMode;
    },
    setCockpitView,
    getCockpitView: () => ckMode,
    // Escape hatches for sibling tools (studio viewpoint gizmos): the live
    // three.js objects, and a pointerdown interceptor — return true from the
    // hook to claim the gesture (the orbit drag then ignores it).
    three: { scene, camera: cam, renderer, modelRoot: built.object3d, radius },
    setPointerDownHook: (fn) => { downHook = fn; },
    dispose: () => {
      cancelAnimationFrame(raf);
      renderer.dispose();
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
}
