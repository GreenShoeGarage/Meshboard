const CACHE = "meshboard-v0.6.1-static";
const CORE = [
  "./", "./index.html", "./styles.css", "./manifest.webmanifest",
  "./app/main.js", "./app/models.js", "./app/demo.js", "./app/storage.js",
  "./app/meshtastic-adapter.js", "./app/utils.js", "./app/node-intelligence.js",
  "./app/packet-lab.js", "./app/rf-telemetry.js"
];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE)));
  self.skipWaiting();
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(event.request, copy));
    return response;
  })));
});
