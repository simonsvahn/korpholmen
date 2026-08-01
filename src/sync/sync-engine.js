import { createBatch, validateBatch } from './batch.js?v=2026-08-01-8';
import { CursorResetError, TransportError } from './errors.js?v=2026-08-01-8';

const isBatchPath = path => /^\/ops\/.+\.json$/.test(path);
const defaultSleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

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
    maxRateLimitRetries = 1,
    sleep = defaultSleep
  }) {
    if (!repository?.initialized) throw new TypeError('SyncEngine kräver initierad Repository');
    if (!transport || typeof transport.putBatch !== 'function' || typeof transport.listChanges !== 'function' || typeof transport.getJson !== 'function') throw new TypeError('SyncEngine kräver transport');
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new TypeError('Ogiltig batchstorlek');
    if (!Number.isSafeInteger(downloadConcurrency) || downloadConcurrency < 1) throw new TypeError('Ogiltig samtidighetsgräns');
    if (!Number.isSafeInteger(maxRateLimitRetries) || maxRateLimitRetries < 0) throw new TypeError('Ogiltigt antal 429-omtag');
    if (typeof sleep !== 'function') throw new TypeError('SyncEngine kräver en väntfunktion');
    this.repository = repository;
    this.transport = transport;
    this.batchSize = batchSize;
    this.downloadConcurrency = downloadConcurrency;
    this.maxRateLimitRetries = maxRateLimitRetries;
    this.sleep = sleep;
    this.keyPrefix = `sync:${transport.id || 'transport'}`;
    this.uploadedSeqKey = `${this.keyPrefix}:uploaded_seq:${repository.deviceId}`;
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
    const all = await this.repository.store.getAllOps();
    const pending = all
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

  async downloadRemote({ allowCursorReset = true } = {}) {
    let cursor = await this.repository.store.getMeta(`${this.keyPrefix}:cursor`);
    let downloadedOps = 0;
    let downloadedBatches = 0;
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
      const entries = page.entries.filter(entry => isBatchPath(entry.path));
      const batches = await mapConcurrent(entries, this.downloadConcurrency, async entry => {
        const batch = await this.withRateLimitRetry(() => this.transport.getJson(entry.path));
        validateBatch(batch);
        return batch;
      });
      // Tillämpning och cursorflytt sker först när hela sidan är säkert hämtad.
      // Ett avbrott kan därför aldrig lämna en halvtillämpad sida med flyttad cursor.
      for (const batch of batches) {
        await this.repository.applyRemoteOps(batch.ops);
        downloadedOps += batch.ops.length;
        downloadedBatches += 1;
      }
      cursor = page.cursor;
      await this.repository.store.putMeta(`${this.keyPrefix}:cursor`, cursor);
      if (!page.has_more) break;
    }
    return { downloadedOps, downloadedBatches, cursor, cursorReset: resetUsed };
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
