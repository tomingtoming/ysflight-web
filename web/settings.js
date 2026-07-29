// Settings core — merge web-owned option toggles into the engine's flight.cfg.
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

  // The options the web Settings page owns.  Each is a boolean flight.cfg key
  // written as "KEY TRUE|FALSE" (fsconfig.cpp uses FsTrueFalseString for these).
  // key: flight.cfg token; def: engine default (so "unset" matches the engine).
  var MANAGED = [
    { key: 'DRWSHADOW', def: true },   // aircraft/ground shadows
    { key: 'DRAWCLOUD', def: true },   // clouds
    { key: 'HRIZNGRAD', def: true },   // horizon gradation (sky band)
    { key: 'ANTIALIAS', def: false },  // OpenGL anti-aliasing
    { key: 'SMKPARTCL', def: true },   // smoke as particles
    { key: 'SIMPLEHUD', def: false },  // simplified HUD
  ];
  var MANAGED_KEYS = MANAGED.map(function (m) { return m.key; });

  function boolStr(v) { return v ? 'TRUE' : 'FALSE'; }

  // Merge the web-owned values into an existing flight.cfg.
  //   existing: current flight.cfg text (may be '' or null on first run)
  //   values:   { KEY: boolean } for any subset of MANAGED_KEYS
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
      if (MANAGED_KEYS.indexOf(key) !== -1 && Object.prototype.hasOwnProperty.call(values, key)) {
        written[key] = true;
        return key + ' ' + boolStr(values[key]);
      }
      return line;
    });

    // Drop a single trailing empty element from a text that ended in '\n', so we
    // append cleanly and re-add exactly one terminating newline at the end.
    if (out.length && out[out.length - 1] === '') out.pop();

    MANAGED.forEach(function (m) {
      if (Object.prototype.hasOwnProperty.call(values, m.key) && !written[m.key]) {
        out.push(m.key + ' ' + boolStr(values[m.key]));
      }
    });

    return out.length ? out.join('\n') + '\n' : '';
  }

  // Normalize an arbitrary object (e.g. from localStorage) to { KEY: bool } over
  // just the managed keys, filling defaults for anything missing/invalid.  Used
  // by the page (to render) and by index.html (to apply).
  function normalize(raw) {
    var o = (raw && typeof raw === 'object') ? raw : {};
    var out = {};
    MANAGED.forEach(function (m) {
      out[m.key] = (typeof o[m.key] === 'boolean') ? o[m.key] : m.def;
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
