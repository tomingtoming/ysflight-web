// Aggregate a raw V8 CPU profile (as captured by scripts/profile-vr.mjs)
// into a self-time-by-function table and a category rollup.
//
// Usage:
//   node scripts/profile-report.mjs <in.cpuprofile> [--top N]
//
// Self time per function is computed from the profile's samples[]/
// timeDeltas[] arrays (the same source Chrome DevTools/speedscope use):
// timeDeltas[i] is the sampling interval ending at samples[i], so summing
// timeDeltas[i] into the bucket for node samples[i] gives each node's total
// self time. hitCount (if present) is used only as a fallback for profiles
// that lack samples/timeDeltas.
//
// NOTE on naming: we originally assumed (per the wasm build's --profiling-funcs
// name section) that wasm frames would show up module-prefixed, e.g.
// "ysflight32_gl2.wasm.FunctionName". In practice V8's CPU profiler does NOT
// do that -- callFrame.functionName is the bare C++/demangled name (e.g.
// "FsSimulation::SimDrawScreen(...)", "cos"), and the module is only
// identifiable via callFrame.url (the .wasm file's URL). So instead of
// string-prefix-stripping, we classify each node's ORIGIN from url/scriptId:
//   - url ends in ".wasm"            -> a wasm/C++ frame (this binary)
//   - name is (program)/(idle)/(root) or (garbage collector) -> V8 special frames
//   - anything else (url is empty [native Blink/V8 builtin, e.g. WebGL entry
//     points like getParameter], url ends in ".js" [the emscripten JS glue],
//     or name is "wasm-to-js"/"imports.<computed>" [V8's wasm<->JS call
//     trampolines]) -> bucketed as one "JS frames" category, matching the
//     brief's "JS frames (no wasm prefix)" bucket.
// This turned out to matter a lot: naive name-prefix matching missed
// getParameter, enableVertexAttribArray/disableVertexAttribArray, bufferSubData,
// texParameteri etc. entirely (they'd fall into "everything-else"), and
// getParameter alone can dominate the profile -- see the report writeup.
import fs from 'node:fs';

const args = process.argv.slice(2);
const topIdx = args.indexOf('--top');
const top = topIdx !== -1 ? Number(args[topIdx + 1]) : 40;
const positional = args.filter((a, i) => i !== topIdx && i !== topIdx + 1);
const [inFile] = positional;
if (!inFile) {
  console.error('usage: node scripts/profile-report.mjs <in.cpuprofile> [--top N]');
  process.exit(2);
}

const profile = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const nodesById = new Map();
for (const n of profile.nodes) nodesById.set(n.id, n);

// --- self time (microseconds) per node id -----------------------------------
const selfUsById = new Map();
if (Array.isArray(profile.samples) && Array.isArray(profile.timeDeltas) && profile.samples.length) {
  const n = profile.samples.length;
  for (let i = 0; i < n; ++i) {
    const nodeId = profile.samples[i];
    // timeDeltas[i] is the interval ending at sample i (V8/speedscope convention).
    const dt = profile.timeDeltas[i] || 0;
    if (dt <= 0) continue;
    selfUsById.set(nodeId, (selfUsById.get(nodeId) || 0) + dt);
  }
} else {
  // Fallback: hitCount as a relative weight in "hits" units (interval isn't
  // stored in-file, so absolute ms isn't recoverable from hitCount alone).
  for (const n of profile.nodes) {
    if (n.hitCount) selfUsById.set(n.id, (selfUsById.get(n.id) || 0) + n.hitCount);
  }
}

const totalUs = [...selfUsById.values()].reduce((a, b) => a + b, 0);
const totalMs = totalUs / 1000;

function nodeName(callFrame) {
  return callFrame.functionName && callFrame.functionName.length ? callFrame.functionName : '(anonymous)';
}

// --- merge self time by function name (across nodes / call sites) -----------
const selfMsByName = new Map();
for (const [nodeId, us] of selfUsById) {
  const node = nodesById.get(nodeId);
  if (!node) continue;
  const name = nodeName(node.callFrame);
  selfMsByName.set(name, (selfMsByName.get(name) || 0) + us / 1000);
}

const rows = [...selfMsByName.entries()]
  .map(([name, ms]) => ({ name, ms, pct: totalMs ? (ms / totalMs) * 100 : 0 }))
  .sort((a, b) => b.ms - a.ms);

console.log(`Total sampled: ${totalMs.toFixed(1)} ms across ${profile.samples ? profile.samples.length : '?'} samples`);
console.log();
console.log(`Top ${top} functions by self time:`);
console.log('  ms      %     name');
for (const r of rows.slice(0, top)) {
  console.log(`  ${r.ms.toFixed(2).padStart(8)} ${r.pct.toFixed(1).padStart(5)}%  ${r.name}`);
}

// --- category rollup ---------------------------------------------------------
// Edit this list to iterate on the taxonomy. `classify(name, url)` decides
// ORIGIN first (wasm frame vs. everything else -- see the big comment up
// top for why url, not name-prefix, is the reliable signal), then applies
// the C++-side sub-patterns only to wasm frames. First matching pattern
// wins; unmatched wasm names fall into "everything-else".
const WASM_SUBCATEGORIES = [
  { label: '__asyncify_* (ASYNCIFY overhead)', re: /^__asyncify_/ },
  { label: 'memcpy/memset/malloc/free/dlmalloc', re: /^(memcpy|memset|memmove|malloc|free|calloc|realloc|dlmalloc|sbrk)$/ },
  { label: 'YsGL* / ysgl (fixed-function GL emulation)', re: /^YsGL/i },
  { label: 'YsScenery* / FsField / terrain', re: /^(YsScenery|FsField)/ },
  { label: 'FsAircraft / FsAirplane / dnm draw', re: /^(FsAircraft|FsAirplane)/ },
  { label: 'FsAircraft / FsAirplane / dnm draw', re: /Dnm.*Draw|DrawDnm/ },
  { label: 'YsShell / geometry', re: /^YsShell/ },
  { label: 'FsSimulation Move/simulate', re: /^FsSimulation/ },
  { label: 'FsSimulation Move/simulate', re: /::Move\(|Simulate/ },
  { label: 'HUD (FsHud / SimDrawHud)', re: /^FsHud|SimDrawHud/ },
];

function classify(name, url) {
  if (name === '(garbage collector)') return 'GC (garbage collector)';
  if (name === '(program)' || name === '(idle)' || name === '(root)') return '(program)/(idle)/unaccounted';
  const isWasm = /\.wasm(\?|$)/.test(url || '');
  if (!isWasm) {
    // Native Blink/V8 WebGL entry points (empty url, e.g. getParameter,
    // enableVertexAttribArray), the emscripten .js glue (imports.<computed>),
    // and V8's wasm<->JS call trampolines (wasm-to-js) all land here.
    return 'JS frames (WebGL calls, GL glue, wasm<->JS trampoline)';
  }
  for (const c of WASM_SUBCATEGORIES) {
    if (c.re.test(name)) return c.label;
  }
  return 'everything-else';
}

const catMs = new Map();
for (const [nodeId, us] of selfUsById) {
  const node = nodesById.get(nodeId);
  if (!node) continue;
  const name = nodeName(node.callFrame);
  const url = node.callFrame.url;
  const label = classify(name, url);
  catMs.set(label, (catMs.get(label) || 0) + us / 1000);
}

console.log();
console.log('Category rollup:');
console.log('  ms      %     category');
const catRows = [...catMs.entries()].sort((a, b) => b[1] - a[1]);
for (const [label, ms] of catRows) {
  const pct = totalMs ? (ms / totalMs) * 100 : 0;
  console.log(`  ${ms.toFixed(2).padStart(8)} ${pct.toFixed(1).padStart(5)}%  ${label}`);
}
