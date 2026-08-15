import {
  FASTIGHETER_WRITER_CONTRACT,
  MasterRepository,
  MasterValidationError,
  RevisionMasterStorage,
  applyMasterChange,
  assertWriterDomainFields,
} from '../master-data-v2/index.js';

export const FASTIGHETER_POINTER_PATH = '/fastigheter-generation2/active.json';

const clone = value => value == null ? value : structuredClone(value);
const protectedFields = new Set(['id', 'updated_at', 'updated_by', 'deleted_at', 'deleted_by']);

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new MasterValidationError(`${label} krävs`);
  return value.trim();
}

function editableFields(collection) {
  const fields = FASTIGHETER_WRITER_CONTRACT[collection];
  if (!fields) throw new MasterValidationError(`Samlingen ${collection} kan inte ändras i Fastigheter`);
  return new Set(fields.filter(field => !protectedFields.has(field)));
}

function activeRecord(master, collection, entityId) {
  return (master.data[collection] || []).find(row => row.id === entityId && !row.deleted_at) || null;
}

function mutationForPatch(master, collectionValue, entityIdValue, patchValue) {
  const collection = requireText(collectionValue, 'Samling');
  const entityId = requireText(entityIdValue, 'Post-id');
  if (!patchValue || typeof patchValue !== 'object' || Array.isArray(patchValue)) {
    throw new MasterValidationError('Ändringen måste vara ett objekt');
  }
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
  return {
    collection,
    entity_id: entityId,
    action: 'upsert',
    set,
    ...(unset.length ? { unset } : {}),
  };
}

export class FastigheterWriter {
  constructor({
    transport,
    pendingStore,
    changedBy = 'simon',
    pointerPath = FASTIGHETER_POINTER_PATH,
    now = () => new Date().toISOString(),
    createId = () => crypto.randomUUID(),
  } = {}) {
    this.changedBy = changedBy;
    this.now = now;
    this.createId = createId;
    this.storage = new RevisionMasterStorage({
      app: 'fastigheter',
      pointerPath,
      transport,
      pendingStore,
      pendingKey: 'master-data-v2:fastigheter:pending',
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
    const mutations = records.map(record => mutationForPatch(
      current.master,
      record?.collection,
      record?.entity_id,
      record?.patch,
    ));
    const request = {
      change_id: `fastigheter:${this.createId()}`,
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

  saveProperty(propertyId, patch, options) {
    return this.saveRecords([{ collection: 'properties', entity_id: propertyId, patch }], options);
  }

  saveTimelineEntry(entryId, patch, options) {
    return this.saveRecords([{ collection: 'timeline_entries', entity_id: entryId, patch }], options);
  }

  saveAffiliation(affiliationId, patch, options) {
    return this.saveRecords([{ collection: 'affiliations', entity_id: affiliationId, patch }], options);
  }

  savePropertyParty(partyId, patch, options) {
    return this.saveRecords([{ collection: 'property_parties', entity_id: partyId, patch }], options);
  }
}

export function createFastigheterWriter(options) {
  return new FastigheterWriter(options);
}
