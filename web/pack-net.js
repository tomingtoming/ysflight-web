// Multiplayer add-on-pack distribution for ysflight-web (v2).
//
// A host advertises the packs it has ENABLED; a joining client diffs that
// against its own installed packs and pulls the missing ones BEFORE the YSFLIGHT
// log-on, so a joiner ends up with the host's packs with no manual install.
//
// Transport is a SHELL-OWNED WebRTC connection (a separate RTCPeerConnection +
// 'ysf-pack' DataChannel), NOT the engine's game channel: the engine's peer
// connection does not exist until after main(), but pack sync must finish during
// the pre-boot run-dependency gate, so the pack connection must be shell-owned
// and independent of the engine.  It reuses the same Cloudflare signaling hub on
// a DERIVED room string.  Full design: docs/addon-packs.md section 5.
//
// This module is built up across milestones:
//   M4 (this file): the pure, engine-independent CORE below — room derivation,
//       the host's advertised manifest, and the joiner's diff.
//   M5: WebRTC signaling + a chunked/backpressured 'ysf-pack' transfer (host push).
//   M6: wire the joiner sync into the pre-boot run-dependency gate (no reload).
//   M7: Option-B URL self-fetch + field-priority + obtain-failure UX.
// Keep browser-only APIs (WebSocket/RTCPeerConnection) inside functions added in
// later milestones so this module stays importable under Node for unit tests.

// The engine host claims the plain room (<=16 chars, an 8-digit code in the web
// build); the pack channel needs a DISTINCT room both sides can derive from data
// they already have (globalThis.ysfwRtc.host.room on the host, ?join= on the
// joiner).  A 2-char suffix keeps it within the Worker's 16-char room-key limit.
export function derivePackRoom(gameRoom) {
  const base = String(gameRoom == null ? '' : gameRoom);
  const suffix = '~p';
  const room = base + suffix;
  return room.length <= 16 ? room : base.slice(0, 16 - suffix.length) + suffix;
}

// Build the host's advertised manifest from the installed-pack index + each
// pack's stored manifest.json.  Only ENABLED packs are advertised.  Pure aside
// from the injected accessors, so it is unit-testable:
//   list()               -> array of index entries {id,name,enabled,categories,...}
//   readManifestJson(id) -> packs/<id>/manifest.json object {files:[{path,size,sha256}],sourceUrl?} | null
export async function buildRoomManifest({ list, readManifestJson }) {
  const index = (await list()) || [];
  const out = [];
  for (const e of index) {
    if (!e || e.enabled === false) continue;
    let files = [];
    let sourceUrl;
    const mf = await readManifestJson(e.id);
    if (mf && Array.isArray(mf.files)) {
      files = mf.files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 }));
      if (mf.sourceUrl) sourceUrl = mf.sourceUrl;
    }
    const pack = { id: e.id, name: e.name, categories: e.categories || [], files };
    if (sourceUrl) pack.sourceUrl = sourceUrl;
    out.push(pack);
  }
  return out;
}

// Diff a received room manifest against the joiner's local index.  Packs are
// content-addressed (id = hash of contents), so an identical id means identical
// bytes.  Returns:
//   missing   : host packs whose id the joiner lacks (must be obtained)
//   present   : host pack ids the joiner already has
//   conflicts : host packs whose NAME matches a locally-installed pack of a
//               DIFFERENT id (same-name/different-hash).  Policy (decided): the
//               host version wins for the session — handled at install time (M6).
export function diffManifest(roomManifest, localIndex) {
  const room = Array.isArray(roomManifest) ? roomManifest : [];
  const local = Array.isArray(localIndex) ? localIndex : [];
  const localIds = new Set(local.map((e) => e && e.id));
  const localByName = new Map();
  for (const e of local) if (e && e.name != null) localByName.set(e.name, e);

  const missing = [];
  const present = [];
  const conflicts = [];
  for (const p of room) {
    if (!p || !p.id) continue;
    if (localIds.has(p.id)) {
      present.push(p.id);
      continue;
    }
    missing.push(p);
    const byName = localByName.get(p.name);
    if (byName && byName.id !== p.id) {
      conflicts.push({ hostId: p.id, hostName: p.name, localId: byName.id });
    }
  }
  return { missing, present, conflicts };
}

// Order a missing-set so REQUIRED field/scenery packs come first.  A missing
// field is fatal in the engine (CLIENT_FATAL_FIELD_UNAVAILABLE), whereas missing
// aircraft/ground degrade to a substitute — so the joiner must obtain fields
// before releasing the boot gate (M6/M7), aircraft/ground are best-effort.
export function prioritizeMissing(missing) {
  const isField = (p) => (p.categories || []).includes('scenery');
  const required = [];
  const bestEffort = [];
  for (const p of missing || []) (isField(p) ? required : bestEffort).push(p);
  return { required, bestEffort };
}

export const _internals = { derivePackRoom, buildRoomManifest, diffManifest, prioritizeMissing };
