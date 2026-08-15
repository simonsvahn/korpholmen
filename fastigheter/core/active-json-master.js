import { cloneJson } from './domain/canonical.js';
import { sha256Hex } from './sync/checkpoint-format.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
const CACHE_VERSION = 1;

const parseJsonBytes = (bytes, label) => {
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error(`${label} innehåller ogiltig JSON`); }
};

const pointerDirectory = path => path.slice(0, path.lastIndexOf('/')) || '/';

function resolveRelativePath(pointerPath, relativePath) {
  const relative = String(relativePath || '');
  if (!relative || relative.startsWith('/') || relative.includes('..') || relative.includes('\\')) {
    throw new TypeError('Den aktiva mastern har en ogiltig relativ sökväg');
  }
  return `${pointerDirectory(pointerPath)}/${relative}`.replace(/\/+/g, '/');
}

function validatePointer(pointer, expectedApp) {
  if (!pointer || pointer.schema_version !== 1 || pointer.app !== expectedApp) throw new TypeError(`Ogiltig aktiv pekare för ${expectedApp}`);
  const readOnly = pointer.mode === 'read_only' && pointer.writer_enabled === false;
  const readWrite = pointer.mode === 'read_write' && pointer.writer_enabled === true;
  if (!readOnly && !readWrite) throw new Error(`${expectedApp}-pekaren har en inkonsekvent läs-/skrivstatus`);
  if (!Number.isSafeInteger(pointer.master_revision) || pointer.master_revision < 1) throw new TypeError(`${expectedApp}-pekaren saknar giltig revision`);
  if (!SHA256_RE.test(String(pointer.master_sha256 || ''))) throw new TypeError(`${expectedApp}-pekaren saknar giltig SHA-256`);
  if (typeof pointer.master_relative_path !== 'string') throw new TypeError(`${expectedApp}-pekaren saknar masterfil`);
  return pointer;
}

function validateMaster(master, pointer, expectedApp, requiredCollections) {
  if (!master || master.schema_version !== 1 || master.app !== expectedApp || !master.data || typeof master.data !== 'object') {
    throw new TypeError(`Ogiltig ${expectedApp}-master`);
  }
  if (master.master_revision !== pointer.master_revision) throw new Error(`${expectedApp}-mastern har annan revision än den aktiva pekaren`);
  for (const collection of requiredCollections) {
    if (!Array.isArray(master.data[collection])) throw new TypeError(`${expectedApp}-mastern saknar listan ${collection}`);
  }
  return master;
}

function validateCachedState(value, expectedApp, requiredCollections) {
  if (!value || value.cache_version !== CACHE_VERSION || !value.pointer || !value.master) return null;
  const pointer = validatePointer(value.pointer, expectedApp);
  const master = validateMaster(value.master, pointer, expectedApp, requiredCollections);
  return { pointer, master, masterPath: value.master_path || null };
}

export class ActiveJsonMaster {
  constructor({ store, cacheKey, pointerPath, app, requiredCollections = [] } = {}) {
    if (!store || typeof store.getSnapshot !== 'function' || typeof store.saveSnapshot !== 'function') {
      throw new TypeError('ActiveJsonMaster kräver ett snapshotlager');
    }
    this.store = store;
    this.cacheKey = String(cacheKey || '').trim();
    this.pointerPath = String(pointerPath || '').trim();
    this.app = String(app || '').trim();
    this.requiredCollections = [...new Set(requiredCollections.map(value => String(value || '').trim()).filter(Boolean))];
    if (!this.cacheKey || !this.pointerPath.startsWith('/') || !this.app) throw new TypeError('ActiveJsonMaster kräver cacheKey, absolut pointerPath och app');
    this.snapshotKey = `active-json-master:${this.cacheKey}:snapshot`;
    this.state = null;
    this.initialized = false;
    this.revision = 0;
  }

  async init() {
    const cached = await this.store.getSnapshot(this.snapshotKey);
    this.state = cached ? validateCachedState(cached, this.app, this.requiredCollections) : null;
    this.initialized = true;
    this.revision += 1;
    return this;
  }

  assertReady() {
    if (!this.initialized) throw new Error('ActiveJsonMaster.init() måste köras först');
  }

  get pointer() {
    this.assertReady();
    return this.state ? cloneJson(this.state.pointer) : null;
  }

  get masterRevision() {
    this.assertReady();
    return this.state?.pointer.master_revision || 0;
  }

  get master() {
    this.assertReady();
    return this.state ? cloneJson(this.state.master) : null;
  }

  hasData() {
    this.assertReady();
    return Boolean(this.state);
  }

  list(collection, { includeDeleted = false } = {}) {
    this.assertReady();
    if (!this.state) return [];
    const rows = this.state.master.data[collection];
    if (!Array.isArray(rows)) return [];
    return rows.filter(row => includeDeleted || !row?.deleted_at).map(cloneJson);
  }

  get(collection, id, options) {
    this.assertReady();
    return this.list(collection, options).find(row => row?.id === id) || null;
  }

  async sync(transport) {
    this.assertReady();
    if (typeof transport?.getBytes !== 'function') throw new TypeError('Den nya masterläsaren kräver en byte-lästransport');
    const pointerBytes = await transport.getBytes(this.pointerPath);
    const pointer = validatePointer(parseJsonBytes(pointerBytes, `${this.app}-pekaren`), this.app);
    const masterPath = resolveRelativePath(this.pointerPath, pointer.master_relative_path);
    const masterBytes = await transport.getBytes(masterPath);
    const actualHash = await sha256Hex(masterBytes);
    if (actualHash !== pointer.master_sha256) throw new Error(`${this.app}-masterns SHA-256 stämmer inte`);
    const master = validateMaster(parseJsonBytes(masterBytes, `${this.app}-mastern`), pointer, this.app, this.requiredCollections);
    const previousHash = this.state?.pointer.master_sha256 || null;
    await this.store.saveSnapshot(this.snapshotKey, {
      cache_version: CACHE_VERSION,
      pointer,
      master,
      master_path: masterPath,
      cached_at: new Date().toISOString(),
    });
    this.state = { pointer, master, masterPath };
    const changed = previousHash !== pointer.master_sha256;
    if (changed) this.revision += 1;
    return { changed, app: this.app, masterRevision: pointer.master_revision, masterSha256: pointer.master_sha256 };
  }
}
