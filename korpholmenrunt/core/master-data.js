const rows = (master, type) => master?.initialized
  ? master.listEntities(type).map(entity => ({ id: entity.entity_id, ...entity.fields }))
  : [];

export function canonicalPeople(master) {
  return rows(master, 'person');
}

export function canonicalPersonMap(master) {
  return new Map(canonicalPeople(master).map(person => [person.id, person]));
}

export function resolvePartyName(party, personMaster) {
  if (!party) return '';
  const person = party.person_id ? canonicalPersonMap(personMaster).get(party.person_id) : null;
  return person?.display_name || party.name || party.id || '';
}

export function mergePersonReferences(references, personMaster, { includeUnreferenced = false } = {}) {
  const canonical = canonicalPersonMap(personMaster);
  const byId = new Map();
  for (const reference of references || []) {
    const externalId = reference.external_id || reference.person_id || reference.id;
    if (!externalId) continue;
    const person = canonical.get(externalId);
    byId.set(externalId, {
      ...reference,
      ...(person || {}),
      id: externalId,
      external_id: externalId,
      display_name: person?.display_name || reference.display_name || externalId,
      url: reference.url || `../matrikel/?person=${encodeURIComponent(externalId)}`,
      source_master: 'matrikel',
      resolution: person ? 'canonical-master' : 'cached-reference',
    });
  }
  if (includeUnreferenced) for (const [id, person] of canonical) if (!byId.has(id)) byId.set(id, {
    ...person,
    id,
    external_id: id,
    url: `../matrikel/?person=${encodeURIComponent(id)}`,
    source_master: 'matrikel',
    resolution: 'canonical-master',
  });
  return [...byId.values()];
}

export function resolveArchiveEntity(reference, { personMaster, boatMaster } = {}) {
  if (!reference || reference.match_status !== 'kopplad' || !reference.external_id) return reference;
  if (reference.entity_type === 'person') {
    const person = personMaster?.initialized ? personMaster.getEntity('person', reference.external_id)?.fields : null;
    return {
      ...reference,
      name: person?.display_name || reference.name,
      url: `../matrikel/?person=${encodeURIComponent(reference.external_id)}`,
      resolution: person ? 'canonical-master' : 'cached-reference',
    };
  }
  if (reference.entity_type === 'båt') {
    const boat = boatMaster?.initialized ? boatMaster.getEntity('boat', reference.external_id)?.fields : null;
    return {
      ...reference,
      name: boat?.namn || reference.name,
      url: `../batregister/?boat=${encodeURIComponent(reference.external_id)}`,
      resolution: boat ? 'canonical-master' : 'cached-reference',
    };
  }
  return reference;
}

export function resolvePropertyReferences(fastigheterMaster, fallbacks = []) {
  const canonical = rows(fastigheterMaster, 'property');
  if (!canonical.length) return [...fallbacks];
  return canonical.map(property => ({
    ...property,
    external_id: property.id,
    display_name: property.display_name || property.id,
    url: `../fastigheter/?property=${encodeURIComponent(property.id)}`,
    source_master: 'fastigheter',
    resolution: 'canonical-master',
  }));
}

export function resolveCurrentOwners(propertyId, fastigheterMaster, personMaster) {
  if (!fastigheterMaster?.initialized) return [];
  const assessment = rows(fastigheterMaster, 'current-owner-assessment').find(item => item.property_id === propertyId);
  if (!assessment) return [];
  const parties = new Map(rows(fastigheterMaster, 'party').map(party => [party.id, party]));
  const people = canonicalPersonMap(personMaster);
  return (assessment.owner_party_ids || []).map(partyId => {
    const party = parties.get(partyId);
    if (!party) return null;
    const person = party.person_id ? people.get(party.person_id) : null;
    return {
      property_id: propertyId,
      party_id: party.id,
      owner_type: person ? 'person' : 'party',
      owner_id: person?.id || party.id,
      display_name: person?.display_name || party.name || party.id,
      party_type: party.party_type || null,
      url: person ? `../matrikel/?person=${encodeURIComponent(person.id)}` : '#',
      source_master: person ? 'matrikel' : 'fastigheter',
      basis: assessment.basis || null,
      reviewed_on: assessment.reviewed_on || null,
      status: assessment.status || null,
    };
  }).filter(Boolean);
}
