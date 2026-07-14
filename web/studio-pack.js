// Pack Studio (studio-pack.html): the editor for a PACK-AS-A-WORK — a curated
// collection of your own creations (aircraft / maps), saved as a creation
// itself.  This is NOT an inventory manager: imported zips live in the game
// page's add-on panel, not here (toming's ruling, 2026-07-10).
//
// Member semantics (toming's ruling): a pack holds each member AS OF the
// moment it was added (snapshot — cheap, because blobs are content-addressed
// and dedupe), and the recipe remembers the source creation id so a member
// can be refreshed to its latest version with one button.  Nothing updates
// behind your back.
//
// Compose layout: every member's payload files are renamed to a per-member
// prefix (aircraft/<member>_f15.dnm …) and path references inside that
// member's .lst text are rewritten to match — so two works that both borrow
// f15.dnm (with different paint) never collide.

import { studioChrome, LANG, el, row, pageUrl, flyUrl, DEFAULT_FLY_AIRCRAFT, saveOrReplace, listCreations, loadCreation } from './studio-shared.js';
import { RECIPE_FILE, SCENERY_START } from './workbench.js';
import { sanitize, uniqueSan, namespaceSnapshot, composeEntries } from './studio-pack-core.js';
import * as opfs from './opfs-store.js';
import { zipSync } from './vendor/fflate.js';

const S = ({
  ja: {
    title: '📦 パックスタジオ',
    availTitle: '📚 マイ作品',
    availIntro: '機体スタジオ・マップスタジオで作った作品。「＋」でこのパックに収録します',
    availEmpty: '（収録できる作品がまだありません — ✈️/🏝 スタジオで作りましょう）',
    membersTitle: '📦 このパックの収録内容',
    membersEmpty: '（まだ空です — 左の作品を「＋」で収録）',
    add: '＋', addTitle: 'このパックに収録する',
    checkTitle: 'まとめて収録する対象に選ぶ',
    searchPh: '名前で検索…',
    filterAll: 'すべて', filterAir: '✈️ 機体', filterSce: '🏝 マップ',
    addSelected: (n) => '☑ 選択した ' + n + ' 件を収録',
    addedN: (n) => '✓ ' + n + ' 件を収録しました',
    preselectNote: '前回保存したパックの収録セットを自動選択しています（チェックを外して調整できます）',
    noMatch: '（検索・フィルタに一致する作品がありません）',
    remove: '−', removeTitle: '収録から外す',
    refresh: '↺', refreshTitle: '元の作品の最新版に更新する（収録は追加時点で固定です）',
    refreshed: (n) => '✓ ' + n + ' を最新版に更新しました',
    snapshotNote: '追加時点の内容で固定（↺で最新版に更新できます）',
    orphanNote: '元の作品は削除済み — このパック内のスナップショットだけが残っています',
    kindGlyph: { aircraft: '✈️', scenery: '🏝', mixed: '📦', other: '📦' },
    packTitle: '🧩 パック',
    packIntro: '作品をまとめた「パック」も1つの作品です。保存するとマイ作品に並び、✏️ で収録を編集し直せます。',
    packName: 'パック名',
    save: '作品として保存',
    saved: (n, k) => '✓ パック「' + n + '」（' + k + ' 作品収録）を保存しました',
    needMembers: '収録する作品を選んでください',
    needName: 'パック名を入れてください',
    exportTitle: '⬇ 配布用に書き出す',
    exportIntro: '保存済みのパックをzipファイルとして手元にダウンロードします（YSFLIGHT本体でも使える形式）',
    exportBtn: '⬇ zipをダウンロード',
    exportNeedSave: '（先に保存してください）',
    exported: (n) => '✓ ' + n + '.zip を書き出しました',
    editingBadge: (n) => '✏️ 編集中: ' + n,
    working: '作業中…',
    errorPrefix: 'エラー: ',
    fly: '🛫', flyTitle: 'テスト飛行（ゲームページに移動します）',
  },
  en: {
    title: '📦 Pack Studio',
    availTitle: '📚 My creations',
    availIntro: 'Works made in the aircraft/scenery studios. “＋” adds one to this pack',
    availEmpty: '(Nothing to include yet — make something in the ✈️/🏝 studios)',
    membersTitle: '📦 In this pack',
    membersEmpty: '(Empty — add works from the left with “＋”)',
    add: '＋', addTitle: 'Include in this pack',
    checkTitle: 'Select for bulk add',
    searchPh: 'Search by name…',
    filterAll: 'All', filterAir: '✈️ Aircraft', filterSce: '🏝 Maps',
    addSelected: (n) => '☑ Add ' + n + ' selected',
    addedN: (n) => '✓ Added ' + n + ' work(s)',
    preselectNote: 'Your last saved pack’s set is pre-selected (uncheck to adjust)',
    noMatch: '(No works match the search / filter)',
    remove: '−', removeTitle: 'Remove from the pack',
    refresh: '↺', refreshTitle: 'Refresh to the source work’s latest version (members are frozen at add time)',
    refreshed: (n) => '✓ Refreshed ' + n + ' to its latest version',
    snapshotNote: 'Frozen as of when it was added (↺ refreshes to latest)',
    orphanNote: 'The source work was deleted — only this pack’s snapshot remains',
    kindGlyph: { aircraft: '✈️', scenery: '🏝', mixed: '📦', other: '📦' },
    packTitle: '🧩 Pack',
    packIntro: 'A pack of works is a work itself: saving puts it on your shelf, and ✏️ re-opens it to re-curate.',
    packName: 'Pack name',
    save: 'Save as a work',
    saved: (n, k) => '✓ Saved pack “' + n + '” (' + k + ' work' + (k === 1 ? '' : 's') + ')',
    needMembers: 'Add at least one work',
    needName: 'Enter a pack name',
    exportTitle: '⬇ Export for sharing',
    exportIntro: 'Download the saved pack as a zip (also usable in desktop YSFLIGHT)',
    exportBtn: '⬇ Download zip',
    exportNeedSave: '(Save first)',
    exported: (n) => '✓ Exported ' + n + '.zip',
    editingBadge: (n) => '✏️ Editing: ' + n,
    working: 'Working…',
    errorPrefix: 'Error: ',
    fly: '🛫', flyTitle: 'Test-fly (moves to the game page)',
  },
})[LANG];

// --- member snapshots -------------------------------------------------------------

// A member = a snapshot of one creation's payload, namespaced per member so
// nothing collides (see namespaceSnapshot in studio-pack-core.js).
// files: [{path, bytes}] (final, namespaced paths).
async function snapshotFromRecord(rec, memberSan) {
  const raw = [];
  for (const f of rec.files || []) {
    if (f.path === RECIPE_FILE) continue; // the pack gets its OWN recipe
    raw.push({ path: f.path, bytes: await opfs.getBlob(f.sha256) });
  }
  return namespaceSnapshot(raw, memberSan);
}

// Rebuild a member snapshot out of an already-saved PACK record (for re-editing
// a pack whose source creation is gone): its files are the ones carrying this
// member's prefix.  Paths are already namespaced — take them verbatim.
async function snapshotFromPack(packRec, memberSan) {
  const out = [];
  const lstRe = new RegExp('^(air|sce|gro)_' + memberSan.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '_', 'i');
  for (const f of packRec.files || []) {
    if (f.path === RECIPE_FILE) continue;
    const base = f.path.slice(f.path.lastIndexOf('/') + 1);
    if (!base.startsWith(memberSan + '_') && !lstRe.test(base)) continue;
    out.push({ path: f.path, bytes: await opfs.getBlob(f.sha256) });
  }
  return out;
}

// --- page state -------------------------------------------------------------------

let members = [];   // [{sourceId, san, name, kind, files:[{path,bytes}], orphan}]
let editingId = null;
let savedName = null; // last saved pack name (enables export)
let savedZip = null;  // last composed zip bytes (export without recompose)

// The creation-picker (left column) state: the library list is loaded once at
// boot; search/kind filtering and the checked set are pure view state.
let creationsCache = [];    // aircraft/scenery creations only (packs don't nest)
const selected = new Set(); // creation ids checked for bulk add
let availFilter = { term: '', kind: 'all' };
let preselectApplied = false;

// "Last curated set": the sourceIds of the last SAVED pack, remembered so the
// next new pack starts pre-checked (no re-picking the same works every time).
// localStorage, guarded like every other ysfw* key (private mode).
const LAST_MEMBERS_KEY = 'ysfwPackLastMembers';
const readLastMembers = () => {
  try { const v = JSON.parse(localStorage.getItem(LAST_MEMBERS_KEY) || '[]'); return Array.isArray(v) ? v : []; }
  catch (e) { return []; }
};
const writeLastMembers = (ids) => { try { localStorage.setItem(LAST_MEMBERS_KEY, JSON.stringify(ids)); } catch (e) {} };

const memberSan = (name) => uniqueSan(name, members.map((m) => m.san));

// Snapshot one library creation and append it as a member (shared by the
// per-row ＋, the bulk add, and the composeAll smoke driver).
async function addMember(c) {
  const rec = await opfs.getRecord(c.id);
  const san = memberSan(c.name || c.id);
  members.push({
    sourceId: c.id, san, name: c.name || c.id, kind: c.kind,
    files: await snapshotFromRecord(rec, san), orphan: false,
  });
}

const composeZip = (packName) => zipSync(composeEntries(members, packName));

// --- page -------------------------------------------------------------------------

const { rail, main } = studioChrome(S.title);

// main: two columns — my creations (left) | this pack's members (right).
main.style.cssText += ';flex-direction:row;overflow:hidden';
const availCol = el('div');
availCol.style.cssText = 'flex:1;min-width:0;overflow-y:auto;padding:12px 14px;border-right:1px solid #2a3647';
const memberCol = el('div');
memberCol.style.cssText = 'flex:1;min-width:0;overflow-y:auto;padding:12px 14px';
main.appendChild(availCol);
main.appendChild(memberCol);

const msg = el('div', 'msg');

const itemRow = (glyph, name, note) => {
  const r = el('div');
  r.style.cssText =
    'display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid #2a3647;' +
    'border-radius:7px;margin-bottom:6px;background:#0b1017';
  r.appendChild(Object.assign(el('span'), { textContent: glyph, style: 'flex:none' }));
  const nm = el('span', null, name);
  nm.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e6edf3;font-size:13.5px';
  r.appendChild(nm);
  if (note) {
    const nt = el('span', null, note);
    nt.style.cssText = 'flex:none;color:#7d93b0;font-size:10.5px;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    r.appendChild(nt);
  }
  return r;
};
const smallBtn = (parent, label, title, accent) => {
  const b = el('button', accent ? 'accent' : null, label);
  b.title = title;
  b.style.cssText += ';font-size:12px;padding:4px 9px;flex:none';
  parent.appendChild(b);
  return b;
};

let renderAvail = () => {};
let renderMembers = () => {};
let availRows = null, bulkAddBtn = null;

function updateBulkAdd() {
  if (!bulkAddBtn) return;
  bulkAddBtn.textContent = S.addSelected(selected.size);
  bulkAddBtn.disabled = selected.size === 0;
  bulkAddBtn.classList.toggle('accent', selected.size > 0);
}

// Only the row list re-renders on search/filter input, so the search box never
// loses focus mid-typing.
function renderAvailRows() {
  if (!availRows) return;
  availRows.innerHTML = '';
  const term = availFilter.term.trim().toLowerCase();
  const list = creationsCache.filter((c) =>
    (availFilter.kind === 'all' || c.kind === availFilter.kind) &&
    (!term || String(c.name || c.id).toLowerCase().includes(term)));
  if (!list.length) {
    availRows.appendChild(el('div', 'msg', S.noMatch));
    updateBulkAdd();
    return;
  }
  for (const c of list) {
    const r = itemRow(S.kindGlyph[c.kind] || '📦', c.name || c.id, c.identities[0] || c.sceneryIdent || '');
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: selected.has(c.id) });
    cb.title = S.checkTitle;
    cb.style.cssText = 'flex:none;accent-color:#4da3ff;margin:0';
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(c.id); else selected.delete(c.id);
      updateBulkAdd();
    });
    r.insertBefore(cb, r.firstChild);
    if (c.identities.length > 0 || (c.kind === 'scenery' && c.sceneryIdent)) {
      const fly = smallBtn(r, S.fly, S.flyTitle, false);
      fly.addEventListener('click', () => {
        location.href = c.identities.length > 0
          ? flyUrl(c.identities[0])
          : flyUrl(DEFAULT_FLY_AIRCRAFT, c.sceneryIdent, SCENERY_START);
      });
    }
    const add = smallBtn(r, S.add, S.addTitle, true);
    add.dataset.add = '1';
    add.addEventListener('click', async () => {
      add.disabled = true;
      msg.textContent = S.working;
      try {
        await addMember(c);
        msg.textContent = '';
        renderMembers();
      } catch (e) {
        msg.textContent = S.errorPrefix + ((e && e.message) || e);
      } finally {
        add.disabled = false;
      }
    });
    availRows.appendChild(r);
  }
  updateBulkAdd();
}

renderAvail = () => {
  availCol.innerHTML = '';
  availRows = null;
  bulkAddBtn = null;
  availCol.appendChild(el('h2', null, S.availTitle));
  availCol.appendChild(el('p', 'intro', S.availIntro));
  if (!creationsCache.length) {
    availCol.appendChild(el('div', 'msg', S.availEmpty));
    return;
  }
  // Toolbar: name search + kind filter, then the bulk-add button for the
  // checked set (the fix for "re-pick everything on every pack").
  const bar = el('div');
  bar.style.cssText = 'display:flex;gap:6px;margin-bottom:8px';
  const search = Object.assign(document.createElement('input'), { type: 'search', placeholder: S.searchPh, value: availFilter.term });
  search.style.cssText = 'flex:1;min-width:0;padding:5px 9px;border:1px solid #2a3647;border-radius:6px;background:#0b1017;color:#e6edf3;font-size:12.5px';
  search.addEventListener('input', () => { availFilter.term = search.value; renderAvailRows(); });
  const kindSel = document.createElement('select');
  for (const [v, label] of [['all', S.filterAll], ['aircraft', S.filterAir], ['scenery', S.filterSce]]) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    kindSel.appendChild(o);
  }
  kindSel.value = availFilter.kind;
  kindSel.style.cssText = 'flex:none;padding:5px 6px;border:1px solid #2a3647;border-radius:6px;background:#0b1017;color:#e6edf3;font-size:12.5px';
  kindSel.addEventListener('change', () => { availFilter.kind = kindSel.value; renderAvailRows(); });
  bar.appendChild(search);
  bar.appendChild(kindSel);
  availCol.appendChild(bar);

  bulkAddBtn = el('button', null, S.addSelected(0));
  bulkAddBtn.style.cssText += ';font-size:12px;margin-bottom:8px';
  bulkAddBtn.addEventListener('click', async () => {
    // Skip works already in the pack, so a stale pre-selection can't duplicate.
    const targets = creationsCache.filter((c) => selected.has(c.id) && !members.some((m) => m.sourceId === c.id));
    bulkAddBtn.disabled = true;
    msg.textContent = S.working;
    try {
      for (const c of targets) await addMember(c);
      selected.clear();
      msg.textContent = S.addedN(targets.length);
      renderAvailRows();
      renderMembers();
    } catch (e) {
      msg.textContent = S.errorPrefix + ((e && e.message) || e);
    } finally {
      bulkAddBtn.disabled = false;
      updateBulkAdd();
    }
  });
  availCol.appendChild(bulkAddBtn);
  if (preselectApplied) availCol.appendChild(el('p', 'intro', S.preselectNote));

  availRows = el('div');
  availCol.appendChild(availRows);
  renderAvailRows();
};

renderMembers = () => {
  memberCol.innerHTML = '';
  memberCol.appendChild(el('h2', null, S.membersTitle));
  memberCol.appendChild(el('p', 'intro', S.snapshotNote));
  if (!members.length) {
    memberCol.appendChild(el('div', 'msg', S.membersEmpty));
    return;
  }
  members.forEach((m, i) => {
    const r = itemRow(S.kindGlyph[m.kind] || '📦', m.name, m.orphan ? S.orphanNote : (m.files.length + 'f'));
    if (!m.orphan) {
      const rf = smallBtn(r, S.refresh, S.refreshTitle, false);
      rf.addEventListener('click', async () => {
        rf.disabled = true;
        msg.textContent = S.working;
        try {
          const rec = await opfs.getRecord(m.sourceId);
          if (!rec) { m.orphan = true; renderMembers(); return; }
          m.files = await snapshotFromRecord(rec, m.san);
          msg.textContent = S.refreshed(m.name);
          renderMembers();
        } catch (e) {
          msg.textContent = S.errorPrefix + ((e && e.message) || e);
        }
      });
    }
    const rm = smallBtn(r, S.remove, S.removeTitle, false);
    rm.style.color = '#c75d6a';
    rm.addEventListener('click', () => { members.splice(i, 1); renderMembers(); });
    memberCol.appendChild(r);
  });
};

// rail: pack identity + save + export.
function buildRail() {
  rail.appendChild(el('h2', null, S.packTitle));
  rail.appendChild(el('p', 'intro', S.packIntro));
  const editBadge = el('div', 'msg');
  rail.appendChild(editBadge);
  const nameIn = row(rail, S.packName, Object.assign(document.createElement('input'), { type: 'text' }));
  const btnRow = el('div', 'btnrow');
  const saveBtn = el('button', 'accent', S.save);
  btnRow.appendChild(saveBtn);
  rail.appendChild(btnRow);
  rail.appendChild(msg);

  rail.appendChild(el('h2', null, S.exportTitle));
  rail.appendChild(el('p', 'intro', S.exportIntro));
  const expBtn = el('button', null, S.exportBtn);
  const expWrap = el('div', 'btnrow');
  expWrap.style.justifyContent = 'flex-start';
  expWrap.appendChild(expBtn);
  rail.appendChild(expWrap);
  const expMsg = el('div', 'msg', S.exportNeedSave);
  rail.appendChild(expMsg);

  saveBtn.addEventListener('click', async () => {
    const name = nameIn.value.trim();
    if (!members.length) { msg.textContent = S.needMembers; return; }
    if (!name) { msg.textContent = S.needName; return; }
    saveBtn.disabled = true;
    msg.textContent = S.working;
    try {
      const zip = composeZip(name);
      const res = await saveOrReplace(zip, name, editingId);
      editingId = res.id;
      savedName = name;
      savedZip = zip;
      writeLastMembers(members.map((m) => m.sourceId).filter(Boolean));
      msg.textContent = S.saved(name, members.length);
      expMsg.textContent = '';
    } catch (e) {
      msg.textContent = S.errorPrefix + ((e && e.message) || e);
    } finally {
      saveBtn.disabled = false;
    }
  });

  expBtn.addEventListener('click', () => {
    if (!savedZip) { expMsg.textContent = S.exportNeedSave; return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([savedZip], { type: 'application/zip' }));
    a.download = sanitize(savedName) + '.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    expMsg.textContent = S.exported(sanitize(savedName));
  });

  return { nameIn, editBadge };
}

// --- boot -------------------------------------------------------------------------

async function main2() {
  const { nameIn, editBadge } = buildRail();

  // Load the library once: the avail column, the pre-selection, and the member
  // freshness checks all read this snapshot.
  creationsCache = (await listCreations()).filter((c) => c.kind === 'aircraft' || c.kind === 'scenery');

  // ?edit=<id>: re-open a saved pack.  Members are re-snapshotted from their
  // SOURCE creations when those still exist (recipe = curation, source = truth
  // at edit time is wrong — ruling says frozen — so prefer the pack's own
  // snapshot bytes; the source is only needed for ↺ refresh).
  const editId = new URLSearchParams(location.search).get('edit');
  if (editId) {
    try {
      const c = await loadCreation(editId);
      if (c && c.recipe && c.recipe.type === 'pack') {
        const packRec = await opfs.getRecord(editId);
        members = [];
        for (const m of c.recipe.members || []) {
          const files = await snapshotFromPack(packRec, m.san);
          const srcAlive = m.sourceId ? !!(await opfs.getRecord(m.sourceId)) : false;
          members.push({ sourceId: m.sourceId, san: m.san, name: m.name, kind: m.kind, files, orphan: !srcAlive });
        }
        editingId = editId;
        nameIn.value = c.recipe.packName || c.name || '';
        editBadge.textContent = S.editingBadge(c.name || editId);
      } else if (c && c.recipe) {
        location.replace(pageUrl(c.recipe.type === 'scenery' ? 'studio-scenery.html' : 'studio-aircraft.html', { edit: editId }));
        return;
      }
    } catch (e) {
      console.warn('[pack-studio] edit load failed', e);
    }
  }

  // New pack: pre-check the last saved pack's set so recurring curation
  // (same works, updated content) starts one click from done.
  if (!editId) {
    for (const id of readLastMembers()) if (creationsCache.some((c) => c.id === id)) selected.add(id);
    preselectApplied = selected.size > 0;
  }

  renderAvail();
  renderMembers();

  window.ysfwStudio = {
    ready: true,
    page: 'pack',
    counts: () => ({
      available: availCol.querySelectorAll('button[data-add]').length,
      members: members.length,
    }),
    // Smoke/console driver: curate every available creation into a pack and save.
    composeAll: async (name) => {
      members = [];
      creationsCache = (await listCreations()).filter((c) => c.kind === 'aircraft' || c.kind === 'scenery');
      for (const c of creationsCache) await addMember(c);
      renderMembers();
      const zip = composeZip(name);
      const res = await saveOrReplace(zip, name, editingId);
      editingId = res.id;
      savedName = name;
      savedZip = zip;
      return { ...res, members: members.length };
    },
  };
}
main2();
