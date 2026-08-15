import {
  BATREGISTER_WRITER_CONTRACT,
  MasterRepository,
  MasterValidationError,
  RevisionMasterStorage,
  applyMasterChange,
  assertWriterDomainFields,
} from '../master-data-v2/index.js';

export const BATREGISTER_POINTER_PATH = '/batregister-generation2/active.json';

const clone = value => value == null ? value : structuredClone(value);
const protectedFields = new Set(['id', 'updated_at', 'updated_by', 'deleted_at', 'deleted_by']);

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new MasterValidationError(`${label} krävs`);
  return value.trim();
}

function editableFields(collection) {
  const fields = BATREGISTER_WRITER_CONTRACT[collection];
  if (!fields) throw new MasterValidationError(`Samlingen ${collection} kan inte ändras i Båtregistret`);
  return new Set(fields.filter(field => !protectedFields.has(field)));
}

function activeRecord(master, collection, entityId) {
  return (master.data[collection] || []).find(row => row.id === entityId && !row.deleted_at) || null;
}

function mutationForPatch(master, collectionValue, entityIdValue, patchValue) {
  const collection = requireText(collectionValue, 'Samling');
  const entityId = requireText(entityIdValue, 'Post-id');
  if (!patchValue || typeof patchValue !== 'object' || Array.isArray(patchValue)) throw new MasterValidationError('Ändringen måste vara ett objekt');
  const allowed = editableFields(collection);
  const current = activeRecord(master, collection, entityId);
  const set = {};
  const unset = [];
  for (const [field, value] of Object.entries(patchValue)) {
    if (!allowed.has(field)) throw new MasterValidationError(`Fältet ${collection}.${field} kan inte ändras här`);
    if (value === undefined) continue;
    if (value === null) {
      if (current && Object.hasOwn(current, field)) unset.push(field);
    } else if (!current || JSON.stringify(current[field]) !== JSON.stringify(value)) {
      set[field] = clone(value);
    }
  }
  if (!Object.keys(set).length && !unset.length) throw new MasterValidationError('Ingenting har ändrats');
  return { collection, entity_id: entityId, action: 'upsert', set, ...(unset.length ? { unset } : {}) };
}

function mutationForAction(master, collectionValue, entityIdValue, action) {
  const collection = requireText(collectionValue, 'Samling');
  const entityId = requireText(entityIdValue, 'Post-id');
  editableFields(collection);
  const records = master.data[collection] || [];
  const record = records.find(row => row.id === entityId) || null;
  if (!record) throw new MasterValidationError(`Posten saknas: ${collection}/${entityId}`);
  if (action === 'delete' && record.deleted_at) throw new MasterValidationError('Posten är redan borttagen');
  if (action === 'restore' && !record.deleted_at) throw new MasterValidationError('Posten är inte borttagen');
  return { collection, entity_id: entityId, action };
}

export class BatregisterWriter {
  constructor({
    transport,
    pendingStore,
    changedBy = 'simon',
    pointerPath = BATREGISTER_POINTER_PATH,
    now = () => new Date().toISOString(),
    createId = () => crypto.randomUUID(),
  } = {}) {
    this.changedBy = changedBy;
    this.now = now;
    this.createId = createId;
    this.storage = new RevisionMasterStorage({
      app: 'batregister', pointerPath, transport, pendingStore,
      pendingKey: 'master-data-v2:batregister:pending',
    });
    this.repository = new MasterRepository(this.storage);
    this.current = null;
  }

  async load() {
    const current = await this.storage.loadMaster();
    assertWriterDomainFields(current.master, { allowMissingCollections: false });
    this.current = current;
    return clone(current);
  }

  async saveRecords(records, { manualComment = '' } = {}) {
    if (!Array.isArray(records) || !records.length) throw new MasterValidationError('Minst en ändring krävs');
    const current = this.current || await this.load();
    const mutations = records.map(record => mutationForPatch(current.master, record?.collection, record?.entity_id, record?.patch));
    const request = {
      change_id: `batregister:${this.createId()}`,
      expected_master_revision: current.master.master_revision,
      expected_storage_revision: current.storage_revision,
      changed_at: this.now(),
      changed_by: this.changedBy,
      manual_comment: typeof manualComment === 'string' ? manualComment.trim() : '',
      mutations,
    };
    const preview = await applyMasterChange(current.master, request);
    assertWriterDomainFields(preview.master, { allowMissingCollections: false });
    const saved = await this.repository.save(request);
    assertWriterDomainFields(saved.master, { allowMissingCollections: false });
    this.current = saved;
    return clone(saved);
  }

  async applyActions(records, { manualComment = '' } = {}) {
    if (!Array.isArray(records) || !records.length) throw new MasterValidationError('Minst en ändring krävs');
    const current = this.current || await this.load();
    const mutations = records.map(record => mutationForAction(current.master, record?.collection, record?.entity_id, record?.action));
    const request = {
      change_id: `batregister:${this.createId()}`,
      expected_master_revision: current.master.master_revision,
      expected_storage_revision: current.storage_revision,
      changed_at: this.now(),
      changed_by: this.changedBy,
      manual_comment: typeof manualComment === 'string' ? manualComment.trim() : '',
      mutations,
    };
    const preview = await applyMasterChange(current.master, request);
    assertWriterDomainFields(preview.master, { allowMissingCollections: false });
    const saved = await this.repository.save(request);
    assertWriterDomainFields(saved.master, { allowMissingCollections: false });
    this.current = saved;
    return clone(saved);
  }

  saveBoat(boatId, patch, options) {
    return this.saveRecords([{ collection: 'boats', entity_id: boatId, patch }], options);
  }

  saveIdentityRedirect(redirectId, patch, options) {
    return this.saveRecords([{ collection: 'identity_redirects', entity_id: redirectId, patch }], options);
  }


  deleteBoat(boatId, options) {
    return this.applyActions([{ collection: 'boats', entity_id: boatId, action: 'delete' }], options);
  }

  restoreBoat(boatId, options) {
    return this.applyActions([{ collection: 'boats', entity_id: boatId, action: 'restore' }], options);
  }
}

export function createBatregisterWriter(options) {
  return new BatregisterWriter(options);
}
