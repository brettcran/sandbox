const CACHE = 'turbosign-v1';
const PRECACHE = [
  '/', '/index.html',
  '/lib/app/app.mjs',
  '/lib/build/pdf.mjs',
  '/lib/build/pdf.worker.mjs',
  '/lib/vendor/pdf-lib.esm.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Cache-first for our app shell & modules
  if (PRECACHE.includes(url.pathname)) {
    event.respondWith(caches.match(event.request).then(r => r || fetch(event.request)));
    return;
  }
  // Network-first for everything else (fallback to cache)
  event.respondWith(
    fetch(event.request).then(response => {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copy));
      return response;
    }).catch(() => caches.match(event.request))
  );
});
