const CACHE = 'korpholmen-matrikel-2026-08-02-3';
const FAMILY_CORE = self.location.pathname.includes('/apps/matrikel/')
  ? '../../packages/core/family-context.js'
  : './core/family-context.js';
const SHELL = [
  './',
  './index.html',
  './styles.css?v=2026-08-02-1',
  './manifest.webmanifest',
  './icons/icon.svg',
  './src/app.js?v=2026-08-02-3',
  FAMILY_CORE,
  './src/landscape-model.js?v=2026-08-01-12',
  './src/config.js?v=2026-08-01-10',
  './src/data-layer.js?v=2026-08-02-3',
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
  const freshShell = SHELL.map(path => new Request(new URL(path, self.location.href), { cache: 'reload' }));
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(freshShell)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('korpholmen-matrikel-') && key !== CACHE).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.includes('/privat/')) return;
  const isNavigation = event.request.mode === 'navigate';
  const cacheKey = isNavigation ? './index.html' : event.request;
  event.respondWith(caches.match(cacheKey).then(cached => {
    const network = fetch(event.request, { cache: 'no-store' }).then(response => {
      if (response.ok) caches.open(CACHE).then(cache => cache.put(cacheKey, response.clone()));
      return response;
    }).catch(() => cached || Response.error());
    return cached || network;
  }));
});
