import { canonicalStringify } from './master.js';
import { assertMaster, cloneJson } from './validation.js';

const SHA256_RE = /^[a-f0-9]{64}$/;

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} krävs`);
  return value.trim();
}

function normalizeAbsolutePath(value, label) {
  const path = requireText(value, label);
  if (!path.startsWith('/') || path.includes('..') || path.includes('\\')) throw new TypeError(`${label} är ogiltig`);
  return path.replace(/\/+$/, '') || '/';
}

function pointerDirectory(path) {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

function resolveRelativePath(pointerPath, relativePath) {
  const relative = requireText(relativePath, 'master_relative_path');
  if (relative.startsWith('/') || relative.includes('..') || relative.includes('\\')) throw new TypeError('master_relative_path är ogiltig');
  return `${pointerDirectory(pointerPath)}/${relative}`.replace(/\/+/g, '/');
}

function parseJsonBytes(bytes, label) {
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error(`${label} innehåller ogiltig JSON`); }
}

async function sha256Bytes(bytes, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle?.digest) throw new Error('Web Crypto med SHA-256 krävs');
  const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Text(value) {
  return sha256Bytes(new TextEncoder().encode(value));
}

function isNotFound(error) {
  return error?.status === 409 && String(error?.code || '').includes('path/not_found');
}

function assertPointer(pointer, app) {
  if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer)) throw new TypeError('Aktiv masterpekare saknas');
  if (pointer.schema_version !== 1 || pointer.app !== app) throw new TypeError(`Ogiltig aktiv pekare för ${app}`);
  if (pointer.mode !== 'read_write' || pointer.writer_enabled !== true) throw new Error(`${app}-mastern är inte aktiverad för skrivning`);
  if (!Number.isSafeInteger(pointer.master_revision) || pointer.master_revision < 0) throw new TypeError('Pekaren saknar giltig master_revision');
  if (!SHA256_RE.test(String(pointer.master_sha256 || ''))) throw new TypeError('Pekaren saknar giltig master_sha256');
  requireText(pointer.master_relative_path, 'master_relative_path');
  return pointer;
}

function requireTransport(transport) {
  for (const method of ['getBytesWithMetadata', 'getJson', 'putImmutable', 'putMutableIfRevision']) {
    if (typeof transport?.[method] !== 'function') throw new TypeError(`RevisionMasterStorage kräver transport.${method}()`);
  }
}

function requirePendingStore(store) {
  for (const method of ['getMeta', 'putMeta', 'deleteMeta']) {
    if (typeof store?.[method] !== 'function') throw new TypeError(`RevisionMasterStorage kräver pendingStore.${method}()`);
  }
}

export class RevisionMasterStorage {
  constructor({ app, pointerPath, transport, pendingStore, pendingKey = null } = {}) {
    this.app = requireText(app, 'app');
    this.pointerPath = normalizeAbsolutePath(pointerPath, 'pointerPath');
    requireTransport(transport);
    requirePendingStore(pendingStore);
    this.transport = transport;
    this.pendingStore = pendingStore;
    this.pendingKey = pendingKey || `master-data-v2:${this.app}:pending`;
  }

  async loadMaster() {
    const pointerFile = await this.transport.getBytesWithMetadata(this.pointerPath);
    if (typeof pointerFile.revision !== 'string' || !pointerFile.revision) throw new Error('Masterpekaren saknar lagringsrevision');
    const pointer = assertPointer(parseJsonBytes(pointerFile.value, `${this.app}-pekaren`), this.app);
    const masterPath = resolveRelativePath(this.pointerPath, pointer.master_relative_path);
    const masterFile = await this.transport.getBytesWithMetadata(masterPath);
    const actualHash = await sha256Bytes(masterFile.value);
    if (actualHash !== pointer.master_sha256) throw new Error(`${this.app}-masterns SHA-256 stämmer inte`);
    const master = parseJsonBytes(masterFile.value, `${this.app}-mastern`);
    assertMaster(master, { app: this.app });
    if (master.master_revision !== pointer.master_revision) throw new Error('Master och pekare har olika revision');
    return {
      master: cloneJson(master),
      storage_revision: pointerFile.revision,
      pointer: cloneJson(pointer),
      master_path: masterPath,
    };
  }

  async compareAndSwap({ expected_storage_revision, expected_master_revision, master }) {
    assertMaster(master, { app: this.app });
    const current = await this.loadMaster();
    if (current.storage_revision !== expected_storage_revision || current.master.master_revision !== expected_master_revision) {
      return { ok: false, ...current };
    }
    if (master.master_revision !== expected_master_revision + 1) throw new Error('Nästa master måste öka master_revision exakt ett steg');

    const masterBytes = new TextEncoder().encode(JSON.stringify(master));
    const masterSha256 = await sha256Bytes(masterBytes);
    const relativePath = `revisions/revision-${master.master_revision}-${masterSha256.slice(0, 12)}/master.json`;
    const masterPath = resolveRelativePath(this.pointerPath, relativePath);
    await this.transport.putImmutable(masterPath, master);

    const nextPointer = {
      ...current.pointer,
      mode: 'read_write',
      writer_enabled: true,
      master_revision: master.master_revision,
      master_sha256: masterSha256,
      master_relative_path: relativePath,
      updated_at: master.updated_at,
      updated_by: master.updated_by,
    };
    const committed = await this.transport.putMutableIfRevision(this.pointerPath, nextPointer, expected_storage_revision);
    if (!committed.ok) return { ok: false, ...(await this.loadMaster()) };
    const loaded = await this.loadMaster();
    return { ok: true, ...loaded };
  }

  async historyPath(changeId) {
    const digest = await sha256Text(requireText(changeId, 'changeId'));
    return `${pointerDirectory(this.pointerPath)}/history/${digest}.json`.replace(/\/+/g, '/');
  }

  async putHistoryReceipt(receipt) {
    if (!receipt || receipt.app !== this.app) throw new TypeError('Ändringskvittot avser fel app');
    return this.transport.putImmutable(await this.historyPath(receipt.change_id), receipt);
  }

  async getHistoryReceipt(changeId) {
    try { return cloneJson(await this.transport.getJson(await this.historyPath(changeId))); }
    catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async readPending() {
    const value = await this.pendingStore.getMeta(this.pendingKey);
    if (value === null) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Den lokala väntande kön är skadad');
    return cloneJson(value);
  }

  async writePending(value) {
    if (Object.keys(value).length === 0) await this.pendingStore.deleteMeta(this.pendingKey);
    else await this.pendingStore.putMeta(this.pendingKey, value);
  }

  async enqueuePending(change) {
    const pending = await this.readPending();
    const previous = pending[change.change_id];
    if (previous && canonicalStringify(previous.request) !== canonicalStringify(change)) throw new Error(`Kolliderande lokalt change_id: ${change.change_id}`);
    if (!previous) {
      pending[change.change_id] = { request: cloneJson(change), state: 'queued', receipt: null };
      await this.writePending(pending);
    }
  }

  async updatePending(changeId, patch) {
    const pending = await this.readPending();
    if (!pending[changeId]) throw new Error(`Väntande ändring saknas: ${changeId}`);
    pending[changeId] = { ...pending[changeId], ...cloneJson(patch) };
    await this.writePending(pending);
  }

  async getPending(changeId) {
    const pending = await this.readPending();
    return pending[changeId] ? cloneJson(pending[changeId]) : null;
  }

  async removePending(changeId) {
    const pending = await this.readPending();
    delete pending[changeId];
    await this.writePending(pending);
  }

  async listPending() {
    return Object.values(await this.readPending()).map(cloneJson);
  }
}
