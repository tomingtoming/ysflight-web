// Unit tests for the scenery studio's selection/editing model
// (web/scenery-edit.js): hit-testing in world meters, move / rotate /
// duplicate / delete, and the runway rectangle geometry they share.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  pointInPoly, runwayCorners, hitTest, itemAt,
  moveSelected, setHeading, duplicateSelected, deleteSelected,
} from '../web/scenery-edit.js';

const mkState = () => ({
  islands: [{ points: [[-1000, -1000], [1000, -1000], [0, 1000]] }],
  objects: [{ nam: 'CASTLE', x: 3000, z: 3000, headingDeg: 0 }],
  mountains: [{ x: -3000, z: 3000, radiusM: 1000, heightM: 300 }],
  starts: [{ x: 3000, z: 3000, altM: 500, speedMS: 100, headingDeg: 0 }],
  runways: [{ x: 0, z: -4000, headingDeg: 90, lengthM: 2000, widthM: 45 }],
});

test('pointInPoly: inside, outside, and winding-agnostic', () => {
  const tri = [[0, 0], [10, 0], [0, 10]];
  assert.equal(pointInPoly(tri, [2, 2]), true);
  assert.equal(pointInPoly(tri, [9, 9]), false);
  assert.equal(pointInPoly([...tri].reverse(), [2, 2]), true);
});

test('runwayCorners: compass 90 runway extends east-west', () => {
  // compass 90 = east: forward (sin, cos) = (+1, 0)
  const c = runwayCorners({ x: 0, z: 0, headingDeg: 90, lengthM: 2000, widthM: 40 });
  assert.deepEqual(c.map(([x, z]) => [Math.round(x), Math.round(z)]),
    [[1000, -20], [1000, 20], [-1000, 20], [-1000, -20]]);
});

test('hitTest: point targets beat area targets, latest placement wins', () => {
  const s = mkState();
  // start and object share (3000, 3000): the start wins (drawn on top)
  assert.deepEqual(hitTest(s, [3000, 3000], 250), { kind: 'start', index: 0 });
  s.starts.length = 0;
  assert.deepEqual(hitTest(s, [3000, 3000], 250), { kind: 'object', index: 0 });
  // runway: inside the rotated rect (compass 90 -> spans x -1000..1000 at z=-4000)
  assert.deepEqual(hitTest(s, [800, -4010], 250), { kind: 'runway', index: 0 });
  // mountain: anywhere within its radius
  assert.deepEqual(hitTest(s, [-2500, 3400], 250), { kind: 'mountain', index: 0 });
  // island body vs island vertex
  assert.deepEqual(hitTest(s, [0, -500], 250), { kind: 'island', index: 0 });
  assert.deepEqual(hitTest(s, [-990, -1010], 250), { kind: 'island', index: 0, vertex: 0 });
  // open sea
  assert.equal(hitTest(s, [-7000, -7000], 250), null);
  // overlapping objects: the most recently placed wins
  s.objects.push({ nam: 'TREE1', x: 3000, z: 3000, headingDeg: 0 });
  assert.deepEqual(hitTest(s, [3000, 3000], 250), { kind: 'object', index: 1 });
});

test('moveSelected: whole islands, single vertices, and point items', () => {
  const s = mkState();
  moveSelected(s, { kind: 'object', index: 0 }, 100, -200);
  assert.deepEqual([s.objects[0].x, s.objects[0].z], [3100, 2800]);
  moveSelected(s, { kind: 'island', index: 0 }, 10, 20);
  assert.deepEqual(s.islands[0].points[0], [-990, -980]);
  assert.deepEqual(s.islands[0].points[2], [10, 1020]);
  moveSelected(s, { kind: 'island', index: 0, vertex: 1 }, 5, 5);
  assert.deepEqual(s.islands[0].points[1], [1015, -975]);
  assert.deepEqual(s.islands[0].points[0], [-990, -980]); // others untouched
});

test('setHeading: wraps to [0, 360) and ignores islands/mountains', () => {
  const s = mkState();
  setHeading(s, { kind: 'runway', index: 0 }, 450);
  assert.equal(s.runways[0].headingDeg, 90);
  setHeading(s, { kind: 'start', index: 0 }, -10);
  assert.equal(s.starts[0].headingDeg, 350);
  setHeading(s, { kind: 'mountain', index: 0 }, 90);
  assert.equal(s.mountains[0].headingDeg, undefined);
});

test('duplicateSelected: deep copy with a nudge, selects the copy', () => {
  const s = mkState();
  const dupSel = duplicateSelected(s, { kind: 'island', index: 0 }, 500, -500);
  assert.deepEqual(dupSel, { kind: 'island', index: 1 });
  assert.deepEqual(s.islands[1].points[0], [-500, -1500]);
  s.islands[1].points[0][0] = 42; // the copy must not share point arrays
  assert.deepEqual(s.islands[0].points[0], [-1000, -1000]);
  const rwSel = duplicateSelected(s, { kind: 'runway', index: 0 }, 100, 100);
  assert.deepEqual(rwSel, { kind: 'runway', index: 1 });
  assert.equal(s.runways[1].x, 100);
  assert.equal(s.runways[1].headingDeg, 90); // properties ride along
});

test('deleteSelected + itemAt', () => {
  const s = mkState();
  assert.equal(itemAt(s, { kind: 'mountain', index: 0 }), s.mountains[0]);
  deleteSelected(s, { kind: 'mountain', index: 0 });
  assert.equal(s.mountains.length, 0);
  assert.equal(itemAt(s, { kind: 'mountain', index: 0 }), null);
  deleteSelected(s, { kind: 'mountain', index: 5 }); // out of range: no throw
});
