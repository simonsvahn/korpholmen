import { canonicalStringify, cloneJson } from '../domain/canonical.js';
import { operationFingerprint, validateOperation } from '../domain/operations.js';

const DB_VERSION = 2;

const requestResult = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const transactionDone = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = () => reject(transaction.error || new Error('IndexedDB-transaktionen avbröts'));
  transaction.onerror = () => reject(transaction.error);
});

export async function openSlaktlandskapDB({
  indexedDB = globalThis.indexedDB,
  name = 'slaktlandskap',
  onBlocked = () => {},
  blockedTimeoutMs = 8_000,
} = {}) {
  if (!indexedDB || typeof indexedDB.open !== 'function') throw new Error('IndexedDB saknas i denna miljö');
  const request = indexedDB.open(name, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains('ops')) db.createObjectStore('ops', { keyPath: 'op_id' });
    if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'key' });
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    let blockedTimer = null;
    const clearBlockedTimer = () => {
      if (blockedTimer) clearTimeout(blockedTimer);
      blockedTimer = null;
    };
    request.onsuccess = () => {
      if (settled) {
        request.result?.close?.();
        return;
      }
      settled = true;
      clearBlockedTimer();
      resolve(request.result);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      clearBlockedTimer();
      reject(request.error);
    };
    request.onblocked = () => {
      try { onBlocked(); } catch { /* status callbacks får inte stoppa databasöppningen */ }
      if (settled || blockedTimer || !(blockedTimeoutMs > 0)) return;
      blockedTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('En annan flik blockerar uppgraderingen av den lokala databasen. Stäng äldre appflikar och försök igen.'));
      }, blockedTimeoutMs);
    };
  });
}

export class IndexedDBStore {
  constructor(db) {
    if (!db) throw new TypeError('IndexedDB-databas saknas');
    this.db = db;
  }

  async appendOps(ops) {
    const incoming = new Map();
    for (const op of ops) {
      validateOperation(op);
      const inBatch = incoming.get(op.op_id);
      if (inBatch && operationFingerprint(inBatch) !== operationFingerprint(op)) throw new Error(`Kollision för op_id ${op.op_id}`);
      incoming.set(op.op_id, op);
    }
    if (!incoming.size) return 0;

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['ops', 'meta'], 'readwrite');
      const store = transaction.objectStore('ops');
      const meta = transaction.objectStore('meta');
      let inserted = 0;
      let collision = null;
      for (const op of incoming.values()) {
        const request = store.get(op.op_id);
        request.onsuccess = () => {
          const existing = request.result;
          if (existing) {
            if (operationFingerprint(existing) !== operationFingerprint(op)) {
              collision = new Error(`Kollision för op_id ${op.op_id}`);
              transaction.abort();
            }
            return;
          }
          store.add(cloneJson(op));
          inserted += 1;
        };
        request.onerror = () => {
          collision = request.error;
          transaction.abort();
        };
      }
      const maxima = new Map();
      for (const op of incoming.values()) maxima.set(op.device_id, Math.max(maxima.get(op.device_id) || 0, op.seq));
      for (const [deviceId, maximum] of maxima) {
        const key = `seq:${deviceId}`;
        const request = meta.get(key);
        request.onsuccess = () => {
          const current = request.result?.value;
          meta.put({ key, value: Math.max(Number.isSafeInteger(current) ? current : 0, maximum) });
        };
        request.onerror = () => {
          collision = request.error;
          transaction.abort();
        };
      }
      transaction.oncomplete = () => resolve(inserted);
      transaction.onabort = () => reject(collision || transaction.error || new Error('IndexedDB-transaktionen avbröts'));
      transaction.onerror = () => reject(collision || transaction.error);
    });
  }

  async commitLocalOps({ deviceId, minimumSeq = 0, build } = {}) {
    if (typeof deviceId !== 'string' || !deviceId) throw new TypeError('commitLocalOps kräver deviceId');
    if (typeof build !== 'function') throw new TypeError('commitLocalOps kräver build');

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['ops', 'meta'], 'readwrite');
      const opStore = transaction.objectStore('ops');
      const metaStore = transaction.objectStore('meta');
      const key = `seq:${deviceId}`;
      let operations = null;
      let failure = null;
      const request = metaStore.get(key);
      request.onsuccess = () => {
        try {
          const stored = request.result?.value;
          const current = Math.max(Number.isSafeInteger(stored) ? stored : 0, Number.isSafeInteger(minimumSeq) ? minimumSeq : 0);
          const startSeq = current + 1;
          operations = build(startSeq);
          if (!Array.isArray(operations) || !operations.length) throw new TypeError('commitLocalOps kräver operationer');
          operations.forEach((op, index) => {
            validateOperation(op);
            if (op.device_id !== deviceId || op.seq !== startSeq + index) throw new Error('Lokal commit har fel enhet eller sekvens');
            opStore.add(cloneJson(op));
          });
          metaStore.put({ key, value: operations.at(-1).seq });
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      request.onerror = () => {
        failure = request.error;
        transaction.abort();
      };
      transaction.oncomplete = () => resolve(operations.map(cloneJson));
      transaction.onabort = () => reject(failure || transaction.error || new Error('IndexedDB-transaktionen avbröts'));
      transaction.onerror = () => reject(failure || transaction.error);
    });
  }

  async getAllOps() {
    const transaction = this.db.transaction('ops', 'readonly');
    const values = await requestResult(transaction.objectStore('ops').getAll());
    await transactionDone(transaction);
    return values.map(cloneJson).sort((a, b) => a.op_id.localeCompare(b.op_id));
  }

  async putMeta(key, value) {
    const transaction = this.db.transaction('meta', 'readwrite');
    transaction.objectStore('meta').put({ key: String(key), value: cloneJson(value) });
    await transactionDone(transaction);
  }

  async getMeta(key) {
    const transaction = this.db.transaction('meta', 'readonly');
    const row = await requestResult(transaction.objectStore('meta').get(String(key)));
    await transactionDone(transaction);
    return row ? cloneJson(row.value) : null;
  }

  async saveSnapshot(id, snapshot) {
    canonicalStringify(snapshot);
    const transaction = this.db.transaction('snapshots', 'readwrite');
    transaction.objectStore('snapshots').put({ id: String(id), value: cloneJson(snapshot) });
    await transactionDone(transaction);
  }

  async getSnapshot(id) {
    const transaction = this.db.transaction('snapshots', 'readonly');
    const row = await requestResult(transaction.objectStore('snapshots').get(String(id)));
    await transactionDone(transaction);
    return row ? cloneJson(row.value) : null;
  }

  async putBlob(key, value, { pendingUpload = false } = {}) {
    if (!(value instanceof Blob)) throw new TypeError('putBlob kräver en Blob');
    const transaction = this.db.transaction('blobs', 'readwrite');
    transaction.objectStore('blobs').put({
      key: String(key),
      value,
      pending_upload: Boolean(pendingUpload),
      updated_at: new Date().toISOString()
    });
    await transactionDone(transaction);
  }

  async getBlob(key) {
    const transaction = this.db.transaction('blobs', 'readonly');
    const row = await requestResult(transaction.objectStore('blobs').get(String(key)));
    await transactionDone(transaction);
    return row?.value instanceof Blob ? row.value : null;
  }

  async listPendingBlobs() {
    const transaction = this.db.transaction('blobs', 'readonly');
    const rows = await requestResult(transaction.objectStore('blobs').getAll());
    await transactionDone(transaction);
    return rows
      .filter(row => row.pending_upload && row.value instanceof Blob)
      .map(row => ({ key: row.key, value: row.value, updatedAt: row.updated_at || null }));
  }

  async markBlobUploaded(key) {
    const transaction = this.db.transaction('blobs', 'readwrite');
    const objectStore = transaction.objectStore('blobs');
    const request = objectStore.get(String(key));
    request.onsuccess = () => {
      if (!request.result) return;
      objectStore.put({ ...request.result, pending_upload: false });
    };
    await transactionDone(transaction);
  }

  close() {
    this.db.close();
  }
}
