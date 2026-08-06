import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  DELETE_FIELD,
  DropboxTransport,
  batchPath,
  createBatch,
  openSlaktlandskapDB,
  MemoryRemoteTransport,
  MemoryStore,
  Materializer,
  ReadOnlyMaster,
  Repository,
  KorpholmenSharedStore,
  SharedDropboxSession,
  SyncEngine,
  canonicalStringify,
  createRevisionCache,
  decodeCheckpointPayload,
  debounce,
  disconnectDropboxEverywhere,
  dropboxUploadTimeoutMs,
  isOfflineError,
  mergePersonReferences,
  migrateLegacyCredentialsToShared,
  mirrorSharedDropboxCredential,
  packSnapshot,
  requestPersistentStorage,
  resolveArchiveEntity,
  resolveDeviceId,
  resolveCurrentOwners,
  revokeDropboxAccessToken,
  sharedDropboxDisconnectedKey,
  sha256Hex,
  syncAppFamily,
  unpackSnapshot,
} from '../data-layer.js';
import { addBatchRange, contiguousSeq, createBatchProgress, hasBatchGaps } from '../sync/batch-progress.js';
import { TransportError } from '../sync/errors.js';

let passed = 0;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
async function test(name, action) {
  await action(); passed += 1; console.log(`✓ ${name}`);
}

async function writableMaster(deviceId, remote) {
  const repository = await new Repository({ store: new MemoryStore(), deviceId }).init();
  return { repository, sync: () => new SyncEngine({ repository, transport: remote }).syncOnce() };
}

await test('batchframsteg flyttar bara vattenmärket över sammanhängande intervall', async () => {
  const progress = createBatchProgress({ device: 6 }, [{ device_id: 'device', from_seq: 3, to_seq: 4 }]);
  assert.equal(contiguousSeq(progress, 'device'), 2);
  assert.deepEqual(progress.device.pending, [[5, 6]]);
  assert.equal(hasBatchGaps(progress), true);
  addBatchRange(progress, { deviceId: 'device', fromSeq: 3, toSeq: 4 });
  assert.equal(contiguousSeq(progress, 'device'), 6);
  assert.equal(hasBatchGaps(progress), false);

  const outOfOrder = createBatchProgress();
  addBatchRange(outOfOrder, { deviceId: 'device', fromSeq: 5, toSeq: 6 });
  assert.equal(contiguousSeq(outOfOrder, 'device'), 0);
  addBatchRange(outOfOrder, { deviceId: 'device', fromSeq: 1, toSeq: 2 });
  assert.equal(contiguousSeq(outOfOrder, 'device'), 2);
  addBatchRange(outOfOrder, { deviceId: 'device', fromSeq: 3, toSeq: 4 });
  assert.equal(contiguousSeq(outOfOrder, 'device'), 6);
});

await test('en blockerad IndexedDB-uppgradering ger begriplig återkoppling i stället för att hänga', async () => {
  let request;
  let blocked = 0;
  const indexedDB = {
    open() {
      request = { result: null, error: null };
      queueMicrotask(() => request.onblocked());
      return request;
    },
  };
  await assert.rejects(
    openSlaktlandskapDB({ indexedDB, onBlocked: () => { blocked += 1; }, openTimeoutMs: 5 }),
    /lokala databasen kunde inte öppnas/,
  );
  assert.equal(blocked, 1);
});

await test('en tyst väntande IndexedDB-öppning får också en sluttid', async () => {
  const indexedDB = { open: () => ({ result: null, error: null }) };
  await assert.rejects(openSlaktlandskapDB({ indexedDB, openTimeoutMs: 5 }), /lokala databasen kunde inte öppnas/);
});

await test('en äldre flik släpper databasen automatiskt vid nästa versionsbyte', async () => {
  let request;
  let closed = 0;
  const database = { close: () => { closed += 1; }, onversionchange: null };
  const indexedDB = {
    open() {
      request = { result: database, error: null };
      queueMicrotask(() => request.onsuccess());
      return request;
    },
  };
  const opened = await openSlaktlandskapDB({ indexedDB, openTimeoutMs: 50 });
  opened.onversionchange();
  assert.equal(closed, 1);
});

await test('ett blockerat gemensamt sessionsanrop får en begriplig sluttid', async () => {
  let request;
  let aborted = 0;
  const transaction = {
    objectStore: () => ({ get: () => ({ result: null, error: null }) }),
    abort() { aborted += 1; this.onabort?.(); },
  };
  const database = { transaction: () => transaction, close: () => {}, onversionchange: null };
  const indexedDB = {
    open() {
      request = { result: database, error: null };
      queueMicrotask(() => request.onsuccess());
      return request;
    },
  };
  const store = new KorpholmenSharedStore({ indexedDB, openTimeoutMs: 50, transactionTimeoutMs: 5 });
  await assert.rejects(store.get('dropbox:refresh-token'), /sessionslagret svarade inte/);
  assert.equal(aborted, 1);
});

await test('automatisk totalsynk dubbelköas inte av flera flikar', async () => {
  const values = new Map();
  const sharedStore = {
    get: async key => values.get(key) ?? null,
    put: async (key, value) => values.set(key, value),
  };
  let lockTail = Promise.resolve();
  const lock = (_name, action) => {
    const result = lockTail.then(action);
    lockTail = result.catch(() => {});
    return result;
  };
  let pulls = 0;
  const appList = [{ id: 'a' }, { id: 'b' }];
  const pull = async ({ app }) => { pulls += 1; return { app: app.id, state: 'ok' }; };
  const [first, second] = await Promise.all([
    syncAppFamily({ accessToken: 'token', sharedStore, appList, pull, lock }),
    syncAppFamily({ accessToken: 'token', sharedStore, appList, pull, lock }),
  ]);
  assert.equal(first.skipped, false);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'fresh');
  assert.equal(pulls, 2);
});

await test('ett upptaget flerflikslås blockerar varken start eller köar en extra totalsynk', async () => {
  const sharedStore = { get: async () => null, put: async () => {} };
  const unavailableLock = async (_name, _action, options) => {
    assert.equal(options.ifAvailable, true);
    return options.unavailableValue;
  };
  let opened = 0;
  const migrated = await migrateLegacyCredentialsToShared({
    sharedStore,
    appList: [{ id: 'matrikel' }],
    storeFactory: async () => { opened += 1; throw new Error('ska inte öppnas'); },
    lock: unavailableLock,
  });
  const synced = await syncAppFamily({
    accessToken: 'token',
    sharedStore,
    appList: [{ id: 'matrikel' }],
    pull: async () => { throw new Error('ska inte köras'); },
    lock: unavailableLock,
  });
  assert.equal(migrated, false);
  assert.equal(opened, 0);
  assert.equal(synced.skipped, true);
  assert.equal(synced.reason, 'locked');
});

await test('äldre tokenmigrering har en gemensam kort sluttid över alla databaser', async () => {
  const sharedStore = { get: async () => null, put: async () => {} };
  const attempted = [];
  const times = [0, 0, 2_500];
  const result = await migrateLegacyCredentialsToShared({
    sharedStore,
    appList: [{ id: 'matrikel' }, { id: 'batregister' }],
    storeFactory: async (app, options) => {
      attempted.push([app.id, options.openTimeoutMs]);
      throw new Error('blockerad');
    },
    lock: async (_name, action) => action(),
    migrationTimeoutMs: 2_000,
    now: () => times.shift() ?? 2_500,
  });
  assert.equal(result, false);
  assert.deepEqual(attempted, [['matrikel', 2_000]]);
});

await test('ett synkfel utlöser inte en kö av omedelbara flerfliksomtag', async () => {
  const values = new Map();
  const sharedStore = {
    get: async key => values.get(key) ?? null,
    put: async (key, value) => values.set(key, value),
  };
  let pulls = 0;
  const pull = async ({ app }) => { pulls += 1; return { app: app.id, state: 'error', message: 'nätfel' }; };
  const first = await syncAppFamily({ accessToken: 'token', sharedStore, appList: [{ id: 'a' }], pull });
  const second = await syncAppFamily({ accessToken: 'token', sharedStore, appList: [{ id: 'a' }], pull });
  assert.equal(first.skipped, false);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'recent-attempt');
  assert.equal(pulls, 1);
});

await test('äldre tokenfält speglas bara en gång efter gemensam inloggning', async () => {
  const values = new Map();
  const sharedStore = {
    get: async key => values.get(key) ?? null,
    put: async (key, value) => values.set(key, value),
  };
  const written = [];
  let opened = 0;
  const storeFactory = async app => {
    opened += 1;
    return {
      store: { putMeta: async (key, value) => written.push([app.id, key, value]) },
      close: () => {},
    };
  };
  const appList = [{ id: 'matrikel' }, { id: 'batregister' }];
  assert.equal(await mirrorSharedDropboxCredential({ refreshToken: 'token', sharedStore, storeFactory, appList: [appList[0]] }), true);
  assert.equal(await mirrorSharedDropboxCredential({ refreshToken: 'token', sharedStore, storeFactory, appList: [appList[0]] }), false);
  assert.equal(await mirrorSharedDropboxCredential({ refreshToken: 'token', sharedStore, storeFactory, appList: [appList[1]] }), true);
  assert.equal(opened, 2);
  assert.equal(written.length, 3);
});

await test('en skrivskyddad master cachar främmande operationer utan att blanda dem med appens op-logg', async () => {
  const remote = new MemoryRemoteTransport({ id: 'matrikel' });
  const source = await writableMaster('matrikel-test', remote);
  await source.repository.setField('person', 'p1', 'display_name', 'Första namnet');
  await source.sync();
  const cache = new MemoryStore();
  const reader = await new ReadOnlyMaster({ store: cache, cacheKey: 'matrikel' }).init();
  await reader.sync(remote);
  assert.equal(reader.getEntity('person', 'p1').fields.display_name, 'Första namnet');
  assert.equal((await cache.getAllOps()).length, 0);
  const offlineReader = await new ReadOnlyMaster({ store: cache, cacheKey: 'matrikel' }).init();
  assert.equal(offlineReader.getEntity('person', 'p1').fields.display_name, 'Första namnet');
});

await test('en lokal referensmaster kan startas från operationer utan att de hamnar i appens op-logg', async () => {
  const sourceStore = new MemoryStore();
  const sourceRepository = await new Repository({ store: sourceStore, deviceId: 'kartdata-seed' }).init();
  await sourceRepository.setField('place', 'korpholmen', 'preferred_name', 'Korpholmen');
  const cache = new MemoryStore();
  const reader = await new ReadOnlyMaster({ store: cache, cacheKey: 'kartdata' }).init();
  await reader.applyOperations(await sourceStore.getAllOps(), { source: 'kartdata-test' });
  assert.equal(reader.getEntity('place', 'korpholmen').fields.preferred_name, 'Korpholmen');
  assert.equal((await cache.getAllOps()).length, 0);
  const offlineReader = await new ReadOnlyMaster({ store: cache, cacheKey: 'kartdata' }).init();
  assert.equal(offlineReader.getEntity('place', 'korpholmen').fields.preferred_name, 'Korpholmen');
});

await test('kompakta checkpoints läser bara operationer efter vattenmärket vid nästa start', async () => {
  class CountingStore extends MemoryStore {
    constructor() { super(); this.fullReads = 0; this.incrementalReads = 0; }
    async getAllOps() { this.fullReads += 1; return super.getAllOps(); }
    async getOpsAfter(watermarks) { this.incrementalReads += 1; return super.getOpsAfter(watermarks); }
  }
  const store = new CountingStore();
  const first = await new Repository({ store, deviceId: 'checkpoint-device' }).init();
  await first.setFields(Array.from({ length: 25 }, (_, index) => ({ entityType: 'person', entityId: `p${index}`, field: 'name', value: `Person ${index}` })));
  const snapshot = await first.saveSnapshot();
  assert.equal(snapshot.snapshot_version, 2);
  assert.deepEqual(snapshot.applied, []);
  assert.equal(snapshot.op_watermarks['checkpoint-device'], 25);
  await first.setField('person', 'p25', 'name', 'Person 25');

  store.fullReads = 0;
  store.incrementalReads = 0;
  const resumed = await new Repository({ store, deviceId: 'checkpoint-device' }).init();
  assert.equal(store.fullReads, 0);
  assert.equal(store.incrementalReads, 1);
  assert.equal(resumed.listEntities('person').length, 26);
  assert.equal(resumed.seq, 26);
});

await test('lyckad synk sparar automatiskt ett kompakt checkpoint', async () => {
  const store = new MemoryStore();
  const repository = await new Repository({ store, deviceId: 'sync-checkpoint' }).init();
  await repository.setField('person', 'p1', 'name', 'Checkpoint');
  const remote = new MemoryRemoteTransport({ id: 'checkpoint' });
  await new SyncEngine({ repository, transport: remote }).syncOnce();
  const snapshotId = await store.getMeta('latest_snapshot');
  const snapshot = await store.getSnapshot(snapshotId);
  assert.equal(snapshot.snapshot_version, 2);
  assert.equal(snapshot.op_watermarks['sync-checkpoint'], 1);
});

await test('snapshot v3 packas förlustfritt och verifieras efter gzip', async () => {
  const source = await new Repository({ store: new MemoryStore(), deviceId: 'snapshot-v3-source' }).init();
  await source.setFields([
    { entityType: 'person', entityId: 'p1', field: 'name', value: 'Åsa Ö' },
    { entityType: 'person', entityId: 'p1', field: 'years', value: [1980, 2025] },
  ]);
  const snapshot = await source.saveSnapshot();
  const packed = packSnapshot(snapshot);
  assert.deepEqual(unpackSnapshot(packed), snapshot);
  const payload = Buffer.from(canonicalStringify(packed));
  const compressed = gzipSync(payload, { level: 9, mtime: 0 });
  const manifest = {
    checkpoint_version: 2,
    app_id: 'klubbhistorik',
    created_at: '2026-08-05T00:00:00.000Z',
    ops_root: '/klubbhistorik/ops',
    snapshot_format: 3,
    compression: 'gzip',
    compressed_sha256: await sha256Hex(compressed),
    payload_sha256: await sha256Hex(payload),
    state_sha256: await sha256Hex(canonicalStringify(snapshot)),
    compressed_bytes: compressed.byteLength,
    payload_bytes: payload.byteLength,
    source_batch_count: 1,
    source_operation_count: 2,
  };
  manifest.snapshot_path = `/klubbhistorik/snapshots/${manifest.compressed_sha256}.snapshot-v3.json.gz`;
  assert.deepEqual(await decodeCheckpointPayload(manifest, compressed, { opsRoot: '/klubbhistorik/ops', verifyStateHash: true }), snapshot);
});

await test('Dropbox-transport hämtar manifest och komprimerad snapshot var för sig', async () => {
  const source = await new Repository({ store: new MemoryStore(), deviceId: 'dropbox-snapshot-source' }).init();
  await source.setField('person', 'p1', 'name', 'Dropbox Snapshot');
  const snapshot = await source.saveSnapshot();
  const payload = Buffer.from(canonicalStringify(packSnapshot(snapshot)));
  const compressed = gzipSync(payload, { level: 9, mtime: 0 });
  const compressedHash = await sha256Hex(compressed);
  const manifest = {
    checkpoint_version: 2,
    app_id: 'klubbhistorik',
    created_at: '2026-08-05T00:00:00.000Z',
    ops_root: '/klubbhistorik/ops',
    snapshot_format: 3,
    compression: 'gzip',
    snapshot_path: `/klubbhistorik/snapshots/${compressedHash}.snapshot-v3.json.gz`,
    compressed_sha256: compressedHash,
    payload_sha256: await sha256Hex(payload),
    state_sha256: await sha256Hex(canonicalStringify(snapshot)),
    compressed_bytes: compressed.byteLength,
    payload_bytes: payload.byteLength,
    source_batch_count: 1,
    source_operation_count: 1,
  };
  const paths = [];
  const transport = new DropboxTransport({
    accessToken: 'test',
    opsRoot: '/klubbhistorik/ops',
    fetchImpl: async (_url, init) => {
      const path = JSON.parse(init.headers['Dropbox-API-Arg']).path;
      paths.push(path);
      return path.endsWith('latest.json') ? new Response(JSON.stringify(manifest)) : new Response(compressed);
    },
  });
  const checkpoint = await transport.getCheckpoint();
  assert.deepEqual(paths, ['/klubbhistorik/checkpoints/latest.json', manifest.snapshot_path]);
  assert.equal(new Materializer(checkpoint.snapshot).getEntity('person', 'p1').fields.name, 'Dropbox Snapshot');
});

await test('checkpointkrav stoppar tom Klubbhistorik innan full historik laddas ned', async () => {
  const repository = await new Repository({ store: new MemoryStore(), deviceId: 'empty-klubbhistorik' }).init();
  let listed = false;
  const transport = {
    id: 'checkpoint-required',
    opsRoot: '/klubbhistorik/ops',
    putBatch: async () => {},
    getJson: async () => null,
    getCheckpoint: async () => null,
    listChanges: async () => { listed = true; return { entries: [], cursor: null, has_more: false }; },
  };
  await assert.rejects(
    new SyncEngine({ repository, transport, requireCheckpointOnEmpty: true }).downloadRemote(),
    /Privat snapshot saknas eller är skadad/,
  );
  assert.equal(listed, false);
});

await test('en ny enhet startar från fjärrcheckpoint och hämtar bara svansen', async () => {
  const sourceStore = new MemoryStore();
  const source = await new Repository({ store: sourceStore, deviceId: 'source-device' }).init();
  await source.setFields(Array.from({ length: 5 }, (_, index) => ({
    entityType: 'person', entityId: `p${index + 1}`, field: 'name', value: `Person ${index + 1}`
  })));
  const snapshot = await source.saveSnapshot();
  await source.setField('person', 'p6', 'name', 'Person 6');
  const sourceOps = await sourceStore.getAllOps();
  const oldBatch = createBatch(sourceOps.slice(0, 5));
  const tailBatch = createBatch(sourceOps.slice(5));
  const oldPath = batchPath(oldBatch.device_id, oldBatch.from_seq, oldBatch.to_seq, '/test/ops');
  const tailPath = batchPath(tailBatch.device_id, tailBatch.from_seq, tailBatch.to_seq, '/test/ops');
  const fetched = [];
  const transport = {
    id: 'checkpoint-test',
    opsRoot: '/test/ops',
    putBatch: async () => {},
    getCheckpoint: async () => ({ checkpoint_version: 1, created_at: '2026-08-05T00:00:00.000Z', snapshot }),
    listChanges: async () => ({ entries: [{ path: oldPath }, { path: tailPath }], cursor: 'cursor-1', has_more: false }),
    getJson: async path => { fetched.push(path); return path === oldPath ? oldBatch : tailBatch; },
  };
  const targetStore = new MemoryStore();
  const target = await new Repository({ store: targetStore, deviceId: 'target-device' }).init();
  const result = await new SyncEngine({ repository: target, transport }).downloadRemote();
  assert.equal(result.checkpointLoaded, true);
  assert.equal(result.downloadedOps, 1);
  assert.equal(result.skippedBatches, 1);
  assert.deepEqual(fetched, [tailPath]);
  assert.equal(target.listEntities('person').length, 6);
});

await test('stora Dropbox-sidor tillämpas i minnesbegränsade chunkar', async () => {
  const sourceStore = new MemoryStore();
  const source = await new Repository({ store: sourceStore, deviceId: 'chunk-source' }).init();
  await source.setFields(Array.from({ length: 7 }, (_, index) => ({
    entityType: 'row', entityId: `r${index + 1}`, field: 'value', value: index + 1
  })));
  const batches = (await sourceStore.getAllOps()).map(operation => createBatch([operation]));
  const byPath = new Map(batches.map(batch => [
    batchPath(batch.device_id, batch.from_seq, batch.to_seq, '/chunk/ops'),
    batch,
  ]));
  const progress = [];
  const transport = {
    id: 'chunk-test',
    opsRoot: '/chunk/ops',
    putBatch: async () => {},
    getCheckpoint: async () => null,
    listChanges: async () => ({ entries: [...byPath.keys()].map(path => ({ path })), cursor: 'cursor', has_more: false }),
    getJson: async path => byPath.get(path),
  };
  const target = await new Repository({ store: new MemoryStore(), deviceId: 'chunk-target' }).init();
  const result = await new SyncEngine({ repository: target, transport, downloadConcurrency: 2, downloadChunkSize: 3 })
    .downloadRemote({ onProgress: status => progress.push(status.pageProcessed) });
  assert.equal(result.downloadedBatches, 7);
  assert.deepEqual(progress, [3, 6, 7]);
});

await test('en återställd enhet hämtar även sina egna saknade fjärrbatcher', async () => {
  const sourceStore = new MemoryStore();
  const source = await new Repository({ store: sourceStore, deviceId: 'reused-device' }).init();
  await source.setField('person', 'p1', 'name', 'Återhämtad');
  const batch = createBatch(await sourceStore.getAllOps());
  const path = batchPath(batch.device_id, batch.from_seq, batch.to_seq, '/recovery/ops');
  const transport = {
    id: 'recovery-test',
    opsRoot: '/recovery/ops',
    putBatch: async () => {},
    getCheckpoint: async () => null,
    listChanges: async () => ({ entries: [{ path }], cursor: 'cursor', has_more: false }),
    getJson: async () => batch,
  };
  const restored = await new Repository({ store: new MemoryStore(), deviceId: 'reused-device' }).init();
  const result = await new SyncEngine({ repository: restored, transport }).downloadRemote();
  assert.equal(result.downloadedOps, 1);
  assert.equal(restored.getEntity('person', 'p1').fields.name, 'Återhämtad');
});

await test('Dropbox skiljer ogiltig JSON från avbruten läsning av svarskroppen', async () => {
  const bodyFailure = new DropboxTransport({
    accessToken: 'test',
    fetchImpl: async () => ({
      ok: true,
      text: async () => { throw new TypeError('nätverket bröts under läsningen'); },
    }),
  });
  await assert.rejects(
    bodyFailure.getJson('/ops/body-failure.json'),
    error => error instanceof TypeError && !(error instanceof TransportError) && /nätverket/.test(error.message),
  );

  const invalidJson = new DropboxTransport({
    accessToken: 'test',
    fetchImpl: async () => ({ ok: true, text: async () => '{' }),
  });
  await assert.rejects(
    invalidJson.getJson('/ops/invalid.json'),
    error => error instanceof TransportError && error.code === 'invalid_json',
  );
});

await test('isolerade JSON-batcher återförsöks och tas bort ur karantän när filen är hel', async () => {
  const sourceStore = new MemoryStore();
  const source = await new Repository({ store: sourceStore, deviceId: 'retry-source' }).init();
  await source.setField('person', 'retry-person', 'name', 'Återläst');
  const batch = createBatch(await sourceStore.getAllOps());
  const root = '/retry/ops';
  const path = batchPath(batch.device_id, batch.from_seq, batch.to_seq, root);
  let listCall = 0;
  let jsonCall = 0;
  const transport = {
    id: 'retry-test',
    opsRoot: root,
    putBatch: async () => {},
    getCheckpoint: async () => null,
    listChanges: async () => ({
      entries: listCall++ === 0 ? [{ path, rev: 'rev-1' }] : [],
      cursor: `retry-cursor-${listCall}`,
      has_more: false,
    }),
    getJson: async () => {
      jsonCall += 1;
      if (jsonCall === 1) throw new TransportError('ofullständig JSON', { code: 'invalid_json' });
      return batch;
    },
  };
  const targetStore = new MemoryStore();
  const target = await new Repository({ store: targetStore, deviceId: 'retry-target' }).init();
  const engine = new SyncEngine({ repository: target, transport });
  const first = await engine.downloadRemote();
  assert.equal(first.quarantinedBatches.length, 1);
  assert.equal(first.snapshotDeferred, true);
  assert.equal(target.getEntity('person', 'retry-person'), null);

  const second = await engine.downloadRemote();
  assert.equal(second.downloadedBatches, 1);
  assert.equal(second.quarantinedBatches.length, 0);
  assert.equal(second.snapshotDeferred, false);
  assert.equal(target.getEntity('person', 'retry-person').fields.name, 'Återläst');
  assert.deepEqual(await targetStore.listMeta('sync:retry-test:quarantine:'), []);
});

await test('batchar efter en sekvenslucka kan tillämpas utan att luckan markeras som klar', async () => {
  const sourceStore = new MemoryStore();
  const source = await new Repository({ store: sourceStore, deviceId: 'gap-source' }).init();
  await source.setFields(Array.from({ length: 6 }, (_, index) => ({
    entityType: 'row', entityId: `gap-${index + 1}`, field: 'value', value: index + 1,
  })));
  const operations = await sourceStore.getAllOps();
  const root = '/gap/ops';
  const batches = [
    createBatch(operations.slice(4, 6)),
    createBatch(operations.slice(0, 2)),
    createBatch(operations.slice(2, 4)),
  ];
  const paths = batches.map(batch => batchPath(batch.device_id, batch.from_seq, batch.to_seq, root));
  let pageIndex = 0;
  const transport = {
    id: 'gap-test',
    opsRoot: root,
    putBatch: async () => {},
    getCheckpoint: async () => null,
    listChanges: async () => {
      const index = pageIndex++;
      return { entries: index < paths.length ? [{ path: paths[index] }] : [], cursor: `gap-cursor-${index}`, has_more: false };
    },
    getJson: async path => batches[paths.indexOf(path)],
  };
  const targetStore = new MemoryStore();
  const target = await new Repository({ store: targetStore, deviceId: 'gap-target' }).init();
  const engine = new SyncEngine({ repository: target, transport });

  const afterTail = await engine.downloadRemote();
  assert.equal(afterTail.snapshotDeferred, true);
  assert.equal((await targetStore.getMeta('sync:gap-test:batch-progress-v1'))['gap-source'].contiguous, 0);
  assert.equal(await targetStore.getMeta('latest_snapshot'), null);

  const afterHead = await engine.downloadRemote();
  assert.equal(afterHead.snapshotDeferred, true);
  assert.equal((await targetStore.getMeta('sync:gap-test:batch-progress-v1'))['gap-source'].contiguous, 2);

  const afterGap = await engine.downloadRemote();
  assert.equal(afterGap.snapshotDeferred, false);
  assert.equal((await targetStore.getMeta('sync:gap-test:batch-progress-v1'))['gap-source'].contiguous, 6);
  assert.ok(await targetStore.getMeta('latest_snapshot'));
  assert.equal(target.listEntities('row').length, 6);
});

await test('ogiltiga och orimligt framtidsdaterade batcher isoleras utan att stoppa sidan', async () => {
  const now = Date.UTC(2026, 7, 5, 12, 0, 0);
  const makeBatch = async (deviceId, wallTime, name) => {
    const store = new MemoryStore();
    const repository = await new Repository({ store, deviceId, now: () => wallTime }).init();
    await repository.setField('person', deviceId, 'name', name);
    return createBatch(await store.getAllOps());
  };
  const good = await makeBatch('good-device', now, 'Giltig');
  const malformed = { ...await makeBatch('bad-device', now, 'Felaktig'), batch_version: 2 };
  const future = await makeBatch('future-device', now + 2 * 24 * 60 * 60 * 1000, 'Framtid');
  const root = '/guard/ops';
  const batches = [good, malformed, future];
  const paths = batches.map(batch => batchPath(batch.device_id, batch.from_seq, batch.to_seq, root));
  const byPath = new Map(paths.map((path, index) => [path, batches[index]]));
  const transport = {
    id: 'quarantine-test',
    opsRoot: root,
    putBatch: async () => {},
    getCheckpoint: async () => null,
    listChanges: async () => ({ entries: paths.map((path, index) => ({ path, rev: `rev-${index}` })), cursor: 'safe-cursor', has_more: false }),
    getJson: async path => byPath.get(path),
  };
  const targetStore = new MemoryStore();
  const target = await new Repository({ store: targetStore, deviceId: 'target', now: () => now }).init();
  const result = await new SyncEngine({ repository: target, transport, now: () => now }).downloadRemote();
  assert.equal(result.downloadedBatches, 1);
  assert.equal(result.quarantinedBatches.length, 2);
  assert.equal(target.getEntity('person', 'good-device').fields.name, 'Giltig');
  assert.equal(target.getEntity('person', 'bad-device'), null);
  assert.equal(target.getEntity('person', 'future-device'), null);
  assert.equal(await targetStore.getMeta('sync:quarantine-test:cursor'), 'safe-cursor');
  assert.match(result.quarantinedBatches.find(item => item.path === paths[2]).reason, /fram i tiden/);
});

await test('skrivskyddade referensmastrar passerar också en isolerad batch', async () => {
  const now = Date.UTC(2026, 7, 5, 12, 0, 0);
  const sourceStore = new MemoryStore();
  const source = await new Repository({ store: sourceStore, deviceId: 'reference-source', now: () => now }).init();
  await source.setField('person', 'valid-reference', 'name', 'Giltig referens');
  const valid = createBatch(await sourceStore.getAllOps());
  const invalid = { ...valid, device_id: 'wrong-device' };
  const root = '/reference/ops';
  const validPath = batchPath(valid.device_id, valid.from_seq, valid.to_seq, root);
  const invalidPath = batchPath('wrong-device', invalid.from_seq, invalid.to_seq, root);
  const transport = {
    id: 'reference-test',
    opsRoot: root,
    listChanges: async () => ({ entries: [{ path: invalidPath }, { path: validPath }], cursor: 'reference-cursor', has_more: false }),
    getJson: async path => path === validPath ? valid : invalid,
  };
  const reader = await new ReadOnlyMaster({ store: new MemoryStore(), cacheKey: 'reference-test', now: () => now }).init();
  const result = await reader.sync(transport);
  assert.equal(result.downloadedBatches, 1);
  assert.equal(result.quarantinedBatches.length, 1);
  assert.equal(reader.getEntity('person', 'valid-reference').fields.name, 'Giltig referens');
});

await test('skrivskyddade referensmastrar återförsöker sin karantän vid nästa synk', async () => {
  const sourceStore = new MemoryStore();
  const source = await new Repository({ store: sourceStore, deviceId: 'reference-retry-source' }).init();
  await source.setField('person', 'reference-retry', 'name', 'Tillgänglig igen');
  const batch = createBatch(await sourceStore.getAllOps());
  const root = '/reference-retry/ops';
  const path = batchPath(batch.device_id, batch.from_seq, batch.to_seq, root);
  let listCall = 0;
  let jsonCall = 0;
  const transport = {
    id: 'reference-retry',
    opsRoot: root,
    listChanges: async () => ({
      entries: listCall++ === 0 ? [{ path, rev: 'rev-1' }] : [],
      cursor: `reference-retry-${listCall}`,
      has_more: false,
    }),
    getJson: async () => {
      jsonCall += 1;
      if (jsonCall === 1) throw new TransportError('ofullständig JSON', { code: 'invalid_json' });
      return batch;
    },
  };
  const store = new MemoryStore();
  const reader = await new ReadOnlyMaster({ store, cacheKey: 'reference-retry' }).init();
  const first = await reader.sync(transport);
  assert.equal(first.quarantinedBatches.length, 1);
  assert.equal(reader.getEntity('person', 'reference-retry'), null);

  const second = await reader.sync(transport);
  assert.equal(second.downloadedBatches, 1);
  assert.equal(second.quarantinedBatches.length, 0);
  assert.equal(reader.getEntity('person', 'reference-retry').fields.name, 'Tillgänglig igen');
  assert.deepEqual(await store.listMeta('read-only-master:reference-retry:quarantine:'), []);
});

await test('tombstonade deterministiska länkar återställs atomiskt vid upsert', async () => {
  const store = new MemoryStore();
  const repository = await new Repository({ store, deviceId: 'upsert-test' }).init();
  await repository.setFields([
    { entityType: 'test-link', entityId: 'a--b', field: 'role', value: 'ägare' },
    { entityType: 'test-link', entityId: 'a--b', field: 'confidence', value: 'importerad' },
  ]);
  await repository.deleteEntity('test-link', 'a--b');
  await repository.setField('test-link', 'a--b', 'role', 'ordinarie set är fortfarande dold');
  assert.equal(repository.getEntity('test-link', 'a--b'), null);

  const operations = await repository.upsertFields([
    { entityType: 'test-link', entityId: 'a--b', field: 'role', value: 'anknuten' },
    { entityType: 'test-link', entityId: 'a--b', field: 'confidence', value: 'godkänd i appen' },
  ]);
  assert.equal(operations.length, 3);
  assert.equal(operations[0].field, DELETE_FIELD);
  assert.equal(operations[0].value, false);
  assert.deepEqual(operations.slice(1).map(operation => operation.field), ['role', 'confidence']);
  assert.deepEqual(repository.getEntity('test-link', 'a--b').fields, {
    role: 'anknuten',
    confidence: 'godkänd i appen',
  });
});

await test('en sammansatt borttagning kan ångras atomiskt utan att fält eller historik förloras', async () => {
  const store = new MemoryStore();
  const repository = await new Repository({ store, deviceId: 'undo-test' }).init();
  await repository.setFields([
    { entityType: 'boat', entityId: 'b1', field: 'name', value: 'Fadersfriden' },
    { entityType: 'boat-person-link', entityId: 'b1--p1', field: 'boat_id', value: 'b1' },
    { entityType: 'boat-person-link', entityId: 'b1--p1', field: 'person_id', value: 'p1' },
  ]);
  const restoreEntries = [
    { entityType: 'boat-person-link', entityId: 'b1--p1' },
    { entityType: 'boat', entityId: 'b1' },
  ];
  await repository.deleteEntities(restoreEntries);
  assert.equal(repository.getEntity('boat', 'b1'), null);
  assert.equal(repository.getEntity('boat-person-link', 'b1--p1'), null);
  const operations = await repository.restoreEntities(restoreEntries);
  assert.equal(operations.length, 2);
  assert.equal(repository.getEntity('boat', 'b1').fields.name, 'Fadersfriden');
  assert.equal(repository.getEntity('boat-person-link', 'b1--p1').fields.person_id, 'p1');
  assert.ok((await store.getAllOps()).length >= 7, 'både borttagning och återställning ska finnas kvar i historiken');
});

await test('ett namnbyte i Matrikel slår igenom i referenser och aktuella fastighetsägare', async () => {
  const personRemote = new MemoryRemoteTransport({ id: 'matrikel' });
  const propertyRemote = new MemoryRemoteTransport({ id: 'fastigheter' });
  const persons = await writableMaster('matrikel-test', personRemote);
  const properties = await writableMaster('fastigheter-test', propertyRemote);
  await persons.repository.setField('person', 'p1', 'display_name', 'Anna Före');
  await properties.repository.setFields([
    { entityType: 'property', entityId: 'Alsvik 3:1', field: 'display_name', value: 'Alsvik 3:1' },
    { entityType: 'party', entityId: 'party-anna', field: 'name', value: 'Källnamn Anna' },
    { entityType: 'party', entityId: 'party-anna', field: 'person_id', value: 'p1' },
    { entityType: 'current-owner-assessment', entityId: 'owner-3-1', field: 'property_id', value: 'Alsvik 3:1' },
    { entityType: 'current-owner-assessment', entityId: 'owner-3-1', field: 'owner_party_ids', value: ['party-anna'] },
  ]);
  await persons.sync(); await properties.sync();
  const cache = new MemoryStore();
  const personReader = await new ReadOnlyMaster({ store: cache, cacheKey: 'matrikel' }).init();
  const propertyReader = await new ReadOnlyMaster({ store: cache, cacheKey: 'fastigheter' }).init();
  await personReader.sync(personRemote); await propertyReader.sync(propertyRemote);
  assert.equal(mergePersonReferences([{ external_id: 'p1', display_name: 'Gammal kopia' }], personReader)[0].display_name, 'Anna Före');
  assert.equal(resolveCurrentOwners('Alsvik 3:1', propertyReader, personReader)[0].display_name, 'Anna Före');
  await persons.repository.setField('person', 'p1', 'display_name', 'Anna Efter'); await persons.sync(); await personReader.sync(personRemote);
  assert.equal(mergePersonReferences([{ external_id: 'p1', display_name: 'Gammal kopia' }], personReader)[0].display_name, 'Anna Efter');
  assert.equal(resolveCurrentOwners('Alsvik 3:1', propertyReader, personReader)[0].display_name, 'Anna Efter');
});

await test('Dokumentarkivets kopplade namn och båtlänkar löses från ägarmastrarna', async () => {
  const personMaster = {
    initialized: true,
    getEntity: (type, id) => type === 'person' && id === 'p1' ? { fields: { display_name: 'Anna Holm' } } : null,
  };
  const boatMaster = {
    initialized: true,
    getEntity: (type, id) => type === 'boat' && id === 'b1' ? { fields: { namn: 'Fadersfriden' } } : null,
  };
  const person = resolveArchiveEntity({ entity_type: 'person', external_id: 'p1', name: 'Anna Neretnieks', match_status: 'kopplad' }, { personMaster, boatMaster });
  const boat = resolveArchiveEntity({ entity_type: 'båt', external_id: 'b1', name: 'Äldre båtnamn', match_status: 'kopplad' }, { personMaster, boatMaster });
  assert.equal(person.name, 'Anna Holm');
  assert.equal(person.url, '../matrikel/?person=p1');
  assert.equal(boat.name, 'Fadersfriden');
  assert.equal(boat.url, '../batregister/?boat=b1');
  const unresolved = resolveArchiveEntity({ entity_type: 'person', external_id: 'p1', name: 'Osäker Anna', match_status: 'granska' }, { personMaster, boatMaster });
  assert.equal(unresolved.name, 'Osäker Anna');
});

await test('skrivskyddad Dropbox-transport avvisar uppladdning', async () => {
  const transport = new DropboxTransport({ accessToken: 'test', readOnly: true, fetchImpl: async () => { throw new Error('fetch ska inte anropas'); } });
  await assert.rejects(() => transport.putMutable('/x.json', {}), /Skrivskyddad/);
});

await test('hängande Dropbox-anrop avbryts med begriplig timeout', async () => {
  const fetchImpl = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  const transport = new DropboxTransport({
    accessToken: 'test',
    readOnly: true,
    requestTimeoutMs: 5,
    fetchImpl,
  });
  await assert.rejects(() => transport.listChanges(), /Dropbox svarade inte inom/);
});

await test('stora Dropbox-uppladdningar får en storleksanpassad men begränsad timeout', () => {
  assert.equal(dropboxUploadTimeoutMs({ size: 10 * 1024 * 1024 }, 0), 0);
  assert.equal(dropboxUploadTimeoutMs(new Blob([]), 45_000), 45_000);
  assert.equal(dropboxUploadTimeoutMs(new Blob([new Uint8Array(1024)]), 45_000), 45_000);
  assert.ok(dropboxUploadTimeoutMs({ size: 10 * 1024 * 1024 }, 45_000) > 45_000);
  assert.equal(dropboxUploadTimeoutMs({ size: 1024 * 1024 * 1024 }, 45_000), 10 * 60_000);
});

await test('Dropbox-huvuden är ASCII-säkra även för svenska filnamn', async () => {
  let apiArgument = null;
  const transport = new DropboxTransport({
    accessToken: 'test',
    requestTimeoutMs: 0,
    fetchImpl: async (_url, options) => {
      apiArgument = options.headers['Dropbox-API-Arg'];
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  await transport.getJson('/bilder/Åland/ö.json');
  assert.ok([...apiArgument].every(character => character.charCodeAt(0) <= 0x7f));
  assert.equal(JSON.parse(apiArgument).path, '/bilder/Åland/ö.json');
});

await test('en gemensam Dropbox-session återanvänder och förnyar samma inloggning', async () => {
  const values = new Map();
  const sharedStore = {
    get: async key => values.get(key) ?? null,
    put: async (key, value) => values.set(key, value),
    delete: async key => values.delete(key),
  };
  let exchanges = 0;
  let now = 1_000;
  const session = new SharedDropboxSession({
    clientId: 'client',
    sharedStore,
    now: () => now,
    exchangeRefreshToken: async ({ refreshToken }) => { exchanges += 1; assert.equal(refreshToken, 'refresh-1'); return { access_token: 'access-2', expires_in: 3600 }; },
  });
  await session.acceptTokenResponse({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 1 });
  assert.equal(await session.hasCredential(), true);
  assert.equal(await session.getRefreshToken(), 'refresh-1');
  now = 32_000;
  assert.equal(await session.getAccessToken(), 'access-2');
  assert.equal(exchanges, 1);
});

await test('enhetsidentiteten överlever om localStorage rensas men roteras om IndexedDB har försvunnit', async () => {
  const storageValues = new Map([['device-key', 'legacy-device']]);
  const storage = {
    getItem: key => storageValues.get(key) ?? null,
    setItem: (key, value) => storageValues.set(key, value),
  };
  const freshStore = new MemoryStore();
  const freshId = await resolveDeviceId({
    store: freshStore,
    key: 'device-key',
    prefix: 'device-',
    storage,
    crypto: { randomUUID: () => 'fresh' },
  });
  assert.equal(freshId, 'device-fresh');
  assert.equal(storageValues.get('device-key'), 'device-fresh');

  storageValues.delete('device-key');
  assert.equal(await resolveDeviceId({ store: freshStore, key: 'device-key', prefix: 'device-', storage }), 'device-fresh');
  assert.equal(storageValues.get('device-key'), 'device-fresh');
});

await test('en äldre enhetsidentitet återanvänds bara när dess operationer finns kvar', async () => {
  const store = new MemoryStore();
  const repository = await new Repository({ store, deviceId: 'legacy-device' }).init();
  await repository.setField('person', 'p1', 'name', 'Test');
  const storage = { getItem: () => 'legacy-device', setItem: () => {} };
  assert.equal(await resolveDeviceId({ store, key: 'device-key', prefix: 'device-', storage }), 'legacy-device');
});

await test('offlineklassningen döljer inte vanliga TypeError-programfel', async () => {
  assert.equal(isOfflineError(new TypeError('programfel'), { online: true }), false);
  assert.equal(isOfflineError(new TypeError('Failed to fetch'), { online: true }), true);
  assert.equal(isOfflineError(new Error('godtyckligt fel'), { online: false }), true);
});

await test('beständig webblagring efterfrågas en gång när stödet finns', async () => {
  let requests = 0;
  const result = await requestPersistentStorage({ storage: {
    persisted: async () => false,
    persist: async () => { requests += 1; return true; },
  } });
  assert.deepEqual(result, { supported: true, persisted: true, requested: true });
  assert.equal(requests, 1);
});

await test('revisionscache och debounce undviker onödiga omräkningar', async () => {
  let revision = 1;
  let computations = 0;
  const cached = createRevisionCache(() => revision);
  assert.equal(cached('lista', () => ++computations), 1);
  assert.equal(cached('lista', () => ++computations), 1);
  revision += 1;
  assert.equal(cached('lista', () => ++computations), 2);

  let scheduled = null;
  let latest = null;
  const delayed = debounce(value => { latest = value; }, 100, {
    setTimer: callback => { scheduled = callback; return 1; },
    clearTimer: () => {},
  });
  delayed('första');
  delayed('senaste');
  scheduled();
  assert.equal(latest, 'senaste');
});

await test('Dropbox-token spärras med den officiella revoke-slutpunkten', async () => {
  let request;
  const revoked = await revokeDropboxAccessToken({
    accessToken: 'access-token',
    fetchImpl: async (url, options) => { request = { url, options }; return { ok: true }; },
  });
  assert.equal(revoked, true);
  assert.equal(request.url, 'https://api.dropboxapi.com/2/auth/token/revoke');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer access-token');
  assert.equal(request.options.body, 'null');
});

await test('frånkoppling spärrar återimport och rensar samtliga äldre tokenkopior', async () => {
  const sharedValues = new Map();
  const sharedStore = {
    get: async key => sharedValues.get(key) ?? null,
    put: async (key, value) => sharedValues.set(key, value),
    delete: async key => sharedValues.delete(key),
  };
  const session = new SharedDropboxSession({
    clientId: 'client',
    sharedStore,
    exchangeRefreshToken: async () => { throw new Error('ska inte förnya'); },
  });
  await session.acceptTokenResponse({ access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600 });
  const legacyStores = new Map();
  const storeFactory = async app => {
    const values = new Map([['dropbox:refresh-token', 'legacy-token']]);
    if (app.id === 'matrikel') values.set('dropbox:refresh-token-v1', 'legacy-token-v1');
    legacyStores.set(app.id, values);
    return {
      store: {
        getMeta: async key => values.get(key) ?? null,
        deleteMeta: async key => values.delete(key),
      },
      close: () => {},
    };
  };
  let remotelyRevoked = null;
  const result = await disconnectDropboxEverywhere({
    session,
    revokeAccessToken: async ({ accessToken }) => { remotelyRevoked = accessToken; },
    storeFactory,
  });
  assert.equal(remotelyRevoked, 'access-token');
  assert.equal(result.revoked, true);
  assert.equal(result.cleared, 7);
  assert.deepEqual(result.failures, []);
  assert.equal(await session.hasCredential(), false);
  assert.ok(sharedValues.get(sharedDropboxDisconnectedKey));
  for (const values of legacyStores.values()) {
    assert.equal(values.has('dropbox:refresh-token'), false);
    assert.equal(values.has('dropbox:refresh-token-v1'), false);
  }

  const staleStore = { getMeta: async () => 'stale-refresh-token' };
  assert.equal(await session.migrateLegacyStore(staleStore), false);
  await session.acceptTokenResponse({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
  assert.equal(await session.hasCredential(), true);
  assert.equal(sharedValues.has(sharedDropboxDisconnectedKey), false);
});

await test('nya mastermoduler importeras direkt så att äldre appcache förblir kompatibel', async () => {
  const apps = ['batregister', 'fastigheter', 'kartdata', 'klubbhistorik', 'korpholmenrunt'];
  for (const app of apps) {
    const source = await readFile(resolve(REPO_ROOT, 'apps', app, 'src/app.js'), 'utf8');
    const barrelFields = source.match(/import\s*\{([\s\S]*?)\}\s*from\s*'\.\.\/\.\.\/\.\.\/packages\/core\/data-layer\.js';/)?.[1] || '';
    for (const field of ['ReadOnlyMaster', 'mergePersonReferences', 'resolveCurrentOwners', 'resolvePropertyReferences', 'resolvePartyName']) {
      assert.ok(!new RegExp(`\\b${field}\\b`).test(barrelFields), `${app} importerar ${field} genom den cachekänsliga data-layer-filen`);
    }
    assert.match(source, /packages\/core\/read-only-master\.js/, `${app} ska importera ReadOnlyMaster direkt`);
  }
});

console.log(`\n${passed} kärnkontrakt godkända.`);
