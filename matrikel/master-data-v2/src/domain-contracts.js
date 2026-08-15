import { MasterValidationError } from './errors.js';
import { assertBoatCategory, assertIdentityRedirect, assertStructuredEvent } from './validation.js';

export const COMMON_RECORD_FIELDS = Object.freeze([
  'id',
  'updated_at',
  'updated_by',
  'needs_review',
  'review_comment',
  'deleted_at',
  'deleted_by',
]);

const contract = collections => Object.freeze(Object.fromEntries(
  Object.entries(collections).map(([name, fields]) => [name, Object.freeze([...COMMON_RECORD_FIELDS, ...fields])]),
));

export const MATRIKEL_WRITER_CONTRACT = contract({
  memberships: ['person_ref', 'membership_level', 'club_name', 'induction_year', 'membership_form', 'participation', 'membership_ended', 'membership_end_decision_id', 'source_refs'],
  releases: ['display_name', 'year', 'as_of', 'release_type', 'is_reconstruction', 'document_ref', 'sort_order'],
  person_occurrences: ['release_id', 'order', 'raw_name', 'person_ref', 'club_name_raw', 'category_raw', 'induction_year', 'birth_year', 'place_raw', 'relation_raw', 'raw_text', 'source_locator'],
  boat_occurrences: ['release_id', 'order', 'raw_name', 'boat_ref', 'registry_year', 'category_raw', 'raw_text', 'source_locator'],
  organizations: ['display_name', 'organization_type', 'name_variants', 'description'],
  roles: ['display_name', 'name_variants', 'description'],
  role_terms: ['role_id', 'organization_id', 'person_ref', 'time', 'source_refs'],
  awards: ['display_name', 'award_type', 'name_variants', 'description'],
  award_events: ['award_id', 'time', 'recipients', 'event_type', 'source_refs', 'comment'],
});

export const FASTIGHETER_WRITER_CONTRACT = contract({
  properties: ['designation', 'display_name', 'place_refs', 'existence_status'],
  timeline_entries: ['property_ids', 'entry_type', 'time', 'chronology_order', 'parties', 'related_properties', 'amount', 'currency', 'area_ha', 'label', 'note', 'source_refs'],
  affiliations: ['property_ref', 'person_ref', 'role', 'note'],
  property_parties: ['display_name', 'party_type', 'represented_person_ref', 'note'],
  identity_redirects: ['target_property_id', 'decision_id'],
});

export const BATREGISTER_WRITER_CONTRACT = contract({
  boats: ['display_name', 'category', 'model', 'base_name_id', 'events', 'vessel_type', 'dimensions', 'material', 'engine', 'additional_specs', 'images', 'source_ids', 'notes'],
  identity_redirects: ['target_boat_id', 'decision_document'],
});

export const DOKUMENTARKIV_WRITER_CONTRACT = contract({
  document_categories: ['display_name', 'sort_order'],
  document_types: ['category_id', 'display_name', 'sort_order'],
  document_events: ['display_name', 'event_type', 'time'],
  documents: ['title', 'time', 'category_id', 'type_ids', 'event_ref', 'part_ids'],
  document_parts: ['document_ref', 'order', 'title', 'part_kind', 'type_id', 'time', 'dating', 'has_uncertainty', 'collection', 'sources', 'transcription', 'provenance'],
  document_entities: ['entity_type', 'display_name', 'name_variants', 'description'],
  document_links: ['document_ref', 'target_ref', 'source_labels', 'roles', 'source_part_refs', 'approval'],
});

export const WRITER_DOMAIN_CONTRACTS = Object.freeze({
  matrikel: MATRIKEL_WRITER_CONTRACT,
  fastigheter: FASTIGHETER_WRITER_CONTRACT,
  batregister: BATREGISTER_WRITER_CONTRACT,
  dokumentarkiv: DOKUMENTARKIV_WRITER_CONTRACT,
});

function assertMatrikelMembershipRows(rows) {
  const personIds = new Set();
  for (const row of rows.filter(item => !item.deleted_at)) {
    const label = `matrikel.memberships/${row.id}`;
    const reference = row.person_ref;
    if (reference?.master !== 'people' || reference.entity_type !== 'person' || typeof reference.entity_id !== 'string' || !reference.entity_id.trim()) {
      throw new MasterValidationError(`${label} saknar stabil personreferens`);
    }
    if (personIds.has(reference.entity_id)) throw new MasterValidationError(`Dubblerad aktiv medlemsrad för personen ${reference.entity_id}`);
    personIds.add(reference.entity_id);
    if (!['junior', 'senior'].includes(row.membership_level)) throw new MasterValidationError(`${label}.membership_level är ogiltigt`);
    if (row.membership_form !== undefined && !['ordinary', 'corresponding'].includes(row.membership_form)) throw new MasterValidationError(`${label}.membership_form är ogiltigt`);
    if (row.membership_form === 'corresponding' && row.membership_level !== 'senior') throw new MasterValidationError(`${label} kan inte vara korresponderande junior`);
    if (row.participation !== undefined && row.participation !== 'passive') throw new MasterValidationError(`${label}.participation får endast vara passive eller utelämnat`);
    if (row.membership_ended !== undefined && row.membership_ended !== true) throw new MasterValidationError(`${label}.membership_ended får endast vara true eller utelämnat`);
    if (row.induction_year !== undefined && (!Number.isSafeInteger(row.induction_year) || row.induction_year < 1900 || row.induction_year > 2200)) throw new MasterValidationError(`${label}.induction_year är ogiltigt`);
    if (row.club_name !== undefined && (typeof row.club_name !== 'string' || !row.club_name.trim())) throw new MasterValidationError(`${label}.club_name måste vara text eller utelämnat`);
    if (row.source_refs !== undefined && !Array.isArray(row.source_refs)) throw new MasterValidationError(`${label}.source_refs måste vara en lista`);
  }
}

function assertReference(reference, { master, entityType, label }) {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)
    || reference.master !== master || reference.entity_type !== entityType
    || typeof reference.entity_id !== 'string' || !reference.entity_id.trim()) {
    throw new MasterValidationError(`${label} saknar stabil referens till ${master}/${entityType}`);
  }
}

function assertFastigheterRows(data) {
  const active = rows => rows.filter(row => !row.deleted_at);
  const properties = active(data.properties || []);
  const propertyParties = active(data.property_parties || []);
  const propertyIds = new Set();
  const propertyPartyIds = new Set();

  for (const row of properties) {
    const label = `fastigheter.properties/${row.id}`;
    if (propertyIds.has(row.id)) throw new MasterValidationError(`Dubblerad aktiv fastighet: ${row.id}`);
    propertyIds.add(row.id);
    if (row.designation !== row.id) throw new MasterValidationError(`${label}.designation måste vara samma stabila ID`);
    if (typeof row.display_name !== 'string' || !row.display_name.trim()) throw new MasterValidationError(`${label}.display_name saknas`);
    if (!['active', 'historical', 'removed'].includes(row.existence_status)) throw new MasterValidationError(`${label}.existence_status är ogiltigt`);
    if (!Array.isArray(row.place_refs)) throw new MasterValidationError(`${label}.place_refs måste vara en lista`);
    for (const [index, reference] of row.place_refs.entries()) assertReference(reference, { master: 'kartdata', entityType: 'place', label: `${label}.place_refs[${index}]` });
  }

  for (const row of propertyParties) {
    const label = `fastigheter.property_parties/${row.id}`;
    if (propertyPartyIds.has(row.id)) throw new MasterValidationError(`Dubblerad aktiv fastighetspart: ${row.id}`);
    propertyPartyIds.add(row.id);
    if (typeof row.display_name !== 'string' || !row.display_name.trim()) throw new MasterValidationError(`${label}.display_name saknas`);
    if (typeof row.party_type !== 'string' || !row.party_type.trim()) throw new MasterValidationError(`${label}.party_type saknas`);
    if (row.represented_person_ref !== undefined) assertReference(row.represented_person_ref, { master: 'people', entityType: 'person', label: `${label}.represented_person_ref` });
  }

  const timelineIds = new Set();
  for (const row of active(data.timeline_entries || [])) {
    const label = `fastigheter.timeline_entries/${row.id}`;
    if (timelineIds.has(row.id)) throw new MasterValidationError(`Dubblerad aktiv tidslinjepost: ${row.id}`);
    timelineIds.add(row.id);
    if (!Array.isArray(row.property_ids) || !row.property_ids.length || row.property_ids.some(id => !propertyIds.has(id))) throw new MasterValidationError(`${label}.property_ids innehåller okänd fastighet`);
    if (new Set(row.property_ids).size !== row.property_ids.length) throw new MasterValidationError(`${label}.property_ids innehåller dubbletter`);
    if (typeof row.entry_type !== 'string' || !row.entry_type.trim()) throw new MasterValidationError(`${label}.entry_type saknas`);
    if (!row.time || typeof row.time !== 'object' || Array.isArray(row.time)
      || !['point', 'period', 'observation', 'unknown'].includes(row.time.kind)
      || typeof row.time.original_text !== 'string' || !row.time.original_text.trim()) {
      throw new MasterValidationError(`${label}.time följer inte den gemensamma tidsmodellen`);
    }
    if (row.chronology_order !== undefined) {
      const validNumber = Number.isFinite(row.chronology_order);
      const validMap = row.chronology_order && typeof row.chronology_order === 'object' && !Array.isArray(row.chronology_order)
        && Object.entries(row.chronology_order).every(([id, value]) => propertyIds.has(id) && Number.isFinite(value));
      if (!validNumber && !validMap) throw new MasterValidationError(`${label}.chronology_order är ogiltigt`);
    }
    if (!Array.isArray(row.parties)) throw new MasterValidationError(`${label}.parties måste vara en lista`);
    for (const [index, party] of row.parties.entries()) {
      if (!party || typeof party !== 'object' || Array.isArray(party) || typeof party.role !== 'string' || !party.role.trim()) throw new MasterValidationError(`${label}.parties[${index}] är ogiltig`);
      const reference = party.party_ref;
      if (reference?.master === 'people') assertReference(reference, { master: 'people', entityType: 'person', label: `${label}.parties[${index}].party_ref` });
      else if (reference?.master === 'fastigheter') {
        assertReference(reference, { master: 'fastigheter', entityType: 'property_party', label: `${label}.parties[${index}].party_ref` });
        if (!propertyPartyIds.has(reference.entity_id)) throw new MasterValidationError(`${label}.parties[${index}] pekar på okänd fastighetspart`);
      } else throw new MasterValidationError(`${label}.parties[${index}] har otillåten master`);
    }
    if (!Array.isArray(row.related_properties)) throw new MasterValidationError(`${label}.related_properties måste vara en lista`);
    for (const [index, related] of row.related_properties.entries()) {
      if (!related || typeof related !== 'object' || Array.isArray(related) || typeof related.role !== 'string' || !related.role.trim()) throw new MasterValidationError(`${label}.related_properties[${index}] är ogiltig`);
      assertReference(related.property_ref, { master: 'fastigheter', entityType: 'property', label: `${label}.related_properties[${index}].property_ref` });
      if (!propertyIds.has(related.property_ref.entity_id)) throw new MasterValidationError(`${label}.related_properties[${index}] pekar på okänd fastighet`);
    }
    if (!Array.isArray(row.source_refs)) throw new MasterValidationError(`${label}.source_refs måste vara en lista`);
  }

  const affiliations = new Set();
  for (const row of active(data.affiliations || [])) {
    const label = `fastigheter.affiliations/${row.id}`;
    assertReference(row.property_ref, { master: 'fastigheter', entityType: 'property', label: `${label}.property_ref` });
    assertReference(row.person_ref, { master: 'people', entityType: 'person', label: `${label}.person_ref` });
    if (!propertyIds.has(row.property_ref.entity_id)) throw new MasterValidationError(`${label} pekar på okänd fastighet`);
    if (typeof row.role !== 'string' || !row.role.trim()) throw new MasterValidationError(`${label}.role saknas`);
    const key = `${row.property_ref.entity_id}\u0000${row.person_ref.entity_id}\u0000${row.role}`;
    if (affiliations.has(key)) throw new MasterValidationError(`Dubblerad aktiv fastighetsanknytning: ${key}`);
    affiliations.add(key);
  }

  for (const row of active(data.identity_redirects || [])) {
    if (propertyIds.has(row.id)) throw new MasterValidationError(`Aktiv fastighet kan inte samtidigt vara identitetsompekning: ${row.id}`);
    if (!propertyIds.has(row.target_property_id)) throw new MasterValidationError(`fastigheter.identity_redirects/${row.id} pekar på okänd fastighet`);
    if (typeof row.decision_id !== 'string' || !row.decision_id.trim()) throw new MasterValidationError(`fastigheter.identity_redirects/${row.id}.decision_id saknas`);
  }
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new MasterValidationError(`${label} måste vara en lista med textvärden`);
  }
}

function assertBatregisterRows(data) {
  const active = rows => (rows || []).filter(row => !row.deleted_at);
  const boats = active(data.boats);
  const boatIds = new Set();
  for (const row of boats) {
    const label = `batregister.boats/${row.id}`;
    if (boatIds.has(row.id)) throw new MasterValidationError(`Dubblerad aktiv båt: ${row.id}`);
    boatIds.add(row.id);
    if (typeof row.display_name !== 'string' || !row.display_name.trim()) throw new MasterValidationError(`${label}.display_name saknas`);
    if (row.base_name_id !== undefined && (typeof row.base_name_id !== 'string' || !row.base_name_id.trim())) throw new MasterValidationError(`${label}.base_name_id måste vara text eller utelämnat`);
    if (row.category !== undefined) assertBoatCategory(row.category, `${label}.category`);
    for (const field of ['model', 'vessel_type', 'material', 'notes']) {
      if (row[field] !== undefined && row[field] !== null && typeof row[field] !== 'string') throw new MasterValidationError(`${label}.${field} måste vara text`);
    }
    for (const field of ['dimensions', 'engine', 'additional_specs']) {
      if (row[field] !== undefined && (!row[field] || typeof row[field] !== 'object' || Array.isArray(row[field]))) throw new MasterValidationError(`${label}.${field} måste vara ett objekt`);
    }
    if (row.images !== undefined && !Array.isArray(row.images)) throw new MasterValidationError(`${label}.images måste vara en lista`);
    if (row.source_ids !== undefined) assertStringArray(row.source_ids, `${label}.source_ids`);
    if (row.events !== undefined) {
      if (!Array.isArray(row.events)) throw new MasterValidationError(`${label}.events måste vara en lista`);
      const eventIds = new Set();
      row.events.forEach((event, index) => {
        assertStructuredEvent(event, `${label}.events[${index}]`);
        if (event.id) {
          if (eventIds.has(event.id)) throw new MasterValidationError(`${label}.events har dubblerat id: ${event.id}`);
          eventIds.add(event.id);
        }
        for (const [participantIndex, participant] of (event.participants || []).entries()) {
          const reference = participant.party_ref;
          const valid = reference?.master === 'people' && ['person', 'family_unit'].includes(reference.entity_type)
            && typeof reference.entity_id === 'string' && reference.entity_id.trim();
          if (!valid) throw new MasterValidationError(`${label}.events[${index}].participants[${participantIndex}] har otillåten ägarreferens`);
        }
      });
    }
  }
  for (const row of active(data.identity_redirects)) {
    assertIdentityRedirect({ ...row, target_person_id: row.target_boat_id, decision_id: row.decision_document }, `batregister.identity_redirects/${row.id}`);
    if (boatIds.has(row.id)) throw new MasterValidationError(`Aktiv båt kan inte samtidigt vara identitetsompekning: ${row.id}`);
    if (!boatIds.has(row.target_boat_id)) throw new MasterValidationError(`batregister.identity_redirects/${row.id} pekar på okänd båt`);
  }
}

function assertOptionalTime(value, label) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['point', 'period', 'observation', 'unknown'].includes(value.kind)
    || typeof value.original_text !== 'string' || !value.original_text.trim()) {
    throw new MasterValidationError(`${label} följer inte den gemensamma tidsmodellen`);
  }
  for (const field of ['start_min', 'start_max', 'end_min', 'end_max']) {
    if (value[field] !== undefined && value[field] !== null && !Number.isFinite(value[field])) {
      throw new MasterValidationError(`${label}.${field} måste vara ett tal eller utelämnat`);
    }
  }
}

function assertStringList(value, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)
    || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new MasterValidationError(`${label} måste vara en lista med textvärden`);
  }
  if (new Set(value).size !== value.length) throw new MasterValidationError(`${label} innehåller dubbletter`);
}

function assertDocumentarkivRows(data) {
  const active = rows => (rows || []).filter(row => !row.deleted_at);
  const categories = active(data.document_categories);
  const types = active(data.document_types);
  const events = active(data.document_events);
  const documents = active(data.documents);
  const parts = active(data.document_parts);
  const entities = active(data.document_entities);
  const links = active(data.document_links);
  const categoryIds = new Set(categories.map(row => row.id));
  const typeIds = new Set(types.map(row => row.id));
  const eventIds = new Set(events.map(row => row.id));
  const documentIds = new Set(documents.map(row => row.id));
  const partIds = new Set(parts.map(row => row.id));
  const entityIds = new Set(entities.map(row => row.id));

  for (const row of categories) {
    if (typeof row.display_name !== 'string' || !row.display_name.trim()) throw new MasterValidationError(`dokumentarkiv.document_categories/${row.id}.display_name saknas`);
    if (!Number.isSafeInteger(row.sort_order) || row.sort_order < 1) throw new MasterValidationError(`dokumentarkiv.document_categories/${row.id}.sort_order är ogiltigt`);
  }
  for (const row of types) {
    if (!categoryIds.has(row.category_id)) throw new MasterValidationError(`dokumentarkiv.document_types/${row.id} pekar på okänd kategori`);
    if (typeof row.display_name !== 'string' || !row.display_name.trim()) throw new MasterValidationError(`dokumentarkiv.document_types/${row.id}.display_name saknas`);
    if (!Number.isSafeInteger(row.sort_order) || row.sort_order < 1) throw new MasterValidationError(`dokumentarkiv.document_types/${row.id}.sort_order är ogiltigt`);
  }
  for (const row of events) {
    if (typeof row.display_name !== 'string' || !row.display_name.trim()) throw new MasterValidationError(`dokumentarkiv.document_events/${row.id}.display_name saknas`);
    if (typeof row.event_type !== 'string' || !row.event_type.trim()) throw new MasterValidationError(`dokumentarkiv.document_events/${row.id}.event_type saknas`);
    assertOptionalTime(row.time, `dokumentarkiv.document_events/${row.id}.time`);
  }
  for (const row of entities) {
    if (typeof row.entity_type !== 'string' || !row.entity_type.trim()) throw new MasterValidationError(`dokumentarkiv.document_entities/${row.id}.entity_type saknas`);
    if (typeof row.display_name !== 'string' || !row.display_name.trim()) throw new MasterValidationError(`dokumentarkiv.document_entities/${row.id}.display_name saknas`);
    assertStringList(row.name_variants, `dokumentarkiv.document_entities/${row.id}.name_variants`);
  }

  const partsByDocument = new Map();
  for (const row of parts) {
    const label = `dokumentarkiv.document_parts/${row.id}`;
    assertReference(row.document_ref, { master: 'documents', entityType: 'document', label: `${label}.document_ref` });
    if (!documentIds.has(row.document_ref.entity_id)) throw new MasterValidationError(`${label} pekar på okänt dokument`);
    if (!Number.isSafeInteger(row.order) || row.order < 1) throw new MasterValidationError(`${label}.order är ogiltigt`);
    if (typeof row.title !== 'string' || !row.title.trim()) throw new MasterValidationError(`${label}.title saknas`);
    if (typeof row.part_kind !== 'string' || !row.part_kind.trim()) throw new MasterValidationError(`${label}.part_kind saknas`);
    if (!typeIds.has(row.type_id)) throw new MasterValidationError(`${label}.type_id pekar på okänd dokumenttyp`);
    assertOptionalTime(row.time, `${label}.time`);
    if (!row.sources || typeof row.sources !== 'object' || Array.isArray(row.sources) || !Array.isArray(row.sources.files)) throw new MasterValidationError(`${label}.sources är ogiltigt`);
    if (!row.transcription || typeof row.transcription !== 'object' || Array.isArray(row.transcription)
      || typeof row.transcription.text !== 'string' || !/^[a-f0-9]{64}$/.test(String(row.transcription.sha256 || ''))) {
      throw new MasterValidationError(`${label}.transcription saknar text eller SHA-256`);
    }
    const documentParts = partsByDocument.get(row.document_ref.entity_id) || [];
    documentParts.push(row);
    partsByDocument.set(row.document_ref.entity_id, documentParts);
  }

  for (const row of documents) {
    const label = `dokumentarkiv.documents/${row.id}`;
    if (typeof row.title !== 'string' || !row.title.trim()) throw new MasterValidationError(`${label}.title saknas`);
    assertOptionalTime(row.time, `${label}.time`);
    if (!categoryIds.has(row.category_id)) throw new MasterValidationError(`${label}.category_id pekar på okänd kategori`);
    assertStringList(row.type_ids, `${label}.type_ids`, { allowEmpty: false });
    if (row.type_ids.some(id => !typeIds.has(id))) throw new MasterValidationError(`${label}.type_ids pekar på okänd dokumenttyp`);
    if (row.event_ref !== undefined) {
      assertReference(row.event_ref, { master: 'documents', entityType: 'document_event', label: `${label}.event_ref` });
      if (!eventIds.has(row.event_ref.entity_id)) throw new MasterValidationError(`${label}.event_ref pekar på okänd dokumenthändelse`);
    }
    assertStringList(row.part_ids, `${label}.part_ids`, { allowEmpty: false });
    if (row.part_ids.some(id => !partIds.has(id))) throw new MasterValidationError(`${label}.part_ids pekar på okänd dokumentdel`);
    const actual = (partsByDocument.get(row.id) || []).sort((left, right) => left.order - right.order).map(part => part.id);
    if (JSON.stringify(actual) !== JSON.stringify(row.part_ids)) throw new MasterValidationError(`${label}.part_ids stämmer inte med dokumentdelarna`);
  }

  const allowedTargets = new Map([
    ['people', new Set(['person', 'family_unit'])],
    ['batregister', new Set(['boat'])],
    ['fastigheter', new Set(['property'])],
    ['kartdata', new Set(['place', 'building', 'entry'])],
    ['documents', new Set(['organization', 'event', 'place', 'award', 'fund', 'boat'])],
  ]);
  const linkKeys = new Set();
  for (const row of links) {
    const label = `dokumentarkiv.document_links/${row.id}`;
    assertReference(row.document_ref, { master: 'documents', entityType: 'document', label: `${label}.document_ref` });
    if (!documentIds.has(row.document_ref.entity_id)) throw new MasterValidationError(`${label} pekar på okänt dokument`);
    const target = row.target_ref;
    if (!target || !allowedTargets.get(target.master)?.has(target.entity_type) || typeof target.entity_id !== 'string' || !target.entity_id.trim()) {
      throw new MasterValidationError(`${label}.target_ref har otillåtet eller ofullständigt mål`);
    }
    if (target.master === 'documents' && !entityIds.has(target.entity_id)) throw new MasterValidationError(`${label} pekar på okänd lokal dokumententitet`);
    assertStringList(row.source_labels, `${label}.source_labels`, { allowEmpty: false });
    assertStringList(row.roles, `${label}.roles`, { allowEmpty: false });
    if (!Array.isArray(row.source_part_refs) || !row.source_part_refs.length) throw new MasterValidationError(`${label}.source_part_refs saknas`);
    for (const [index, reference] of row.source_part_refs.entries()) {
      assertReference(reference, { master: 'documents', entityType: 'document_part', label: `${label}.source_part_refs[${index}]` });
      if (!partIds.has(reference.entity_id)) throw new MasterValidationError(`${label}.source_part_refs[${index}] pekar på okänd dokumentdel`);
    }
    const approval = row.approval;
    if (!approval || typeof approval !== 'object' || Array.isArray(approval)
      || typeof approval.decision_id !== 'string' || !approval.decision_id.trim()
      || !Array.isArray(approval.review_row_ids) || !approval.review_row_ids.length
      || typeof approval.saved_by !== 'string' || !approval.saved_by.trim()
      || Number.isNaN(Date.parse(approval.saved_at))) {
      throw new MasterValidationError(`${label}.approval saknar uttryckligt mänskligt beslut`);
    }
    const key = `${row.document_ref.entity_id}\u0000${target.master}\u0000${target.entity_type}\u0000${target.entity_id}`;
    if (linkKeys.has(key)) throw new MasterValidationError(`Dubblerad aktiv dokumentlänk: ${key}`);
    linkKeys.add(key);
  }
}

export function assertWriterDomainFields(master, { allowMissingCollections = true } = {}) {
  const contractForApp = WRITER_DOMAIN_CONTRACTS[master?.app];
  if (!contractForApp) throw new MasterValidationError(`Skrivkontrakt saknas för ${master?.app || 'okänd app'}`);
  const unknownCollections = Object.keys(master.data || {}).filter(collection => !contractForApp[collection]);
  if (unknownCollections.length) throw new MasterValidationError(`Okända aktiva samlingar i ${master.app}: ${unknownCollections.join(', ')}`);
  if (!allowMissingCollections) {
    const missing = Object.keys(contractForApp).filter(collection => !Array.isArray(master.data?.[collection]));
    if (missing.length) throw new MasterValidationError(`Saknade aktiva samlingar i ${master.app}: ${missing.join(', ')}`);
  }
  for (const [collection, rows] of Object.entries(master.data || {})) {
    const allowed = new Set(contractForApp[collection]);
    for (const row of rows) {
      const unknownFields = Object.keys(row).filter(field => !allowed.has(field));
      if (unknownFields.length) throw new MasterValidationError(`Okända vardagsfält i ${master.app}.${collection}/${row.id}: ${unknownFields.join(', ')}`);
    }
  }
  if (master.app === 'matrikel' && Array.isArray(master.data?.memberships)) assertMatrikelMembershipRows(master.data.memberships);
  if (master.app === 'fastigheter') assertFastigheterRows(master.data || {});
  if (master.app === 'batregister') assertBatregisterRows(master.data || {});
  if (master.app === 'dokumentarkiv') assertDocumentarkivRows(master.data || {});
  return master;
}
