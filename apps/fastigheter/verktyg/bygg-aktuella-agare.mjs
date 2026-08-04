import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materialize } from '../../../packages/core/domain/materializer.js';
import { validateOperation } from '../../../packages/core/domain/operations.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'privat/migrering-2026-08-04-aktuella-agare');
const SOURCE_PATH = resolve(ROOT, 'privat/kallkopior/fastighetshistorik.json');
const dropboxRoot = process.argv[2] || '/Users/simon/Dropbox/Appar/Korpholmen';
const DEVICE = 'migration-fastigheter-current-owners-2026-08-04';
const MIGRATION_ID = '2026-08-04-fastigheter-current-owners';
const CLOCK_MS = 1785868200000;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const slug = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'post';

async function loadNamespace(namespace) {
  const root = resolve(dropboxRoot, namespace, 'ops');
  const files = (await readdir(root)).filter(name => name.endsWith('.json')).sort();
  const texts = await Promise.all(files.map(name => readFile(resolve(root, name), 'utf8')));
  const operations = texts.map(JSON.parse).flatMap(document => document.operations || document.ops || []);
  return materialize(operations);
}
const rows = (state, type) => state.listEntities(type).map(entity => ({ id: entity.entity_id, ...entity.fields }));

const sourceText = await readFile(SOURCE_PATH, 'utf8');
const source = JSON.parse(sourceText);
const [fastigheter, matrikel] = await Promise.all([loadNamespace('fastigheter'), loadNamespace('matrikel')]);
const propertyIds = new Set(rows(fastigheter, 'property').map(property => property.id));
const peopleIds = new Set(rows(matrikel, 'person').map(person => person.id));
const partiesByName = new Map(rows(fastigheter, 'party').map(party => [party.name, party]));
const partyIds = new Map(rows(fastigheter, 'party').map(party => [party.id, party.name]));

let seq = 0;
const operations = [];
function set(entityType, entityId, field, value) {
  seq += 1;
  const operation = { op_id: `${DEVICE}:${seq}`, device_id: DEVICE, seq, entity_type: entityType, entity_id: entityId, field, value, hlc: `${CLOCK_MS}-${String(seq).padStart(6, '0')}-${DEVICE}`, schema_version: 1 };
  validateOperation(operation); operations.push(operation);
}
function setFields(entityType, entityId, fields) { for (const [field, value] of Object.entries(fields)) set(entityType, entityId, field, value); }
function ensureParty(name) {
  const existing = partiesByName.get(name);
  const id = existing?.id || `party-${slug(name)}`;
  if (partyIds.has(id) && partyIds.get(id) !== name) throw new Error(`Part-id kolliderar: ${id}`);
  const personId = source.person_links[name] || null;
  if (personId && !peopleIds.has(personId)) throw new Error(`Matrikelpersonen saknas: ${personId}`);
  setFields('party', id, {
    name,
    party_type: existing?.party_type || (/förening/i.test(name) ? 'organisation' : 'person eller namngrupp'),
    ...(personId ? { person_id: personId, identity_status: 'kopplad till Matrikeln' } : { identity_status: existing?.identity_status || 'fristående part' }),
  });
  partiesByName.set(name, { id, name, person_id: personId, identity_status: personId ? 'kopplad till Matrikeln' : 'fristående part' });
  partyIds.set(id, name);
  return id;
}

for (const party of rows(fastigheter, 'party')) {
  const personId = source.person_links[party.name];
  if (!personId) continue;
  if (!peopleIds.has(personId)) throw new Error(`Matrikelpersonen saknas: ${personId}`);
  setFields('party', party.id, { person_id: personId, identity_status: 'kopplad till Matrikeln' });
}
for (const assessment of source.current_owner_assessments || []) {
  if (!propertyIds.has(assessment.property_id)) throw new Error(`Fastigheten saknas: ${assessment.property_id}`);
  const ownerPartyIds = assessment.owners.map(ensureParty);
  setFields('current-owner-assessment', `current-owner-${slug(assessment.property_id)}`, { ...assessment, owner_party_ids: ownerPartyIds });
}
setFields('root', 'fastigheter', {
  schema_version: source.schema_version,
  current_owner_migration_id: MIGRATION_ID,
  current_owner_source_sha256: sha256(sourceText),
  current_owner_principle: source.principles.current_owner,
});

const document = { operations_version: 1, dataset: source.dataset, device_id: DEVICE, migration_id: MIGRATION_ID, operations };
await mkdir(OUT, { recursive: true });
await writeFile(resolve(OUT, 'current-owner-ops.json'), `${JSON.stringify(document, null, 2)}\n`);
await writeFile(resolve(OUT, 'manifest.json'), `${JSON.stringify({ migration_id: MIGRATION_ID, source_sha256: sha256(sourceText), assessments: source.current_owner_assessments.length, operations: operations.length }, null, 2)}\n`);
console.log(JSON.stringify({ migration_id: MIGRATION_ID, assessments: source.current_owner_assessments.length, operations: operations.length }, null, 2));
