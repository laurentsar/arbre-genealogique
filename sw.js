/* sw.js — cache le shell de l'application pour un usage hors-ligne complet.
 * Toutes les données (personnes, unions) restent en localStorage sur l'appareil. */
const CACHE = 'genealogie-1.4.40';
const SHELL = [
  'index.html', 'styles.css',
  'store.js', 'gedcom.js', 'wikitree.js', 'tree.js', 'app.js',
  'manifest.webmanifest', 'img/icon-192.png', 'img/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(scope)) return;
  const path = url.pathname.slice(scope.length) || 'index.html';
  if (!SHELL.includes(path)) return;
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
