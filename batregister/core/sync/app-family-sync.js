import { Repository } from '../domain/repository.js';
import { resolveDeviceId } from '../runtime-safety.js';
import { IndexedDBStore, openSlaktlandskapDB } from '../storage/indexeddb.js';
import { DropboxTransport } from './dropbox-transport.js';
import { SyncEngine } from './sync-engine.js';
import { KorpholmenSharedStore, sharedDropboxDisconnectedKey, sharedDropboxTokenKey } from './shared-dropbox-session.js';

export const KORPHOLMEN_APPS = Object.freeze([
  { id: 'matrikel', label: 'Matrikel', database: 'slaktlandskap', deviceKey: 'slaktlandskap:device-id', devicePrefix: 'slakt-web-', transportId: 'dropbox-matrikel-v2', opsRoot: '/matrikel/ops' },
  { id: 'batregister', label: 'Båtregister', database: 'korpholmen-batregister', deviceKey: 'korpholmen:batregister-device-id', devicePrefix: 'bat-web-', transportId: 'dropbox-batregister', opsRoot: '/batregister/ops' },
  { id: 'fastigheter', label: 'Fastigheter', database: 'korpholmen-fastigheter', deviceKey: 'korpholmen:fastigheter-device-id', devicePrefix: 'fastigheter-web-', transportId: 'dropbox-fastigheter', opsRoot: '/fastigheter/ops' },
  { id: 'dokumentarkiv', label: 'Dokumentarkiv', database: 'korpholmen-dokumentarkiv', deviceKey: 'korpholmen:dokumentarkiv-device-id', devicePrefix: 'dokumentarkiv-web-', transportId: 'dropbox-dokumentarkiv', opsRoot: '/dokumentarkiv/ops' },
  { id: 'korpholmenrunt', label: 'Korpholmen runt', database: 'korpholmen-runt', deviceKey: 'korpholmen:runt-device-id', devicePrefix: 'runt-web-', transportId: 'dropbox-korpholmenrunt', opsRoot: '/korpholmenrunt/ops' },
  { id: 'klubbhistorik', label: 'Klubbhistorik', database: 'kbk-klubbhistorik', deviceKey: 'korpholmen:klubbhistorik-device-id', devicePrefix: 'klubbhistorik-web-', transportId: 'dropbox-klubbhistorik', opsRoot: '/klubbhistorik/ops' },
  { id: 'kartdata', label: 'Kartdata', database: 'korpholmen-kartdata-v2', deviceKey: 'korpholmen:kartdata-device-id', devicePrefix: 'kartdata-web-', transportId: 'dropbox-kartdata', opsRoot: '/kartdata/ops' },
]);

const FAMILY_SYNC_KEY = 'family-sync:last-completed-at';
const statusKey = id => `family-sync:status:${id}`;
let scheduledPromise = null;

const legacyTokenKeys = app => app.id === 'matrikel' ? ['dropbox:refresh-token-v1', 'dropbox:refresh-token'] : ['dropbox:refresh-token'];

const deviceIdFor = (app, store) => resolveDeviceId({ store, key: app.deviceKey, prefix: app.devicePrefix });

const withOriginLock = async (name, action) => {
  if (globalThis.navigator?.locks?.request) return navigator.locks.request(name, action);
  return action();
};

async function pullApp({ app, accessToken, sharedStore, onProgress }) {
  const startedAt = new Date().toISOString();
  await sharedStore.put(statusKey(app.id), { state: 'syncing', started_at: startedAt });
  onProgress?.({ app, state: 'syncing' });
  let database;
  try {
    database = await openSlaktlandskapDB({ name: app.database });
    const store = new IndexedDBStore(database);
    const repository = await new Repository({ store, deviceId: await deviceIdFor(app, store) }).init();
    const transport = new DropboxTransport({ accessToken, id: app.transportId, opsRoot: app.opsRoot, readOnly: true });
    const result = await new SyncEngine({ repository, transport }).downloadRemote();
    const status = { state: 'ok', synced_at: new Date().toISOString(), downloaded_ops: result.downloadedOps, downloaded_batches: result.downloadedBatches };
    await sharedStore.put(statusKey(app.id), status);
    onProgress?.({ app, ...status });
    return { app: app.id, ...status };
  } catch (error) {
    const status = { state: 'error', failed_at: new Date().toISOString(), message: error.message };
    await sharedStore.put(statusKey(app.id), status);
    onProgress?.({ app, ...status });
    return { app: app.id, ...status };
  } finally {
    database?.close();
  }
}

export async function getAppFamilySyncStatuses({ sharedStore = new KorpholmenSharedStore() } = {}) {
  return Object.fromEntries(await Promise.all(KORPHOLMEN_APPS.map(async app => [app.id, await sharedStore.get(statusKey(app.id))])));
}

export async function migrateLegacyCredentialsToShared({ sharedStore = new KorpholmenSharedStore() } = {}) {
  return withOriginLock('korpholmen-dropbox-session', async () => {
    if (await sharedStore.get(sharedDropboxDisconnectedKey)) return false;
    if (await sharedStore.get(sharedDropboxTokenKey)) return false;
    for (const app of KORPHOLMEN_APPS) {
      const database = await openSlaktlandskapDB({ name: app.database });
      try {
        const store = new IndexedDBStore(database);
        for (const key of legacyTokenKeys(app)) {
          const refreshToken = await store.getMeta(key);
          if (!refreshToken) continue;
          await sharedStore.put(sharedDropboxTokenKey, refreshToken);
          return true;
        }
      } finally {
        database.close();
      }
    }
    return false;
  });
}

export async function mirrorSharedDropboxCredential({ refreshToken, sharedStore = new KorpholmenSharedStore() } = {}) {
  return withOriginLock('korpholmen-dropbox-session', async () => {
    if (await sharedStore.get(sharedDropboxDisconnectedKey)) return false;
    const token = refreshToken || await sharedStore.get(sharedDropboxTokenKey);
    if (!token) return false;
    for (const app of KORPHOLMEN_APPS) {
      const database = await openSlaktlandskapDB({ name: app.database });
      try {
        const store = new IndexedDBStore(database);
        await Promise.all(legacyTokenKeys(app).map(key => store.putMeta(key, token)));
      } finally {
        database.close();
      }
    }
    return true;
  });
}

const defaultStoreFactory = async app => {
  const database = await openSlaktlandskapDB({ name: app.database });
  return { store: new IndexedDBStore(database), close: () => database.close() };
};

async function clearLegacyCredentialStores(storeFactory) {
  const failures = [];
  let cleared = 0;
  for (const app of KORPHOLMEN_APPS) {
    let handle;
    try {
      handle = await storeFactory(app);
      for (const key of legacyTokenKeys(app)) await handle.store.deleteMeta(key);
      cleared += 1;
    } catch (error) {
      failures.push({ app: app.id, message: error.message });
    } finally {
      handle?.close?.();
    }
  }
  return { cleared, failures };
}

export async function clearLegacyDropboxCredentials({ storeFactory = defaultStoreFactory } = {}) {
  return withOriginLock('korpholmen-dropbox-session', () => clearLegacyCredentialStores(storeFactory));
}

export async function disconnectDropboxEverywhere({ session, revokeAccessToken, storeFactory = defaultStoreFactory } = {}) {
  if (!session?.disconnect || !session?.getAccessToken) throw new TypeError('disconnectDropboxEverywhere kräver en delad session');
  return withOriginLock('korpholmen-dropbox-session', async () => {
    let revoked = false;
    let revokeError = null;
    try {
      const accessToken = await session.getAccessToken({ online: globalThis.navigator?.onLine !== false });
      if (accessToken && typeof revokeAccessToken === 'function') {
        await revokeAccessToken({ accessToken });
        revoked = true;
      }
    } catch (error) {
      revokeError = error;
    }
    await session.disconnect();
    const legacy = await clearLegacyCredentialStores(storeFactory);
    return { revoked, revokeError, ...legacy };
  });
}

export async function syncAppFamily({ accessToken, skipApp = null, force = false, maxAgeMs = 10 * 60_000, concurrency = 2, sharedStore = new KorpholmenSharedStore(), onProgress } = {}) {
  if (!accessToken) throw new TypeError('Totalsynk kräver Dropbox access token');
  if (globalThis.navigator?.onLine === false) return { skipped: true, reason: 'offline', results: [] };
  const lastCompleted = await sharedStore.get(FAMILY_SYNC_KEY);
  if (!force && lastCompleted && Date.now() - Date.parse(lastCompleted) < maxAgeMs) return { skipped: true, reason: 'fresh', results: [] };
  const apps = KORPHOLMEN_APPS.filter(app => app.id !== skipApp);
  const results = new Array(apps.length);
  let next = 0;
  await withOriginLock('korpholmen-family-sync', async () => {
    const workers = Array.from({ length: Math.min(Math.max(1, concurrency), apps.length) }, async () => {
      while (next < apps.length) {
        const index = next++;
        results[index] = await pullApp({ app: apps[index], accessToken, sharedStore, onProgress });
      }
    });
    await Promise.all(workers);
    if (results.every(result => result.state === 'ok')) await sharedStore.put(FAMILY_SYNC_KEY, new Date().toISOString());
  });
  return { skipped: false, results };
}

export function scheduleAppFamilySync(options = {}) {
  if (scheduledPromise) return scheduledPromise;
  scheduledPromise = Promise.resolve().then(() => syncAppFamily(options)).finally(() => { scheduledPromise = null; });
  return scheduledPromise;
}
