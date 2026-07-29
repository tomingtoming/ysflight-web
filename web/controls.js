// Controls core — merge web-owned gamepad assignments into the engine's
// ctlassign.cfg (web-shell increment 13).
//
// The engine reads control assignments from <userdir>/config/ctlassign.cfg
// (FsControlAssignment::Load, fscontrol.cpp): VER header, then
//   AXS <dev 0-7|M> <axis 0-5> <AXISFUNC> [REV]
//   TRG <dev 0-7|M> <btn 0-31> <BUTTONFUNC>
//   KEY <KEYLABEL> <BUTTONFUNC>
//   DZELV2|DZAIL2|DZRUD2 <float>   HATSW <TRUE|FALSE>   END
// Keyboard (KEY), mouse ('M' = device 7) and joysticks share the ONE file, so
// the web must not own the whole file: this module rewrites only the GAMEPAD
// lines (devices 0-6) and the dead zones, passing every other line through
// verbatim — same merge philosophy as settings.js for flight.cfg.
//
// Calibration note: the web port feeds the Gamepad API's already-normalized
// -1..1 axes straight to the engine and the YsJoyReader calibration stack is
// compiled out (src/port/platform_emscripten/fsplatform_emscripten.cpp), so
// per-axis min/center/max calibration does not exist on the web — REV and the
// dead zones are the only axis shaping that reaches the sim.
//
// Classic script (globalThis.ysfwControls), loaded before Module like
// settings.js; test/controls.test.mjs imports it for the side effect.
globalThis.ysfwControls = (function () {
  'use strict';

  // Axis functions the page offers (fscontrol.cpp fsAxisFuncStr).  A curated
  // subset: the four flight axes plus the gamepad-style incremental throttle.
  var AXIS_FUNCS = ['AILERON', 'ELEVATOR', 'THROTTLE', 'THROTTLEUPDOWN', 'RUDDER'];

  // Button functions the page offers (fscontrol.cpp fsButtonFuncStr).  A
  // curated subset of the ~100 tokens — the ones a stick/pad user actually
  // rebinds; keyboard keeps the full default map (KEY lines pass through).
  var BUTTON_FUNCS = [
    'FIREWEAPON', 'SELECTWEAPON', 'RADAR', 'DISPENSEFLARE',
    'LANDINGGEAR', 'FLAP', 'SPOILERBRAKE', 'AFTERBURNER',
    'AUTOTRIM', 'THROTTLEUP', 'THROTTLEDOWN', 'REVERSETHRUST',
    'COCKPITVIEW', 'OUTSIDEPLAYERVIEW', 'PAUSESIMULATION',
  ];

  // The engine's gamepad-tuned default (fscontrol.cpp SetDefaultGamePad):
  // one click on the page applies this to the chosen pad.
  function gamepadPreset(dev) {
    return normalize({
      axes: [
        { dev: dev, axis: 0, func: 'AILERON', rev: false },
        { dev: dev, axis: 1, func: 'ELEVATOR', rev: false },
        { dev: dev, axis: 2, func: 'RUDDER', rev: false },
        { dev: dev, axis: 3, func: 'THROTTLEUPDOWN', rev: true },
      ],
      btns: [
        { dev: dev, btn: 0, func: 'FIREWEAPON' },
        { dev: dev, btn: 1, func: 'SELECTWEAPON' },
        { dev: dev, btn: 2, func: 'RADAR' },
        { dev: dev, btn: 3, func: 'DISPENSEFLARE' },
        { dev: dev, btn: 4, func: 'LANDINGGEAR' },
        { dev: dev, btn: 5, func: 'FLAP' },
        { dev: dev, btn: 6, func: 'SPOILERBRAKE' },
        { dev: dev, btn: 7, func: 'AUTOTRIM' },
      ],
      dz: { elv: 0.03, ail: 0.03, rud: 0.03 },
    });
  }

  // The engine's complete default assignment, as a file.  Needed because the
  // engine only ever CREATES ctlassign.cfg from its own key-assign dialog:
  // FsControlAssignment::Load runs CleanUp() only when the file opens, so
  // "no file" = full constructor defaults, but a PARTIAL file would wipe the
  // keyboard.  When the web writes the first file it must therefore carry the
  // whole default map.  Mirrors fscontrol.cpp SetDefault(0) +
  // SetDefaultKeyAssign (non-Apple branch; upstream is frozen) — keep in sync.
  var DEFAULT_KEYS = [
    ['INS', 'TRIMDOWN'], ['DEL', 'TRIMUP'], ['T', 'AUTOTRIM'],
    ['Q', 'THROTTLEUP'], ['A', 'THROTTLEDOWN'], ['TAB', 'AFTERBURNER'],
    ['PAGEUP', 'NOZZLEUP'], ['PAGEDOWN', 'NOZZLEDOWN'], ['COMMA', 'CYCLESENSITIVITY'],
    ['G', 'LANDINGGEAR'], ['B', 'SPOILERBRAKE'],
    ['Z', 'RUDDERLEFT'], ['X', 'RUDDERCENTER'], ['C', 'RUDDERRIGHT'],
    ['SPACE', 'FIREWEAPON'], ['2', 'SELECTWEAPON'], ['P', 'CYCLESMOKESELECTOR'],
    ['3', 'RADAR'], ['4', 'DISPENSEFLARE'], ['I', 'TOGGLELIGHT'],
    ['V', 'VELOCITYINDICATOR'], ['BS', 'OPENAUTOPILOTMENU'], ['ENTER', 'OPENRADIOCOMMMENU'],
    ['F1', 'COCKPITVIEW'], ['F2', 'OUTSIDEPLAYERVIEW'], ['F3', 'COMPUTERAIRPLANEVIEW'],
    ['F4', 'WEAPONVIEW'], ['F5', 'CHANGEAIRPLANE'], ['F6', 'ILSVIEW'],
    ['F7', 'OUTSIDEPLAYERVIEW2'], ['F8', 'CONTROLTOWERVIEW'], ['F9', 'SWITCHVIEWTARGET'],
    ['U', 'LOOKFORWARD'], ['K', 'LOOKRIGHT'], ['H', 'LOOKLEFT'],
    ['M', 'LOOKBACK'], ['J', 'LOOKUP'], ['N', 'LOOKDOWN'],
    ['DOT', 'REVERSETHRUST'], ['W', 'PROPFORWARD'], ['S', 'PROPBACKWARD'],
    ['R', 'FLAPUP'], ['F', 'FLAPDOWN'], ['O', 'OPENSUBWINDOWMENU'],
    ['9', 'CHANGEHUDCOLOR'], ['PAUSEBREAK', 'PAUSESIMULATION'], ['F10', 'GHOSTVIEW'],
    ['L', 'OPENVORMENU'], ['7', 'ROTATEVORLEFT'], ['8', 'ROTATEVORRIGHT'],
    ['1', 'BOMBBAYDOOR'], ['CTRL', 'INFLIGHTCFG'], ['SEMICOLON', 'TOGGLEALLDOOR'],
    ['F12', 'INFLTMESSAGE'], ['WHEELUP', 'VIEWZOOM'], ['WHEELDOWN', 'VIEWMOOZ'],
    ['HOME', 'OPENSUPPLYDLG'],
  ];
  function defaultCtlAssign() {
    var lines = ['VER 20181124'];
    // SetDefault(0): joystick 0 axes/buttons + mouse turret axes.
    lines.push('AXS 0 0 AILERON', 'AXS 0 1 ELEVATOR', 'AXS 0 2 THROTTLE', 'AXS 0 3 RUDDER');
    lines.push('AXS M 0 TURRETHDG', 'AXS M 1 TURRETPCH');
    lines.push('TRG 0 0 FIREWEAPON', 'TRG 0 1 SELECTWEAPON', 'TRG 0 2 RADAR', 'TRG 0 3 DISPENSEFLARE');
    for (var i = 0; i < DEFAULT_KEYS.length; i++) {
      lines.push('KEY ' + DEFAULT_KEYS[i][0] + ' ' + DEFAULT_KEYS[i][1]);
    }
    lines.push('DZELV2 0.030', 'DZAIL2 0.030', 'DZRUD2 0.030', 'HATSW TRUE', 'END');
    return lines.join('\n') + '\n';
  }

  var isInt = function (v, lo, hi) {
    var n = Number(v);
    return isFinite(n) && n === Math.round(n) && n >= lo && n <= hi;
  };

  // Normalize an arbitrary object (e.g. from localStorage) to a clean model:
  //   { axes: [{dev 0-6, axis 0-5, func, rev}], btns: [{dev 0-6, btn 0-31,
  //     func}], dz: {elv, ail, rud} }  — invalid entries dropped, dead zones
  // clamped to 0..0.2, one binding per (dev,axis)/(dev,btn) (last wins).
  function normalize(raw) {
    var o = (raw && typeof raw === 'object') ? raw : {};
    var out = { axes: [], btns: [], dz: {} };
    var seen = {};
    var list = Array.isArray(o.axes) ? o.axes : [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i] || {};
      if (!isInt(a.dev, 0, 6) || !isInt(a.axis, 0, 5)) continue;
      if (AXIS_FUNCS.indexOf(a.func) === -1) continue;
      var k = 'a' + a.dev + '/' + a.axis;
      if (seen[k] !== undefined) out.axes.splice(seen[k], 1, null);
      seen[k] = out.axes.length;
      out.axes.push({ dev: Number(a.dev), axis: Number(a.axis), func: a.func, rev: !!a.rev });
    }
    out.axes = out.axes.filter(Boolean);
    list = Array.isArray(o.btns) ? o.btns : [];
    for (i = 0; i < list.length; i++) {
      var b = list[i] || {};
      if (!isInt(b.dev, 0, 6) || !isInt(b.btn, 0, 31)) continue;
      if (BUTTON_FUNCS.indexOf(b.func) === -1) continue;
      k = 'b' + b.dev + '/' + b.btn;
      if (seen[k] !== undefined) out.btns.splice(seen[k], 1, null);
      seen[k] = out.btns.length;
      out.btns.push({ dev: Number(b.dev), btn: Number(b.btn), func: b.func });
    }
    out.btns = out.btns.filter(Boolean);
    var dz = (o.dz && typeof o.dz === 'object') ? o.dz : {};
    ['elv', 'ail', 'rud'].forEach(function (kk) {
      var n = Number(dz[kk]);
      out.dz[kk] = isFinite(n) ? Math.min(0.2, Math.max(0, Math.round(n * 1000) / 1000)) : null;
    });
    return out;
  }

  function axisLine(a) {
    // Save writes a trailing token slot for REV; non-reversed lines simply
    // omit it (Load only honors the literal "REV").
    return 'AXS ' + a.dev + ' ' + a.axis + ' ' + a.func + (a.rev ? ' REV' : '');
  }
  function btnLine(b) {
    return 'TRG ' + b.dev + ' ' + b.btn + ' ' + b.func;
  }

  // Merge the web-owned model into an existing ctlassign.cfg.  The web owns:
  //   - every GAMEPAD line: AXS/TRG with an integer device 0-6 (mouse 'M'/7
  //     and KEY lines pass through verbatim)
  //   - the DZELV2/DZAIL2/DZRUD2 lines when the model sets them
  // Existing pad lines are REPLACED wholesale by the model's (a removed
  // binding must actually disappear, so this is not line-by-line rewriting:
  // old pad lines are dropped, the model's are inserted where the first pad
  // line was, or before END).  With NO existing file the merge target is the
  // synthesized engine default (defaultCtlAssign above) — the engine never
  // creates this file on its own, and a partial file would wipe the keyboard
  // (Load's CleanUp runs whenever the file opens).
  function mergeCtlAssign(existing, model) {
    if (existing == null || String(existing).length === 0) existing = defaultCtlAssign();
    model = normalize(model);
    var lines = String(existing).split('\n');
    var out = [];
    var inserted = false;
    var webLines = model.axes.map(axisLine).concat(model.btns.map(btnLine));
    var DZ_KEY = { DZELV2: 'elv', DZAIL2: 'ail', DZRUD2: 'rud' };
    var dzWritten = {};
    function missingDzLines() {
      var add = [];
      for (var key in DZ_KEY) {
        if (model.dz[DZ_KEY[key]] != null && !dzWritten[key]) {
          add.push(key + ' ' + model.dz[DZ_KEY[key]].toFixed(3));
          dzWritten[key] = true;
        }
      }
      return add;
    }
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim().split(/\s+/);
      var isPad = (t[0] === 'AXS' || t[0] === 'TRG') && /^[0-6]$/.test(t[1] || '');
      if (isPad) {
        if (!inserted) { out = out.concat(webLines); inserted = true; }
        continue; // old pad line dropped (replaced above)
      }
      if (DZ_KEY[t[0]] && model.dz[DZ_KEY[t[0]]] != null) {
        out.push(t[0] + ' ' + model.dz[DZ_KEY[t[0]]].toFixed(3));
        dzWritten[t[0]] = true;
        continue;
      }
      if (t[0] === 'END') {
        // Everything the file lacked goes in before END: the pad lines (a
        // default file has none once the engine had no stick at first boot)
        // and any dead-zone line not present yet.
        if (!inserted) { out = out.concat(webLines); inserted = true; }
        out = out.concat(missingDzLines());
      }
      out.push(lines[i]);
    }
    if (!inserted) out = out.concat(webLines);
    out = out.concat(missingDzLines());
    return out.join('\n');
  }

  return {
    AXIS_FUNCS: AXIS_FUNCS,
    BUTTON_FUNCS: BUTTON_FUNCS,
    gamepadPreset: gamepadPreset,
    normalize: normalize,
    defaultCtlAssign: defaultCtlAssign,
    mergeCtlAssign: mergeCtlAssign,
  };
})();
