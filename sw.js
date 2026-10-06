// Service worker: keeps a copy of the app on the device so it opens without internet.
// Bump VERSION whenever you change any app file, so devices pick up the new copy.
const VERSION = "parlour-v3.0.1";
const SDK = "https://www.gstatic.com/firebasejs/12.19.0/";

const SHELL = [
  "./", "./index.html", "./manifest.webmanifest",
  "./css/styles.css",
  "./js/app.js", "./js/firebase.js", "./js/seed.js", "./js/util.js", "./js/receipt.js", "./js/backup.js",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png"
];
const SDK_FILES = ["firebase-app.js", "firebase-auth.js", "firebase-firestore.js"].map((f) => SDK + f);

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL);
    try { await cache.addAll(SDK_FILES); } catch (e) { /* fetched on first use instead */ }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Firebase library files never change for a given version: cache first.
  if (url.href.startsWith(SDK)) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok) (await caches.open(VERSION)).put(req, res.clone());
      return res;
    })());
    return;
  }

  // App files: answer from the device copy straight away, refresh it in the background.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const isPage = req.mode === "navigate";
      const cached = await cache.match(isPage ? "./index.html" : req, { ignoreSearch: true });
      const network = fetch(req).then((res) => {
        if (res.ok && !isPage) cache.put(req, res.clone());
        if (res.ok && isPage) cache.put("./index.html", res.clone());
        return res;
      }).catch(() => null);
      if (cached) { event.waitUntil(network); return cached; }
      return (await network) || new Response("Offline and not cached yet.", { status: 503 });
    })());
  }
  // Everything else (Firebase database and login traffic) goes straight to the network.
});
