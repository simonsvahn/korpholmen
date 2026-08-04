import { Repository } from '../domain/repository.js';
import { IndexedDBStore, openSlaktlandskapDB } from '../storage/indexeddb.js';
import { DropboxTransport } from './dropbox-transport.js';
import { SyncEngine } from './sync-engine.js';
import { KorpholmenSharedStore } from './shared-dropbox-session.js';

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

const deviceIdFor = app => {
  let value = globalThis.localStorage?.getItem(app.deviceKey);
  if (!value) {
    value = `${app.devicePrefix}${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
    globalThis.localStorage?.setItem(app.deviceKey, value);
  }
  return value;
};

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
    const repository = await new Repository({ store, deviceId: deviceIdFor(app) }).init();
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
  if (await sharedStore.get('dropbox:refresh-token')) return false;
  for (const app of KORPHOLMEN_APPS) {
    const database = await openSlaktlandskapDB({ name: app.database });
    try {
      const store = new IndexedDBStore(database);
      for (const key of legacyTokenKeys(app)) {
        const refreshToken = await store.getMeta(key);
        if (!refreshToken) continue;
        await sharedStore.put('dropbox:refresh-token', refreshToken);
        return true;
      }
    } finally {
      database.close();
    }
  }
  return false;
}

export async function mirrorSharedDropboxCredential({ refreshToken, sharedStore = new KorpholmenSharedStore() } = {}) {
  const token = refreshToken || await sharedStore.get('dropbox:refresh-token');
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
