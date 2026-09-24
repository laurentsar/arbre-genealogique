/* sw.js — cache le shell de l'application pour un usage hors-ligne complet.
 * Toutes les données (personnes, unions) restent sur l'appareil.
 *
 * Mise à jour : une nouvelle version s'installe en arrière-plan puis ATTEND
 * (pas de skipWaiting automatique) ; l'app affiche un bandeau « Nouvelle
 * version — Recharger » et n'active la nouvelle version qu'à la demande
 * (message SKIP_WAITING), pour ne jamais changer le code sous les pieds
 * d'une page ouverte. */
const CACHE = 'genealogie-1.6.0';
// Doit rester aligné sur la liste des <script> d'index.html et sur les
// assets de scripts/build-www.mjs (vérifié par tests/shell.test.mjs).
const SHELL = [
  'index.html', 'styles.css',
  'util.js', 'store.js', 'gedcom.js', 'wikitree.js', 'insee.js', 'tree.js', 'fanchart.js',
  'app.js', 'online.js', 'backend.js',
  'manifest.webmanifest', 'img/icon-192.png', 'img/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
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
  // Recherche par chemin canonique : l'URL racine (« …/arbre-genealogique/ »)
  // est servie par index.html en cache — l'app démarre donc aussi hors-ligne
  // quand elle est ouverte sans « index.html » dans l'adresse.
  const cached = new URL(path, self.registration.scope).href;
  e.respondWith(caches.match(cached).then(r => r || fetch(e.request)));
});
