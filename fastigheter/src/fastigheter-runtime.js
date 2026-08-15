import { ActiveJsonMaster } from '../core/active-json-master.js';
import { assertCompatibleActiveDependency } from '../core/dependency-compatibility.js';
import { assertWriterDomainFields } from '../master-data-v2/index.js';

const PROPERTY_COLLECTIONS = Object.freeze([
  'properties',
  'timeline_entries',
  'affiliations',
  'property_parties',
  'identity_redirects',
]);

const timeStart = time => Number(time?.start_min ?? time?.start_max ?? Number.POSITIVE_INFINITY);

function chronology(entry, propertyId) {
  if (Number.isFinite(entry.chronology_order)) return entry.chronology_order;
  const mapped = entry.chronology_order?.[propertyId];
  return Number.isFinite(mapped) ? mapped : Number.POSITIVE_INFINITY;
}

function timelineCompare(propertyId) {
  return (left, right) => {
    const leftOrder = chronology(left, propertyId);
    const rightOrder = chronology(right, propertyId);
    // chronology_order is a deliberate human ordering of a property's chain.
    // When both rows carry it, it must win over approximate or open dates.
    if (Number.isFinite(leftOrder) && Number.isFinite(rightOrder) && leftOrder !== rightOrder) return leftOrder - rightOrder;
    return timeStart(left.time) - timeStart(right.time)
      || leftOrder - rightOrder
      || String(left.id).localeCompare(String(right.id), 'sv');
  };
}

export class FastigheterActiveRuntime {
  constructor({ store } = {}) {
    this.properties = new ActiveJsonMaster({
      store,
      cacheKey: 'fastigheter-generation2-primary',
      pointerPath: '/fastigheter-generation2/active.json',
      app: 'fastigheter',
      requiredCollections: PROPERTY_COLLECTIONS,
    });
    this.people = new ActiveJsonMaster({
      store,
      cacheKey: 'people-for-fastigheter-generation2',
      pointerPath: '/personer-familjer/active.json',
      app: 'people',
      requiredCollections: ['people'],
    });
    this.kartdata = new ActiveJsonMaster({
      store,
      cacheKey: 'kartdata-for-fastigheter-generation2',
      pointerPath: '/kartdata-generation2/active.json',
      app: 'kartdata',
      requiredCollections: ['places', 'entries'],
    });
  }

  async init() {
    await Promise.all([this.properties.init(), this.people.init(), this.kartdata.init()]);
    if (this.hasData()) this.assertCoherent();
    return this;
  }

  hasData() {
    return this.properties.hasData() && this.people.hasData() && this.kartdata.hasData();
  }

  assertCoherent() {
    if (!this.hasData()) throw new Error('Fastighetsmasterns beroenden saknas');
    assertCompatibleActiveDependency(this.people.pointer, {
      master_revision: this.properties.pointer.person_master_revision,
      master_sha256: this.properties.pointer.person_master_sha256,
    }, 'Fastigheters Personberoende');
    assertCompatibleActiveDependency(this.properties.pointer, {
      master_revision: this.kartdata.pointer.property_master_revision,
      master_sha256: this.kartdata.pointer.property_master_sha256,
    }, 'Kartdatas Fastighetsberoende');
    assertWriterDomainFields(this.properties.master, { allowMissingCollections: false });
    return true;
  }

  async sync(transport) {
    await Promise.all([
      this.properties.sync(transport),
      this.people.sync(transport),
      this.kartdata.sync(transport),
    ]);
    this.assertCoherent();
    return {
      propertyRevision: this.properties.masterRevision,
      peopleRevision: this.people.masterRevision,
      kartdataRevision: this.kartdata.masterRevision,
      writable: this.properties.pointer.writer_enabled === true,
    };
  }

  listProperties() {
    return this.properties.list('properties').sort((a, b) => a.designation.localeCompare(b.designation, 'sv', { numeric: true }));
  }

  getProperty(propertyId) {
    return this.properties.get('properties', propertyId);
  }

  timelineFor(propertyId) {
    return this.properties.list('timeline_entries')
      .filter(row => row.property_ids.includes(propertyId))
      .sort(timelineCompare(propertyId));
  }

  affiliationsFor(propertyId) {
    return this.properties.list('affiliations')
      .filter(row => row.property_ref.entity_id === propertyId);
  }

  resolveParty(reference) {
    if (reference?.master === 'people') {
      const person = this.people.get('people', reference.entity_id);
      return { id: reference.entity_id, kind: 'person', display_name: person?.display_name || reference.entity_id, person };
    }
    if (reference?.master === 'fastigheter') {
      const party = this.properties.get('property_parties', reference.entity_id);
      return { id: reference.entity_id, kind: 'property_party', display_name: party?.display_name || reference.entity_id, party };
    }
    return { id: reference?.entity_id || '', kind: 'unknown', display_name: reference?.entity_id || 'Okänd part' };
  }

  currentOwners(propertyId) {
    const rows = this.timelineFor(propertyId).filter(row => row.entry_type.startsWith('current_ownership'));
    const latest = rows.at(-1) || null;
    return latest ? latest.parties.map(party => ({ ...party, resolved: this.resolveParty(party.party_ref) })) : [];
  }

  placeNames(property) {
    return (property?.place_refs || []).map(reference => this.kartdata.get('places', reference.entity_id)?.preferred_name)
      .filter(Boolean);
  }
}

export function createFastigheterActiveRuntime(options) {
  return new FastigheterActiveRuntime(options);
}
