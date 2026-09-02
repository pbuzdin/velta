// sw.js — Delta Web service worker (app-shell cache)
const CACHE = "velta-v49";
const ASSETS = [
  "./",
  "./index.html", "./diag.html",
  "./css/main.css",
  "./js/app.js",
  "./js/chat-view.js",
  "./js/components.js",
  "./js/diagnostics.js",
  "./js/mock-core.js",
  "./js/rpc-core.js",
  "./js/transport.js",
  "./js/ui.js",
  "./vendor/elena.js",
  "./vendor/virtual-scroller.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => {
      return hit || fetch(e.request).then(res => {
        if (res.ok && new URL(e.request.url).origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match("./index.html"));
    })
  );
});
