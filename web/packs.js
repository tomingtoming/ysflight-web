// Add-on pack engine for ysflight-web.  Pure ESM with NO DOM/Emscripten
// coupling: every filesystem touch goes through an injected adapter, so the
// exact same code runs in the browser (over Module.FS / IDBFS) and in node
// tests (over a temp directory).  See docs/addon-packs.md for the full design.
//
// What installPack() does:
//   1. unzip the archive (fflate, synchronous)
//   2. drop archive cruft (__MACOSX, .DS_Store, AppleDouble ._*, dir entries)
//   3. find the lists YSFLIGHT actually scans: aircraft/air*.lst,
//      scenery/sce*.lst, ground/gro*.lst (engine: fsworld.cpp Load*TemplateList)
//   4. content-hash the payload -> a stable, collision-free pack id
//   5. stage every payload file under packs/<id>/ (isolated, so two packs that
//      ship a file of the same name never clobber each other) and commit it
//      atomically (staging dir -> rename)
//   6. regenerate each list as <dir>/<prefix><id>.lst whose entries point at
//      packs/<id>/..., resolving the original references case-INsensitively
//      (real community packs say "User/foo" while shipping "user/foo") and
//      writing clean LF — so the engine's glob scan picks them up verbatim
//   7. record the install in packs/index.json
//
// The adapter is the YSFLIGHT *user dir* root; all paths here are relative to
// it (the browser adapter prepends /home/web_user/Documents/YSFLIGHT.COM/
// YSFLIGHT, the node adapter prepends a temp dir).  The generated list entries
// are likewise relative to that root, which is exactly how the engine resolves
// them (MakeFullPathName(userYsflightDir, entry)).
//
// Out of scope here (later milestones): the pre-boot UI + run-dependency gate
// (M2), enable/disable + uninstall (M3), Shift-JIS transcoding of legacy packs
// (v1.5), multiplayer host->client distribution (v2).
//
// Adapter interface (all async):
//   exists(path)            -> boolean
//   mkdirp(path)            -> create dir and parents
//   writeFile(path, bytes)  -> write a Uint8Array (creates parent dirs)
//   readFile(path)          -> Uint8Array
//   rename(from, to)        -> move (creates dest parent)
//   rmrf(path)              -> recursive remove, no error if absent

import { unzipSync, unzipEachAsync } from './vendor/fflate.js';

// The three list globs YSFLIGHT scans from each root, and how each list's lines
// are shaped.  'files' = every token is a file path (aircraft, ground).
// 'field' = "IDENT <paths...> [MODE]" (scenery), so the first token is an
// identifier and a trailing bareword may be a flight mode, not a file.
const CATEGORIES = [
  { key: 'aircraft', dir: 'aircraft', prefix: 'air', kind: 'files' },
  { key: 'ground', dir: 'ground', prefix: 'gro', kind: 'files' },
  { key: 'scenery', dir: 'scenery', prefix: 'sce', kind: 'field' },
];

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: false });
const strToBytes = (s) => enc.encode(s);
const strFromBytes = (b) => dec.decode(b);

const INDEX_PATH = 'packs/index.json';

async function loadIndex(fs) {
  if (await fs.exists(INDEX_PATH)) {
    try {
      const parsed = JSON.parse(strFromBytes(await fs.readFile(INDEX_PATH)));
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      /* corrupt index -> treat as empty */
    }
  }
  return [];
}

async function saveIndex(fs, index) {
  await fs.mkdirp('packs');
  await fs.writeFile(INDEX_PATH, strToBytes(JSON.stringify(index, null, 2)));
}

// The generated list file for one category of a pack, and its disabled twin.
// The engine globs <prefix>*.lst, so the .off suffix removes it from the scan.
function listFilesForCategory(id, categoryKey) {
  const c = CATEGORIES.find((x) => x.key === categoryKey);
  if (!c) return null;
  const base = `${c.dir}/${c.prefix}${id}.lst`;
  return { on: base, off: base + '.off' };
}

const listRe = (c) => new RegExp(`^${c.dir}/${c.prefix}[^/]*\\.lst$`, 'i');
// A YSFLIGHT list by FILENAME (air*/sce*/gro*.lst), regardless of directory --
// real packs put lists in aircraft/scenery/ground/, but also in air/, User/doc/,
// or the wrapper root.  Used to keep a candidate list's bytes during streaming
// (before the re-root is chosen) and to detect lists in non-standard locations.
const listFnameRe = /^(air|sce|gro)[^/]*\.lst$/i;
const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);

function join(...parts) {
  return parts.filter((p) => p !== '' && p != null).join('/').replace(/\/{2,}/g, '/');
}
function parentDir(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

// Normalize a path read out of the archive or a list entry: backslashes to
// slashes, strip a leading "./" and any leading slashes.
function normPath(p) {
  return String(p).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

// Things we must never write to the FS.
function isCruft(rawPath) {
  if (rawPath.endsWith('/')) return true; // directory entry
  const parts = rawPath.replace(/\\/g, '/').split('/');
  if (parts.includes('__MACOSX')) return true; // mac zip resource-fork sidecar
  const base = parts[parts.length - 1];
  if (base === '.DS_Store' || base === 'Thumbs.db' || base === 'desktop.ini') return true;
  if (base.startsWith('._')) return true; // AppleDouble
  return false;
}

// Tokenize a list line honouring double-quoted segments (scenery paths can be
// quoted and contain spaces).
function tokenize(line) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const quoted = m[1] !== undefined;
    out.push({ value: quoted ? m[1] : m[2], quoted });
  }
  return out;
}

// Emit a path token, quoting only if it contains whitespace.
function emitPath(p) {
  return /\s/.test(p) ? `"${p}"` : p;
}

// Build a case-insensitive resolver from a referenced path to the actual
// (real-case) payload path, or null if the pack doesn't contain it.
function buildResolver(files) {
  const byLower = new Map();
  for (const f of files) byLower.set(f.path.toLowerCase(), f.path);
  return (ref) => byLower.get(normPath(ref).toLowerCase()) || null;
}

// aircraft / ground: every token is a file path.
function rewriteFilesLine(line, resolve, prefixDir) {
  const toks = tokenize(line);
  if (toks.length === 0) return null;
  let resolved = 0;
  let missing = 0;
  const parts = toks.map((t) => {
    const actual = resolve(t.value);
    if (actual) {
      resolved++;
      return emitPath(`${prefixDir}/${actual}`);
    }
    missing++;
    return emitPath(t.value); // keep; engine logs "Cannot Load" and skips
  });
  return { line: parts.join(' '), tokens: toks.length, resolved, missing };
}

// scenery: "IDENT <fld> <stp> [<yfs>|""] [MODE]".  Keep the identifier and any
// trailing mode bareword; rewrite the path-looking tokens.
function rewriteFieldLine(line, resolve, prefixDir) {
  const toks = tokenize(line);
  if (toks.length === 0) return null;
  const parts = [toks[0].quoted ? `"${toks[0].value}"` : toks[0].value]; // IDENT
  let resolved = 0;
  let missing = 0;
  for (let i = 1; i < toks.length; i++) {
    const v = toks[i].value;
    if (v === '') {
      parts.push('""');
      continue;
    }
    const looksPath = /[\\/]/.test(v) || /\.(fld|stp|yfs)$/i.test(v);
    if (!looksPath) {
      parts.push(v); // flight-mode keyword (e.g. AIRRACE)
      continue;
    }
    const actual = resolve(v);
    if (actual) {
      resolved++;
      parts.push(`"${prefixDir}/${actual}"`);
    } else {
      missing++;
      parts.push(`"${v}"`);
    }
  }
  return { line: parts.join(' '), tokens: toks.length, resolved, missing };
}

// Unzip and return the usable payload files (cruft removed).
export function readArchive(zipBytes) {
  const buf = zipBytes instanceof Uint8Array ? zipBytes : new Uint8Array(zipBytes);
  const raw = unzipSync(buf);
  const files = [];
  for (const rawPath of Object.keys(raw)) {
    if (isCruft(rawPath)) continue;
    const path = normPath(rawPath);
    if (!path || path.endsWith('/')) continue;
    files.push({ path, bytes: raw[rawPath] });
  }
  return files;
}

// Locate the list files the engine scans (or that we can re-root to one), with
// their decoded text.  STANDARD lists live in aircraft/scenery/ground/ (std:true,
// trusted as-is); packs also ship lists elsewhere (air/, User/doc/, the wrapper
// root), detected by the air*/sce*/gro*.lst filename (std:false) and gated on
// reference resolution by the caller so a mislaid/dependency pack is not accepted.
export function findLists(files) {
  const lists = [];
  for (const f of files) {
    let category = null, std = false;
    for (const c of CATEGORIES) if (listRe(c).test(f.path)) { category = c; std = true; break; }
    if (!category) {
      const base = baseOf(f.path);
      if (listFnameRe.test(base)) for (const c of CATEGORIES) if (base.toLowerCase().startsWith(c.prefix)) { category = c; break; }
    }
    if (category) lists.push({ category, std, path: f.path, text: strFromBytes(f.bytes) });
  }
  return lists;
}

// Derive a human-ish name from the first list file ("aircraft/air_toming.lst"
// -> "toming"), falling back to "pack".
function deriveName(lists) {
  if (lists.length === 0) return 'pack';
  const base = lists[0].path.split('/').pop().replace(/\.lst$/i, '');
  const stripped = base.replace(new RegExp(`^${lists[0].category.prefix}`, 'i'), '').replace(/^[_-]+/, '');
  return stripped || base || 'pack';
}

// Turn the located lists into the regenerated, path-rewritten lists we will
// drop into the scanned dirs.  Returns [{category, file, text, entries}].
function buildGeneratedLists(lists, resolve, id) {
  const prefixDir = `packs/${id}`;
  const generated = [];
  for (const c of CATEGORIES) {
    const catLists = lists.filter((l) => l.category.key === c.key);
    if (catLists.length === 0) continue;
    const outLines = [];
    for (const l of catLists) {
      for (const rawLine of l.text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith('REM ')) continue;
        const rw = c.kind === 'field'
          ? rewriteFieldLine(line, resolve, prefixDir)
          : rewriteFilesLine(line, resolve, prefixDir);
        // YSFLIGHT requires >= 3 tokens per usable entry; skip anything shorter.
        if (!rw || rw.tokens < 3) continue;
        outLines.push(rw.line);
      }
    }
    if (outLines.length === 0) continue;
    generated.push({
      category: c.key,
      file: `${c.dir}/${c.prefix}${id}.lst`,
      text: outLines.join('\n') + '\n',
      entries: outLines.length,
    });
  }
  return generated;
}

// Re-root candidates: the original layout plus each level of a SINGLE common
// wrapper directory peeled off (real packs are zipped inside one, sometimes
// nested, wrapper dir).  Stops at a multi-folder level or a category dir (never
// peels aircraft/scenery/ground/).  `paths` must exclude archive cruft.
function candidatePrefixes(paths) {
  const out = [''];
  let prefix = '', cur = paths;
  for (let depth = 0; depth < 8; depth++) {
    const tops = new Set(cur.map((p) => { const i = p.indexOf('/'); return i < 0 ? '' : p.slice(0, i); }));
    if (tops.size !== 1 || tops.has('')) break;
    const top = [...tops][0];
    if (CATEGORIES.some((c) => c.dir.toLowerCase() === top.toLowerCase())) break;
    prefix += top + '/';
    cur = cur.map((p) => p.slice(top.length + 1));
    out.push(prefix);
  }
  return out;
}

// How many of a candidate layout's list references actually exist in the archive
// (id-independent).  A pack whose references don't resolve would "install" broken.
function listResolution(lists, files) {
  const resolve = buildResolver(files);
  let refs = 0, res = 0;
  for (const l of lists) {
    for (const rawLine of l.text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith('REM ')) continue;
      const rw = l.category.kind === 'field'
        ? rewriteFieldLine(line, resolve, '')
        : rewriteFilesLine(line, resolve, '');
      if (!rw || rw.tokens < 3) continue;
      refs += rw.resolved + rw.missing;
      res += rw.resolved;
    }
  }
  return { refs, rate: refs ? res / refs : 0 };
}

// Pick the re-rooting that exposes a usable YSFLIGHT list.  A STANDARD list (in a
// category dir) is trusted as-is -- preserving the historical behaviour for the
// packs that already install.  A list found only by FILENAME (non-standard
// location) is accepted only when its references resolve (>= 50%), so a missing-
// dependency or mislaid pack is rejected rather than installed broken.  Returns
// { prefix, files, lists } or null.  `files` is [{path, bytes?}] (bytes only read
// for the list files themselves).
function chooseLayout(files) {
  let best = null;
  for (const prefix of candidatePrefixes(files.map((f) => f.path))) {
    const rf = prefix ? files.map((f) => ({ path: f.path.slice(prefix.length), bytes: f.bytes })) : files;
    const lists = findLists(rf);
    if (lists.length === 0) continue;
    const std = lists.some((l) => l.std);
    const rate = listResolution(lists, rf).rate;
    if (!(std || rate >= 0.5)) continue;
    const score = (std ? 2 : 0) + rate;
    if (!best || score > best.score) best = { prefix, files: rf, lists, score };
  }
  return best;
}

// Analyze a pack archive WITHOUT touching any filesystem: unzip, validate,
// content-hash every file, derive the (Merkle-ish) pack id, and build the
// regenerated lists.  This is the pure core shared by installPack (writes the
// payload into the engine FS) and the OPFS content-addressed store
// (web/opfs-store.js, which stages payload as blobs keyed by sha256 and
// materializes on demand).
//   returns { id, name, categories, total, files:[{path,bytes}],
//     hashed:[{path,size,sha256}], generated:[{category,file,text,entries}],
//     manifest, source, now }
export async function analyzePack(zipBytes, opts) {
  const {
    sha256,
    name,
    source = 'user-supplied',
    sourceUrl,
    now = Date.now(),
    maxFileBytes = 64 * 1024 * 1024,
    maxPackBytes = 256 * 1024 * 1024,
  } = opts;
  if (!sha256) throw new Error('analyzePack requires { sha256 }');

  const rawFiles = readArchive(zipBytes);
  if (rawFiles.length === 0) throw new Error('pack is empty (no files after removing archive cruft)');

  // Choose the re-rooting that exposes a usable list (wrapper folders + non-standard
  // list locations), rejecting packs whose references don't resolve.
  const layout = chooseLayout(rawFiles);
  if (!layout) {
    throw new Error('no YSFLIGHT list found (expected aircraft/air*.lst, scenery/sce*.lst, or ground/gro*.lst)');
  }
  const files = layout.files;
  const lists = layout.lists;

  // Reject path traversal and enforce size limits before any storage.
  let total = 0;
  for (const f of files) {
    if (f.path.split('/').includes('..')) throw new Error(`unsafe path in pack: ${f.path}`);
    if (f.bytes.length > maxFileBytes) throw new Error(`file exceeds ${maxFileBytes} bytes: ${f.path}`);
    total += f.bytes.length;
  }
  if (total > maxPackBytes) throw new Error(`pack exceeds ${maxPackBytes} bytes (${total})`);

  // Per-file hashes (sorted) -> a stable Merkle-ish pack id.
  const hashed = [];
  for (const f of files) hashed.push({ path: f.path, size: f.bytes.length, sha256: await sha256(f.bytes) });
  hashed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const idDigest = await sha256(strToBytes(hashed.map((h) => `${h.path}\0${h.sha256}`).join('\n')));
  const id = idDigest.slice(0, 16);

  const resolve = buildResolver(files);
  const generated = buildGeneratedLists(lists, resolve, id);
  if (generated.length === 0) throw new Error('pack lists contained no usable entries');

  const packName = name || deriveName(lists);
  const manifest = {
    schema: 1,
    id,
    name: packName,
    source,
    installedAt: now,
    categories: generated.map((g) => g.category),
    bytes: total,
    files: hashed,
    lists: generated.map((g) => ({ category: g.category, file: g.file, entries: g.entries })),
  };
  // Remember where a pack came from so a HOST can re-advertise that URL and let
  // joiners self-fetch it (Option B) instead of pulling the bytes P2P.  Kept out
  // of the pack-id hash: the id is computed over the archive files only.
  if (sourceUrl) manifest.sourceUrl = sourceUrl;

  return { id, name: packName, categories: manifest.categories, total, files, hashed, generated, manifest, source, now };
}

// Streaming analyze: decompress + hash + persist ONE file at a time so the whole
// decompressed archive is never held in memory (the fix for the install-time
// memory peak on the largest packs).  `putBlob(sha256hex, bytes)` is injected by
// the OPFS store and persists each file's content-addressed blob; this keeps only
// per-file metadata + the tiny .lst contents.  Produces the SAME id, blobs, and
// generated lists as analyzePack (verified), so a pack is identical either way.
// Returns the analyzePack shape minus the in-memory `files` bytes.
export async function analyzePackStreaming(zipBytes, opts) {
  const {
    sha256,
    putBlob,
    name,
    source = 'user-supplied',
    sourceUrl,
    now = Date.now(),
    maxFileBytes = 64 * 1024 * 1024,
    maxPackBytes = 256 * 1024 * 1024,
  } = opts;
  if (!sha256 || !putBlob) throw new Error('analyzePackStreaming requires { sha256, putBlob }');
  const buf = zipBytes instanceof Uint8Array ? zipBytes : new Uint8Array(zipBytes);

  const hashed = [];          // {path, size, sha256} for every payload file
  const listEntries = [];     // {path, bytes} for the .lst files only (kept for list generation)
  let total = 0;
  await unzipEachAsync(buf, async (rawPath, bytes) => {
    if (isCruft(rawPath)) return;
    const path = normPath(rawPath);
    if (!path || path.endsWith('/')) return;
    if (path.split('/').includes('..')) throw new Error(`unsafe path in pack: ${path}`);
    if (bytes.length > maxFileBytes) throw new Error(`file exceeds ${maxFileBytes} bytes: ${path}`);
    total += bytes.length;
    if (total > maxPackBytes) throw new Error(`pack exceeds ${maxPackBytes} bytes (${total})`);
    const sha = await sha256(bytes);
    await putBlob(sha, bytes);                 // persist content-addressed; bytes freed after this entry
    hashed.push({ path, size: bytes.length, sha256: sha });
    if (listFnameRe.test(baseOf(path))) listEntries.push({ path, bytes }); // keep any list by filename (pre-reroot)
  });
  if (hashed.length === 0) throw new Error('pack is empty (no files after removing archive cruft)');

  // Choose the re-rooting (wrapper folders + non-standard list locations).  Blobs
  // are already stored content-addressed by hash, so only the path metadata is
  // rewritten.  chooseLayout reads list bytes only, so non-list files pass {path}.
  const leByPath = new Map(listEntries.map((e) => [e.path, e.bytes]));
  const layout = chooseLayout(hashed.map((h) => ({ path: h.path, bytes: leByPath.get(h.path) })));
  if (!layout) {
    throw new Error('no YSFLIGHT list found (expected aircraft/air*.lst, scenery/sce*.lst, or ground/gro*.lst)');
  }
  if (layout.prefix) for (const h of hashed) h.path = h.path.slice(layout.prefix.length);
  const lists = layout.lists;
  hashed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const id = (await sha256(strToBytes(hashed.map((h) => `${h.path}\0${h.sha256}`).join('\n')))).slice(0, 16);

  const resolve = buildResolver(hashed); // buildResolver only reads .path
  const generated = buildGeneratedLists(lists, resolve, id);
  if (generated.length === 0) throw new Error('pack lists contained no usable entries');

  const packName = name || deriveName(lists);
  const manifest = {
    schema: 1, id, name: packName, source, installedAt: now,
    categories: generated.map((g) => g.category), bytes: total, files: hashed,
    lists: generated.map((g) => ({ category: g.category, file: g.file, entries: g.entries })),
  };
  if (sourceUrl) manifest.sourceUrl = sourceUrl;

  return { id, name: packName, categories: manifest.categories, total, hashed, generated, manifest, source, now };
}

// Install a pack archive into the user dir via the adapter.  Idempotent:
// re-installing the same bytes reuses the existing payload and just refreshes
// the generated lists + index entry.
export async function installPack(zipBytes, opts) {
  const { fs } = opts;
  if (!fs || !opts.sha256) throw new Error('installPack requires { fs, sha256 }');

  const { id, name: packName, total, files, generated, manifest, source, now } = await analyzePack(zipBytes, opts);

  // Stage the payload (+ manifest) and commit it atomically, unless an
  // identical pack id is already present.
  const packRoot = `packs/${id}`;
  if (!(await fs.exists(packRoot))) {
    const staging = `packs/.staging-${id}`;
    await fs.rmrf(staging);
    for (const f of files) {
      const dest = join(staging, f.path);
      await fs.mkdirp(parentDir(dest));
      await fs.writeFile(dest, f.bytes);
    }
    await fs.writeFile(join(staging, 'manifest.json'), strToBytes(JSON.stringify(manifest, null, 2)));
    await fs.mkdirp('packs');
    await fs.rename(staging, packRoot);
  }

  // Drop the regenerated lists into the scanned dirs (this is what the engine
  // globs).  Done after the payload commit so a live list never points at a
  // half-written pack.
  for (const g of generated) {
    await fs.mkdirp(parentDir(g.file));
    await fs.writeFile(g.file, strToBytes(g.text));
  }

  // Update the installed-packs index.
  const index = (await loadIndex(fs)).filter((e) => e && e.id !== id);
  index.push({
    id,
    name: packName,
    enabled: true,
    bytes: total,
    categories: manifest.categories,
    source,
    installedAt: now,
  });
  await saveIndex(fs, index);

  return {
    id,
    name: packName,
    categories: manifest.categories,
    bytes: total,
    templates: generated.reduce((n, g) => n + g.entries, 0),
    lists: generated.map((g) => g.file),
  };
}

// Enable or disable an installed pack by renaming its generated lists between
// <prefix><id>.lst and <prefix><id>.lst.off.  The engine globs <prefix>*.lst,
// so the .off suffix takes the pack out of the scan.  Updates index.json.
export async function setEnabled(id, enabled, opts) {
  const { fs } = opts || {};
  if (!fs) throw new Error('setEnabled requires { fs }');
  const index = await loadIndex(fs);
  const entry = index.find((e) => e.id === id);
  if (!entry) throw new Error('pack not installed: ' + id);
  for (const cat of entry.categories || []) {
    const lf = listFilesForCategory(id, cat);
    if (!lf) continue;
    const from = enabled ? lf.off : lf.on;
    const to = enabled ? lf.on : lf.off;
    if (await fs.exists(from)) await fs.rename(from, to);
  }
  entry.enabled = !!enabled;
  await saveIndex(fs, index);
  return { id, enabled: !!enabled };
}

// Remove an installed pack: its isolated payload (packs/<id>/), its generated
// lists (.lst and .lst.off across categories), and its index entry.
export async function uninstall(id, opts) {
  const { fs } = opts || {};
  if (!fs) throw new Error('uninstall requires { fs }');
  const index = await loadIndex(fs);
  const entry = index.find((e) => e.id === id);
  const cats = entry && entry.categories ? entry.categories : CATEGORIES.map((c) => c.key);
  for (const cat of cats) {
    const lf = listFilesForCategory(id, cat);
    if (!lf) continue;
    for (const f of [lf.on, lf.off]) if (await fs.exists(f)) await fs.rmrf(f);
  }
  if (await fs.exists(`packs/${id}`)) await fs.rmrf(`packs/${id}`);
  await saveIndex(fs, index.filter((e) => e.id !== id));
  return { id, removed: true };
}

// Exposed for unit tests; not part of the public surface.
export const _internals = {
  CATEGORIES,
  normPath,
  isCruft,
  tokenize,
  buildResolver,
  rewriteFilesLine,
  rewriteFieldLine,
  findLists,
  deriveName,
  buildGeneratedLists,
  candidatePrefixes,
  chooseLayout,
  listResolution,
};
