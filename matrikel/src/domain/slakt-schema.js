const RELATION_KINDS = new Set(['foralder-barn', 'syskon', 'partner', 'tidigare']);

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} saknas`);
  return value;
}

export function relationEntityId(kind, fromPersonId, toPersonId) {
  requiredText(kind, 'Relationstyp');
  requiredText(fromPersonId, 'Från-person');
  requiredText(toPersonId, 'Till-person');
  if (!RELATION_KINDS.has(kind)) throw new TypeError(`Okänd relationstyp: ${kind}`);
  if (fromPersonId === toPersonId) throw new TypeError('En person kan inte ha en relation till sig själv');
  const endpoints = kind === 'foralder-barn'
    ? [fromPersonId, toPersonId]
    : [fromPersonId, toPersonId].sort((a, b) => a.localeCompare(b, 'sv'));
  return `relation:${kind}:${endpoints[0]}:${endpoints[1]}`;
}

export function propertyLinkEntityId(personId, propertyId) {
  requiredText(personId, 'Person-id');
  requiredText(propertyId, 'Fastighets-id');
  return `property-link:${personId}:${propertyId}`;
}

export function validateArchive(archive) {
  if (!archive || archive.schema_version !== 1) throw new TypeError('Arkivet har fel schemaversion');
  if (!Array.isArray(archive.persons) || !Array.isArray(archive.relations)) throw new TypeError('Arkivet saknar personer eller relationer');
  const personIds = new Set();
  for (const person of archive.persons) {
    requiredText(person.id, 'Person-id');
    requiredText(person.fields?.display_name, `Visningsnamn för ${person.id}`);
    if (personIds.has(person.id)) throw new Error(`Dubblerat person-id: ${person.id}`);
    personIds.add(person.id);
  }
  const relationIds = new Set();
  for (const relation of archive.relations) {
    const expected = relationEntityId(
      relation.fields?.kind,
      relation.fields?.from_person_id,
      relation.fields?.to_person_id
    );
    if (relation.id !== expected) throw new Error(`Fel relations-id: ${relation.id}`);
    if (relationIds.has(relation.id)) throw new Error(`Dubblerad relation: ${relation.id}`);
    if (!personIds.has(relation.fields.from_person_id) || !personIds.has(relation.fields.to_person_id)) {
      throw new Error(`Relationen ${relation.id} pekar på en person som saknas`);
    }
    relationIds.add(relation.id);
  }
  return archive;
}

export function archiveToEntities(archive) {
  validateArchive(archive);
  return [
    ...archive.persons.map(person => ({ entity_type: 'person', entity_id: person.id, fields: person.fields })),
    ...archive.relations.map(relation => ({ entity_type: 'relation', entity_id: relation.id, fields: relation.fields }))
  ];
}
