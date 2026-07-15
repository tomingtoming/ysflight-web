// glTF (.glb) -> DNM CLI: bring Blender-edited models back into YSFLIGHT.
//   node scripts/gltf2dnm.mjs <input.glb> <output.dnm>
// Thin wrapper — the conversion lives in web/dnm-gltf.js (browser-safe), which
// the workbench also uses directly.  extras.ysflight (Blender custom
// properties; check Include > Data > Custom Properties on export) restores
// CLA/POS/STA/CNT verbatim; fresh Blender-made nodes become static parts.
// Handedness is detected per file (rh marker / legacy / foreign) — see the
// CHIRALITY note in web/dnm-gltf.js.

import { readFileSync, writeFileSync } from 'node:fs';
import { glbToDnm } from '../web/dnm-gltf.js';

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error('usage: node scripts/gltf2dnm.mjs <input.glb> <output.dnm>');
  process.exit(2);
}
const res = glbToDnm(readFileSync(inPath));
writeFileSync(outPath, res.dnm);
console.log(JSON.stringify({ out: outPath, nodes: res.nodes, srfs: res.srfs, triangles: res.triangles }));
