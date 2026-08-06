import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materialize } from '../../../packages/core/domain/materializer.js';
import { validateOperation } from '../../../packages/core/domain/operations.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'privat/migrering-2026-08-04-aktuella-agare');
const dropboxRoot = process.argv[2] || '/Users/simon/Dropbox/Appar/Korpholmen';
const DEVICE = 'migration-kartdata-current-owners-2026-08-04';
const MIGRATION_ID = '2026-08-04-kartdata-current-owners';
const CLOCK_MS = 1785869100000;
const slug = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'post';

async function loadNamespace(namespace) {
  const root = resolve(dropboxRoot, namespace, 'ops');
  const files = (await readdir(root)).filter(name => name.endsWith('.json')).sort();
  const documents = await Promise.all(files.map(name => readFile(resolve(root, name), 'utf8').then(JSON.parse)));
  const operations = documents.flatMap(document => document.operations || document.ops || []);
  return materialize(operations);
}
const rows = (state, type) => state.listEntities(type).map(entity => ({ id: entity.entity_id, ...entity.fields }));

const [kartdata, fastigheter, matrikel] = await Promise.all([loadNamespace('kartdata'), loadNamespace('fastigheter'), loadNamespace('matrikel')]);
const usedPropertyIds = new Set(rows(kartdata, 'data-entry-property-link').map(link => link.property_id));
const assessments = rows(fastigheter, 'current-owner-assessment').filter(assessment => usedPropertyIds.has(assessment.property_id));
const parties = new Map(rows(fastigheter, 'party').map(party => [party.id, party]));
const people = new Map(rows(matrikel, 'person').map(person => [person.id, person]));

let seq = 0;
const operations = [];
function set(entityType, entityId, field, value) {
  seq += 1;
  const operation = { op_id: `${DEVICE}:${seq}`, device_id: DEVICE, seq, entity_type: entityType, entity_id: entityId, field, value, hlc: `${CLOCK_MS}-${String(seq).padStart(6, '0')}-${DEVICE}`, schema_version: 1 };
  validateOperation(operation); operations.push(operation);
}
function setFields(entityType, entityId, fields) { for (const [field, value] of Object.entries(fields)) set(entityType, entityId, field, value); }

let links = 0;
for (const assessment of assessments) {
  for (const partyId of assessment.owner_party_ids || []) {
    const party = parties.get(partyId);
    if (!party) throw new Error(`Ägarpart saknas: ${partyId}`);
    const person = party.person_id ? people.get(party.person_id) : null;
    if (party.person_id && !person) throw new Error(`Matrikelpersonen saknas: ${party.person_id}`);
    const ownerType = person ? 'person-ref' : 'external-party';
    const ownerId = person?.id || party.id;
    if (person) setFields('person-ref', `person-ref:${person.id}`, { external_id: person.id, display_name: person.display_name, full_name: person.full_name || person.display_name, display_surname: party.display_surname || null, source_master: 'matrikel', url: `../matrikel/?person=${encodeURIComponent(person.id)}` });
    else setFields('external-party', `external-party:${party.id}`, { external_id: party.id, display_name: party.name, display_surname: party.display_surname || null, party_type: party.party_type || 'extern part', source_master: 'fastigheter', url: `../fastigheter/?party=${encodeURIComponent(party.id)}` });
    setFields('property-owner-link', `current-owner:${slug(assessment.property_id)}:${ownerType}:${slug(ownerId)}`, {
      property_id: assessment.property_id,
      owner_type: ownerType,
      owner_id: ownerId,
      basis: 'best-known-current',
      reviewed_on: assessment.reviewed_on || null,
    });
    links += 1;
  }
}
setFields('root', 'kartdata', { current_owner_migration_id: MIGRATION_ID, current_owner_basis: 'best-known-current' });

const document = { operations_version: 1, dataset: 'Korpholmen kartdata aktuella ägare', device_id: DEVICE, migration_id: MIGRATION_ID, counts: { assessments: assessments.length, owner_links: links, operations: operations.length }, operations };
await mkdir(OUT, { recursive: true });
await writeFile(resolve(OUT, 'current-owner-ops.json'), `${JSON.stringify(document, null, 2)}\n`);
await writeFile(resolve(OUT, 'manifest.json'), `${JSON.stringify({ migration_id: MIGRATION_ID, ...document.counts }, null, 2)}\n`);
console.log(JSON.stringify({ migration_id: MIGRATION_ID, ...document.counts }, null, 2));
