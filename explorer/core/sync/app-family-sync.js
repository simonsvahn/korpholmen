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
  { id: 'klubbhistorik', label: 'Klubbhistorik', database: 'kbk-klubbhistorik', deviceKey: 'korpholmen:klubbhistorik-device-id', devicePrefix: 'klubbhistorik-web-', transportId: 'dropbox-klubbhistorik', opsRoot: '/klubbhistorik/ops', requireCheckpointOnEmpty: true },
  { id: 'kartdata', label: 'Kartdata', database: 'korpholmen-kartdata-v2', deviceKey: 'korpholmen:kartdata-device-id', devicePrefix: 'kartdata-web-', transportId: 'dropbox-kartdata', opsRoot: '/kartdata/ops' },
]);

const FAMILY_SYNC_KEY = 'family-sync:last-completed-at';
const FAMILY_ATTEMPT_KEY = 'family-sync:last-attempt-at';
const LEGACY_MIRROR_KEY = 'dropbox:legacy-mirror-v1';
const statusKey = id => `family-sync:status:${id}`;
let scheduledPromise = null;

const legacyTokenKeys = app => app.id === 'matrikel' ? ['dropbox:refresh-token-v1', 'dropbox:refresh-token'] : ['dropbox:refresh-token'];

const deviceIdFor = (app, store) => resolveDeviceId({ store, key: app.deviceKey, prefix: app.devicePrefix });

const withOriginLock = async (name, action, { ifAvailable = false, unavailableValue = false } = {}) => {
  if (globalThis.navigator?.locks?.request) {
    if (!ifAvailable) return navigator.locks.request(name, action);
    return navigator.locks.request(name, { ifAvailable: true }, lock => lock ? action() : unavailableValue);
  }
  return action();
};

async function appsWithExistingDatabases(appList) {
  if (typeof globalThis.indexedDB?.databases !== 'function') return [];
  try {
    const databases = await Promise.race([
      globalThis.indexedDB.databases(),
      new Promise(resolve => setTimeout(() => resolve(null), 2_000)),
    ]);
    if (!Array.isArray(databases)) return [];
    const names = new Set(databases.map(database => database?.name).filter(Boolean));
    return appList.filter(app => names.has(app.database));
  } catch {
    return [];
  }
}

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
    const result = await new SyncEngine({ repository, transport, requireCheckpointOnEmpty: app.requireCheckpointOnEmpty }).downloadRemote({
      onProgress: async progress => {
        const status = {
          state: 'syncing',
          started_at: startedAt,
          downloaded_ops: progress.downloadedOps || 0,
          downloaded_batches: progress.downloadedBatches || 0,
          skipped_batches: progress.skippedBatches || 0,
          quarantined_batches: progress.quarantinedBatches || 0,
          checkpoint_loaded: Boolean(progress.checkpointLoaded),
        };
        await sharedStore.put(statusKey(app.id), status);
        onProgress?.({ app, ...status });
      },
    });
    const quarantined = result.quarantinedBatches?.length || 0;
    const status = { state: quarantined ? 'warning' : 'ok', synced_at: new Date().toISOString(), downloaded_ops: result.downloadedOps, downloaded_batches: result.downloadedBatches, quarantined_batches: quarantined };
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
  return Object.fromEntries(await Promise.all(KORPHOLMEN_APPS.map(async app => {
    const status = await sharedStore.get(statusKey(app.id));
    if (status?.state === 'syncing' && Date.now() - Date.parse(status.started_at || 0) > 15 * 60_000) {
      return [app.id, { state: 'error', failed_at: status.started_at, message: 'Föregående synk avbröts innan den blev klar' }];
    }
    return [app.id, status];
  })));
}

export async function migrateLegacyCredentialsToShared({ sharedStore = new KorpholmenSharedStore(), storeFactory = defaultStoreFactory, appList = KORPHOLMEN_APPS, lock = withOriginLock, migrationTimeoutMs = 2_000, now = () => Date.now() } = {}) {
  return lock('korpholmen-dropbox-session', async () => {
    if (await sharedStore.get(sharedDropboxDisconnectedKey)) return false;
    if (await sharedStore.get(sharedDropboxTokenKey)) return false;
    const candidates = storeFactory === defaultStoreFactory ? await appsWithExistingDatabases(appList) : appList;
    const deadline = now() + Math.max(0, migrationTimeoutMs);
    for (const app of candidates) {
      const remainingMs = deadline - now();
      if (remainingMs <= 0) return false;
      let handle;
      try {
        handle = await storeFactory(app, { openTimeoutMs: remainingMs });
        for (const key of legacyTokenKeys(app)) {
          const refreshToken = await handle.store.getMeta(key);
          if (!refreshToken) continue;
          await sharedStore.put(sharedDropboxTokenKey, refreshToken);
          return true;
        }
      } catch {
        // En blockerad äldre appdatabas får inte hindra navet från att starta.
        // Användaren kan ansluta den gemensamma sessionen på nytt från roten.
      } finally {
        handle?.close?.();
      }
    }
    return false;
  }, { ifAvailable: true, unavailableValue: false });
}

export async function mirrorSharedDropboxCredential({ refreshToken, sharedStore = new KorpholmenSharedStore(), storeFactory = defaultStoreFactory, appList = KORPHOLMEN_APPS, lock = withOriginLock } = {}) {
  return lock('korpholmen-dropbox-session', async () => {
    if (await sharedStore.get(sharedDropboxDisconnectedKey)) return false;
    const token = refreshToken || await sharedStore.get(sharedDropboxTokenKey);
    if (!token) return false;
    const mirrorState = await sharedStore.get(LEGACY_MIRROR_KEY);
    const mirroredApps = new Set(Array.isArray(mirrorState?.apps) ? mirrorState.apps : []);
    const pendingApps = appList.filter(app => !mirroredApps.has(app.id));
    if (!pendingApps.length) return false;
    for (const app of pendingApps) {
      const handle = await storeFactory(app);
      try {
        await Promise.all(legacyTokenKeys(app).map(key => handle.store.putMeta(key, token)));
      } finally {
        handle.close?.();
      }
      mirroredApps.add(app.id);
      await sharedStore.put(LEGACY_MIRROR_KEY, { apps: [...mirroredApps].sort(), updated_at: new Date().toISOString() });
    }
    return true;
  }, { ifAvailable: true, unavailableValue: false });
}

const defaultStoreFactory = async (app, { openTimeoutMs } = {}) => {
  const database = await openSlaktlandskapDB({ name: app.database, openTimeoutMs });
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
    await session.sharedStore?.delete?.(LEGACY_MIRROR_KEY);
    const legacy = await clearLegacyCredentialStores(storeFactory);
    return { revoked, revokeError, ...legacy };
  });
}

export async function syncAppFamily({ accessToken, skipApp = null, force = false, maxAgeMs = 10 * 60_000, retryDelayMs = 2 * 60_000, concurrency = 2, sharedStore = new KorpholmenSharedStore(), onProgress, appList = KORPHOLMEN_APPS, pull = pullApp, lock = withOriginLock } = {}) {
  if (!accessToken) throw new TypeError('Totalsynk kräver Dropbox access token');
  if (globalThis.navigator?.onLine === false) return { skipped: true, reason: 'offline', results: [] };
  return lock('korpholmen-family-sync', async () => {
    // Färskhetskontrollen måste ligga innanför flerflikslåset. Annars kan
    // flera flikar läsa samma gamla markör och köa varsin full totalsynk.
    const lastCompleted = await sharedStore.get(FAMILY_SYNC_KEY);
    if (!force && lastCompleted && Date.now() - Date.parse(lastCompleted) < maxAgeMs) return { skipped: true, reason: 'fresh', results: [] };
    const lastAttempt = await sharedStore.get(FAMILY_ATTEMPT_KEY);
    if (!force && lastAttempt && Date.now() - Date.parse(lastAttempt) < retryDelayMs) return { skipped: true, reason: 'recent-attempt', results: [] };
    await sharedStore.put(FAMILY_ATTEMPT_KEY, new Date().toISOString());
    const apps = appList.filter(app => app.id !== skipApp);
    const results = new Array(apps.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, concurrency), apps.length) }, async () => {
      while (next < apps.length) {
        const index = next++;
        results[index] = await pull({ app: apps[index], accessToken, sharedStore, onProgress });
      }
    });
    await Promise.all(workers);
    if (results.every(result => result.state !== 'error')) await sharedStore.put(FAMILY_SYNC_KEY, new Date().toISOString());
    return { skipped: false, results };
  }, { ifAvailable: true, unavailableValue: { skipped: true, reason: 'locked', results: [] } });
}

export function scheduleAppFamilySync(options = {}) {
  if (scheduledPromise) return scheduledPromise;
  scheduledPromise = Promise.resolve().then(() => syncAppFamily(options)).finally(() => { scheduledPromise = null; });
  return scheduledPromise;
}
