import { MasterValidationError } from './errors.js';

function fail(message) {
  throw new MasterValidationError(message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} måste vara en icke-tom sträng`);
}

function assertOptionalTimestamp(value, label) {
  if (value === null || value === undefined) return;
  assertNonEmptyString(value, label);
  if (Number.isNaN(Date.parse(value))) fail(`${label} måste vara en giltig tidsstämpel`);
}

export function cloneJson(value) {
  const stack = new WeakSet();
  const inspect = (entry, path) => {
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return;
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) fail(`${path} innehåller ett icke-ändligt tal`);
      return;
    }
    if (typeof entry !== 'object') fail(`${path} är inte JSON-kompatibelt`);
    if (stack.has(entry)) fail(`${path} innehåller en cirkulär referens`);
    stack.add(entry);
    if (Array.isArray(entry)) entry.forEach((item, index) => inspect(item, `${path}[${index}]`));
    else {
      if (!isPlainObject(entry)) fail(`${path} måste vara ett vanligt JSON-objekt`);
      for (const [key, item] of Object.entries(entry)) inspect(item, `${path}.${key}`);
    }
    stack.delete(entry);
  };
  inspect(value, 'värde');
  const text = JSON.stringify(value);
  if (text === undefined) {
    fail('Värdet är inte JSON-kompatibelt');
  }
  return JSON.parse(text);
}

export function assertStableReference(reference, label = 'referens') {
  if (!isPlainObject(reference)) fail(`${label} måste vara ett objekt`);
  assertNonEmptyString(reference.master, `${label}.master`);
  assertNonEmptyString(reference.entity_type, `${label}.entity_type`);
  assertNonEmptyString(reference.entity_id, `${label}.entity_id`);
  return reference;
}

export function assertStructuredTime(value, label = 'tid') {
  if (!isPlainObject(value)) fail(`${label} måste vara ett objekt`);
  if (!['point', 'period', 'observation'].includes(value.kind)) fail(`${label}.kind är ogiltig`);
  if (value.original_text !== undefined && typeof value.original_text !== 'string') fail(`${label}.original_text måste vara text`);
  for (const field of ['start_min', 'start_max', 'end_min', 'end_max']) {
    if (value[field] !== undefined && value[field] !== null && !Number.isFinite(value[field])) fail(`${label}.${field} måste vara ett tal eller null`);
  }
  if (value.precision !== undefined && !['day', 'month', 'year', 'decade'].includes(value.precision)) fail(`${label}.precision är ogiltig`);
  if (value.qualifier !== undefined && value.qualifier !== null && !['about', 'before', 'after', 'early', 'middle', 'late'].includes(value.qualifier)) fail(`${label}.qualifier är ogiltig`);
  if (value.ongoing !== undefined && typeof value.ongoing !== 'boolean') fail(`${label}.ongoing måste vara boolean`);
  return value;
}

export const STRUCTURED_EVENT_TYPES = Object.freeze([
  'observed',
  'manufactured',
  'name_decided',
  'renamed',
  'ownership',
  'purchased',
  'sold',
  'registered',
  'deregistered',
  'other',
]);

export const BOAT_CATEGORIES = Object.freeze([
  'motorboat',
  'sailboat',
  'rowboat',
  'kayak',
  'surfboard',
  'other',
]);

export function assertBoatCategory(value, label = 'båtkategori') {
  if (!BOAT_CATEGORIES.includes(value)) fail(`${label} är ogiltig`);
  return value;
}

export function assertPersonRecord(value, label = 'person') {
  if (!isPlainObject(value)) fail(`${label} måste vara ett objekt`);
  assertNonEmptyString(value.id, `${label}.id`);
  assertNonEmptyString(value.display_name, `${label}.display_name`);
  if (value.aliases !== undefined) {
    if (!Array.isArray(value.aliases)) fail(`${label}.aliases måste vara en lista`);
    value.aliases.forEach((alias, index) => assertNonEmptyString(alias, `${label}.aliases[${index}]`));
  }
  if (value.birth_name !== undefined && value.birth_name !== null) assertNonEmptyString(value.birth_name, `${label}.birth_name`);
  if (value.birth_time !== undefined && value.birth_time !== null) assertStructuredTime(value.birth_time, `${label}.birth_time`);
  if (value.death_time !== undefined && value.death_time !== null) assertStructuredTime(value.death_time, `${label}.death_time`);
  if (!Object.hasOwn(value, 'living')) fail(`${label}.living måste väljas som true, false eller null`);
  if (value.living !== null && typeof value.living !== 'boolean') fail(`${label}.living måste vara boolean eller null`);
  if (value.living === true && value.death_time) fail(`${label}.living får inte vara true när death_time finns`);
  for (const field of ['context_note', 'note', 'review_comment']) {
    if (value[field] !== undefined && value[field] !== null && typeof value[field] !== 'string') fail(`${label}.${field} måste vara text`);
  }
  if (value.needs_review !== undefined && typeof value.needs_review !== 'boolean') fail(`${label}.needs_review måste vara boolean`);
  return value;
}

export function assertIdentityRedirect(value, label = 'identitetsompekning') {
  if (!isPlainObject(value)) fail(`${label} måste vara ett objekt`);
  assertNonEmptyString(value.id, `${label}.id`);
  assertNonEmptyString(value.target_person_id, `${label}.target_person_id`);
  assertNonEmptyString(value.decision_id, `${label}.decision_id`);
  return value;
}

export function assertStructuredEvent(value, label = 'händelse') {
  if (!isPlainObject(value)) fail(`${label} måste vara ett objekt`);
  if (value.id !== undefined) assertNonEmptyString(value.id, `${label}.id`);
  if (!STRUCTURED_EVENT_TYPES.includes(value.event_type)) fail(`${label}.event_type är ogiltig`);
  if (value.time === undefined) {
    if (value.event_type !== 'ownership') fail(`${label}.time krävs`);
  } else {
    assertStructuredTime(value.time, `${label}.time`);
  }
  if (value.participants !== undefined) {
    if (!Array.isArray(value.participants)) fail(`${label}.participants måste vara en lista`);
    value.participants.forEach((participant, index) => {
      const participantLabel = `${label}.participants[${index}]`;
      if (!isPlainObject(participant)) fail(`${participantLabel} måste vara ett objekt`);
      assertStableReference(participant.party_ref, `${participantLabel}.party_ref`);
      if (participant.role !== 'owner') fail(`${participantLabel}.role måste vara owner`);
    });
  }
  if (['ownership', 'purchased', 'sold', 'registered'].includes(value.event_type)
    && (!Array.isArray(value.participants) || value.participants.length === 0)) {
    fail(`${label}.${value.event_type} kräver minst en kopplad ägare`);
  }
  if (value.event_type === 'renamed') {
    assertNonEmptyString(value.name_before, `${label}.name_before`);
    assertNonEmptyString(value.name_after, `${label}.name_after`);
  }
  if (value.event_type === 'name_decided') {
    assertNonEmptyString(value.decided_name, `${label}.decided_name`);
  }
  if (value.comment !== undefined && typeof value.comment !== 'string') fail(`${label}.comment måste vara text`);
  return value;
}

function assertEntity(record, label) {
  if (!isPlainObject(record)) fail(`${label} måste vara ett objekt`);
  assertNonEmptyString(record.id, `${label}.id`);
  if (record.needs_review !== undefined && typeof record.needs_review !== 'boolean') fail(`${label}.needs_review måste vara boolean`);
  if (record.review_comment !== undefined && typeof record.review_comment !== 'string') fail(`${label}.review_comment måste vara text`);
  if (record.updated_by !== undefined && record.updated_by !== null) assertNonEmptyString(record.updated_by, `${label}.updated_by`);
  assertOptionalTimestamp(record.updated_at, `${label}.updated_at`);
  if (record.deleted_by !== undefined && record.deleted_by !== null) assertNonEmptyString(record.deleted_by, `${label}.deleted_by`);
  assertOptionalTimestamp(record.deleted_at, `${label}.deleted_at`);
}

export function assertMaster(master, options = {}) {
  if (!isPlainObject(master)) fail('Mastern måste vara ett objekt');
  if (master.schema_version !== 1) fail('Mastern måste ha schema_version 1');
  if (master.architecture_generation !== 2) fail('Mastern måste ha architecture_generation 2');
  assertNonEmptyString(master.app, 'app');
  if (options.app !== undefined && master.app !== options.app) fail(`Fel appmaster: väntade ${options.app}, fick ${master.app}`);
  if (!Number.isSafeInteger(master.master_revision) || master.master_revision < 0) fail('master_revision måste vara ett icke-negativt heltal');
  if (master.last_change_id !== null) assertNonEmptyString(master.last_change_id, 'last_change_id');
  if (master.updated_by !== null) assertNonEmptyString(master.updated_by, 'updated_by');
  assertOptionalTimestamp(master.updated_at, 'updated_at');
  if (!isPlainObject(master.data)) fail('data måste vara ett objekt med samlingar');

  for (const [collection, records] of Object.entries(master.data)) {
    assertNonEmptyString(collection, 'samlingsnamn');
    if (!Array.isArray(records)) fail(`data.${collection} måste vara en array`);
    const ids = new Set();
    for (let index = 0; index < records.length; index += 1) {
      const label = `data.${collection}[${index}]`;
      assertEntity(records[index], label);
      if (ids.has(records[index].id)) fail(`Dubblerat ID i ${collection}: ${records[index].id}`);
      ids.add(records[index].id);
    }
  }

  cloneJson(master);
  return master;
}
