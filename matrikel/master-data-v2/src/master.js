import { MasterValidationError } from './errors.js';
import { assertMaster, assertPersonRecord, cloneJson } from './validation.js';

function sortForCanonicalJson(value) {
  if (Array.isArray(value)) return value.map(sortForCanonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortForCanonicalJson(value[key])]));
}

export function canonicalStringify(value) {
  return JSON.stringify(sortForCanonicalJson(value));
}

async function sha256(value, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle?.digest) throw new MasterValidationError('Web Crypto med SHA-256 krävs');
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new MasterValidationError(`${label} måste vara en icke-tom sträng`);
}

function requireTimestamp(value) {
  requireText(value, 'changed_at');
  if (Number.isNaN(Date.parse(value))) throw new MasterValidationError('changed_at måste vara en giltig tidsstämpel');
}

export function createEmptyMaster(app) {
  requireText(app, 'app');
  return {
    schema_version: 1,
    architecture_generation: 2,
    app,
    master_revision: 0,
    last_change_id: null,
    updated_at: null,
    updated_by: null,
    data: {},
  };
}

function validateMutation(mutation, seen) {
  if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation)) throw new MasterValidationError('Varje mutation måste vara ett objekt');
  requireText(mutation.collection, 'mutation.collection');
  requireText(mutation.entity_id, 'mutation.entity_id');
  if (!['upsert', 'delete', 'restore'].includes(mutation.action)) throw new MasterValidationError(`Ogiltig mutation action: ${mutation.action}`);
  const key = `${mutation.collection}\u0000${mutation.entity_id}`;
  if (seen.has(key)) throw new MasterValidationError(`Samma post får bara ändras en gång per Spara: ${mutation.collection}/${mutation.entity_id}`);
  seen.add(key);
  if (mutation.action !== 'upsert' && (mutation.set !== undefined || mutation.unset !== undefined)) throw new MasterValidationError(`${mutation.action} får inte innehålla set/unset`);
  if (mutation.action === 'upsert') {
    if (mutation.set !== undefined && (!mutation.set || typeof mutation.set !== 'object' || Array.isArray(mutation.set))) throw new MasterValidationError('mutation.set måste vara ett objekt');
    if (mutation.unset !== undefined && (!Array.isArray(mutation.unset) || mutation.unset.some((field) => typeof field !== 'string' || !field))) throw new MasterValidationError('mutation.unset måste vara en array av fältnamn');
    const protectedFields = new Set(['id', 'updated_at', 'updated_by', 'deleted_at', 'deleted_by']);
    for (const field of Object.keys(mutation.set ?? {})) if (protectedFields.has(field)) throw new MasterValidationError(`Fältet ${field} hanteras av mastern`);
    for (const field of mutation.unset ?? []) if (protectedFields.has(field)) throw new MasterValidationError(`Fältet ${field} får inte tas bort via unset`);
  }
}

export async function applyMasterChange(master, change) {
  assertMaster(master);
  if (!change || typeof change !== 'object' || Array.isArray(change)) throw new MasterValidationError('Ändringen måste vara ett objekt');
  requireText(change.change_id, 'change_id');
  requireText(change.changed_by, 'changed_by');
  requireTimestamp(change.changed_at);
  if (!Number.isSafeInteger(change.expected_master_revision) || change.expected_master_revision < 0) throw new MasterValidationError('expected_master_revision måste vara ett icke-negativt heltal');
  if (change.expected_master_revision !== master.master_revision) throw new MasterValidationError('Ändringen bygger inte på masterns aktuella revision');
  if (!Array.isArray(change.mutations) || change.mutations.length === 0) throw new MasterValidationError('Minst en mutation krävs');

  const next = cloneJson(master);
  const seen = new Set();
  const changes = [];

  for (const mutation of change.mutations) {
    validateMutation(mutation, seen);
    const records = next.data[mutation.collection] ?? [];
    next.data[mutation.collection] = records;
    const index = records.findIndex((record) => record.id === mutation.entity_id);
    const before = index === -1 ? null : cloneJson(records[index]);

    if (mutation.action === 'upsert') {
      // Kvittots före-bild måste förbli oföränderlig så att ändringen kan
      // reverseras exakt. Arbeta därför på en separat kopia av posten.
      const record = before === null ? { id: mutation.entity_id } : cloneJson(before);
      Object.assign(record, cloneJson(mutation.set ?? {}));
      for (const field of mutation.unset ?? []) delete record[field];
      record.updated_at = change.changed_at;
      record.updated_by = change.changed_by;
      if (index === -1) records.push(record);
      else records[index] = record;
    } else {
      if (index === -1) throw new MasterValidationError(`Posten saknas: ${mutation.collection}/${mutation.entity_id}`);
      if (mutation.action === 'delete') {
        records[index].deleted_at = change.changed_at;
        records[index].deleted_by = change.changed_by;
      } else {
        delete records[index].deleted_at;
        delete records[index].deleted_by;
      }
      records[index].updated_at = change.changed_at;
      records[index].updated_by = change.changed_by;
    }

    const afterIndex = records.findIndex((record) => record.id === mutation.entity_id);
    changes.push({
      collection: mutation.collection,
      entity_id: mutation.entity_id,
      action: mutation.action,
      before,
      after: cloneJson(records[afterIndex]),
    });
  }

  next.master_revision += 1;
  next.last_change_id = change.change_id;
  next.updated_at = change.changed_at;
  next.updated_by = change.changed_by;
  assertMaster(next, { app: master.app });
  if (master.app === 'people') {
    for (const item of changes.filter(item => item.collection === 'people' && item.before === null)) {
      assertPersonRecord(item.after, `ny person ${item.entity_id}`);
    }
  }

  const beforeHash = await sha256(canonicalStringify(master));
  const afterHash = await sha256(canonicalStringify(next));
  const receipt = {
    schema_version: 1,
    change_id: change.change_id,
    app: master.app,
    base_master_revision: master.master_revision,
    new_master_revision: next.master_revision,
    before_sha256: beforeHash,
    after_sha256: afterHash,
    changed_at: change.changed_at,
    changed_by: change.changed_by,
    manual_comment: typeof change.manual_comment === 'string' ? change.manual_comment : '',
    changes,
  };

  return { master: next, receipt };
}
