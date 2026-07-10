// studio-pack.js — Pack Studio: full inventory + composition manager.
// Engine-less (OPFS only); studioChrome injects all CSS.
// See workbench-page.js for string tone and row-render reference.

import {
  studioChrome, LANG, el, flyUrl, pageUrl,
  installZip, DEFAULT_FLY_AIRCRAFT,
} from './studio-shared.js';
import * as opfs from './opfs-store.js';
import { RECIPE_FILE, SCENERY_START } from './workbench.js';
import { zipSync } from './vendor/fflate.js';
import { listStaged, getStaged, removeStaged, putStaged } from './staging.js';

// --- strings ---------------------------------------------------------------

const S = ({
  ja: {
    title: '📦 パックスタジオ',
    errorPrefix: 'エラー: ',
    working: '作業中…',
    invTitle: '📦 インストール済みパック',
    invEmpty: '（まだパックがありません — 下の「取り込み」でzipを追加できます）',
    invFiltered: '（絞り込み結果: 0件）',
    filterPlaceholder: '名前・IDで絞り込み',
    selAll: '全選択',
    selNone: '選択解除',
    countSummary: (n, total) => n + ' / ' + total + ' 件',
    kindGlyph: { aircraft: '✈️', scenery: '🏝', other: '📦', mixed: '📦' },
    recipeMark: ' 🛠',
    idLabel: (id) => id.slice(0, 8),
    enabledOn: '有効', enabledOff: '無効',
    flyBtn: '🛫', flyTitle: 'テスト飛行（ゲームページに移動します）',
    editBtn: '✏️', editTitle: '続きから編集',
    expBtn: '⬇', expTitle: 'zipとしてダウンロード',
    expDone: (name) => '✓ 「' + name + '」をエクスポートしました',
    delBtn: '🗑', delTitle: '削除',
    delConfirm: (n) => '「' + n + '」を削除しますか？',
    delDone: (n) => '✓ 「' + n + '」を削除しました',
    composeTitle: '🧩 パック合成',
    composeSub: '選択したパックのファイルを1本のzipにまとめます。',
    composeSizeHint: (s) => '合計 ' + s,
    composeName: '合成パック名',
    composeBtn: '選択を1つのzipに合成',
    composeDone: (n) => '✓ ' + n + ' 件を合成しました',
    composeCollision: (path) => '⚠ パス衝突: ' + path,
    composeNeedSel: '1件以上選択してください',
    composeNeedName: 'パック名を入れてください',
    composeInstall: '取り込む',
    importTitle: '📥 zip取り込み',
    importDrop: 'zipをドロップ / クリックして選択',
    importDone: (name, n) => '✓ 「' + name + '」を取り込みました（テンプレート ' + n + ' 件）',
    stagedTitle: '🧊 モデラ連携',
    stagedHint: 'Polygon Crestで保存したファイルは自動でここに届きます',
    stagedEmpty: '（まだありません — 🧊 でモデルを保存すると届きます）',
    stagedSend: '＋ ファイルを送る',
    stagedSendTitle: '手持ちの .srf/.dnm/.dat をモデラと共有領域に入れる',
    stagedSent: (n) => '✓ ' + n + ' 件を送りました',
    stagedDl: '⬇', stagedDlTitle: 'ダウンロード（手元に保存）',
    stagedDel: '🗑',
  },
  en: {
    title: '📦 Pack Studio',
    errorPrefix: 'Error: ',
    working: 'Working…',
    invTitle: '📦 Installed Packs',
    invEmpty: '(No packs yet — import a zip below)',
    invFiltered: '(No matches)',
    filterPlaceholder: 'Filter by name or ID',
    selAll: 'Select all',
    selNone: 'Deselect all',
    countSummary: (n, total) => n + ' of ' + total,
    kindGlyph: { aircraft: '✈️', scenery: '🏝', other: '📦', mixed: '📦' },
    recipeMark: ' 🛠',
    idLabel: (id) => id.slice(0, 8),
    enabledOn: 'On', enabledOff: 'Off',
    flyBtn: '🛫', flyTitle: 'Test-fly (moves to the game page)',
    editBtn: '✏️', editTitle: 'Continue editing',
    expBtn: '⬇', expTitle: 'Export as zip',
    expDone: (name) => '✓ Exported "' + name + '"',
    delBtn: '🗑', delTitle: 'Delete',
    delConfirm: (n) => 'Delete "' + n + '"?',
    delDone: (n) => '✓ Deleted "' + n + '"',
    composeTitle: '🧩 Compose Pack',
    composeSub: 'Merge selected packs' files into one zip.',
    composeSizeHint: (s) => 'Total ' + s,
    composeName: 'Merged pack name',
    composeBtn: 'Merge selected into one zip',
    composeDone: (n) => '✓ Merged ' + n + ' pack(s)',
    composeCollision: (path) => '⚠ Path collision: ' + path,
    composeNeedSel: 'Select at least one pack',
    composeNeedName: 'Enter a pack name',
    composeInstall: 'Import merged',
    importTitle: '📥 Import zip',
    importDrop: 'Drop .zip / click to choose',
    importDone: (name, n) => '✓ Imported "' + name + '" (' + n + ' template(s))',
    stagedTitle: '🧊 Modeler Bridge',
    stagedHint: 'Files saved in Polygon Crest arrive here automatically',
    stagedEmpty: '(Nothing yet — save a model in 🧊 and it lands here)',
    stagedSend: '＋ Send a file',
    stagedSendTitle: 'Put your own .srf/.dnm/.dat into the shared modeler area',
    stagedSent: (n) => '✓ Sent ' + n + ' file(s)',
    stagedDl: '⬇', stagedDlTitle: 'Download a copy',
    stagedDel: '🗑',
  },
})[LANG];

// --- helpers ---------------------------------------------------------------

const fmtBytes = (n) => {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / 1024).toFixed(1) + ' KB';
};

// Extract display metadata from a raw OPFS record (mirrors listCreations in
// studio-shared.js but covers ALL records, not just recipe-carrying ones).
function recordMeta(rec) {
  const cats = rec.categories || [];
  const kind = cats.length > 1 ? 'mixed'
    : cats[0] === 'aircraft' ? 'aircraft'
    : cats[0] === 'scenery' ? 'scenery'
    : 'other';
  const hasRecipe = (rec.files || []).some((f) => f.path === RECIPE_FILE);
  const identities = [];
  let sceneryIdent = null;
  for (const g of rec.generated || []) {
    if (/^aircraft\/.*\.lst\.idx$/.test(g.file)) {
      for (const line of (g.text || '').split('\n')) {
        const t = line.split('\t');
        if (t.length >= 2 && t[1]) identities.push(t[1]);
      }
    } else if (/^scenery\/.*\.lst$/.test(g.file) && !/\.idx$/.test(g.file)) {
      const first = (g.text || '').split('\n').find(Boolean);
      if (first) sceneryIdent = first.trim().split(/\s+/)[0].replace(/^"|"$/g, '') || null;
    }
  }
  return { kind, hasRecipe, identities, sceneryIdent };
}

// Sanitize a record name for use as a collision-fallback folder prefix.
const sanitizeFolderName = (name) =>
  String(name || 'pack').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'pack';

// Reconstruct the original zip from a record: one blob fetch per file entry.
async function exportRecord(rec) {
  const data = {};
  for (const f of (rec.files || [])) {
    data[f.path] = await opfs.getBlob(f.sha256);
  }
  return zipSync(data);
}

// Trigger a browser download of bytes as <name>.zip.
function downloadZip(bytes, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  a.download = name + '.zip';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// --- page state ------------------------------------------------------------

let allRecords = [];       // full list from OPFS, sorted newest-first
let filterText = '';       // current filter input value
let checkedIds = new Set(); // record ids selected for composition
let currentRecordCount = 0; // count of currently rendered rows (smoke hook)

// Mutable render hooks — assigned by build* functions, called cross-section.
let renderInventory = () => {};
let renderComposeSummary = () => {};

// smoke hook (ready flag set after first render)
window.ysfwStudio = { ready: false, page: 'pack', count: () => currentRecordCount };

// --- filtered view ---------------------------------------------------------

function visibleRecords() {
  if (!filterText) return allRecords;
  const q = filterText.toLowerCase();
  return allRecords.filter((rec) => {
    if ((rec.name || '').toLowerCase().includes(q)) return true;
    if ((rec.id || '').toLowerCase().includes(q)) return true;
    const m = recordMeta(rec);
    if (m.identities.some((id) => id.toLowerCase().includes(q))) return true;
    if (m.sceneryIdent && m.sceneryIdent.toLowerCase().includes(q)) return true;
    return false;
  });
}

// --- inventory (main area) -------------------------------------------------

function buildInventory(main) {
  // toolbar — flex:none strip above the scrollable list
  const toolbar = el('div');
  toolbar.style.cssText =
    'flex:none;display:flex;align-items:center;gap:8px;padding:10px 14px;' +
    'border-bottom:1px solid #2a3647;background:#0d141d;flex-wrap:wrap';

  const selAllBtn = el('button', null, S.selAll);
  selAllBtn.style.cssText = 'font-size:12px;padding:4px 10px;flex:none';

  const selNoneBtn = el('button', null, S.selNone);
  selNoneBtn.style.cssText = 'font-size:12px;padding:4px 10px;flex:none';

  const filterIn = document.createElement('input');
  filterIn.type = 'text';
  filterIn.placeholder = S.filterPlaceholder;
  filterIn.style.cssText =
    'flex:1;min-width:120px;padding:5px 9px;border:1px solid #2a3647;border-radius:6px;' +
    'background:#0b1017;color:#e6edf3;font-size:13px';

  const countEl = el('span');
  countEl.style.cssText = 'flex:none;color:#7d93b0;font-size:12px;white-space:nowrap';

  toolbar.appendChild(selAllBtn);
  toolbar.appendChild(selNoneBtn);
  toolbar.appendChild(filterIn);
  toolbar.appendChild(countEl);
  main.appendChild(toolbar);

  // scrollable list body
  const listEl = el('div');
  listEl.style.cssText = 'flex:1;overflow-y:auto;padding:10px 14px';
  main.appendChild(listEl);

  // status/error message at the top of the list
  const invMsg = el('div', 'msg');
  listEl.appendChild(invMsg);

  selAllBtn.addEventListener('click', () => {
    for (const r of visibleRecords()) checkedIds.add(r.id);
    renderInventory();
    renderComposeSummary();
  });

  selNoneBtn.addEventListener('click', () => {
    checkedIds.clear();
    renderInventory();
    renderComposeSummary();
  });

  filterIn.addEventListener('input', () => {
    filterText = filterIn.value;
    renderInventory();
  });

  renderInventory = async () => {
    try { allRecords = await opfs.listRecords(); } catch (e) { allRecords = []; }
    allRecords.sort((a, b) => (b.installedAt || 0) - (a.installedAt || 0));

    const vis = visibleRecords();
    currentRecordCount = vis.length;
    countEl.textContent = S.countSummary(vis.length, allRecords.length);

    // keep invMsg, remove old rows
    while (listEl.children.length > 1) listEl.removeChild(listEl.lastChild);

    if (vis.length === 0) {
      invMsg.textContent = allRecords.length === 0 ? S.invEmpty : S.invFiltered;
      renderComposeSummary();
      return;
    }
    invMsg.textContent = '';

    for (const rec of vis) {
      const meta = recordMeta(rec);
      const disabled = rec.enabled === false;

      const rowEl = el('div');
      rowEl.style.cssText =
        'display:flex;align-items:center;gap:6px;padding:7px 10px;' +
        'border:1px solid #2a3647;border-radius:7px;margin-bottom:6px;background:#0b1017' +
        (disabled ? ';opacity:.55' : '');

      // checkbox for composition selection
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = checkedIds.has(rec.id);
      cb.style.cssText = 'flex:none;width:14px;height:14px;cursor:pointer;accent-color:#4da3ff';
      cb.addEventListener('change', () => {
        if (cb.checked) checkedIds.add(rec.id);
        else checkedIds.delete(rec.id);
        renderComposeSummary();
      });
      rowEl.appendChild(cb);

      // kind glyph + recipe marker
      const glyph = el('span', null, (S.kindGlyph[meta.kind] || '📦') + (meta.hasRecipe ? S.recipeMark : ''));
      glyph.style.cssText = 'flex:none;font-size:15px;white-space:nowrap';
      rowEl.appendChild(glyph);

      // pack name
      const nm = el('span', null, rec.name || rec.id);
      nm.style.cssText =
        'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
        'color:#e6edf3;font-size:13.5px';
      rowEl.appendChild(nm);

      // short id (8 chars, muted monospace)
      const idEl = el('span', null, S.idLabel(rec.id));
      idEl.style.cssText = 'flex:none;color:#3d5166;font-size:10.5px;font-family:monospace';
      rowEl.appendChild(idEl);

      // size + file count
      const sz = el('span', null, fmtBytes(rec.bytes || 0) + ' · ' + (rec.files || []).length + 'f');
      sz.style.cssText = 'flex:none;color:#7d93b0;font-size:11px;white-space:nowrap';
      rowEl.appendChild(sz);

      // first identity / scenery ident
      const ident0 = meta.identities[0] || meta.sceneryIdent || '';
      if (ident0) {
        const idSpan = el('span', null, ident0);
        idSpan.style.cssText =
          'flex:none;color:#7d93b0;font-size:11px;max-width:18%;' +
          'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        rowEl.appendChild(idSpan);
      }

      // small button factory (appends to rowEl)
      const btn = (label, title, accent) => {
        const b = el('button', accent ? 'accent' : null, label);
        b.title = title;
        b.style.cssText += ';font-size:12px;padding:4px 8px;flex:none';
        rowEl.appendChild(b);
        return b;
      };

      // enabled/disabled toggle
      const onoff = btn(
        disabled ? S.enabledOff : S.enabledOn,
        '',
        !disabled,
      );
      onoff.addEventListener('click', async () => {
        try {
          await opfs.setEnabled(rec.id, disabled);
          renderInventory();
        } catch (e) {
          invMsg.textContent = S.errorPrefix + ((e && e.message) || e);
        }
      });

      // fly — aircraft by first identity; scenery by ident + SCENERY_START
      if (!disabled && (meta.identities.length > 0 || meta.sceneryIdent)) {
        const fly = btn(S.flyBtn, S.flyTitle, true);
        fly.addEventListener('click', () => {
          if (meta.identities.length > 0) {
            location.href = flyUrl(meta.identities[0]);
          } else {
            location.href = flyUrl(DEFAULT_FLY_AIRCRAFT, meta.sceneryIdent, SCENERY_START);
          }
        });
      }

      // edit — only for recipe-carrying records; routes to correct studio
      if (meta.hasRecipe) {
        const ed = btn(S.editBtn, S.editTitle, false);
        ed.addEventListener('click', async () => {
          try {
            const rf = (rec.files || []).find((f) => f.path === RECIPE_FILE);
            if (!rf) return;
            const bytes = await opfs.getBlob(rf.sha256);
            const recipe = JSON.parse(new TextDecoder().decode(bytes));
            const dest = recipe.type === 'scenery' ? 'studio-scenery.html' : 'studio-aircraft.html';
            location.href = pageUrl(dest, { edit: rec.id });
          } catch (e) {
            invMsg.textContent = S.errorPrefix + ((e && e.message) || e);
          }
        });
      }

      // export — reconstruct exact original zip from OPFS blobs
      const expBtn = btn(S.expBtn, S.expTitle, false);
      expBtn.addEventListener('click', async () => {
        expBtn.disabled = true;
        try {
          const zip = await exportRecord(rec);
          downloadZip(zip, rec.name || rec.id);
          invMsg.textContent = S.expDone(rec.name || rec.id);
        } catch (e) {
          invMsg.textContent = S.errorPrefix + ((e && e.message) || e);
        } finally {
          expBtn.disabled = false;
        }
      });

      // delete — confirm, removeRecord + gc + rerender
      const delBtn = btn(S.delBtn, S.delTitle, false);
      delBtn.style.color = '#c75d6a';
      delBtn.addEventListener('click', async () => {
        if (!self.confirm(S.delConfirm(rec.name || rec.id))) return;
        try {
          await opfs.removeRecord(rec.id);
          try { await opfs.gc(); } catch (_) {}
          checkedIds.delete(rec.id);
          invMsg.textContent = S.delDone(rec.name || rec.id);
          renderInventory();
        } catch (e) {
          invMsg.textContent = S.errorPrefix + ((e && e.message) || e);
        }
      });

      listEl.appendChild(rowEl);
    }

    renderComposeSummary();
  };
}

// --- rail (compose / import / staged) -------------------------------------

function buildRail(rail) {

  // === Compose section =====================================================
  rail.appendChild(el('h2', null, S.composeTitle));
  rail.appendChild(el('p', 'intro', S.composeSub));

  // total-size hint — updated by renderComposeSummary whenever selection changes
  const composeSizeEl = el('div', 'msg');
  composeSizeEl.style.marginBottom = '6px';
  rail.appendChild(composeSizeEl);

  // pack name input
  const nameIn = document.createElement('input');
  nameIn.type = 'text';
  nameIn.placeholder = S.composeName;
  nameIn.style.cssText =
    'width:100%;padding:6px 9px;border:1px solid #2a3647;border-radius:6px;' +
    'background:#0b1017;color:#e6edf3;font-size:13px;margin-bottom:8px';
  rail.appendChild(nameIn);

  const composeBtnRow = el('div', 'btnrow');
  const composeBtn = el('button', 'accent', S.composeBtn);
  const installBtn = el('button', null, S.composeInstall);
  installBtn.style.display = 'none';
  composeBtnRow.appendChild(composeBtn);
  composeBtnRow.appendChild(installBtn);
  rail.appendChild(composeBtnRow);

  const composeMsg = el('div', 'msg');
  rail.appendChild(composeMsg);

  let lastMergedBytes = null; // retained so installBtn can import without re-building

  // renderComposeSummary: show total size of selected packs; called by renderInventory
  renderComposeSummary = () => {
    const sel = allRecords.filter((r) => checkedIds.has(r.id));
    if (sel.length === 0) {
      composeSizeEl.textContent = '';
    } else {
      const totalBytes = sel.reduce((n, r) => n + (r.bytes || 0), 0);
      composeSizeEl.textContent = S.composeSizeHint(fmtBytes(totalBytes)) + ' (' + sel.length + '件)';
    }
  };

  composeBtn.addEventListener('click', async () => {
    const sel = allRecords.filter((r) => checkedIds.has(r.id));
    if (sel.length === 0) { composeMsg.textContent = S.composeNeedSel; return; }
    const packName = nameIn.value.trim();
    if (!packName) { composeMsg.textContent = S.composeNeedName; return; }

    composeBtn.disabled = true;
    installBtn.style.display = 'none';
    lastMergedBytes = null;
    composeMsg.textContent = S.working;

    try {
      // Build union of all selected records' files; path collision for later record
      // gets prefixed with a sanitized folder derived from its record name.
      const merged = {}; // path → sha256
      const collisions = [];

      for (const rec of sel) {
        const prefix = sanitizeFolderName(rec.name || rec.id);
        for (const f of (rec.files || [])) {
          if (f.path in merged) {
            const newPath = prefix + '/' + f.path;
            collisions.push(f.path);
            merged[newPath] = f.sha256;
          } else {
            merged[f.path] = f.sha256;
          }
        }
      }

      // Fetch blobs and assemble zip data object
      const data = {};
      for (const [path, sha256] of Object.entries(merged)) {
        data[path] = await opfs.getBlob(sha256);
      }
      const zip = zipSync(data);
      lastMergedBytes = zip;

      // Download the merged zip immediately
      downloadZip(zip, packName);

      const msgs = [S.composeDone(sel.length)];
      for (const p of collisions) msgs.push(S.composeCollision(p));
      composeMsg.textContent = msgs.join('\n');

      // Show the "import" button so user can also add it to OPFS
      installBtn.style.display = '';
      installBtn.dataset.packName = packName;
    } catch (e) {
      composeMsg.textContent = S.errorPrefix + ((e && e.message) || e);
    } finally {
      composeBtn.disabled = false;
    }
  });

  installBtn.addEventListener('click', async () => {
    if (!lastMergedBytes) return;
    const packName = installBtn.dataset.packName || nameIn.value.trim() || 'merged';
    installBtn.disabled = true;
    composeMsg.textContent = S.working;
    try {
      const res = await installZip(lastMergedBytes, packName);
      composeMsg.textContent = S.importDone(res.name || packName, res.templates);
      renderInventory();
    } catch (e) {
      composeMsg.textContent = S.errorPrefix + ((e && e.message) || e);
    } finally {
      installBtn.disabled = false;
    }
  });

  // === Import section =======================================================
  rail.appendChild(el('h2', null, S.importTitle));

  const importMsg = el('div', 'msg');

  const drop = el('label', 'drop', S.importDrop);
  const dropIn = document.createElement('input');
  dropIn.type = 'file';
  dropIn.accept = '.zip';
  dropIn.style.display = 'none';
  drop.appendChild(dropIn);

  ['dragover', 'dragenter'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hot'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('hot'); }));

  rail.appendChild(drop);
  rail.appendChild(importMsg);

  const handleZip = async (file) => {
    if (!file) return;
    importMsg.textContent = S.working;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const name = file.name.replace(/\.zip$/i, '');
      const res = await installZip(bytes, name);
      importMsg.textContent = S.importDone(res.name || name, res.templates);
      renderInventory();
    } catch (e) {
      importMsg.textContent = S.errorPrefix + ((e && e.message) || e);
    }
  };

  dropIn.addEventListener('change', () => handleZip(dropIn.files[0]));
  drop.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files[0]) handleZip(e.dataTransfer.files[0]);
  });

  // === Modeler bridge (staged files) =======================================
  rail.appendChild(el('h2', null, S.stagedTitle));

  const stagedMsg = el('div', 'msg');
  const stagedBox = el('div');
  rail.appendChild(stagedBox);
  rail.appendChild(stagedMsg);

  const renderStaged = async () => {
    let staged = [];
    try { staged = await listStaged(); } catch (_) { /* OPFS unavailable — hide section */ }
    stagedBox.innerHTML = '';

    const hint = el('div', null, staged.length ? S.stagedHint : S.stagedEmpty);
    hint.style.cssText = 'color:#7d93b0;font-size:11px;margin-bottom:4px';
    stagedBox.appendChild(hint);

    for (const s of staged) {
      const rowEl = el('div');
      rowEl.style.cssText =
        'display:flex;align-items:center;gap:8px;padding:4px 8px;' +
        'border:1px solid #2a3647;border-radius:6px;margin-bottom:4px';

      const nm = el('span', null, s.name);
      nm.style.cssText =
        'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;' +
        'white-space:nowrap;color:#e6edf3;font-size:12.5px';

      const sz = el('span', null, (s.size / 1024).toFixed(1) + ' KB');
      sz.style.cssText = 'flex:none;color:#7d93b0;font-size:11px';

      const dl = el('button', null, S.stagedDl);
      dl.title = S.stagedDlTitle;
      dl.style.cssText += ';font-size:11.5px;padding:3px 8px;flex:none';
      dl.addEventListener('click', async () => {
        const bytes = await getStaged(s.name);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([bytes]));
        a.download = s.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      });

      const del = el('button', null, S.stagedDel);
      del.title = '';
      del.style.cssText += ';font-size:11.5px;padding:3px 8px;flex:none;color:#c75d6a';
      del.addEventListener('click', async () => {
        await removeStaged(s.name);
        renderStaged();
      });

      rowEl.appendChild(nm);
      rowEl.appendChild(sz);
      rowEl.appendChild(dl);
      rowEl.appendChild(del);
      stagedBox.appendChild(rowEl);
    }

    // send a local file into the shared staging area
    const sendLab = el('label', null, S.stagedSend);
    sendLab.title = S.stagedSendTitle;
    sendLab.style.cssText =
      'display:inline-block;margin-top:4px;padding:4px 10px;border:1px dashed #2a3647;' +
      'border-radius:6px;color:#7d93b0;font-size:11.5px;cursor:pointer';
    const sendIn = document.createElement('input');
    sendIn.type = 'file';
    sendIn.accept = '.srf,.dnm,.dat';
    sendIn.multiple = true;
    sendIn.style.display = 'none';
    sendIn.addEventListener('change', async () => {
      let n = 0;
      for (const f of Array.from(sendIn.files)) {
        if (!/\.(srf|dnm|dat)$/i.test(f.name)) continue;
        await putStaged(f.name, new Uint8Array(await f.arrayBuffer()));
        n++;
      }
      if (n) stagedMsg.textContent = S.stagedSent(n);
      renderStaged();
    });
    sendLab.appendChild(sendIn);
    stagedBox.appendChild(sendLab);
  };

  renderStaged();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') renderStaged();
  });
  window.addEventListener('focus', renderStaged);
}

// --- boot ------------------------------------------------------------------

async function main() {
  const { rail, main: mainEl } = studioChrome(S.title);
  // mainEl already has display:flex;flex-direction:column from CHROME_CSS .main rule
  buildInventory(mainEl);
  buildRail(rail);
  await renderInventory();
  window.ysfwStudio.ready = true;
}

main().catch((e) => console.error('[studio-pack]', e));
