// Aircraft Studio (studio-aircraft.html): the full-screen aircraft page.
//
// Same engine-less contract as the workbench hub: everything made here is
// installed as an OPFS pack record ONLY, and the game page materializes every
// enabled record at boot.  The point of this page over the old single-page
// card is the layout: `main` is a permanent large 3D preview of the assigned
// visual .dnm (with movable-part sliders below), and the rail carries the
// assembly controls.  Paint reflects live via setPaint; only a FILE change
// (different bytes object in the visual slot) remounts the preview.

import {
  studioChrome, LANG, el, row, flyUrl, pageUrl,
  saveOrReplace, loadCreation, packPayload, knownIdentities, stockIndex,
} from './studio-shared.js';
import {
  classifyLoose, assembleAircraftZip, makeDatFromBase,
  extractDnmColors, repaintDnm,
} from './workbench.js';
import { mountPreview } from './dnm-preview.js';
import { dnmToGlb, glbToDnm, dnmToCollisionSrf } from './dnm-gltf.js';

const S = ({
  ja: {
    title: '✈️ 機体スタジオ',
    errorPrefix: 'エラー: ',
    working: '作業中…',
    acTitle: '✈️ 組み立て',
    acIntro: 'Blenderで作った .glb（または .dnm / .srf）と、飛行特性 .dat を1機に組み立てます。.dat が無ければ下の「stockから作る」で。',
    acDrop: '機体のファイル (.dat / .dnm / .srf / .glb) をドロップ / クリックして選択',
    glbImported: (n, k, t) => '✓ ' + n + ' をDNMに変換して取り込みました（' + k + 'ノード・' + t + '三角形）',
    glbAutoColl: '＋ 当たり判定を外観から自動生成しました',
    glbAutoDat: (b) => '＋ 飛行特性 (.dat) を ' + b + ' ベースで自動生成しました（下のウィザードで調整可）',
    glbReady: '→ このまま「組み立てて保存」で機体になります',
    blTitle: '🟠 Blenderで作る',
    blIntro: 'Blenderが主役のモデリング経路。テンプレから始めて、書き出した .glb を上のドロップ欄に入れるだけ。',
    blTemplate: '📥 機体テンプレをダウンロード (.glb)',
    blTemplateTitle: '可動部（脚・フラップ・プロペラ・VTOLノズル等）が配線済みの箱組み機体。Blenderで箱を彫り替えれば飛ばせます',
    blExport: '⬇ 選択中の外観を .glb で書き出す',
    blExportTitle: '外観モデル (.dnm) をBlender用glTFに変換してダウンロード（階層・可動アニメ・YSFLIGHT情報つき）',
    blExportNone: '書き出すには外観モデル (.dnm) を選んでください',
    blExported: (n, a) => '✓ ' + n + ' を書き出しました（アニメ: ' + (a.length ? a.join('・') : 'なし') + '）',
    blHint: '⚠ Blenderからの書き出しは glTF 2.0 (.glb)、「含める → データ → カスタムプロパティ」にチェック（可動部情報の保持に必須）',
    borrowLabel: '🎨 stockの見た目を借りる',
    borrowBtn: '取り込む',
    borrowTitle: 'stock機体の外観・当たり判定・コックピットをこの組み立てに取り込む（.datは下のウィザードで）',
    borrowDone: (name, n) => '✓ ' + name + ' の見た目（' + n + 'ファイル）を取り込みました。あとは .dat＝下の「stockから作る」で完成',
    slotDat: '飛行特性 (.dat) ※必須',
    slotVisual: '外観モデル (.dnm) ※必須',
    slotColl: '当たり判定 (.srf) ※必須',
    slotCockpit: 'コックピット (.srf)',
    slotCoarse: '遠景モデル (.dnm)',
    packName: 'パック名',
    none: '（なし）',
    assemble: '組み立てて保存',
    acDone: (n) => '✓ 機体パック「' + n + '」を保存しました',
    warn: {
      'coarse-needs-cockpit': '⚠ 遠景モデルは外しました（コックピット指定がないと使えません）',
      'no-ascii-identify': '⚠ .dat に ASCII の IDENTIFY がありません（テスト飛行ボタンで名前指定できません）',
    },
    errMap: {
      NO_DAT: '飛行特性 (.dat) を割り当ててください（下の「stockから作る」でも作れます）',
      NO_VISUAL: '外観モデル (.dnm) を割り当ててください',
      NO_COLLISION: '当たり判定 (.srf) を割り当ててください',
    },
    ignored: (names) => '— 対象外: ' + names.join(', '),
    fly: (n) => '🛫 ' + n + ' で飛ぶ',
    datTitle: '✏️ 飛行特性 (.dat) を stock から作る',
    datIntro: '元になる機体を選んで、名前を付けて、性能を倍率でいじれます。できた .dat は上の機体組み立てに入ります。',
    datBase: '元になる機体',
    datName: '新しい機体名（英数字）',
    knobs: { engine: 'エンジン出力', weight: '機体の重さ', speed: '最高速度', agility: '操縦の鋭さ' },
    exStrength: '耐久力', exStealth: 'ステルス', exGun: '機銃の連射', exSmoke: 'スモーク色',
    exKeep: 'そのまま',
    exStrengthOpts: { 1: 'すぐ壊れる (1)', 8: 'ふつう (8)', 25: '頑丈 (25)', 99: 'ほぼ無敵 (99)' },
    exStealthOpts: { 0.1: 'ステルス (0.1)', 0.05: '超ステルス (0.05)' },
    exGunOpts: { 0.03: '速い', 0.075: 'ふつう', 0.15: 'ゆっくり' },
    exSmokeOn: 'スモークを付ける',
    paintSection: '🎨 塗装',
    paintTitle: 'この外観モデルの色を塗り替える（ナビライト等は自動保護）',
    paintHint: '色ごとに新しい色を選んで「塗り替える」。数字はその色が使われている面の数',
    paintApply: '塗り替える',
    paintDone: (n) => '✓ ' + n + ' 面を塗り替えました',
    paintNone: '（この見た目に塗れる色が見つかりません — .dnm を選んでください）',
    previewNone: '外観モデル (.dnm) を割り当てるとここに3Dプレビューが出ます（ドラッグで回転・ホイールで拡大縮小・塗装は即反映）',
    animGear: '脚', animFlap: 'フラップ', animVgw: '可変翼', animElevator: '昇降舵', animAileron: '補助翼', animRudder: '方向舵',
    animNone: '（この機体に動く部品はありません）',
    datUse: 'この .dat を使う',
    datGenerated: (n) => '（生成）' + n + '.dat',
    datSet: (n) => '✓ ' + n + ' を機体組み立ての .dat スロットに入れました',
    datNeedName: '新しい機体名を入れてください',
    datDup: '⚠ その名前は既存の機体と重複しています（別名を推奨）',
    libEditingBadge: (n) => '✏️ 編集中: ' + n,
  },
  en: {
    title: '✈️ Aircraft Studio',
    errorPrefix: 'Error: ',
    working: 'Working…',
    acTitle: '✈️ Assemble',
    acIntro: 'Combine your Blender-made .glb (or .dnm / .srf) with a flight-model .dat. No .dat? Make one below from a stock base.',
    acDrop: 'Drop aircraft files (.dat / .dnm / .srf / .glb) / click to choose',
    glbImported: (n, k, t) => '✓ Converted ' + n + ' to DNM (' + k + ' nodes, ' + t + ' triangles)',
    glbAutoColl: '+ Generated a collision shell from the visual',
    glbAutoDat: (b) => '+ Generated a flight model (.dat) from ' + b + ' (tune it in the wizard below)',
    glbReady: '→ “Assemble & save” makes it an aircraft as-is',
    blTitle: '🟠 Build in Blender',
    blIntro: 'The Blender-first modeling path: start from the template, drop the exported .glb into the file drop above.',
    blTemplate: '📥 Download the aircraft template (.glb)',
    blTemplateTitle: 'A boxy airframe with every movable part (gear, flaps, propeller, VTOL nozzles, ...) pre-wired — carve the boxes and it flies',
    blExport: '⬇ Export the selected visual as .glb',
    blExportTitle: 'Convert the visual model (.dnm) to Blender-ready glTF (hierarchy, movable-part animations, YSFLIGHT metadata)',
    blExportNone: 'Select a visual model (.dnm) to export',
    blExported: (n, a) => '✓ Exported ' + n + ' (animations: ' + (a.length ? a.join(', ') : 'none') + ')',
    blHint: '⚠ Export from Blender as glTF 2.0 (.glb) with Include > Data > Custom Properties checked (required to keep the movable-part wiring)',
    borrowLabel: '🎨 Borrow a stock airframe',
    borrowBtn: 'Import',
    borrowTitle: 'Pull a stock aircraft’s visual/collision/cockpit into this assembly (make the .dat below)',
    borrowDone: (name, n) => '✓ Imported ' + name + '’s airframe (' + n + ' files). Now make a .dat below to complete it',
    slotDat: 'Flight model (.dat) — required',
    slotVisual: 'Visual model (.dnm) — required',
    slotColl: 'Collision shell (.srf) — required',
    slotCockpit: 'Cockpit (.srf)',
    slotCoarse: 'Coarse/LOD model (.dnm)',
    packName: 'Pack name',
    none: '(none)',
    assemble: 'Assemble & save',
    acDone: (n) => '✓ Saved aircraft pack “' + n + '”',
    warn: {
      'coarse-needs-cockpit': '⚠ Coarse model dropped (needs a cockpit assigned)',
      'no-ascii-identify': '⚠ No ASCII IDENTIFY in the .dat — the test-fly button can’t name this aircraft',
    },
    errMap: {
      NO_DAT: 'Assign a flight model (.dat) — or make one below from a stock base',
      NO_VISUAL: 'Assign a visual model (.dnm)',
      NO_COLLISION: 'Assign a collision shell (.srf)',
    },
    ignored: (names) => '— not usable: ' + names.join(', '),
    fly: (n) => '🛫 Fly ' + n,
    datTitle: '✏️ Make a flight model (.dat) from stock',
    datIntro: 'Pick a base aircraft, name yours, scale its performance. The result feeds the assembly above.',
    datBase: 'Base aircraft',
    datName: 'New aircraft name (ASCII)',
    knobs: { engine: 'Engine power', weight: 'Weight', speed: 'Top speed', agility: 'Handling sharpness' },
    exStrength: 'Toughness', exStealth: 'Stealth', exGun: 'Gun fire rate', exSmoke: 'Smoke color',
    exKeep: 'Keep',
    exStrengthOpts: { 1: 'Fragile (1)', 8: 'Normal (8)', 25: 'Tough (25)', 99: 'Nearly unkillable (99)' },
    exStealthOpts: { 0.1: 'Stealth (0.1)', 0.05: 'Super stealth (0.05)' },
    exGunOpts: { 0.03: 'Fast', 0.075: 'Normal', 0.15: 'Slow' },
    exSmokeOn: 'Enable smoke',
    paintSection: '🎨 Paint',
    paintTitle: 'Recolor this visual model (nav lights are auto-protected)',
    paintHint: 'Pick a new color per swatch, then Apply. The number is how many faces use it',
    paintApply: 'Apply paint',
    paintDone: (n) => '✓ Repainted ' + n + ' faces',
    paintNone: '(No paintable colors found — select a .dnm visual)',
    previewNone: 'Assign a visual model (.dnm) and its 3D preview appears here (drag to rotate, wheel to zoom, paint reflects live)',
    animGear: 'Gear', animFlap: 'Flap', animVgw: 'Swing wing', animElevator: 'Elevator', animAileron: 'Aileron', animRudder: 'Rudder',
    animNone: '(This aircraft has no moving parts)',
    datUse: 'Use this .dat',
    datGenerated: (n) => '(generated) ' + n + '.dat',
    datSet: (n) => '✓ Placed ' + n + ' into the assembly’s .dat slot',
    datNeedName: 'Enter a new aircraft name',
    datDup: '⚠ That name clashes with an existing aircraft (pick another)',
    libEditingBadge: (n) => '✏️ Editing: ' + n,
  },
})[LANG];

// --- module state -----------------------------------------------------------------

let entries = [];        // [{name, bytes}] accumulated loose files
let generatedDat = null; // {name, bytes, identify} from the dat wizard
let datRecipe = null;    // {baseFile, identify, knobs} when the dat wizard made the .dat
let editingId = null;    // replace-on-save target when re-editing a creation
let sels = null;         // slot selects, rebuilt by rebuildSlots
let byName = new Map();  // basename -> entry, rebuilt by rebuildSlots

let preview = null;
let previewedBytes = null; // the visual bytes currently mounted — paint updates
                           // live via setPaint, so only a different FILE remounts

// DOM handles filled during boot.
let previewWrap, surfaceHint, animBar;
let editBadge, slotsBox, acMsg, btnRow;
let paintPanel, paintMsg;

// --- the big preview surface (main) ------------------------------------------------

function buildSurface(surface) {
  previewWrap = el('div');
  previewWrap.style.cssText = 'flex:1;min-height:0;position:relative';
  surfaceHint = el('div', null, S.previewNone);
  surfaceHint.style.cssText =
    'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
    'color:#7d93b0;font-size:13px;text-align:center;padding:24px';
  previewWrap.appendChild(surfaceHint);
  animBar = el('div');
  animBar.style.cssText = 'flex:none;padding:8px 12px;border-top:1px solid #2a3647';
  surface.appendChild(previewWrap);
  surface.appendChild(animBar);
}

const visualEntry = () => {
  if (!sels || !sels.visual.value) return null;
  const ent = byName.get(sels.visual.value);
  return ent && /\.dnm$/i.test(ent.name) ? ent : null;
};

function disposePreview() {
  if (preview) { preview.dispose(); preview = null; }
  previewedBytes = null;
}

function refreshPreview() {
  const ent = visualEntry();
  if (!ent) {
    disposePreview();
    animBar.innerHTML = '';
    surfaceHint.style.display = 'flex';
    return;
  }
  if (preview && previewedBytes === ent.bytes) return; // same file -> keep the live view
  disposePreview();
  animBar.innerHTML = '';
  try {
    preview = mountPreview(previewWrap, ent.bytes);
    previewedBytes = ent.bytes;
    surfaceHint.style.display = 'none';
  } catch (e) {
    surfaceHint.style.display = 'flex';
    acMsg.textContent = S.errorPrefix + ((e && e.message) || e);
    return;
  }
  // Animation sliders for whatever movable parts this model has.
  const labels = { gear: S.animGear, flap: S.animFlap, vgw: S.animVgw, elevator: S.animElevator, aileron: S.animAileron, rudder: S.animRudder };
  let any = false;
  for (const [g, groups] of Object.entries(preview.movable)) {
    if (!groups.length) continue;
    any = true;
    const r = el('div', 'row');
    r.style.margin = '2px 0';
    const lab = el('span', 'lab', labels[g] || g);
    const sl = Object.assign(document.createElement('input'), { type: 'range', min: '0', max: '1', step: '0.02', value: '0' });
    sl.style.cssText = 'flex:1;min-width:0';
    sl.addEventListener('input', () => { for (const grp of groups) preview.setMovable(grp, Number(sl.value)); });
    r.appendChild(lab);
    r.appendChild(sl);
    animBar.appendChild(r);
  }
  if (!any) animBar.appendChild(el('div', 'msg', S.animNone));
}

// --- assemble section ---------------------------------------------------------------

function rebuildSlots(preset) {
  slotsBox.innerHTML = '';
  btnRow.innerHTML = '';
  const { candidates, guess, ignored } = classifyLoose(entries);
  const pre = (slot) => (preset && preset.slots && preset.slots[slot]) || null;
  byName = new Map(entries.map((e) => [e.name.split(/[\\/]/).pop(), e]));
  const mkSel = (label, cands, preselect, required, extraOpt) => {
    const sel = document.createElement('select');
    if (!required) sel.appendChild(Object.assign(el('option'), { value: '', textContent: S.none }));
    for (const c of cands) sel.appendChild(Object.assign(el('option'), { value: c.name, textContent: c.name }));
    if (extraOpt) sel.appendChild(extraOpt);
    sel.value = preselect || (required ? (cands[0] && cands[0].name) || '' : '');
    return row(slotsBox, label, sel);
  };
  const genOpt = generatedDat
    ? Object.assign(el('option'), { value: '@generated', textContent: S.datGenerated(generatedDat.identify) })
    : null;
  sels = {
    dat: mkSel(S.slotDat, candidates.dat, pre('dat') || (generatedDat ? '@generated' : guess.dat), true, genOpt),
    visual: mkSel(S.slotVisual, candidates.dnm, pre('visual') || guess.visual, true),
    collision: mkSel(S.slotColl, candidates.srf, pre('collision') || guess.collision, true),
    cockpit: mkSel(S.slotCockpit, candidates.srf, pre('cockpit') || guess.cockpit, false),
    coarse: mkSel(S.slotCoarse, candidates.dnm, pre('coarse') || guess.coarse, false),
  };
  if (!preset && generatedDat) sels.dat.value = '@generated';
  sels.visual.addEventListener('change', () => { refreshPreview(); renderPaint(); });

  const nameIn = Object.assign(document.createElement('input'), {
    type: 'text',
    placeholder: (guess.dat || (generatedDat && generatedDat.identify) || '').replace(/\.dat$/i, ''),
  });
  if (preset && preset.packName) nameIn.value = preset.packName;
  row(slotsBox, S.packName, nameIn);
  if (ignored.length) acMsg.textContent = S.ignored(ignored);

  const goBtn = el('button', 'accent', S.assemble);
  goBtn.addEventListener('click', async () => {
    goBtn.disabled = true;
    acMsg.textContent = S.working;
    try {
      const pick = (sel) => (sel.value === '@generated' ? generatedDat : sel.value ? byName.get(sel.value) : null);
      const slots = {
        dat: pick(sels.dat), visual: pick(sels.visual), collision: pick(sels.collision),
        cockpit: pick(sels.cockpit), coarse: pick(sels.coarse),
      };
      const asm = assembleAircraftZip({
        name: nameIn.value.trim() || undefined,
        ...slots,
        recipe: {
          packName: nameIn.value.trim() || undefined,
          slots: Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, v ? v.name : null])),
          datRecipe: sels.dat.value === '@generated' ? datRecipe : null,
        },
      });
      const res = await saveOrReplace(asm.zipBytes, asm.packName, editingId);
      editingId = res.id; // further saves keep replacing this creation
      const lines = [S.acDone(asm.packName)];
      for (const w of asm.warnings) if (S.warn[w]) lines.push(S.warn[w]);
      acMsg.textContent = lines.join('\n');
      if (asm.identify) {
        const fly = el('button', 'accent', S.fly(asm.identify));
        fly.addEventListener('click', () => { location.href = flyUrl(asm.identify); });
        btnRow.innerHTML = '';
        btnRow.appendChild(goBtn);
        btnRow.appendChild(fly);
      }
    } catch (e) {
      const m = (e && e.message) || String(e);
      const friendly = /missing \.dat/.test(m) ? S.errMap.NO_DAT
        : /missing visual/.test(m) ? S.errMap.NO_VISUAL
        : /missing collision/.test(m) ? S.errMap.NO_COLLISION : m;
      acMsg.textContent = S.errorPrefix + friendly;
    } finally {
      goBtn.disabled = false;
    }
  });
  btnRow.appendChild(goBtn);

  refreshPreview();
  renderPaint();
}

function buildAssembleSection(rail) {
  rail.appendChild(el('h2', null, S.acTitle));
  rail.appendChild(el('p', 'intro', S.acIntro));
  editBadge = el('div', 'msg');
  rail.appendChild(editBadge);

  const drop = el('label', 'drop', S.acDrop);
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.dat,.dnm,.srf,.glb,.gltf';
  input.multiple = true;
  input.style.display = 'none';
  drop.appendChild(input);
  ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hot'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('hot'); }));
  rail.appendChild(drop);

  slotsBox = el('div');
  slotsBox.style.marginTop = '10px';
  rail.appendChild(slotsBox);
  acMsg = el('div', 'msg');
  btnRow = el('div', 'btnrow');
  rail.appendChild(acMsg);
  rail.appendChild(btnRow);

  const addFiles = async (fileList) => {
    let glbBase = null;
    for (const f of Array.from(fileList)) {
      // .glb (Blender export) is a first-class aircraft: the visual converts
      // to .dnm, and whatever else a complete aircraft needs is auto-filled —
      // a collision shell baked from the visible rest geometry, and (when no
      // .dat is around) a generated flight model.  One drop -> assemble -> fly.
      if (/\.(glb|gltf)$/i.test(f.name)) {
        try {
          const res = glbToDnm(new Uint8Array(await f.arrayBuffer()));
          const base = f.name.replace(/\.(glb|gltf)$/i, '');
          const name = base + '.dnm';
          entries = entries.filter((e) => e.name !== name);
          entries.push({ name, bytes: res.dnm });
          glbBase = base;
          const auto = [];
          if (!entries.some((e) => /\.srf$/i.test(e.name))) {
            const coll = dnmToCollisionSrf(res.dnm);
            entries.push({ name: base + '_coll.srf', bytes: coll });
            auto.push(S.glbAutoColl);
          }
          if (!generatedDat && !entries.some((e) => /\.dat$/i.test(e.name))) {
            const stock = await stockIndex();
            const datBase = stock.find((a) => a.identify === 'F-15C_EAGLE') || stock[0];
            if (datBase) {
              const r = await fetch('./stock/' + datBase.file);
              if (r.ok) {
                const identify = base.toUpperCase().replace(/[^A-Z0-9_-]+/g, '_').slice(0, 24) || 'MY_AIRCRAFT';
                const dat = makeDatFromBase(new Uint8Array(await r.arrayBuffer()), { identify, knobs: {} });
                generatedDat = { name: dat.identify.toLowerCase() + '.dat', bytes: dat.bytes, identify: dat.identify };
                datRecipe = { baseFile: datBase.file, identify, knobs: {} };
                auto.push(S.glbAutoDat(datBase.identify));
              }
            }
          }
          acMsg.textContent = S.glbImported(f.name, res.nodes, res.triangles) +
            (auto.length ? '\n' + auto.join('\n') + '\n' + S.glbReady : '');
        } catch (e) {
          acMsg.textContent = S.errorPrefix + ((e && e.message) || e);
        }
        continue;
      }
      if (!/\.(dat|dnm|srf)$/i.test(f.name)) continue;
      entries = entries.filter((e) => e.name !== f.name);
      entries.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    }
    rebuildSlots(glbBase ? { packName: glbBase } : undefined);
  };
  input.addEventListener('change', () => addFiles(input.files));
  drop.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });
}

// --- borrow-a-stock-airframe section ------------------------------------------------

function buildBorrowSection(rail) {
  rail.appendChild(el('h2', null, S.borrowLabel));
  const r = el('div', 'row');
  const borrowSel = document.createElement('select');
  const borrowBtn = el('button', 'accent', S.borrowBtn);
  borrowBtn.title = S.borrowTitle;
  r.appendChild(borrowSel);
  r.appendChild(borrowBtn);
  rail.appendChild(r);
  stockIndex().then((stock) => {
    for (const a of stock) {
      if (!a.visual) continue;
      borrowSel.appendChild(Object.assign(el('option'), { value: a.identify, textContent: a.identify }));
    }
  });
  borrowBtn.addEventListener('click', async () => {
    borrowBtn.disabled = true;
    acMsg.textContent = S.working;
    try {
      const stock = await stockIndex();
      const a = stock.find((s) => s.identify === borrowSel.value);
      if (!a) throw new Error('stock entry not found: ' + borrowSel.value);
      const slots = {};
      let n = 0;
      for (const slot of ['visual', 'collision', 'cockpit', 'coarse']) {
        if (!a[slot]) continue;
        const r2 = await fetch('./stock/' + a[slot]);
        if (!r2.ok) throw new Error('stock fetch: HTTP ' + r2.status + ' (' + a[slot] + ')');
        const nm = a[slot].split('/').pop();
        entries = entries.filter((e) => e.name !== nm);
        entries.push({ name: nm, bytes: new Uint8Array(await r2.arrayBuffer()) });
        slots[slot] = nm;
        n++;
      }
      rebuildSlots({ slots });
      acMsg.textContent = S.borrowDone(a.identify, n);
    } catch (e) {
      acMsg.textContent = S.errorPrefix + ((e && e.message) || e);
    } finally {
      borrowBtn.disabled = false;
    }
  });
}

// --- paint section (always visible; swatches follow the visual slot) -----------------

function renderPaint() {
  paintPanel.innerHTML = '';
  const ent = visualEntry();
  const colors = ent ? extractDnmColors(ent.bytes).slice(0, 24) : [];
  if (!colors.length) {
    paintPanel.appendChild(el('div', 'msg', S.paintNone));
    return;
  }
  paintPanel.appendChild(el('div', 'msg', S.paintHint));
  const rgb2hex6 = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  const pickers = [];
  const grid = el('div');
  grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin:4px 0';
  for (const c of colors) {
    const cell = el('div');
    cell.style.cssText = 'display:flex;align-items:center;gap:4px;border:1px solid #2a3647;border-radius:6px;padding:3px 6px';
    const sw = el('span');
    sw.style.cssText = 'width:16px;height:16px;border-radius:3px;display:inline-block;background:rgb(' + c.r + ',' + c.g + ',' + c.b + ')';
    const cnt = el('span', null, String(c.count));
    cnt.style.cssText = 'color:#7d93b0;font-size:10.5px';
    const inp = Object.assign(document.createElement('input'), { type: 'color', value: rgb2hex6(c.r, c.g, c.b) });
    inp.style.cssText = 'width:34px;height:24px;padding:0;border:0;background:none';
    cell.appendChild(sw);
    cell.appendChild(cnt);
    cell.appendChild(inp);
    grid.appendChild(cell);
    pickers.push({ key: c.key, orig: rgb2hex6(c.r, c.g, c.b), inp });
  }
  paintPanel.appendChild(grid);
  const applyBtn = el('button', 'accent', S.paintApply);
  applyBtn.addEventListener('click', () => {
    const mapping = {};
    for (const p of pickers) {
      if (p.inp.value.toLowerCase() === p.orig.toLowerCase()) continue;
      mapping[p.key] = [1, 3, 5].map((i) => parseInt(p.inp.value.slice(i, i + 2), 16));
    }
    const out = repaintDnm(ent.bytes, mapping);
    ent.bytes = out.bytes;      // same entry object -> the assembly picks up the paint
    previewedBytes = ent.bytes; // setPaint reflects live, so this is not a FILE change
    if (preview) preview.setPaint(mapping);
    paintMsg.textContent = S.paintDone(out.replaced);
    renderPaint(); // swatches now show the new colors
  });
  paintPanel.appendChild(applyBtn);
}

function buildPaintSection(rail) {
  rail.appendChild(el('h2', null, S.paintSection));
  rail.appendChild(el('p', 'intro', S.paintTitle));
  paintPanel = el('div');
  rail.appendChild(paintPanel);
  paintMsg = el('div', 'msg');
  rail.appendChild(paintMsg);
}

// --- dat wizard section ---------------------------------------------------------------

async function buildDatSection(rail) {
  rail.appendChild(el('h2', null, S.datTitle));
  rail.appendChild(el('p', 'intro', S.datIntro));
  const box = el('div');
  rail.appendChild(box);

  const stock = await stockIndex();
  const baseSel = document.createElement('select');
  for (const a of stock) baseSel.appendChild(Object.assign(el('option'), { value: a.file, textContent: a.identify }));
  row(box, S.datBase, baseSel);
  const nameIn = Object.assign(document.createElement('input'), { type: 'text' });
  row(box, S.datName, nameIn);

  const knobs = {};
  for (const k of ['engine', 'weight', 'speed', 'agility']) {
    const wrap = el('div');
    wrap.style.cssText = 'flex:1;display:flex;align-items:center;gap:8px;min-width:0';
    const slider = Object.assign(document.createElement('input'), { type: 'range', min: '0.5', max: '3', step: '0.1', value: '1' });
    slider.style.cssText = 'flex:1;min-width:0';
    const val = el('span', 'val', '×1.0');
    slider.addEventListener('input', () => { val.textContent = '×' + Number(slider.value).toFixed(1); });
    wrap.appendChild(slider);
    wrap.appendChild(val);
    row(box, S.knobs[k], wrap);
    knobs[k] = slider;
  }

  // Second-tier SET knobs (default = leave the base value alone).
  const exSel = (label, opts) => {
    const sel = document.createElement('select');
    sel.appendChild(Object.assign(el('option'), { value: '', textContent: S.exKeep }));
    for (const [v, label2] of Object.entries(opts)) {
      sel.appendChild(Object.assign(el('option'), { value: v, textContent: label2 }));
    }
    row(box, label, sel);
    return sel;
  };
  const stSel = exSel(S.exStrength, S.exStrengthOpts);
  const rcSel = exSel(S.exStealth, S.exStealthOpts);
  const gunSel = exSel(S.exGun, S.exGunOpts);
  const smokeWrap = el('div');
  smokeWrap.style.cssText = 'flex:1;display:flex;align-items:center;gap:8px;min-width:0';
  const smokeOn = Object.assign(document.createElement('input'), { type: 'checkbox' });
  const smokeLab = el('span', null, S.exSmokeOn);
  smokeLab.style.cssText = 'color:#8fa3bb;font-size:12px';
  const smokeCol = Object.assign(document.createElement('input'), { type: 'color', value: '#ff5050' });
  smokeCol.style.cssText = 'width:52px;height:28px;padding:1px;border:1px solid #2a3647;border-radius:6px;background:#0b1017';
  smokeWrap.appendChild(smokeOn);
  smokeWrap.appendChild(smokeLab);
  smokeWrap.appendChild(smokeCol);
  row(box, S.exSmoke, smokeWrap);
  const hex2rgb3 = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

  const msg = el('div', 'msg');
  box.appendChild(msg);
  const btnR = el('div', 'btnrow');
  const useBtn = el('button', 'accent', S.datUse);
  useBtn.addEventListener('click', async () => {
    const name = nameIn.value.trim();
    if (!name) { msg.textContent = S.datNeedName; return; }
    useBtn.disabled = true;
    try {
      const r = await fetch('./stock/' + baseSel.value);
      if (!r.ok) throw new Error('stock fetch: HTTP ' + r.status);
      const dat = makeDatFromBase(new Uint8Array(await r.arrayBuffer()), {
        identify: name,
        knobs: Object.fromEntries(Object.entries(knobs).map(([k, s]) => [k, Number(s.value)])),
        extras: {
          strength: stSel.value ? Number(stSel.value) : undefined,
          radarCross: rcSel.value ? Number(rcSel.value) : undefined,
          gunInterval: gunSel.value ? Number(gunSel.value) : undefined,
          smoke: smokeOn.checked ? hex2rgb3(smokeCol.value) : undefined,
        },
      });
      const lines = [S.datSet(dat.identify)];
      if ((await knownIdentities()).has(dat.identify)) lines.push(S.datDup);
      msg.textContent = lines.join('\n');
      const knobVals = Object.fromEntries(Object.entries(knobs).map(([k, s]) => [k, Number(s.value)]));
      generatedDat = { name: dat.identify.toLowerCase() + '.dat', bytes: dat.bytes, identify: dat.identify };
      datRecipe = { baseFile: baseSel.value, identify: name, knobs: knobVals };
      rebuildSlots(); // reselects '@generated' in the .dat slot
    } catch (e) {
      msg.textContent = S.errorPrefix + ((e && e.message) || e);
    } finally {
      useBtn.disabled = false;
    }
  });
  btnR.appendChild(useBtn);
  box.appendChild(btnR);
}

// --- Blender section --------------------------------------------------------------------
// The primary from-scratch modeling path: template out, .glb in (via the file
// drop, which converts to DNM), and export of any visual for editing.

function buildBlenderSection(rail) {
  rail.appendChild(el('h2', null, S.blTitle));
  rail.appendChild(el('p', 'intro', S.blIntro));
  const tpl = el('a', null, S.blTemplate);
  tpl.href = './aircraft-starter.glb';
  tpl.download = 'aircraft-starter.glb';
  tpl.title = S.blTemplateTitle;
  tpl.style.cssText = 'display:inline-block;margin:0 0 8px;padding:6px 12px;border:1px solid #4da3ff;' +
    'border-radius:6px;color:#4da3ff;font-size:12.5px;text-decoration:none;background:rgba(77,163,255,.14)';
  rail.appendChild(tpl);
  const expBtn = el('button', null, S.blExport);
  expBtn.title = S.blExportTitle;
  const btnR = el('div', 'btnrow');
  btnR.style.justifyContent = 'flex-start';
  btnR.appendChild(expBtn);
  rail.appendChild(btnR);
  const msg = el('div', 'msg', S.blHint);
  rail.appendChild(msg);
  expBtn.addEventListener('click', () => {
    const ent = visualEntry();
    if (!ent) { msg.textContent = S.blExportNone; return; }
    try {
      const res = dnmToGlb(ent.bytes);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([res.glb], { type: 'model/gltf-binary' }));
      a.download = ent.name.replace(/\.dnm$/i, '') + '.glb';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      msg.textContent = S.blExported(a.download, res.animations) + '\n' + S.blHint;
    } catch (e) {
      msg.textContent = S.errorPrefix + ((e && e.message) || e);
    }
  });
}


// --- boot ------------------------------------------------------------------------------

async function main() {
  const chrome = studioChrome(S.title);
  buildSurface(chrome.main);
  buildAssembleSection(chrome.rail);
  buildBorrowSection(chrome.rail);
  buildPaintSection(chrome.rail);
  await buildDatSection(chrome.rail);
  buildBlenderSection(chrome.rail);


  // ?edit=<id>: re-open a creation — loose files come back out of the pack
  // payload, the slot assignment and name from the embedded recipe.
  let preset = null;
  const editId = new URLSearchParams(location.search).get('edit');
  if (editId) {
    try {
      const c = await loadCreation(editId);
      if (c && c.recipe) {
        if (c.recipe.type === 'scenery' || c.recipe.type === 'pack') {
          location.replace(pageUrl(c.recipe.type === 'pack' ? 'studio-pack.html' : 'studio-scenery.html', { edit: editId }));
          return;
        }
        entries = await packPayload(editId, 'aircraft/');
        generatedDat = null;
        datRecipe = c.recipe.datRecipe || null;
        editingId = editId;
        editBadge.textContent = S.libEditingBadge(c.name || editId);
        preset = { slots: c.recipe.slots || {}, packName: c.recipe.packName || c.name };
      }
    } catch (e) {
      acMsg.textContent = S.errorPrefix + ((e && e.message) || e);
    }
  }
  rebuildSlots(preset);

  // Driven by the smoke test (and handy in the console).
  window.ysfwStudio = {
    ready: true,
    page: 'aircraft',
    getEntries: () => entries.map((e) => e.name),
    hasPreview: () => !!preview,
  };
}
main();
