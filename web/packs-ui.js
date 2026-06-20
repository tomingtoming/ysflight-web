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

import { analyzePackStreaming } from './packs.js';
import * as opfs from './opfs-store.js';

const USER_DIR_DEFAULT = '/home/web_user/Documents/YSFLIGHT.COM/YSFLIGHT';
const ACCENT = '#4da3ff';
// Payload lives in OPFS (on disk), so the old MEMFS-bound 256MB cap is lifted.
// NOTE: install still unzips the whole archive in memory (fflate unzipSync); a
// streaming unzip is a follow-up before the very largest (~1GB) packs are smooth.
const MAX_PACK_BYTES = 1536 * 1024 * 1024;

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
    notZip: '(.zip ではないのでスキップ)',
    panelTitle: '追加パック',
    dropZone: 'パック (.zip) をドロップ / クリックして選択',
    playBtn: '▶ プレイ開始',
    joinFailTitle: '⚠ 必須パックを取得できませんでした',
    joinFailDesc: (names) => 'ホストの必須フィールド' + (names.length ? '「' + names.join('・') + '」' : '') +
      'を取得できませんでした。このまま参加すると正しく飛べません。再試行するか、ソロ（シングルプレイ）で開始してください。',
    retryBtn: '↻ 再試行',
    soloBtn: 'ソロでプレイ',
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
    notZip: '(skipped: not a .zip)',
    panelTitle: 'Add-on packs',
    dropZone: 'Drop a pack (.zip) / click to choose',
    playBtn: '▶ Play',
    joinFailTitle: '⚠ Couldn’t obtain required packs',
    joinFailDesc: (names) => 'Couldn’t obtain the host’s required field' + (names.length ? ' “' + names.join(', ') + '”' : '') +
      '. Joining now would not fly correctly. Retry, or start in solo (single-player).',
    retryBtn: '↻ Retry',
    soloBtn: 'Play solo',
  },
})[LANG];

let FS = null;
let adapter = null;
let listEl = null;
let storageEl = null;

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

async function refresh() {
  if (!listEl) return;
  const packs = await readIndex();
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
  if (storageEl) {
    const s = await storageInfo();
    storageEl.textContent = S.storage(fmtBytes(s.usage), s.quota ? fmtBytes(s.quota) : '', s.persisted);
  }
}

async function sync() {
  await new Promise((resolve) => FS.syncfs(false, () => resolve())); // persist to IndexedDB
}

async function installFromBytes(bytes, name, sourceUrl) {
  if (!adapter) throw new Error('pack layer not ready');
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Path A: analyze (no FS writes), store the payload content-addressed in OPFS
  // (on disk, deduped), then materialize it into the engine FS -- payload into the
  // MEMFS-mounted packs/ (excluded from IDBFS sync) and the tiny generated lists
  // into the IDBFS user dir.  sourceUrl is kept for Option-B re-advertising.
  const a = await analyzePackStreaming(buf, {
    sha256: webSha256, putBlob: opfs.putBlob, name, sourceUrl, maxPackBytes: MAX_PACK_BYTES,
  });
  await opfs.putRecordFromAnalysis(a, { enabled: true });
  await opfs.materialize(await opfs.getRecord(a.id), adapter);
  await sync(); // persist the tiny lists (payload lives in OPFS + the MEMFS mount)
  await refresh();
  return {
    id: a.id, name: a.name, categories: a.categories, bytes: a.total,
    templates: a.generated.reduce((n, g) => n + g.entries, 0), lists: a.generated.map((g) => g.file),
  };
}

async function setEnabled(id, enabled) {
  if (!adapter) throw new Error('pack layer not ready');
  const rec = await opfs.setEnabled(id, enabled);
  if (enabled) await opfs.materialize(rec, adapter);              // write payload + generated lists
  else for (const g of rec.generated) await adapter.rmrf(g.file); // drop lists -> engine won't scan it
  await sync();
  await refresh();
  return { id, enabled: !!enabled };
}

async function uninstall(id) {
  if (!adapter) throw new Error('pack layer not ready');
  const rec = await opfs.getRecord(id);
  if (rec) {
    for (const g of rec.generated) await adapter.rmrf(g.file); // remove generated lists (IDBFS)
    await adapter.rmrf('packs/' + id);                          // remove materialized payload (MEMFS)
    await opfs.removeRecord(id);
    await opfs.gc();                                            // reclaim now-unreferenced blobs
  }
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

async function handleFiles(fileList) {
  const status = document.getElementById('ysfw-pack-status');
  // One result line per file, accumulated and each prefixed with the file name,
  // so a BATCH upload makes clear WHICH file an error (e.g. "no YSFLIGHT list
  // found") is about.  ✓ installed · ✗ failed · — skipped.
  const lines = [];
  const show = (pending) => { if (status) status.textContent = (pending ? lines.concat(pending) : lines).join('\n'); };
  for (const file of fileList) {
    if (!/\.zip$/i.test(file.name)) {
      lines.push('— ' + file.name + ' ' + S.notZip);
      show();
      continue;
    }
    show(S.installing + file.name + ' …');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const res = await installFromBytes(bytes, file.name.replace(/\.zip$/i, ''));
      lines.push('✓ ' + file.name + ' → ' + res.name + ' (' + res.categories.join('/') + ' · ' + res.templates + ')');
    } catch (e) {
      lines.push('✗ ' + file.name + ': ' + (e && e.message ? e.message : e));
    }
    show();
  }
}

function renderPanel() {
  const overlay = document.getElementById('overlay');
  if (!overlay || document.getElementById('ysfw-pack-panel')) return;

  const panel = document.createElement('div');
  panel.id = 'ysfw-pack-panel';
  panel.style.cssText =
    'margin-top:22px;width:min(460px,86vw);background:#0b121b;border:1px solid #1d2633;' +
    'border-radius:10px;padding:16px 16px 14px;text-align:left;box-shadow:0 8px 30px rgba(0,0,0,.4)';

  const title = document.createElement('div');
  title.textContent = S.panelTitle;
  title.style.cssText = 'color:#e6edf3;font-size:14px;font-weight:600;letter-spacing:.04em;margin-bottom:10px';
  panel.appendChild(title);

  listEl = document.createElement('div');
  listEl.id = 'ysfw-pack-list';
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

  overlay.appendChild(panel);
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
    adapter = makeFsAdapter(FS, M.__ysfwUserDir || USER_DIR_DEFAULT);
  }
  window.ysfwPacks.fsReady = true;
  return true;
}

// Materialize every ENABLED pack from OPFS into the engine FS before the engine's
// one-time template scan: payload into the MEMFS-mounted packs/ (ephemeral,
// regenerated each boot from OPFS) and the tiny generated lists into the IDBFS
// user dir.  index.html holds a run dependency across this so main() does not scan
// until the packs are in place.
async function materializeEnabled() {
  if (!adapter && !setupFS()) return;
  for (const rec of await opfs.listRecords()) {
    if (rec.enabled === false) continue;
    try { await opfs.materialize(rec, adapter); }
    catch (e) { console.warn('[packs] materialize failed for ' + rec.id + ': ' + (e && e.message ? e.message : e)); }
  }
}

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
  list: readIndex,
  start,
  refresh,
  showJoinFailure,
  setupFS,
  materializeEnabled,
};
window.ysfwPacksInit = init;

// If index.html already signalled FS readiness before this module evaluated,
// initialize now (normally init() is called from the preRun syncfs callback).
if (window.__ysfwFsReady) init();
