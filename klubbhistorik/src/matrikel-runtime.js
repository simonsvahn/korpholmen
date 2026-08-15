import { ActiveJsonMaster } from '../core/active-json-master.js';
import { assertCompatibleActiveDependency } from '../core/dependency-compatibility.js';
import { assertWriterDomainFields } from '../master-data-v2/index.js';
import { createMatrikelCanaryRepository, createMatrikelPersonReadOnlyMaster } from './matrikel-canary.js';

const REQUIRED_MATRIKEL_COLLECTIONS = Object.freeze([
  'memberships',
  'releases',
  'person_occurrences',
  'boat_occurrences',
  'organizations',
  'roles',
  'role_terms',
  'awards',
  'award_events',
]);

function personReferences(master) {
  const memberships = new Map(master.matrikel.data.memberships
    .filter(row => !row.deleted_at)
    .map(row => [row.person_ref?.entity_id, row]));
  return master.people.data.people.filter(row => !row.deleted_at).map(row => {
    const membership = memberships.get(row.id);
    return {
      id: `person-ref:${row.id}`,
      external_id: row.id,
      display_name: row.display_name,
      club_name: membership?.club_name || null,
      url: `../matrikel/?person=${encodeURIComponent(row.id)}`,
      match_status: 'kopplad',
    };
  });
}

function boatReferences(master) {
  return master.boats.data.boats.filter(row => !row.deleted_at).map(row => ({
    id: `boat-ref:${row.id}`,
    external_id: row.id,
    name: row.display_name,
    display_name: row.display_name,
    category: row.category || null,
    model: row.model || null,
    events: row.events || [],
    url: `../batregister/?boat=${encodeURIComponent(row.id)}`,
    match_status: 'kopplad',
  }));
}

function assertDependencies(matrikelPointer, peoplePointer) {
  assertCompatibleActiveDependency(peoplePointer, {
    master_revision: matrikelPointer.person_master_revision,
    master_sha256: matrikelPointer.person_master_sha256,
  }, 'Matrikelns Personberoende');
}

export class MatrikelActiveRuntime {
  constructor({ store } = {}) {
    this.matrikel = new ActiveJsonMaster({
      store,
      cacheKey: 'matrikel-generation2-primary',
      pointerPath: '/matrikel-generation2/active.json',
      app: 'matrikel',
      requiredCollections: REQUIRED_MATRIKEL_COLLECTIONS,
    });
    this.people = new ActiveJsonMaster({
      store,
      cacheKey: 'people-for-matrikel-generation2',
      pointerPath: '/personer-familjer/active.json',
      app: 'people',
      requiredCollections: ['people'],
    });
    this.boats = new ActiveJsonMaster({
      store,
      cacheKey: 'boats-for-matrikel-generation2',
      pointerPath: '/batregister-generation2/active.json',
      app: 'batregister',
      requiredCollections: ['boats'],
    });
    this.repository = null;
    this.personMaster = null;
    this.bundle = null;
  }

  async init() {
    await Promise.all([this.matrikel.init(), this.people.init(), this.boats.init()]);
    if (this.hasData()) this.rebuild();
    return this;
  }

  hasData() {
    return this.matrikel.hasData() && this.people.hasData() && this.boats.hasData();
  }

  rebuild() {
    if (!this.hasData()) throw new Error('Den aktiva Matrikelns beroenden saknas');
    assertDependencies(this.matrikel.pointer, this.people.pointer);
    assertWriterDomainFields(this.matrikel.master, { allowMissingCollections: false });
    const documents = { matrikel: this.matrikel.master, people: this.people.master, boats: this.boats.master };
    const bundle = {
      manifest: { status: 'active_private_master', writer_enabled: this.matrikel.pointer.writer_enabled },
      master: documents.matrikel,
      masterSha256: this.matrikel.pointer.master_sha256,
      personMaster: documents.people,
      personPointer: this.people.pointer,
      personMasterSha256: this.people.pointer.master_sha256,
      retiredReferences: {
        person_refs: personReferences(documents),
        boat_refs: boatReferences(documents),
        club_history_roots: [],
      },
      lifeSyncReport: { schema_version: 1, issues: [], decisions: [] },
    };
    this.bundle = bundle;
    this.repository = createMatrikelCanaryRepository(bundle);
    this.personMaster = createMatrikelPersonReadOnlyMaster(bundle);
    return this;
  }

  async sync(transport) {
    await Promise.all([
      this.matrikel.sync(transport),
      this.people.sync(transport),
      this.boats.sync(transport),
    ]);
    this.rebuild();
    return {
      matrikelRevision: this.matrikel.masterRevision,
      peopleRevision: this.people.masterRevision,
      boatRevision: this.boats.masterRevision,
      writable: this.matrikel.pointer.writer_enabled === true,
    };
  }
}

export function createMatrikelActiveRuntime(options) {
  return new MatrikelActiveRuntime(options);
}
