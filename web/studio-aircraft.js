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
  extractDnmColors, repaintDnm, getDatCockpit, setDatCockpit,
  getDatExCameras, setDatExCameras,
} from './workbench.js';
import { mountPreview } from './dnm-preview.js';
import { dnmToGlb, glbToDnm, dnmToCollisionSrf, estimateCockpit } from './dnm-gltf.js';
import { mountPartPaint } from './studio-paint.js';
import { mountViewpointTools } from './viewpoint-tools.js';
import { mountDatEditor } from './studio-dat.js';
import { buildMovablesSection } from './studio-movables.js';
import { buildLintSection } from './dnm-lint-ui.js';

const S = ({
  ja: {
    title: '機体スタジオ',
    sub: 'Blender製 .glb や .dnm/.srf と飛行特性 .dat を1機に組み立て。3Dプレビューで塗装・可動部・視点も編集できます。',
    errorPrefix: 'エラー: ',
    working: '作業中…',
    acTitle: '組み立て',
    acIntro: 'Blenderで作った .glb（または .dnm / .srf）と、飛行特性 .dat を1機に組み立てます。.dat が無ければ下の「stockから作る」で。',
    acDrop: '機体のファイル (.dat / .dnm / .srf / .glb) をドロップ / クリックして選択',
    glbImported: (n, k, t) => '✓ ' + n + ' をDNMに変換して取り込みました（' + k + 'ノード・' + t + '三角形）',
    glbAutoColl: '＋ 当たり判定を外観から自動生成しました',
    glbAutoDat: (b) => '＋ 飛行特性 (.dat) を ' + b + ' ベースで自動生成しました（下のウィザードで調整可）',
    glbReady: '→ このまま「組み立てて保存」で機体になります',
    blTitle: 'Blenderで作る',
    blIntro: 'Blenderが主役のモデリング経路。テンプレから始めて、書き出した .glb を上のドロップ欄に入れるだけ。',
    blTemplate: '機体テンプレをダウンロード (.glb)',
    blTemplateTitle: '可動部（脚・フラップ・プロペラ・VTOLノズル等）が配線済みの箱組み機体。Blenderで箱を彫り替えれば飛ばせます',
    blSample: 'サンプル機 B747-8I をダウンロード (.glb)',
    blSampleTitle: 'Boeing公式三面図から起こした9,806三角形の完成機（舵面・脚が可動、曲面はスムーズシェーディング）。そのまま上のドロップ欄に入れても、Blenderの参考にしてもOK',
    blExport: '選択中の外観を .glb で書き出す',
    blExportTitle: '外観モデル (.dnm) をBlender用glTFに変換してダウンロード（階層・可動アニメ・YSFLIGHT情報つき）',
    blExportNone: '書き出すには外観モデル (.dnm) を選んでください',
    blExported: (n, a) => '✓ ' + n + ' を書き出しました（アニメ: ' + (a.length ? a.join('・') : 'なし') + '）',
    blHint: '⚠ Blenderからの書き出しは glTF 2.0 (.glb)、「含める → データ → カスタムプロパティ」にチェック（可動部情報の保持に必須）',
    borrowLabel: 'stockの見た目を借りる',
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
    fly: (n) => n + ' で離陸',
    datTitle: '飛行特性 (.dat) を stock から作る',
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
    paintSection: '塗装',
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
    ckTitle: 'メインコックピット',
    ckIntro: 'F1視点の目の位置と追加視点。保存時に .dat の COCKPITP / EXCAMERA へ書き込まれ、レシピにも残ります。追加視点の並び順＝ゲーム内F1サイクルの巡回順。',
    ckX: '左右 x（右+）', ckY: '上下 y（上+）', ckZ: '前後 z（機首+）',
    ckView: 'コックピットビュー', ckViewOff: '外部視点に戻る（ドラッグで見回し）',
    ckSrc: {
      recipe: 'レシピの保存値', dat: '.dat から', glb: '.glb のカメラから', user: '手動指定',
      estimate: 'ジオメトリから推定（機首から全長の約7%後方）— 要調整',
    },
    ckNone: '（外観 .dnm か .dat を入れると初期値を提案します）',
    glbCockpit: '＋ コックピット位置を .glb のカメラから取り込みました',
    vpTitle: '視点',
    vpExTitle: '追加視点 (EXCAMERA)',
    vpExIntro: '機長・副操縦士・客席・尾翼カメラなど、F1で巡回する名前付き視点。マーカーをドラッグで移動、「写し取り」で今の視点を記録。',
    vpAdd: '＋ 追加視点',
    vpDel: '削除',
    vpName: '名前',
    vpTypeOpts: { INSIDE: '機内 (INSIDE)', OUTSIDE: '機外 (OUTSIDE)', CABIN: '客室 (CABIN)' },
    vpNoHud: 'HUD非表示',
    vpNoInst: '計器盤非表示',
    vpH: '向き h（左+°）', vpP: '向き p（上+°）', vpB: '傾き b（°）',
    vpNone: '（追加視点なし — stockのB747は副操縦士席などを持っています）',
    vpCapture: '今の視点を写し取る',
    vpCaptureTitle: 'プレビューの今のカメラ（位置＋向き）を選択中の視点へ書き込む。オービット/視点サイクルで構図を決めて1クリック',
    vpCapturedMain: '✓ メインコックピットへ位置を写し取りました（COCKPITP は向きを持ちません）',
    vpCapturedEx: (n) => '✓ 「' + n + '」へ位置と向きを写し取りました',
    vpCycle: '視点サイクル',
    vpViewing: (n) => '視点: ' + n + '（クリックで次へ）',
    vpMain: 'メインコックピット',
    glbExcams: (n) => '＋ 追加視点 ' + n + ' 件を .glb のカメラから取り込みました',
    libEditingBadge: (n) => '編集中: ' + n,
  },
  en: {
    title: 'Aircraft Studio',
    sub: 'Assemble a Blender-made .glb (or .dnm/.srf) with a flight-model .dat — paint, movables and viewpoints edit live in the 3D preview.',
    errorPrefix: 'Error: ',
    working: 'Working…',
    acTitle: 'Assemble',
    acIntro: 'Combine your Blender-made .glb (or .dnm / .srf) with a flight-model .dat. No .dat? Make one below from a stock base.',
    acDrop: 'Drop aircraft files (.dat / .dnm / .srf / .glb) / click to choose',
    glbImported: (n, k, t) => '✓ Converted ' + n + ' to DNM (' + k + ' nodes, ' + t + ' triangles)',
    glbAutoColl: '+ Generated a collision shell from the visual',
    glbAutoDat: (b) => '+ Generated a flight model (.dat) from ' + b + ' (tune it in the wizard below)',
    glbReady: '→ “Assemble & save” makes it an aircraft as-is',
    blTitle: 'Build in Blender',
    blIntro: 'The Blender-first modeling path: start from the template, drop the exported .glb into the file drop above.',
    blTemplate: 'Download the aircraft template (.glb)',
    blTemplateTitle: 'A boxy airframe with every movable part (gear, flaps, propeller, VTOL nozzles, ...) pre-wired — carve the boxes and it flies',
    blSample: 'Download the B747-8I sample (.glb)',
    blSampleTitle: 'A finished 9,806-triangle airliner compiled from the official Boeing three-view (movable control surfaces and gear, smooth-shaded curves). Drop it into the file drop as-is, or use it as a Blender reference',
    blExport: 'Export the selected visual as .glb',
    blExportTitle: 'Convert the visual model (.dnm) to Blender-ready glTF (hierarchy, movable-part animations, YSFLIGHT metadata)',
    blExportNone: 'Select a visual model (.dnm) to export',
    blExported: (n, a) => '✓ Exported ' + n + ' (animations: ' + (a.length ? a.join(', ') : 'none') + ')',
    blHint: '⚠ Export from Blender as glTF 2.0 (.glb) with Include > Data > Custom Properties checked (required to keep the movable-part wiring)',
    borrowLabel: 'Borrow a stock airframe',
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
    fly: (n) => 'Fly ' + n,
    datTitle: 'Make a flight model (.dat) from stock',
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
    paintSection: 'Paint',
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
    ckTitle: 'Main cockpit',
    ckIntro: 'F1 eye positions: the main cockpit and named extra viewpoints. Written into the .dat COCKPITP / EXCAMERA on save, and kept in the recipe. Extra-view order = the in-game F1 cycle order.',
    ckX: 'x (starboard +)', ckY: 'y (up +)', ckZ: 'z (nose +)',
    ckView: 'Cockpit view', ckViewOff: 'Back to orbit (drag to look around)',
    ckSrc: {
      recipe: 'from the saved recipe', dat: 'from the .dat', glb: 'from the .glb camera', user: 'set by hand',
      estimate: 'estimated from geometry (~7% of the length behind the nose) — adjust to taste',
    },
    ckNone: '(assign a visual .dnm or a .dat and a starting value appears)',
    glbCockpit: '+ Cockpit position imported from the .glb camera',
    vpTitle: 'Viewpoints',
    vpExTitle: 'Extra viewpoints (EXCAMERA)',
    vpExIntro: 'Named F1-cycle viewpoints — captain, co-pilot, cabin, tail cam. Drag a marker to move it; Capture writes the current preview view.',
    vpAdd: '+ Add viewpoint',
    vpDel: 'Delete',
    vpName: 'Name',
    vpTypeOpts: { INSIDE: 'Inside (INSIDE)', OUTSIDE: 'Outside (OUTSIDE)', CABIN: 'Cabin (CABIN)' },
    vpNoHud: 'Hide HUD',
    vpNoInst: 'Hide inst panel',
    vpH: 'h (yaw, left +°)', vpP: 'p (pitch, up +°)', vpB: 'b (bank °)',
    vpNone: '(no extra viewpoints — stock B747 carries a co-pilot seat and more)',
    vpCapture: 'Capture current view',
    vpCaptureTitle: 'Write the preview camera (position + direction) into the selected viewpoint. Frame the shot by orbit / the view cycle, then one click',
    vpCapturedMain: '✓ Captured the position into the main cockpit (COCKPITP has no direction)',
    vpCapturedEx: (n) => '✓ Captured position + direction into “' + n + '”',
    vpCycle: 'View cycle',
    vpViewing: (n) => 'Viewing: ' + n + ' (click for next)',
    vpMain: 'Main cockpit',
    glbExcams: (n) => '+ Imported ' + n + ' extra viewpoint(s) from the .glb cameras',
    libEditingBadge: (n) => 'Editing: ' + n,
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
let partPaint = null;      // mountPartPaint handle; torn down on visual slot change
let movablesEditor = null; // handle returned by buildMovablesSection

// Cockpit eye point (YS aircraft coords = the .dat COCKPITP value) and where
// it came from: 'recipe' | 'glb' | 'dat' | 'estimate' | 'user'.  Sticky
// sources (user/recipe/glb) survive slot changes; derived ones re-derive.
let cockpit = null;
let cockpitSource = null;

// EXCAMERA extra viewpoints (the getDatExCameras shape — angles in DEGREES,
// order = the F1 cycle order) with the same source-stickiness ladder.
let excams = [];
let excamsSource = null;
let selCam = 'main';   // which viewpoint 📷/drag act on: 'main' | index
let vpTools = null;    // viewpoint-tools handle, remounted with the preview
let viewIx = -1;       // 👀 cycle position: -1 orbit, 0 main, 1.. = excams[i-1]

// DOM handles filled during boot.
let previewWrap, surfaceHint, animBar;
let editBadge, slotsBox, acMsg, btnRow;
let paintPanel, paintMsg;
let partPaintPanel; // container for studio-paint.js UI
let ckInputs = null, ckSrcNote = null;
let exListBox = null, exInputRefs = [], vpMsg = null, cycleBtn = null, captureBtn = null, mainRadio = null;
let datEditorWrap = null;    // container div for the .dat editor panel
let datEditorHandle = null;  // { load } returned by mountDatEditor

// --- the big preview surface (main) ------------------------------------------------

function buildSurface(surface) {
  // The 3D preview keeps its dark viewport (the scene clears to #0b1017 —
  // viewport convention, not chrome); the slider bar below is chrome and light.
  previewWrap = el('div');
  previewWrap.style.cssText = 'flex:1;min-height:0;position:relative;background:#0b1017';
  surfaceHint = el('div', null, S.previewNone);
  surfaceHint.style.cssText =
    'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
    'color:#7d93b0;font-size:13px;text-align:center;padding:24px';
  previewWrap.appendChild(surfaceHint);
  animBar = el('div');
  animBar.style.cssText = 'flex:none;padding:8px 12px;border-top:1px solid #ACA899;background:#ECE9D8';
  surface.appendChild(previewWrap);
  surface.appendChild(animBar);
}

const visualEntry = () => {
  if (!sels || !sels.visual.value) return null;
  const ent = byName.get(sels.visual.value);
  return ent && /\.dnm$/i.test(ent.name) ? ent : null;
};

function disposePreview() {
  if (partPaint) { partPaint.dispose(); partPaint = null; }
  if (vpTools) { vpTools.dispose(); vpTools = null; }
  if (preview) { preview.dispose(); preview = null; }
  previewedBytes = null;
  if (partPaintPanel) partPaintPanel.innerHTML = '';
  viewIx = -1;
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
    vpTools = mountViewpointTools(preview, { onMove: onMarkerMove });
    syncMarkers();
  } catch (e) {
    surfaceHint.style.display = 'flex';
    acMsg.textContent = S.errorPrefix + ((e && e.message) || e);
    return;
  }
  // Mount the part-paint panel (requires scene/camera/built from the extended mountPreview).
  if (partPaintPanel && preview.built) {
    partPaint = mountPartPaint({
      container: partPaintPanel,
      previewHandle: preview,
      getBytes: () => ent.bytes,
      setBytes: (b) => {
        ent.bytes = b;
        previewedBytes = b;
      },
      lang: LANG,
    });
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

  // Notify the movables editor that the preview has been (re)mounted so gizmos
  // can be injected into the new scene.
  if (movablesEditor) movablesEditor.refresh();
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
  sels.visual.addEventListener('change', () => { refreshPreview(); renderPaint(); deriveCockpit(); if (movablesEditor) movablesEditor.refresh(); });
  sels.dat.addEventListener('change', () => { deriveCockpit(); refreshDatEditor(); });

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
      // Cockpit -> .dat: write COCKPITP into the outgoing flight model (the
      // engine's F1 view reads only the .dat).  Left byte-identical when the
      // .dat already says exactly this.
      if (cockpit && slots.dat) {
        const cur = getDatCockpit(slots.dat.bytes);
        if (!cur || cur.x !== cockpit.x || cur.y !== cockpit.y || cur.z !== cockpit.z) {
          slots.dat = { ...slots.dat, bytes: setDatCockpit(slots.dat.bytes, cockpit) };
        }
      }
      // EXCAMERA -> .dat: same non-destructive line surgery.  Order in the
      // list = the F1 cycle order in game.  Byte-identical when unchanged.
      if (slots.dat) {
        const norm = (a) => JSON.stringify(a.map((c) => [c.name, c.x, c.y, c.z, c.h, c.p, c.b, c.type, !!c.noHud, !!c.noInstPanel]));
        if (norm(getDatExCameras(slots.dat.bytes)) !== norm(excams)) {
          slots.dat = { ...slots.dat, bytes: setDatExCameras(slots.dat.bytes, excams) };
        }
      }
      const asm = assembleAircraftZip({
        name: nameIn.value.trim() || undefined,
        ...slots,
        recipe: {
          packName: nameIn.value.trim() || undefined,
          slots: Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, v ? v.name : null])),
          datRecipe: sels.dat.value === '@generated' ? datRecipe : null,
          cockpit: cockpit ? { x: cockpit.x, y: cockpit.y, z: cockpit.z } : null,
          excameras: excams.map((c) => ({ ...c })),
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
  deriveCockpit();
  refreshDatEditor();
}

// --- dat editor refresh -------------------------------------------------------------

function refreshDatEditor() {
  if (!datEditorWrap) return;
  datEditorWrap.innerHTML = '';
  datEditorHandle = null;
  const pick = (sel) => (sel && sel.value === '@generated' ? generatedDat
    : sel && sel.value ? byName.get(sel.value) : null);
  const datEntry = sels ? pick(sels.dat) : null;
  if (!datEntry) return;
  const h2 = el('h2', null, LANG === 'ja' ? '.dat エディタ' : '.dat Editor');
  datEditorWrap.appendChild(h2);
  const intro = el('p', 'intro', LANG === 'ja'
    ? '飛行特性の全パラメータをフォームまたは生テキストで編集できます。保存すると組み立てに反映されます。'
    : 'Edit all flight-model parameters as a form or raw text. Save writes back into the assembly.');
  datEditorWrap.appendChild(intro);
  datEditorHandle = mountDatEditor(datEditorWrap, {
    getBytes: () => datEntry.bytes,
    setBytes: (bytes) => { datEntry.bytes = bytes; },
    LANG,
    el,
    row,
  });
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

  datEditorWrap = el('div');
  rail.appendChild(datEditorWrap);

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
          // A Cockpit camera in the glb (our export, or one added in Blender)
          // carries the eye point into the recipe.
          if (res.cockpit) {
            cockpit = res.cockpit;
            cockpitSource = 'glb';
            auto.push(S.glbCockpit);
          }
          // Extra viewpoint cameras (our export, or ones added in Blender).
          if (res.excameras && res.excameras.length) {
            excams = res.excameras;
            excamsSource = 'glb';
            auto.push(S.glbExcams(excams.length));
          }
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
    cell.style.cssText = 'display:flex;align-items:center;gap:4px;border:1px solid #ACA899;border-radius:2px;background:#fff;padding:3px 6px';
    const sw = el('span');
    sw.style.cssText = 'width:16px;height:16px;border-radius:3px;display:inline-block;background:rgb(' + c.r + ',' + c.g + ',' + c.b + ')';
    const cnt = el('span', null, String(c.count));
    cnt.style.cssText = 'color:#777;font-size:10.5px';
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

// --- part paint section (new) --------------------------------------------------------

function buildPartPaintSection(rail) {
  partPaintPanel = document.createElement('div');
  partPaintPanel.style.cssText = 'padding:0';
  rail.appendChild(partPaintPanel);
  // Content is populated by mountPartPaint after preview is ready.
}

// --- viewpoints section -----------------------------------------------------------
// The F1 eye positions: the main cockpit (COCKPITP) plus named EXCAMERA extra
// viewpoints.  Each value lives in three places, all wired here: the recipe
// (workbench.json, for re-editing), the outgoing .dat lines (what the engine
// reads), and the preview (markers + view cycle + drag + 📷 capture, an
// approachable approximation — the truth is always the 🛫 flight).

const D2R = Math.PI / 180;

// Preview markers follow the state: the main cockpit rides the preview's own
// yellow marker (via setCockpit); this adds the EXCAMERA markers, name labels,
// forward rays and the drag handle for whichever viewpoint is selected.
function syncMarkers() {
  if (!vpTools) return;
  const items = [];
  if (cockpit) items.push({ key: 'main', x: cockpit.x, y: cockpit.y, z: cockpit.z, h: 0, p: 0, b: 0, kind: 'main', selected: selCam === 'main' });
  excams.forEach((c, i) => items.push({
    key: i, name: c.name || 'EXCAMERA', x: c.x, y: c.y, z: c.z,
    h: (c.h || 0) * D2R, p: (c.p || 0) * D2R, b: (c.b || 0) * D2R,
    kind: 'ex', selected: selCam === i,
  }));
  vpTools.setMarkers(items);
}

// The 👀 cycle stops, in engine order: main cockpit, then each EXCAMERA in
// list order (= .dat order = the F1 cycle in game), then back to orbit.
function vpStops() {
  const st = [];
  if (cockpit) st.push({ name: S.vpMain, pose: { ...cockpit } });
  for (const c of excams) {
    st.push({
      name: c.name || 'EXCAMERA',
      pose: { x: c.x, y: c.y, z: c.z, h: (c.h || 0) * D2R, p: (c.p || 0) * D2R, b: (c.b || 0) * D2R },
    });
  }
  return st;
}

function exitView() {
  viewIx = -1;
  if (preview) {
    preview.setCockpitView(false);
    preview.setCockpit(cockpit);
  }
  if (vpTools) vpTools.setVisible(true);
  if (cycleBtn) {
    cycleBtn.textContent = S.vpCycle;
    cycleBtn.classList.remove('accent');
  }
}

function stepView() {
  if (!preview) return;
  const stops = vpStops();
  viewIx++;
  if (viewIx >= stops.length) { exitView(); return; }
  preview.setCockpit(stops[viewIx].pose);
  preview.setCockpitView(true);
  if (vpTools) vpTools.setVisible(false); // markers would sit in the lens
  cycleBtn.textContent = S.vpViewing(stops[viewIx].name);
  cycleBtn.classList.add('accent');
}

// Live drag from the 3D handle: position only (direction stays put; 📷 or the
// h/p/b inputs own that), value updates without a list rebuild so focus and
// the drag itself survive.
function onMarkerMove(key, p) {
  const r = (v) => Math.round(v * 100) / 100;
  if (key === 'main') {
    cockpit = { x: r(p.x), y: r(p.y), z: r(p.z) };
    cockpitSource = 'user';
    for (const k of ['x', 'y', 'z']) if (ckInputs && document.activeElement !== ckInputs[k]) ckInputs[k].value = String(cockpit[k]);
    if (ckSrcNote) ckSrcNote.textContent = S.ckSrc.user;
    if (preview && viewIx < 0) preview.setCockpit(cockpit); // the yellow marker follows
  } else if (excams[key]) {
    Object.assign(excams[key], { x: r(p.x), y: r(p.y), z: r(p.z) });
    excamsSource = 'user';
    const refs = exInputRefs[key];
    if (refs) for (const k of ['x', 'y', 'z']) if (document.activeElement !== refs[k]) refs[k].value = String(excams[key][k]);
  }
}

function updateCockpitUi() {
  if (!ckInputs) return;
  for (const k of ['x', 'y', 'z']) {
    if (document.activeElement !== ckInputs[k]) ckInputs[k].value = cockpit ? String(cockpit[k]) : '';
  }
  ckSrcNote.textContent = cockpit ? (S.ckSrc[cockpitSource] || '') : S.ckNone;
  // While 👀 is parked on an EXCAMERA, setCockpit carries that eye pose — do
  // not yank it back to the main seat until the cycle leaves.
  if (preview && viewIx <= 0) preview.setCockpit(cockpit);
  const stops = preview ? vpStops().length : 0;
  if (cycleBtn) cycleBtn.disabled = !stops;
  if (captureBtn) captureBtn.disabled = !vpTools;
  if (viewIx >= (preview ? vpStops().length : 0)) exitView();
  syncMarkers();
}

// Rebuild the EXCAMERA list DOM (structural changes only — value edits go
// through the input handlers / onMarkerMove to keep focus).
function renderExcamList() {
  if (!exListBox) return;
  exListBox.innerHTML = '';
  exInputRefs = [];
  if (selCam !== 'main' && !excams[selCam]) selCam = 'main';
  if (mainRadio) mainRadio.checked = selCam === 'main';
  if (!excams.length) {
    exListBox.appendChild(el('div', 'msg', S.vpNone));
    return;
  }
  // Selection restyles in place (no DOM rebuild — that would eat the very
  // click that landed on a button/input inside the item).
  const parts = []; // [{item, radio}]
  const refreshSel = () => {
    if (mainRadio) mainRadio.checked = selCam === 'main';
    parts.forEach((p, i) => {
      p.item.style.borderColor = selCam === i ? '#ff8c3a' : '#ACA899';
      p.radio.checked = selCam === i;
    });
  };
  excams.forEach((cam, i) => {
    const item = el('div');
    item.style.cssText = 'border:1px solid ' + (selCam === i ? '#ff8c3a' : '#ACA899') + ';border-radius:2px;background:#F2F1E5;padding:6px;margin:6px 0';
    const pick = () => { if (selCam !== i) { selCam = i; refreshSel(); syncMarkers(); } };
    item.addEventListener('pointerdown', pick);

    const r1 = el('div', 'row');
    const radio = Object.assign(document.createElement('input'), { type: 'radio', name: 'vpsel', checked: selCam === i });
    radio.addEventListener('change', pick);
    parts.push({ item, radio });
    const nameIn = Object.assign(document.createElement('input'), { type: 'text', value: cam.name || '', placeholder: S.vpName });
    nameIn.style.cssText = 'flex:1;min-width:0';
    nameIn.addEventListener('input', () => { cam.name = nameIn.value; excamsSource = 'user'; syncMarkers(); });
    const delBtn = el('button', null, S.vpDel);
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      excams.splice(i, 1);
      excamsSource = 'user';
      if (selCam === i) selCam = 'main';
      else if (selCam !== 'main' && selCam > i) selCam--;
      exitView();
      renderExcamList();
      updateCockpitUi();
    });
    r1.appendChild(radio);
    r1.appendChild(nameIn);
    r1.appendChild(delBtn);
    item.appendChild(r1);

    const r2 = el('div', 'row');
    const typeSel = document.createElement('select');
    for (const t of ['INSIDE', 'OUTSIDE', 'CABIN']) {
      typeSel.appendChild(Object.assign(el('option'), { value: t, textContent: S.vpTypeOpts[t], selected: cam.type === t }));
    }
    typeSel.addEventListener('change', () => { cam.type = typeSel.value; excamsSource = 'user'; });
    r2.appendChild(typeSel);
    const cb = (labelText, key) => {
      const lab = el('span', null, labelText);
      lab.style.cssText = 'color:#555;font-size:11px';
      const c = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!cam[key] });
      c.addEventListener('change', () => { cam[key] = c.checked; excamsSource = 'user'; });
      r2.appendChild(c);
      r2.appendChild(lab);
    };
    cb(S.vpNoHud, 'noHud');
    cb(S.vpNoInst, 'noInstPanel');
    item.appendChild(r2);

    const grid = el('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin-top:4px';
    const refs = {};
    const numIn = (key, labelText, step) => {
      const wrap = el('div');
      const lab = el('div', null, labelText);
      lab.style.cssText = 'color:#555;font-size:10px';
      const inp = Object.assign(document.createElement('input'), { type: 'number', step, value: String(cam[key]) });
      inp.style.cssText = 'width:100%;box-sizing:border-box;border:1px solid #7F9DB9;border-radius:2px;background:#fff;color:#000;padding:2px 4px';
      inp.addEventListener('input', () => {
        const v = parseFloat(inp.value);
        if (!Number.isFinite(v)) return;
        cam[key] = v;
        excamsSource = 'user';
        syncMarkers();
      });
      wrap.appendChild(lab);
      wrap.appendChild(inp);
      grid.appendChild(wrap);
      refs[key] = inp;
    };
    numIn('x', S.ckX, '0.05');
    numIn('y', S.ckY, '0.05');
    numIn('z', S.ckZ, '0.05');
    numIn('h', S.vpH, '1');
    numIn('p', S.vpP, '1');
    numIn('b', S.vpB, '1');
    item.appendChild(grid);
    exInputRefs[i] = refs;
    exListBox.appendChild(item);
  });
}

// Initial-value ladder: ① a sticky value (hand-set / recipe / glb camera)
// stays put; ② the assigned .dat's existing COCKPITP; ③ a geometry estimate
// (labeled as such in the UI).  EXCAMERAs share the ladder minus the estimate.
function deriveCockpit() {
  if (!ckInputs) return;
  deriveExcams();
  if (cockpit && cockpitSource !== 'dat' && cockpitSource !== 'estimate') { updateCockpitUi(); return; }
  const datEnt = sels && sels.dat
    ? (sels.dat.value === '@generated' ? generatedDat : sels.dat.value ? byName.get(sels.dat.value) : null)
    : null;
  const fromDat = datEnt && /\.dat$/i.test(datEnt.name) ? getDatCockpit(datEnt.bytes) : null;
  if (fromDat) {
    cockpit = fromDat;
    cockpitSource = 'dat';
  } else {
    const ent = visualEntry();
    let est = null;
    try { est = ent ? estimateCockpit(ent.bytes) : null; } catch (e) { est = null; }
    cockpit = est;
    cockpitSource = est ? 'estimate' : null;
  }
  updateCockpitUi();
}

function deriveExcams() {
  if (excams.length && excamsSource !== 'dat') { renderExcamList(); return; } // sticky
  const datEnt = sels && sels.dat
    ? (sels.dat.value === '@generated' ? generatedDat : sels.dat.value ? byName.get(sels.dat.value) : null)
    : null;
  const fromDat = datEnt && /\.dat$/i.test(datEnt.name) ? getDatExCameras(datEnt.bytes) : [];
  excams = fromDat;
  excamsSource = fromDat.length ? 'dat' : null;
  if (selCam !== 'main' && !excams[selCam]) selCam = 'main';
  renderExcamList();
}

function buildViewpointsSection(rail) {
  rail.appendChild(el('h2', null, S.vpTitle));
  rail.appendChild(el('p', 'intro', S.ckIntro));
  const box = el('div');
  rail.appendChild(box);

  // Main cockpit: selectable like the extra viewpoints, so 📷 and the drag
  // handle can target it.
  const mainRow = el('div', 'row');
  mainRadio = Object.assign(document.createElement('input'), { type: 'radio', name: 'vpsel', checked: true });
  mainRadio.addEventListener('change', () => { selCam = 'main'; renderExcamList(); syncMarkers(); });
  mainRow.appendChild(mainRadio);
  mainRow.appendChild(el('span', 'lab', S.ckTitle));
  box.appendChild(mainRow);
  ckInputs = {};
  for (const k of ['x', 'y', 'z']) {
    const inp = Object.assign(document.createElement('input'), { type: 'number', step: '0.05' });
    inp.addEventListener('input', () => {
      const v = {
        x: parseFloat(ckInputs.x.value),
        y: parseFloat(ckInputs.y.value),
        z: parseFloat(ckInputs.z.value),
      };
      if (![v.x, v.y, v.z].every(Number.isFinite)) return;
      cockpit = v;
      cockpitSource = 'user';
      updateCockpitUi();
    });
    row(box, S['ck' + k.toUpperCase()], inp);
    ckInputs[k] = inp;
  }
  ckSrcNote = el('div', 'msg');
  box.appendChild(ckSrcNote);

  // Extra viewpoints (EXCAMERA).
  const exHead = el('div', 'row');
  exHead.appendChild(el('span', 'lab', S.vpExTitle));
  const addBtn = el('button', null, S.vpAdd);
  addBtn.addEventListener('click', () => {
    // Seed from the main seat mirrored to the other side (the co-pilot idiom)
    // when we have one; refine by drag / 📷 afterwards.
    const seed = cockpit
      ? { x: Math.round(-cockpit.x * 100) / 100, y: cockpit.y, z: cockpit.z }
      : { x: 0, y: 0, z: 0 };
    excams.push({ name: 'VIEW' + (excams.length + 1), ...seed, h: 0, p: 0, b: 0, type: 'INSIDE', noHud: false, noInstPanel: false });
    excamsSource = 'user';
    selCam = excams.length - 1;
    renderExcamList();
    updateCockpitUi();
  });
  exHead.appendChild(addBtn);
  box.appendChild(exHead);
  box.appendChild(el('p', 'intro', S.vpExIntro));
  exListBox = el('div');
  box.appendChild(exListBox);
  vpMsg = el('div', 'msg');
  box.appendChild(vpMsg);

  const btnR = el('div', 'btnrow');
  btnR.style.justifyContent = 'flex-start';
  captureBtn = el('button', null, S.vpCapture);
  captureBtn.title = S.vpCaptureTitle;
  captureBtn.addEventListener('click', () => {
    if (!vpTools) return;
    const pose = vpTools.capturePose(); // YS coords, radians
    const r = (v) => Math.round(v * 100) / 100;
    const ra = (v) => Math.round((v / D2R) * 10) / 10;
    if (selCam === 'main') {
      cockpit = { x: r(pose.x), y: r(pose.y), z: r(pose.z) };
      cockpitSource = 'user';
      vpMsg.textContent = S.vpCapturedMain;
      updateCockpitUi();
    } else if (excams[selCam]) {
      Object.assign(excams[selCam], { x: r(pose.x), y: r(pose.y), z: r(pose.z), h: ra(pose.h), p: ra(pose.p), b: ra(pose.b) });
      excamsSource = 'user';
      vpMsg.textContent = S.vpCapturedEx(excams[selCam].name || 'EXCAMERA');
      renderExcamList();
      updateCockpitUi();
    }
  });
  btnR.appendChild(captureBtn);
  cycleBtn = el('button', null, S.vpCycle);
  cycleBtn.addEventListener('click', stepView);
  btnR.appendChild(cycleBtn);
  box.appendChild(btnR);
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
  smokeLab.style.cssText = 'color:#555;font-size:12px';
  const smokeCol = Object.assign(document.createElement('input'), { type: 'color', value: '#ff5050' });
  smokeCol.style.cssText = 'width:52px;height:28px;padding:1px;border:1px solid #7F9DB9;border-radius:2px;background:#fff';
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
  // Download links dressed as the era's buttons (same gradient as the chrome).
  const linkCss = 'display:inline-block;margin:0 8px 8px 0;padding:6px 12px;border:1px solid #003C74;' +
    'border-radius:3.5px;color:#000;font-size:12.5px;text-decoration:none;' +
    'background:linear-gradient(180deg,#FFFFFF 0%,#F4F2E7 55%,#E5E1CE 90%,#D8D0B8 100%);' +
    'box-shadow:inset 0 -2px 2px rgba(160,140,90,0.22)';
  const tpl = el('a', null, S.blTemplate);
  tpl.href = './aircraft-starter.glb';
  tpl.download = 'aircraft-starter.glb';
  tpl.title = S.blTemplateTitle;
  tpl.style.cssText = linkCss;
  rail.appendChild(tpl);
  const smp = el('a', null, S.blSample);
  smp.href = './b747-8i.glb';
  smp.download = 'b747-8i.glb';
  smp.title = S.blSampleTitle;
  smp.style.cssText = linkCss;
  rail.appendChild(smp);
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
      // The cockpit and every extra viewpoint ride along as glTF cameras so
      // Blender shows each seat's view and a re-import restores the values.
      const res = dnmToGlb(ent.bytes, cockpit || excams.length
        ? { cockpit: cockpit || undefined, excameras: excams }
        : undefined);
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
  const chrome = studioChrome(S.title, S.sub);
  buildSurface(chrome.main);
  buildAssembleSection(chrome.rail);
  // Thin mount: the linter UI lives in dnm-lint-ui.js; we only hand it the
  // files currently assigned to the slots (collision/cockpit lint differently).
  const lint = buildLintSection(chrome.rail, () => {
    if (!sels) return [];
    const pick = (sel, kind) => {
      const ent = sel.value && sel.value !== '@generated' ? byName.get(sel.value) : null;
      return ent ? { name: ent.name, bytes: ent.bytes, kind } : null;
    };
    return [
      pick(sels.visual, 'visual'), pick(sels.coarse, 'visual'),
      pick(sels.collision, 'collision'), pick(sels.cockpit, 'cockpit'),
    ].filter(Boolean);
  });
  buildBorrowSection(chrome.rail);
  buildPaintSection(chrome.rail);
  buildPartPaintSection(chrome.rail);
  buildViewpointsSection(chrome.rail);

  // Movable-part & light GUI editor.  Mounts into the rail; reads the visual
  // entry and the live preview handle via closures over module state.
  movablesEditor = buildMovablesSection(chrome.rail, {
    getVisualEntry: () => visualEntry(),
    getPreview: () => preview,
    onBytesChanged: (newBytes, _name) => {
      const ent = visualEntry();
      if (!ent) return;
      ent.bytes = newBytes;
      previewedBytes = null; // force remount on next refresh
      refreshPreview();
      renderPaint();
    },
  });
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
        const rc = c.recipe.cockpit;
        if (rc && [rc.x, rc.y, rc.z].every(Number.isFinite)) {
          cockpit = { x: rc.x, y: rc.y, z: rc.z };
          cockpitSource = 'recipe';
        }
        if (Array.isArray(c.recipe.excameras)) {
          excams = c.recipe.excameras.filter((e) => e && [e.x, e.y, e.z].every(Number.isFinite));
          excamsSource = excams.length ? 'recipe' : null;
        }
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
    cockpit: () => (cockpit ? { ...cockpit, source: cockpitSource } : null),
    setCockpitView: (on) => { if (preview) preview.setCockpitView(on); return !!(preview && preview.getCockpitView()); },
    excams: () => excams.map((c) => ({ ...c })),
    capturePose: () => (vpTools ? vpTools.capturePose() : null),
    stepView: () => { stepView(); return viewIx; },
    runLint: () => lint.run(),
  };
}
main();
