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

import { studioChrome, LANG, el, row, pageUrl, flyUrl, DEFAULT_FLY_AIRCRAFT, saveOrReplace, listCreations, loadCreation, webSha256 } from './studio-shared.js';
import { RECIPE_FILE, SCENERY_START } from './workbench.js';
import {
  sanitize, uniqueSan, namespaceSnapshot, composeEntries, memberState, refreshPlan,
  parseRecipe, fmtBytes, memberBytes, summarize, memberFlight, ATTRIBUTION_POLICIES,
} from './studio-pack-core.js';
import * as opfs from './opfs-store.js';
import { prepareUpdate, commitUpdate } from './pack-update.js';
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
    staleBadge: '↺ 更新あり',
    staleTitle: 'ライブラリの現行版と内容が異なります（content-hash不一致）。↺で最新版に更新できます',
    refreshAllBtn: (n) => '↺ 全部最新化（' + n + ' 件）',
    refreshAllConfirm: (n, names) => n + ' 件を最新版に更新します（収録は更新時点で再固定されます）:\n・' + names.join('\n・'),
    refreshAllDone: (n) => '✓ ' + n + ' 件を最新版に更新しました',
    snapshotNote: '追加時点の内容で固定（↺で最新版に更新できます）',
    summaryLine: (k, f, b) => '合計: ' + k + ' 作品 · ' + f + ' ファイル · ' + b,
    detailTitle: '収録内容の詳細を開閉',
    addedAtLabel: '収録日時', addedAtUnknown: '（記録なし — 旧形式のレシピ）',
    filesLabel: '含有ファイル',
    orphanNote: '元の作品は削除済み — このパック内のスナップショットだけが残っています',
    kindGlyph: { aircraft: '✈️', scenery: '🏝', mixed: '📦', other: '📦' },
    packTitle: '🧩 パック',
    packIntro: '作品をまとめた「パック」も1つの作品です。保存するとマイ作品に並び、✏️ で収録を編集し直せます。',
    packName: 'パック名',
    save: '作品として保存',
    saved: (n, k) => '✓ パック「' + n + '」（' + k + ' 作品収録）を保存しました',
    needMembers: '収録する作品を選んでください',
    needName: 'パック名を入れてください',
    attrTitle: '🏷 作者・再配布条件',
    attrIntro: 'パックに「出自の記録」として同梱します（レシピとzip内README.txtに転記。配布機能ではなく、強制・検証もしません）。未入力なら何も記録しません。',
    attrAuthor: '作者名',
    attrPolicy: '再配布',
    attrTerms: '条件メモ',
    attrTermsPh: '（任意）条件の自由記述',
    attrUrl: '出典/連絡先URL',
    attrPolicyLabels: {
      'unspecified': '明示なし',
      'redist-mod-ok': '再配布可・改変可',
      'redist-nomod': '再配布可・改変不可',
      'no-redist': '再配布不可',
      'ask-author': '要許可（作者に連絡）',
    },
    creditLabel: '原作者クレジット',
    creditPh: '（任意）この作品の原作者・出典のメモ',
    exportTitle: '⬇ 配布用に書き出す',
    exportIntro: '保存済みのパックをzipファイルとして手元にダウンロードします（YSFLIGHT本体でも使える形式）',
    exportBtn: '⬇ zipをダウンロード',
    exportNeedSave: '（先に保存してください）',
    exported: (n) => '✓ ' + n + '.zip を書き出しました',
    updTitle: '⤴️ ZIPから更新',
    updIntro: '編集中のパックの中身を、選んだ zip の内容で差し替えます（パック名・有効/無効・作者情報は引き継ぎ）。書き出した zip を外部で手直しした版の取り込みに。',
    updBtn: '⤴️ zipを選んで更新',
    updNeedEdit: '（✏️ で保存済みのパックを開いているときに使えます）',
    updConfirm: (n, d, hasRecipe) => '「' + n + '」を選択した zip の内容で更新します。\n' +
      '追加 ' + d.added.length + ' ／ 削除 ' + d.removed.length + ' ／ 変更 ' + d.changed.length + ' ／ 変更なし ' + d.unchanged + '\n' +
      '（有効/無効の状態と作者情報は引き継がれます）' +
      (hasRecipe ? '' : '\n⚠ この zip にはレシピ（workbench.json）が無いため、更新後はマイ作品の棚から外れ、ゲームページの「追加パック」欄での管理になります'),
    updSame: '選択した zip は今の内容と同一です（更新は不要でした）',
    updDoneNoRecipe: '✓ 更新しました。zip にレシピが無いため、以降はゲームページの「追加パック」欄で管理されます',
    editingBadge: (n) => '✏️ 編集中: ' + n,
    working: '作業中…',
    errorPrefix: 'エラー: ',
    fly: '🛫', flyTitle: 'テスト飛行（ゲームページに移動します）',
    flyMemberAirTitle: (idn) => 'この機体でテスト飛行: ' + idn + '（ゲームページに移動。インストール済みの内容で飛びます）',
    flyMemberSceTitle: (idn) => 'このマップで飛ぶ: ' + idn + '（ゲームページに移動）',
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
    staleBadge: '↺ update',
    staleTitle: 'Differs from the library’s current version (content-hash mismatch). ↺ refreshes it',
    refreshAllBtn: (n) => '↺ Refresh all (' + n + ')',
    refreshAllConfirm: (n, names) => 'Refresh ' + n + ' member(s) to their latest versions (re-frozen as of now):\n· ' + names.join('\n· '),
    refreshAllDone: (n) => '✓ Refreshed ' + n + ' member(s)',
    snapshotNote: 'Frozen as of when it was added (↺ refreshes to latest)',
    summaryLine: (k, f, b) => 'Total: ' + k + ' work(s) · ' + f + ' file(s) · ' + b,
    detailTitle: 'Toggle member details',
    addedAtLabel: 'Added', addedAtUnknown: '(not recorded — old recipe)',
    filesLabel: 'Files',
    orphanNote: 'The source work was deleted — only this pack’s snapshot remains',
    kindGlyph: { aircraft: '✈️', scenery: '🏝', mixed: '📦', other: '📦' },
    packTitle: '🧩 Pack',
    packIntro: 'A pack of works is a work itself: saving puts it on your shelf, and ✏️ re-opens it to re-curate.',
    packName: 'Pack name',
    save: 'Save as a work',
    saved: (n, k) => '✓ Saved pack “' + n + '” (' + k + ' work' + (k === 1 ? '' : 's') + ')',
    needMembers: 'Add at least one work',
    needName: 'Enter a pack name',
    attrTitle: '🏷 Author & redistribution terms',
    attrIntro: 'Recorded INSIDE the pack as provenance (transcribed into the recipe and a README.txt in the zip). Not a distribution feature; nothing is enforced or verified. Leave empty to record nothing.',
    attrAuthor: 'Author',
    attrPolicy: 'Redistribution',
    attrTerms: 'Terms note',
    attrTermsPh: '(optional) free-form terms',
    attrUrl: 'Source / contact URL',
    attrPolicyLabels: {
      'unspecified': 'Unspecified',
      'redist-mod-ok': 'Redistribution OK / mods OK',
      'redist-nomod': 'Redistribution OK / no mods',
      'no-redist': 'No redistribution',
      'ask-author': 'Ask the author',
    },
    creditLabel: 'Credit (original author)',
    creditPh: '(optional) note the original author / source of this work',
    exportTitle: '⬇ Export for sharing',
    exportIntro: 'Download the saved pack as a zip (also usable in desktop YSFLIGHT)',
    exportBtn: '⬇ Download zip',
    exportNeedSave: '(Save first)',
    exported: (n) => '✓ Exported ' + n + '.zip',
    updTitle: '⤴️ Update from ZIP',
    updIntro: 'Replace the edited pack\'s contents with a chosen zip (name, on/off state, and author info carry over). For re-importing an exported zip you touched up outside.',
    updBtn: '⤴️ Choose a zip & update',
    updNeedEdit: '(Available while editing a saved pack via ✏️)',
    updConfirm: (n, d, hasRecipe) => 'Update “' + n + '” with the selected zip?\n' +
      'Added ' + d.added.length + ' / removed ' + d.removed.length + ' / changed ' + d.changed.length + ' / unchanged ' + d.unchanged + '\n' +
      '(The on/off state and author info carry over.)' +
      (hasRecipe ? '' : '\n⚠ This zip has no recipe (workbench.json): after the update the pack leaves this shelf and is managed in the game page\'s add-on panel'),
    updSame: 'The selected zip is identical to the current contents (nothing to update)',
    updDoneNoRecipe: '✓ Updated. The zip carries no recipe, so the pack is now managed in the game page\'s add-on panel',
    editingBadge: (n) => '✏️ Editing: ' + n,
    working: 'Working…',
    errorPrefix: 'Error: ',
    fly: '🛫', flyTitle: 'Test-fly (moves to the game page)',
    flyMemberAirTitle: (idn) => 'Test-fly this aircraft: ' + idn + ' (moves to the game page; flies the installed content)',
    flyMemberSceTitle: (idn) => 'Fly on this map: ' + idn + ' (moves to the game page)',
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

let members = [];   // [{sourceId, san, name, kind, files:[{path,bytes}]}]
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

// Attribution inputs (buildRail).  Read at compose time; normalizeAttribution
// (in composeEntries) drops an all-empty set, so nothing is ever auto-recorded.
let attrUI = null; // {author, policy, terms, url} input elements
const attrValues = () => attrUI && {
  author: attrUI.author.value, policy: attrUI.policy.value,
  terms: attrUI.terms.value, url: attrUI.url.value,
};

// Author-name default: remembered once entered (localStorage, guarded).
const AUTHOR_KEY = 'ysfwPackAuthor';
const readAuthorDefault = () => { try { return localStorage.getItem(AUTHOR_KEY) || ''; } catch (e) { return ''; } };
const writeAuthorDefault = (v) => { try { if (v) localStorage.setItem(AUTHOR_KEY, v); } catch (e) {} };

// Snapshot one library creation and append it as a member (shared by the
// per-row ＋, the bulk add, and the composeAll smoke driver).
async function addMember(c) {
  const rec = await opfs.getRecord(c.id);
  const san = memberSan(c.name || c.id);
  members.push({
    sourceId: c.id, san, name: c.name || c.id, kind: c.kind,
    files: await snapshotFromRecord(rec, san), addedAt: Date.now(),
  });
}

const composeZip = (packName) => zipSync(composeEntries(members, packName, attrValues()));

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

// Re-snapshot one member from the library record `currentId` (its source, or
// its edited successor when the source id was replaced) and re-bind sourceId
// so the saved recipe points at what the member now holds.
async function refreshMember(m, currentId) {
  const rec = await opfs.getRecord(currentId);
  if (!rec) return false;
  m.files = await snapshotFromRecord(rec, m.san);
  m.sourceId = currentId;
  m.addedAt = Date.now(); // re-frozen as of now
  return true;
}

renderMembers = () => {
  memberCol.innerHTML = '';
  memberCol.appendChild(el('h2', null, S.membersTitle));
  memberCol.appendChild(el('p', 'intro', S.snapshotNote));
  if (!members.length) {
    memberCol.appendChild(el('div', 'msg', S.membersEmpty));
    return;
  }
  // Whole-pack summary: works / files / total size.
  const sum = summarize(members);
  const sumEl = el('div', null, S.summaryLine(sum.works, sum.files, fmtBytes(sum.bytes)));
  sumEl.style.cssText = 'color:#cfe0f5;font-size:12px;margin-bottom:8px';
  memberCol.appendChild(sumEl);
  // Bulk ↺: shown only when the hash diff found outdated members; the confirm
  // lists exactly what would be re-frozen before anything happens.
  const plan = refreshPlan(members, creationsCache);
  if (plan.stale.length > 0) {
    const rb = el('button', 'accent', S.refreshAllBtn(plan.stale.length));
    rb.style.cssText += ';font-size:12px;margin-bottom:8px';
    rb.addEventListener('click', async () => {
      if (!self.confirm(S.refreshAllConfirm(plan.stale.length, plan.stale.map((s) => s.name)))) return;
      rb.disabled = true;
      msg.textContent = S.working;
      try {
        let done = 0;
        for (const s of plan.stale) if (await refreshMember(members[s.index], s.currentId)) done++;
        msg.textContent = S.refreshAllDone(done);
        renderMembers();
      } catch (e) {
        msg.textContent = S.errorPrefix + ((e && e.message) || e);
        renderMembers();
      }
    });
    memberCol.appendChild(rb);
  }
  members.forEach((m, i) => {
    const st = memberState(m, creationsCache);
    const note = st.state === 'orphan' ? S.orphanNote : (m.files.length + 'f · ' + fmtBytes(memberBytes(m)));
    const r = itemRow(S.kindGlyph[m.kind] || '📦', m.name, note);
    if (st.state === 'stale') {
      const badge = el('span', null, S.staleBadge);
      badge.title = S.staleTitle;
      badge.style.cssText = 'flex:none;color:#e3b341;font-size:10.5px;border:1px solid #5c4a1a;border-radius:5px;padding:1px 6px';
      r.appendChild(badge);
    }
    const dt = smallBtn(r, m.open ? '▾' : '▸', S.detailTitle, false);
    dt.addEventListener('click', () => { m.open = !m.open; renderMembers(); });
    // Test-fly straight from the pack: the identity comes from the member's own
    // snapshot bytes, and the flight uses whatever is installed under that
    // identity (the source creation and/or the saved pack — see memberFlight).
    const flight = memberFlight(m);
    if (m.kind === 'aircraft' && flight.identities.length > 0) {
      const fb = smallBtn(r, S.fly, S.flyMemberAirTitle(flight.identities[0]), false);
      fb.addEventListener('click', () => { location.href = flyUrl(flight.identities[0]); });
    } else if (m.kind === 'scenery' && flight.sceneryIdent) {
      const fb = smallBtn(r, S.fly, S.flyMemberSceTitle(flight.sceneryIdent), false);
      fb.addEventListener('click', () => { location.href = flyUrl(DEFAULT_FLY_AIRCRAFT, flight.sceneryIdent, SCENERY_START); });
    }
    if (st.state !== 'orphan') {
      const rf = smallBtn(r, S.refresh, S.refreshTitle, false);
      rf.addEventListener('click', async () => {
        rf.disabled = true;
        msg.textContent = S.working;
        try {
          if (await refreshMember(m, st.currentId)) msg.textContent = S.refreshed(m.name);
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
    if (m.open) memberCol.appendChild(memberDetail(m));
  });
};

// The expanded member view: kind, freeze time, and the exact snapshot contents
// (path · size · short content hash).  Hashes are computed lazily on first
// expand and cached on the file objects (a refresh replaces the array, so
// stale hashes can't survive).
function memberDetail(m) {
  const d = el('div');
  d.style.cssText = 'margin:-2px 0 8px;padding:8px 10px;border:1px dashed #2a3647;border-radius:7px;font-size:11.5px;color:#8fa3bb';
  d.appendChild(el('div', null,
    (S.kindGlyph[m.kind] || '📦') + ' ' + m.kind + ' · ' + S.addedAtLabel + ': ' +
    (m.addedAt ? new Date(m.addedAt).toLocaleString() : S.addedAtUnknown)));
  const fl = el('div', null, S.filesLabel + ':');
  fl.style.marginTop = '4px';
  d.appendChild(fl);
  for (const f of m.files) {
    const line = el('div', null, f.path + ' · ' + fmtBytes(f.bytes.length) + ' · ');
    line.style.cssText = 'font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10.5px;color:#7d93b0;' +
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    const hs = el('span', null, '…');
    line.appendChild(hs);
    if (f.sha) hs.textContent = f.sha.slice(0, 10);
    else webSha256(f.bytes).then((h) => { f.sha = h; hs.textContent = h.slice(0, 10); }).catch(() => { hs.textContent = '?'; });
    d.appendChild(line);
  }
  // Per-member original-author credit (attribution) — rides in the recipe.
  const credRow = el('div');
  credRow.style.cssText = 'display:flex;gap:6px;align-items:center;margin-top:6px';
  credRow.appendChild(Object.assign(el('span', null, S.creditLabel), { style: 'flex:none;color:#8fa3bb' }));
  const credIn = Object.assign(document.createElement('input'), { type: 'text', value: m.credit || '', placeholder: S.creditPh });
  credIn.style.cssText = 'flex:1;min-width:0;padding:4px 8px;border:1px solid #2a3647;border-radius:6px;background:#0b1017;color:#e6edf3;font-size:11.5px';
  credIn.addEventListener('input', () => { m.credit = credIn.value; });
  credRow.appendChild(credIn);
  d.appendChild(credRow);
  return d;
}

// rail: pack identity + save + export.
function buildRail() {
  rail.appendChild(el('h2', null, S.packTitle));
  rail.appendChild(el('p', 'intro', S.packIntro));
  const editBadge = el('div', 'msg');
  rail.appendChild(editBadge);
  const nameIn = row(rail, S.packName, Object.assign(document.createElement('input'), { type: 'text' }));

  // Attribution / license — a carried record, never enforced (see core).
  rail.appendChild(el('h2', null, S.attrTitle));
  rail.appendChild(el('p', 'intro', S.attrIntro));
  const authorIn = row(rail, S.attrAuthor, Object.assign(document.createElement('input'), { type: 'text', value: readAuthorDefault() }));
  const policySel = document.createElement('select');
  for (const p of ATTRIBUTION_POLICIES) {
    const o = document.createElement('option');
    o.value = p;
    o.textContent = S.attrPolicyLabels[p] || p;
    policySel.appendChild(o);
  }
  policySel.value = 'unspecified'; // the default is ALWAYS "unspecified" — never auto-assigned
  row(rail, S.attrPolicy, policySel);
  const termsIn = Object.assign(document.createElement('textarea'), { rows: 2, placeholder: S.attrTermsPh });
  termsIn.style.cssText = 'flex:1;min-width:0;padding:6px 9px;border:1px solid #2a3647;border-radius:6px;background:#0b1017;color:#e6edf3;font-size:12.5px;resize:vertical';
  row(rail, S.attrTerms, termsIn);
  const urlIn = row(rail, S.attrUrl, Object.assign(document.createElement('input'), { type: 'url' }));
  attrUI = { author: authorIn, policy: policySel, terms: termsIn, url: urlIn };

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
      writeAuthorDefault(attrUI.author.value.trim());
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

  // ⤴️ Update from ZIP: the inverse of export — replace THIS pack's record
  // with a zip's contents while keeping its identity/state (pack-update.js).
  // The successor keeps being a creation only if the zip carries a recipe
  // (an exported pack zip does); otherwise it moves to the game page's
  // add-on panel, which the confirm dialog warns about.
  rail.appendChild(el('h2', null, S.updTitle));
  rail.appendChild(el('p', 'intro', S.updIntro));
  const updBtn = el('button', null, S.updBtn);
  const updWrap = el('div', 'btnrow');
  updWrap.style.justifyContent = 'flex-start';
  updWrap.appendChild(updBtn);
  rail.appendChild(updWrap);
  const updMsg = el('div', 'msg');
  rail.appendChild(updMsg);
  updBtn.addEventListener('click', () => {
    if (!editingId) { updMsg.textContent = S.updNeedEdit; return; }
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.zip';
    inp.addEventListener('change', async () => {
      const file = inp.files && inp.files[0];
      if (!file) return;
      updBtn.disabled = true;
      updMsg.textContent = S.working;
      try {
        const oldRec = await opfs.getRecord(editingId);
        if (!oldRec) throw new Error('pack record not found: ' + editingId);
        const bytes = new Uint8Array(await file.arrayBuffer());
        let prep;
        try {
          prep = await prepareUpdate(oldRec, bytes, { sha256: webSha256, store: opfs });
        } catch (e) {
          try { await opfs.gc(); } catch (_) {}
          throw e;
        }
        if (prep.sameId) { updMsg.textContent = S.updSame; return; }
        if (!self.confirm(S.updConfirm(oldRec.name || editingId, prep.diff, prep.newHasRecipe))) {
          try { await opfs.gc(); } catch (_) {}
          updMsg.textContent = '';
          return;
        }
        const rec = await commitUpdate(oldRec, prep.analysis, { store: opfs });
        if (prep.newRecipeType) {
          // Reload the right editor on the successor (a non-pack recipe
          // reroutes via the normal ?edit dispatch).
          location.replace(pageUrl('studio-pack.html', { edit: rec.id }));
        } else {
          editingId = null;
          savedZip = null;
          savedName = null;
          updMsg.textContent = S.updDoneNoRecipe;
        }
      } catch (e) {
        updMsg.textContent = S.errorPrefix + ((e && e.message) || e);
      } finally {
        updBtn.disabled = false;
      }
    });
    inp.click();
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
        const parsed = parseRecipe(c.recipe); // tolerates old-studio recipes
        members = [];
        for (const m of parsed.members) {
          const files = await snapshotFromPack(packRec, m.san);
          // fresh/stale/orphan is derived at render time (memberState vs. the
          // library snapshot), so nothing else is loaded here.
          members.push({ sourceId: m.sourceId, san: m.san, name: m.name, kind: m.kind, files, addedAt: m.addedAt, credit: m.credit });
        }
        editingId = editId;
        nameIn.value = parsed.packName || c.name || '';
        // Attribution: restore what the pack recorded.  A pack saved WITHOUT
        // attribution stays blank (incl. the author default) — re-saving it
        // must not silently start recording.
        if (parsed.attribution) {
          attrUI.author.value = parsed.attribution.author;
          attrUI.policy.value = parsed.attribution.policy;
          attrUI.terms.value = parsed.attribution.terms;
          attrUI.url.value = parsed.attribution.url;
        } else {
          attrUI.author.value = '';
        }
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
    // Smoke/console driver: update the pack being edited from zip bytes (the
    // UI flow minus the picker/confirm/navigation).
    updateFromZip: async (bytes) => {
      if (!editingId) throw new Error('no pack being edited');
      const oldRec = await opfs.getRecord(editingId);
      const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const prep = await prepareUpdate(oldRec, buf, { sha256: webSha256, store: opfs });
      if (prep.sameId) return { id: editingId, updated: false, same: true };
      const rec = await commitUpdate(oldRec, prep.analysis, { store: opfs });
      const oldId = editingId;
      editingId = rec.id;
      return { id: rec.id, oldId, updated: true, diff: prep.diff, hasRecipe: prep.newHasRecipe };
    },
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
