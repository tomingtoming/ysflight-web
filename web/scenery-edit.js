// scenery-edit.js — selection / editing model for the Scenery Studio (🏝).
// Pure data helpers, no DOM: everything is in world meters (+x = east,
// +z = north; headingDeg = compass — see compassToEngineDeg in workbench.js).
//
// state = {
//   islands:   [{points: [[x, z], ...]}],
//   objects:   [{nam, x, z, headingDeg}],
//   mountains: [{x, z, radiusM, heightM}],
//   starts:    [{x, z, altM, speedMS, headingDeg}],
//   runways:   [{x, z, headingDeg, lengthM, widthM, ils?, vaid?}],
// }
// selection = {kind: 'island'|'object'|'mountain'|'start'|'runway', index, vertex?}

// Ray-cast point-in-polygon (winding-agnostic).
export function pointInPoly(points, [px, pz]) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, zi] = points[i], [xj, zj] = points[j];
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// The four pavement corners of a runway rectangle (+marginM on every side).
// Order: forward-right, forward-left, back-left, back-right.
export function runwayCorners({ x, z, headingDeg = 0, lengthM = 2000, widthM = 45 }, marginM = 0) {
  const h = ((headingDeg || 0) * Math.PI) / 180;
  const fx = Math.sin(h), fz = Math.cos(h);   // forward (landing direction)
  const rx = Math.cos(h), rz = -Math.sin(h);  // pilot's right
  const hl = lengthM / 2 + marginM, hw = widthM / 2 + marginM;
  return [
    [x + fx * hl + rx * hw, z + fz * hl + rz * hw],
    [x + fx * hl - rx * hw, z + fz * hl - rz * hw],
    [x - fx * hl - rx * hw, z - fz * hl - rz * hw],
    [x - fx * hl + rx * hw, z - fz * hl + rz * hw],
  ];
}

const d2 = (ax, az, [bx, bz]) => (ax - bx) * (ax - bx) + (az - bz) * (az - bz);

// Pick the item under a world point.  Small point targets (starts, objects)
// win over area targets (runways, mountains, islands); within a class the
// most recently placed wins (matches paint order).  tolM is the click slop
// in meters.  For a selected island, prefer a vertex grab within tolM.
export function hitTest(state, pt, tolM) {
  const tol2 = tolM * tolM;
  const starts = state.starts || [], objects = state.objects || [];
  const runways = state.runways || [], mountains = state.mountains || [], islands = state.islands || [];
  for (let i = starts.length - 1; i >= 0; i--) {
    if (d2(starts[i].x, starts[i].z, pt) <= tol2) return { kind: 'start', index: i };
  }
  for (let i = objects.length - 1; i >= 0; i--) {
    if (d2(objects[i].x, objects[i].z, pt) <= tol2) return { kind: 'object', index: i };
  }
  for (let i = runways.length - 1; i >= 0; i--) {
    if (pointInPoly(runwayCorners(runways[i], tolM / 2), pt)) return { kind: 'runway', index: i };
  }
  for (let i = mountains.length - 1; i >= 0; i--) {
    const r = mountains[i].radiusM || 1500;
    if (d2(mountains[i].x, mountains[i].z, pt) <= r * r) return { kind: 'mountain', index: i };
  }
  for (let i = islands.length - 1; i >= 0; i--) {
    const points = islands[i].points || [];
    for (let v = 0; v < points.length; v++) {
      if (d2(points[v][0], points[v][1], pt) <= tol2) return { kind: 'island', index: i, vertex: v };
    }
    if (pointInPoly(points, pt)) return { kind: 'island', index: i };
  }
  return null;
}

export function itemAt(state, sel) {
  if (!sel) return null;
  const arr = state[sel.kind === 'island' ? 'islands' : sel.kind + 's'];
  return (arr && arr[sel.index]) || null;
}

// Translate the selected item (or a single island vertex) by (dx, dz).
export function moveSelected(state, sel, dx, dz) {
  const it = itemAt(state, sel);
  if (!it) return;
  if (sel.kind === 'island') {
    if (sel.vertex !== undefined && sel.vertex !== null) {
      const p = it.points[sel.vertex];
      if (p) { p[0] += dx; p[1] += dz; }
    } else {
      for (const p of it.points) { p[0] += dx; p[1] += dz; }
    }
  } else {
    it.x += dx;
    it.z += dz;
  }
}

// Set the compass heading of a directional item (no-op for the rest).
export function setHeading(state, sel, headingDeg) {
  const it = itemAt(state, sel);
  if (it && sel.kind !== 'island' && sel.kind !== 'mountain') {
    it.headingDeg = ((Number(headingDeg) || 0) % 360 + 360) % 360;
  }
}

// Append a deep copy of the selected item, nudged by (dx, dz); returns the
// selection of the copy (so the caller can keep dragging it).
export function duplicateSelected(state, sel, dx = 500, dz = 500) {
  const it = itemAt(state, sel);
  if (!it) return null;
  const arr = state[sel.kind === 'island' ? 'islands' : sel.kind + 's'];
  const copy = sel.kind === 'island'
    ? { ...it, points: it.points.map(([x, z]) => [x + dx, z + dz]) }
    : { ...it, x: it.x + dx, z: it.z + dz };
  arr.push(copy);
  return { kind: sel.kind, index: arr.length - 1 };
}

export function deleteSelected(state, sel) {
  const arr = state[sel && (sel.kind === 'island' ? 'islands' : sel.kind + 's')];
  if (arr && sel.index >= 0 && sel.index < arr.length) arr.splice(sel.index, 1);
}
