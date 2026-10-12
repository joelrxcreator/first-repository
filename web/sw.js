// Service Worker: lädt die App immer frisch vom Server (am Zwischenspeicher vorbei),
// nur ohne Netz kommt die gespeicherte Kopie. Zeigt außerdem Push-Nachrichten an.
const CACHE = 'pendel-v11';
const SHELL = ['./', 'index.html', 'app.js', 'icons.js', 'style.css', 'icon.svg', 'apple-touch-icon.png', 'manifest.webmanifest', 'vendor/supabase.js'];
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

// Push-Nachricht vom Server anzeigen
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Pendelpilot', body: e.data?.text() || '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Pendelpilot', {
    body: d.body || '', icon: 'apple-touch-icon.png', badge: 'icon-192.png', tag: d.tag || undefined, renotify: !!d.tag, data: { url: d.url || './' },
  }));
});
// Antippen öffnet die App (oder holt sie nach vorn)
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow(e.notification.data?.url || './');
  }));
});
