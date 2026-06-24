// Unit tests for the MEMFS LRU evictor (web/memfs-lru.js), layer3 of the
// unlimited-packs design.  Pure module -> runs in plain node (`node --test`, or
// scripts/test.sh); the injected unlink just records calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMemfsLru } from '../web/memfs-lru.js';

// A tiny budget so a handful of small files crosses it: highWater 100, lowWater 50.
function makeLru(extra = {}) {
  const unlinked = [];
  const lru = createMemfsLru({ highWater: 100, lowWater: 50, unlink: (k) => unlinked.push(k), ...extra });
  return { lru, unlinked };
}

test('track accumulates total and count', () => {
  const { lru } = makeLru();
  lru.track('packs/a/x', 30);
  lru.track('packs/a/y', 20);
  const s = lru.stats();
  assert.equal(s.total, 50);
  assert.equal(s.count, 2);
});

test('re-tracking a key replaces its size (no double count) and refreshes recency', () => {
  const { lru } = makeLru();
  lru.track('packs/a/x', 30);
  lru.track('packs/a/x', 40); // same key, new size
  assert.equal(lru.stats().total, 40);
  assert.equal(lru.stats().count, 1);
});

test('sweep is a no-op while under highWater', () => {
  const { lru, unlinked } = makeLru();
  lru.track('packs/a/x', 40);
  const evicted = lru.sweep();
  assert.deepEqual(evicted, []);
  assert.deepEqual(unlinked, []);
  assert.equal(lru.stats().total, 40);
});

test('sweep evicts LRU-first down to lowWater and unlinks each victim', () => {
  const { lru, unlinked } = makeLru();
  lru.track('packs/a/oldest', 30); // seq 1
  lru.track('packs/a/mid', 30);    // seq 2
  lru.track('packs/a/new', 50);    // seq 3 -> total 110 > highWater 100
  const evicted = lru.sweep();
  // Must drop to <= 50: evicting 'oldest' (->80) then 'mid' (->50) reaches lowWater.
  assert.deepEqual(evicted, ['packs/a/oldest', 'packs/a/mid']);
  assert.deepEqual(unlinked, ['packs/a/oldest', 'packs/a/mid']);
  assert.equal(lru.stats().total, 50);
  assert.equal(lru.stats().count, 1); // only 'new' survives
});

test('touch defers eviction: a touched-old file outlives an untouched newer one', () => {
  // NOTE: touch() is NOT YET WIRED in production -- the openat ASYNCIFY hook does not
  // fire on a MEMFS hit, so a resident re-open does not bump recency (see the
  // materialize-time recency policy in docs/asyncify-lazy-pack.md, and the regression
  // test directly below).  This exercises touch() for the FUTURE per-open-touch path
  // (which needs a wasm rebuild); memfs-lru.js ships touch() ready for it.
  // Tight gap (high 100, low 80) so a single eviction reaches the mark, isolating
  // WHICH file is chosen -- the untouched 'new', not the touched-fresh 'old'.
  const { lru } = makeLru({ lowWater: 80 });
  lru.track('packs/a/old', 30); // seq 1
  lru.track('packs/a/new', 30); // seq 2
  lru.touch('packs/a/old');     // seq 3 -> 'old' is now the freshest
  lru.track('packs/a/big', 50); // seq 4 -> total 110 > 100
  const evicted = lru.sweep();
  assert.deepEqual(evicted, ['packs/a/new']); // the untouched one goes, not 'old'
  assert.equal(lru.stats().total, 80);
});

test('materialize-time recency policy: a resident-but-stale file (never re-tracked) is the victim', () => {
  // Pins the ACTUAL production policy: recency advances only on (re)materialize via
  // track(); a resident re-open does NOT touch (openat skips the materialize path on a
  // MEMFS hit), so a frequently-used-but-resident file keeps its old stamp and can be
  // evicted before a newer-materialized one.  Harmless -- the openat hook re-materializes
  // it transparently on the next open -- but this IS the real victim-selection behaviour.
  const { lru } = makeLru({ lowWater: 80 });
  lru.track('packs/a/hot', 30);  // seq 1 -- engine keeps re-opening it, but it stays resident...
  lru.track('packs/a/cold', 30); // seq 2
  // ...and a resident re-open of 'hot' is a no-op here (no re-track / no touch), so seq stays 1.
  lru.track('packs/a/new', 50);  // seq 3 -> total 110 > highWater 100
  const evicted = lru.sweep();
  assert.deepEqual(evicted, ['packs/a/hot']); // the stale-but-hot file falls first
});

test('protect set is never evicted, even if it is the oldest', () => {
  const { lru, unlinked } = makeLru();
  lru.track('packs/a/pinned', 30); // seq 1 (oldest)
  lru.track('packs/a/b', 30);      // seq 2
  lru.track('packs/a/c', 50);      // seq 3 -> total 110
  const evicted = lru.sweep(new Set(['packs/a/pinned']));
  assert.ok(!evicted.includes('packs/a/pinned'));
  assert.ok(!unlinked.includes('packs/a/pinned'));
  assert.equal(lru.stats().total <= lru.stats().lowWater, true);
});

test('protect accepts an array too', () => {
  const { lru } = makeLru();
  lru.track('packs/a/keep', 30);
  lru.track('packs/a/b', 30);
  lru.track('packs/a/c', 50);
  const evicted = lru.sweep(['packs/a/keep']);
  assert.ok(!evicted.includes('packs/a/keep'));
});

test('the newest (just-materialized) file is never the victim with realistic headroom', () => {
  // Mirrors production: gap (highWater-lowWater) >> any single payload file.
  const unlinked = [];
  const lru = createMemfsLru({ highWater: 768 * 1024 * 1024, lowWater: 512 * 1024 * 1024, unlink: (k) => unlinked.push(k) });
  // Fill with many 10MB files, then add one more crossing the line.
  for (let i = 0; i < 80; i++) lru.track('packs/p/f' + i, 10 * 1024 * 1024); // 800MB > 768
  lru.track('packs/p/newest', 10 * 1024 * 1024);
  lru.sweep();
  assert.ok(!unlinked.includes('packs/p/newest'), 'newest must survive');
  assert.ok(lru.stats().total <= 512 * 1024 * 1024);
});

test('forget drops accounting without unlinking', () => {
  const { lru, unlinked } = makeLru();
  lru.track('packs/a/x', 30);
  lru.forget('packs/a/x');
  assert.equal(lru.stats().total, 0);
  assert.equal(lru.stats().count, 0);
  assert.deepEqual(unlinked, []); // forget != unlink
});

test('forgetPrefix drops a whole pack and leaves others', () => {
  const { lru } = makeLru();
  lru.track('packs/a/x', 30);
  lru.track('packs/a/y', 20);
  lru.track('packs/b/z', 10);
  lru.forgetPrefix('packs/a/');
  assert.equal(lru.stats().count, 1);
  assert.equal(lru.stats().total, 10);
});

test('sweep makes progress even when unlink throws (entry still removed)', () => {
  const lru = createMemfsLru({
    highWater: 100, lowWater: 50,
    unlink: (k) => { throw new Error('ENOENT ' + k); },
  });
  lru.track('packs/a/x', 30);
  lru.track('packs/a/y', 30);
  lru.track('packs/a/z', 50); // total 110
  const evicted = lru.sweep();
  assert.equal(evicted.length, 2);          // still evicted from accounting
  assert.equal(lru.stats().total, 50);      // total reflects the drop
});

test('configure can raise/lower the watermarks', () => {
  const { lru } = makeLru();
  lru.track('packs/a/x', 60);
  assert.deepEqual(lru.sweep(), []); // 60 < 100, no-op
  lru.configure({ highWater: 50, lowWater: 20 });
  const evicted = lru.sweep();
  assert.deepEqual(evicted, ['packs/a/x']); // now over the lowered highWater
});

test('constructor rejects a missing unlink fn and bad watermarks', () => {
  assert.throws(() => createMemfsLru({ highWater: 100, lowWater: 50 }), /unlink/);
  assert.throws(() => createMemfsLru({ highWater: 50, lowWater: 100, unlink() {} }), /lowWater < highWater/);
});

test('a single oversized file still evicts down past its own size', () => {
  // Defensive: if one file exceeds the high-low gap, sweep should still shed older
  // files to the extent possible (it cannot evict the protected newest one).
  const { lru } = makeLru();
  lru.track('packs/a/old', 40);  // seq 1
  lru.track('packs/a/huge', 90); // seq 2 -> total 130, huge alone > lowWater 50
  const evicted = lru.sweep(new Set(['packs/a/huge'])); // protect the just-added one
  assert.deepEqual(evicted, ['packs/a/old']);
  assert.equal(lru.stats().total, 90); // cannot go below the protected file's size
});
