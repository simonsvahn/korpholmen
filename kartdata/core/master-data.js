const rows = (master, type) => master?.initialized
  ? master.listEntities(type).map(entity => ({ id: entity.entity_id, ...entity.fields }))
  : [];

export function canonicalPeople(master) {
  return rows(master, 'person');
}

export function canonicalPersonMap(master) {
  return new Map(canonicalPeople(master).map(person => [person.id, person]));
}

export function canonicalBoats(master) {
  return rows(master, 'boat');
}

export function canonicalBoatMap(master) {
  return new Map(canonicalBoats(master).map(boat => [boat.id, boat]));
}

export function resolvePartyName(party, personMaster) {
  if (!party) return '';
  const person = party.person_id ? canonicalPersonMap(personMaster).get(party.person_id) : null;
  return person?.display_name || party.name || party.id || '';
}

function inferredSurname(value) {
  const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
  return parts.at(-1) || '';
}

export function ownerSurnameLabel(owner) {
  if (!owner) return '';
  const explicit = owner.display_surname || owner.surname || owner.last_name || owner.family_name;
  if (explicit) return String(explicit).trim();
  const name = owner.display_name || owner.name || owner.id || '';
  if (owner.party_type === 'organisation') return String(name).trim();
  return inferredSurname(name);
}

export function formatSwedishList(values) {
  const items = [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))];
  if (items.length < 2) return items[0] || '';
  if (items.length === 2) return `${items[0]} och ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} och ${items.at(-1)}`;
}

export function formatPropertyDisplayName(propertyId, owners = []) {
  const id = String(propertyId || '').trim();
  const ownerLabel = formatSwedishList(owners.map(ownerSurnameLabel));
  return ownerLabel ? `${id} (${ownerLabel})` : id;
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
      url: reference.url || `../personer-familjer/?person=${encodeURIComponent(externalId)}`,
      source_master: 'matrikel',
      resolution: person ? 'canonical-master' : 'cached-reference',
    });
  }
  if (includeUnreferenced) for (const [id, person] of canonical) if (!byId.has(id)) byId.set(id, {
    ...person,
    id,
    external_id: id,
    url: `../personer-familjer/?person=${encodeURIComponent(id)}`,
    source_master: 'matrikel',
    resolution: 'canonical-master',
  });
  return [...byId.values()];
}

const textValues = values => [...new Set((values || []).flat().map(value => String(value || '').trim()).filter(Boolean))];

export function resolvePropertyIslandNames(propertyId, kartdataMaster, { fallback = [] } = {}) {
  const fallbackNames = textValues(fallback);
  const places = rows(kartdataMaster, 'place').filter(place => place.subtype === 'ö');
  if (!places.length) return fallbackNames;
  const entryIds = new Set(rows(kartdataMaster, 'data-entry-property-link')
    .filter(link => link.property_id === propertyId)
    .map(link => link.entry_id));
  const islandIds = textValues(rows(kartdataMaster, 'data-entry-island-link')
    .filter(link => entryIds.has(link.entry_id))
    .map(link => link.island_id));
  const placesById = new Map(places.map(place => [place.id, place]));
  return textValues(islandIds.map(id => placesById.get(id)?.preferred_name));
}

function boatAliases(boat) {
  return textValues([
    boat?.dopnamn,
    boat?.onskat_namn,
    boat?.smeknamn || [],
    boat?.tidigare_namn || [],
    boat?.senare_namn || [],
  ]);
}

function resolvedBoatReference(reference, boat, externalId) {
  const canonicalName = boat?.namn || boat?.onskat_namn || boat?.modell;
  const name = canonicalName || reference?.name || 'Namn okänt';
  return {
    ...(reference || {}),
    ...(boat || {}),
    id: externalId,
    external_id: externalId,
    name,
    aliases: textValues([reference?.aliases || [], boatAliases(boat)]).filter(alias => alias !== name),
    type: boat?.typ || reference?.type || '',
    period: boat?.period ?? reference?.period ?? '',
    owner_text: boat?.agare || boat?.agarnamn || reference?.owner_text || '',
    url: reference?.url || `../batregister/?boat=${encodeURIComponent(externalId)}`,
    source_master: 'batregister',
    resolution: boat ? 'canonical-master' : 'cached-reference',
  };
}

export function mergeBoatReferences(references, boatMaster, { includeUnreferenced = false } = {}) {
  const canonical = canonicalBoatMap(boatMaster);
  const byId = new Map();
  for (const reference of references || []) {
    const externalId = reference.external_id || reference.boat_id || reference.id;
    if (!externalId) continue;
    byId.set(externalId, resolvedBoatReference(reference, canonical.get(externalId), externalId));
  }
  if (includeUnreferenced) for (const [id, boat] of canonical) if (!byId.has(id)) {
    byId.set(id, resolvedBoatReference(null, boat, id));
  }
  return [...byId.values()];
}

export function resolveArchiveEntity(reference, { personMaster, boatMaster, fastigheterMaster, kartdataMaster } = {}) {
  if (!reference || reference.match_status !== 'kopplad' || !reference.external_id) return reference;
  if (reference.entity_type === 'person') {
    const person = personMaster?.initialized ? personMaster.getEntity('person', reference.external_id)?.fields : null;
    return {
      ...reference,
      name: person?.display_name || reference.name,
      url: `../personer-familjer/?person=${encodeURIComponent(reference.external_id)}`,
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
  if (reference.entity_type === 'fastighet') {
    const property = fastigheterMaster?.getEntity?.('property', reference.external_id);
    if (!property) return reference;
    const name = resolvePropertyDisplayName(reference.external_id, fastigheterMaster);
    return { ...reference, name, display_name: name, resolution: 'canonical-master', url: `../fastigheter/?property=${encodeURIComponent(reference.external_id)}` };
  }
  if (reference.entity_type === 'plats' || reference.entity_type === 'hus') {
    const externalType = reference.external_entity_type || (reference.entity_type === 'hus' ? 'data-entry' : 'place');
    if (!['place', 'data-entry'].includes(externalType)) return reference;
    const target = kartdataMaster?.getEntity?.(externalType, reference.external_id)?.fields;
    if (!target) return reference;
    const name = externalType === 'place' ? target.preferred_name : target.name;
    const parameter = externalType === 'place' ? 'island' : 'entry';
    return {
      ...reference,
      name: name || reference.name,
      app: 'Kartdata',
      resolution: 'canonical-master',
      url: `../kartdata/?${parameter}=${encodeURIComponent(reference.external_id)}`,
    };
  }
  return reference;
}

export function resolvePropertyReferences(
  fastigheterMaster,
  fallbacks = [],
  personMaster = null,
  { includeOwnerLabel = true } = {},
) {
  const canonical = rows(fastigheterMaster, 'property');
  if (!canonical.length) return [...fallbacks];
  return canonical.map(property => ({
    ...property,
    external_id: property.id,
    display_name: includeOwnerLabel
      ? resolvePropertyDisplayName(property.id, fastigheterMaster, personMaster)
      : property.id,
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
      display_surname: party.display_surname || person?.surname || person?.last_name || person?.family_name || null,
      party_type: party.party_type || null,
      url: person ? `../personer-familjer/?person=${encodeURIComponent(person.id)}` : '#',
      source_master: person ? 'matrikel' : 'fastigheter',
      basis: assessment.basis || null,
      reviewed_on: assessment.reviewed_on || null,
      status: assessment.status || null,
    };
  }).filter(Boolean);
}

export function resolvePropertyDisplayName(propertyId, fastigheterMaster, personMaster = null) {
  return formatPropertyDisplayName(propertyId, resolveCurrentOwners(propertyId, fastigheterMaster, personMaster));
}
