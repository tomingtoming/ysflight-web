// EXCAMERA (extra viewpoint) plumbing: .dat line surgery (workbench.js), the
// glb camera-node round trip (dnm-gltf.js), the YsAtt3 <-> vector math, and
// the preview-capture coordinate chain (viewpoint-tools.js capturePose).
//
// Engine ground truth (fsairplaneproperty.cpp case 144, fssimulation.cpp
// SimDecideViewpoint / the FSBTF_COCKPITVIEW cycle):
//   EXCAMERA "<name>" x y z h p b INSIDE|OUTSIDE|CABIN [NOHUD] [NOINSTPANEL]
// with mandatory unit suffixes, defaults INSIDE/HUD-on/panel-on, and the .dat
// line order = the F1 view cycle order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const stock = (name) => readFileSync(join(here, '..', 'upstream', 'YSFLIGHT', 'runtime', 'aircraft', name));

let getDatExCameras, setDatExCameras, dnmToGlb, glbToDnm, ysAttVectors, ysAttFromForwardUp;
let THREE, mountViewpointTools;
try {
  ({ getDatExCameras, setDatExCameras } = await import('../web/workbench.js'));
  ({ dnmToGlb, glbToDnm, ysAttVectors, ysAttFromForwardUp } = await import('../web/dnm-gltf.js'));
  THREE = await import('../web/vendor/three.module.js');
  ({ mountViewpointTools } = await import('../web/viewpoint-tools.js'));
} catch (e) {
  console.error('excamera test imports skipped under Node: ' + e.message);
}

const D2R = Math.PI / 180;
const latin1 = (b) => new TextDecoder('latin1').decode(b);

// --- .dat EXCAMERA -----------------------------------------------------------------

test('getDatExCameras reads the stock b747 lines verbatim, in F1 order', { skip: !getDatExCameras }, () => {
  // b747.dat: EXCAMERA "CO-PILOT" 0.5m 3.5m 29.05m ... / "INSTRUMENT" -0.5m 3.1m ...
  assert.deepEqual(getDatExCameras(stock('b747.dat')), [
    { name: 'CO-PILOT', x: 0.5, y: 3.5, z: 29.05, h: 0, p: 0, b: 0, type: 'INSIDE', noHud: false, noInstPanel: false },
    { name: 'INSTRUMENT', x: -0.5, y: 3.1, z: 29.05, h: 0, p: 0, b: 0, type: 'INSIDE', noHud: false, noInstPanel: false },
  ]);
});

test('getDatExCameras reads flags: f15dj NOHUD, b29 CABIN with -90deg pitch', { skip: !getDatExCameras }, () => {
  const nav = getDatExCameras(stock('f15dj.dat'))[0];
  assert.equal(nav.name, 'NAVIGATOR');
  assert.equal(nav.noHud, true);
  assert.equal(nav.noInstPanel, false);
  const bay = getDatExCameras(stock('b29.dat')).find((c) => c.name === 'BOMBBAY');
  assert.equal(bay.type, 'CABIN');
  assert.equal(bay.p, -90);
  assert.deepEqual(bay.b, 0, '-0deg normalizes to 0');
});

test('setDatExCameras replaces existing lines in place, all other bytes verbatim', { skip: !setDatExCameras }, () => {
  const src = stock('b747.dat');
  const cams = getDatExCameras(src);
  cams[0] = { ...cams[0], x: 1.5, h: -20 };
  const out = setDatExCameras(src, cams);
  const a = latin1(src).split('\n');
  const b = latin1(out).split('\n');
  assert.equal(b.length, a.length, 'line count unchanged');
  const diff = a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y);
  assert.equal(diff.length, 1, 'exactly one line touched');
  assert.match(diff[0][1], /^EXCAMERA "CO-PILOT" 1\.5m 3\.5m 29\.05m -20deg 0deg 0deg INSIDE\r?$/,
    'engine-shaped line (units + explicit type; case 144 needs ac>=9)');
  assert.deepEqual(getDatExCameras(out), cams);
});

test('setDatExCameras appends new cameras after the last EXCAMERA line (F1 order kept)', { skip: !setDatExCameras }, () => {
  const src = stock('b747.dat');
  const cams = getDatExCameras(src);
  cams.push({ name: 'JUMP SEAT', x: 0, y: 3, z: 25, h: 180, p: 0, b: 0, type: 'CABIN', noHud: true, noInstPanel: false });
  const out = setDatExCameras(src, cams);
  const a = latin1(src).split('\n');
  const b = latin1(out).split('\n');
  assert.equal(b.length, a.length + 1, 'one line added');
  const lastEx = a.reduce((acc, l, i) => (/^EXCAMERA\b/.test(l) ? i : acc), -1);
  assert.match(b[lastEx + 1], /^EXCAMERA "JUMP SEAT" 0m 3m 25m 180deg 0deg 0deg CABIN NOHUD\r?$/,
    'inserted right below the stock EXCAMERA block, quoted name with a space');
  assert.deepEqual(getDatExCameras(out), cams, 'round trip incl. flags');
});

test('setDatExCameras inserts after COCKPITP when the .dat has no EXCAMERA yet', { skip: !setDatExCameras }, () => {
  const bare = new TextEncoder().encode(
    latin1(stock('b747.dat')).split('\n').filter((l) => !/^EXCAMERA\b/.test(l)).join('\n'));
  const cam = { name: 'CO-PILOT', x: 0.5, y: 3.5, z: 29.05, h: 0, p: 0, b: 0, type: 'INSIDE', noHud: false, noInstPanel: false };
  const out = setDatExCameras(bare, [cam]);
  const lines = latin1(out).split('\n');
  const ckIx = lines.findIndex((l) => /^COCKPITP\b/.test(l));
  assert.match(lines[ckIx + 1], /^EXCAMERA "CO-PILOT"/, 'header block, right after COCKPITP');
  assert.deepEqual(getDatExCameras(out), [cam]);
});

test('setDatExCameras deletes surplus lines when the list shrinks', { skip: !setDatExCameras }, () => {
  const src = stock('b747.dat');
  const cams = getDatExCameras(src);
  const out = setDatExCameras(src, cams.slice(0, 1));
  const a = latin1(src).split('\n');
  const b = latin1(out).split('\n');
  assert.equal(b.length, a.length - 1, 'one line removed');
  assert.deepEqual(getDatExCameras(out), cams.slice(0, 1));
  // Nothing else moved: removing the deleted line from the original restores equality.
  const cut = a.filter((l) => !/^EXCAMERA "INSTRUMENT"/.test(l));
  assert.deepEqual(b, cut);
});

// --- glb camera nodes ----------------------------------------------------------------

const glbJson = (glb) => {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLen = dv.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
};
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
const EX = [
  { name: 'CO-PILOT', x: 0.5, y: 3.5, z: 29.05, h: 0, p: 0, b: 0, type: 'INSIDE', noHud: false, noInstPanel: false },
  { name: 'TAIL CAM', x: 0, y: 11, z: -19.9, h: 25, p: -10, b: 5, type: 'OUTSIDE', noHud: true, noInstPanel: false },
];

test('export embeds one named camera node per EXCAMERA next to the Cockpit one', { skip: !dnmToGlb }, () => {
  const res = dnmToGlb(stock('f22.dnm'), { cockpit: CK, excameras: EX });
  const json = glbJson(res.glb);
  assert.equal(json.cameras.length, 3, 'Cockpit + 2 EXCAMERA');
  for (const name of ['Cockpit', 'CO-PILOT', 'TAIL CAM']) {
    const node = json.nodes.find((n) => n.name === name);
    assert.ok(node && node.camera !== undefined, name + ' node holds a camera');
    assert.ok(json.scenes[0].nodes.includes(json.nodes.indexOf(node)), name + ' is a scene root');
  }
  // extras carry the .dat values VERBATIM (degrees, YS coords).
  const tail = json.nodes.find((n) => n.name === 'TAIL CAM');
  assert.deepEqual(tail.extras.ysflight.excamera,
    { name: 'TAIL CAM', x: 0, y: 11, z: -19.9, h: 25, p: -10, b: 5, type: 'OUTSIDE', noHud: 1 });
  // The nose-facing zero-attitude camera gets the same mirrored pose the
  // Cockpit camera does: x flipped, half turn about Y.
  const co = json.nodes.find((n) => n.name === 'CO-PILOT');
  assert.deepEqual(co.translation, [-0.5, 3.5, 29.05]);
  const q = co.rotation.map(Math.abs);
  assert.ok(q[0] < 1e-9 && Math.abs(q[1] - 1) < 1e-9 && q[2] < 1e-9 && q[3] < 1e-9, '180deg about Y');
});

test('glb -> dnm restores every EXCAMERA verbatim, DNM bytes untouched', { skip: !dnmToGlb }, () => {
  const plain = dnmToGlb(stock('f22.dnm'));
  const withEx = dnmToGlb(stock('f22.dnm'), { cockpit: CK, excameras: EX });
  const backPlain = glbToDnm(plain.glb);
  const backEx = glbToDnm(withEx.glb);
  assert.deepEqual(backEx.excameras, EX, 'names, positions, angles, types, flags — all back');
  assert.deepEqual(backEx.cockpit, CK, 'cockpit unaffected by the extra cameras');
  assert.deepEqual(backPlain.excameras, [], 'no cameras -> no excameras');
  assert.equal(backEx.nodes, backPlain.nodes, 'camera nodes never become DNM nodes');
  assert.equal(new TextDecoder().decode(backEx.dnm), new TextDecoder().decode(backPlain.dnm),
    'the DNM itself is byte-identical with or without the cameras');
});

test('EXCAMERA node without extras (Blender-added camera) recovers pose + attitude', { skip: !dnmToGlb }, () => {
  const res = dnmToGlb(stock('f22.dnm'), { cockpit: CK, excameras: EX });
  const json = glbJson(res.glb);
  delete json.nodes.find((n) => n.name === 'TAIL CAM').extras;
  const back = glbToDnm(withJson(res.glb, json));
  const tail = back.excameras.find((c) => c.name === 'TAIL CAM');
  assert.ok(tail, 'camera still recovered from the node pose');
  for (const [k, want] of [['x', 0], ['y', 11], ['z', -19.9], ['h', 25], ['p', -10], ['b', 5]]) {
    assert.ok(Math.abs(tail[k] - want) < 1e-4, k + ' recovered: ' + tail[k] + ' ~ ' + want);
  }
  assert.equal(tail.type, 'INSIDE', 'flags are extras-only, defaults apply');
});

test('foreign glb without cameras imports with excameras []', { skip: !glbToDnm }, () => {
  const back = glbToDnm(readFileSync(join(here, '..', 'templates', 'aircraft-starter.glb')));
  assert.deepEqual(back.excameras, []);
});

// --- YsAtt3 <-> forward/up math -------------------------------------------------------

test('ysAttVectors matches the engine conventions at the cardinal attitudes', { skip: !ysAttVectors }, () => {
  const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-12);
  assert.ok(close(ysAttVectors(0, 0, 0).forward, [0, 0, 1]), 'zero attitude looks at the nose (+Z)');
  assert.ok(close(ysAttVectors(90 * D2R, 0, 0).forward, [-1, 0, 0]), '+h yaws LEFT (port, -X)');
  assert.ok(close(ysAttVectors(0, 90 * D2R, 0).forward, [0, 1, 0]), '+p pitches UP (+Y)');
  assert.ok(close(ysAttVectors(0, 0, 0).up, [0, 1, 0]), 'zero attitude up is +Y');
});

test('ysAttFromForwardUp inverts ysAttVectors across the h/p/b grid', { skip: !ysAttFromForwardUp }, () => {
  for (const h of [-135, -45, 0, 30, 90, 179]) {
    for (const p of [-60, -15, 0, 45, 80]) {
      for (const b of [-30, 0, 10, 60]) {
        const { forward, up } = ysAttVectors(h * D2R, p * D2R, b * D2R);
        const r = ysAttFromForwardUp(forward, up);
        assert.ok(Math.abs(r.h - h * D2R) < 1e-9 && Math.abs(r.p - p * D2R) < 1e-9 && Math.abs(r.b - b * D2R) < 1e-9,
          `h=${h} p=${p} b=${b} -> ${r.h / D2R},${r.p / D2R},${r.b / D2R}`);
      }
    }
  }
});

test('gimbal poles (b29 bomb-bay style, p=±90) recover a view-identical attitude', { skip: !ysAttFromForwardUp }, () => {
  for (const p of [-90, 90]) {
    for (const h of [0, 30, -120]) {
      for (const b of [0, 25]) {
        const v = ysAttVectors(h * D2R, p * D2R, b * D2R);
        const r = ysAttFromForwardUp(v.forward, v.up);
        const v2 = ysAttVectors(r.h, r.p, r.b);
        for (let i = 0; i < 3; i++) {
          assert.ok(Math.abs(v.forward[i] - v2.forward[i]) < 1e-9, 'forward preserved');
          assert.ok(Math.abs(v.up[i] - v2.up[i]) < 1e-9, 'up preserved');
        }
        assert.equal(r.b, 0, 'pole twist goes into h, b pinned to 0');
      }
    }
  }
});

// --- capture <-> view consistency (the mirror-display chain) --------------------------
// The preview shows YS(x,y,z) at world (x,y,-z): rotation.y=pi to face the
// camera, then the chirality mirror scale.x=-1 (dnm-preview.js).  These two
// tests pin both directions of that chain — capture inverts what the eye view
// renders, so 写し取り -> 👀 shows the same picture.

test('eye-view init (ckYaw=-h, ckPitch=p) equals the YS attitude through the display map', { skip: !ysAttVectors }, () => {
  for (const h of [-120, -45, 0, 30, 90]) {
    for (const p of [-45, 0, 60]) {
      const f = ysAttVectors(h * D2R, p * D2R, 0).forward;
      const disp = [f[0], f[1], -f[2]]; // YS -> preview world
      const ckYaw = -h * D2R, ckPitch = p * D2R;
      const dir = [Math.sin(ckYaw) * Math.cos(ckPitch), Math.sin(ckPitch), -Math.cos(ckYaw) * Math.cos(ckPitch)];
      for (let i = 0; i < 3; i++) {
        assert.ok(Math.abs(disp[i] - dir[i]) < 1e-12, `h=${h} p=${p} axis ${i}: ${disp[i]} vs ${dir[i]}`);
      }
    }
  }
});

test('capturePose inverts the real preview transform chain (recenter + facing + mirror)', { skip: !mountViewpointTools }, () => {
  // Replicate mountPreview's scene graph exactly: recentered model root,
  // rotation.y = pi, mirrored display parent.
  const modelRoot = new THREE.Group();
  modelRoot.position.set(-1.25, 0.4, -7.5); // arbitrary recenter offset
  modelRoot.rotation.y = Math.PI;
  const mirror = new THREE.Group();
  mirror.scale.x = -1;
  mirror.add(modelRoot);
  new THREE.Scene().add(mirror);
  const camera = new THREE.PerspectiveCamera();

  const fake = {
    three: { camera, renderer: { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } }, modelRoot, radius: 10 },
    setPointerDownHook: () => {},
    getCockpitView: () => false,
  };
  const tools = mountViewpointTools(fake, {});

  const eyeYs = { x: 0.5, y: 3.5, z: 29.05 };
  for (const [h, p] of [[0, 0], [25, -10], [-100, 35]]) {
    // Aim the camera along the YS attitude, expressed in world space through
    // the model transform (exactly what the marker/eye rendering does).
    modelRoot.updateWorldMatrix(true, false);
    const m3 = new THREE.Matrix3().setFromMatrix4(modelRoot.matrixWorld);
    const v = ysAttVectors(h * D2R, p * D2R, 0);
    const eyeW = new THREE.Vector3(eyeYs.x, eyeYs.y, eyeYs.z).applyMatrix4(modelRoot.matrixWorld);
    camera.position.copy(eyeW);
    camera.up.copy(new THREE.Vector3(...v.up).applyMatrix3(m3).normalize());
    camera.lookAt(eyeW.clone().add(new THREE.Vector3(...v.forward).applyMatrix3(m3).normalize()));
    camera.updateMatrixWorld(true);

    const pose = tools.capturePose();
    assert.ok(Math.abs(pose.x - eyeYs.x) < 1e-9 && Math.abs(pose.y - eyeYs.y) < 1e-9 && Math.abs(pose.z - eyeYs.z) < 1e-9,
      `position back in YS coords (h=${h},p=${p}): ${pose.x},${pose.y},${pose.z}`);
    assert.ok(Math.abs(pose.h - h * D2R) < 1e-9, `h captured: ${pose.h / D2R} ~ ${h}`);
    assert.ok(Math.abs(pose.p - p * D2R) < 1e-9, `p captured: ${pose.p / D2R} ~ ${p}`);
    assert.ok(Math.abs(pose.b) < 1e-9, `b stays level: ${pose.b / D2R}`);
  }
});
