// Update an EXISTING pack record from a new zip ("update from ZIP") — the
// missing verb for self-authored add-on packs: importing a zip always installs
// a NEW pack (content-hash id), so versioning one's own pack used to pile up
// duplicates.  This module replaces a record's payload while carrying over its
// identity and state, following the same lineage as the studios' re-edit ->
// replace-save (saveOrReplace): the successor gets a NEW content-hash id, the
// old id retires and its blobs become GC-able.
//
// What carries over (record-level, never content):
//   - name     — the pack's identity for humans AND for the pack studio's
//                stale detection (memberState matches a vanished sourceId by
//                name+kind, so an updated creation naturally shows the "↺
//                update" badge on packs that snapshot it)
//   - enabled  — an off pack stays off across an update
//   - sourceUrl — kept when the new zip doesn't declare its own
//   - attribution (author / redistribution policy, PR "pack-qol") — carried
//                onto the record ONLY when the new zip ships no recipe of its
//                own; a zip that carries workbench.json speaks for itself
//
// Two-phase by design so the UI can show a diff summary and still cancel:
//   prepareUpdate() streams the zip's blobs into the store (content-addressed,
//   so a cancel just leaves unreferenced blobs for gc()) and returns the diff;
//   commitUpdate() writes the successor record, retires the old id, and gc()s.
//
// Engine-less and DOM-less: the store is injected (the browser passes the
// opfs-store module itself; tests pass an in-memory mock), so this runs and is
// unit-tested in plain node/deno alongside packs.js.

import { analyzePackStreaming, MAX_PACK_BYTES } from './packs.js';
import { recordFromAnalysis } from './opfs-store.js';
import { RECIPE_FILE } from './workbench.js';
import { normalizeAttribution } from './studio-pack-core.js';

const td = new TextDecoder();

// Pure file-manifest diff between the old record and the new analysis, both
// [{path, sha256, ...}].  `changed` = same path, different bytes.
export function diffPackFiles(oldFiles, newFiles) {
  const oldBy = new Map((oldFiles || []).map((f) => [f.path, f.sha256]));
  const newBy = new Map((newFiles || []).map((f) => [f.path, f.sha256]));
  const added = [], removed = [], changed = [];
  for (const [p, sha] of newBy) {
    if (!oldBy.has(p)) added.push(p);
    else if (oldBy.get(p) !== sha) changed.push(p);
  }
  for (const p of oldBy.keys()) if (!newBy.has(p)) removed.push(p);
  return { added, removed, changed, unchanged: newBy.size - added.length - changed.length };
}

// The recipe (workbench.json) carried by a record/analysis, parsed, or null.
async function recipeOf(files, store) {
  const rf = (files || []).find((f) => f.path === RECIPE_FILE);
  if (!rf) return null;
  try { return JSON.parse(td.decode(await store.getBlob(rf.sha256))); }
  catch (e) { return null; }
}

// The attribution a pack effectively carries: its recipe's (content) first,
// then a record-level carry from a previous update.
async function effectiveAttribution(rec, store) {
  const recipe = await recipeOf(rec.files, store);
  return normalizeAttribution(recipe && recipe.attribution) || normalizeAttribution(rec.attribution);
}

// Phase 1: analyze the zip (streaming; blobs persist via store.putBlob as they
// decompress) and diff it against the old record.  The old record's NAME is
// force-fed as the pack name so identity survives whatever the zip is called.
// Throws packs.js analysis errors verbatim (same messages the import UI maps).
// On failure or cancel the caller should store.gc() to reclaim orphan blobs.
export async function prepareUpdate(oldRec, zipBytes, { sha256, store, maxPackBytes = MAX_PACK_BYTES } = {}) {
  if (!oldRec || !oldRec.id) throw new Error('prepareUpdate requires the existing pack record');
  if (!sha256 || !store) throw new Error('prepareUpdate requires { sha256, store }');
  const analysis = await analyzePackStreaming(zipBytes, {
    sha256, putBlob: store.putBlob, name: oldRec.name,
    maxPackBytes, maxFileBytes: maxPackBytes,
  });
  const newRecipe = await recipeOf(analysis.hashed, store);
  return {
    analysis,
    diff: diffPackFiles(oldRec.files, analysis.hashed),
    sameId: analysis.id === oldRec.id,
    newRecipeType: newRecipe ? (newRecipe.type || null) : null,
    newHasRecipe: !!newRecipe,
  };
}

// Phase 2: write the successor record (state carried over), retire the old id,
// reclaim unreferenced blobs.  Returns the new record.  A same-id "update" is
// a no-op upstream (callers skip commit), but committing one is harmless: the
// record is rewritten in place and nothing retires.
export async function commitUpdate(oldRec, analysis, { store } = {}) {
  if (!store) throw new Error('commitUpdate requires { store }');
  const record = recordFromAnalysis(analysis, oldRec.enabled !== false);
  if (!record.sourceUrl && oldRec.sourceUrl) record.sourceUrl = oldRec.sourceUrl;
  // Carry attribution only when the new zip has NO recipe at all — a zip that
  // ships workbench.json is the authority on its own provenance (including
  // deliberately recording none).
  if (!(analysis.hashed || []).some((f) => f.path === RECIPE_FILE)) {
    const a = await effectiveAttribution(oldRec, store);
    if (a) record.attribution = a;
  }
  await store.putRecord(record);
  if (oldRec.id !== record.id) await store.removeRecord(oldRec.id);
  await store.gc();
  return record;
}
