import { HistoryPendingError, MasterConflictError, MasterValidationError } from './errors.js';
import { applyMasterChange } from './master.js';

function requireStorage(storage) {
  for (const method of ['loadMaster', 'compareAndSwap', 'putHistoryReceipt', 'getHistoryReceipt', 'enqueuePending', 'updatePending', 'getPending', 'removePending']) {
    if (typeof storage?.[method] !== 'function') throw new TypeError(`Lagringsadaptern saknar ${method}()`);
  }
}

export class MasterRepository {
  constructor(storage) {
    requireStorage(storage);
    this.storage = storage;
  }

  async save(request) {
    if (!request || typeof request !== 'object') throw new MasterValidationError('Sparbegäran måste vara ett objekt');
    if (typeof request.change_id !== 'string' || !request.change_id.trim()) throw new MasterValidationError('change_id krävs');
    if (!Number.isSafeInteger(request.expected_master_revision) || request.expected_master_revision < 0) throw new MasterValidationError('expected_master_revision måste vara ett icke-negativt heltal');
    if (request.expected_storage_revision === null || request.expected_storage_revision === undefined) throw new MasterValidationError('expected_storage_revision krävs');
    await this.storage.enqueuePending(request);

    const existingReceipt = await this.storage.getHistoryReceipt(request.change_id);
    if (existingReceipt) {
      await this.storage.removePending(request.change_id);
      const current = await this.storage.loadMaster();
      return { ...current, receipt: existingReceipt, idempotent: true };
    }

    const pending = await this.storage.getPending(request.change_id);
    if (pending?.state === 'master_committed' && pending.receipt) {
      return this.#finishReceipt(request.change_id, pending.receipt, true);
    }

    const current = await this.storage.loadMaster();
    if (current.master.last_change_id === request.change_id && pending?.receipt) {
      await this.storage.updatePending(request.change_id, { state: 'master_committed' });
      return this.#finishReceipt(request.change_id, pending.receipt, true);
    }

    if (current.master.master_revision !== request.expected_master_revision || current.storage_revision !== request.expected_storage_revision) {
      await this.storage.updatePending(request.change_id, {
        state: 'conflict',
        conflict_master_revision: current.master.master_revision,
        conflict_storage_revision: current.storage_revision,
      });
      throw new MasterConflictError('Mastern har ändrats på en annan klient', {
        expected_master_revision: request.expected_master_revision,
        current_master_revision: current.master.master_revision,
        expected_storage_revision: request.expected_storage_revision,
        current_storage_revision: current.storage_revision,
      });
    }

    let applied;
    try {
      applied = await applyMasterChange(current.master, request);
    } catch (error) {
      if (error instanceof MasterValidationError) {
        await this.storage.updatePending(request.change_id, { state: 'validation_error', validation_error: error.message });
      }
      throw error;
    }
    await this.storage.updatePending(request.change_id, { state: 'prepared', receipt: applied.receipt });
    const committed = await this.storage.compareAndSwap({
      expected_storage_revision: request.expected_storage_revision,
      expected_master_revision: request.expected_master_revision,
      master: applied.master,
    });
    if (!committed.ok) {
      await this.storage.updatePending(request.change_id, {
        state: 'conflict',
        conflict_master_revision: committed.master.master_revision,
        conflict_storage_revision: committed.storage_revision,
      });
      throw new MasterConflictError('Mastern ändrades under sparningen', {
        expected_master_revision: request.expected_master_revision,
        current_master_revision: committed.master.master_revision,
        expected_storage_revision: request.expected_storage_revision,
        current_storage_revision: committed.storage_revision,
      });
    }
    await this.storage.updatePending(request.change_id, { state: 'master_committed' });
    return this.#finishReceipt(request.change_id, applied.receipt, false);
  }

  async #finishReceipt(changeId, receipt, idempotent) {
    try {
      await this.storage.putHistoryReceipt(receipt);
      await this.storage.removePending(changeId);
      const current = await this.storage.loadMaster();
      return { ...current, receipt, idempotent };
    } catch (error) {
      throw new HistoryPendingError('Masterrevisionen är sparad men ändringskvittot väntar på synkning', {
        change_id: changeId,
        cause: error.message,
      });
    }
  }
}
