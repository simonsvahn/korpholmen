const legacyScope = (scope, rootScope) => scope.startsWith(rootScope) && scope !== rootScope;

export async function registerKorpholmenServiceWorker({ sourceTree = false, rootPage = false, reloadOnUpdate = true } = {}) {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return null;
  const root = new URL(rootPage ? './' : sourceTree ? '../../' : '../', location.href);
  const rootScope = root.href;
  const scriptUrl = new URL('sw.js', root).href;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.filter(registration => legacyScope(registration.scope, rootScope)).map(registration => registration.unregister()));

  const hadController = Boolean(navigator.serviceWorker.controller);
  if (reloadOnUpdate && hadController) {
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    }, { once: true });
  }
  const registration = await navigator.serviceWorker.register(scriptUrl, { scope: rootScope, updateViaCache: 'none' });
  await registration.update();
  return registration;
}
