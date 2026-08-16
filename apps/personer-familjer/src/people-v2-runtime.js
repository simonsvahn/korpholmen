import { PeopleMembershipMaster } from '../../../packages/core/people-membership-master.js';
import { createActiveAppBundle } from '../../../packages/core/active-app-bundle.js';
import { buildGraph, componentSets } from './landscape-model.js';

const entityRows = (master, type) => master.listEntities(type).map(entity => ({ id: entity.entity_id, ...entity.fields }));
const unique = values => [...new Set(values.filter(Boolean))];
const relationType = relation => relation.relation_type || relation.kind || '';
const CONTEXT_SOURCES = Object.freeze({
  boats: Object.freeze({ pointerPath: '/batregister-generation2/active.json', app: 'batregister', requiredCollections: ['boats'] }),
  properties: Object.freeze({ pointerPath: '/fastigheter-generation2/active.json', app: 'fastigheter', requiredCollections: ['properties', 'timeline_entries', 'affiliations'] }),
  documents: Object.freeze({ pointerPath: '/dokumentarkiv-generation2/active.json', app: 'dokumentarkiv', requiredCollections: ['documents', 'document_links'] }),
  race: Object.freeze({ pointerPath: '/korpholmenrunt-generation2/active.json', app: 'korpholmenrunt', requiredCollections: ['results', 'participants'] }),
});

export function familyUnitView(family, people = [], relations = []) {
  if (!family) return null;
  const peopleById = new Map(people.map(person => [person.id, person]));
  const anchorIds = unique(family.anchor_person_ids || []).filter(id => peopleById.has(id));
  const childIdsByAnchor = new Map(anchorIds.map(id => [id, new Set()]));
  for (const relation of relations) {
    if (relationType(relation) !== 'foralder-barn') continue;
    if (!childIdsByAnchor.has(relation.from_person_id) || !peopleById.has(relation.to_person_id)) continue;
    childIdsByAnchor.get(relation.from_person_id).add(relation.to_person_id);
  }
  const sharedChildIds = anchorIds.length > 1
    ? [...(childIdsByAnchor.get(anchorIds[0]) || [])].filter(id => anchorIds.slice(1).every(anchorId => childIdsByAnchor.get(anchorId)?.has(id)))
    : [];
  // Trädet följer alltid de faktiska föräldrabanden. Äldre familjeenheter
  // saknar ibland den senare membership_rule-markeringen, men barnen ska ändå
  // synas i familjevyn när båda ankarpersonerna är registrerade som föräldrar.
  const childIds = sharedChildIds;
  const partyMemberIds = family.membership_rule === 'anchors_and_shared_children'
    ? [...anchorIds, ...childIds]
    : anchorIds;
  const anchors = anchorIds.map(id => peopleById.get(id));
  const children = childIds.map(id => peopleById.get(id));
  return {
    ...family,
    anchors,
    children,
    member_ids: [...anchorIds, ...childIds],
    party_member_ids: partyMemberIds,
    member_count: anchorIds.length + childIds.length,
  };
}

export function kinshipView(people = [], relations = []) {
  const normalizedRelations = relations.map(relation => ({
    ...relation,
    kind: relationType(relation),
  }));
  const graph = buildGraph(people, normalizedRelations);
  const components = componentSets(people, normalizedRelations);
  return {
    graph,
    relations: normalizedRelations,
    connected: components.filter(component => component.size > 1),
    isolated: components.filter(component => component.size === 1),
  };
}

export class PeopleV2Runtime {
  constructor({ store } = {}) {
    this.master = new PeopleMembershipMaster({ store, cacheKey: 'personer-familjer-active-v2' });
    this.store = store;
    this.context = null;
    this.contextError = null;
  }

  async init() {
    await this.master.init();
    this.context = await createActiveAppBundle({ store: this.store, cacheKey: 'personer-familjer-context-v2', sources: CONTEXT_SOURCES }).init();
    return this;
  }

  hasData() { return this.master.listEntities('person').length > 0; }

  async sync(transport) {
    const result = await this.master.sync(transport);
    this.contextError = null;
    try { await this.context.sync(transport); }
    catch (error) { this.contextError = error; }
    return { ...result, contextError: this.contextError };
  }

  listPeople() {
    return entityRows(this.master, 'person')
      .sort((left, right) => left.display_name.localeCompare(right.display_name, 'sv', { numeric: true }));
  }

  getPerson(id) { return this.listPeople().find(person => person.id === id) || null; }

  listRelations() { return entityRows(this.master, 'relation'); }

  listFamilies() {
    const people = this.listPeople();
    const relations = this.listRelations();
    return entityRows(this.master, 'family-unit')
      .map(family => familyUnitView(family, people, relations))
      .filter(Boolean)
      .sort((left, right) => String(left.display_name || left.reference_code).localeCompare(String(right.display_name || right.reference_code), 'sv', { numeric: true }));
  }

  getFamily(id) { return this.listFamilies().find(family => family.id === id) || null; }

  familiesFor(personId) { return this.listFamilies().filter(family => family.member_ids.includes(personId)); }

  kinship() { return kinshipView(this.listPeople(), this.listRelations()); }

  contextList(source, collection) { return this.context?.list(source, collection) || []; }

  boatsFor(personId) {
    const partyIds = new Set([
      personId,
      ...this.listFamilies()
        .filter(family => family.party_member_ids.includes(personId))
        .map(family => family.id),
    ]);
    return this.contextList('boats', 'boats').filter(boat => (boat.events || []).some(event => (event.participants || []).some(participant => participant.party_ref?.master === 'people' && partyIds.has(participant.party_ref.entity_id))));
  }

  propertiesFor(personId) {
    const propertyIds = new Set();
    this.contextList('properties', 'affiliations').forEach(row => {
      if (row.person_ref?.master === 'people' && row.person_ref.entity_id === personId) propertyIds.add(row.property_ref?.entity_id);
    });
    this.contextList('properties', 'timeline_entries').forEach(row => {
      if ((row.parties || []).some(party => party.party_ref?.master === 'people' && party.party_ref.entity_id === personId)) (row.property_ids || []).forEach(id => propertyIds.add(id));
    });
    return this.contextList('properties', 'properties').filter(property => propertyIds.has(property.id));
  }

  documentsFor(personId) {
    const documentIds = new Set(this.contextList('documents', 'document_links')
      .filter(link => link.target_ref?.master === 'people' && link.target_ref?.entity_type === 'person' && link.target_ref.entity_id === personId)
      .map(link => link.document_ref?.entity_id || link.source_document_ref?.entity_id || link.document_id)
      .filter(Boolean));
    return this.contextList('documents', 'documents').filter(document => documentIds.has(document.id));
  }

  raceYearsFor(personId) {
    const resultIds = new Set(this.contextList('race', 'participants')
      .filter(participant => participant.person_ref?.master === 'people' && participant.person_ref?.entity_type === 'person' && participant.person_ref.entity_id === personId)
      .map(participant => participant.result_id));
    const counts = new Map();
    this.contextList('race', 'results').forEach(result => {
      if (!resultIds.has(result.id)) return;
      counts.set(String(result.year), (counts.get(String(result.year)) || 0) + 1);
    });
    return [...counts].map(([year, count]) => ({ year, count })).sort((left, right) => Number(right.year) - Number(left.year));
  }

  relationsFor(personId) {
    return this.listRelations().filter(relation => relation.from_person_id === personId || relation.to_person_id === personId);
  }

  relatedPerson(relation, personId) {
    return this.getPerson(relation.from_person_id === personId ? relation.to_person_id : relation.from_person_id);
  }

  relationLabel(relation, personId) {
    const type = relationType(relation);
    if (type === 'foralder-barn') return relation.from_person_id === personId ? 'Barn' : 'Förälder';
    if (type === 'partner') return 'Partner';
    if (type === 'tidigare') return 'Tidigare partner';
    if (type === 'syskon') return 'Syskon';
    return type || 'Relation';
  }
}

export const createPeopleV2Runtime = options => new PeopleV2Runtime(options);
