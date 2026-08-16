/* ══════════════════════════════════════════════════════
   sw.js — StepUP Service Worker
   Strategy:
     • App shell (local files + CDN) → Cache First
     • Everything else               → Network First, cache fallback
   Bump CACHE_VER when you deploy new code to force update.
══════════════════════════════════════════════════════ */

const CACHE_VER  = 'stepup-v3';
const CDN_CACHE  = 'stepup-cdn-v3';

/* All local app files */
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './db.js',
  './calc.js',
  './charts.js',
  './render.js',
  './helpers.js',
  './manifest.json',
  './icon512_maskable.png',
  './icon512_rounded.png',
];

/* External CDN assets — cached separately so a cache-ver bump
   doesn't force re-download of large unchanged CDN files       */
const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/chartjs-plugin-zoom@2.0.1/dist/chartjs-plugin-zoom.min.js',
  'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css',
  'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/fonts/bootstrap-icons.woff2',
  'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/fonts/bootstrap-icons.woff',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap',
];

/* ── Install: pre-cache app shell & CDN assets ───────────────── */
self.addEventListener('install', event => {
  event.waitUntil(
    Promise.all([
      caches.open(CACHE_VER).then(cache =>
        cache.addAll(APP_SHELL).catch(err =>
          console.warn('[SW] App shell cache partial failure:', err)
        )
      ),
      caches.open(CDN_CACHE).then(cache =>
        Promise.allSettled(
          CDN_ASSETS.map(url =>
            cache.add(url).catch(err =>
              console.warn('[SW] CDN cache miss:', url, err)
            )
          )
        )
      ),
    ]).then(() => self.skipWaiting())
  );
});

/* ── Activate: delete old caches ────────────────────────────── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_VER && k !== CDN_CACHE)
          .map(k => {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim())
  );
});

/* ── Fetch: serve from cache, fall back to network ───────────── */
self.addEventListener('fetch', event => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // ── Google Fonts CSS & web fonts: cache-first ──────────────
  if (
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  ) {
    event.respondWith(cacheFirst(request, CDN_CACHE));
    return;
  }

  // ── jsDelivr CDN assets: cache-first ───────────────────────
  if (url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(cacheFirst(request, CDN_CACHE));
    return;
  }

  // ── App shell (same origin): cache-first ───────────────────
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request, CACHE_VER));
    return;
  }

  // ── Everything else: network-first with cache fallback ─────
  event.respondWith(networkFirst(request, CACHE_VER));
});

/* ── Strategies ─────────────────────────────────────────────── */

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Offline and not in cache — return a friendly offline page
    // for navigation requests, or an empty 503 for assets
    if (request.mode === 'navigate') {
      const fallback = await caches.match('./index.html');
      return fallback || new Response('Offline', { status: 503 });
    }
    return new Response('', { status: 503 });
  }
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('', { status: 503 });
  }
}

/* ── Message: force update from app ─────────────────────────── */
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
