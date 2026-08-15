import {
  MasterRepository,
  MasterValidationError,
  RevisionMasterStorage,
  applyMasterChange,
  assertWriterDomainFields,
} from '../../../packages/master-data-v2/index.js';

export const MATRIKEL_POINTER_PATH = '/matrikel-generation2/active.json';

const EDITABLE_FIELDS = new Set([
  'membership_level',
  'club_name',
  'induction_year',
  'membership_form',
  'participation',
  'membership_ended',
]);

const clone = value => value == null ? value : structuredClone(value);

function requirePersonId(value) {
  if (typeof value !== 'string' || !value.trim()) throw new MasterValidationError('Person-id krävs');
  return value.trim();
}

function normalizePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new MasterValidationError('Medlemsändringen måste vara ett objekt');
  const normalized = {};
  for (const [field, value] of Object.entries(patch)) {
    if (!EDITABLE_FIELDS.has(field)) throw new MasterValidationError(`Fältet ${field} kan inte ändras här`);
    normalized[field] = value;
  }
  if (Object.hasOwn(normalized, 'membership_level') && !['junior', 'senior'].includes(normalized.membership_level)) {
    throw new MasterValidationError('Medlemsnivå måste vara junior eller senior');
  }
  if (Object.hasOwn(normalized, 'club_name') && normalized.club_name !== null
    && (typeof normalized.club_name !== 'string' || !normalized.club_name.trim())) {
    throw new MasterValidationError('Klubbnamn måste vara text eller null');
  }
  if (typeof normalized.club_name === 'string') normalized.club_name = normalized.club_name.trim();
  if (Object.hasOwn(normalized, 'induction_year') && normalized.induction_year !== null
    && (!Number.isSafeInteger(normalized.induction_year) || normalized.induction_year < 1900 || normalized.induction_year > 2200)) {
    throw new MasterValidationError('Invalsår måste vara ett heltal 1900–2200 eller null');
  }
  if (Object.hasOwn(normalized, 'membership_form') && normalized.membership_form !== null
    && !['ordinary', 'corresponding'].includes(normalized.membership_form)) {
    throw new MasterValidationError('Medlemsform måste vara ordinarie, korresponderande eller null');
  }
  if (Object.hasOwn(normalized, 'participation') && ![null, 'passive'].includes(normalized.participation)) {
    throw new MasterValidationError('Deltagande måste vara passivt eller null');
  }
  if (Object.hasOwn(normalized, 'membership_ended') && ![null, true].includes(normalized.membership_ended)) {
    throw new MasterValidationError('Avslutat medlemskap måste vara true eller null');
  }
  return normalized;
}

function membershipForPerson(master, personId) {
  return (master.data.memberships || []).find(row => !row.deleted_at
    && row.person_ref?.master === 'people'
    && row.person_ref?.entity_type === 'person'
    && row.person_ref?.entity_id === personId) || null;
}

function mutationForMembership(master, personId, patch) {
  const current = membershipForPerson(master, personId);
  const entityId = current?.id || `membership:${personId}`;
  const set = current ? {} : {
    person_ref: { master: 'people', entity_type: 'person', entity_id: personId },
  };
  const unset = [];
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) {
      if (current && Object.hasOwn(current, field)) unset.push(field);
    } else if (!current || JSON.stringify(current[field]) !== JSON.stringify(value)) {
      set[field] = clone(value);
    }
  }
  if (!Object.keys(set).length && !unset.length) throw new MasterValidationError('Ingenting har ändrats');
  return {
    collection: 'memberships',
    entity_id: entityId,
    action: 'upsert',
    set,
    ...(unset.length ? { unset } : {}),
  };
}

export class MatrikelMembershipWriter {
  constructor({
    transport,
    pendingStore,
    changedBy = 'simon',
    pointerPath = MATRIKEL_POINTER_PATH,
    now = () => new Date().toISOString(),
    createId = () => crypto.randomUUID(),
  } = {}) {
    this.changedBy = changedBy;
    this.now = now;
    this.createId = createId;
    this.storage = new RevisionMasterStorage({
      app: 'matrikel',
      pointerPath,
      transport,
      pendingStore,
      pendingKey: 'master-data-v2:matrikel:pending',
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

  async saveMembership(personIdValue, patchValue, { manualComment = '' } = {}) {
    const personId = requirePersonId(personIdValue);
    const patch = normalizePatch(patchValue);
    const current = this.current || await this.load();
    const changedAt = this.now();
    const request = {
      change_id: `matrikel-membership:${this.createId()}`,
      expected_master_revision: current.master.master_revision,
      expected_storage_revision: current.storage_revision,
      changed_at: changedAt,
      changed_by: this.changedBy,
      manual_comment: typeof manualComment === 'string' ? manualComment.trim() : '',
      mutations: [mutationForMembership(current.master, personId, patch)],
    };
    const preview = await applyMasterChange(current.master, request);
    assertWriterDomainFields(preview.master, { allowMissingCollections: false });
    const saved = await this.repository.save(request);
    assertWriterDomainFields(saved.master, { allowMissingCollections: false });
    this.current = saved;
    return clone(saved);
  }
}

export function createMatrikelMembershipWriter(options) {
  return new MatrikelMembershipWriter(options);
}
