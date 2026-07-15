// DNM -> glTF (.glb) CLI: opens YSFLIGHT aircraft in Blender.
//   node scripts/dnm2gltf.mjs <input.dnm> <output.glb> [--spec <spec.json>]
// Thin wrapper — the conversion lives in web/dnm-gltf.js (browser-safe), which
// the workbench also uses directly.  See that module for the full mapping notes
// (hierarchy, engine-exact transforms, extras.ysflight, per-class animations,
// and the chirality note: the glb is right-handed, so Blender shows the model
// the way the engine does, not its mirror image).
//
// --spec reads the aircraft-compiler spec's optional `cockpit: {x, y, zn}`
// (zn = meters from the nose tip, the spec-wide convention) and embeds a
// "Cockpit" glTF camera node — the studio's glb import turns it back into the
// recipe's cockpit position and, from there, the .dat COCKPITP line.  This is
// how a spec's cockpit reaches the engine: the compiler itself only emits
// geometry (DNM), never a .dat.

import { readFileSync, writeFileSync } from 'node:fs';
import { dnmToGlb } from '../web/dnm-gltf.js';

const args = process.argv.slice(2);
const specIx = args.indexOf('--spec');
const specPath = specIx >= 0 ? args.splice(specIx, 2)[1] : null;
const [inPath, outPath] = args;
if (!inPath || !outPath) {
  console.error('usage: node scripts/dnm2gltf.mjs <input.dnm> <output.glb> [--spec <spec.json>]');
  process.exit(2);
}
let cockpit;
if (specPath) {
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  if (spec.cockpit && [spec.cockpit.x, spec.cockpit.y, spec.cockpit.zn].every(Number.isFinite)) {
    // zn (nose station) -> YS z, the same conversion the compiler uses.
    cockpit = { x: spec.cockpit.x, y: spec.cockpit.y, z: spec.length / 2 - spec.cockpit.zn };
  }
}
const res = dnmToGlb(readFileSync(inPath), cockpit ? { cockpit } : undefined);
writeFileSync(outPath, res.glb);
console.log(JSON.stringify({
  out: outPath, nodes: res.nodes, meshes: res.meshes,
  materials: res.materials, animations: res.animations, bytes: res.glb.length,
  ...(cockpit ? { cockpit } : {}),
}));
