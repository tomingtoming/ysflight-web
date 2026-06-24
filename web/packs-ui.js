// Pre-boot add-on pack management UI for ysflight-web (milestone M2).
//
// This module wires the engine-agnostic pack core (packs.js) into the browser:
//   - a Module.FS-backed adapter rooted at the IDBFS-persisted YSFLIGHT user dir
//   - a panel grafted onto the existing loading overlay: list installed packs,
//     add one (drag-drop or file picker), see storage usage, then "play"
//   - a run-dependency gate ('ysfw-packs', held in index.html's preRun) so the
//     engine's one-time template scan happens AFTER pack selection — no reload
//
// index.html calls window.ysfwPacksInit() once IDBFS is synced (FS ready, gate
// held).  The smoke test (scripts/smoke-pack.mjs) drives window.ysfwPacks
// directly.  Install/list only here; enable-disable + uninstall land in M3.

import { analyzePackStreaming, MAX_PACK_BYTES } from './packs.js';
import * as opfs from './opfs-store.js';
import { createMemfsLru } from './memfs-lru.js';

const USER_DIR_DEFAULT = '/home/web_user/Documents/YSFLIGHT.COM/YSFLIGHT';
const ACCENT = '#4da3ff';
// MAX_PACK_BYTES (the whole-archive cap, 1.5GB) is defined in packs.js so the engine
// core and this UI share one value; installCore forwards it to analyzePackStreaming.
// NOTE: install still unzips the whole archive in memory (fflate unzipSync); a
// streaming unzip is a follow-up before the very largest (~1GB) packs are smooth.

// Shell UI locale.  Shares index.html's choice (window.ysfwLang); recomputed here
// as a fallback so the module localizes even if loaded standalone (smoke test).
const LANG = (typeof window !== 'undefined' && window.ysfwLang) || (function () {
  try {
    const l = String((new URLSearchParams(location.search).get('lang')) || navigator.language || 'en').toLowerCase();
    return l.indexOf('ja') === 0 ? 'ja' : 'en';
  } catch (e) { return 'en'; }
})();
const S = ({
  ja: {
    emptyList: '（追加パックなし — そのままプレイできます）',
    enabled: '有効', disabled: '無効',
    enableTitle: 'クリックで有効化', disableTitle: 'クリックで無効化',
    errorPrefix: 'エラー: ',
    uninstallTitle: 'アンインストール',
    confirmDelete: (n) => '「' + n + '」を削除しますか？',
    storage: (u, q, p) => '使用容量 ' + u + (q ? ' / ' + q : '') + ' ・ 永続化 ' + (p ? 'ON' : 'OFF'),
    installing: '取り込み中: ',
    bulkProgress: (done, total) => '取り込み中 ' + done + '/' + total + ' …',
    bulkDone: (ok, fail) => '✓ ' + ok + ' 件取り込み' + (fail ? '  ／  ⚠ ' + fail + ' 件失敗（下記）' : ''),
    notZip: '(.zip ではないのでスキップ)',
    panelTitle: '追加パック',
    quickTitle: '🛫 今すぐ飛ぶ',
    quickHint: 'クリックでそのまま離陸（追加パック不要）',
    touchHint: 'スマホ対応：離陸すると画面に操縦スティックが出ます',
    tagBeginner: '👍 はじめての方向け',
    tagIntermediate: '中級者向け',
    tagAirliner: '大型機',
    urlAdd: 'URL から追加',
    urlPlaceholder: 'パック .zip の URL',
    urlBtn: '追加',
    urlFetching: 'URL から取得中…',
    urlFail: '直接取得できませんでした（CORS／ネットワーク）。zip をDLしてドロップしてください',
    urlFail404: (s) => 'URL を取得できませんでした（' + s + '）。リンクが正しいか確認してください',
    dropZone: 'パック (.zip) を1つ以上ドロップ / クリックして選択',
    dropHint: 'zip の直下に aircraft/ scenery/ ground/ などのフォルダがある構成にしてください',
    postPlayHint: 'プレイ開始後、エンジンのメニューで Simulation → Create Flight を開くと、取り込んだ機体・マップが選べます',
    errMap: {
      noList: 'YSFLIGHT のリスト（aircraft/air*.lst など）が見つかりません。zip の直下に aircraft/ や scenery/ があるか確認してください',
      tooBig: 'パックが大きすぎます（サイズ上限を超過）',
      unsafe: 'パック内に不正なパス（..）が含まれています',
      empty: 'パックが空です（有効なファイルがありません）',
      noEntries: 'パックのリストに有効なエントリがありませんでした',
    },
    playBtn: '▶ プレイ開始',
    flyAgain: '↻ 続きから',
    joinFailTitle: '⚠ 必須パックを取得できませんでした',
    joinFailDesc: (names) => 'ホストの必須フィールド' + (names.length ? '「' + names.join('・') + '」' : '') +
      'を取得できませんでした。このまま参加すると正しく飛べません。再試行するか、ソロ（シングルプレイ）で開始してください。',
    retryBtn: '↻ 再試行',
    soloBtn: 'ソロでプレイ',
    joinReason: {
      'no-room': 'ホストがまだ起動していないようです。相手にゲーム開始を頼んでから再試行してください。',
      'timeout': '接続がタイムアウトしました（回線が厳しい可能性）。再試行するか、相手と直結できるか確認してください。',
      'host-left': 'ホストとの接続が切れました。相手がまだホスト中か確認して再試行してください。',
      '_default': 'パックを取得できませんでした。少し待ってから再試行してください。',
    },
  },
  en: {
    emptyList: '(No add-on packs — you can play as-is)',
    enabled: 'On', disabled: 'Off',
    enableTitle: 'Click to enable', disableTitle: 'Click to disable',
    errorPrefix: 'Error: ',
    uninstallTitle: 'Uninstall',
    confirmDelete: (n) => 'Delete “' + n + '”?',
    storage: (u, q, p) => 'Storage ' + u + (q ? ' / ' + q : '') + ' · Persisted ' + (p ? 'ON' : 'OFF'),
    installing: 'Installing: ',
    bulkProgress: (done, total) => 'Importing ' + done + '/' + total + '…',
    bulkDone: (ok, fail) => '✓ ' + ok + ' imported' + (fail ? '  /  ⚠ ' + fail + ' failed (below)' : ''),
    notZip: '(skipped: not a .zip)',
    panelTitle: 'Add-on packs',
    quickTitle: '🛫 Quick flight',
    quickHint: 'Click to take off right away (no add-on needed)',
    touchHint: 'Touch-ready: an on-screen stick appears once you take off.',
    tagBeginner: '👍 Beginner',
    tagIntermediate: 'Intermediate',
    tagAirliner: 'Airliner',
    urlAdd: 'Add from URL',
    urlPlaceholder: 'URL of a pack .zip',
    urlBtn: 'Add',
    urlFetching: 'Fetching from URL…',
    urlFail: 'Could not fetch directly (CORS / network). Download the zip and drop it here',
    urlFail404: (s) => 'Could not fetch the URL (' + s + '). Check the link is correct',
    dropZone: 'Drop one or more packs (.zip) / click to choose',
    dropHint: 'The zip should have folders like aircraft/ scenery/ ground/ at its top level',
    postPlayHint: 'After Play, open Simulation → Create Flight in the engine menu to fly your installed aircraft & maps',
    errMap: {
      noList: 'No YSFLIGHT list found (aircraft/air*.lst, etc.). Make sure the zip has folders like aircraft/ or scenery/ at its top level',
      tooBig: 'The pack is too large (exceeds the size limit)',
      unsafe: 'The pack contains an unsafe path (..)',
      empty: 'The pack is empty (no usable files)',
      noEntries: 'The pack lists contained no usable entries',
    },
    playBtn: '▶ Play',
    flyAgain: '↻ Fly again',
    joinFailTitle: '⚠ Couldn’t obtain required packs',
    joinFailDesc: (names) => 'Couldn’t obtain the host’s required field' + (names.length ? ' “' + names.join(', ') + '”' : '') +
      '. Joining now would not fly correctly. Retry, or start in solo (single-player).',
    retryBtn: '↻ Retry',
    soloBtn: 'Play solo',
    joinReason: {
      'no-room': 'The host doesn’t seem to be up yet — ask your friend to start the game, then retry.',
      'timeout': 'The connection timed out (the network may be restrictive). Retry, or check that you can connect directly.',
      'host-left': 'Lost the connection to the host. Make sure they’re still hosting, then retry.',
      '_default': 'Could not obtain the pack. Wait a moment, then retry.',
    },
  },
})[LANG];

let FS = null;
let adapter = null;
// layer3 (docs/asyncify-lazy-pack.md): bounds resident MEMFS payload so long
// sessions across many packs do not grow the wasm linear memory into its ceiling.
// Created once FS is ready (setupFS); evicts LRU payload via FS.unlink, which the
// openat hook transparently re-materializes on next open.
let lru = null;
let listEl = null;
let storageEl = null;
// In-memory source of truth for the installed-pack list shown in the panel.
// Loaded ONCE from OPFS (ensureCache), then kept up to date in memory on
// install/enable/uninstall.  The panel renders from this -- never from a fresh
// OPFS directory enumeration, which can briefly under-report right after a burst
// of writes (e.g. a bulk import).
let cache = null;

// SHA-256 over a Uint8Array via Web Crypto (secure context: https or localhost).
async function webSha256(bytes) {
  if (!self.crypto || !self.crypto.subtle) {
    throw new Error('Web Crypto unavailable (needs https or localhost)');
  }
  const digest = await self.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function rmrf(fs, path) {
  let st;
  try {
    st = fs.stat(path);
  } catch (e) {
    return;
  }
  if (fs.isDir(st.mode)) {
    for (const name of fs.readdir(path)) {
      if (name === '.' || name === '..') continue;
      rmrf(fs, path + '/' + name);
    }
    fs.rmdir(path);
  } else {
    fs.unlink(path);
  }
}

// packs.js adapter over Module.FS; the adapter root is the YSFLIGHT user dir, so
// all paths it sees are relative to it (e.g. "packs/<id>/...", "aircraft/x.lst").
function makeFsAdapter(fs, root) {
  const abs = (p) => (p ? root + '/' + p : root);
  const parent = (p) => p.replace(/\/[^/]*$/, '');
  return {
    async exists(p) {
      try {
        fs.stat(abs(p));
        return true;
      } catch (e) {
        return false;
      }
    },
    async mkdirp(p) {
      fs.mkdirTree(abs(p));
    },
    async writeFile(p, bytes) {
      const a = abs(p);
      fs.mkdirTree(parent(a));
      fs.writeFile(a, bytes);
    },
    async readFile(p) {
      return fs.readFile(abs(p), { encoding: 'binary' });
    },
    async rename(from, to) {
      const a = abs(to);
      fs.mkdirTree(parent(a));
      fs.rename(abs(from), a);
    },
    async rmrf(p) {
      rmrf(fs, abs(p));
    },
  };
}

// The installed-pack index now lives in OPFS (the content-addressed store is the
// source of truth); map its records to the shape the panel + pack-net expect.
async function readIndex() {
  try {
    return (await opfs.listRecords()).map((r) => ({
      id: r.id, name: r.name, enabled: r.enabled !== false, bytes: r.bytes, categories: r.categories,
    }));
  } catch (e) {
    return [];
  }
}

// Load the in-memory list once (at a quiet moment, so the OPFS read is reliable),
// then keep it in memory.  All other reads of the list go through `cache`.
// Memoised on a PROMISE, not on the value: concurrent callers (e.g. the panel's
// fire-and-forget refresh racing a bulk import) must share ONE readIndex and
// assign `cache` exactly once -- a plain `if (cache === null) cache = await ...`
// is a check-then-act race where a late, empty readIndex clobbers a cache the
// import workers have already filled.
let cacheLoad = null;
async function ensureCache() {
  if (cache !== null) return cache;
  if (cacheLoad === null) cacheLoad = readIndex();
  const loaded = await cacheLoad;
  if (cache === null) cache = loaded; // first resolver wins; never overwrite
  return cache;
}
// Synchronous in-memory upsert/remove (no await between read and write, so it is
// safe under the concurrent bulk-import workers).
function cacheUpsert(entry) {
  if (cache === null) return;
  const i = cache.findIndex((p) => p.id === entry.id);
  if (i >= 0) cache.splice(i, 1, entry); else cache.push(entry);
}
function cacheUpdate(id, patch) {
  if (cache === null) return;
  const e = cache.find((p) => p.id === id);
  if (e) Object.assign(e, patch);
}
function cacheRemove(id) {
  if (cache !== null) cache = cache.filter((p) => p.id !== id);
}

// public-surface for list() now returns the in-memory cache (loading it if needed)
async function listInstalled() { return (await ensureCache()).slice(); }

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}

// Ask the browser to keep our IndexedDB data from being evicted, and report use.
async function storageInfo() {
  const out = { persisted: false, usage: 0, quota: 0 };
  try {
    if (navigator.storage) {
      if (navigator.storage.persisted) out.persisted = await navigator.storage.persisted();
      if (!out.persisted && navigator.storage.persist) out.persisted = await navigator.storage.persist();
      if (navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        out.usage = e.usage || 0;
        out.quota = e.quota || 0;
      }
    }
  } catch (e) {
    /* non-fatal */
  }
  return out;
}

// Render the installed-pack rows for a given list (no I/O).  Used by refresh() and
// by the bulk import (which renders from its in-memory result to avoid a flaky
// post-bulk OPFS directory re-enumeration).
function renderList(packs) {
  if (!listEl) return;
  listEl.innerHTML = '';
  if (packs.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = S.emptyList;
    empty.style.cssText = 'color:#5d7290;font-size:13px;padding:6px 0';
    listEl.appendChild(empty);
  } else {
    for (const p of packs) {
      const enabled = p.enabled !== false;
      const row = document.createElement('div');
      row.style.cssText =
        'display:flex;justify-content:space-between;align-items:center;gap:10px;' +
        'padding:7px 10px;border:1px solid #2a3647;border-radius:6px;margin-bottom:6px;background:#0d141d;' +
        (enabled ? '' : 'opacity:.5');
      const left = document.createElement('div');
      left.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      const nm = document.createElement('span');
      nm.textContent = p.name || p.id;
      nm.style.cssText = 'color:#e6edf3;font-size:14px';
      const cat = document.createElement('span');
      cat.textContent = '  ' + (p.categories || []).join('/') + ' · ' + fmtBytes(p.bytes || 0);
      cat.style.cssText = 'color:#8fa3bb;font-size:12px';
      left.appendChild(nm);
      left.appendChild(cat);

      const ctl = document.createElement('div');
      ctl.style.cssText = 'flex:none;display:flex;gap:6px;align-items:center';
      const toggle = document.createElement('button');
      toggle.textContent = enabled ? S.enabled : S.disabled;
      toggle.title = enabled ? S.disableTitle : S.enableTitle;
      toggle.style.cssText =
        'font-size:12px;padding:4px 9px;border-radius:5px;cursor:pointer;border:1px solid ' +
        (enabled
          ? ACCENT + ';background:rgba(77,163,255,.12);color:' + ACCENT
          : '#2a3647;background:#0d141d;color:#8fa3bb');
      const setErr = (e) => {
        const s = document.getElementById('ysfw-pack-status');
        if (s) s.textContent = S.errorPrefix + (e && e.message ? e.message : e);
      };
      toggle.addEventListener('click', async () => {
        toggle.disabled = true;
        try {
          await window.ysfwPacks.setEnabled(p.id, !enabled);
        } catch (e) {
          setErr(e);
        }
      });
      const del = document.createElement('button');
      del.textContent = '🗑';
      del.title = S.uninstallTitle;
      del.style.cssText =
        'font-size:12px;padding:4px 8px;border-radius:5px;border:1px solid #2a3647;background:#0d141d;color:#c75d6a;cursor:pointer';
      del.addEventListener('click', async () => {
        if (!self.confirm(S.confirmDelete(p.name || p.id))) return;
        del.disabled = true;
        try {
          await window.ysfwPacks.uninstall(p.id);
        } catch (e) {
          setErr(e);
        }
      });
      ctl.appendChild(toggle);
      ctl.appendChild(del);

      row.appendChild(left);
      row.appendChild(ctl);
      listEl.appendChild(row);
    }
  }
}

async function updateStorageLine() {
  if (!storageEl) return;
  try {
    const s = await storageInfo();
    storageEl.textContent = S.storage(fmtBytes(s.usage), s.quota ? fmtBytes(s.quota) : '', s.persisted);
  } catch (e) { /* non-fatal */ }
}

async function refresh() {
  renderList(await ensureCache());
  await updateStorageLine();
}

async function sync() {
  await new Promise((resolve) => FS.syncfs(false, () => resolve())); // persist to IndexedDB
}

// Install one pack WITHOUT the per-pack syncfs + panel re-render (the caller does
// those once for a whole batch -- a per-pack full-tree syncfs and a re-render of a
// growing list are O(n) / O(n^2) and dominate a bulk import of hundreds of packs).
async function installCore(bytes, name, sourceUrl) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Path A: analyze (streaming, no whole-archive memory peak), store the payload
  // content-addressed in OPFS (on disk, deduped), then materialize it into the
  // engine FS -- payload into the MEMFS-mounted packs/ (excluded from IDBFS sync)
  // and the tiny generated lists into the IDBFS user dir.
  // maxFileBytes is forwarded = the whole-pack budget: with only maxPackBytes set,
  // analyzePackStreaming falls back to its 64MB per-file default and would reject a
  // sub-1.5GB pack that holds one large file (e.g. a big scenery .fld), contradicting
  // the lifted pack budget.
  let a = null, recordWritten = false;
  try {
    a = await analyzePackStreaming(buf, {
      sha256: webSha256, putBlob: opfs.putBlob, name, sourceUrl,
      maxPackBytes: MAX_PACK_BYTES, maxFileBytes: MAX_PACK_BYTES,
    });
    await opfs.putRecordFromAnalysis(a, { enabled: true });
    recordWritten = true;
    await opfs.materialize(await opfs.getRecord(a.id), adapter, { metaOnly: true }); // listing only; payload on demand
    // Keep the in-memory list in sync (sync section, no await -> safe vs. the
    // concurrent bulk-import workers) so the panel never has to re-enumerate OPFS.
    cacheUpsert({ id: a.id, name: a.name, enabled: true, bytes: a.total, categories: a.categories });
  } catch (e) {
    // A failed import must leave NO record behind: materializeEnabled enumerates
    // OPFS records at boot, so a record written before a materialize failure would
    // resurrect as a phantom pack on the next reload.  Orphan payload blobs are
    // reclaimed by the caller's gc() (reference-counted, so a blob shared with a
    // sibling pack that DID install survives).
    if (recordWritten && a) { try { await opfs.removeRecord(a.id); } catch (_) {} }
    throw e;
  }
  return {
    id: a.id, name: a.name, categories: a.categories, bytes: a.total,
    templates: a.generated.reduce((n, g) => n + g.entries, 0), lists: a.generated.map((g) => g.file),
  };
}

// Single-pack install (used by the multiplayer pack sync + the smoke test): does
// the syncfs + refresh itself.
async function installFromBytes(bytes, name, sourceUrl) {
  if (!adapter) throw new Error('pack layer not ready');
  let res;
  try {
    res = await installCore(bytes, name, sourceUrl);
  } catch (e) {
    try { await opfs.gc(); } catch (_) {} // reclaim blobs the rejected pack streamed in
    throw e;
  }
  await sync(); // persist the tiny lists (payload lives in OPFS + the MEMFS mount)
  await refresh();
  return res;
}

async function setEnabled(id, enabled) {
  if (!adapter) throw new Error('pack layer not ready');
  const rec = await opfs.setEnabled(id, enabled);
  if (enabled) await opfs.materialize(rec, adapter, { metaOnly: true }); // write listing only; payload on demand
  else for (const g of rec.generated) await adapter.rmrf(g.file);        // drop lists -> engine won't scan it
  cacheUpdate(id, { enabled: !!enabled });
  await sync();
  await refresh();
  return { id, enabled: !!enabled };
}

async function uninstall(id) {
  if (!adapter) throw new Error('pack layer not ready');
  const rec = await opfs.getRecord(id);
  if (rec) {
    // Remove the record FIRST: a ysfwMaterializeForOpen that has not yet resolved its
    // opfs.getRecord(id) now gets null and bails, so it cannot resurrect a payload file
    // (and re-add a stale LRU entry) after the rmrf/forget below.
    await opfs.removeRecord(id);
    for (const g of rec.generated) await adapter.rmrf(g.file); // remove generated lists (IDBFS)
    await adapter.rmrf('packs/' + id);                          // remove materialized payload (MEMFS)
    if (lru) lru.forgetPrefix('packs/' + id + '/');             // drop its LRU accounting
    forgetPrefetchForId(id);                                    // and its prefetch guard entries
    await opfs.gc();                                            // reclaim now-unreferenced blobs
  }
  cacheRemove(id);
  await sync();
  await refresh();
  return { id, removed: true };
}

function start() {
  const M = window.Module;
  if (M && M.__ysfwGateHeld) {
    M.removeRunDependency('ysfw-packs');
    M.__ysfwGateHeld = false;
  }
  const panel = document.getElementById('ysfw-pack-panel');
  if (panel) panel.style.display = 'none';
}

// Map a raw packs.js install error to short, localized guidance (shared by the
// drop/file bulk import and the URL import).  Matches the streaming-path messages
// (analyzePackStreaming); unknown messages pass through raw so nothing is hidden.
function friendlyErr(msg) {
  const m = String((msg && msg.message) || msg || '');
  if (m.indexOf('no YSFLIGHT list found') !== -1) return S.errMap.noList;
  if (m.indexOf('pack exceeds') !== -1 || m.indexOf('file exceeds') !== -1) return S.errMap.tooBig;
  if (m.indexOf('unsafe path') !== -1) return S.errMap.unsafe;
  if (m.indexOf('pack is empty') !== -1) return S.errMap.empty;
  if (m.indexOf('no usable entries') !== -1) return S.errMap.noEntries;
  return m;
}

// Import a batch of dropped/picked files.  Processing CONTINUES past failures and,
// at the end, summarises (count) and WARNS with the list of packs that could not
// be imported.  Speed: the old per-pack overhead -- a full-tree IDBFS syncfs and a
// re-render of a growing list per install (O(n) / O(n^2)) -- now happens ONCE for
// the whole batch, and a few packs are imported concurrently to overlap the
// OPFS-write / hashing I/O (the unzip itself is CPU-bound and stays serialised).
async function handleFiles(fileList) {
  if (!adapter) return;
  const status = document.getElementById('ysfw-pack-status');
  const all = Array.from(fileList);
  const zips = all.filter((f) => /\.zip$/i.test(f.name));
  const nonZip = all.filter((f) => !/\.zip$/i.test(f.name));
  const failed = [];          // { name, error }
  await ensureCache();        // load the in-memory list once (reliable: nothing writing yet)
  let okCount = 0, done = 0;
  const total = zips.length;
  // The tail (failure warnings + skipped non-zips) is shown under every status
  // line.  We set the PROGRESS line during the run and the DONE summary only at
  // the very end -- AFTER the list is rendered -- so the panel never shows
  // "✓ done" next to an empty list.
  const tail = () => [
    ...failed.map((f) => '✗ ' + f.name + ': ' + friendlyErr(f.error)),
    ...nonZip.map((f) => '— ' + f.name + ' ' + S.notZip),
  ];
  const setStatus = (head) => { if (status) status.textContent = [head, ...tail()].join('\n'); };
  setStatus(S.bulkProgress(0, total));

  let idx = 0;
  const worker = async () => {
    while (idx < zips.length) {
      const file = zips[idx++];
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await installCore(bytes, file.name.replace(/\.zip$/i, '')); // also upserts `cache`
        okCount++;
      } catch (e) {
        failed.push({ name: file.name, error: (e && e.message) ? e.message : String(e) });
      }
      done++;
      setStatus(S.bulkProgress(done, total));
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, zips.length || 1) }, worker));

  // Every rejected pack (chooseLayout miss, size cap, ...) streamed its payload
  // blobs into OPFS before it threw; with rejection a DESIGNED, common outcome
  // (~13 of the 223-pack corpus), reclaim those orphans in ONE reference-counted
  // pass.  gc keeps blobs any installed pack still references, so it is safe to
  // run after the whole batch; skip it entirely when nothing failed.
  if (failed.length) { try { await opfs.gc(); } catch (_) {} }

  await sync(); // one IDBFS sync for the whole batch (not per pack)
  // Re-render the list ONCE, from the in-memory `cache` (which each installCore
  // already upserted into).  We deliberately do NOT re-enumerate OPFS here: a
  // directory listing immediately after a burst of writes can briefly under-report,
  // and we already know exactly what we stored.
  renderList(cache);
  await updateStorageLine();
  setStatus(S.bulkDone(okCount, failed.length)); // done summary LAST, after the list is shown
}

function renderPanel() {
  const overlay = document.getElementById('overlay');
  if (!overlay || document.getElementById('ysfw-pack-panel')) return;

  // The .data download is already complete by the time the panel shows (the gate
  // is held only to await the user's "Play").  This shell has no
  // monitorRunDependencies, so Emscripten's last "Downloading data… (n/n)"
  // setStatus is never cleared and the full progress bar lingers above the
  // panel.  Clear both so the panel isn't crowned by a stale "downloading".
  const shellStatus = document.getElementById('status');
  if (shellStatus) shellStatus.textContent = '';
  const shellProgress = document.getElementById('progress');
  if (shellProgress) shellProgress.style.display = 'none';

  const panel = document.createElement('div');
  panel.id = 'ysfw-pack-panel';
  panel.style.cssText =
    'margin-top:22px;width:min(460px,86vw);background:#0b121b;border:1px solid #1d2633;' +
    'border-radius:10px;padding:16px 16px 14px;text-align:left;box-shadow:0 8px 30px rgba(0,0,0,.4)';

  // Quick Flight: one-click presets that deep-link into ?freeflight=AIRCRAFT,FIELD,
  // STARTPOS.  Every triple is VERIFIED to ship in the base bundle (so it works
  // offline on first load) and to reference a real .stp start position.  The most
  // prominent thing in the panel -- a new player flies immediately, no install.
  const quickWrap = document.createElement('div');
  quickWrap.style.cssText = 'margin-bottom:14px';
  const qTitle = document.createElement('div');
  qTitle.textContent = S.quickTitle;
  qTitle.style.cssText = 'color:#e6edf3;font-size:14px;font-weight:600;letter-spacing:.04em;margin-bottom:2px';
  quickWrap.appendChild(qTitle);
  const qHint = document.createElement('div');
  qHint.textContent = S.quickHint;
  qHint.style.cssText = 'color:#5d7290;font-size:11px;margin-bottom:8px';
  quickWrap.appendChild(qHint);
  // On touch devices, surface the taster value (on-screen stick after takeoff) ON the
  // top page, not only once already in flight.  Inline the coarse-pointer test (no
  // named const) so it never collides with other coarse checks in renderPanel.
  if ((window.matchMedia && matchMedia('(pointer: coarse)').matches) ||
      navigator.maxTouchPoints > 0 || ('ontouchstart' in window)) {
    const touchHint = document.createElement('div');
    touchHint.textContent = S.touchHint;
    touchHint.style.cssText = 'color:#8fa3bb;font-size:11px;margin-bottom:8px';
    quickWrap.appendChild(touchHint);
  }
  const qGrid = document.createElement('div');
  qGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px';
  // tag is a difficulty hint (localized via the S table) so a newcomer can pick the
  // easy one; the Cessna is flagged `recommended` and gets the accent treatment so it
  // visibly out-weighs the (demoted) join button and the harder jets.
  const PRESETS = [
    { name: 'Cessna 172', sub: 'Small Map', ff: 'CESSNA_172R,SMALL_MAP,RW36_01', tag: S.tagBeginner, recommended: true },
    { name: 'F/A-18 Hornet', sub: '厚木 / Atsugi', ff: 'F-18C_HORNET,ATSUGI_AIRBASE,RW01_01', tag: S.tagIntermediate },
    { name: 'F-15J Eagle', sub: 'Hawaii ✈ 空中', ff: 'F-15J_EAGLE,HAWAII,NORTH10000_01', tag: S.tagIntermediate },
    { name: 'Boeing 747', sub: 'Heathrow', ff: 'B747,HEATHROW,RW27R', tag: S.tagAirliner },
  ];
  const curLang = new URLSearchParams(location.search).get('lang');
  for (const p of PRESETS) {
    const card = document.createElement('button');
    // Accent ONLY the recommended (beginner) card so it visibly leads; the harder
    // presets keep the quiet #243244 border (accenting all four would dilute the
    // hierarchy against the accent Play/URL buttons).
    card.style.cssText = 'text-align:left;padding:9px 11px;border-radius:8px;cursor:pointer;border:1px solid ' +
      (p.recommended ? ACCENT + ';background:rgba(77,163,255,.08)' : '#243244;background:#0d141d');
    const nm = document.createElement('div');
    nm.textContent = '▶ ' + p.name;
    nm.style.cssText = 'color:#e6edf3;font-size:13px;font-weight:600';
    const sub = document.createElement('div');
    sub.textContent = p.sub;
    sub.style.cssText = 'color:#8fa3bb;font-size:11px;margin-top:1px';
    card.appendChild(nm);
    card.appendChild(sub);
    if (p.tag) {
      const tag = document.createElement('div');
      tag.textContent = p.tag;
      tag.style.cssText = 'margin-top:5px;font-size:10px;' +
        (p.recommended ? 'color:' + ACCENT + ';font-weight:700' : 'color:#5d7290');
      card.appendChild(tag);
    }
    card.addEventListener('click', () => {
      location.assign(location.origin + location.pathname + '?freeflight=' + p.ff + (curLang ? '&lang=' + encodeURIComponent(curLang) : ''));
    });
    qGrid.appendChild(card);
  }
  // Returning visitor fast-path: if the last Quick Flight matches a BUNDLED preset,
  // surface a one-tap "Fly again" above the grid.  Gated to bundled presets so it can
  // never deep-link into an uninstalled add-on (an arbitrary saved triple could).
  // Read is guarded -- localStorage may be unavailable (private mode).
  let lastFlight = null;
  try { lastFlight = localStorage.getItem('ysfwLastFlight'); } catch (e) {}
  const lastPreset = lastFlight ? PRESETS.find((p) => p.ff === lastFlight) : null;
  if (lastPreset) {
    const again = document.createElement('button');
    again.style.cssText = 'display:block;width:100%;text-align:left;padding:10px 12px;margin-bottom:8px;border:1px solid ' + ACCENT + ';border-radius:8px;background:rgba(77,163,255,.12);cursor:pointer';
    const an = document.createElement('div');
    an.textContent = S.flyAgain + ' ' + lastPreset.name;
    an.style.cssText = 'color:#e6edf3;font-size:13px;font-weight:700';
    const as = document.createElement('div');
    as.textContent = lastPreset.sub;
    as.style.cssText = 'color:#9db4d0;font-size:11px;margin-top:1px';
    again.appendChild(an);
    again.appendChild(as);
    again.addEventListener('click', () => {
      location.assign(location.origin + location.pathname + '?freeflight=' + lastPreset.ff + (curLang ? '&lang=' + encodeURIComponent(curLang) : ''));
    });
    quickWrap.appendChild(again);
  }
  quickWrap.appendChild(qGrid);
  panel.appendChild(quickWrap);

  const title = document.createElement('div');
  title.textContent = S.panelTitle;
  title.style.cssText = 'color:#e6edf3;font-size:14px;font-weight:600;letter-spacing:.04em;margin-bottom:10px';
  panel.appendChild(title);
  // Where do installed packs show up?  The biggest modder drop-off is not knowing
  // the aircraft/maps appear under the engine's Simulation -> Create Flight.
  const postPlay = document.createElement('div');
  postPlay.textContent = S.postPlayHint;
  postPlay.style.cssText = 'color:#5d7290;font-size:11px;margin:-4px 0 10px;line-height:1.5';
  panel.appendChild(postPlay);

  listEl = document.createElement('div');
  listEl.id = 'ysfw-pack-list';
  // Cap the installed-pack list and scroll it internally, so importing hundreds of
  // packs keeps the panel (drop zone, status, Play button) within the viewport.
  listEl.style.cssText = 'max-height:40vh;overflow-y:auto';
  panel.appendChild(listEl);

  // Drop zone + file picker.
  const drop = document.createElement('label');
  drop.style.cssText =
    'display:block;margin-top:8px;padding:14px;border:1px dashed #2a3647;border-radius:8px;' +
    'color:#8fa3bb;font-size:13px;text-align:center;cursor:pointer;transition:border-color .15s,background .15s';
  drop.textContent = S.dropZone;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.zip';
  input.multiple = true;
  input.style.display = 'none';
  input.addEventListener('change', () => handleFiles(input.files));
  drop.appendChild(input);
  ['dragover', 'dragenter'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.style.borderColor = ACCENT;
      drop.style.background = 'rgba(77,163,255,.06)';
    }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.style.borderColor = '#2a3647';
      drop.style.background = 'transparent';
    }),
  );
  drop.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
  });
  panel.appendChild(drop);
  const dropHintEl = document.createElement('div');
  dropHintEl.textContent = S.dropHint;
  dropHintEl.style.cssText = 'color:#5d7290;font-size:10.5px;margin-top:4px;text-align:center';
  panel.appendChild(dropHintEl);

  // Install from a URL: the browser fetches the .zip directly (pure-pipe / no
  // hosting).  On a CORS / dead-link failure, fall back to "download & drop".  The
  // URL is recorded as sourceUrl so a host can later re-advertise it (Option B).
  const urlRow = document.createElement('div');
  urlRow.style.cssText = 'display:flex;gap:6px;margin-top:8px';
  const urlIn = document.createElement('input');
  urlIn.type = 'url';
  urlIn.placeholder = S.urlPlaceholder;
  urlIn.style.cssText = 'flex:1;min-width:0;padding:8px 10px;border:1px solid #2a3647;border-radius:6px;background:#0d141d;color:#e6edf3;font-size:12px';
  const urlBtn = document.createElement('button');
  urlBtn.textContent = S.urlBtn;
  urlBtn.title = S.urlAdd;
  urlBtn.style.cssText = 'flex:none;padding:8px 14px;border:1px solid ' + ACCENT + ';border-radius:6px;background:rgba(77,163,255,.12);color:' + ACCENT + ';font-size:12px;cursor:pointer';
  const doUrl = async () => {
    const url = urlIn.value.trim();
    if (!url) return;
    urlBtn.disabled = true;
    if (status) status.textContent = S.urlFetching;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const name = (url.split('?')[0].split('/').pop() || 'pack').replace(/\.zip$/i, '') || 'pack';
      await installFromBytes(bytes, name, url); // does sync + refresh; records sourceUrl
      urlIn.value = '';
    } catch (e) {
      // Three distinct failures, distinguished by the error (res is out of scope in
      // a CORS rejection): a non-ok response = Error('HTTP <status>') (404 etc.); a
      // valid URL that served a BAD pack = a packs.js analysis error (route it to the
      // same friendly guidance as a dropped bad zip, not a misleading "can't fetch");
      // a real CORS/network failure = a TypeError with no status.
      const m = (e && e.message) || String(e);
      const http = /^HTTP (\d.*)$/.exec(m);
      const packErr = /no YSFLIGHT list found|pack exceeds|file exceeds|unsafe path|pack is empty|no usable entries/.test(m);
      if (status) {
        status.textContent = http ? S.urlFail404(http[1]) + ': ' + url
          : packErr ? friendlyErr(m)
          : S.urlFail + ': ' + url;
      }
    } finally {
      urlBtn.disabled = false;
    }
  };
  urlBtn.addEventListener('click', doUrl);
  urlIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doUrl(); } });
  urlRow.appendChild(urlIn);
  urlRow.appendChild(urlBtn);
  panel.appendChild(urlRow);

  const status = document.createElement('div');
  status.id = 'ysfw-pack-status';
  status.style.cssText = 'color:#8fa3bb;font-size:12px;min-height:1.2em;margin-top:8px;white-space:pre-line;max-height:7.5em;overflow:auto';
  panel.appendChild(status);

  storageEl = document.createElement('div');
  storageEl.style.cssText = 'color:#5d7290;font-size:11px;margin-top:4px';
  panel.appendChild(storageEl);

  const playBtn = document.createElement('button');
  playBtn.id = 'ysfw-pack-play';
  playBtn.textContent = S.playBtn;
  playBtn.style.cssText =
    'margin-top:14px;width:100%;padding:11px;border:0;border-radius:8px;background:' + ACCENT + ';' +
    'color:#04101f;font-size:15px;font-weight:700;cursor:pointer';
  playBtn.addEventListener('click', start);
  panel.appendChild(playBtn);

  // On touch devices, put the Quick Flight panel ABOVE the Room-ID join form so the
  // primary action is the first thing a thumb reaches (the join form renders earlier,
  // synchronously, from index.html).  Fine-pointer PCs keep DOM order (the panel sits
  // below the form there, which is fine with the keyboard/legend available).
  const coarse = (window.matchMedia && matchMedia('(pointer: coarse)').matches) ||
    navigator.maxTouchPoints > 0 || ('ontouchstart' in window);
  const joinForm = document.getElementById('ysfw-manual-join');
  if (coarse && joinForm) overlay.insertBefore(panel, joinForm);
  else overlay.appendChild(panel);
  refresh();
}

// Obtain-failure UX (M7): a ?join pre-boot sync could not obtain one or more
// REQUIRED field/scenery packs (Option B URL self-fetch AND Option A host push
// both failed — e.g. an unreachable peer with no TURN, or a dead URL).  A missing
// field is fatal in the engine, so instead of booting silently into a session
// that will desync/disconnect, show an explicit panel: Retry the obtain, or play
// Solo (single-player).  index.html holds the boot gate until the user chooses.
//   failed:   [{ id, name, categories }]  (the required packs not obtained)
//   handlers: { onRetry(), onSolo() }
function showJoinFailure(failed, handlers) {
  const M = window.Module;
  if (M) M.__ysfwJoinFailureShown = true;
  const overlay = document.getElementById('overlay');
  if (!overlay) { if (handlers && handlers.onSolo) handlers.onSolo(); return; } // no UI host -> degrade to solo
  const existing = document.getElementById('ysfw-join-failure');
  if (existing) existing.remove(); // a Retry re-renders fresh

  const panel = document.createElement('div');
  panel.id = 'ysfw-join-failure';
  panel.style.cssText =
    'margin-top:22px;width:min(460px,86vw);background:#1a1010;border:1px solid #5a2a2a;' +
    'border-radius:10px;padding:16px 16px 14px;text-align:left;box-shadow:0 8px 30px rgba(0,0,0,.4)';

  const title = document.createElement('div');
  title.textContent = S.joinFailTitle;
  title.style.cssText = 'color:#f0c0c0;font-size:14px;font-weight:600;letter-spacing:.03em;margin-bottom:8px';
  panel.appendChild(title);

  const names = (failed || []).map((f) => f && (f.name || f.id)).filter(Boolean);
  const desc = document.createElement('div');
  desc.style.cssText = 'color:#cbb;font-size:12px;line-height:1.6;margin-bottom:12px';
  desc.textContent = S.joinFailDesc(names);
  panel.appendChild(desc);

  // Per-pack failure reason (timeout / host-not-up / host-left / …) so Retry is an
  // informed choice, not a blind guess.  reason comes from pack-net's failed[] joined
  // onto requiredFailed; unknown/compound reasons (id-mismatch:*, raw errors) and the
  // no-reason syncError path fall back to a generic line / show nothing.
  const reasonKey = (reason) => {
    const r = String(reason || '');
    return (r === 'no-room' || r === 'timeout' || r === 'host-left') ? r : '_default';
  };
  const reasonSeen = new Set();
  const reasonLines = [];
  for (const f of (failed || [])) {
    if (!f || !f.reason) continue;
    const k = reasonKey(f.reason);
    if (reasonSeen.has(k)) continue;
    reasonSeen.add(k);
    reasonLines.push('• ' + ((S.joinReason && (S.joinReason[k] || S.joinReason._default)) || ''));
  }
  if (reasonLines.length) {
    const why = document.createElement('div');
    why.style.cssText = 'color:#d8b9b9;font-size:12px;line-height:1.6;margin-bottom:12px;white-space:pre-line';
    why.textContent = reasonLines.join('\n');
    panel.appendChild(why);
  }

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:10px';

  const retryBtn = document.createElement('button');
  retryBtn.id = 'ysfw-join-retry';
  retryBtn.textContent = S.retryBtn;
  retryBtn.style.cssText =
    'flex:1;padding:11px;border:0;border-radius:8px;background:' + ACCENT + ';color:#04101f;font-size:14px;font-weight:700;cursor:pointer';
  retryBtn.addEventListener('click', () => {
    retryBtn.disabled = true; soloBtn.disabled = true;
    panel.remove();
    if (handlers && handlers.onRetry) handlers.onRetry();
  });

  const soloBtn = document.createElement('button');
  soloBtn.id = 'ysfw-join-solo';
  soloBtn.textContent = S.soloBtn;
  soloBtn.style.cssText =
    'flex:1;padding:11px;border:1px solid #2a3647;border-radius:8px;background:#0d141d;color:#cfd8e3;font-size:14px;cursor:pointer';
  soloBtn.addEventListener('click', () => {
    retryBtn.disabled = true; soloBtn.disabled = true;
    panel.remove();
    if (handlers && handlers.onSolo) handlers.onSolo();
  });

  row.appendChild(retryBtn);
  row.appendChild(soloBtn);
  panel.appendChild(row);
  overlay.appendChild(panel);
}

// Bind the FS adapter.  Called early in preRun (before the launch-mode logic) so
// materializeEnabled() and installs have a working adapter regardless of mode.
function setupFS() {
  const M = window.Module;
  if (!M || !M.FS) return false;
  if (!adapter) {
    FS = M.FS;
    const root = M.__ysfwUserDir || USER_DIR_DEFAULT;
    adapter = makeFsAdapter(FS, root);
    // layer3 LRU: keys are engine-relative payload paths ("packs/<id>/<rel>"); the
    // unlink maps a key back to its absolute MEMFS path.  Budget is overridable via
    // window.__ysfwMemfsBudget = { highWater, lowWater } (bytes) for tuning/tests.
    lru = createMemfsLru({
      ...(window.__ysfwMemfsBudget || {}),
      unlink: (key) => { try { FS.unlink(root + '/' + key); } catch (e) { /* already gone */ } },
    });
  }
  window.ysfwPacks.fsReady = true;
  return true;
}

// Metadata the engine reads via its directory GLOB at scan time (.lst) or by fixed
// path during selection (.dat/.stp).  These are PINNED -- never LRU-tracked or
// evicted: an evicted .lst would silently vanish from the menu (the glob would not
// re-discover it), unlike payload, which the openat hook re-materializes on open.
// Mirrors META_EXT in opfs-store.js.
const PINNED_EXT = /\.(lst|dat|stp)$/i;

// Record an on-demand-materialized PAYLOAD file in the LRU (skips pinned metadata).
// Eviction is a separate step (sweepLru) so a multi-file burst tracks all of its
// files before a single sweep.
function trackMaterialized(rec, id, relPath) {
  if (!lru || PINNED_EXT.test(relPath)) return;
  const f = rec.files.find((x) => x.path === relPath);
  if (f) lru.track('packs/' + id + '/' + relPath, f.size || 0);
}

// Evict LRU payload if resident bytes crossed the high-water mark.  `protect` holds
// the keys currently being materialized (residentInFlight), which must never be
// evicted out from under an in-flight open.
function sweepLru(protect) {
  if (!lru) return;
  const evicted = lru.sweep(protect);
  if (!evicted.length) return;
  invalidatePrefetch(evicted); // evicted payload -> let a later re-highlight re-prefetch
  const s = lru.stats();
  console.log('[packs] memfs LRU evicted ' + evicted.length + ' file(s) -> resident ' +
    fmtBytes(s.total) + ' / ' + fmtBytes(s.highWater));
}

// Materialize every ENABLED pack's LISTING from OPFS into the engine FS before the
// engine's one-time template scan: only the lightweight metadata the scan reads
// (.lst/.dat/.stp) goes into the MEMFS-mounted packs/, and the tiny generated lists
// into the IDBFS user dir.  index.html holds a run dependency across this so main()
// does not scan until the listings are in place.
//
// The heavy visual/collision payload (.dnm/.srf/.fld...) is left in OPFS and copied
// in on demand when a pack item is actually selected (see materializeOnDemand).
// Because only metadata is loaded at boot, the old MEMFS capacity budget -- which
// SKIPPED whole packs once the unpacked total approached the ~2GB wasm-linear-memory
// ceiling -- is no longer needed: every enabled pack's listing is always available,
// however many are installed.  This is the classic-FS path to "unlimited packs"
// (the WasmFS+OPFS+ASYNCIFY route is paused on emscripten OPFS-backend bugs).
async function materializeEnabled(onProgress) {
  if (!adapter && !setupFS()) return { materialized: [], skipped: [] };
  const recs = (await opfs.listRecords()).filter((r) => r.enabled !== false);
  const total = recs.length;
  const materialized = [], skipped = [];
  let done = 0, idx = 0;
  // Parallelize: metadata materialize is OPFS-read bound, and with hundreds of packs
  // a serial loop can run past the boot gate's 90s backstop, leaving later packs
  // unscanned (missing from the menu).  A small worker pool keeps it well under.
  const CONCURRENCY = 8;
  async function worker() {
    while (idx < recs.length) {
      const rec = recs[idx++];
      try {
        await opfs.materialize(rec, adapter, { metaOnly: true });
        materialized.push(rec.id);
      } catch (e) {
        console.warn('[packs] meta materialize failed for ' + rec.id + ': ' + (e && e.message ? e.message : e));
        skipped.push({ id: rec.id, name: rec.name, reason: 'error', error: String((e && e.message) || e) });
      }
      done++;
      if (typeof onProgress === 'function') { try { onProgress(done, total); } catch (e) {} }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, recs.length) }, worker));
  if (skipped.length) {
    console.warn('[packs] ' + skipped.length + ' pack(s) failed meta materialize: ' +
      skipped.map((s) => s.name || s.id).join(', '));
  }
  window.__ysfwMaterializeSkipped = skipped;
  return { materialized, skipped };
}

// On-demand payload materialize (Phase 2): the engine (fschoose.cpp) calls this
// when the selection dialog highlights an aircraft/field, passing a model file's
// full path <userDir>/packs/<id>/<relPath>.  Boot only materialized .lst/.dat
// metadata, so copy the rest of that pack's payload from OPFS into the engine FS
// before the engine opens the model.
//
// We materialize the WHOLE pack (not just the .dnm), because a model references
// TEXTURES (.bmp/.png/...) that are not listed in the .lst and cannot be reached
// from the model's path -- without them WebGL has no texture to bind and the model
// renders broken.  Pack-grained, first-touch only (tracked in materializedPacks),
// idempotent.  Failures are graceful: a missing file makes the engine's fopen skip
// that frame; the delete-on-error lets the next highlight retry.  (Memory is
// bounded later by Phase 3 LRU unload.)
const materializedDirs = new Set();
// `materializedDirs` keys are "<id> <modelRelPath>"; a model's prefetch covers its
// whole directory.  When layer3 evicts a file, drop any prefetch entry for a model in
// the SAME directory, so the next highlight re-runs the parallel prefetch instead of
// falling back to the slow per-file openat materialize mid-render.  Keeps this
// write-once guard in sync with LRU residency (the two had diverged otherwise).
function invalidatePrefetch(evictedKeys) {
  if (!materializedDirs.size) return;
  for (const key of evictedKeys) {
    const mm = key.match(/^packs\/([^/]+)\/(.+)$/);
    if (!mm) continue;
    const id = mm[1], dir = mm[2].replace(/[^/]*$/, '');
    for (const dk of materializedDirs) {
      const sp = dk.indexOf(' ');
      if (sp > 0 && dk.slice(0, sp) === id && dk.slice(sp + 1).replace(/[^/]*$/, '') === dir) materializedDirs.delete(dk);
    }
  }
}
// Drop every prefetch entry for a pack (uninstall) so a reinstall re-prefetches.
function forgetPrefetchForId(id) {
  for (const dk of materializedDirs) if (dk.startsWith(id + ' ')) materializedDirs.delete(dk);
}
// LRU keys (packs/<id>/<rel>) currently being materialized: passed to sweepLru as
// the protect set so an in-flight open's file is never evicted out from under it.
const residentInFlight = new Set();
window.ysfwOnChoiceHighlight = async (kind, fullPath) => {
  if (!adapter || !fullPath) return;
  const m = fullPath.match(/\/packs\/([^/]+)\/(.+)$/);
  if (!m) return;
  const id = m[1], dir = m[2].replace(/[^/]*$/, ''); // the model's directory (textures usually sit alongside it)
  const key = id + ' ' + m[2];
  if (materializedDirs.has(key)) return;
  try {
    const rec = await opfs.getRecord(id);
    if (!rec) return;
    // Materialize the model's DIRECTORY -- the .dnm/.srf PLUS the textures it
    // references (which live alongside but are not listed in the .lst).  Scoping to
    // the directory, not the whole pack, keeps it small enough to finish inside the
    // engine's ~300ms still-delay; materializing a whole large pack does NOT, so the
    // engine reads half-written files (Load Error (VISUAL) / "no PNG signature").
    const targets = rec.files.filter((f) => f.path === m[2] || (f.path.startsWith(dir) && f.path.slice(dir.length).indexOf('/') < 0 && /\.(png|bmp|dds|jpe?g|tga)$/i.test(f.path)));
    const lkeys = targets.map((f) => 'packs/' + id + '/' + f.path);
    for (const k of lkeys) residentInFlight.add(k);
    try {
      await Promise.all(targets.map((f) => opfs.materializeFile(rec, adapter, f.path)
        .then((wrote) => { if (wrote) trackMaterialized(rec, id, f.path); })
        .catch(() => {})));
      sweepLru(residentInFlight); // one sweep after the whole directory is resident
    } finally {
      for (const k of lkeys) residentInFlight.delete(k);
    }
    materializedDirs.add(key); // mark done only AFTER every file is fully on disk
  } catch (e) { /* leave unmarked -> a later highlight retries */ }
};

// Called by the engine's openat ASYNCIFY hook (src/port/ysfw_openat.jslib) the
// instant a packs/ file is opened but missing from MEMFS.  Materializes that ONE
// file from OPFS and AWAITS it, so the suspended fopen resumes with the file in
// place -- this is the "last resort" that covers demo/flight (no still-delay).
// In-flight map dedups concurrent opens (and the highlight prefetch) of the same
// file so we never double-write a half-written blob.  Because openat awaits THIS
// before opening, the engine never reads a partial file ("no PNG signature").
const inflightOpen = new Map(); // "id relPath" -> Promise
window.ysfwMaterializeForOpen = async (fullPath) => {
  if (!adapter) return;
  const m = fullPath.match(/\/packs\/([^/]+)\/(.+)$/);
  if (!m) return;
  const id = m[1], relPath = m[2], key = id + ' ' + relPath;
  let p = inflightOpen.get(key);
  if (!p) {
    const lkey = 'packs/' + id + '/' + relPath;
    residentInFlight.add(lkey); // guard against eviction by a concurrent sweep
    p = (async () => {
      const rec = await opfs.getRecord(id);
      if (!rec) return;
      const wrote = await opfs.materializeFile(rec, adapter, relPath);
      if (wrote) { trackMaterialized(rec, id, relPath); sweepLru(residentInFlight); }
    })().finally(() => { inflightOpen.delete(key); residentInFlight.delete(lkey); });
    inflightOpen.set(key, p);
  }
  await p;
};

function init() {
  const M = window.Module;
  if (!setupFS()) return;
  // Graft the management panel only for a deliberate manual launch.  ?freeflight
  // boots straight in (no gate); ?join holds the gate too (M6) but drives the
  // pre-boot pack sync via pack-net instead of the panel.
  if (M.__ysfwGateHeld && !M.__ysfwJoinSync) {
    renderPanel();
    M.__ysfwPanelShown = true;
  }
}

// Public surface (also driven by the smoke test).
window.ysfwPacks = {
  fsReady: false,
  installFromBytes,
  setEnabled,
  uninstall,
  list: listInstalled,
  start,
  refresh,
  showJoinFailure,
  setupFS,
  materializeEnabled,
  memfsStats: () => (lru ? lru.stats() : null), // layer3 LRU observability (smoke/debug)
};
window.ysfwPacksInit = init;

// If index.html already signalled FS readiness before this module evaluated,
// initialize now (normally init() is called from the preRun syncfs callback).
if (window.__ysfwFsReady) init();
