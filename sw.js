const CACHE = 'slaktlandskap-shell-2026-08-01-3';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './icons/icon.svg',
  './src/app.js',
  './src/config.js',
  './src/data-layer.js',
  './src/domain/canonical.js',
  './src/domain/hlc.js',
  './src/domain/materializer.js',
  './src/domain/operations.js',
  './src/domain/repository.js',
  './src/domain/slakt-schema.js',
  './src/storage/indexeddb.js',
  './src/storage/memory.js',
  './src/sync/batch.js',
  './src/sync/dropbox-transport.js',
  './src/sync/errors.js',
  './src/sync/memory-transport.js',
  './src/sync/oauth-flow.js',
  './src/sync/oauth-pkce.js',
  './src/sync/sync-engine.js'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))));
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
