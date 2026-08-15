import { cloneJson } from './domain/canonical.js';
import { sha256Hex } from './sync/checkpoint-format.js';
import { deriveLegacyMembershipStatus, membershipPersonId } from './membership-model.js';
import { assertCompatibleActiveDependency } from './dependency-compatibility.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
const CACHE_VERSION = 1;

const DEFAULT_SOURCES = Object.freeze({
  people: Object.freeze({ pointerPath: '/personer-familjer/active.json', app: 'people' }),
  matrikel: Object.freeze({ pointerPath: '/matrikel-generation2/active.json', app: 'matrikel' }),
});

const collectionByType = Object.freeze({
  person: ['people', 'people'],
  relation: ['people', 'relations'],
  'person-relation': ['people', 'relations'],
  'family-unit': ['people', 'family_units'],
  'identity-redirect': ['people', 'identity_redirects'],
  membership: ['matrikel', 'memberships'],
  release: ['matrikel', 'releases'],
  'person-occurrence': ['matrikel', 'person_occurrences'],
  'boat-occurrence': ['matrikel', 'boat_occurrences'],
  'source-document': ['matrikel', 'source_documents'],
  'source-row': ['matrikel', 'source_rows'],
  'source-layout-row': ['matrikel', 'source_layout_rows'],
  'name-change-candidate': ['matrikel', 'name_change_candidates'],
});

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

function validateMaster(master, pointer, expectedApp) {
  if (!master || master.schema_version !== 1 || master.app !== expectedApp || !master.data || typeof master.data !== 'object') {
    throw new TypeError(`Ogiltig ${expectedApp}-master`);
  }
  if (master.master_revision !== pointer.master_revision) throw new Error(`${expectedApp}-mastern har annan revision än den aktiva pekaren`);
  return master;
}

function validateCollections(people, matrikel) {
  for (const key of ['people', 'relations', 'family_units', 'identity_redirects']) {
    if (!Array.isArray(people.data[key])) throw new TypeError(`Personmastern saknar listan ${key}`);
  }
  for (const key of ['memberships', 'releases', 'person_occurrences']) {
    if (!Array.isArray(matrikel.data[key])) throw new TypeError(`Matrikelmastern saknar listan ${key}`);
  }
}

async function loadSource(transport, source) {
  if (typeof transport?.getBytes !== 'function') throw new TypeError('Den nya masterläsaren kräver en byte-lästransport');
  const pointerBytes = await transport.getBytes(source.pointerPath);
  const pointer = validatePointer(parseJsonBytes(pointerBytes, `${source.app}-pekaren`), source.app);
  const masterPath = resolveRelativePath(source.pointerPath, pointer.master_relative_path);
  const masterBytes = await transport.getBytes(masterPath);
  const actualHash = await sha256Hex(masterBytes);
  if (actualHash !== pointer.master_sha256) throw new Error(`${source.app}-masterns SHA-256 stämmer inte`);
  const master = validateMaster(parseJsonBytes(masterBytes, `${source.app}-mastern`), pointer, source.app);
  return { pointer, master, masterPath };
}

const entity = (type, row) => ({
  entity_type: type,
  entity_id: row.id,
  fields: cloneJson(Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'id'))),
});

function membershipByPerson(master) {
  return new Map(master.data.memberships.map(row => [membershipPersonId(row), row]).filter(([id]) => id));
}

function rowsForType(state, type) {
  const descriptor = collectionByType[type];
  if (!descriptor) return [];
  const [masterName, collection] = descriptor;
  const rows = state[masterName].data[collection] || [];
  if (type !== 'person') return rows;
  const memberships = membershipByPerson(state.matrikel);
  return rows.map(row => {
    const membership = memberships.get(row.id);
    if (!membership) return row;
    const status = deriveLegacyMembershipStatus(membership, row);
    return {
      ...row,
      club_name: membership.club_name ?? null,
      membership_status: status,
      matrikel_status: status,
      membership_level: membership.membership_level ?? null,
      membership_form: membership.membership_form ?? null,
      membership_participation: membership.participation ?? null,
      induction_year: membership.induction_year ?? null,
    };
  });
}

function validateCachedState(value) {
  if (!value || value.cache_version !== CACHE_VERSION || !value.people?.pointer || !value.people?.master || !value.matrikel?.pointer || !value.matrikel?.master) return null;
  validatePointer(value.people.pointer, 'people');
  validatePointer(value.matrikel.pointer, 'matrikel');
  validateMaster(value.people.master, value.people.pointer, 'people');
  validateMaster(value.matrikel.master, value.matrikel.pointer, 'matrikel');
  validateCollections(value.people.master, value.matrikel.master);
  return { people: value.people.master, matrikel: value.matrikel.master, pointers: { people: value.people.pointer, matrikel: value.matrikel.pointer } };
}

export class PeopleMembershipMaster {
  constructor({ store, cacheKey = 'people-membership-generation2', sources = DEFAULT_SOURCES } = {}) {
    if (!store || typeof store.getSnapshot !== 'function' || typeof store.saveSnapshot !== 'function') {
      throw new TypeError('PeopleMembershipMaster kräver ett snapshotlager');
    }
    this.store = store;
    this.cacheKey = String(cacheKey || '').trim();
    if (!this.cacheKey) throw new TypeError('PeopleMembershipMaster kräver cacheKey');
    this.sources = sources;
    this.snapshotKey = `people-membership-master:${this.cacheKey}:snapshot`;
    this.state = null;
    this.initialized = false;
    this.revision = 0;
  }

  async init() {
    const cached = await this.store.getSnapshot(this.snapshotKey);
    this.state = cached ? validateCachedState(cached) : null;
    this.initialized = true;
    this.revision += 1;
    return this;
  }

  assertReady() {
    if (!this.initialized) throw new Error('PeopleMembershipMaster.init() måste köras först');
  }

  listEntities(type) {
    this.assertReady();
    if (!this.state) return [];
    return rowsForType(this.state, type).filter(row => row?.id).map(row => entity(type, row));
  }

  getEntity(type, id) {
    this.assertReady();
    return this.listEntities(type).find(item => item.entity_id === id) || null;
  }

  async sync(transport) {
    this.assertReady();
    const [peopleSource, matrikelSource] = await Promise.all([
      loadSource(transport, this.sources.people),
      loadSource(transport, this.sources.matrikel),
    ]);
    validateCollections(peopleSource.master, matrikelSource.master);
    assertCompatibleActiveDependency(peopleSource.pointer, {
      master_revision: matrikelSource.pointer.person_master_revision,
      master_sha256: matrikelSource.pointer.person_master_sha256,
    }, 'Matrikelns Personberoende');
    const previous = this.state;
    const next = {
      people: peopleSource.master,
      matrikel: matrikelSource.master,
      pointers: { people: peopleSource.pointer, matrikel: matrikelSource.pointer },
    };
    await this.store.saveSnapshot(this.snapshotKey, {
      cache_version: CACHE_VERSION,
      people: { pointer: peopleSource.pointer, master: peopleSource.master, master_path: peopleSource.masterPath },
      matrikel: { pointer: matrikelSource.pointer, master: matrikelSource.master, master_path: matrikelSource.masterPath },
      cached_at: new Date().toISOString(),
    });
    this.state = next;
    const changed = !previous
      || previous.pointers.people.master_sha256 !== next.pointers.people.master_sha256
      || previous.pointers.matrikel.master_sha256 !== next.pointers.matrikel.master_sha256;
    if (changed) this.revision += 1;
    return {
      changed,
      peopleRevision: peopleSource.pointer.master_revision,
      matrikelRevision: matrikelSource.pointer.master_revision,
    };
  }
}
