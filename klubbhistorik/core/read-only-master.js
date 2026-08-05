import { Materializer } from './domain/materializer.js';
import { validateOperation } from './domain/operations.js';
import { parseBatchPath, validateBatch } from './sync/batch.js';
import { CursorResetError } from './sync/errors.js';

const isBatchPath = path => /\/ops\/.+\.json$/.test(String(path || ''));

async function mapConcurrent(values, limit, mapper) {
  const result = new Array(values.length);
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (!failure) {
      const index = next++;
      if (index >= values.length) return;
      try { result[index] = await mapper(values[index], index); }
      catch (error) { failure = error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  if (failure) throw failure;
  return result;
}

export class ReadOnlyMaster {
  constructor({ store, cacheKey, downloadConcurrency = 6, downloadChunkSize = 24 } = {}) {
    if (!store || typeof store.getMeta !== 'function' || typeof store.putMeta !== 'function' || typeof store.getSnapshot !== 'function' || typeof store.saveSnapshot !== 'function') {
      throw new TypeError('ReadOnlyMaster kräver ett lager med metadata och snapshots');
    }
    if (typeof cacheKey !== 'string' || !cacheKey.trim()) throw new TypeError('ReadOnlyMaster kräver cacheKey');
    if (!Number.isSafeInteger(downloadConcurrency) || downloadConcurrency < 1) throw new TypeError('Ogiltig samtidighetsgräns');
    if (!Number.isSafeInteger(downloadChunkSize) || downloadChunkSize < downloadConcurrency) throw new TypeError('Ogiltig nedladdningschunk');
    this.store = store;
    this.cacheKey = cacheKey.trim();
    this.downloadConcurrency = downloadConcurrency;
    this.downloadChunkSize = downloadChunkSize;
    this.snapshotKey = `read-only-master:${this.cacheKey}:snapshot`;
    this.cursorKey = `read-only-master:${this.cacheKey}:cursor`;
    this.statusKey = `read-only-master:${this.cacheKey}:status`;
    this.state = new Materializer();
    this.cursor = null;
    this.initialized = false;
    this.revision = 0;
  }

  async init() {
    const snapshot = await this.store.getSnapshot(this.snapshotKey);
    this.state = snapshot ? new Materializer(snapshot) : new Materializer();
    this.cursor = snapshot ? await this.store.getMeta(this.cursorKey) : null;
    this.initialized = true;
    this.revision += 1;
    return this;
  }

  assertReady() {
    if (!this.initialized) throw new Error('ReadOnlyMaster.init() måste köras först');
  }

  getEntity(type, id, options) {
    this.assertReady();
    return this.state.getEntity(type, id, options);
  }

  listEntities(type, options) {
    this.assertReady();
    return this.state.listEntities(type, options);
  }

  async persist(cursor, status) {
    // Snapshoten skrivs före cursorn. Ett avbrott kan då högst ge en säker
    // omhämtning av redan tillämpade operationer, aldrig ett tyst datahål.
    await this.store.saveSnapshot(this.snapshotKey, this.state.exportSnapshot({ compactApplied: true }));
    await this.store.putMeta(this.cursorKey, cursor);
    await this.store.putMeta(this.statusKey, status);
  }

  async applyOperations(operations, { source = `${this.cacheKey}:local-bootstrap` } = {}) {
    this.assertReady();
    if (!Array.isArray(operations)) throw new TypeError('ReadOnlyMaster.applyOperations kräver en lista');
    operations.forEach(validateOperation);
    this.state.applyAll(operations);
    if (operations.length) this.revision += 1;
    await this.persist(this.cursor, {
      source,
      synced_at: new Date().toISOString(),
      downloaded_ops: operations.length,
      downloaded_batches: 0,
      local_bootstrap: true,
    });
    return { appliedOps: operations.length };
  }

  async loadRemoteCheckpoint(transport) {
    if (this.cursor || this.state.entities.size || typeof transport.getCheckpoint !== 'function') return false;
    try {
      const checkpoint = await transport.getCheckpoint();
      if (!checkpoint || checkpoint.checkpoint_version !== 1 || !checkpoint.snapshot) return false;
      this.state = new Materializer(checkpoint.snapshot);
      await this.persist(null, {
        source: transport.id || this.cacheKey,
        synced_at: new Date().toISOString(),
        downloaded_ops: 0,
        downloaded_batches: 0,
        checkpoint_loaded: true,
      });
      this.revision += 1;
      return true;
    } catch {
      // Den kompakta läskopian är bara en accelerator. Vid fel läses de
      // oföränderliga operationsbatcherna som tidigare.
      return false;
    }
  }

  async sync(transport, { allowCursorReset = true, onProgress } = {}) {
    this.assertReady();
    if (!transport || typeof transport.listChanges !== 'function' || typeof transport.getJson !== 'function') {
      throw new TypeError('ReadOnlyMaster kräver en lästransport');
    }
    await this.loadRemoteCheckpoint(transport);
    let cursor = this.cursor;
    let downloadedOps = 0;
    let downloadedBatches = 0;
    let resetUsed = false;
    while (true) {
      let page;
      try { page = await transport.listChanges(cursor); }
      catch (error) {
        if (error instanceof CursorResetError && allowCursorReset && !resetUsed) {
          this.state = new Materializer();
          cursor = null;
          this.cursor = null;
          resetUsed = true;
          await this.loadRemoteCheckpoint(transport);
          continue;
        }
        throw error;
      }
      const watermarks = Object.fromEntries(this.state.opWatermarks.entries());
      const entries = page.entries.filter(entry => {
        if (!isBatchPath(entry.path)) return false;
        const descriptor = parseBatchPath(entry.path, transport.opsRoot);
        return !descriptor || descriptor.toSeq > Number(watermarks[descriptor.deviceId] || 0);
      });
      for (let offset = 0; offset < entries.length; offset += this.downloadChunkSize) {
        const chunk = entries.slice(offset, offset + this.downloadChunkSize);
        const batches = await mapConcurrent(chunk, this.downloadConcurrency, async entry => {
          const batch = await transport.getJson(entry.path);
          validateBatch(batch);
          return batch;
        });
        for (const batch of batches) {
          this.state.applyAll(batch.ops);
          downloadedOps += batch.ops.length;
          downloadedBatches += 1;
        }
        await onProgress?.({ downloadedOps, downloadedBatches, pageBatches: entries.length, pageProcessed: Math.min(offset + chunk.length, entries.length) });
      }
      cursor = page.cursor;
      await this.persist(cursor, {
        source: transport.id || this.cacheKey,
        synced_at: new Date().toISOString(),
        downloaded_ops: downloadedOps,
        downloaded_batches: downloadedBatches,
        cursor_reset: resetUsed,
      });
      if (!page.has_more) break;
    }
    this.cursor = cursor;
    if (downloadedOps || resetUsed) this.revision += 1;
    return { downloadedOps, downloadedBatches, cursor, cursorReset: resetUsed };
  }
}
