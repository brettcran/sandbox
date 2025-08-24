// TurboSign SW v2 (relative paths; GH Pages friendly)
const CACHE = 'turbosign-v2';
const PRECACHE = [
  'index.html',
  'manifest.json',
  'lib/app/app.mjs',
  'lib/build/pdf.mjs',
  'lib/build/pdf.worker.mjs',
  'lib/vendor/pdf-lib.esm.js',
  'icon-192.png',
  'icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Cache-first for same-origin app shell / modules; network-first fallback
self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(resp => {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(request, copy));
          return resp;
        });
      })
    );
  }
});