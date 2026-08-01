const CACHE = 'korpholmen-matrikel-2026-08-01-10';
const SHELL = [
  './',
  './index.html',
  './styles.css?v=2026-08-01-10',
  './manifest.webmanifest',
  './icons/icon.svg',
  './src/app.js?v=2026-08-01-10',
  './src/landscape-model.js?v=2026-08-01-10',
  './src/config.js?v=2026-08-01-10',
  './src/data-layer.js?v=2026-08-01-10',
  './src/domain/canonical.js?v=2026-08-01-10',
  './src/domain/hlc.js?v=2026-08-01-10',
  './src/domain/materializer.js?v=2026-08-01-10',
  './src/domain/operations.js?v=2026-08-01-10',
  './src/domain/repository.js?v=2026-08-01-10',
  './src/domain/slakt-schema.js?v=2026-08-01-10',
  './src/storage/indexeddb.js?v=2026-08-01-10',
  './src/storage/memory.js?v=2026-08-01-10',
  './src/sync/batch.js?v=2026-08-01-10',
  './src/sync/dropbox-transport.js?v=2026-08-01-10',
  './src/sync/errors.js?v=2026-08-01-10',
  './src/sync/memory-transport.js?v=2026-08-01-10',
  './src/sync/oauth-flow.js?v=2026-08-01-10',
  './src/sync/oauth-pkce.js?v=2026-08-01-10',
  './src/sync/sync-engine.js?v=2026-08-01-10'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('korpholmen-matrikel-') && key !== CACHE).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.includes('/privat/')) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
    return response;
  }).catch(() => caches.match(event.request)));
});
