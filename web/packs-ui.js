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

import { installPack, setEnabled as pkSetEnabled, uninstall as pkUninstall } from './packs.js';

const USER_DIR_DEFAULT = '/home/web_user/Documents/YSFLIGHT.COM/YSFLIGHT';
const ACCENT = '#4da3ff';

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

async function readIndex() {
  try {
    const raw = await adapter.readFile('packs/index.json');
    const arr = JSON.parse(new TextDecoder().decode(raw));
    return Array.isArray(arr) ? arr : [];
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
    empty.textContent = '（追加パックなし — そのままプレイできます）';
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
      toggle.textContent = enabled ? '有効' : '無効';
      toggle.title = enabled ? 'クリックで無効化' : 'クリックで有効化';
      toggle.style.cssText =
        'font-size:12px;padding:4px 9px;border-radius:5px;cursor:pointer;border:1px solid ' +
        (enabled
          ? ACCENT + ';background:rgba(77,163,255,.12);color:' + ACCENT
          : '#2a3647;background:#0d141d;color:#8fa3bb');
      const setErr = (e) => {
        const s = document.getElementById('ysfw-pack-status');
        if (s) s.textContent = 'エラー: ' + (e && e.message ? e.message : e);
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
      del.title = 'アンインストール';
      del.style.cssText =
        'font-size:12px;padding:4px 8px;border-radius:5px;border:1px solid #2a3647;background:#0d141d;color:#c75d6a;cursor:pointer';
      del.addEventListener('click', async () => {
        if (!self.confirm('「' + (p.name || p.id) + '」を削除しますか？')) return;
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
    storageEl.textContent =
      '使用容量 ' + fmtBytes(s.usage) + (s.quota ? ' / ' + fmtBytes(s.quota) : '') +
      ' ・ 永続化 ' + (s.persisted ? 'ON' : 'OFF');
  }
}

async function sync() {
  await new Promise((resolve) => FS.syncfs(false, () => resolve())); // persist to IndexedDB
}

async function installFromBytes(bytes, name) {
  if (!adapter) throw new Error('pack layer not ready');
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const res = await installPack(buf, { fs: adapter, sha256: webSha256, name });
  await sync();
  await refresh();
  return res;
}

async function setEnabled(id, enabled) {
  if (!adapter) throw new Error('pack layer not ready');
  const res = await pkSetEnabled(id, enabled, { fs: adapter });
  await sync();
  await refresh();
  return res;
}

async function uninstall(id) {
  if (!adapter) throw new Error('pack layer not ready');
  const res = await pkUninstall(id, { fs: adapter });
  await sync();
  await refresh();
  return res;
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
  for (const file of fileList) {
    if (!/\.zip$/i.test(file.name)) continue;
    try {
      if (status) status.textContent = '取り込み中: ' + file.name + ' …';
      const bytes = new Uint8Array(await file.arrayBuffer());
      const res = await installFromBytes(bytes, file.name.replace(/\.zip$/i, ''));
      if (status) {
        status.textContent =
          '追加: ' + res.name + '（' + res.categories.join('/') + '・' + res.templates + '件）';
      }
    } catch (e) {
      if (status) status.textContent = 'エラー: ' + (e && e.message ? e.message : e);
    }
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
  title.textContent = '追加パック';
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
  drop.textContent = 'パック (.zip) をドロップ / クリックして選択';
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
  status.style.cssText = 'color:#8fa3bb;font-size:12px;min-height:1.2em;margin-top:8px';
  panel.appendChild(status);

  storageEl = document.createElement('div');
  storageEl.style.cssText = 'color:#5d7290;font-size:11px;margin-top:4px';
  panel.appendChild(storageEl);

  const playBtn = document.createElement('button');
  playBtn.id = 'ysfw-pack-play';
  playBtn.textContent = '▶ プレイ開始';
  playBtn.style.cssText =
    'margin-top:14px;width:100%;padding:11px;border:0;border-radius:8px;background:' + ACCENT + ';' +
    'color:#04101f;font-size:15px;font-weight:700;cursor:pointer';
  playBtn.addEventListener('click', start);
  panel.appendChild(playBtn);

  overlay.appendChild(panel);
  refresh();
}

function init() {
  const M = window.Module;
  if (!M || !M.FS) return;
  FS = M.FS;
  adapter = makeFsAdapter(FS, M.__ysfwUserDir || USER_DIR_DEFAULT);
  window.ysfwPacks.fsReady = true;
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
};
window.ysfwPacksInit = init;

// If index.html already signalled FS readiness before this module evaluated,
// initialize now (normally init() is called from the preRun syncfs callback).
if (window.__ysfwFsReady) init();
