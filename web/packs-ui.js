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
import { prepareUpdate, commitUpdate } from './pack-update.js';
import { createMemfsLru } from './memfs-lru.js';
import { unzipSync } from './vendor/fflate.js';

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
    updateBtn: '⤴',
    updateTitle: 'ZIPから更新 — このパックの中身を選んだ zip で差し替えます（パック名・有効/無効・作者情報は引き継ぎ）',
    updateConfirm: (n, d) => '「' + n + '」を選択した zip の内容で更新します。\n' +
      '追加 ' + d.added.length + ' ／ 削除 ' + d.removed.length + ' ／ 変更 ' + d.changed.length + ' ／ 変更なし ' + d.unchanged + '\n' +
      (d.changed.length ? '変更例: ' + d.changed.slice(0, 3).join(', ') + '\n' : '') +
      '（有効/無効の状態と作者情報は引き継がれます）',
    updateSame: '選択した zip は今の内容と同一です（更新は不要でした）',
    updated: (n, d) => '✓ 「' + n + '」を更新しました（追加 ' + d.added.length + ' ／ 削除 ' + d.removed.length + ' ／ 変更 ' + d.changed.length + '）',
    confirmDelete: (n) => '「' + n + '」を削除しますか？',
    disableAllBtn: '全部無効化', enableAllBtn: '全部有効化', deleteAllBtn: '全部削除',
    disableAllTitle: '全パックを一括で無効化（原典YSFLIGHTに戻す。あとで有効化できます）',
    enableAllTitle: '全パックを一括で有効化',
    deleteAllTitle: '全パックを一括でアンインストール（元に戻せません）',
    confirmDeleteAll: (n) => '追加パック ' + n + ' 個をすべて削除しますか？\nこの操作は元に戻せません（各パックは再インポートが必要になります）。',
    bulkDisabled: (n) => '✓ ' + n + ' 個を無効化しました（原典YSFLIGHTに戻りました）',
    bulkEnabled: (n) => '✓ ' + n + ' 個を有効化しました',
    bulkRemoved: (n) => '✓ ' + n + ' 個を削除しました',
    bulkWorking: '処理中…',
    storage: (u, q, p) => '使用容量 ' + u + (q ? ' / ' + q : '') + ' ・ 永続化 ' + (p ? 'ON' : 'OFF'),
    installing: '取り込み中: ',
    bulkProgress: (done, total) => '取り込み中 ' + done + '/' + total + ' …',
    bulkDone: (ok, fail) => '✓ ' + ok + ' 件取り込み' + (fail ? '  ／  ⚠ ' + fail + ' 件失敗（下記）' : ''),
    notZip: '(.zip ではないのでスキップ)',
    panelTitle: '追加パック',
    packToggle0: '手持ちのアドオンを追加',
    packToggleN: (n) => '追加パック (' + n + ')',
    quickTitle: '🛫 今すぐ飛ぶ',
    quickHint: 'クリックでそのまま離陸（追加パック不要）',
    touchHint: 'スマホ対応：離陸すると画面に操縦スティックが出ます',
    tagBeginner: '👍 はじめての方向け',
    tagIntermediate: '中級者向け',
    tagAirliner: '大型機',
    tagAdvanced: '上級者向け',
    missionTitle: '🎯 ミッション',
    missionHint: 'クリックで即ミッション開始（耐久戦＝波状の敵を迎え撃つ／邀撃＝来襲編隊を阻止）',
    missionEasySub: '耐久戦: 厚木 / 僚機2機・敵レベル3',
    missionHardSub: '耐久戦: Hawaii / 単機・敵レベル5',
    missionInterceptSub: '邀撃: 爆撃編隊を阻止 / 僚機2機',
    createFlightLink: '✈️ フライトを作る（機体・敵機・時間帯を選ぶ）',
    createFlightTitle: '専用ページで機体・マップ・時間帯・AI機を組んで離陸（Create Flight のweb版）',
    settingsLink: '⚙️ 設定（影・雲・HUD など）',
    settingsTitle: '見た目と表示の設定（Option メニューのweb版）',
    urlAdd: 'URL から追加',
    urlPlaceholder: 'パック .zip の URL',
    urlBtn: '追加',
    urlFetching: 'URL から取得中…',
    urlFail: '直接取得できませんでした（CORS／ネットワーク）。zip をDLしてドロップしてください',
    urlFail404: (s) => 'URL を取得できませんでした（' + s + '）。リンクが正しいか確認してください',
    dropZone: 'パック (.zip) を1つ以上ドロップ / クリックして選択',
    dropHint: 'zip の直下に aircraft/ scenery/ ground/ などのフォルダがある構成にしてください',
    wbLink: '🛠 ワークベンチ — 機体とマップを作る',
    wbLinkTitle: '専用ページで機体を組む・.datを作る・島を描く（作ったものは次回起動から使えます）',
    looseHint: (names) => '— ' + names.join(', ') + ' : 機体のファイルはワークベンチ（🛠）で組み立てられます',
    flyBtn: '🛫',
    flyTitle: 'テスト飛行 — この機体で滑走路から即離陸（ページをリロードします）',
    flyPick: '機体を選択:',
    flyNoIdent: 'この機体は名前指定で起動できません（.dat に ASCII の IDENTIFY が無い）。プレイ開始からメニューで選んでください',
    diagWarn: (n, samples) => '⚠ パック内のリストが参照する ' + n + ' ファイルが見つかりません（該当エントリは飛べません）' + (samples.length ? ' 例: ' + samples.slice(0, 3).join(', ') : ''),
    postPlayHint: 'プレイ開始後、エンジンのメニューで Simulation → Create Flight を開くと、取り込んだ機体・マップが選べます',
    errMap: {
      noList: 'YSFLIGHT のリスト（aircraft/air*.lst など）が見つかりません。zip の直下に aircraft/ や scenery/ があるか確認してください',
      tooBig: 'パックが大きすぎます（サイズ上限を超過）',
      unsafe: 'パック内に不正なパス（..）が含まれています',
      empty: 'パックが空です（有効なファイルがありません）',
      noEntries: 'パックのリストに有効なエントリがありませんでした',
    },
    attribPolicy: {
      'redist-mod-ok': '再配布可・改変可',
      'redist-nomod': '再配布可・改変不可',
      'no-redist': '再配布不可',
      'ask-author': '要許可（作者に連絡）',
    },
    playBtn: '▶ プレイ開始',
    playHint: '機体・マップを自分で選ぶ／対戦をホストするときはこちら（エンジンのメニューが開きます）',
    vrPlayBtn: '🥽 VRでプレイ開始',
    vrPlayHint: 'ヘッドセットのままメニュー操作から飛行まで（WebXR・実験的機能）',
    flyAgain: '↻ 続きから',
    joinFailTitle: '⚠ 必須パックを取得できませんでした',
    joinFailDesc: (names) => 'ホストの必須フィールド' + (names.length ? '「' + names.join('・') + '」' : '') +
      'を取得できませんでした。このまま参加すると正しく飛べません。再試行するか、ソロ（シングルプレイ）で開始してください。',
    retryBtn: '↻ 再試行',
    soloBtn: 'ソロでプレイ',
    joinReason: {
      'no-room': 'ホストがまだ起動していないようです。相手にゲーム開始を頼んでから再試行してください。',
      'timeout': '接続がタイムアウトしました（回線が厳しい可能性）。再試行するか、相手と直結できるか確認してください。',
      'timeoutNoTurn': '接続がタイムアウトしました。このサーバはTURN中継が未設定のため、厳しい回線（モバイル/CGNAT等）では同期できません。別の回線を試すか、サーバ運営者にTURN設定を依頼してください。',
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
    updateBtn: '⤴',
    updateTitle: 'Update from ZIP — replace this pack\'s contents with a chosen zip (name, on/off state, and author info carry over)',
    updateConfirm: (n, d) => 'Update “' + n + '” with the selected zip?\n' +
      'Added ' + d.added.length + ' / removed ' + d.removed.length + ' / changed ' + d.changed.length + ' / unchanged ' + d.unchanged + '\n' +
      (d.changed.length ? 'e.g. changed: ' + d.changed.slice(0, 3).join(', ') + '\n' : '') +
      '(The on/off state and author info carry over.)',
    updateSame: 'The selected zip is identical to the current contents (nothing to update)',
    updated: (n, d) => '✓ Updated “' + n + '” (added ' + d.added.length + ' / removed ' + d.removed.length + ' / changed ' + d.changed.length + ')',
    confirmDelete: (n) => 'Delete “' + n + '”?',
    disableAllBtn: 'Disable all', enableAllBtn: 'Enable all', deleteAllBtn: 'Delete all',
    disableAllTitle: 'Disable every pack at once (back to plain YSFLIGHT; you can re-enable later)',
    enableAllTitle: 'Enable every pack at once',
    deleteAllTitle: 'Uninstall every pack at once (cannot be undone)',
    confirmDeleteAll: (n) => 'Delete all ' + n + ' add-on packs?\nThis cannot be undone (each pack would need to be re-imported).',
    bulkDisabled: (n) => '✓ Disabled ' + n + ' pack(s) — back to plain YSFLIGHT',
    bulkEnabled: (n) => '✓ Enabled ' + n + ' pack(s)',
    bulkRemoved: (n) => '✓ Deleted ' + n + ' pack(s)',
    bulkWorking: 'Working…',
    storage: (u, q, p) => 'Storage ' + u + (q ? ' / ' + q : '') + ' · Persisted ' + (p ? 'ON' : 'OFF'),
    installing: 'Installing: ',
    bulkProgress: (done, total) => 'Importing ' + done + '/' + total + '…',
    bulkDone: (ok, fail) => '✓ ' + ok + ' imported' + (fail ? '  /  ⚠ ' + fail + ' failed (below)' : ''),
    notZip: '(skipped: not a .zip)',
    panelTitle: 'Add-on packs',
    packToggle0: 'Add your own add-ons',
    packToggleN: (n) => 'Add-on packs (' + n + ')',
    quickTitle: '🛫 Quick flight',
    quickHint: 'Click to take off right away (no add-on needed)',
    touchHint: 'Touch-ready: an on-screen stick appears once you take off.',
    tagBeginner: '👍 Beginner',
    tagIntermediate: 'Intermediate',
    tagAirliner: 'Airliner',
    tagAdvanced: 'Advanced',
    missionTitle: '🎯 Missions',
    missionHint: 'Click to start a mission (Endurance = survive the waves / Intercept = stop the raid)',
    missionEasySub: 'Endurance: Atsugi / 2 wingmen, enemy Lv 3',
    missionHardSub: 'Endurance: Hawaii / solo, enemy Lv 5',
    missionInterceptSub: 'Intercept: stop the bomber raid / 2 wingmen',
    createFlightLink: '✈️ Create a flight (aircraft, enemies, time of day)',
    createFlightTitle: 'Compose aircraft / map / time / AI on a dedicated page, then take off (web Create Flight)',
    settingsLink: '⚙️ Settings (shadows, clouds, HUD…)',
    settingsTitle: 'Look & display options (web Option menu)',
    urlAdd: 'Add from URL',
    urlPlaceholder: 'URL of a pack .zip',
    urlBtn: 'Add',
    urlFetching: 'Fetching from URL…',
    urlFail: 'Could not fetch directly (CORS / network). Download the zip and drop it here',
    urlFail404: (s) => 'Could not fetch the URL (' + s + '). Check the link is correct',
    dropZone: 'Drop one or more packs (.zip) / click to choose',
    dropHint: 'The zip should have folders like aircraft/ scenery/ ground/ at its top level',
    wbLink: '🛠 Workbench — build aircraft & maps',
    wbLinkTitle: 'A dedicated page to assemble aircraft, make a .dat, and draw islands (available in-game on next load)',
    looseHint: (names) => '— ' + names.join(', ') + ' : assemble loose aircraft files in the Workbench (🛠)',
    flyBtn: '🛫',
    flyTitle: 'Test-fly — take off with this aircraft right away (reloads the page)',
    flyPick: 'Pick an aircraft:',
    flyNoIdent: 'This aircraft can’t be launched by name (no ASCII IDENTIFY in its .dat). Press Play and pick it from the menu',
    diagWarn: (n, samples) => '⚠ ' + n + ' file(s) referenced by the pack’s lists are missing (those entries won’t fly)' + (samples.length ? ' e.g. ' + samples.slice(0, 3).join(', ') : ''),
    postPlayHint: 'After Play, open Simulation → Create Flight in the engine menu to fly your installed aircraft & maps',
    errMap: {
      noList: 'No YSFLIGHT list found (aircraft/air*.lst, etc.). Make sure the zip has folders like aircraft/ or scenery/ at its top level',
      tooBig: 'The pack is too large (exceeds the size limit)',
      unsafe: 'The pack contains an unsafe path (..)',
      empty: 'The pack is empty (no usable files)',
      noEntries: 'The pack lists contained no usable entries',
    },
    attribPolicy: {
      'redist-mod-ok': 'Redistribution OK / mods OK',
      'redist-nomod': 'Redistribution OK / no mods',
      'no-redist': 'No redistribution',
      'ask-author': 'Ask the author',
    },
    playBtn: '▶ Play',
    playHint: 'Choose your own aircraft & maps, or host multiplayer — this opens the engine menu',
    vrPlayBtn: '🥽 Play in VR',
    vrPlayHint: 'Menus and flying without taking the headset off (WebXR, experimental)',
    flyAgain: '↻ Fly again',
    joinFailTitle: '⚠ Couldn’t obtain required packs',
    joinFailDesc: (names) => 'Couldn’t obtain the host’s required field' + (names.length ? ' “' + names.join(', ') + '”' : '') +
      '. Joining now would not fly correctly. Retry, or start in solo (single-player).',
    retryBtn: '↻ Retry',
    soloBtn: 'Play solo',
    joinReason: {
      'no-room': 'The host doesn’t seem to be up yet — ask your friend to start the game, then retry.',
      'timeout': 'The connection timed out (the network may be restrictive). Retry, or check that you can connect directly.',
      'timeoutNoTurn': 'The connection timed out. This server has no TURN relay configured, so restrictive networks (mobile/CGNAT) can’t sync. Try another network, or ask the server operator to configure TURN.',
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
// Collapsible add-on section: Quick Flight + Play stay above it; this is collapsed by
// default and auto-expanded once the visitor turns out to have installed packs (see
// renderList).  Most visitors fly a Quick Flight or hit Play and never open it.
let packToggleEl = null, packBodyEl = null, packCount = 0, packAutoExpanded = false;
function updatePackToggleLabel() {
  if (!packToggleEl) return;
  const open = packBodyEl && packBodyEl.style.display !== 'none';
  packToggleEl.textContent = (open ? '▾ ' : '▸ ') + (packCount > 0 ? S.packToggleN(packCount) : S.packToggle0);
}
let storageEl = null;
// Bulk-action bar (disable/enable all, delete all).  Shown only when packs exist.
let bulkBarEl = null, bulkToggleBtn = null, bulkDeleteBtn = null;
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
  // Keep the collapsible add-on section in sync: update its label's count and, the
  // first time the visitor turns out to have installed packs, auto-expand it (a
  // returning modder's packs shouldn't stay hidden).  Manual toggling sets
  // packAutoExpanded so a later refresh never fights the user's choice.
  packCount = packs.length;
  if (packToggleEl) {
    if (!packAutoExpanded && packs.length > 0) {
      packBodyEl.style.display = 'block';
      packToggleEl.setAttribute('aria-expanded', 'true');
      packAutoExpanded = true;
    }
    updatePackToggleLabel();
  }
  updateBulkBar(packs);
  listEl.innerHTML = '';
  if (packs.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = S.emptyList;
    empty.style.cssText = 'color:#7d93b0;font-size:13px;padding:6px 0';
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
      // Attribution badge (async fill; appending to a row replaced by a
      // re-render is harmless — the node is simply detached).
      attributionOf(p.id).then((a) => {
        if (!a) return;
        const at = document.createElement('span');
        at.textContent = '  ' + [a.author && ('© ' + a.author), S.attribPolicy[a.policy]].filter(Boolean).join(' · ');
        at.style.cssText = 'color:#7d93b0;font-size:11px';
        left.appendChild(at);
      });

      const ctl = document.createElement('div');
      ctl.style.cssText = 'flex:none;display:flex;gap:6px;align-items:center';

      // Test-fly: reload straight into a flight with an aircraft from this pack.
      // Identities come from the .lst.idx sidecar in the OPFS record (lazy — read
      // on click, not for every row).  Hidden for scenery/ground-only packs.
      let fly = null;
      if (enabled && (p.categories || []).includes('aircraft')) {
        fly = document.createElement('button');
        fly.textContent = S.flyBtn;
        fly.title = S.flyTitle;
        fly.style.cssText =
          'font-size:12px;padding:4px 8px;border-radius:5px;cursor:pointer;border:1px solid ' +
          ACCENT + ';background:rgba(77,163,255,.12);color:' + ACCENT;
        fly.addEventListener('click', async () => {
          const existing = row.nextSibling && row.nextSibling.dataset && row.nextSibling.dataset.flyPicker === p.id
            ? row.nextSibling : null;
          if (existing) { existing.remove(); return; } // second click folds the picker
          fly.disabled = true;
          try {
            const ids = await aircraftIdentities(p.id);
            if (ids.length === 0) {
              const s = document.getElementById('ysfw-pack-status');
              if (s) s.textContent = S.flyNoIdent;
            } else if (ids.length === 1) {
              flyFreeflight(ids[0]);
            } else {
              const picker = document.createElement('div');
              picker.dataset.flyPicker = p.id;
              picker.style.cssText =
                'display:flex;flex-wrap:wrap;gap:4px;align-items:center;padding:6px 10px;margin:-2px 0 6px;' +
                'border:1px dashed #2a3647;border-radius:6px;max-height:8em;overflow-y:auto';
              const lab = document.createElement('span');
              lab.textContent = S.flyPick;
              lab.style.cssText = 'color:#7d93b0;font-size:11px;flex:none';
              picker.appendChild(lab);
              for (const idn of ids) {
                const b = document.createElement('button');
                b.textContent = idn;
                b.style.cssText =
                  'font-size:11px;padding:3px 8px;border-radius:5px;cursor:pointer;border:1px solid #2a3647;background:#0d141d;color:#cfe0f5';
                b.addEventListener('click', () => flyFreeflight(idn));
                picker.appendChild(b);
              }
              row.after(picker);
            }
          } finally {
            fly.disabled = false;
          }
        });
      }

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
      // ⤴ Update from ZIP: replace this pack's contents with a newer zip while
      // keeping its identity (name), on/off state, and author info — the
      // versioning verb for self-authored packs (import alone always creates a
      // NEW pack, because ids are content hashes).
      const upd = document.createElement('button');
      upd.textContent = S.updateBtn;
      upd.title = S.updateTitle;
      upd.style.cssText =
        'font-size:12px;padding:4px 8px;border-radius:5px;border:1px solid #2a3647;background:#0d141d;color:#8fa3bb;cursor:pointer';
      upd.addEventListener('click', () => {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = '.zip';
        inp.addEventListener('change', async () => {
          const file = inp.files && inp.files[0];
          if (!file) return;
          upd.disabled = true;
          const s = document.getElementById('ysfw-pack-status');
          try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const res = await updateFromZip(p.id, bytes,
              async (diff) => self.confirm(S.updateConfirm(p.name || p.id, diff)));
            if (s) {
              s.textContent = res.same ? S.updateSame
                : res.updated ? S.updated(res.name, res.diff) : s.textContent;
            }
          } catch (e) {
            if (s) s.textContent = S.errorPrefix + friendlyErr(e);
          } finally {
            upd.disabled = false;
          }
        });
        inp.click();
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
      if (fly) ctl.appendChild(fly);
      ctl.appendChild(toggle);
      ctl.appendChild(upd);
      ctl.appendChild(del);

      row.appendChild(left);
      row.appendChild(ctl);
      listEl.appendChild(row);
    }
  }
}

// Show the bulk bar only when packs exist, and make the toggle button reflect state:
// if any pack is enabled it offers "disable all" (the common case: get to plain
// YSFLIGHT); if all are already disabled it offers "enable all" (restore).
function updateBulkBar(packs) {
  if (!bulkBarEl) return;
  if (!packs.length) { bulkBarEl.style.display = 'none'; return; }
  bulkBarEl.style.display = 'flex';
  const anyEnabled = packs.some((p) => p.enabled !== false);
  if (bulkToggleBtn) {
    bulkToggleBtn.dataset.enableAll = anyEnabled ? '' : '1';
    bulkToggleBtn.textContent = anyEnabled ? S.disableAllBtn : S.enableAllBtn;
    bulkToggleBtn.title = anyEnabled ? S.disableAllTitle : S.enableAllTitle;
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
    templates: a.generated.filter((g) => !g.idx).reduce((n, g) => n + g.entries, 0), lists: a.generated.filter((g) => !g.idx).map((g) => g.file),
    diagnostics: a.diagnostics, // {refs, missing, samples} — unresolved list references
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

// Per-pack enable/disable, WITHOUT the syncfs + panel re-render.  Split out so the
// bulk "disable all / enable all" path can run it across hundreds of packs and pay
// the one-time syncfs + refresh cost ONCE at the end (same reason handleFiles batches).
async function setEnabledCore(id, enabled) {
  const rec = await opfs.setEnabled(id, enabled);
  if (enabled) await opfs.materialize(rec, adapter, { metaOnly: true }); // write listing only; payload on demand
  else for (const g of rec.generated) await adapter.rmrf(g.file);        // drop lists -> engine won't scan it
  cacheUpdate(id, { enabled: !!enabled });
}

async function setEnabled(id, enabled) {
  if (!adapter) throw new Error('pack layer not ready');
  await setEnabledCore(id, enabled);
  await sync();
  await refresh();
  return { id, enabled: !!enabled };
}

// Per-pack uninstall, WITHOUT the gc + syncfs + re-render (batched by uninstallAll).
async function uninstallCore(id) {
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
  }
  cacheRemove(id);
}

async function uninstall(id) {
  if (!adapter) throw new Error('pack layer not ready');
  await uninstallCore(id);
  await opfs.gc();     // reclaim now-unreferenced blobs
  await sync();
  await refresh();
  return { id, removed: true };
}

// Update an installed pack's contents from a new zip (see web/pack-update.js
// for the carry-over rules; this adds the engine-FS half).  Same lineage as
// the studios' re-edit -> replace-save: the successor gets a new content-hash
// id, the old id retires, orphan blobs are GC'd.  `confirmFn(diff)` is asked
// (async, may be a dialog) before anything irreversible; on cancel the blobs
// the prepare streamed in are reclaimed and nothing changed.
async function updateFromZip(id, bytes, confirmFn) {
  if (!adapter) throw new Error('pack layer not ready');
  const oldRec = await opfs.getRecord(id);
  if (!oldRec) throw new Error('pack not installed: ' + id);
  let prep;
  try {
    prep = await prepareUpdate(oldRec, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
      { sha256: webSha256, store: opfs });
  } catch (e) {
    try { await opfs.gc(); } catch (_) {} // reclaim blobs the rejected zip streamed in
    throw e;
  }
  if (prep.sameId) return { id, updated: false, same: true, name: oldRec.name };
  if (confirmFn && !(await confirmFn(prep.diff))) {
    try { await opfs.gc(); } catch (_) {}
    return { id, updated: false, cancelled: true, name: oldRec.name };
  }
  const rec = await commitUpdate(oldRec, prep.analysis, { store: opfs });
  // Engine-FS swap, mirroring uninstallCore (old) + installCore (new): drop the
  // old generated lists + materialized payload, then materialize the successor's
  // listing when it is enabled.
  for (const g of oldRec.generated || []) await adapter.rmrf(g.file);
  await adapter.rmrf('packs/' + oldRec.id);
  if (lru) lru.forgetPrefix('packs/' + oldRec.id + '/');
  forgetPrefetchForId(oldRec.id);
  if (rec.enabled !== false) await opfs.materialize(rec, adapter, { metaOnly: true });
  cacheRemove(oldRec.id);
  cacheUpsert({ id: rec.id, name: rec.name, enabled: rec.enabled !== false, bytes: rec.bytes, categories: rec.categories });
  attribCache.delete(oldRec.id);
  attribCache.delete(rec.id);
  await sync();
  await refresh();
  return { id: rec.id, oldId: oldRec.id, updated: true, diff: prep.diff, name: rec.name };
}

// Bulk enable/disable EVERY installed pack in one pass.  A first release doesn't
// push add-ons, so a returning modder with hundreds of packs needs a one-click way
// back to plain YSFLIGHT (and back again) instead of toggling each row.  Failures on
// a single bad pack don't abort the sweep; the syncfs + re-render happen once.
async function setEnabledAll(enabled) {
  if (!adapter) throw new Error('pack layer not ready');
  const targets = (await listInstalled()).filter((p) => (p.enabled !== false) !== enabled);
  let done = 0;
  for (const p of targets) {
    try { await setEnabledCore(p.id, enabled); done++; } catch (e) { /* skip a bad pack, keep going */ }
  }
  await sync();
  await refresh();
  return { changed: done, total: targets.length };
}

// Bulk uninstall EVERY installed pack (payload + lists + index) in one pass.
async function uninstallAll() {
  if (!adapter) throw new Error('pack layer not ready');
  const packs = await listInstalled();
  let removed = 0;
  for (const p of packs) {
    try { await uninstallCore(p.id); removed++; } catch (e) { /* skip a bad pack, keep going */ }
  }
  await opfs.gc();     // reclaim all now-unreferenced blobs once
  await sync();
  await refresh();
  return { removed, total: packs.length };
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
  // Loose aircraft files belong in the dedicated workbench page (creation
  // space); here they just get a pointer instead of the "not a zip" pile.
  const loose = all.filter((f) => /\.(dat|dnm|srf)$/i.test(f.name));
  const nonZip = all.filter((f) => !/\.zip$/i.test(f.name) && !/\.(dat|dnm|srf)$/i.test(f.name));
  const failed = [];          // { name, error }
  const warned = [];          // import-time diagnostics (unresolved references)
  await ensureCache();        // load the in-memory list once (reliable: nothing writing yet)
  let okCount = 0, done = 0;
  const total = zips.length;
  // The tail (failure warnings + skipped non-zips) is shown under every status
  // line.  We set the PROGRESS line during the run and the DONE summary only at
  // the very end -- AFTER the list is rendered -- so the panel never shows
  // "✓ done" next to an empty list.
  const tail = () => [
    ...failed.map((f) => '✗ ' + f.name + ': ' + friendlyErr(f.error)),
    ...warned,
    ...(loose.length ? [S.looseHint(loose.map((f) => f.name))] : []),
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
        const res = await installCore(bytes, file.name.replace(/\.zip$/i, '')); // also upserts `cache`
        if (res.diagnostics && res.diagnostics.missing > 0) {
          warned.push(file.name + ': ' + S.diagWarn(res.diagnostics.missing, res.diagnostics.samples || []));
        }
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
  if (zips.length > 0) {
    setStatus(S.bulkDone(okCount, failed.length)); // done summary LAST, after the list is shown
  } else if (status) {
    status.textContent = tail().join('\n'); // loose-only drop: point at the workbench page
  }
}

// --- workbench (loose-file aircraft assembly + test-fly) ----------------------

// Reload straight into a flight with the given aircraft (engine -freeflight via
// the shell's ?freeflight= path; default field/start come from index.html).
// Only lang survives from the current query — everything else is stale intent.
function flyFreeflight(identify, field, start) {
  const q = new URLSearchParams(location.search);
  const next = new URLSearchParams();
  next.set('freeflight', [identify, field, start].filter(Boolean).join(','));
  if (q.get('lang')) next.set('lang', q.get('lang'));
  location.href = location.pathname + '?' + next.toString();
}

// The ASCII aircraft identities of an installed pack, read from the generated
// .lst.idx sidecar kept in its OPFS record (datPath\tIDENTIFY\tCATEGORY per
// line).  A Shift-JIS-named aircraft has no sidecar entry by design (see
// parseDatIdentity) and so cannot be test-flown by name.
async function aircraftIdentities(id) {
  const rec = await opfs.getRecord(id);
  if (!rec) return [];
  const out = [];
  for (const g of rec.generated || []) {
    if (!/^aircraft\/.*\.lst\.idx$/.test(g.file)) continue;
    for (const line of (g.text || '').split('\n')) {
      const t = line.split('\t');
      if (t.length >= 2 && t[1]) out.push(t[1]);
    }
  }
  return out;
}

// Attribution metadata (author / redistribution policy) some packs carry in
// their embedded recipe (workbench.json, written by the pack studio — see
// web/studio-pack-core.js).  DISPLAY ONLY: read lazily per row, memoized;
// packs without a recipe resolve to null with no blob read, and a pack that
// recorded nothing shows nothing (never inferred).
const RECIPE_PATH = 'workbench.json'; // = RECIPE_FILE in workbench.js
const attribCache = new Map(); // pack id -> {author, policy} | null
async function attributionOf(id) {
  if (attribCache.has(id)) return attribCache.get(id);
  let out = null;
  try {
    const rec = await opfs.getRecord(id);
    const rf = rec && (rec.files || []).find((f) => f.path === RECIPE_PATH);
    let a = null;
    if (rf) {
      const recipe = JSON.parse(new TextDecoder().decode(await opfs.getBlob(rf.sha256)));
      a = recipe && recipe.attribution;
    } else if (rec && rec.attribution) {
      // Record-level carry from "update from ZIP" (the new zip shipped no
      // recipe, so the pack's previously recorded attribution rides the record).
      a = rec.attribution;
    }
    const author = a ? String(a.author || '').trim() : '';
    const policy = a && S.attribPolicy[a.policy] ? a.policy : '';
    if (author || policy) out = { author, policy };
  } catch (e) { /* display-only — a broken recipe shows nothing */ }
  attribCache.set(id, out);
  return out;
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
  const shellSkeleton = document.getElementById('ysfw-skeleton');
  if (shellSkeleton) shellSkeleton.remove(); // the real Quick Flight grid replaces the placeholder

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
  qHint.style.cssText = 'color:#7d93b0;font-size:11px;margin-bottom:8px';
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
        (p.recommended ? 'color:' + ACCENT + ';font-weight:700' : 'color:#7d93b0');
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

  // ---- Missions: the engine's endurance mode via ?endurance= deep links -------
  // Same card idiom as Quick Flight; a separate section so the "just fly" and
  // "fight" entries don't blur.  Bundled aircraft/fields only (same rule as
  // PRESETS: a deep link must never point into an uninstalled add-on).
  const mTitle = document.createElement('div');
  mTitle.textContent = S.missionTitle;
  mTitle.style.cssText = 'color:#e6edf3;font-size:14px;font-weight:600;letter-spacing:.04em;margin:14px 0 2px';
  quickWrap.appendChild(mTitle);
  const mHint = document.createElement('div');
  mHint.textContent = S.missionHint;
  mHint.style.cssText = 'color:#7d93b0;font-size:11px;margin-bottom:8px';
  quickWrap.appendChild(mHint);
  const mGrid = document.createElement('div');
  mGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px';
  const MISSIONS = [
    { name: 'F-15J Eagle', sub: S.missionEasySub, link: '?endurance=F-15J_EAGLE,ATSUGI_AIRBASE,2,3,1', tag: S.tagIntermediate },
    { name: 'F-15J Eagle', sub: S.missionInterceptSub, link: '?intercept=F-15J_EAGLE,ATSUGI_AIRBASE', tag: S.tagIntermediate },
    { name: 'F/A-18 Hornet', sub: S.missionHardSub, link: '?endurance=F-18C_HORNET,HAWAII,0,5,1', tag: S.tagAdvanced },
  ];
  for (const m of MISSIONS) {
    const card = document.createElement('button');
    card.style.cssText = 'text-align:left;padding:9px 11px;border-radius:8px;cursor:pointer;border:1px solid #243244;background:#0d141d';
    const nm = document.createElement('div');
    nm.textContent = '🎯 ' + m.name;
    nm.style.cssText = 'color:#e6edf3;font-size:13px;font-weight:600';
    const sub = document.createElement('div');
    sub.textContent = m.sub;
    sub.style.cssText = 'color:#8fa3bb;font-size:11px;margin-top:1px';
    card.appendChild(nm);
    card.appendChild(sub);
    const tag = document.createElement('div');
    tag.textContent = m.tag;
    tag.style.cssText = 'margin-top:5px;font-size:10px;color:#7d93b0';
    card.appendChild(tag);
    card.addEventListener('click', () => {
      location.assign(location.origin + location.pathname + m.link + (curLang ? '&lang=' + encodeURIComponent(curLang) : ''));
    });
    mGrid.appendChild(card);
  }
  quickWrap.appendChild(mGrid);

  // Create Flight: author a custom flight (aircraft/map/time/AI) on a dedicated
  // page, then take off — the web-shell replacement for Sim > Create Flight.
  const createLink = document.createElement('a');
  createLink.textContent = S.createFlightLink;
  createLink.title = S.createFlightTitle;
  createLink.href = 'studio-flight.html' + (curLang ? '?lang=' + encodeURIComponent(curLang) : '');
  createLink.style.cssText = 'display:block;margin-top:12px;padding:9px 11px;border:1px dashed #345;border-radius:8px;color:' + ACCENT + ';font-size:13px;text-decoration:none;text-align:center';
  quickWrap.appendChild(createLink);

  // Settings: the web replacement for the engine's Option menu.
  const settingsLink = document.createElement('a');
  settingsLink.textContent = S.settingsLink;
  settingsLink.title = S.settingsTitle;
  settingsLink.href = 'studio-settings.html' + (curLang ? '?lang=' + encodeURIComponent(curLang) : '');
  settingsLink.style.cssText = 'display:block;margin-top:8px;padding:7px 11px;color:#8fa3bb;font-size:12px;text-decoration:none;text-align:center';
  quickWrap.appendChild(settingsLink);

  panel.appendChild(quickWrap);

  // ▶ Play (primary CTA) sits directly under Quick Flight — ABOVE the add-on
  // management — so it isn't buried at the bottom under a panel most visitors never
  // touch.  Order: Quick Flight -> Play -> (collapsible) add-on management.
  const playBtn = document.createElement('button');
  playBtn.id = 'ysfw-pack-play';
  playBtn.textContent = S.playBtn;
  playBtn.style.cssText =
    'margin-top:14px;width:100%;padding:11px;border:0;border-radius:8px;background:' + ACCENT + ';' +
    'color:#04101f;font-size:15px;font-weight:700;cursor:pointer';
  playBtn.addEventListener('click', start);
  panel.appendChild(playBtn);
  // Disambiguate the two "start" affordances: the Quick Flight cards above take off
  // instantly on a fixed preset, whereas Play opens the engine menu — the route to
  // pick your own aircraft/maps or host multiplayer.  One quiet line under the button.
  const playHint = document.createElement('div');
  playHint.textContent = S.playHint;
  playHint.style.cssText = 'color:#7d93b0;font-size:11px;margin-top:6px;text-align:center;line-height:1.45';
  panel.appendChild(playHint);

  // "Play in VR": shown only once immersive-vr support is CONFIRMED (async
  // probe below), so flat-screen visitors never see a dead button.  It boots
  // the exact same way as Play plus a window.__ysfwVrAutostart flag —
  // index.html's VR block picks that up once the engine reports XR support
  // and calls vr.enter() (or shows a one-tap overlay when the click's user
  // activation didn't survive the wasm boot).
  const vrPlayBtn = document.createElement('button');
  vrPlayBtn.id = 'ysfw-pack-play-vr';
  vrPlayBtn.textContent = S.vrPlayBtn;
  vrPlayBtn.style.cssText =
    'display:none;margin-top:8px;width:100%;padding:10px;border:1px solid ' + ACCENT + ';border-radius:8px;' +
    'background:rgba(77,163,255,.10);color:#cfe0f5;font-size:14px;font-weight:700;cursor:pointer';
  vrPlayBtn.addEventListener('click', () => {
    window.__ysfwVrAutostart = true;
    start();
  });
  panel.appendChild(vrPlayBtn);
  const vrPlayHint = document.createElement('div');
  vrPlayHint.textContent = S.vrPlayHint;
  vrPlayHint.style.cssText = 'display:none;color:#7d93b0;font-size:11px;margin-top:6px;text-align:center;line-height:1.45';
  panel.appendChild(vrPlayHint);
  try {
    if (navigator.xr && navigator.xr.isSessionSupported) {
      navigator.xr.isSessionSupported('immersive-vr').then((ok) => {
        if (ok) {
          vrPlayBtn.style.display = '';
          vrPlayHint.style.display = '';
        }
      }).catch(() => {});
    }
  } catch (e) {}

  // Add-on management, COLLAPSED by default (auto-expanded once the visitor has
  // installed packs; see renderList).  Opening it is a deliberate "I want to add or
  // manage add-ons" act — the label invites exactly that when empty.
  const packSection = document.createElement('div');
  packSection.style.cssText = 'margin-top:16px;border-top:1px solid #1d2633;padding-top:12px';
  const packToggle = document.createElement('button');
  packToggle.id = 'ysfw-pack-toggle';
  packToggle.setAttribute('aria-expanded', 'false');
  packToggle.style.cssText =
    'width:100%;text-align:left;background:none;border:0;color:#cfe0f5;font-size:13px;' +
    'font-weight:600;letter-spacing:.02em;cursor:pointer;padding:2px 0';
  const packBody = document.createElement('div');
  packBody.id = 'ysfw-pack-body';
  packBody.style.cssText = 'display:none;margin-top:10px';
  packToggle.addEventListener('click', () => {
    const willOpen = packBody.style.display === 'none';
    packBody.style.display = willOpen ? 'block' : 'none';
    packToggle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    packAutoExpanded = true; // user took control; a later refresh won't re-toggle
    updatePackToggleLabel();
  });
  packToggleEl = packToggle;
  packBodyEl = packBody;
  packSection.appendChild(packToggle);
  packSection.appendChild(packBody);
  panel.appendChild(packSection);
  updatePackToggleLabel();

  // Where do installed packs show up?  The biggest modder drop-off is not knowing
  // the aircraft/maps appear under the engine's Simulation -> Create Flight.
  const postPlay = document.createElement('div');
  postPlay.textContent = S.postPlayHint;
  postPlay.style.cssText = 'color:#7d93b0;font-size:11px;margin:0 0 10px;line-height:1.5';
  packBody.appendChild(postPlay);

  // Bulk actions (hidden until packs exist).  A first release doesn't push add-ons,
  // so a returning modder needs one click back to plain YSFLIGHT (disable all) and,
  // separately, a way to wipe the whole library (delete all, with confirm).
  const bulkBar = document.createElement('div');
  bulkBar.id = 'ysfw-pack-bulk';
  bulkBar.style.cssText = 'display:none;justify-content:flex-end;gap:6px;margin:0 0 8px';
  const bulkStatusFor = () => document.getElementById('ysfw-pack-status');
  const runBulk = async (fn, done) => {
    const st = bulkStatusFor();
    if (bulkToggleBtn) bulkToggleBtn.disabled = true;
    if (bulkDeleteBtn) bulkDeleteBtn.disabled = true;
    if (st) st.textContent = S.bulkWorking;
    try {
      const r = await fn();
      if (st) st.textContent = done(r);
    } catch (e) {
      if (st) st.textContent = S.errorPrefix + (e && e.message ? e.message : e);
    } finally {
      if (bulkToggleBtn) bulkToggleBtn.disabled = false;
      if (bulkDeleteBtn) bulkDeleteBtn.disabled = false;
    }
  };
  bulkToggleBtn = document.createElement('button');
  bulkToggleBtn.textContent = S.disableAllBtn;
  bulkToggleBtn.style.cssText =
    'font-size:12px;padding:5px 11px;border-radius:5px;cursor:pointer;border:1px solid ' +
    ACCENT + ';background:rgba(77,163,255,.12);color:' + ACCENT;
  bulkToggleBtn.addEventListener('click', () => {
    const enableAll = bulkToggleBtn.dataset.enableAll === '1';
    runBulk(() => window.ysfwPacks.setEnabledAll(enableAll),
      (r) => (enableAll ? S.bulkEnabled : S.bulkDisabled)(r.changed));
  });
  bulkDeleteBtn = document.createElement('button');
  bulkDeleteBtn.textContent = S.deleteAllBtn;
  bulkDeleteBtn.title = S.deleteAllTitle;
  bulkDeleteBtn.style.cssText =
    'font-size:12px;padding:5px 11px;border-radius:5px;cursor:pointer;border:1px solid #2a3647;background:#0d141d;color:#c75d6a';
  bulkDeleteBtn.addEventListener('click', () => {
    if (!self.confirm(S.confirmDeleteAll(packCount))) return;
    runBulk(() => window.ysfwPacks.uninstallAll(), (r) => S.bulkRemoved(r.removed));
  });
  bulkBar.appendChild(bulkToggleBtn);
  bulkBar.appendChild(bulkDeleteBtn);
  bulkBarEl = bulkBar;
  packBody.appendChild(bulkBar);

  listEl = document.createElement('div');
  listEl.id = 'ysfw-pack-list';
  // Cap the installed-pack list and scroll it internally, so importing hundreds of
  // packs keeps the panel (drop zone, status, Play button) within the viewport.
  listEl.style.cssText = 'max-height:40vh;overflow-y:auto';
  packBody.appendChild(listEl);

  // Drop zone + file picker.
  const drop = document.createElement('label');
  drop.style.cssText =
    'display:block;margin-top:8px;padding:14px;border:1px dashed #2a3647;border-radius:8px;' +
    'color:#8fa3bb;font-size:13px;text-align:center;cursor:pointer;transition:border-color .15s,background .15s';
  drop.textContent = S.dropZone;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.zip,.dat,.dnm,.srf';
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
  packBody.appendChild(drop);
  const dropHintEl = document.createElement('div');
  dropHintEl.textContent = S.dropHint;
  dropHintEl.style.cssText = 'color:#7d93b0;font-size:10.5px;margin-top:4px;text-align:center';
  packBody.appendChild(dropHintEl);

  // Creation lives on its own page: the workbench (assemble aircraft, make a
  // .dat from stock, draw island maps).  Packs made there are OPFS records,
  // which this page materializes at every boot — so the link IS the whole
  // integration.
  const wbLink = document.createElement('a');
  wbLink.href = 'workbench.html' + (LANG === 'ja' ? '' : '?lang=' + LANG);
  wbLink.textContent = S.wbLink;
  wbLink.title = S.wbLinkTitle;
  wbLink.style.cssText =
    'display:block;margin-top:8px;padding:9px 12px;border:1px solid #2a3647;border-radius:6px;' +
    'color:#8fa3bb;font-size:12.5px;text-decoration:none;text-align:center';
  packBody.appendChild(wbLink);

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
  packBody.appendChild(urlRow);

  const status = document.createElement('div');
  status.id = 'ysfw-pack-status';
  status.style.cssText = 'color:#8fa3bb;font-size:12px;min-height:1.2em;margin-top:8px;white-space:pre-line;max-height:7.5em;overflow:auto';
  packBody.appendChild(status);

  storageEl = document.createElement('div');
  storageEl.style.cssText = 'color:#7d93b0;font-size:11px;margin-top:4px';
  packBody.appendChild(storageEl);

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
// True when the /turn fetch (index.html) populated an actual TURN relay (a turn:/turns:
// URL), so a symmetric-NAT/CGNAT joiner CAN relay.  Mirrors index.html turnAvailable();
// used to pick the right timeout copy in showJoinFailure (operator-config vs. user-network).
function turnConfigured() {
  const ice = (window.Module && window.Module.ysfwIceServers) || window.ysfwPackIce;
  if (!Array.isArray(ice)) return false;
  return ice.some((s) => {
    const u = s && s.urls;
    return (Array.isArray(u) ? u : [u]).some((x) => typeof x === 'string' && /^turns?:/.test(x));
  });
}

function showJoinFailure(failed, handlers) {
  const M = window.Module;
  if (M) M.__ysfwJoinFailureShown = true;
  const overlay = document.getElementById('overlay');
  if (!overlay) { if (handlers && handlers.onSolo) handlers.onSolo(); return; } // no UI host -> degrade to solo
  const skeleton = document.getElementById('ysfw-skeleton');
  if (skeleton) skeleton.remove(); // drop the loading placeholder before the failure panel
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
    let k = reasonKey(f.reason);
    // A timeout with no TURN relay configured is an OPERATOR problem (server has no
    // relay so symmetric-NAT/CGNAT peers can never connect), not the joiner's network
    // — don't tell them to "connect directly"; point at the real cause.
    if (k === 'timeout' && !turnConfigured()) k = 'timeoutNoTurn';
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

// HOST (multiplayer): read a pack's COMPLETE file tree straight from the durable
// OPFS content-addressed store, NOT from MEMFS.  The MEMFS copy is lazy and partial:
// boot materializes only .lst/.dat/.stp metadata and the heavy payload is both
// deferred and LRU-evictable (see materializeEnabled + the openat hook), so walking
// MEMFS would ship a pack MISSING its models/textures.  The joiner recomputes the
// content-hash id over what it receives, so a partial tree yields a DIFFERENT id ->
// id-mismatch -> rollback -> the pack never syncs.  The OPFS record always holds the
// full immutable tree, so a zip built from it is complete regardless of what is
// resident or evicted.  Returns { relPath: Uint8Array } (rel to packs/<id>/), {} if
// the pack is unknown.
async function packFilesForHost(id) {
  const rec = await opfs.getRecord(id);
  if (!rec || !rec.files) return {};
  const out = {};
  for (const f of rec.files) out[f.path] = await opfs.getBlob(f.sha256);
  return out;
}

// HOST (multiplayer): the non-byte pack metadata a joiner's advertised manifest
// needs -- currently just sourceUrl for the Option-B self-fetch.  Read from the OPFS
// record (durable), NOT a MEMFS packs/<id>/manifest.json, which is not materialized
// under the lazy-pack scheme (.lst/.dat/.stp only) -- so the old MEMFS read silently
// lost sourceUrl and forced every pack onto the P2P push path.  Returns { sourceUrl? }.
async function packMetaForHost(id) {
  const rec = await opfs.getRecord(id);
  if (!rec) return null;
  return rec.sourceUrl ? { sourceUrl: rec.sourceUrl } : {};
}

// HOST (multiplayer, Step 1): the metadata-only payload for ONE pack -- its record
// meta (id/name/categories/files/generated/sourceUrl) plus the .lst/.dat/.stp BLOBS
// the joiner's boot template scan reads.  Lets a joiner install the pack as a SPARSE
// record (menu + scan complete, heavy geometry deferred) in one bundle without a full
// byte pull.  Works for a SPARSE local record too (its meta blobs are present), so a
// meta-only joiner can re-serve.  Returns { record, blobs:{sha256:bytes} } or null --
// null if a meta blob is missing, so we never ship a record the joiner can't materialize.
async function packMetaBundleForHost(id) {
  const rec = await opfs.getRecord(id);
  if (!rec || !rec.files) return null;
  const blobs = {};
  for (const f of rec.files) {
    if (!PINNED_EXT.test(f.path)) continue; // only the .lst/.dat/.stp the scan reads
    try { blobs[f.sha256] = await opfs.getBlob(f.sha256); }
    catch (e) { return null; }
  }
  const record = { id: rec.id, name: rec.name, categories: rec.categories || [], files: rec.files, generated: rec.generated || [] };
  if (rec.sourceUrl) record.sourceUrl = rec.sourceUrl;
  return { record, blobs };
}

// JOINER (multiplayer, Step 1): install a host's packs as SPARSE records from one
// metadata bundle (fetchMetaBundle).  The bundle is a zip of records.json (per-pack
// meta) + blob/<sha256> entries (the .lst/.dat/.stp the boot scan reads).  For each
// pack we verify every meta blob's sha256, store it, write a sparse record (sparse:
// true, enabled), and materialize its listing so the engine's scan + menu see the
// pack -- WITHOUT the heavy geometry (deferred; until a later lazy fetch those
// aircraft render broken, the same degraded state as a timed-out best-effort pull).
// Best-effort PER PACK: an incomplete/forged/failed pack is skipped, never aborts the
// batch.  Returns { installed:[ids] }.
async function installMetaBundle(zipBytes) {
  if (!adapter && !setupFS()) return { installed: [] };
  let files;
  try { files = unzipSync(zipBytes instanceof Uint8Array ? zipBytes : new Uint8Array(zipBytes)); }
  catch (e) { console.warn('[packs] meta bundle unzip failed: ' + (e && e.message ? e.message : e)); return { installed: [] }; }
  const recsRaw = files['records.json'];
  if (!recsRaw) return { installed: [] };
  let records;
  try { records = JSON.parse(new TextDecoder().decode(recsRaw)); } catch (e) { return { installed: [] }; }
  const installed = [];
  for (const rec of (records || [])) {
    if (!rec || !rec.id || !Array.isArray(rec.files)) continue;
    try {
      // The bundle must carry every .lst/.dat/.stp blob (the scan reads these); verify
      // each against its advertised hash before storing, then write the sparse record.
      const metaFiles = rec.files.filter((f) => PINNED_EXT.test(f.path));
      let ok = true, bytes = 0;
      for (const f of metaFiles) {
        const blob = files['blob/' + f.sha256];
        if (!blob) { ok = false; break; }
        if (await webSha256(blob) !== f.sha256) { ok = false; break; } // integrity: bytes must match the hash
        await opfs.putBlob(f.sha256, blob);
        bytes += blob.length;
      }
      if (!ok) { console.warn('[packs] meta bundle: incomplete/forged meta for ' + rec.id + ' -- skipped'); continue; }
      const record = {
        id: rec.id, name: rec.name, categories: rec.categories || [],
        bytes, enabled: true, installedAt: Date.now(), source: 'p2p-meta',
        files: rec.files, generated: rec.generated || [], sparse: true,
      };
      if (rec.sourceUrl) record.sourceUrl = rec.sourceUrl;
      await opfs.putRecord(record);
      // Materialize the listing NOW: materializeEnabled (the boot-wide pass) has
      // usually already run by the time this pre-boot network sync resolves, so a
      // late-arriving sparse pack must write its own .lst/.dat/.stp + generated lists
      // or the scan would miss it.
      await opfs.materialize(record, adapter, { metaOnly: true });
      cacheUpsert({ id: record.id, name: record.name, enabled: true, bytes: record.bytes, categories: record.categories });
      installed.push(record.id);
    } catch (e) {
      console.warn('[packs] meta bundle: install failed for ' + (rec && rec.id) + ': ' + (e && e.message ? e.message : e));
    }
  }
  return { installed };
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
  updateFromZip,        // update an installed pack's contents from a new zip (state carries over)
  setEnabledAll,        // bulk: enable/disable every installed pack (one syncfs+refresh)
  uninstallAll,         // bulk: uninstall every installed pack (one gc+syncfs+refresh)
  list: listInstalled,
  start,
  refresh,
  showJoinFailure,
  setupFS,
  materializeEnabled,
  packFilesForHost, // multiplayer host: serve a complete pack from OPFS (not lazy MEMFS)
  packMetaForHost,  // multiplayer host: advertise sourceUrl from OPFS (not lazy MEMFS)
  packMetaBundleForHost, // multiplayer host (Step 1): serve a pack's .lst/.dat/.stp meta bundle
  installMetaBundle,     // multiplayer joiner (Step 1): sparse-install many packs from one meta bundle
  memfsStats: () => (lru ? lru.stats() : null), // layer3 LRU observability (smoke/debug)
  aircraftIdentities,       // test-fly button: ASCII identities of an installed pack (smoke/debug)
};
window.ysfwPacksInit = init;

// If index.html already signalled FS readiness before this module evaluated,
// initialize now (normally init() is called from the preRun syncfs callback).
if (window.__ysfwFsReady) init();
