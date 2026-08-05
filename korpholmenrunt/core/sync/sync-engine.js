import { Materializer } from '../domain/materializer.js';
import { DEFAULT_MAX_FUTURE_CLOCK_DRIFT_MS, createBatch, parseBatchPath, validateBatchEnvelope } from './batch.js';
import { CursorResetError, TransportError } from './errors.js';

const isBatchPath = path => /\/ops\/.+\.json$/.test(path);
const defaultSleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function checkpointSnapshot(checkpoint) {
  if (!checkpoint || ![1, 2].includes(checkpoint.checkpoint_version) || !checkpoint.snapshot) throw new TypeError('Ogiltig synkcheckpoint');
  // Konstruktionen validerar hela snapshoten innan den får påverka lokal data.
  new Materializer(checkpoint.snapshot);
  return checkpoint.snapshot;
}

async function mapConcurrent(values, limit, mapper) {
  const result = new Array(values.length);
  let nextIndex = 0;
  let failure = null;
  const worker = async () => {
    while (!failure) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        result[index] = await mapper(values[index], index);
      } catch (error) {
        failure = error;
      }
    }
  };
  const workerCount = Math.min(limit, values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (failure) throw failure;
  return result;
}

export class SyncEngine {
  constructor({
    repository,
    transport,
    batchSize = 250,
    downloadConcurrency = 6,
    downloadChunkSize = 24,
    requireCheckpointOnEmpty = false,
    maxRateLimitRetries = 1,
    maxFutureClockDriftMs = DEFAULT_MAX_FUTURE_CLOCK_DRIFT_MS,
    now = () => Date.now(),
    sleep = defaultSleep
  }) {
    if (!repository?.initialized) throw new TypeError('SyncEngine kräver initierad Repository');
    if (!transport || typeof transport.putBatch !== 'function' || typeof transport.listChanges !== 'function' || typeof transport.getJson !== 'function') throw new TypeError('SyncEngine kräver transport');
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new TypeError('Ogiltig batchstorlek');
    if (!Number.isSafeInteger(downloadConcurrency) || downloadConcurrency < 1) throw new TypeError('Ogiltig samtidighetsgräns');
    if (!Number.isSafeInteger(downloadChunkSize) || downloadChunkSize < downloadConcurrency) throw new TypeError('Ogiltig nedladdningschunk');
    if (!Number.isSafeInteger(maxRateLimitRetries) || maxRateLimitRetries < 0) throw new TypeError('Ogiltigt antal 429-omtag');
    if (!Number.isSafeInteger(maxFutureClockDriftMs) || maxFutureClockDriftMs < 0) throw new TypeError('Ogiltig framtidsgräns för HLC');
    if (typeof now !== 'function') throw new TypeError('SyncEngine kräver en klockfunktion');
    if (typeof sleep !== 'function') throw new TypeError('SyncEngine kräver en väntfunktion');
    this.repository = repository;
    this.transport = transport;
    this.batchSize = batchSize;
    this.downloadConcurrency = downloadConcurrency;
    this.downloadChunkSize = downloadChunkSize;
    this.requireCheckpointOnEmpty = Boolean(requireCheckpointOnEmpty);
    this.maxRateLimitRetries = maxRateLimitRetries;
    this.maxFutureClockDriftMs = maxFutureClockDriftMs;
    this.now = now;
    this.sleep = sleep;
    this.keyPrefix = `sync:${transport.id || 'transport'}`;
    this.uploadedSeqKey = `${this.keyPrefix}:uploaded_seq:${repository.deviceId}`;
  }

  validateRemoteBatch(entry, batch) {
    return validateBatchEnvelope(entry, batch, {
      rootPath: this.transport.opsRoot,
      now: Number(this.now()),
      maxFutureClockDriftMs: this.maxFutureClockDriftMs,
    });
  }

  async quarantineBatch(entry, error) {
    const record = {
      path: entry.path,
      rev: entry.rev || null,
      reason: error?.message || 'Ogiltig batch',
      quarantined_at: new Date(Number(this.now())).toISOString(),
    };
    await this.repository.store.putMeta(`${this.keyPrefix}:quarantine:${encodeURIComponent(entry.path)}`, record);
    return record;
  }

  async withRateLimitRetry(operation) {
    let retries = 0;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof TransportError) || error.status !== 429 || retries >= this.maxRateLimitRetries) throw error;
        retries += 1;
        const seconds = Number.isFinite(error.retryAfter) ? Math.max(0, error.retryAfter) : 1;
        await this.sleep(seconds * 1000);
      }
    }
  }

  async uploadLocal() {
    const uploadedSeq = await this.repository.store.getMeta(this.uploadedSeqKey) ?? 0;
    const pending = typeof this.repository.store.getOpsForDeviceAfter === 'function'
      ? await this.repository.store.getOpsForDeviceAfter(this.repository.deviceId, uploadedSeq)
      : (await this.repository.store.getAllOps())
        .filter(op => op.device_id === this.repository.deviceId && op.seq > uploadedSeq)
        .sort((a, b) => a.seq - b.seq);
    let uploadedOps = 0;
    let uploadedBatches = 0;
    for (let index = 0; index < pending.length; index += this.batchSize) {
      const batch = createBatch(pending.slice(index, index + this.batchSize));
      await this.withRateLimitRetry(() => this.transport.putBatch(batch));
      await this.repository.store.putMeta(this.uploadedSeqKey, batch.to_seq);
      uploadedOps += batch.ops.length;
      uploadedBatches += 1;
    }
    return { uploadedOps, uploadedBatches };
  }

  async diagnostics() {
    const uploadedSeq = await this.repository.store.getMeta(this.uploadedSeqKey) ?? 0;
    const all = await this.repository.store.getAllOps();
    const ownOps = all.filter(op => op.device_id === this.repository.deviceId);
    const pendingOps = ownOps.filter(op => op.seq > uploadedSeq).length;
    const appDevices = [...new Set([this.repository.deviceId, ...all.map(op => op.device_id)])
      .values()]
      .filter(id => /^(?:slakt-web-|web-)/.test(id));
    return {
      deviceId: this.repository.deviceId,
      localSeq: ownOps.reduce((max, op) => Math.max(max, op.seq), 0),
      uploadedSeq,
      pendingOps,
      knownAppDevices: appDevices.length
    };
  }

  async loadRemoteCheckpoint({ onProgress } = {}) {
    if (typeof this.transport.getCheckpoint !== 'function') return { loaded: false, reason: 'unsupported' };
    const [cursor, latestSnapshotId, knownDeviceIds] = await Promise.all([
      this.repository.store.getMeta(`${this.keyPrefix}:cursor`),
      this.repository.store.getMeta('latest_snapshot'),
      this.repository.store.getMeta('device_ids'),
    ]);
    if (cursor || latestSnapshotId || (Array.isArray(knownDeviceIds) && knownDeviceIds.length)) return { loaded: false, reason: 'local-state' };
    const localOps = await this.repository.store.getAllOps();
    if (localOps.length) return { loaded: false, reason: 'local-state' };
    let checkpoint;
    try {
      checkpoint = await this.transport.getCheckpoint();
      if (!checkpoint) return { loaded: false, reason: 'missing' };
      const snapshot = checkpointSnapshot(checkpoint);
      const snapshotId = `dropbox-checkpoint:${this.transport.id || 'transport'}`;
      await this.repository.store.saveSnapshot(snapshotId, snapshot);
      await this.repository.store.putMeta('device_ids', Object.keys(snapshot.op_watermarks || {}));
      await this.repository.store.putMeta('latest_snapshot', snapshotId);
      await this.repository.init();
      await onProgress?.({ phase: 'checkpoint', checkpointLoaded: true, downloadedOps: 0, downloadedBatches: 0, skippedBatches: 0 });
      return { loaded: true, createdAt: checkpoint.created_at || null };
    } catch (error) {
      // Checkpointen är en accelerator. Originalbatcherna är fortsatt master
      // och ska kunna användas även om acceleratorn saknas eller är skadad.
      return { loaded: false, reason: 'unavailable', error: error.message };
    }
  }

  async downloadRemote({ allowCursorReset = true, onProgress } = {}) {
    const checkpoint = await this.loadRemoteCheckpoint({ onProgress });
    if (this.requireCheckpointOnEmpty && ['missing', 'unavailable', 'unsupported'].includes(checkpoint.reason)) {
      const detail = checkpoint.error ? `: ${checkpoint.error}` : '';
      throw new Error(`Privat snapshot saknas eller är skadad${detail}`);
    }
    let cursor = await this.repository.store.getMeta(`${this.keyPrefix}:cursor`);
    let downloadedOps = 0;
    let downloadedBatches = 0;
    let skippedBatches = 0;
    const quarantinedBatches = [];
    let resetUsed = false;
    while (true) {
      let page;
      try {
        page = await this.withRateLimitRetry(() => this.transport.listChanges(cursor));
      } catch (error) {
        if (error instanceof CursorResetError && allowCursorReset && !resetUsed) {
          cursor = null;
          resetUsed = true;
          continue;
        }
        throw error;
      }
      const watermarks = this.repository.getWatermarks();
      const entries = page.entries.filter(entry => {
        if (!isBatchPath(entry.path)) return false;
        const descriptor = parseBatchPath(entry.path, this.transport.opsRoot);
        if (descriptor && descriptor.toSeq <= Number(watermarks[descriptor.deviceId] || 0)) {
          skippedBatches += 1;
          return false;
        }
        return true;
      });
      for (let offset = 0; offset < entries.length; offset += this.downloadChunkSize) {
        const chunk = entries.slice(offset, offset + this.downloadChunkSize);
        const downloaded = await mapConcurrent(chunk, this.downloadConcurrency, async entry => {
          let batch;
          try {
            batch = await this.withRateLimitRetry(() => this.transport.getJson(entry.path));
          } catch (error) {
            if (!(error instanceof TransportError) || error.code !== 'invalid_json') throw error;
            return { quarantine: await this.quarantineBatch(entry, error) };
          }
          try {
            this.validateRemoteBatch(entry, batch);
            return { batch };
          } catch (error) {
            return { quarantine: await this.quarantineBatch(entry, error) };
          }
        });
        const batches = downloaded.filter(item => item.batch).map(item => item.batch);
        quarantinedBatches.push(...downloaded.filter(item => item.quarantine).map(item => item.quarantine));
        // Operationer är idempotenta. Vi tillämpar en begränsad chunk i taget
        // men flyttar inte Dropbox-cursorn förrän hela sidan är klar. Ett avbrott
        // ger därför säker omhämtning utan att hundratals MB måste ligga i minnet.
        for (const batch of batches) {
          await this.repository.applyRemoteOps(batch.ops);
          downloadedOps += batch.ops.length;
          downloadedBatches += 1;
        }
        await onProgress?.({
          phase: 'batches',
          checkpointLoaded: checkpoint.loaded,
          downloadedOps,
          downloadedBatches,
          skippedBatches,
          quarantinedBatches: quarantinedBatches.length,
          pageBatches: entries.length,
          pageProcessed: Math.min(offset + chunk.length, entries.length),
        });
      }
      cursor = page.cursor;
      await this.repository.store.putMeta(`${this.keyPrefix}:cursor`, cursor);
      if (!page.has_more) break;
    }
    await this.repository.saveSnapshot();
    return {
      downloadedOps,
      downloadedBatches,
      skippedBatches,
      quarantinedBatches,
      cursor,
      cursorReset: resetUsed,
      checkpointLoaded: checkpoint.loaded,
      checkpointError: checkpoint.error || null,
    };
  }

  async syncOnce() {
    const upload = await this.uploadLocal();
    const download = await this.downloadRemote();
    return { ...upload, ...download };
  }

  async waitAndSync({ timeoutMs = 30_000 } = {}) {
    let cursor = await this.repository.store.getMeta(`${this.keyPrefix}:cursor`);
    if (!cursor) {
      await this.syncOnce();
      cursor = await this.repository.store.getMeta(`${this.keyPrefix}:cursor`);
    }
    const result = await this.transport.waitForChanges(cursor, { timeoutMs });
    if (!result.changes) return { changes: false, backoff: result.backoff ?? null };
    return { changes: true, backoff: result.backoff ?? null, ...await this.syncOnce() };
  }
}
