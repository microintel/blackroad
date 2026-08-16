/* BlackRoad — minimal service worker
   Its only job is to satisfy PWA installability requirements
   (Chrome/Edge require a registered service worker before the
   "Install app" / beforeinstallprompt flow becomes available).
   It intentionally does no caching, so the app always loads the
   latest deployed files over the network. */

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Pass-through network fetch — no offline cache.
  event.respondWith(fetch(event.request).catch(() => new Response('', { status: 504 })));
});
