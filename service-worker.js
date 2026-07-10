/* App-shell cache so the PWA opens offline. The prescription (today.json) is NOT
 * cached here — app.js keeps the last good copy in localStorage and always tries
 * the network first for fresh data. Bump CACHE when shell files change. */
const CACHE = "mtl-shell-v4";
const SHELL = [
  "./", "./index.html", "./app.js", "./styles.css",
  "./manifest.webmanifest", "./icon.svg", "./icon-maskable.svg",
  "./icon-192.png", "./icon-512.png",
  "./icon-maskable-192.png", "./icon-maskable-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // Never intercept GitHub API calls — those must hit the network.
  if (url.hostname === "api.github.com") return;
  if (e.request.method !== "GET") return;
  // Cache-first for the app shell; fall back to network otherwise.
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
});
