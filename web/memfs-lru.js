// MEMFS LRU residency tracker + evictor for on-demand materialized pack payload.
//
// LAYER 3 of the classic-FS "unlimited packs" design (docs/asyncify-lazy-pack.md).
//
// The lazy-pack system copies pack PAYLOAD (.dnm/.srf/.fld/textures) from OPFS into
// the engine's MEMFS on demand (web/packs-ui.js ysfwMaterializeForOpen, driven by
// the openat ASYNCIFY hook in src/port/ysfw_openat.jslib).  MEMFS lives in the wasm
// LINEAR MEMORY, which only ever GROWS (ALLOW_MEMORY_GROWTH, never shrinks) up to
// the ~2GB wasm32 ceiling.  With no eviction, flying across many packs over a long
// session pushes resident payload monotonically up until the engine ABORTS at the
// ceiling -- the real capacity limit (boot has no budget anymore; this is the one
// that bites mid-play).
//
// This tracker bounds it: every materialized payload file is recorded with its byte
// size and a monotonically increasing access stamp.  When the tracked total crosses
// `highWater`, the least-recently-used files are FS.unlink'd (oldest first) until the
// total falls back under `lowWater`.  Eviction is SAFE because the openat hook
// transparently re-materializes any evicted file from OPFS the next time the engine
// opens it -- "delete -> comes back on next open".  So RAM stays bounded regardless
// of how many packs are installed or how long the session runs; the only cost of an
// over-eviction is one extra OPFS->MEMFS copy on next access.
//
// Why threshold on OUR tracked bytes, not Module.HEAP8.length: linear memory never
// shrinks, so HEAP8.length only grows; thresholding on it would trigger ENDLESS
// eviction once crossed (freeing MEMFS nodes does not shrink the heap).  The tracked
// payload total IS the part we can actually free, and freeing it relieves the
// PRESSURE to grow the heap further.  That is the lever, so that is the gauge.
//
// Pure and dependency-free (no browser, no FS) so it unit-tests in plain node: the
// caller injects `unlink(key)` and the policy is just arithmetic.  Keys are the
// engine-relative payload paths ("packs/<id>/<relPath>"); the injected unlink maps a
// key to the real FS.unlink at the engine FS root.

const MiB = 1024 * 1024;

export function createMemfsLru({
  highWater = 768 * MiB,  // start evicting once tracked payload exceeds this
  lowWater = 512 * MiB,   // ...and drop back under this.  The gap (256MiB) is far
                          //    larger than any single payload file, so the
                          //    just-materialized (newest) file is never the victim.
  unlink,                 // (key) => void : remove the file from the engine MEMFS
} = {}) {
  if (typeof unlink !== 'function') throw new Error('memfs-lru: an unlink(key) fn is required');
  highWater = toBytes(highWater, 768 * MiB);
  lowWater = toBytes(lowWater, 512 * MiB);
  if (!(lowWater < highWater)) throw new Error('memfs-lru: need lowWater < highWater');

  // key -> { bytes, seq }.  We evict by `seq` (access recency), not Map insertion
  // order, so a re-touch correctly defers a file's eviction.
  const entries = new Map();
  let total = 0;     // summed bytes of every tracked (resident, evictable) file
  let clock = 0;     // monotonic recency stamp
  let evictions = 0; // lifetime count, for observability

  // Record (or update) a materialized file and stamp it most-recently-used.
  function track(key, bytes) {
    bytes = toBytes(bytes, 0);
    const prev = entries.get(key);
    if (prev) { total += bytes - prev.bytes; prev.bytes = bytes; prev.seq = ++clock; }
    else { entries.set(key, { bytes, seq: ++clock }); total += bytes; }
  }

  // Bump recency without changing size.  No-op if untracked.  (Hook for a future
  // per-open touch from the openat ASYNCIFY hook, so a resident-but-hot file is not
  // evicted just because it has not been *re*-materialized recently.)
  function touch(key) {
    const e = entries.get(key);
    if (e) e.seq = ++clock;
  }

  // Drop an entry from accounting WITHOUT unlinking -- the caller already removed the
  // file (e.g. uninstall rmrf'd the whole pack dir).
  function forget(key) {
    const e = entries.get(key);
    if (!e) return;
    total -= e.bytes;
    entries.delete(key);
  }
  function forgetPrefix(prefix) {
    for (const key of [...entries.keys()]) if (key.startsWith(prefix)) forget(key);
  }

  // Evict LRU-first until total <= lowWater.  `protect` (a Set or array of keys) is
  // never evicted this pass -- the caller passes the files it just materialized / has
  // in flight, belt-and-suspenders on top of the high/low headroom.  Returns the
  // evicted keys.
  function sweep(protect) {
    if (total <= highWater) return [];
    const guard = protect ? (protect instanceof Set ? protect : new Set(protect)) : null;
    // Oldest first.  Snapshot + sort by seq; cheap relative to the OPFS->MEMFS copies
    // that grew the total, and sweeps only run past highWater (rarely).
    const order = [...entries.entries()].sort((a, b) => a[1].seq - b[1].seq);
    const evicted = [];
    for (const [key, e] of order) {
      if (total <= lowWater) break;
      if (guard && guard.has(key)) continue;
      // Remove from accounting FIRST so the loop always makes progress even if unlink
      // throws (a missing file is already "evicted" for our purposes).
      total -= e.bytes;
      entries.delete(key);
      try { unlink(key); } catch (err) { /* ENOENT etc.: already gone, fine */ }
      evictions++;
      evicted.push(key);
    }
    return evicted;
  }

  function stats() {
    return { total, count: entries.size, highWater, lowWater, evictions };
  }
  function configure(opts) {
    if (opts && opts.highWater != null) highWater = toBytes(opts.highWater, highWater);
    if (opts && opts.lowWater != null) lowWater = toBytes(opts.lowWater, lowWater);
  }

  return { track, touch, forget, forgetPrefix, sweep, stats, configure };
}

function toBytes(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}
