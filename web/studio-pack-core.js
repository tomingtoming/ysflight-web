// Pure logic core for the Pack Studio (web/studio-pack.js): member snapshot
// namespacing, recipe (de)serialization, and pack composition — everything that
// does not need the DOM or OPFS, so it runs (and is unit-tested) in plain node
// alongside packs.js.  The studio page keeps only the I/O glue and rendering.
//
// Design context (toming's rulings, unchanged here): a pack is a WORK — a
// curated collection of one's own creations — not an inventory manager and not
// a distribution channel.  Members are frozen content-hash snapshots taken at
// add time; ↺ refresh is always an explicit act.

import { RECIPE_FILE } from './workbench.js';

const te = new TextEncoder();
const td = new TextDecoder();

// --- names ------------------------------------------------------------------------

export const sanitize = (s) =>
  (String(s || 'work').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'work').slice(0, 24);

// A member prefix unique within this pack ("f15", "f15_2", ...).
export const uniqueSan = (name, taken) => {
  const base = sanitize(name);
  let san = base, n = 2;
  while (taken.includes(san)) san = base + '_' + (n++);
  return san;
};

// --- member snapshot namespacing ---------------------------------------------------

// Namespace one creation's payload files per member so nothing collides in the
// composed pack: every file becomes <dir>/<memberSan>_<base>, and path
// references inside the member's own .lst text are rewritten to match.
// `rawFiles` is [{path, bytes}] (the source record's payload, recipe excluded);
// returns [{path, bytes}] with final namespaced paths.
export function namespaceSnapshot(rawFiles, memberSan) {
  const rename = new Map(); // old path -> new path
  for (const f of rawFiles) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
    const base = f.path.slice(dir.length);
    if (/\.lst$/i.test(base)) {
      // The pack analyzer requires list names to KEEP their air*/sce*/gro*
      // prefix (chooseLayout in packs.js) — namespace after it, not before.
      const m = base.match(/^(air|sce|gro)/i);
      const lead = m ? m[1] : ({ 'aircraft/': 'air', 'scenery/': 'sce', 'ground/': 'gro' }[dir] || 'air');
      rename.set(f.path, dir + lead + '_' + memberSan + '_' + base.slice(m ? m[1].length : 0).replace(/^_+/, ''));
    } else {
      rename.set(f.path, dir + memberSan + '_' + base);
    }
  }
  return rawFiles.map((f) => {
    let bytes = f.bytes;
    if (/\.lst$/i.test(f.path)) {
      let text = td.decode(bytes);
      for (const [oldP, newP] of rename) {
        if (oldP === f.path) continue;
        text = text.split(oldP).join(newP);
      }
      bytes = te.encode(text);
    }
    return { path: rename.get(f.path), bytes };
  });
}

// --- freshness ---------------------------------------------------------------------

// Creations are content-addressed records (id = content hash of the payload),
// so member freshness is a pure hash/id comparison against the library:
//   fresh  — a record with the member's sourceId still exists: the snapshot IS
//            the library's current bytes (same hash, nothing to refresh).
//   stale  — no record with that id, but a creation of the same name+kind
//            exists: editing a work replaces its record under a NEW id
//            (saveOrReplace), so that creation is the member's edited
//            successor.  currentId is the ↺ target; the library list is
//            newest-first, so the newest name match wins.
//   orphan — neither: the source work was deleted; only the snapshot remains.
// `creations` is the studio's library list ([{id, name, kind}], newest first).
export function memberState(member, creations) {
  if (creations.some((c) => c.id === member.sourceId)) return { state: 'fresh', currentId: member.sourceId };
  const cur = creations.find((c) => c.kind === member.kind && (c.name || c.id) === member.name);
  if (cur) return { state: 'stale', currentId: cur.id };
  return { state: 'orphan', currentId: null };
}

// The bulk-↺ plan: which members are outdated (with their refresh targets) and
// the counts the confirmation summary shows before anything is touched.
export function refreshPlan(members, creations) {
  const stale = [], orphans = [];
  let fresh = 0;
  members.forEach((m, index) => {
    const st = memberState(m, creations);
    if (st.state === 'stale') stale.push({ index, name: m.name, currentId: st.currentId });
    else if (st.state === 'orphan') orphans.push(m.name);
    else fresh++;
  });
  return { stale, orphans, fresh };
}

// --- recipe -----------------------------------------------------------------------

// The pack recipe object embedded as workbench.json.  Field order and the
// omit-when-empty rules are stable so an UNCHANGED pack re-serializes to the
// same bytes (records are content-addressed: same bytes = same id = no-op
// save), and a pack saved by an OLDER studio round-trips byte-identically.
// addedAt = when the member snapshot was (re-)frozen (add or ↺), epoch ms.
export function buildRecipe(packName, members) {
  return {
    type: 'pack',
    packName,
    members: members.map((m) => {
      const e = { sourceId: m.sourceId, san: m.san, name: m.name, kind: m.kind };
      if (m.addedAt) e.addedAt = m.addedAt;
      return e;
    }),
  };
}

// Normalize a parsed pack recipe, tolerating recipes written by OLDER studios
// (missing fields default) — the backward-compat seam for every recipe change.
export function parseRecipe(recipe) {
  return {
    packName: (recipe && recipe.packName) || '',
    members: ((recipe && recipe.members) || []).map((m) => ({
      sourceId: m.sourceId || null,
      san: m.san,
      name: m.name,
      kind: m.kind,
      addedAt: m.addedAt || null,
    })),
  };
}

// --- compose ----------------------------------------------------------------------

// The zip entry map for a pack: every member's namespaced files + the recipe.
// The caller zips this (fflate zipSync) and hands it to the install pipeline.
export function composeEntries(members, packName) {
  const entries = {};
  for (const m of members) for (const f of m.files) entries[f.path] = f.bytes;
  entries[RECIPE_FILE] = te.encode(JSON.stringify(buildRecipe(packName, members)));
  return entries;
}

// --- display helpers ----------------------------------------------------------------

export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}

export const memberBytes = (m) => (m.files || []).reduce((n, f) => n + (f.bytes ? f.bytes.length : 0), 0);

// Whole-pack summary for the members header: work/file counts + total size.
export function summarize(members) {
  let files = 0, bytes = 0;
  for (const m of members) {
    files += (m.files || []).length;
    bytes += memberBytes(m);
  }
  return { works: members.length, files, bytes };
}
