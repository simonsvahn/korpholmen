import { canonicalStringify, cloneJson } from '../domain/canonical.js';
import { operationFingerprint, validateOperation } from '../domain/operations.js';

export class MemoryStore {
  constructor() {
    this.ops = new Map();
    this.meta = new Map();
    this.snapshots = new Map();
    this.blobs = new Map();
  }

  async appendOps(ops) {
    const incoming = new Map();
    for (const op of ops) {
      validateOperation(op);
      const inBatch = incoming.get(op.op_id);
      if (inBatch && operationFingerprint(inBatch) !== operationFingerprint(op)) throw new Error(`Kollision för op_id ${op.op_id}`);
      incoming.set(op.op_id, op);
    }
    for (const op of incoming.values()) {
      const existing = this.ops.get(op.op_id);
      if (existing && operationFingerprint(existing) !== operationFingerprint(op)) throw new Error(`Kollision för op_id ${op.op_id}`);
    }
    let inserted = 0;
    for (const op of incoming.values()) {
      if (this.ops.has(op.op_id)) continue;
      this.ops.set(op.op_id, cloneJson(op));
      inserted += 1;
    }
    for (const op of incoming.values()) {
      const key = `seq:${op.device_id}`;
      const current = this.meta.get(key);
      this.meta.set(key, Math.max(Number.isSafeInteger(current) ? current : 0, op.seq));
    }
    return inserted;
  }

  async commitLocalOps({ deviceId, minimumSeq = 0, build } = {}) {
    if (typeof deviceId !== 'string' || !deviceId) throw new TypeError('commitLocalOps kräver deviceId');
    if (typeof build !== 'function') throw new TypeError('commitLocalOps kräver build');
    const key = `seq:${deviceId}`;
    const stored = this.meta.get(key);
    const current = Math.max(Number.isSafeInteger(stored) ? stored : 0, Number.isSafeInteger(minimumSeq) ? minimumSeq : 0);
    const startSeq = current + 1;
    const operations = build(startSeq);
    if (!Array.isArray(operations) || !operations.length) throw new TypeError('commitLocalOps kräver operationer');
    operations.forEach((op, index) => {
      validateOperation(op);
      if (op.device_id !== deviceId || op.seq !== startSeq + index) throw new Error('Lokal commit har fel enhet eller sekvens');
      const existing = this.ops.get(op.op_id);
      if (existing && operationFingerprint(existing) !== operationFingerprint(op)) throw new Error(`Kollision för op_id ${op.op_id}`);
    });
    for (const op of operations) this.ops.set(op.op_id, cloneJson(op));
    this.meta.set(key, operations.at(-1).seq);
    return operations.map(cloneJson);
  }

  async getAllOps() {
    return [...this.ops.values()].map(cloneJson).sort((a, b) => a.op_id.localeCompare(b.op_id));
  }

  async putMeta(key, value) {
    this.meta.set(String(key), cloneJson(value));
  }

  async getMeta(key) {
    const value = this.meta.get(String(key));
    return value === undefined ? null : cloneJson(value);
  }

  async deleteMeta(key) {
    this.meta.delete(String(key));
  }

  async saveSnapshot(id, snapshot) {
    canonicalStringify(snapshot);
    this.snapshots.set(String(id), cloneJson(snapshot));
  }

  async getSnapshot(id) {
    const value = this.snapshots.get(String(id));
    return value === undefined ? null : cloneJson(value);
  }

  async putBlob(key, value, { pendingUpload = false } = {}) {
    if (!(value instanceof Blob)) throw new TypeError('putBlob kräver en Blob');
    this.blobs.set(String(key), { value, pendingUpload: Boolean(pendingUpload) });
  }

  async getBlob(key) {
    return this.blobs.get(String(key))?.value || null;
  }

  async listPendingBlobs() {
    return [...this.blobs.entries()]
      .filter(([, entry]) => entry.pendingUpload)
      .map(([key, entry]) => ({ key, value: entry.value, updatedAt: null }));
  }

  async markBlobUploaded(key) {
    const entry = this.blobs.get(String(key));
    if (entry) entry.pendingUpload = false;
  }

  async clear() {
    this.ops.clear();
    this.meta.clear();
    this.snapshots.clear();
    this.blobs.clear();
  }
}
