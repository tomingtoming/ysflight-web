// Content-addressed add-on-pack store over OPFS (Origin Private File System).
//
// Pack PAYLOAD (the big .dnm/.srf/.dat files) is stored here as content-addressed
// blobs keyed by sha256, NOT in the IDBFS-backed engine FS:
//   - OPFS lives on disk (not the JS heap) with a large quota, so GB packs fit
//     without the IDBFS whole-tree syncfs cost or MEMFS memory pressure.
//   - Files shared across packs are stored once (dedup) -- YSFLIGHT packs reuse
//     models heavily (repaints share geometry; collections bundle aircraft that
//     also ship individually).
//   - It is the substrate for the planned P2P file-level delta transfer: a joiner
//     pulls only the blob hashes it lacks (pure-pipe distribution, no hosting).
//
// OPFS layout:
//   blob/<aa>/<sha256>   content-addressed file payload  (aa = first 2 hex chars)
//   packs/<id>.json      pack record: manifest + enabled flag + generated lists
//
// The engine reads files by PATH from its MEMFS user dir, so an installed pack is
// MATERIALIZED (copied) from blobs into the engine FS at the paths its .lst files
// reference -- the "git checkout" step.  The OPFS blobs are the durable store; the
// MEMFS copy is ephemeral and regenerated each boot, so packs never bloat IDBFS.
//
// Browser-only (needs navigator.storage.getDirectory + a secure context).  Pairs
// with analyzePack() in packs.js, which produces the analysis this module stores.

const PACKS_DIR = 'packs';
const BLOB_DIR = 'blob';
const enc = new TextEncoder();
const parentDir = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };

function assertOPFS() {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory) {
    throw new Error('OPFS unavailable (needs a secure context: https or localhost)');
  }
}
const root = () => navigator.storage.getDirectory();
const dir = (parent, name, create = false) => parent.getDirectoryHandle(name, { create });
// Blobs are sharded by their first 2 hex chars so no single OPFS directory holds
// the whole store.
const blobShard = async (r, hash, create = false) => dir(await dir(r, BLOB_DIR, create), hash.slice(0, 2), create);

// --- content-addressed blobs -----------------------------------------------

export async function hasBlob(hash) {
  assertOPFS();
  try {
    await (await blobShard(await root(), hash, false)).getFileHandle(hash, { create: false });
    return true;
  } catch (e) { return false; }
}

// In-flight writes keyed by hash, so concurrent writers of the SAME hash in this
// realm (the bulk import runs a worker pool, and YSFLIGHT packs share models) are
// SERIALISED rather than racing on a half-written 0-byte file: the second caller
// awaits the first and then re-checks, instead of seeing the first writer's
// freshly-created-but-not-yet-flushed entry and mistaking it for a dedup hit.
const inflight = new Map();

// Returns true if the blob was newly written, false if it was already present
// (the dedup signal).
export async function putBlob(hash, bytes) {
  assertOPFS();
  // If another writer of this exact hash is mid-flight, wait for it to settle
  // before deciding -- success means a real dedup hit; failure means we write.
  const pending = inflight.get(hash);
  if (pending) { try { await pending; } catch (e) { /* writer failed; we retry below */ } }

  if (await hasBlob(hash)) return false;
  const p = (async () => {
    const fh = await (await blobShard(await root(), hash, true)).getFileHandle(hash, { create: true });
    const w = await fh.createWritable();
    try { await w.write(bytes); } finally { await w.close(); }
  })();
  inflight.set(hash, p);
  try {
    await p;
    return true;
  } catch (e) {
    if (await hasBlob(hash)) return false; // a concurrent writer (e.g. another tab) won
    throw e;
  } finally {
    if (inflight.get(hash) === p) inflight.delete(hash);
  }
}

export async function getBlob(hash) {
  assertOPFS();
  const fh = await (await blobShard(await root(), hash, false)).getFileHandle(hash, { create: false });
  return new Uint8Array(await (await fh.getFile()).arrayBuffer());
}

// --- pack records -----------------------------------------------------------

export async function putRecord(record) {
  const fh = await (await dir(await root(), PACKS_DIR, true)).getFileHandle(record.id + '.json', { create: true });
  const w = await fh.createWritable();
  try { await w.write(enc.encode(JSON.stringify(record))); } finally { await w.close(); }
}

export async function getRecord(id) {
  assertOPFS();
  try {
    const fh = await (await dir(await root(), PACKS_DIR, false)).getFileHandle(id + '.json', { create: false });
    return JSON.parse(await (await fh.getFile()).text());
  } catch (e) { return null; }
}

export async function listRecords() {
  assertOPFS();
  const out = [];
  try {
    const d = await dir(await root(), PACKS_DIR, false);
    for await (const [name, h] of d.entries()) {
      if (h.kind === 'file' && name.endsWith('.json')) {
        try { out.push(JSON.parse(await (await h.getFile()).text())); } catch (e) { /* skip corrupt */ }
      }
    }
  } catch (e) { /* no packs dir yet */ }
  return out;
}

export async function removeRecord(id) {
  assertOPFS();
  try { await (await dir(await root(), PACKS_DIR, false)).removeEntry(id + '.json'); } catch (e) {}
}

export async function setEnabled(id, enabled) {
  const rec = await getRecord(id);
  if (!rec) throw new Error('pack not in OPFS store: ' + id);
  rec.enabled = !!enabled;
  await putRecord(rec);
  return rec;
}

// --- install / materialize / gc --------------------------------------------

// A pack record from an analysis: the manifest essentials + enabled flag + the
// small generated-list text (so we can materialize later without re-reading the
// archive).  Blob storage is separate (streaming vs in-memory).
function recordFromAnalysis(analysis, enabled) {
  const record = {
    id: analysis.id,
    name: analysis.name,
    categories: analysis.categories,
    bytes: analysis.total,
    enabled,
    installedAt: analysis.now,
    source: analysis.source,
    files: analysis.hashed, // [{path,size,sha256}]
    generated: analysis.generated.map((g) => ({ category: g.category, file: g.file, text: g.text, entries: g.entries })),
  };
  if (analysis.manifest && analysis.manifest.sourceUrl) record.sourceUrl = analysis.manifest.sourceUrl;
  return record;
}

// Write the record for an analysis whose blobs are ALREADY stored -- the streaming
// install path (analyzePackStreaming persists each blob via the injected putBlob
// as it decompresses, so the whole archive is never held in memory).
export async function putRecordFromAnalysis(analysis, { enabled = true } = {}) {
  assertOPFS();
  await putRecord(recordFromAnalysis(analysis, enabled));
  return { id: analysis.id };
}

// Store an analyzed pack whose file BYTES are in memory (analysis.files[].bytes):
// write its blobs content-addressed (dedup makes re-used files free), then the
// record.  Used by tests / non-streaming callers; the live install streams.
export async function storeAnalyzedPack(analysis, { enabled = true } = {}) {
  assertOPFS();
  const bytesByPath = new Map(analysis.files.map((f) => [f.path, f.bytes]));
  let newBlobs = 0;
  for (const h of analysis.hashed) {
    if (await putBlob(h.sha256, bytesByPath.get(h.path))) newBlobs++;
  }
  await putRecord(recordFromAnalysis(analysis, enabled));
  return { id: analysis.id, newBlobs, files: analysis.hashed.length };
}

// Materialize a stored pack into the engine FS at the paths its generated lists
// reference: copy each file's blob to packs/<id>/<path> (the MEMFS-mounted,
// IDBFS-excluded payload area) and -- when the pack is enabled -- write the
// generated lists into the scanned dirs so the engine's glob finds them.  A
// disabled pack's payload may still be materialized, but with no list the engine
// does not scan it.  `fsAdapter` is the packs.js-style adapter rooted at the
// YSFLIGHT user dir; `withLists` defaults to the record's enabled flag.
// File extensions the engine's startup template scan actually reads: the lists,
// plus aircraft/ground property (.dat) and scenery start position (.stp).  The
// heavy visual/collision payload (.dnm/.srf/.fld/.yfs/cockpit...) is NOT opened
// during the scan -- the engine loads it lazily, one item at a time, when a pack
// entry is selected/hovered.  So boot only needs these; the rest is materialized
// on demand (materializeFile).
const META_EXT = /\.(lst|dat|stp)$/i;

export async function materialize(record, fsAdapter, { withLists = record.enabled !== false, metaOnly = false } = {}) {
  assertOPFS();
  // Aircraft .dat files covered by a generated .lst.idx sidecar are NOT needed
  // during the boot scan (the engine registers those templates from the sidecar)
  // -- skip them in metaOnly and let the openat hook materialize them on demand
  // at flight time, like any payload.  Packs without a sidecar (imported before
  // this feature, or with non-ASCII identities) keep the old bulk-copy behavior.
  const idxCovered = new Set();
  const idPrefix = 'packs/' + record.id + '/';
  for (const g of record.generated || []) {
    if (!/\.lst\.idx$/i.test(g.file)) continue;
    for (const ln of g.text.split('\n')) {
      const tab = ln.indexOf('\t');
      if (tab > 0 && ln.startsWith(idPrefix)) idxCovered.add(ln.slice(idPrefix.length, tab));
    }
  }
  for (const f of record.files) {
    if (metaOnly && !META_EXT.test(f.path)) continue; // heavy payload deferred to materializeFile
    if (metaOnly && /\.dat$/i.test(f.path) && idxCovered.has(f.path)) continue; // sidecar-covered
    const dest = 'packs/' + record.id + '/' + f.path;
    await fsAdapter.mkdirp(parentDir(dest));
    await fsAdapter.writeFile(dest, await getBlob(f.sha256));
  }
  if (withLists) {
    for (const g of record.generated) {
      await fsAdapter.mkdirp(parentDir(g.file));
      await fsAdapter.writeFile(g.file, enc.encode(g.text));
    }
  }
}

// On-demand materialize of a single payload file (Phase 2): copy one pack file's
// blob into the engine FS.  Returns true if the path is in the record (now on
// disk), false if the record has no such file.  Idempotent (blobs are immutable,
// so a re-write is harmless).
export async function materializeFile(record, fsAdapter, relPath) {
  assertOPFS();
  const f = record.files.find((x) => x.path === relPath);
  if (!f) return false;
  const dest = 'packs/' + record.id + '/' + f.path;
  await fsAdapter.mkdirp(parentDir(dest));
  await fsAdapter.writeFile(dest, await getBlob(f.sha256));
  return true;
}

// Garbage-collect blobs no longer referenced by any pack record.  Safe to run
// after uninstall; content-addressing means a blob shared by another pack stays.
export async function gc() {
  assertOPFS();
  const referenced = new Set();
  for (const rec of await listRecords()) for (const f of (rec.files || [])) referenced.add(f.sha256);
  let removed = 0;
  try {
    const bd = await dir(await root(), BLOB_DIR, false);
    for await (const [, shard] of bd.entries()) {
      if (shard.kind !== 'directory') continue;
      const toDel = [];
      for await (const [hash, h] of shard.entries()) if (h.kind === 'file' && !referenced.has(hash)) toDel.push(hash);
      for (const hash of toDel) { try { await shard.removeEntry(hash); removed++; } catch (e) {} }
    }
  } catch (e) { /* no blob dir yet */ }
  return { removed };
}

// Stored pack count + summed bytes + the browser's OPFS estimate.
export async function usage() {
  const records = await listRecords();
  let estimate = null;
  try { estimate = await navigator.storage.estimate(); } catch (e) {}
  return { packs: records.length, packBytes: records.reduce((n, r) => n + (r.bytes || 0), 0), estimate };
}
