export { canonicalStringify, cloneJson } from './domain/canonical.js?v=2026-08-01-10';
export { compareHLC, createClock, formatHLC, parseHLC } from './domain/hlc.js?v=2026-08-01-10';
export {
  DELETE_FIELD,
  RESET_FIELD,
  createDeleteOperation,
  createRestoreOperation,
  createSetOperation,
  validateOperation
} from './domain/operations.js?v=2026-08-01-10';
export { Materializer, materialize } from './domain/materializer.js?v=2026-08-01-10';
export { Repository } from '../core/domain/repository.js';
export { createRevisionCache, debounce, isOfflineError, resolveDeviceId } from '../core/runtime-safety.js';
export { MemoryStore } from '../core/storage/memory.js';
export { IndexedDBStore, openSlaktlandskapDB } from '../core/storage/indexeddb.js';
export { createBatch, batchPath, validateBatch } from './sync/batch.js?v=2026-08-01-10';
export { DropboxTransport } from './sync/dropbox-transport.js?v=2026-08-01-10';
export { MemoryRemoteTransport } from './sync/memory-transport.js?v=2026-08-01-10';
export { beginDropboxOAuth, completeDropboxOAuth } from './sync/oauth-flow.js?v=2026-08-01-10';
export { exchangeDropboxRefreshToken } from './sync/oauth-pkce.js?v=2026-08-01-10';
export { SyncEngine } from '../core/sync/sync-engine.js';
export { KorpholmenSharedStore, SharedDropboxSession, sharedDropboxTokenKey } from '../core/sync/shared-dropbox-session.js';
export { KORPHOLMEN_APPS, getAppFamilySyncStatuses, migrateLegacyCredentialsToShared, mirrorSharedDropboxCredential, scheduleAppFamilySync, syncAppFamily } from '../core/sync/app-family-sync.js';
export { registerKorpholmenServiceWorker } from '../core/pwa/korpholmen-service-worker.js';
