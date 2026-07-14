// Cockpit position plumbing: .dat COCKPITP surgery (workbench.js), the glb
// Cockpit camera node round trip and its chirality (dnm-gltf.js), and the
// geometry fallback estimate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const stock = (name) => readFileSync(join(here, '..', 'upstream', 'YSFLIGHT', 'runtime', 'aircraft', name));

let getDatCockpit, setDatCockpit, dnmToGlb, glbToDnm, estimateCockpit;
try {
  ({ getDatCockpit, setDatCockpit } = await import('../web/workbench.js'));
  ({ dnmToGlb, glbToDnm, estimateCockpit } = await import('../web/dnm-gltf.js'));
} catch (e) {
  console.error('cockpit test imports skipped under Node: ' + e.message);
}

// --- .dat COCKPITP -----------------------------------------------------------------

test('getDatCockpit reads the stock b747 line verbatim', { skip: !getDatCockpit }, () => {
  // b747.dat: COCKPITP -0.5m  3.5m  29.05m  #COCKPIT POSITION
  assert.deepEqual(getDatCockpit(stock('b747.dat')), { x: -0.5, y: 3.5, z: 29.05 });
});

test('setDatCockpit replaces an existing COCKPITP in place, all other lines verbatim', { skip: !setDatCockpit }, () => {
  const src = stock('b747.dat');
  const out = setDatCockpit(src, { x: 1.25, y: 2.5, z: 10 });
  assert.deepEqual(getDatCockpit(out), { x: 1.25, y: 2.5, z: 10 });
  const a = new TextDecoder('latin1').decode(src).split('\n');
  const b = new TextDecoder('latin1').decode(out).split('\n');
  assert.equal(b.length, a.length, 'line count unchanged');
  const diff = a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y);
  assert.equal(diff.length, 1, 'exactly one line touched');
  assert.match(diff[0][1], /^COCKPITP 1\.25m {2}2\.5m {2}10m {2}#COCKPIT POSITION\r?$/, 'stock-shaped line');
});

test('setDatCockpit inserts after IDENTIFY when the base has no COCKPITP', { skip: !setDatCockpit }, () => {
  const src = new TextDecoder('latin1').decode(stock('b747.dat'))
    .split('\n').filter((l) => !/^COCKPITP\b/.test(l)).join('\n');
  const out = new TextDecoder('latin1').decode(
    setDatCockpit(new TextEncoder().encode(src), { x: -0.55, y: 1.07, z: 18 }));
  assert.deepEqual(getDatCockpit(new TextEncoder().encode(out)), { x: -0.55, y: 1.07, z: 18 });
  const lines = out.split('\n');
  const idIx = lines.findIndex((l) => /^IDENTIFY\b/.test(l));
  assert.match(lines[idIx + 1], /^COCKPITP -0\.55m/, 'inserted right after IDENTIFY');
});

// --- glb Cockpit camera node --------------------------------------------------------

const glbJson = (glb) => {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLen = dv.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
};
// Rebuild a GLB with a mutated JSON chunk (BIN untouched).
const withJson = (glb, json) => {
  const dv0 = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLen0 = dv0.getUint32(12, true);
  const bin = glb.subarray(20 + jsonLen0 + 8);
  const enc = new TextEncoder();
  const j0 = enc.encode(JSON.stringify(json));
  const jPad = (4 - (j0.length % 4)) % 4;
  const bPad = (4 - (bin.length % 4)) % 4;
  const total = 12 + 8 + j0.length + jPad + 8 + bin.length + bPad;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, j0.length + jPad, true); dv.setUint32(16, 0x4e4f534a, true);
  out.set(j0, 20); out.fill(0x20, 20 + j0.length, 20 + j0.length + jPad);
  const bh = 20 + j0.length + jPad;
  dv.setUint32(bh, bin.length + bPad, true); dv.setUint32(bh + 4, 0x004e4942, true);
  out.set(bin, bh + 8);
  return out;
};

const CK = { x: -0.5, y: 3.5, z: 29.05 };

test('export embeds a Cockpit camera node: mirrored pose, engine-exact extras', { skip: !dnmToGlb }, () => {
  const res = dnmToGlb(stock('f22.dnm'), { cockpit: CK });
  const json = glbJson(res.glb);
  assert.equal(json.cameras.length, 1);
  assert.equal(json.cameras[0].type, 'perspective');
  const node = json.nodes.find((n) => n.name === 'Cockpit');
  assert.ok(node && node.camera === 0, 'Cockpit node holds the camera');
  assert.ok(json.scenes[0].nodes.includes(json.nodes.indexOf(node)), 'camera is a scene root');
  // extras carry the COCKPITP value VERBATIM in YS coords (the round-trip
  // source of truth); the node pose is the mirrored right-handed view of it.
  assert.deepEqual(node.extras.ysflight.cockpit, CK);
  assert.deepEqual(node.translation, [0.5, 3.5, 29.05], 'x mirrored into the rh frame');
  // Facing the nose: glTF cameras look down local -Z, the nose is +Z in the
  // mirrored frame, so the rotation is a half turn about Y.
  const q = node.rotation.map(Math.abs);
  assert.ok(q[0] < 1e-9 && Math.abs(q[1] - 1) < 1e-9 && q[2] < 1e-9 && q[3] < 1e-9,
    '180deg about Y: ' + node.rotation);
});

test('glb -> dnm restores the cockpit value byte-exact, node/tri counts untouched', { skip: !dnmToGlb }, () => {
  const plain = dnmToGlb(stock('f22.dnm'));
  const withCk = dnmToGlb(stock('f22.dnm'), { cockpit: CK });
  const backPlain = glbToDnm(plain.glb);
  const backCk = glbToDnm(withCk.glb);
  assert.deepEqual(backCk.cockpit, CK, 'cockpit restored verbatim');
  assert.equal(backPlain.cockpit, null, 'no camera -> no cockpit');
  assert.equal(backCk.nodes, backPlain.nodes, 'camera node never becomes a DNM node');
  assert.equal(backCk.triangles, backPlain.triangles);
  assert.equal(new TextDecoder().decode(backCk.dnm), new TextDecoder().decode(backPlain.dnm),
    'the DNM itself is byte-identical with or without the camera');
});

test('camera without extras (rh file) mirrors the position back into YS coords', { skip: !dnmToGlb }, () => {
  // Simulate a Blender edit that lost the custom property but kept the camera:
  // the pose is right-handed, so the importer must flip x back.
  const res = dnmToGlb(stock('f22.dnm'), { cockpit: CK });
  const json = glbJson(res.glb);
  delete json.nodes.find((n) => n.name === 'Cockpit').extras;
  const back = glbToDnm(withJson(res.glb, json));
  assert.ok(back.cockpit, 'cockpit still recovered from the node pose');
  assert.ok(Math.abs(back.cockpit.x - CK.x) < 1e-5, 'x mirrored back: ' + back.cockpit.x);
  assert.ok(Math.abs(back.cockpit.y - CK.y) < 1e-5 && Math.abs(back.cockpit.z - CK.z) < 1e-5);
});

test('foreign glb without a camera imports with cockpit null (unchanged behavior)', { skip: !glbToDnm }, () => {
  const back = glbToDnm(readFileSync(join(here, '..', 'templates', 'aircraft-starter.glb')));
  assert.equal(back.cockpit, null);
});

// --- geometry fallback estimate ------------------------------------------------------

test('estimateCockpit lands near the stock eye point on the b747', { skip: !estimateCockpit }, () => {
  // Stock b747.dat: COCKPITP -0.5m 3.5m 29.05m on a ~71m airframe.  The
  // heuristic (eye ~7% of the length behind the nose, just under the local
  // crown) is a labeled ESTIMATE — assert the ballpark, not the meter.
  const est = estimateCockpit(stock('b747.dnm'));
  assert.equal(est.x, 0, 'centered');
  assert.ok(Math.abs(est.z - 29.05) < 4, 'z near the stock value: ' + est.z);
  assert.ok(est.y > 1.5 && est.y < 6.5, 'y in the flight-deck band: ' + est.y);
});
