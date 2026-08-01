const OLD_CACHE_PREFIX='slaktlandskap-shell-';
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith(OLD_CACHE_PREFIX)).map(key=>caches.delete(key)))).then(()=>self.registration.unregister()));self.clients.claim()});
