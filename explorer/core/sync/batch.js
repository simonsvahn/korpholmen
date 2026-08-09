import { cloneJson } from '../domain/canonical.js';
import { parseHLC } from '../domain/hlc.js';
import { validateOperation } from '../domain/operations.js';

export const DEFAULT_MAX_FUTURE_CLOCK_DRIFT_MS = 24 * 60 * 60 * 1000;

export function batchPath(deviceId, fromSeq, toSeq, rootPath = '/ops') {
  const root = String(rootPath || '/ops').replace(/\/$/, '');
  if (!root.startsWith('/') || root.includes('..')) throw new TypeError('Ogiltig operationsmapp');
  return `${root}/${encodeURIComponent(deviceId)}-${String(fromSeq).padStart(10, '0')}-${String(toSeq).padStart(10, '0')}.json`;
}

export function parseBatchPath(pathValue, rootPath = '/ops') {
  const path = String(pathValue || '');
  const root = String(rootPath || '/ops').replace(/\/$/, '');
  if (!path.startsWith(`${root}/`)) return null;
  const filename = path.slice(root.length + 1);
  const match = filename.match(/^(.+)-(\d{10})-(\d{10})\.json$/);
  if (!match) return null;
  let deviceId;
  try { deviceId = decodeURIComponent(match[1]); }
  catch { return null; }
  const fromSeq = Number(match[2]);
  const toSeq = Number(match[3]);
  if (!deviceId || !Number.isSafeInteger(fromSeq) || !Number.isSafeInteger(toSeq) || fromSeq < 1 || toSeq < fromSeq) return null;
  return { deviceId, fromSeq, toSeq };
}

export function createBatch(ops) {
  if (!Array.isArray(ops) || !ops.length) throw new TypeError('En op-batch får inte vara tom');
  const sorted = [...ops].sort((a, b) => a.seq - b.seq);
  sorted.forEach(validateOperation);
  const deviceId = sorted[0].device_id;
  if (sorted.some(op => op.device_id !== deviceId)) throw new Error('En batch får bara innehålla en enhet');
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].seq !== sorted[index - 1].seq + 1) throw new Error('En batch måste ha sammanhängande sekvenser');
  }
  const fromSeq = sorted[0].seq;
  const toSeq = sorted.at(-1).seq;
  return {
    batch_version: 1,
    device_id: deviceId,
    from_seq: fromSeq,
    to_seq: toSeq,
    ops: sorted.map(cloneJson)
  };
}

export function validateBatch(batch) {
  if (!batch || batch.batch_version !== 1 || typeof batch.device_id !== 'string' || !Array.isArray(batch.ops) || !batch.ops.length) throw new TypeError('Ogiltig op-batch');
  const normalized = createBatch(batch.ops);
  if (normalized.device_id !== batch.device_id || normalized.from_seq !== batch.from_seq || normalized.to_seq !== batch.to_seq) throw new Error('Batchens metadata matchar inte operationerna');
  return batch;
}

export function validateBatchEnvelope(entry, batch, {
  rootPath = '/ops',
  now = Date.now(),
  maxFutureClockDriftMs = DEFAULT_MAX_FUTURE_CLOCK_DRIFT_MS,
} = {}) {
  validateBatch(batch);
  const descriptor = parseBatchPath(entry?.path, rootPath);
  if (!descriptor
    || descriptor.deviceId !== batch.device_id
    || descriptor.fromSeq !== batch.from_seq
    || descriptor.toSeq !== batch.to_seq) {
    throw new TypeError('Batchens sökväg matchar inte innehållet');
  }
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Klockan gav en ogiltig tid');
  if (!Number.isSafeInteger(maxFutureClockDriftMs) || maxFutureClockDriftMs < 0) throw new TypeError('Ogiltig framtidsgräns för HLC');
  const latestAllowed = now + maxFutureClockDriftMs;
  if (batch.ops.some(operation => parseHLC(operation.hlc).wallTime > latestAllowed)) {
    throw new TypeError('Batchens HLC ligger orimligt långt fram i tiden');
  }
  return batch;
}
