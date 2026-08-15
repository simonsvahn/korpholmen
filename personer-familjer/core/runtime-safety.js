const validDeviceId = value => typeof value === 'string' && value.length > 0;
const storageGet = (storage, key) => {
  try { return storage?.getItem?.(key) ?? null; } catch (_) { return null; }
};
const storageSet = (storage, key, value) => {
  try { storage?.setItem?.(key, value); } catch (_) { /* IndexedDB-markören är den beständiga sanningen. */ }
};

function randomDeviceId(prefix, crypto = globalThis.crypto) {
  const suffix = crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
  return `${prefix}${suffix}`;
}

export async function resolveDeviceId({ store, key, prefix, storage = globalThis.localStorage, crypto = globalThis.crypto } = {}) {
  if (!store?.getMeta || !store?.putMeta || !store?.getAllOps) throw new TypeError('resolveDeviceId kräver ett komplett lager');
  if (!key || !prefix) throw new TypeError('resolveDeviceId kräver nyckel och prefix');
  const markerKey = `device-identity:${key}`;
  const storedIdentity = await store.getMeta(markerKey);
  if (validDeviceId(storedIdentity)) {
    if (storageGet(storage, key) !== storedIdentity) storageSet(storage, key, storedIdentity);
    return storedIdentity;
  }

  const legacyIdentity = storageGet(storage, key);
  const operations = await store.getAllOps();
  const canReuseLegacy = validDeviceId(legacyIdentity) && operations.some(operation => operation.device_id === legacyIdentity);
  const identity = canReuseLegacy ? legacyIdentity : randomDeviceId(prefix, crypto);
  await store.putMeta(markerKey, identity);
  storageSet(storage, key, identity);
  return identity;
}

export function isOfflineError(error, { online = globalThis.navigator?.onLine } = {}) {
  if (online === false) return true;
  if (error?.name === 'NetworkError') return true;
  return /failed to fetch|fetch failed|load failed|networkerror|internetanslutning|network connection|the internet connection appears to be offline/i.test(String(error?.message || error || ''));
}

export async function requestPersistentStorage({ storage = globalThis.navigator?.storage } = {}) {
  if (!storage?.persist) return { supported: false, persisted: false };
  const alreadyPersisted = typeof storage.persisted === 'function' ? await storage.persisted().catch(() => false) : false;
  if (alreadyPersisted) return { supported: true, persisted: true, requested: false };
  const persisted = await storage.persist().catch(() => false);
  return { supported: true, persisted: Boolean(persisted), requested: true };
}

export function debounce(callback, waitMs = 120, { setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout } = {}) {
  if (typeof callback !== 'function') throw new TypeError('debounce kräver en funktion');
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new TypeError('debounce kräver en giltig väntetid');
  let timer = null;
  let latestArgs = [];
  let latestThis = null;
  const invoke = () => {
    timer = null;
    const result = callback.apply(latestThis, latestArgs);
    latestArgs = [];
    latestThis = null;
    return result;
  };
  function debounced(...args) {
    latestArgs = args;
    latestThis = this;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(invoke, waitMs);
  }
  debounced.cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    latestArgs = [];
    latestThis = null;
  };
  debounced.flush = () => timer === null ? undefined : (clearTimer(timer), invoke());
  return debounced;
}

export function createRevisionCache(getRevision) {
  if (typeof getRevision !== 'function') throw new TypeError('createRevisionCache kräver en revisionsläsare');
  let revision = Symbol('tom revision');
  const values = new Map();
  return (key, compute) => {
    const nextRevision = getRevision();
    if (nextRevision !== revision) {
      revision = nextRevision;
      values.clear();
    }
    if (!values.has(key)) {
      if (typeof compute !== 'function') throw new TypeError('Revisionscachen kräver en beräkning');
      values.set(key, compute());
    }
    return values.get(key);
  };
}
