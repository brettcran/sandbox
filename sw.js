/* TurboSign SW — offline for app shell + CDN ESM modules + optional remote PDFs
   Strategy:
   - App shell: Cache-First
   - CDN JS (pdf.js worker/core, pdf-lib): Stale-While-Revalidate
   - Remote PDFs: Cache-First (limit size via header check)
*/

const VERSION = 'ts-4.0.1';
const SHELL_CACHE = `ts-shell-${VERSION}`;
const CDN_CACHE   = `ts-cdn-${VERSION}`;
const PDF_CACHE   = `ts-pdf-${VERSION}`;

const APP_SHELL = [
  '/',                    // GH Pages: root (will be 404.html on subpaths; ok for SPA)
  '/index.html',
  '/lib/app/app.mjs',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// CDN allowlist (CORS-enabled, cacheable)
const CDN_HOSTS = new Set([
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cdn.skypack.dev'
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(k => ![SHELL_CACHE, CDN_CACHE, PDF_CACHE].includes(k))
        .map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// Helpers
const isCDNRequest = (req) => {
  try { return CDN_HOSTS.has(new URL(req.url).host); } catch { return false; }
};
const isNavigation = (req) => req.mode === 'navigate' || (req.destination === 'document');

// Cache-first for shell (same-origin)
async function handleShell(req) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(req, { ignoreVary: true });
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    // Offline fallback: index.html for navigations
    if (isNavigation(req)) {
      const fallback = await cache.match('/index.html');
      if (fallback) return fallback;
    }
    throw new Error('Shell fetch failed');
  }
}

// SWR for CDN modules
async function handleCDN(req) {
  const cache = await caches.open(CDN_CACHE);
  const cached = await cache.match(req, { ignoreVary: true });
  const fetchAndUpdate = fetch(req).then(res => {
    // Only cache successful, CORS-OK JS resources
    const ct = res.headers.get('content-type') || '';
    if (res.ok && (ct.includes('javascript') || ct.includes('text/plain') || ct.includes('application/octet-stream'))) {
      cache.put(req, res.clone());
    }
    return res;
  }).catch(() => null);

  // Return cached immediately if present, update in background
  if (cached) { fetchAndUpdate; return cached; }
  // Else fetch network, fallback to nothing
  const fresh = await fetchAndUpdate;
  if (fresh) return fresh;
  // Last resort: try any previous cached item
  if (cached) return cached;
  return new Response('Offline and not cached', { status: 503 });
}

// Cache-first for remote PDFs (when opened by URL)
async function handlePDF(req) {
  const cache = await caches.open(PDF_CACHE);
  const cached = await cache.match(req, { ignoreVary: true });
  if (cached) return cached;
  try {
    const res = await fetch(req, { mode: 'cors' });
    // Guard: avoid caching huge blobs (e.g., > 25MB)
    const len = parseInt(res.headers.get('content-length') || '0', 10);
    if (res.ok && (len === 0 || len < 25 * 1024 * 1024)) {
      cache.put(req, res.clone());
    }
    return res;
  } catch {
    if (cached) return cached;
    return new Response('PDF unavailable offline', { status: 503 });
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Same-origin app shell (HTML, JS, CSS, icons)
  if (url.origin === location.origin) {
    event.respondWith(handleShell(req));
    return;
  }

  // CDN modules (pdf.js core/worker, pdf-lib)
  if (isCDNRequest(req)) {
    event.respondWith(handleCDN(req));
    return;
  }

  // Remote PDFs (if user opens a URL to a PDF)
  if (req.destination === 'document' || req.destination === 'embed' || req.destination === 'object') {
    if (url.pathname.endsWith('.pdf')) {
      event.respondWith(handlePDF(req));
      return;
    }
  }

  // Default: network, fallback to cache
  event.respondWith((async () => {
    try { return await fetch(req); }
    catch {
      const match = await caches.match(req, { ignoreVary: true });
      return match || new Response('Offline', { status: 503 });
    }
  })());
});