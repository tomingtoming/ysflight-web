// The workbench HUB (workbench.html): the home of "my creations" and the
// launcher for the dedicated full-screen studio pages.  The actual editors
// live on their own pages now —
//   studio-aircraft.html  aircraft assembly / paint / .dat wizard / 3D preview
//   studio-scenery.html   map drawing (islands, objects, mountains, starts)
//   studio-pack.html      pack composition: inventory, merge, export, import
// Everything stays engine-less: creations are OPFS pack records only, and the
// game page materializes every enabled record at boot.
//
// window.ysfwWorkbench (the smoke test's and console's API) is preserved here
// unchanged — it never depended on the editor cards, only on the shared libs.

import {
  assembleAircraftZip, makeDatFromBase, assembleSceneryZip, SCENERY_START,
  extractDnmColors, repaintDnm,
} from './workbench.js';
import {
  LANG, el, pageUrl, flyUrl, DEFAULT_FLY_AIRCRAFT,
  installZip, saveOrReplace, listCreations, loadRecipe, stockIndex, packPayload,
} from './studio-shared.js';
import { dnmToGlb } from './dnm-gltf.js';
import * as opfs from './opfs-store.js';
import { listStaged, getStaged, putStaged, removeStaged } from './staging.js';

const S = ({
  ja: {
    title: '🛠 ワークベンチ',
    sub: '機体とマップを作る場所。作ったものは自動で保存され、ゲームを開くと使えます。',
    backToGame: '← ゲームへ戻る',
    studios: [
      {
        page: 'studio-aircraft.html', glyph: '✈️', title: '機体スタジオ',
        desc: 'stockの見た目を借りて塗装し、性能を .dat ウィザードでいじって、3Dプレビューで確かめる。Blenderで作った .glb の取り込みもここ。',
      },
      {
        page: 'studio-scenery.html', glyph: '🏝', title: 'マップスタジオ',
        desc: '画面いっぱいのキャンバスに海岸線を描いて島を作る。空母・滑走路・山・スタート地点も配置できる。',
      },
      {
        page: 'studio-pack.html', glyph: '📦', title: 'パックスタジオ',
        desc: '自分の機体とマップを選んでまとめた「パック」を作る。パックも1つの作品として棚に並び、配布用zipに書き出せる。',
      },
    ],
    open: '開く',
    libTitle: '📦 マイ作品',
    libIntro: 'このワークベンチで作った物だけが並びます（zipで取り込んだパックは 📦 パックスタジオで）。✏️ でスタジオを開いて続きから編集できます',
    libEmpty: '（まだ何もありません — 上のスタジオで作りましょう）',
    libKind: { aircraft: '✈️', scenery: '🏝', mixed: '📦', other: '📦' },
    libOn: '有効', libOff: '無効',
    libFly: '🛫', libFlyTitle: 'テスト飛行（ゲームページに移動します）',
    libGlb: '🟠', libGlbTitle: 'Blender用に書き出す (.glb)',
    libEdit: '✏️', libEditTitle: 'スタジオで続きから編集',
    libDel: '🗑', libDelTitle: '削除',
    libDelConfirm: (n) => '「' + n + '」を削除しますか？',
  },
  en: {
    title: '🛠 Workbench',
    sub: 'The place to build aircraft and maps. Everything saves automatically and is available next time the game loads.',
    backToGame: '← Back to the game',
    studios: [
      {
        page: 'studio-aircraft.html', glyph: '✈️', title: 'Aircraft Studio',
        desc: 'Borrow a stock airframe, paint it, tune the .dat, and check it in a live 3D preview. Blender-made .glb files import here too.',
      },
      {
        page: 'studio-scenery.html', glyph: '🏝', title: 'Scenery Studio',
        desc: 'Draw coastlines on a full-screen canvas to make islands; place carriers, runways, mountains and start points.',
      },
      {
        page: 'studio-pack.html', glyph: '📦', title: 'Pack Studio',
        desc: 'Curate your own aircraft and maps into a pack — itself a work on your shelf, exportable as a distributable zip.',
      },
    ],
    open: 'Open',
    libTitle: '📦 My creations',
    libIntro: 'Only things MADE in this workbench appear here (imported zip packs live in the 📦 Pack Studio). ✏️ opens the right studio to continue editing',
    libEmpty: '(Nothing yet — make something in a studio above)',
    libKind: { aircraft: '✈️', scenery: '🏝', mixed: '📦', other: '📦' },
    libOn: 'On', libOff: 'Off',
    libFly: '🛫', libFlyTitle: 'Test-fly (moves to the game page)',
    libGlb: '🟠', libGlbTitle: 'Export for Blender (.glb)',
    libEdit: '✏️', libEditTitle: 'Continue editing in its studio',
    libDel: '🗑', libDelTitle: 'Delete',
    libDelConfirm: (n) => 'Delete “' + n + '”?',
  },
})[LANG];

const app = document.getElementById('app');

function header() {
  const top = el('div', 'top');
  const left = el('div');
  left.appendChild(el('h1', null, S.title));
  const back = el('a', null, S.backToGame);
  back.href = pageUrl('index.html');
  top.appendChild(left);
  top.appendChild(back);
  app.appendChild(top);
  app.appendChild(el('p', 'sub', S.sub));
}

// The three studio launchers — the hub's main job.
function studioCards() {
  const wrap = el('div');
  wrap.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-bottom:16px';
  for (const st of S.studios) {
    const card = el('a', 'card');
    card.href = pageUrl(st.page);
    card.style.cssText = 'display:block;margin:0;text-decoration:none;color:inherit;cursor:pointer';
    const h = el('h2', null, st.glyph + ' ' + st.title);
    h.style.fontSize = '16px';
    card.appendChild(h);
    const d = el('p', 'intro', st.desc);
    d.style.margin = '6px 0 10px';
    card.appendChild(d);
    const go = el('span', null, S.open + ' →');
    go.style.cssText = 'color:#4da3ff;font-size:13px';
    card.appendChild(go);
    wrap.appendChild(card);
  }
  app.appendChild(wrap);
}

// --- creations library ---------------------------------------------------------

let renderLibrary = () => {};
let lastAircraftIdentify = null;

function creationsCard() {
  const card = el('div', 'card');
  card.appendChild(el('h2', null, S.libTitle));
  card.appendChild(el('p', 'intro', S.libIntro));
  const listEl = el('div');
  card.appendChild(listEl);
  app.appendChild(card);

  renderLibrary = async () => {
    const items = await listCreations();
    listEl.innerHTML = '';
    if (items.length === 0) {
      listEl.appendChild(el('div', 'msg', S.libEmpty));
      return;
    }
    for (const it of items) {
      const rowEl = el('div');
      rowEl.style.cssText =
        'display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid #2a3647;' +
        'border-radius:7px;margin-bottom:6px;background:#0b1017' + (it.enabled ? '' : ';opacity:.5');
      const badge = el('span', null, S.libKind[it.kind] || '📦');
      badge.style.cssText = 'flex:none';
      const nm = el('span', null, it.name || it.id);
      nm.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e6edf3;font-size:13.5px';
      const sub = el('span', null, it.identities[0] || it.sceneryIdent || '');
      sub.style.cssText = 'flex:none;color:#7d93b0;font-size:11px;max-width:30%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      rowEl.appendChild(badge);
      rowEl.appendChild(nm);
      rowEl.appendChild(sub);

      const btn = (label, title, accent) => {
        const b = el('button', accent ? 'accent' : null, label);
        b.title = title;
        b.style.cssText += ';font-size:12px;padding:4px 9px;flex:none';
        rowEl.appendChild(b);
        return b;
      };
      const onoff = btn(it.enabled ? S.libOn : S.libOff, '', it.enabled);
      onoff.addEventListener('click', async () => {
        await opfs.setEnabled(it.id, !it.enabled);
        renderLibrary();
      });
      const canFlyScenery = it.kind === 'scenery' && it.sceneryIdent && it.recipeSha;
      if (it.enabled && (it.identities.length > 0 || canFlyScenery)) {
        const fly = btn(S.libFly, S.libFlyTitle, true);
        fly.addEventListener('click', () => {
          if (it.identities.length > 0) location.href = flyUrl(it.identities[0]);
          else location.href = flyUrl(lastAircraftIdentify || DEFAULT_FLY_AIRCRAFT, it.sceneryIdent, SCENERY_START);
        });
      }
      // 🟠 an aircraft creation is downloadable as .glb — the seamless half of
      // the Blender loop (the other half: dropping a .glb into the aircraft
      // studio auto-completes into a full aircraft).
      if (it.kind === 'aircraft' && it.recipeSha) {
        const glb = btn(S.libGlb, S.libGlbTitle, false);
        glb.addEventListener('click', async () => {
          try {
            let visualName = null;
            try { visualName = ((await loadRecipe(it.recipeSha)).slots || {}).visual || null; } catch (e) {}
            const payload = await packPayload(it.id, 'aircraft/');
            const ent = (visualName && payload.find((f) => f.name === visualName)) ||
              payload.find((f) => /\.dnm$/i.test(f.name));
            if (!ent) throw new Error('no visual .dnm in this pack');
            const res = dnmToGlb(ent.bytes);
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([res.glb], { type: 'model/gltf-binary' }));
            a.download = (it.identities[0] || it.name || 'aircraft') + '.glb';
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
          } catch (e) {
            console.warn('[workbench] glb export failed', e);
          }
        });
      }
      // ✏️ opens the matching studio with ?edit=<record id> — the studio pulls
      // the recipe + payload back out of OPFS itself.  Routing needs the recipe
      // TYPE (a pack of aircraft looks 'aircraft' by category), so peek at it.
      if (it.recipeSha) {
        const ed = btn(S.libEdit, S.libEditTitle, false);
        ed.addEventListener('click', async () => {
          let type = it.kind === 'scenery' ? 'scenery' : 'aircraft';
          try { type = (await loadRecipe(it.recipeSha)).type || type; } catch (e) {}
          const page = type === 'pack' ? 'studio-pack.html'
            : type === 'scenery' ? 'studio-scenery.html' : 'studio-aircraft.html';
          location.href = pageUrl(page, { edit: it.id });
        });
      }
      const del = btn(S.libDel, S.libDelTitle, false);
      del.style.color = '#c75d6a';
      del.addEventListener('click', async () => {
        if (!self.confirm(S.libDelConfirm(it.name || it.id))) return;
        await opfs.removeRecord(it.id);
        try { await opfs.gc(); } catch (e) {}
        renderLibrary();
      });
      listEl.appendChild(rowEl);
    }
  };
  renderLibrary();
}

// --- boot -------------------------------------------------------------------------

async function main() {
  try { await navigator.storage.persist(); } catch (e) { /* best effort */ }
  header();
  studioCards();
  creationsCard();
  // Driven by the smoke test (and handy in the console).  The two create APIs
  // embed recipes exactly like the studio UIs do, so anything made through them
  // shows up as an editable creation in the library.
  window.ysfwWorkbench = {
    ready: true,
    installZip,
    listStock: stockIndex,
    listCreations,
    loadRecipe,
    listStaged, getStaged, putStaged, removeStaged, // modeler file bridge (smoke/debug)
    deleteCreation: async (id) => {
      await opfs.removeRecord(id);
      try { await opfs.gc(); } catch (e) {}
      renderLibrary();
      return { id, removed: true };
    },
    makeDat: async (file, identify, knobs, extras) => {
      const r = await fetch('./stock/' + file);
      if (!r.ok) throw new Error('stock fetch: HTTP ' + r.status);
      return makeDatFromBase(new Uint8Array(await r.arrayBuffer()), { identify, knobs, extras });
    },
    extractDnmColors, repaintDnm, // paint shop primitives (smoke/debug)
    assembleInstall: async (slots) => {
      const asm = assembleAircraftZip({
        ...slots,
        recipe: {
          packName: slots.name,
          slots: Object.fromEntries(['dat', 'visual', 'collision', 'cockpit', 'coarse']
            .map((k) => [k, slots[k] ? slots[k].name : null])),
        },
      });
      const res = await saveOrReplace(asm.zipBytes, asm.packName, slots.replaceId);
      lastAircraftIdentify = asm.identify || lastAircraftIdentify;
      renderLibrary();
      return { ...res, identify: asm.identify, warnings: asm.warnings, packName: asm.packName };
    },
    createScenery: async (opts) => {
      const { replaceId, ...scenery } = opts;
      const asm = assembleSceneryZip({ ...scenery, recipe: { scenery } });
      const res = await saveOrReplace(asm.zipBytes, asm.packName, replaceId);
      renderLibrary();
      return { ...res, ident: asm.ident, start: SCENERY_START };
    },
  };
}
main();
