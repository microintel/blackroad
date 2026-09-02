const CACHE_NAME = "blackroad-cache-v1";

const CACHE_FILES = [
  "./",
  "./index.html",
  "./blackroad-dashboard.html",
  "./manifest.json",

  "./favicon.ico",
  "./favicon-16x16.png",
  "./favicon-32x32.png",
  "./apple-touch-icon.png",
  "./icon-192.png",
  "./icon-512.png"
];


// INSTALL
self.addEventListener("install", event => {

  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CACHE_FILES))
  );

  self.skipWaiting();
});


// ACTIVATE
self.addEventListener("activate", event => {

  event.waitUntil(
    caches.keys().then(cacheNames => {

      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name));

    })
  );

  self.clients.claim();
});


// FETCH
self.addEventListener("fetch", event => {

  if (event.request.method !== "GET") {
    return;
  }

  event.respondWith(

    caches.match(event.request)
      .then(cachedResponse => {

        // Return cached version
        if (cachedResponse) {
          return cachedResponse;
        }

        // Otherwise get from network
        return fetch(event.request)
          .then(response => {

            if (
              response &&
              response.status === 200 &&
              response.type === "basic"
            ) {

              const clone = response.clone();

              caches.open(CACHE_NAME)
                .then(cache => {
                  cache.put(event.request, clone);
                });
            }

            return response;
          });

      })
  );
});