import {
  buildFamilyContext,
  groupsForPerson,
  relationIsConfirmed,
} from '../../../packages/core/family-context.js';

const TYPE_ORDER = Object.freeze({ person: 0, boat: 1, property: 2, document: 3, year: 4, 'source-text': 5 });

export function normalizeExplorerText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('sv')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
const rows = (masters, app, type) => masters?.[app]?.[type] || [];
const byId = list => new Map(list.map(item => [item.id, item]));
const unique = values => [...new Set(values.filter(Boolean))];
const labelForPerson = person => person?.display_name || person?.full_name || person?.name || person?.id || 'Okänd person';
const labelForBoat = boat => boat?.visningsnamn || boat?.namn || boat?.name || boat?.id || 'Okänd båt';
const labelForProperty = property => property?.display_name || property?.name || property?.designation || property?.property_id || property?.id || 'Okänd fastighet';

function indexedItem({ type, id, label, detail = '', sourceApp, searchValues = [], sourceTextOnly = false }) {
  return {
    type,
    id,
    label,
    detail,
    sourceApp,
    sourceTextOnly,
    normalizedLabel: normalizeExplorerText(label),
    normalizedSearch: normalizeExplorerText([label, detail, ...searchValues].join(' ')),
  };
}

export function buildSearchIndex(masters = {}) {
  const index = [];
  for (const person of rows(masters, 'matrikel', 'person')) {
    index.push(indexedItem({
      type: 'person', id: person.id, label: labelForPerson(person), sourceApp: 'matrikel',
      detail: unique([person.club_name, person.klubbnamn, person.family, person.ui_clan]).join(' · '),
      searchValues: [person.full_name, person.first_name, person.last_name, person.surname, ...(person.family_labels || [])],
    }));
  }
  for (const boat of rows(masters, 'batregister', 'boat')) {
    index.push(indexedItem({
      type: 'boat', id: boat.id, label: labelForBoat(boat), sourceApp: 'batregister',
      detail: unique([boat.typ, boat.type, boat.visningsurskiljning, boat.agare]).join(' · '),
      searchValues: [boat.namn, boat.name, ...(boat.aliases || []), ...(boat.kallor_text || [])],
    }));
  }
  for (const property of rows(masters, 'fastigheter', 'property')) {
    index.push(indexedItem({
      type: 'property', id: property.id, label: labelForProperty(property), sourceApp: 'fastigheter',
      detail: unique([property.island_name, property.island, property.type]).join(' · '),
      searchValues: [property.property_id, property.official_designation, ...(property.aliases || [])],
    }));
  }
  for (const document of rows(masters, 'dokumentarkiv', 'document')) {
    index.push(indexedItem({
      type: 'document', id: document.id, label: document.title || document.id, sourceApp: 'dokumentarkiv',
      detail: unique([document.document_date, document.document_type]).join(' · '),
      // Avskriften är bara sökunderlag. Explorer återger inte eller äger texten.
      searchValues: [document.transcript],
    }));
  }

  const results = rows(masters, 'korpholmenrunt', 'race-result');
  const years = unique(results.map(result => Number(result.year)).filter(Number.isFinite)).sort((a, b) => b - a);
  for (const year of years) {
    index.push(indexedItem({
      type: 'year', id: String(year), label: `Korpholmen runt ${year}`, sourceApp: 'korpholmenrunt',
      detail: `${results.filter(result => Number(result.year) === year).length} resultat`,
    }));
  }
  for (const result of results) {
    const rawNames = Array.isArray(result.participants_raw) ? result.participants_raw : [];
    const boatName = result.boat_name_corrected || result.boat_name_raw || '';
    if (!rawNames.length && !boatName) continue;
    index.push(indexedItem({
      type: 'source-text', id: result.id, label: `Källrad ${result.year || 'utan år'}`, sourceApp: 'korpholmenrunt',
      detail: unique([boatName, ...rawNames, result.class_name, result.time_raw]).join(' · '),
      searchValues: [result.raw_row], sourceTextOnly: true,
    }));
  }
  return index;
}

function searchScore(item, query) {
  if (item.normalizedLabel === query) return 0;
  if (item.normalizedLabel.startsWith(query)) return 1;
  if (item.normalizedLabel.split(' ').some(word => word.startsWith(query))) return 2;
  if (item.normalizedLabel.includes(query)) return 3;
  if (item.normalizedSearch.includes(query)) return 4;
  return Number.POSITIVE_INFINITY;
}

export function searchExplorer(index, value, { limit = 40 } = {}) {
  const query = normalizeExplorerText(value);
  if (!query) return index.filter(item => !item.sourceTextOnly).slice(0, limit);
  return index
    .map(item => ({ item, score: searchScore(item, query) }))
    .filter(entry => Number.isFinite(entry.score))
    .sort((left, right) => left.score - right.score
      || Number(left.item.sourceTextOnly) - Number(right.item.sourceTextOnly)
      || (TYPE_ORDER[left.item.type] ?? 99) - (TYPE_ORDER[right.item.type] ?? 99)
      || left.item.label.localeCompare(right.item.label, 'sv', { numeric: true }))
    .slice(0, limit)
    .map(entry => entry.item);
}

function relationLabel(relation, personId) {
  if (relation.kind === 'foralder-barn') return relation.from_person_id === personId ? 'Barn' : 'Förälder';
  if (relation.kind === 'syskon') return 'Syskon';
  if (relation.kind === 'tidigare-partner') return 'Tidigare partner';
  if (relation.kind === 'partner') return 'Partner';
  return relation.kind || 'Relation';
}

function relationOtherId(relation, personId) {
  if (relation.from_person_id === personId) return relation.to_person_id;
  if (relation.to_person_id === personId) return relation.from_person_id;
  return null;
}

function buildRelations(people, relations, personId) {
  const peopleMap = byId(people);
  return relations.flatMap(relation => {
    const otherId = relationOtherId(relation, personId);
    if (!otherId) return [];
    const other = peopleMap.get(otherId);
    return [{
      id: relation.id,
      kind: relation.kind,
      label: relationLabel(relation, personId),
      personId: otherId,
      personName: labelForPerson(other),
      confirmed: relationIsConfirmed(relation),
    }];
  }).sort((left, right) => left.label.localeCompare(right.label, 'sv') || left.personName.localeCompare(right.personName, 'sv'));
}

function buildGroups(masters, people, relations, personId) {
  const familyUnits = rows(masters, 'matrikel', 'family-unit');
  const kinGroups = rows(masters, 'matrikel', 'kin-group');
  const propertyLinks = rows(masters, 'matrikel', 'property-link');
  const context = buildFamilyContext({
    people,
    relations,
    familyUnits,
    kinGroups,
    properties: rows(masters, 'fastigheter', 'property'),
    propertyLinks,
  });
  return groupsForPerson(personId, context).map(item => ({
    id: item.group.id,
    type: item.type,
    referenceCode: item.group.reference_code || '',
    name: item.group.name || item.group.reference_code || item.group.id,
    role: item.membership.role || '',
    confirmed: item.membership.confirmed,
  }));
}

function buildBoats(masters, personId) {
  const boats = byId(rows(masters, 'batregister', 'boat'));
  const ownerships = rows(masters, 'batregister', 'boat-ownership-observation').filter(owner =>
    owner.party_type === 'person' && owner.party_id === personId
    || owner.party_type === 'person-set' && (owner.party_ids || []).includes(personId));
  const legacyLinks = rows(masters, 'batregister', 'boat-person-link').filter(link => link.person_id === personId);
  const result = new Map();
  for (const owner of ownerships) {
    const boat = boats.get(owner.boat_id);
    result.set(owner.boat_id, {
      id: owner.boat_id,
      name: labelForBoat(boat),
      type: boat?.typ || boat?.type || '',
      roles: ['Ägare'],
      periods: unique([[owner.start, owner.end].filter(Boolean).join('–') || null]),
    });
  }
  for (const link of legacyLinks) {
    const boat = boats.get(link.boat_id);
    const current = result.get(link.boat_id) || {
      id: link.boat_id,
      name: labelForBoat(boat),
      type: boat?.typ || boat?.type || '',
      roles: [],
      periods: [],
    };
    current.roles = unique([...current.roles, link.role || 'Anknytning']);
    result.set(link.boat_id, current);
  }
  return [...result.values()].sort((left, right) => left.name.localeCompare(right.name, 'sv'));
}

function buildProperties(masters, personId) {
  const properties = byId(rows(masters, 'fastigheter', 'property'));
  const parties = rows(masters, 'fastigheter', 'party').filter(party => party.person_id === personId);
  const partyIds = new Set(parties.map(party => party.id));
  const ownedIds = new Set(rows(masters, 'fastigheter', 'current-owner-assessment')
    .filter(assessment => (assessment.owner_party_ids || []).some(id => partyIds.has(id)))
    .map(assessment => assessment.property_id));
  const associatedIds = new Set([
    ...rows(masters, 'matrikel', 'property-link').filter(link => link.person_id === personId).map(link => link.property_id),
    ...rows(masters, 'fastigheter', 'community-link').filter(link => link.person_id === personId).map(link => link.property_id),
  ]);
  return unique([...ownedIds, ...associatedIds]).map(id => ({
    id,
    name: labelForProperty(properties.get(id) || { id }),
    currentOwner: ownedIds.has(id),
    associated: associatedIds.has(id),
  })).sort((left, right) => left.name.localeCompare(right.name, 'sv', { numeric: true }));
}

function buildRaceResults(masters, personId) {
  const connected = rows(masters, 'korpholmenrunt', 'race-person-link').filter(link =>
    link.person_id === personId
    && (link.confirmed === true || ['kopplad', 'manuell', 'godkand', 'godkänd'].includes(link.match_status)));
  const resultMap = byId(rows(masters, 'korpholmenrunt', 'race-result'));
  const boatMap = byId(rows(masters, 'batregister', 'boat'));
  return connected.flatMap(link => {
    const result = resultMap.get(link.result_id);
    if (!result) return [];
    const boat = boatMap.get(result.boat_id);
    return [{
      id: result.id,
      year: result.year,
      course: result.course_code || '',
      className: result.class_name || result.class_raw || '',
      time: result.time_raw || '',
      boatId: result.boat_id || '',
      boatName: labelForBoat(boat || { id: result.boat_id, name: result.boat_name_corrected || result.boat_name_raw }),
      rawName: link.raw_name || '',
    }];
  }).sort((left, right) => Number(right.year || 0) - Number(left.year || 0) || String(left.time).localeCompare(String(right.time), 'sv'));
}

function buildDocuments(masters, personId) {
  const archiveEntityIds = new Set(rows(masters, 'dokumentarkiv', 'archive-entity')
    .filter(entity => entity.entity_type === 'person' && entity.external_id === personId && entity.match_status === 'kopplad')
    .map(entity => entity.id));
  return rows(masters, 'dokumentarkiv', 'document').filter(document =>
    (document.entity_ids || []).some(id => archiveEntityIds.has(id))
    || (document.entity_links || []).some(link => archiveEntityIds.has(link.entity_id)))
    .map(document => ({
      id: document.id,
      title: document.title || document.id,
      date: document.document_date || '',
      type: document.document_type || '',
    }))
    .sort((left, right) => String(right.date).localeCompare(String(left.date), 'sv'));
}

function buildClubOccurrences(masters, personId) {
  const releases = byId(rows(masters, 'klubbhistorik', 'matrikel-release'));
  return rows(masters, 'klubbhistorik', 'person-occurrence')
    .filter(item => item.person_id === personId && item.confirmed === true && item.retained !== false)
    .map(item => {
      const release = releases.get(item.release_id);
      return {
        id: item.id,
        releaseId: item.release_id,
        year: release?.year || release?.as_of?.slice?.(0, 4) || item.release_id?.match?.(/\d{4}/)?.[0] || '',
        name: item.person_name_raw || '',
        membershipStatus: item.membership_status || '',
        clubName: item.club_name_raw || item.club_name_core_raw || '',
      };
    }).sort((left, right) => Number(right.year || 0) - Number(left.year || 0));
}

export function buildPersonProfile(masters = {}, personId) {
  const people = rows(masters, 'matrikel', 'person');
  const person = byId(people).get(personId);
  if (!person) return null;
  const relations = rows(masters, 'matrikel', 'relation');
  return {
    id: person.id,
    person,
    name: labelForPerson(person),
    relations: buildRelations(people, relations, personId),
    groups: buildGroups(masters, people, relations, personId),
    boats: buildBoats(masters, personId),
    properties: buildProperties(masters, personId),
    raceResults: buildRaceResults(masters, personId),
    documents: buildDocuments(masters, personId),
    clubOccurrences: buildClubOccurrences(masters, personId),
  };
}
