import { ActiveJsonMaster } from '../core/active-json-master.js';
import { ReadOnlyMaster } from '../core/read-only-master.js';
import { assertCompatibleActiveDependency } from '../core/dependency-compatibility.js';
import { assertWriterDomainFields } from '../master-data-v2/index.js';

const startYear = event => Number(event?.time?.start_min ?? event?.time?.start_max ?? Number.POSITIVE_INFINITY);
const endYear = event => Number(event?.time?.end_max ?? event?.time?.end_min ?? startYear(event));

export class BatregisterActiveRuntime {
  constructor({ store } = {}) {
    this.boats = new ActiveJsonMaster({
      store,
      cacheKey: 'batregister-generation2-primary',
      pointerPath: '/batregister-generation2/active.json',
      app: 'batregister',
      requiredCollections: ['boats', 'identity_redirects'],
    });
    this.people = new ActiveJsonMaster({
      store,
      cacheKey: 'people-for-batregister-generation2',
      pointerPath: '/personer-familjer/active.json',
      app: 'people',
      requiredCollections: ['people', 'family_units'],
    });
    this.legacy = new ReadOnlyMaster({ store, cacheKey: 'batregister-generation1-supplement' });
  }

  async init() {
    await Promise.all([this.boats.init(), this.people.init(), this.legacy.init()]);
    if (this.hasData()) this.assertCoherent();
    return this;
  }

  hasData() {
    return this.boats.hasData() && this.people.hasData();
  }

  assertCoherent() {
    if (!this.hasData()) throw new Error('Båtmasterns personberoende saknas');
    assertCompatibleActiveDependency(this.people.pointer, {
      master_revision: this.boats.pointer.people_master_revision,
      master_sha256: this.boats.pointer.people_master_sha256,
    }, 'Båtregistrets Personberoende');
    assertWriterDomainFields(this.boats.master, { allowMissingCollections: false });
    return true;
  }

  async sync(transport) {
    await Promise.all([this.boats.sync(transport), this.people.sync(transport)]);
    this.assertCoherent();
    return {
      boatRevision: this.boats.masterRevision,
      peopleRevision: this.people.masterRevision,
      writable: this.boats.pointer.writer_enabled === true,
    };
  }

  async syncLegacy(transport) {
    return this.legacy.sync(transport);
  }

  legacyRecords(type) {
    return this.legacy.listEntities(type).map(entity => ({
      id: entity.entity_id,
      ...(entity.fields?.record && typeof entity.fields.record === 'object' ? entity.fields.record : entity.fields),
    }));
  }

  legacyIdsForBoat(boatId) {
    return [boatId, ...this.boats.list('identity_redirects').filter(row => row.target_boat_id === boatId).map(row => row.id)];
  }

  legacySupplement(boatOrId) {
    const boat = typeof boatOrId === 'string' ? this.getBoat(boatOrId) : boatOrId;
    if (!boat) return null;
    const ids = new Set(this.legacyIdsForBoat(boat.id));
    const records = type => this.legacyRecords(type).filter(row => ids.has(row.boat_id));
    const base = this.legacyRecords('boat').find(row => ids.has(row.id)) || null;
    const supplement = {
      base,
      specs: records('boat-spec-observation'),
      ownerships: records('boat-ownership-observation'),
      events: records('boat-event-observation'),
      names: records('boat-name-observation'),
      reviews: records('boat-review-item').filter(row => row.status !== 'resolved'),
      sources: [],
    };
    const sourceIds = new Set([
      ...(base?.source_ids || []),
      ...supplement.specs.flatMap(row => row.source_ids || []),
      ...supplement.ownerships.flatMap(row => row.source_ids || []),
      ...supplement.events.flatMap(row => row.source_ids || []),
      ...supplement.names.flatMap(row => row.source_ids || []),
      ...supplement.reviews.flatMap(row => row.source_ids || []),
    ]);
    supplement.sources = this.legacyRecords('boat-source').filter(row => sourceIds.has(row.id));
    supplement.hasData = Boolean(base || supplement.specs.length || supplement.ownerships.length || supplement.events.length || supplement.names.length || supplement.reviews.length);
    return supplement;
  }

  legacySummary(boatOrId) {
    const supplement = this.legacySupplement(boatOrId);
    if (!supplement?.hasData) return null;
    const specs = {};
    for (const observation of supplement.specs) {
      if (observation.status && !['accepted', 'source-observation'].includes(observation.status)) continue;
      for (const [key, value] of Object.entries(observation.values || {})) if (specs[key] === undefined && value !== null && value !== '') specs[key] = value;
    }
    return { ...supplement, specs: supplement.specs, effectiveSpecs: specs };
  }

  listBoats() {
    return this.boats.list('boats').sort((left, right) => left.display_name.localeCompare(right.display_name, 'sv', { numeric: true }));
  }

  getBoat(id) {
    return this.boats.get('boats', id);
  }

  eventsFor(boatOrId) {
    const boat = typeof boatOrId === 'string' ? this.getBoat(boatOrId) : boatOrId;
    return [...(boat?.events || [])].sort((left, right) => startYear(left) - startYear(right) || endYear(left) - endYear(right) || String(left.id).localeCompare(String(right.id), 'sv'));
  }

  resolveParty(reference) {
    if (reference?.master !== 'people') return { display_name: reference?.entity_id || 'Okänd ägare', kind: 'unknown' };
    if (reference.entity_type === 'person') {
      const person = this.people.get('people', reference.entity_id);
      return { display_name: person?.display_name || reference.entity_id, kind: 'person', person };
    }
    if (reference.entity_type === 'family_unit') {
      const family = this.people.get('family_units', reference.entity_id);
      return { display_name: family?.display_name || reference.entity_id, kind: 'family_unit', family };
    }
    return { display_name: reference.entity_id || 'Okänd ägare', kind: 'unknown' };
  }

  ownersForEvent(event) {
    return (event?.participants || []).filter(row => row.role === 'owner').map(row => this.resolveParty(row.party_ref));
  }

  latestOwners(boatOrId) {
    const ownershipEvents = this.eventsFor(boatOrId).filter(event => ['ownership', 'purchased', 'registered', 'sold', 'deregistered'].includes(event.event_type));
    const latest = ownershipEvents.at(-1);
    if (!latest || ['sold', 'deregistered'].includes(latest.event_type)) return [];
    return this.ownersForEvent(latest);
  }

  partyOptions() {
    const people = this.people.list('people').map(person => ({ value: `person|${person.id}`, label: person.display_name, reference: { master: 'people', entity_type: 'person', entity_id: person.id } }));
    const families = this.people.list('family_units').filter(family => family.allowed_as_owner_target !== false).map(family => ({ value: `family_unit|${family.id}`, label: family.display_name, reference: { master: 'people', entity_type: 'family_unit', entity_id: family.id } }));
    return [...people, ...families].sort((left, right) => left.label.localeCompare(right.label, 'sv'));
  }
}

export function createBatregisterActiveRuntime(options) {
  return new BatregisterActiveRuntime(options);
}
