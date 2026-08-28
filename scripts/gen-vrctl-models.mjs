// Regenerates the hand-held VR controller models (upstream/YSFLIGHT/runtime/
// misc/vrctl_left.dnm, vrctl_right.dnm) and the button-anchor reference
// (specs/vrctl-button-anchors.json) from the WebXR input-profiles assets.
//
//   node scripts/gen-vrctl-models.mjs [--assets-dir <extracted-package-dir>]
//
// Without --assets-dir it fetches @webxr-input-profiles/assets with `npm pack`
// into a temp dir (dev-time network use only -- the OUTPUTS are committed, the
// shipped build never touches a CDN).
//
// Why the glbs are patched before conversion: the source models carry ALL of
// their visual detail in a baseColorTexture, and DNM has no textures --
// converted as-is every face lands on the converter's flat-color fallback and
// the whole controller reads as one grey blob.  Each mesh node (body, trigger,
// squeeze, thumbstick, face buttons) therefore gets its own textureless
// material with a flat baseColorFactor, so the parts the help placard talks
// about are visually separable on the DNM.
//
// The profile id is meta-quest-touch-plus (Quest 3 / 3S controllers).  The
// package also ships a *-v2 profile with ~4x heavier meshes; this script
// deliberately uses the light one -- the model is a hand prop, not a hero
// asset, and it rides inside the engine .data download.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glbToDnm } from '../web/dnm-gltf.js';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const PROFILE = 'meta-quest-touch-plus';

// sRGB targets / 255 == baseColorFactor (dnm-gltf.js multiplies the factor by
// 255 with no gamma step -- its untextured fallback 0.8 becomes rgb(204)).
const NODE_COLORS = {
  controller_mesh: [58, 62, 70],     // dark body, close to the real device
  trigger:         [84, 90, 100],
  squeeze:         [84, 90, 100],
  thumbstick:      [38, 40, 46],
  x_button:        [232, 236, 242],  // light, so "the buttons" pop against
  y_button:        [232, 236, 242],  // the body and match the help placard's
  a_button:        [232, 236, 242],  // callout language
  b_button:        [232, 236, 242],
};

// The components whose rest positions the help placard needs.  profile.json
// declares rootNodeName per component but those nodes do NOT exist in these
// glbs -- only the *_pressed_value visual-response nodes resolve, so anchors
// are taken from them.
const ANCHOR_NODES = {
  'xr-standard-trigger':    'xr_standard_trigger_pressed_value',
  'xr-standard-squeeze':    'xr_standard_squeeze_pressed_value',
  'xr-standard-thumbstick': 'xr_standard_thumbstick_pressed_value',
  'x-button': 'x_button_pressed_value',
  'y-button': 'y_button_pressed_value',
  'a-button': 'a_button_pressed_value',
  'b-button': 'b_button_pressed_value',
  'thumbrest': 'thumbrest_pressed_value',
};

// ---- GLB container ---------------------------------------------------------

function parseGlb(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const rest = buf.subarray(20 + jsonLen);   // BIN chunk (header + data), verbatim
  return { json, rest };
}

function buildGlb(json, rest) {
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const pad = (4 - (jsonBuf.length % 4)) % 4;
  if (pad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(pad, 0x20)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + jsonBuf.length + rest.length, 8);
  header.writeUInt32LE(jsonBuf.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, jsonBuf, rest]);
}

// ---- recolor: one textureless material per named mesh node -----------------

function recolor(json) {
  json.materials = json.materials || [];
  for (const node of json.nodes || []) {
    if (node.mesh === undefined) continue;
    const rgb = NODE_COLORS[node.name];
    if (!rgb) throw new Error(`mesh node with no color entry: ${node.name}`);
    const matIndex = json.materials.length;
    json.materials.push({
      name: `vrctl_${node.name}`,
      pbrMetallicRoughness: {
        baseColorFactor: [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1],
        metallicFactor: 0, roughnessFactor: 1,
      },
    });
    for (const prim of json.meshes[node.mesh].primitives) prim.material = matIndex;
  }
  // Orphaned textured materials/textures/images stay in the json harmlessly;
  // the converter never looks at them once no primitive references them.
  return json;
}

// ---- rest-pose world position of a node (walk parent TRS) ------------------

function nodeWorldPos(json, targetName) {
  const nodes = json.nodes || [];
  const idx = nodes.findIndex((n) => n.name === targetName);
  if (idx < 0) return null;
  const parentOf = new Map();
  nodes.forEach((n, i) => (n.children || []).forEach((c) => parentOf.set(c, i)));
  const chain = [];
  for (let i = idx; i !== undefined; i = parentOf.get(i)) chain.unshift(nodes[i]);
  let pos = [0, 0, 0];
  const rotv = (q, v) => { // rotate v by unit quaternion q=[x,y,z,w]
    const [x, y, z, w] = q;
    const ix = w * v[0] + y * v[2] - z * v[1];
    const iy = w * v[1] + z * v[0] - x * v[2];
    const iz = w * v[2] + x * v[1] - y * v[0];
    const iw = -x * v[0] - y * v[1] - z * v[2];
    return [
      ix * w + iw * -x + iy * -z - iz * -y,
      iy * w + iw * -y + iz * -x - ix * -z,
      iz * w + iw * -z + ix * -y - iy * -x,
    ];
  };
  // Compose root->leaf: world = T1 R1 S1 (T2 R2 S2 (...)) applied to origin.
  // Walking root-first keeps a running frame: pos_world of the leaf origin.
  let frames = [{ t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] }];
  for (const n of chain) {
    frames.push({
      t: n.translation || [0, 0, 0],
      r: n.rotation || [0, 0, 0, 1],
      s: n.scale || [1, 1, 1],
    });
  }
  // Fold from the leaf back to the root: p = T + R*(S*p).
  pos = [0, 0, 0];
  for (let i = frames.length - 1; i >= 0; --i) {
    const f = frames[i];
    pos = [pos[0] * f.s[0], pos[1] * f.s[1], pos[2] * f.s[2]];
    pos = rotv(f.r, pos);
    pos = [pos[0] + f.t[0], pos[1] + f.t[1], pos[2] + f.t[2]];
  }
  return pos.map((v) => Math.round(v * 1e6) / 1e6);
}

// ---- main ------------------------------------------------------------------

let assetsDir = null;
const argIx = process.argv.indexOf('--assets-dir');
if (argIx >= 0) assetsDir = process.argv[argIx + 1];

let tmp = null;
if (!assetsDir) {
  tmp = mkdtempSync(join(tmpdir(), 'vrctl-assets-'));
  const tarball = execFileSync('npm', ['pack', '@webxr-input-profiles/assets', '--pack-destination', tmp],
    { encoding: 'utf8' }).trim().split('\n').pop();
  execFileSync('tar', ['xzf', join(tmp, tarball), '-C', tmp]);
  assetsDir = join(tmp, 'package');
}
const profileDir = join(assetsDir, 'dist', 'profiles', PROFILE);
const profile = JSON.parse(readFileSync(join(profileDir, 'profile.json'), 'utf8'));

const anchors = { profile: profile.profileId, generated: 'scripts/gen-vrctl-models.mjs', left: {}, right: {} };
for (const hand of ['left', 'right']) {
  const glb = parseGlb(readFileSync(join(profileDir, `${hand}.glb`)));
  const layout = profile.layouts[hand];
  for (const [component, nodeName] of Object.entries(ANCHOR_NODES)) {
    if (!layout.components[component]) continue;   // e.g. x/y are left-only
    const pos = nodeWorldPos(glb.json, nodeName);
    if (pos) anchors[hand][component] = { node: nodeName, pos };
    // left declares a 'menu' component but the glb has no such nodes; every
    // resolvable component is covered by ANCHOR_NODES, so a miss here is a
    // package-version change worth failing loudly on.
    else throw new Error(`${hand}: anchor node missing: ${nodeName}`);
  }
  const patched = buildGlb(recolor(glb.json), glb.rest);
  const res = glbToDnm(patched);
  const out = join(repo, 'upstream', 'YSFLIGHT', 'runtime', 'misc', `vrctl_${hand}.dnm`);
  writeFileSync(out, res.dnm);
  console.log(JSON.stringify({ out, nodes: res.nodes, srfs: res.srfs, triangles: res.triangles }));
}
writeFileSync(join(repo, 'specs', 'vrctl-button-anchors.json'), JSON.stringify(anchors, null, 2) + '\n');
console.log('specs/vrctl-button-anchors.json written');
if (tmp) rmSync(tmp, { recursive: true, force: true });
