// Service Worker: lädt die App immer frisch vom Server (am Zwischenspeicher vorbei),
// nur ohne Netz kommt die gespeicherte Kopie. So kommen Updates sofort an.
const CACHE = 'pendel-v6';
const SHELL = ['./', 'index.html', 'app.js', 'style.css', 'icon.svg', 'apple-touch-icon.png', 'manifest.webmanifest'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request, { cache: 'no-store' }).then((r) => {
    const copy = r.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request)));
});
