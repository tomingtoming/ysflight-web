// Settings core — merge web-owned options (toggles + numerics) into the
// engine's flight.cfg.
//
// The engine reads its options from flight.cfg (FsFlightConfig::Load,
// fsconfig.cpp): one "KEY value" line per option.  The web-shell direction
// (docs/web-shell.md) replaces the engine's Option menu with a web Settings
// page; this module is the pure text merge that lets the page own a curated
// subset of those lines while leaving every other line (engine-written, or not
// yet exposed here) untouched.
//
// Classic script (globalThis.ysfwSettings), loaded before Module like
// deeplink.js/yfs.js; test/settings.test.mjs imports it for the side effect.
globalThis.ysfwSettings = (function () {
  'use strict';

  // The options the web Settings page owns.  key: flight.cfg token; def: engine
  // default (so an untouched web Settings page reproduces engine behavior);
  // type: how the value is validated and written —
  //   bool    "KEY TRUE|FALSE"      (fsconfig.cpp FsTrueFalseString)
  //   length  "KEY <v>.00m" meters  (fsconfig.cpp "%.2lfm" / FsGetLength),
  //           clamped to [min,max]
  //   enum    "KEY <n>" integer     (fsconfig.cpp atoi), 0 <= n < count
  //   choice  "KEY <TOKEN>" string  (fsconfig.cpp keyword tables), token must
  //           be one of `values`
  var MANAGED = [
    { key: 'DRWSHADOW', type: 'bool', def: true },   // aircraft/ground shadows
    { key: 'DRAWCLOUD', type: 'bool', def: true },   // clouds
    { key: 'HRIZNGRAD', type: 'bool', def: true },   // horizon gradation (sky band)
    { key: 'ANTIALIAS', type: 'bool', def: false },  // OpenGL anti-aliasing
    { key: 'SMKPARTCL', type: 'bool', def: true },   // smoke as particles
    { key: 'SIMPLEHUD', type: 'bool', def: false },  // simplified HUD
    // Numeric/enum options (web-shell increment 7).  Bounds mirror the engine:
    // fog visibility FS_FOG_VISIBILITY_MIN..MAX (fsdef.h 800..20000, default
    // max); airplane LOD is the native "Airplane Graphics" drop list
    // (fsguiconfigdlg.cpp: 0 Automatic / 1 Always High Quality / 2 Always
    // Coarse, default 0).
    { key: 'VISIBILIT', type: 'length', def: 20000, min: 800, max: 20000 }, // fog visibility [m]
    { key: 'AIRLVODTL', type: 'enum', def: 0, count: 3 },                   // airplane LOD
    // Config detail, second batch (web-shell increment 9) — the rest of the
    // native Option dialog (fsguiconfigdlg.cpp).  Tokens/defaults mirror
    // fsconfig.cpp: SMOKETYPE table (dialog exposes TOWEL/SOLID/NULL),
    // CLOUDTYPE NONE/FLAT/SOLID, ZBUFFQUAL 0-3 (SetDefault 1); bool defaults
    // from FsFlightConfig::SetDefault.
    { key: 'SMOKETYPE', type: 'choice', def: 'SOLID', values: ['TOWEL', 'SOLID', 'NULL'] },
    { key: 'CLOUDTYPE', type: 'choice', def: 'SOLID', values: ['NONE', 'FLAT', 'SOLID'] },
    { key: 'ZBUFFQUAL', type: 'enum', def: 1, count: 4 },
    { key: 'HUDALWAYS', type: 'bool', def: false },  // HUD even in cockpit views
    { key: 'SHOWKIAS_', type: 'bool', def: true },   // airspeed as IAS
    { key: 'FRMPERSEC', type: 'bool', def: false },  // FPS counter
    { key: 'DRAWVJSTK', type: 'bool', def: true },   // on-screen virtual stick
    { key: 'GBLACKOUT', type: 'bool', def: true },   // G blackout/redout
    { key: 'MIDAIRCOL', type: 'bool', def: true },   // mid-air collision
    { key: 'NOTAILSTK', type: 'bool', def: true },   // tail strike protection
    { key: 'LANDANWHR', type: 'bool', def: true },   // land anywhere
  ];
  var MANAGED_KEYS = MANAGED.map(function (m) { return m.key; });
  var BY_KEY = {};
  MANAGED.forEach(function (m) { BY_KEY[m.key] = m; });

  // Write a validated value in the exact format FsFlightConfig::Save uses, so
  // a web-written line is byte-identical to an engine-written one.
  function fmtValue(m, v) {
    if (m.type === 'bool') return v ? 'TRUE' : 'FALSE';
    if (m.type === 'length') return v.toFixed(2) + 'm';
    return String(v);  // enum integer / choice token
  }

  // Merge the web-owned values into an existing flight.cfg.
  //   existing: current flight.cfg text (may be '' or null on first run)
  //   values:   { KEY: value } for any subset of MANAGED_KEYS (validated —
  //             pass through normalize() first; fmtValue assumes clean input)
  // Returns the new flight.cfg text.  Managed keys already present are rewritten
  // IN PLACE (order preserved); managed keys absent are appended; every
  // non-managed line is passed through verbatim.  Idempotent.
  function mergeFlightCfg(existing, values) {
    values = values || {};
    var text = (existing == null) ? '' : String(existing);
    var lines = text.length ? text.split('\n') : [];
    var written = {};

    var out = lines.map(function (line) {
      var key = line.split(/\s+/)[0];
      if (BY_KEY[key] && Object.prototype.hasOwnProperty.call(values, key)) {
        written[key] = true;
        return key + ' ' + fmtValue(BY_KEY[key], values[key]);
      }
      return line;
    });

    // Drop a single trailing empty element from a text that ended in '\n', so we
    // append cleanly and re-add exactly one terminating newline at the end.
    if (out.length && out[out.length - 1] === '') out.pop();

    MANAGED.forEach(function (m) {
      if (Object.prototype.hasOwnProperty.call(values, m.key) && !written[m.key]) {
        out.push(m.key + ' ' + fmtValue(m, values[m.key]));
      }
    });

    return out.length ? out.join('\n') + '\n' : '';
  }

  // Normalize an arbitrary object (e.g. from localStorage) to { KEY: value }
  // over just the managed keys, filling defaults for anything missing/invalid
  // and clamping numerics to their engine bounds.  Used by the page (to render)
  // and by index.html (to apply).
  function normalize(raw) {
    var o = (raw && typeof raw === 'object') ? raw : {};
    var out = {};
    MANAGED.forEach(function (m) {
      var v = o[m.key];
      if (m.type === 'bool') {
        out[m.key] = (typeof v === 'boolean') ? v : m.def;
      } else if (m.type === 'length') {
        var n = Number(v);
        out[m.key] = isFinite(n) ? Math.min(m.max, Math.max(m.min, Math.round(n))) : m.def;
      } else if (m.type === 'choice') {
        out[m.key] = (m.values.indexOf(v) !== -1) ? v : m.def;
      } else { // enum
        var e = Number(v);
        out[m.key] = (isFinite(e) && e === Math.round(e) && e >= 0 && e < m.count) ? e : m.def;
      }
    });
    return out;
  }

  return {
    MANAGED: MANAGED,
    MANAGED_KEYS: MANAGED_KEYS,
    mergeFlightCfg: mergeFlightCfg,
    normalize: normalize,
  };
})();
