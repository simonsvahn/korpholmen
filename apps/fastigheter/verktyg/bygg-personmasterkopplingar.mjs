import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSetOperation, materialize, validateBatch } from '../../../packages/core/data-layer.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '../..');
const DROPBOX_ROOT = resolve(process.argv[2] || '/Users/simon/Dropbox/Appar/Korpholmen');
const SOURCE_PATH = resolve(ROOT, 'privat/kallkopior/fastighetshistorik.json');
const MATRIKEL_OUTPUT = resolve(REPO, 'apps/personer-familjer/privat/korrigeringar/2026-08-04-externa-fastighetsagare.json');
const FASTIGHETER_OUTPUT = resolve(ROOT, 'privat/migrering-2026-08-04-personmaster/party-links.json');
const PERSON_DEVICE = 'migration-matrikel-externa-fastighetsagare-2026-08-04';
const PARTY_DEVICE = 'migration-fastigheter-personmaster-2026-08-04';
const CLOCK_MS = Date.UTC(2026, 7, 4, 20, 0, 0);

const hash = value => createHash('sha256').update(value).digest('hex');
const normalize = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('sv').replace(/[^a-z0-9]+/g, ' ').trim();
const personIdForParty = partyId => `extern-fastighet-${String(partyId).replace(/^party-/, '')}`;

async function readMaster(relative) {
  const directory = resolve(DROPBOX_ROOT, relative, 'ops');
  const files = (await readdir(directory)).filter(name => name.endsWith('.json')).sort();
  const batches = await Promise.all(files.map(name => readFile(resolve(directory, name), 'utf8').then(JSON.parse)));
  batches.forEach(validateBatch);
  return batches.flatMap(batch => batch.ops);
}

const [matrikelOps, fastigheterOps, sourceBytes] = await Promise.all([
  readMaster('matrikel'), readMaster('fastigheter'), readFile(SOURCE_PATH),
]);
if (matrikelOps.some(operation => operation.device_id === PERSON_DEVICE) || fastigheterOps.some(operation => operation.device_id === PARTY_DEVICE)) {
  throw new Error('Migreringen finns redan i Dropbox-mastern. Befintliga utdata ska användas; bygg inte om med ett nytt klockslag.');
}
const matrikelState = materialize(matrikelOps);
const fastigheterState = materialize(fastigheterOps);
const people = matrikelState.listEntities('person').map(entity => ({ id: entity.entity_id, ...entity.fields }));
const peopleByNormalizedName = new Map();
for (const person of people) {
  const key = normalize(person.display_name);
  if (!peopleByNormalizedName.has(key)) peopleByNormalizedName.set(key, []);
  peopleByNormalizedName.get(key).push(person);
}
const parties = new Map(fastigheterState.listEntities('party').map(entity => [entity.entity_id, { id: entity.entity_id, ...entity.fields }]));
const currentPartyIds = [...new Set(fastigheterState.listEntities('current-owner-assessment').flatMap(entity => entity.fields.owner_party_ids || []))];
const candidates = currentPartyIds.map(id => parties.get(id)).filter(party => party && !party.person_id && party.party_type !== 'organisation' && party.party_type !== 'kollektiv');
if (candidates.length !== 24) throw new Error(`Förväntade 24 externa nuvarande personägare, fick ${candidates.length}`);

for (const party of candidates) {
  if (party.party_type !== 'person eller namngrupp') throw new Error(`${party.id}: oväntad parttyp ${party.party_type}`);
  if (/\boch\b|,|\/|\?|arvingar|familj|dödsbo/iu.test(party.name)) throw new Error(`${party.id}: ser inte ut som en entydig person: ${party.name}`);
  const collisions = peopleByNormalizedName.get(normalize(party.name)) || [];
  if (collisions.length) throw new Error(`${party.id}: namnmatchning kräver manuell identitetsprövning mot ${collisions.map(person => person.id).join(', ')}`);
  if (matrikelState.getEntity('person', personIdForParty(party.id))) throw new Error(`${party.id}: mål-ID finns redan`);
}

const buildOperations = (deviceId, records) => {
  let sequence = 0;
  const operations = [];
  for (const record of records) for (const [field, value] of Object.entries(record.fields)) {
    sequence += 1;
    operations.push(createSetOperation({ deviceId, seq: sequence, entityType: record.entityType, entityId: record.entityId, field, value, hlc: `${CLOCK_MS}-${String(sequence).padStart(6, '0')}-${deviceId}` }));
  }
  return operations;
};

const personRecords = candidates.map(party => ({ entityType: 'person', entityId: personIdForParty(party.id), fields: {
  display_name: party.name,
  person_scope: 'extern',
  identity_status: 'separat identitet, ännu inte sammanslagen med annan person',
  source_master: 'fastigheter',
  source_external_id: party.id,
} }));
const partyRecords = candidates.map(party => ({ entityType: 'party', entityId: party.id, fields: {
  person_id: personIdForParty(party.id),
  identity_status: 'kopplad till Matrikelns externa personmaster',
} }));
const personOperations = buildOperations(PERSON_DEVICE, personRecords);
const partyOperations = buildOperations(PARTY_DEVICE, partyRecords);

const finalMatrikel = materialize([...matrikelOps, ...personOperations]);
const finalFastigheter = materialize([...fastigheterOps, ...partyOperations]);
for (const party of candidates) {
  const personId = personIdForParty(party.id);
  if (finalMatrikel.getEntity('person', personId)?.fields.display_name !== party.name) throw new Error(`${personId}: personposten kunde inte verifieras`);
  if (finalFastigheter.getEntity('party', party.id)?.fields.person_id !== personId) throw new Error(`${party.id}: partlänken kunde inte verifieras`);
}

const base = {
  operations_version: 1,
  migration_id: '2026-08-04-externa-fastighetsagare-till-personmaster',
  source_sha256: hash(sourceBytes),
  identity_rule: 'En ny separat person per redan strukturerad nuvarande ägarpart. Ingen namnmatchning eller sammanslagning.',
  parties: candidates.map(party => ({ party_id: party.id, person_id: personIdForParty(party.id), display_name: party.name })),
};
await mkdir(dirname(MATRIKEL_OUTPUT), { recursive: true });
await mkdir(dirname(FASTIGHETER_OUTPUT), { recursive: true });
await writeFile(MATRIKEL_OUTPUT, `${JSON.stringify({ ...base, target_master: 'matrikel', device_id: PERSON_DEVICE, operations: personOperations }, null, 2)}\n`);
await writeFile(FASTIGHETER_OUTPUT, `${JSON.stringify({ ...base, target_master: 'fastigheter', device_id: PARTY_DEVICE, operations: partyOperations }, null, 2)}\n`);

const source = JSON.parse(sourceBytes);
source.person_links ||= {};
for (const party of candidates) source.person_links[party.name] = personIdForParty(party.id);
await writeFile(SOURCE_PATH, `${JSON.stringify(source, null, 2)}\n`);
console.log(JSON.stringify({ external_people: candidates.length, matrikel_operations: personOperations.length, fastigheter_operations: partyOperations.length, organization_parties_unchanged: currentPartyIds.filter(id => parties.get(id)?.party_type === 'organisation') }, null, 2));
