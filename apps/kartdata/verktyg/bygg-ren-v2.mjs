import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materialize } from '../../../packages/core/domain/materializer.js';
import { validateOperation } from '../../../packages/core/domain/operations.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '../..');
const OUT = resolve(ROOT, 'privat/migrering-2026-08-04-ren-v2');
const requestedDropboxRoot = process.argv[2] || '/Users/simon/Dropbox/Appar/Korpholmen';
const DEVICE = 'migration-kartdata-clean-v2-2026-08-04';
const CLOCK_MS = 1785866400000;
const MIGRATION_ID = '2026-08-04-kartdata-clean-v2';
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function loadNamespace(namespace) {
  const opsRoot = resolve(requestedDropboxRoot, namespace, 'ops');
  const files = (await readdir(opsRoot)).filter(name => name.endsWith('.json')).sort();
  const texts = await Promise.all(files.map(name => readFile(resolve(opsRoot, name), 'utf8')));
  const documents = texts.map(JSON.parse);
  const operations = documents.flatMap(document => document.operations || document.ops || []);
  return { state: materialize(operations), operations, fingerprint: sha256(texts.join('\n')) };
}

const rows = (state, type) => state.listEntities(type).map(entity => ({ id: entity.entity_id, ...entity.fields }));
const unique = values => [...new Set(values.filter(Boolean))];
const normalize = value => String(value || '').trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('sv');
const normalizeIsland = value => ({ 'Stora Korpholmen': 'Korpholmen', 'Stora Sviholmen': 'Sviholmen' }[String(value || '').trim()] || String(value || '').trim());
const propertyIds = value => unique((String(value || '').match(/(?:Alsvik\s+)?3:\d+/gi) || []).map(token => /^Alsvik\s+/i.test(token) ? token.replace(/\s+/g, ' ') : `Alsvik ${token}`));
const activeObjectType = entry => {
  if (entry.review_status && entry.review_status !== 'ogranskad' && entry.review_object_class) return entry.review_object_class;
  const mapKind = String(entry.source_name_type || '');
  if (/symbol|annat/i.test(mapKind)) return 'kartsymbol';
  if (/ägaretikett/i.test(mapKind)) return 'ägaretikett';
  if (/husnamn/i.test(mapKind)) return 'byggnad';
  if (/äldre namn/i.test(mapKind)) return 'namnform';
  if (/ortnamn|plats/i.test(mapKind)) return 'plats';
  return null;
};

const [kartdata, fastigheter, matrikel] = await Promise.all([
  loadNamespace('kartdata'), loadNamespace('fastigheter'), loadNamespace('matrikel'),
]);
const baseDocuments = await Promise.all([
  'initial-ops.json', 'place-names-ops.json',
].map(name => readFile(resolve(ROOT, 'privat/migrering-2026-08-03', name), 'utf8').then(JSON.parse)));
const baseState = materialize(baseDocuments.flatMap(document => document.operations || []));

const islands = rows(kartdata.state, 'place').filter(place => place.subtype === 'ö');
if (!islands.length) throw new Error('Den levande Kartdata-mastern saknar öar');
if (rows(kartdata.state, 'building').length) throw new Error('V2-byggaren förväntar sig att den manuellt rensade mastern saknar separata byggnadsobjekt');
const islandsByName = new Map(islands.map(island => [normalize(island.preferred_name), island]));
const properties = rows(fastigheter.state, 'property');
const propertiesById = new Map(properties.map(property => [property.id, property]));
const people = rows(matrikel.state, 'person');
const peopleById = new Map(people.map(person => [person.id, person]));
const parties = rows(fastigheter.state, 'party');
const partiesById = new Map(parties.map(party => [party.id, party]));

const dataEntries = rows(kartdata.state, 'map-entry').map(entry => {
  const reviewed = entry.review_status && entry.review_status !== 'ogranskad';
  const objectType = activeObjectType(entry);
  const islandText = reviewed && entry.review_island ? entry.review_island : normalizeIsland(entry.source_island);
  const island = islandsByName.get(normalize(islandText)) || null;
  const candidates = reviewed ? entry.review_property_ids || [] : propertyIds(entry.source_property);
  const linkedProperties = candidates.filter(id => propertiesById.has(id));
  const invalidProperties = candidates.filter(id => !propertiesById.has(id));
  if (invalidProperties.length) throw new Error(`${entry.id} pekar på okända fastigheter: ${invalidProperties.join(', ')}`);
  return {
    id: entry.id,
    name: String((reviewed && entry.review_name) || entry.source_name || '').trim(),
    object_type: objectType,
    subtype: reviewed && entry.review_subtype && entry.review_subtype !== 'Utgått/fel' ? entry.review_subtype : null,
    review_status: entry.review_status || 'ogranskad',
    island_id: island?.id || null,
    property_ids: linkedProperties,
  };
}).filter(entry => !['kartsymbol', 'annat'].includes(entry.object_type));

if (dataEntries.some(entry => !entry.name || !['byggnad', 'plats', 'namnform', 'ägaretikett'].includes(entry.object_type))) throw new Error('En aktiv v2-post saknar namn eller har otillåten objekttyp');
if (new Set(dataEntries.map(entry => entry.id)).size !== dataEntries.length) throw new Error('V2-posterna har dubbla ID:n');

const observations = rows(fastigheter.state, 'observation');
const latestObservationByProperty = new Map();
for (const observation of observations) {
  const previous = latestObservationByProperty.get(observation.property_id);
  if (!previous || String(observation.observed_on || '').localeCompare(String(previous.observed_on || '')) > 0) latestObservationByProperty.set(observation.property_id, observation);
}

const usedPropertyIds = unique(dataEntries.flatMap(entry => entry.property_ids)).sort();
const ownerLinks = [];
const personRefs = new Map();
const externalParties = new Map();
for (const propertyId of usedPropertyIds) {
  const observation = latestObservationByProperty.get(propertyId);
  if (!observation) continue;
  for (const partyId of observation.owner_party_ids || []) {
    const party = partiesById.get(partyId);
    if (!party) throw new Error(`Ägarpart saknas i Fastighetshistorik: ${partyId}`);
    const person = party.person_id ? peopleById.get(party.person_id) : null;
    if (party.person_id && !person) throw new Error(`Parten ${partyId} pekar på saknad Matrikel-person ${party.person_id}`);
    const ownerType = person ? 'person-ref' : 'external-party';
    const ownerId = person?.id || party.id;
    if (person) personRefs.set(person.id, {
      external_id: person.id, display_name: person.display_name,
      full_name: person.full_name || person.display_name, source_master: 'matrikel',
      url: `../matrikel/?person=${encodeURIComponent(person.id)}`,
    });
    else externalParties.set(party.id, {
      external_id: party.id, display_name: party.name,
      party_type: party.party_type || 'extern part', source_master: 'fastigheter',
      url: `../fastigheter/?party=${encodeURIComponent(party.id)}`,
    });
    ownerLinks.push({
      property_id: propertyId, owner_type: ownerType, owner_id: ownerId,
      observed_on: observation.observed_on || null,
    });
  }
}

let seq = 0;
const operations = [];
function operation(entityType, entityId, field, value) {
  seq += 1;
  const op = {
    op_id: `${DEVICE}:${seq}`, device_id: DEVICE, seq,
    entity_type: entityType, entity_id: entityId, field, value,
    hlc: `${CLOCK_MS}-${String(seq).padStart(6, '0')}-${DEVICE}`, schema_version: 1,
  };
  validateOperation(op); operations.push(op);
}
function setFields(entityType, entityId, fields) { for (const [field, value] of Object.entries(fields)) operation(entityType, entityId, field, value); }
function remove(entityType, entityId) { operation(entityType, entityId, '__deleted', true); }

setFields('root', 'kartdata', {
  active_schema_version: 2,
  active_dataset: 'kartdata-v2',
  migration_id_v2: MIGRATION_ID,
  archived_entity_types: ['source', 'map-entry', 'map-entry-link', 'object-property-link'],
});

const activeByType = new Map([
  ['place', new Set(islands.map(item => item.id))],
  ['building', new Set()],
  ['name-record', new Set(rows(kartdata.state, 'name-record').map(item => item.id))],
  ['place-relation', new Set(rows(kartdata.state, 'place-relation').map(item => item.id))],
  ['object-property-link', new Set()],
  ['map-entry-link', new Set()],
]);
for (const [type, ids] of activeByType) {
  for (const base of rows(baseState, type)) if (!ids.has(base.id)) remove(type, base.id);
}

for (const island of islands) setFields('place', island.id, {
  preferred_name: island.preferred_name,
  subtype: 'ö',
  review_status: island.review_status || 'ogranskad',
  source_ids: null,
  note: null,
  valid_from: island.valid_from || null,
  valid_to: island.valid_to || null,
});
for (const name of rows(kartdata.state, 'name-record')) setFields('name-record', name.id, {
  target_type: name.target_type,
  target_id: name.target_id,
  name: name.name,
  name_type: name.name_type,
  review_status: name.review_status || 'ogranskad',
  source_ids: null,
  note: null,
  valid_from: name.valid_from || null,
  valid_to: name.valid_to || null,
});

for (const entry of dataEntries) {
  setFields('data-entry', entry.id, {
    name: entry.name,
    object_type: entry.object_type,
    subtype: entry.subtype,
    review_status: entry.review_status,
  });
  if (entry.island_id) setFields('data-entry-island-link', `entry:${entry.id}:island:${entry.island_id}`, { entry_id: entry.id, island_id: entry.island_id });
  for (const propertyId of entry.property_ids) setFields('data-entry-property-link', `entry:${entry.id}:property:${propertyId}`, { entry_id: entry.id, property_id: propertyId });
}
for (const propertyId of usedPropertyIds) {
  const property = propertiesById.get(propertyId);
  setFields('property-ref', `property-ref:${propertyId}`, {
    external_id: propertyId,
    display_name: property.display_name || propertyId,
    source_master: 'fastigheter',
    url: `../fastigheter/?property=${encodeURIComponent(propertyId)}`,
  });
}
for (const [id, fields] of personRefs) setFields('person-ref', `person-ref:${id}`, fields);
for (const [id, fields] of externalParties) setFields('external-party', `external-party:${id}`, fields);
for (const link of ownerLinks) setFields('property-owner-link', `property:${link.property_id}:owner:${link.owner_type}:${link.owner_id}`, link);

const combined = materialize([...kartdata.operations, ...operations]);
const activeEntries = rows(combined, 'data-entry');
if (activeEntries.length !== dataEntries.length) throw new Error('Materialiseringen tappade v2-poster');
if (activeEntries.some(entry => ['kartsymbol', 'annat'].includes(entry.object_type))) throw new Error('En borttagen objekttyp finns kvar i v2');
if (rows(combined, 'place').length !== islands.length) throw new Error('Den rensade ölistan matchar inte den levande mastern');

const preview = {
  format: 'korpholmen-kartdata-v2-preview',
  islands: rows(combined, 'place').map(place => ({ id: place.id, name: place.preferred_name, review_status: place.review_status })),
  entries: dataEntries.map(entry => ({
    id: entry.id, name: entry.name, object_type: entry.object_type, subtype: entry.subtype,
    review_status: entry.review_status, island_id: entry.island_id, property_ids: entry.property_ids,
  })),
  properties: usedPropertyIds.map(id => ({ id, display_name: propertiesById.get(id).display_name || id })),
  person_refs: [...personRefs].map(([id, fields]) => ({ id, ...fields })),
  external_parties: [...externalParties].map(([id, fields]) => ({ id, ...fields })),
  property_owner_links: ownerLinks,
};
const manifest = {
  format: 'korpholmen-kartdata-clean-v2-manifest',
  migration_id: MIGRATION_ID,
  inputs: {
    kartdata_ops_sha256: kartdata.fingerprint,
    fastigheter_ops_sha256: fastigheter.fingerprint,
    matrikel_ops_sha256: matrikel.fingerprint,
  },
  counts: {
    islands: islands.length,
    entries: dataEntries.length,
    island_links: dataEntries.filter(entry => entry.island_id).length,
    unresolved_island_links: dataEntries.filter(entry => !entry.island_id).length,
    property_links: dataEntries.reduce((sum, entry) => sum + entry.property_ids.length, 0),
    properties: usedPropertyIds.length,
    owner_links: ownerLinks.length,
    person_refs: personRefs.size,
    external_parties: externalParties.size,
    operations: operations.length,
  },
};
const document = { operations_version: 1, dataset: 'Korpholmen kartdata v2', device_id: DEVICE, migration_id: MIGRATION_ID, counts: manifest.counts, operations };

await mkdir(OUT, { recursive: true });
await writeFile(resolve(OUT, 'clean-v2-ops.json'), `${JSON.stringify(document, null, 2)}\n`);
await writeFile(resolve(OUT, 'preview.json'), `${JSON.stringify(preview, null, 2)}\n`);
await writeFile(resolve(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest.counts, null, 2));
