import { canonicalStringify } from './master.js';
import { assertMaster, cloneJson } from './validation.js';

export class MemoryMasterStorage {
  constructor(master) {
    assertMaster(master);
    this.master = cloneJson(master);
    this.storageRevisionNumber = 0;
    this.receipts = new Map();
    this.pending = new Map();
    this.failReceiptWrites = 0;
  }

  storageRevision() {
    return `memory-${this.storageRevisionNumber}`;
  }

  async loadMaster() {
    return { master: cloneJson(this.master), storage_revision: this.storageRevision() };
  }

  async compareAndSwap({ expected_storage_revision, expected_master_revision, master }) {
    assertMaster(master, { app: this.master.app });
    if (expected_storage_revision !== this.storageRevision() || expected_master_revision !== this.master.master_revision) {
      return { ok: false, ...(await this.loadMaster()) };
    }
    this.master = cloneJson(master);
    this.storageRevisionNumber += 1;
    return { ok: true, ...(await this.loadMaster()) };
  }

  async putHistoryReceipt(receipt) {
    if (this.failReceiptWrites > 0) {
      this.failReceiptWrites -= 1;
      throw new Error('Simulerat historikfel');
    }
    const previous = this.receipts.get(receipt.change_id);
    if (previous && canonicalStringify(previous) !== canonicalStringify(receipt)) throw new Error(`Kolliderande ändringskvitto: ${receipt.change_id}`);
    this.receipts.set(receipt.change_id, cloneJson(receipt));
  }

  async getHistoryReceipt(changeId) {
    const value = this.receipts.get(changeId);
    return value ? cloneJson(value) : null;
  }

  async enqueuePending(change) {
    const previous = this.pending.get(change.change_id);
    if (previous && canonicalStringify(previous.request) !== canonicalStringify(change)) throw new Error(`Kolliderande lokalt change_id: ${change.change_id}`);
    if (!previous) this.pending.set(change.change_id, { request: cloneJson(change), state: 'queued', receipt: null });
  }

  async updatePending(changeId, patch) {
    const previous = this.pending.get(changeId);
    if (!previous) throw new Error(`Väntande ändring saknas: ${changeId}`);
    this.pending.set(changeId, { ...previous, ...cloneJson(patch) });
  }

  async getPending(changeId) {
    const value = this.pending.get(changeId);
    return value ? cloneJson(value) : null;
  }

  async removePending(changeId) {
    this.pending.delete(changeId);
  }

  async listPending() {
    return [...this.pending.values()].map(cloneJson);
  }

  failNextHistoryReceipt(count = 1) {
    this.failReceiptWrites += count;
  }
}
