// Bump this on every change to any precached file.
const CACHE_VERSION = 'kits-v5';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/db.js',
  './js/images.js',
  './js/store.js',
  './js/router.js',
  './js/supabase.js',
  './js/sync.js',
  './js/charts.js',
  './js/combobox.js',
  './js/views/collection.js',
  './js/views/detail.js',
  './js/views/form.js',
  './js/views/stats.js',
  './js/views/data.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      // `cache: 'reload'` is essential: a plain addAll() is allowed to satisfy
      // itself from the browser's HTTP cache, which happily hands back the very
      // files this new version exists to replace. Without it, bumping
      // CACHE_VERSION can re-cache the old app under the new name.
      .then((c) => c.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// All data lives in IndexedDB, so the only thing to serve is the app shell.
// Cache-first, falling back to the network for anything not precached.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // Supabase reads must always hit the network — a cached API response would
  // quietly hand back a stale collection.
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).catch(() => {
        // A navigation that misses the cache still gets the shell, so the app
        // opens offline no matter which URL it was launched from.
        if (e.request.mode === 'navigate') return caches.match('./index.html');
        throw new Error('offline and uncached');
      });
    })
  );
});
