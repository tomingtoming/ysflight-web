// Service worker for ysflight-web: offline play + instant reload.
// __BUILD_ID__ and __PRECACHE__ are substituted by scripts/build.sh.
var BUILD_ID = '__BUILD_ID__';
var PRECACHE = __PRECACHE__;
var CACHE_NAME = 'ysflight-web-' + BUILD_ID;

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE_NAME) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  if (e.request.mode === 'navigate') {
    // HTML: network first so a new deploy is picked up, cache as fallback.
    e.respondWith(
      fetch(e.request).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE_NAME).then(function (c) { c.put(e.request, copy); });
        return res;
      }).catch(function () {
        return caches.match(e.request).then(function (hit) {
          return hit || caches.match('./');
        });
      })
    );
    return;
  }

  // Only the content-hashed engine assets (ysflight32_gl2.<hash>.{js,wasm,data}) are
  // truly immutable -> cache first (fast, offline).  Everything else is a FIXED-name
  // shell file (packs-ui.js, opfs-store.js, pack-net.js, sw.js, icons...) that changes
  // WITHOUT a new filename, so cache-first would pin a stale copy across deploys --
  // the root cause of repeated "my JS fix didn't take" bugs.  Serve those network-first
  // with a cache fallback for offline.
  if (/ysflight32_gl2\.[0-9a-f]{8}\.(js|wasm|data)$/.test(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then(function (hit) {
        if (hit) return hit;
        return fetch(e.request).then(function (res) {
          if (res.ok) { var copy = res.clone(); caches.open(CACHE_NAME).then(function (c) { c.put(e.request, copy); }); }
          return res;
        });
      })
    );
  } else {
    e.respondWith(
      fetch(e.request).then(function (res) {
        if (res.ok) { var copy = res.clone(); caches.open(CACHE_NAME).then(function (c) { c.put(e.request, copy); }); }
        return res;
      }).catch(function () { return caches.match(e.request); })
    );
  }
});
