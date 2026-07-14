// 3D viewpoint tools for the studio preview: named EXCAMERA markers, a
// screen-plane drag handle on the selected camera, and "capture the current
// view" (📷) — the KSP-style direct-manipulation layer for eye points.
//
// Lives OUTSIDE dnm-preview.js on purpose: the preview stays a generic model
// viewer and this module drives it through the exported handles
// (preview.three + setPointerDownHook), so parallel preview work stays
// mergeable.  Everything at this API is YS AIRCRAFT COORDINATES ({x,y,z}
// meters, {h,p,b} RADIANS, YsAtt3 conventions = the .dat EXCAMERA values);
// the preview's display mirror (root scale.x = -1, the chirality fix) is
// crossed via modelRoot's own world matrix in BOTH directions, so what you
// capture is what you saw — no hand-derived sign to get wrong.

import * as THREE from './vendor/three.module.js';
import { ysAttVectors, ysAttFromForwardUp } from './dnm-gltf.js';

// Mount onto a live dnm-preview handle.  opts.onMove(key, {x,y,z}) fires as a
// marker is dragged (key = the item's key from setMarkers).  Returns
// { setMarkers(items), capturePose(), dispose() } where items are
// [{key, name, x,y,z, h,p,b, kind:'main'|'ex', selected}].
export function mountViewpointTools(preview, opts) {
  const { camera, renderer, modelRoot, radius } = preview.three;
  const onMove = opts && opts.onMove;
  const group = new THREE.Group();
  modelRoot.add(group);
  const s = Math.max((radius || 5) * 0.045, 0.25);

  let hitMeshes = [];   // invisible drag spheres, one per item
  const byKey = new Map(); // key -> the item's marker Group (moved live in drag)

  const clearGroup = () => {
    group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (o.material.map) o.material.map.dispose();
        o.material.dispose();
      }
    });
    group.clear();
    hitMeshes = [];
    byKey.clear();
  };

  // Name label as a billboard sprite.  Sprites size themselves from the world
  // matrix's column LENGTHS, so the mirrored ancestor cannot mirror the text.
  const labelSprite = (text, color) => {
    const fs = 28, pad = 8;
    const cv = document.createElement('canvas');
    let ctx = cv.getContext('2d');
    ctx.font = 'bold ' + fs + 'px system-ui, sans-serif';
    cv.width = Math.ceil(ctx.measureText(text).width) + pad * 2;
    cv.height = fs + 14;
    ctx = cv.getContext('2d'); // resizing reset the state
    ctx.font = 'bold ' + fs + 'px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(11,16,23,0.72)';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = color;
    ctx.fillText(text, pad, fs + 2);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(cv), depthTest: false, sizeAttenuation: true,
    }));
    sp.renderOrder = 1000;
    const k = (s * 1.5) / cv.height;
    sp.scale.set(cv.width * k, cv.height * k, 1);
    return sp;
  };

  const lineSeg = (pts, color) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, depthTest: false }));
    l.renderOrder = 999;
    return l;
  };

  const setMarkers = (items) => {
    clearGroup();
    for (const it of items || []) {
      const m = new THREE.Group();
      m.position.set(it.x, it.y, it.z);
      const color = it.selected ? 0xff8c3a : 0x4dd2ff;
      const cssColor = it.selected ? '#ff8c3a' : '#4dd2ff';
      // The main cockpit already has the preview's own yellow cross; this
      // module only adds its DRAG handle (and a selection cross when picked).
      if (it.kind !== 'main' || it.selected) {
        m.add(lineSeg([-s, 0, 0, s, 0, 0, 0, -s, 0, 0, s, 0, 0, 0, -s * 0.6, 0, 0, s * 0.6], color));
        // Forward ray: where this viewpoint looks (h/p/b through the engine's
        // exact vector math — the main cockpit looks at the nose, +Z).
        const f = ysAttVectors(it.h || 0, it.p || 0, it.b || 0).forward;
        m.add(lineSeg([0, 0, 0, f[0] * s * 2.8, f[1] * s * 2.8, f[2] * s * 2.8], color));
      }
      if (it.kind !== 'main' && it.name) {
        const sp = labelSprite(it.name, cssColor);
        sp.position.set(0, s * 1.6, 0);
        m.add(sp);
      }
      const hit = new THREE.Mesh(
        new THREE.SphereGeometry(s * 1.2, 8, 6),
        new THREE.MeshBasicMaterial({ visible: false }));
      hit.userData.key = it.key;
      m.add(hit);
      hitMeshes.push(hit);
      byKey.set(it.key, m);
      group.add(m);
    }
  };

  // --- capture the current view (📷) ----------------------------------------------
  // Preview camera pose -> YS aircraft coords + YsAtt3 angles, via the model
  // root's world matrix (which owns the recenter offset, the face-the-camera
  // rotation AND the display mirror — inverting it undoes all three at once).
  const capturePose = () => {
    modelRoot.updateWorldMatrix(true, false);
    const inv = new THREE.Matrix4().copy(modelRoot.matrixWorld).invert();
    const eye = camera.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
    const m3 = new THREE.Matrix3().setFromMatrix4(inv);
    const q = camera.getWorldQuaternion(new THREE.Quaternion());
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q).applyMatrix3(m3).normalize();
    const u = new THREE.Vector3(0, 1, 0).applyQuaternion(q).applyMatrix3(m3).normalize();
    const att = ysAttFromForwardUp([f.x, f.y, f.z], [u.x, u.y, u.z]);
    return { x: eye.x, y: eye.y, z: eye.z, h: att.h, p: att.p, b: att.b };
  };

  // --- drag handle ------------------------------------------------------------------
  // Screen-plane drag: grab a marker's hit sphere, move it in the plane
  // through the marker perpendicular to the view axis (the least surprising
  // 3D drag), report YS-local positions live via onMove.
  const raycaster = new THREE.Raycaster();
  const ndc = (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - r.left) / (r.width || 1)) * 2 - 1,
      -((e.clientY - r.top) / (r.height || 1)) * 2 + 1);
  };
  let moveL = null, upL = null;
  preview.setPointerDownHook((e) => {
    if (preview.getCockpitView()) return false; // no gizmo from inside the eye
    raycaster.setFromCamera(ndc(e), camera);
    const hits = raycaster.intersectObjects(hitMeshes, false);
    if (!hits.length) return false;
    const key = hits[0].object.userData.key;
    const marker = byKey.get(key);
    const p0 = marker.getWorldPosition(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      camera.getWorldDirection(new THREE.Vector3()), p0);
    const pt = new THREE.Vector3();
    moveL = (ev) => {
      raycaster.setFromCamera(ndc(ev), camera);
      if (!raycaster.ray.intersectPlane(plane, pt)) return;
      modelRoot.updateWorldMatrix(true, false);
      const local = modelRoot.worldToLocal(pt.clone());
      marker.position.copy(local); // live visual, no rebuild churn
      if (onMove) onMove(key, { x: local.x, y: local.y, z: local.z });
    };
    upL = () => {
      window.removeEventListener('pointermove', moveL);
      window.removeEventListener('pointerup', upL);
      moveL = upL = null;
    };
    window.addEventListener('pointermove', moveL);
    window.addEventListener('pointerup', upL);
    return true; // ours — the preview must not orbit
  });

  return {
    setMarkers,
    capturePose,
    dispose: () => {
      if (upL) upL();
      preview.setPointerDownHook(null);
      clearGroup();
      if (group.parent) group.parent.remove(group);
    },
  };
}
