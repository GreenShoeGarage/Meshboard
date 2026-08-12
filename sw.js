const CACHE = "meshboard-v0.6.8";
const CORE = [
  "./styles-v0.6.8.css?v=0.6.8", "./manifest.webmanifest?v=0.6.8",
  "./app-v0.6.8/main.js", "./app-v0.6.8/models.js", "./app-v0.6.8/demo.js", "./app-v0.6.8/storage.js",
  "./app-v0.6.8/meshtastic-adapter.js", "./app-v0.6.8/utils.js", "./app-v0.6.8/node-intelligence.js",
  "./app-v0.6.8/packet-lab.js", "./app-v0.6.8/rf-telemetry.js",
  "./vendor-v0.6.8/meshtastic-runtime.js", "./vendor-v0.6.8/dist-xiYX3mxm.js"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("meshboard-v") && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request, { cache: "no-store" });
      if (response && response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, copy));
      }
      return response;
    } catch (error) {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      throw error;
    }
  })());
});
