// Build-time: stage the stock aircraft .dat files + an identity index into
// dist/stock/ so the engine-less workbench page (workbench.html) can offer
// "make a .dat from a stock base" without loading the wasm preload.
//
//   node scripts/gen-stock-index.mjs <runtimeDir> <outDir>
//
// Reads aircraft/air*.lst exactly like the engine's glob, copies each listed
// .dat, and emits index.json [{identify, category, file}] (ASCII identities
// only — same parseDatIdentity the importer uses).
import { readdirSync, readFileSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';

import { parseDatIdentity } from '../web/packs.js';

const [runtimeDir, outDir] = process.argv.slice(2);
if (!runtimeDir || !outDir) {
  console.error('usage: gen-stock-index.mjs <runtimeDir> <outDir>');
  process.exit(1);
}

mkdirSync(join(outDir, 'aircraft'), { recursive: true });
const index = [];
const seen = new Set();
// .lst line: <dat> <visual dnm> <collision srf> [<cockpit srf> [<coarse dnm>]]
// — every token is a file; staging them all lets the workbench build a complete
// aircraft with ZERO user files (stock visuals + a wizard-made .dat).
const SLOTS = ['file', 'visual', 'collision', 'cockpit', 'coarse'];
for (const lst of readdirSync(join(runtimeDir, 'aircraft'))) {
  if (!/^air.*\.lst$/i.test(lst)) continue;
  const text = readFileSync(join(runtimeDir, 'aircraft', lst), 'latin1');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('REM ')) continue;
    const tokens = line.match(/"[^"]*"|\S+/g)?.map((t) => t.replace(/^"|"$/g, '')) || [];
    if (!tokens[0] || !/\.dat$/i.test(tokens[0])) continue;
    let idn;
    try { idn = parseDatIdentity(readFileSync(join(runtimeDir, tokens[0]))); } catch { continue; }
    if (!idn || seen.has(idn.identify)) continue;
    seen.add(idn.identify);
    const entry = { identify: idn.identify, category: idn.category };
    for (let i = 0; i < SLOTS.length && i < tokens.length; i++) {
      if (!tokens[i]) continue;
      const rel = 'aircraft/' + basename(tokens[i]);
      try {
        copyFileSync(join(runtimeDir, tokens[i]), join(outDir, rel));
        entry[SLOTS[i]] = rel;
      } catch { /* referenced file missing from runtime — skip the slot */ }
    }
    if (!entry.file || !entry.visual || !entry.collision) continue; // engine minimum
    index.push(entry);
  }
}
index.sort((a, b) => (a.identify < b.identify ? -1 : 1));
writeFileSync(join(outDir, 'index.json'), JSON.stringify(index));
console.log('stock index: ' + index.length + ' aircraft -> ' + outDir);
