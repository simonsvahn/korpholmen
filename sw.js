const RELEASE = '2026-08-07-korpholmen-pwa-33';
const CACHE_PREFIX = 'korpholmen-family-shell-';
const CACHE = `${CACHE_PREFIX}${RELEASE}`;
const LEGACY_PREFIXES = ['slaktlandskap-shell-', 'korpholmen-matrikel-', 'korpholmen-batregister-', 'korpholmen-fastigheter-', 'korpholmen-dokumentarkiv-', 'korpholmen-runt-', 'kbk-klubbhistorik-', 'korpholmen-kartdata-'];
const FALLBACK_SHELL = ['./', './index.html', `./styles.css?v=${RELEASE}`, `./app-switcher.css?v=${RELEASE}`, './manifest.webmanifest', './icons/korpholmen.svg', './icons/korpholmen-180.png', './icons/korpholmen-192.png', './icons/korpholmen-512.png', `./src/app.js?v=${RELEASE}`, './src/config.js', './release-manifest.json'];

async function shellRequests() {
  try {
    const response = await fetch('./release-manifest.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(String(response.status));
    const manifest = await response.json();
    return [...new Set([...FALLBACK_SHELL, ...(manifest.shell_files || [])])].map(path => new Request(new URL(path, self.location.href), { cache: 'reload' }));
  } catch (_) {
    return FALLBACK_SHELL.map(path => new Request(new URL(path, self.location.href), { cache: 'reload' }));
  }
}

async function precache(requests) {
  const cache = await caches.open(CACHE);
  const criticalUrls = new Set(FALLBACK_SHELL.map(path => new URL(path, self.location.href).href));
  const results = await Promise.allSettled(requests.map(async request => {
    const response = await fetch(request);
    if (!response.ok) throw new Error(`${response.status} ${request.url}`);
    await cache.put(request, response);
  }));
  const failed = results.map((result, index) => ({ result, request: requests[index] })).filter(entry => entry.result.status === 'rejected');
  const criticalFailure = failed.find(entry => criticalUrls.has(entry.request.url));
  if (criticalFailure) throw criticalFailure.result.reason;
}

async function navigationFallback(request) {
  const exact = await caches.match(request, { ignoreSearch: true });
  if (exact) return exact;
  const scope = new URL(self.registration.scope);
  const url = new URL(request.url);
  const relative = url.pathname.slice(scope.pathname.length).replace(/^\/+/, '');
  const app = relative.split('/')[0];
  if (app) {
    const appIndex = await caches.match(`./${app}/index.html`, { ignoreSearch: true });
    if (appIndex) return appIndex;
  }
  return caches.match('./index.html', { ignoreSearch: true });
}

self.addEventListener('install', event => {
  event.waitUntil(shellRequests().then(precache).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => (key.startsWith(CACHE_PREFIX) && key !== CACHE) || LEGACY_PREFIXES.some(prefix => key.startsWith(prefix))).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.includes('/privat/') || url.pathname.includes('/apps/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request, { cache: 'no-store' }).then(response => {
      const containsOAuthResponse = ['code', 'state', 'error'].some(key => url.searchParams.has(key));
      if (response.ok && !containsOAuthResponse) caches.open(CACHE).then(cache => cache.put(request, response.clone()));
      return response;
    }).catch(() => navigationFallback(request)));
    return;
  }
  event.respondWith(caches.match(request, { ignoreSearch: true }).then(cached => {
    const network = fetch(request, { cache: 'no-store' }).then(response => {
      if (response.ok) caches.open(CACHE).then(cache => cache.put(request, response.clone()));
      return response;
    }).catch(() => cached || Response.error());
    return cached || network;
  }));
});
