// DNM -> glTF (.glb) CLI: opens YSFLIGHT aircraft in Blender.
//   node scripts/dnm2gltf.mjs <input.dnm> <output.glb>
// Thin wrapper — the conversion lives in web/dnm-gltf.js (browser-safe), which
// the workbench also uses directly.  See that module for the full mapping notes
// (hierarchy, engine-exact transforms, extras.ysflight, per-class animations).

import { readFileSync, writeFileSync } from 'node:fs';
import { dnmToGlb } from '../web/dnm-gltf.js';

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error('usage: node scripts/dnm2gltf.mjs <input.dnm> <output.glb>');
  process.exit(2);
}
const res = dnmToGlb(readFileSync(inPath));
writeFileSync(outPath, res.glb);
console.log(JSON.stringify({
  out: outPath, nodes: res.nodes, meshes: res.meshes,
  materials: res.materials, animations: res.animations, bytes: res.glb.length,
}));
