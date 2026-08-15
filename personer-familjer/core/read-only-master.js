import { Materializer } from './domain/materializer.js';
import { validateOperation } from './domain/operations.js';
import { DEFAULT_MAX_FUTURE_CLOCK_DRIFT_MS, parseBatchPath, validateBatchEnvelope } from './sync/batch.js';
import { addBatchRange, contiguousSeq, createBatchProgress, normalizeBatchProgress } from './sync/batch-progress.js';
import { CursorResetError, TransportError } from './sync/errors.js';

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
  constructor({ store, cacheKey, downloadConcurrency = 6, downloadChunkSize = 24, maxFutureClockDriftMs = DEFAULT_MAX_FUTURE_CLOCK_DRIFT_MS, now = () => Date.now() } = {}) {
    if (!store || typeof store.getMeta !== 'function' || typeof store.putMeta !== 'function' || typeof store.getSnapshot !== 'function' || typeof store.saveSnapshot !== 'function') {
      throw new TypeError('ReadOnlyMaster kräver ett lager med metadata och snapshots');
    }
    if (typeof cacheKey !== 'string' || !cacheKey.trim()) throw new TypeError('ReadOnlyMaster kräver cacheKey');
    if (!Number.isSafeInteger(downloadConcurrency) || downloadConcurrency < 1) throw new TypeError('Ogiltig samtidighetsgräns');
    if (!Number.isSafeInteger(downloadChunkSize) || downloadChunkSize < downloadConcurrency) throw new TypeError('Ogiltig nedladdningschunk');
    if (!Number.isSafeInteger(maxFutureClockDriftMs) || maxFutureClockDriftMs < 0) throw new TypeError('Ogiltig framtidsgräns för HLC');
    if (typeof now !== 'function') throw new TypeError('ReadOnlyMaster kräver en klockfunktion');
    this.store = store;
    this.cacheKey = cacheKey.trim();
    this.downloadConcurrency = downloadConcurrency;
    this.downloadChunkSize = downloadChunkSize;
    this.maxFutureClockDriftMs = maxFutureClockDriftMs;
    this.now = now;
    this.snapshotKey = `read-only-master:${this.cacheKey}:snapshot`;
    this.cursorKey = `read-only-master:${this.cacheKey}:cursor`;
    this.statusKey = `read-only-master:${this.cacheKey}:status`;
    this.batchProgressKey = `read-only-master:${this.cacheKey}:batch-progress-v1`;
    this.quarantinePrefix = `read-only-master:${this.cacheKey}:quarantine:`;
    this.state = new Materializer();
    this.cursor = null;
    this.initialized = false;
    this.revision = 0;
  }

  async quarantineBatch(entry, error, opsRoot) {
    const key = `${this.quarantinePrefix}${encodeURIComponent(entry.path)}`;
    const previous = await this.store.getMeta(key);
    const descriptor = parseBatchPath(entry.path, opsRoot);
    const record = {
      path: entry.path,
      rev: entry.rev || null,
      reason: error?.message || 'Ogiltig batch',
      device_id: descriptor?.deviceId || previous?.device_id || null,
      from_seq: descriptor?.fromSeq || previous?.from_seq || null,
      to_seq: descriptor?.toSeq || previous?.to_seq || null,
      attempts: Number(previous?.attempts || 0) + 1,
      first_quarantined_at: previous?.first_quarantined_at || previous?.quarantined_at || new Date(Number(this.now())).toISOString(),
      quarantined_at: new Date(Number(this.now())).toISOString(),
    };
    await this.store.putMeta(key, record);
    return record;
  }

  async quarantineRows() {
    if (typeof this.store.listMeta !== 'function') return [];
    return (await this.store.listMeta(this.quarantinePrefix))
      .filter(row => row?.value?.path)
      .map(row => ({ key: row.key, record: row.value }));
  }

  async loadBatchProgress() {
    const stored = await this.store.getMeta(this.batchProgressKey);
    if (stored) return normalizeBatchProgress(stored);
    const quarantines = (await this.quarantineRows()).map(item => item.record);
    const progress = createBatchProgress(Object.fromEntries(this.state.opWatermarks.entries()), quarantines);
    await this.store.putMeta(this.batchProgressKey, progress);
    return progress;
  }

  async retryQuarantines(transport, progress) {
    let downloadedOps = 0;
    let downloadedBatches = 0;
    for (const row of await this.quarantineRows()) {
      const entry = { path: row.record.path, rev: row.record.rev || null, opsRoot: transport.opsRoot };
      let batch;
      try {
        batch = await transport.getJson(entry.path);
      } catch (error) {
        if (!(error instanceof TransportError) || error.code !== 'invalid_json') throw error;
        await this.quarantineBatch(entry, error, transport.opsRoot);
        continue;
      }
      try {
        validateBatchEnvelope(entry, batch, {
          rootPath: transport.opsRoot,
          now: Number(this.now()),
          maxFutureClockDriftMs: this.maxFutureClockDriftMs,
        });
      } catch (error) {
        await this.quarantineBatch(entry, error, transport.opsRoot);
        continue;
      }
      this.state.applyAll(batch.ops);
      addBatchRange(progress, parseBatchPath(entry.path, transport.opsRoot));
      await this.store.putMeta(this.batchProgressKey, progress);
      await this.store.deleteMeta(row.key);
      downloadedOps += batch.ops.length;
      downloadedBatches += 1;
    }
    return { downloadedOps, downloadedBatches };
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
      if (!checkpoint || ![1, 2].includes(checkpoint.checkpoint_version) || !checkpoint.snapshot) return false;
      this.state = new Materializer(checkpoint.snapshot);
      const quarantines = (await this.quarantineRows()).map(item => item.record);
      await this.store.putMeta(this.batchProgressKey, createBatchProgress(checkpoint.snapshot.op_watermarks || {}, quarantines));
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
    let batchProgress = await this.loadBatchProgress();
    const retried = await this.retryQuarantines(transport, batchProgress);
    let cursor = this.cursor;
    let downloadedOps = retried.downloadedOps;
    let downloadedBatches = retried.downloadedBatches;
    let quarantinedBatches = (await this.quarantineRows()).map(item => item.record);
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
          await this.store.deleteMeta(this.batchProgressKey);
          await this.loadRemoteCheckpoint(transport);
          batchProgress = await this.loadBatchProgress();
          continue;
        }
        throw error;
      }
      const entries = page.entries.filter(entry => {
        if (!isBatchPath(entry.path)) return false;
        const descriptor = parseBatchPath(entry.path, transport.opsRoot);
        return !descriptor || descriptor.toSeq > contiguousSeq(batchProgress, descriptor.deviceId);
      });
      for (let offset = 0; offset < entries.length; offset += this.downloadChunkSize) {
        const chunk = entries.slice(offset, offset + this.downloadChunkSize);
        const downloaded = await mapConcurrent(chunk, this.downloadConcurrency, async entry => {
          let batch;
          try {
            batch = await transport.getJson(entry.path);
          } catch (error) {
            if (!(error instanceof TransportError) || error.code !== 'invalid_json') throw error;
            return { quarantine: await this.quarantineBatch(entry, error, transport.opsRoot) };
          }
          try {
            validateBatchEnvelope(entry, batch, {
              rootPath: transport.opsRoot,
              now: Number(this.now()),
              maxFutureClockDriftMs: this.maxFutureClockDriftMs,
            });
            return { batch };
          } catch (error) {
            return { quarantine: await this.quarantineBatch(entry, error, transport.opsRoot) };
          }
        });
        const batches = downloaded.filter(item => item.batch).map(item => item.batch);
        quarantinedBatches.push(...downloaded.filter(item => item.quarantine).map(item => item.quarantine));
        for (const batch of batches) {
          this.state.applyAll(batch.ops);
          addBatchRange(batchProgress, {
            deviceId: batch.device_id,
            fromSeq: batch.from_seq,
            toSeq: batch.to_seq,
          });
          downloadedOps += batch.ops.length;
          downloadedBatches += 1;
        }
        if (batches.length) await this.store.putMeta(this.batchProgressKey, batchProgress);
        await onProgress?.({ downloadedOps, downloadedBatches, quarantinedBatches: quarantinedBatches.length, pageBatches: entries.length, pageProcessed: Math.min(offset + chunk.length, entries.length) });
      }
      cursor = page.cursor;
      quarantinedBatches = (await this.quarantineRows()).map(item => item.record);
      await this.persist(cursor, {
        source: transport.id || this.cacheKey,
        synced_at: new Date().toISOString(),
        downloaded_ops: downloadedOps,
        downloaded_batches: downloadedBatches,
        quarantined_batches: quarantinedBatches.length,
        cursor_reset: resetUsed,
      });
      if (!page.has_more) break;
    }
    this.cursor = cursor;
    if (downloadedOps || resetUsed) this.revision += 1;
    return { downloadedOps, downloadedBatches, quarantinedBatches, cursor, cursorReset: resetUsed };
  }
}
