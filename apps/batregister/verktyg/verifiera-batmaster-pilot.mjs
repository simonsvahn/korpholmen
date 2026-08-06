import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { canonicalStringify } from '../../../packages/core/domain/canonical.js';
import { compareHLC } from '../../../packages/core/domain/hlc.js';
import { materialize } from '../../../packages/core/domain/materializer.js';
import { validateOperation } from '../../../packages/core/domain/operations.js';
import { validateBatch } from '../../../packages/core/sync/batch.js';

const [auditArgument, dropboxArgument, sourceArgument, originalPlanArgument] = process.argv.slice(2);
if (!auditArgument || !dropboxArgument || !sourceArgument) {
  throw new Error('Användning: node verifiera-batmaster-pilot.mjs REVISION DROPBOX-ROT KÄLLROT [ORIGINALPLAN]');
}

const auditPath = resolve(auditArgument);
const auditText = await readFile(auditPath, 'utf8');
const audit = JSON.parse(auditText);
const planPath = resolve(dirname(auditPath), 'plan.json');
const planText = await readFile(planPath, 'utf8');
const plan = JSON.parse(planText);
if (audit.audit_version !== 1 || audit.pilot_id !== plan.pilot_id || !Array.isArray(audit.operations)) {
  throw new Error('Revisionsfil och pilotplan hör inte ihop.');
}

const dropboxRoot = await realpath(resolve(dropboxArgument));
if (!dropboxRoot.endsWith('/Dropbox/Appar/Korpholmen')) {
  throw new Error(`Avbryter: målet är inte Dropbox/Appar/Korpholmen: ${dropboxRoot}`);
}
const sourceRoot = await realpath(resolve(sourceArgument));
const same = (left, right) => canonicalStringify(left) === canonicalStringify(right);
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function jsonFiles(root) {
  const output = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && entry.name.endsWith('.json')) output.push(child);
    }
  }
  await visit(root);
  return output.sort();
}

const batches = await Promise.all((await jsonFiles(resolve(dropboxRoot, 'batregister/ops'))).map(async path => {
  const batch = JSON.parse(await readFile(path, 'utf8'));
  validateBatch(batch);
  return batch;
}));
const operations = batches.flatMap(batch => batch.ops);
operations.forEach(validateOperation);
audit.operations.forEach(validateOperation);

const originalPlanText = originalPlanArgument ? await readFile(resolve(originalPlanArgument), 'utf8') : planText;
const originalPlan = JSON.parse(originalPlanText);
assert(same(plan, originalPlan), 'Revisionskopian av pilotplanen avviker innehållsmässigt från originalplanen.');
const planHash = createHash('sha256').update(originalPlanText).digest('hex');
assert(audit.plan_sha256 === planHash, 'Originalplanens kontrollsumma stämmer inte med revisionen.');
const auditOperationHash = createHash('sha256').update(canonicalStringify(audit.operations)).digest('hex');
assert(audit.operation_sha256 === auditOperationHash, 'Revisionens operationskontrollsumma stämmer inte.');

const pilotOperations = operations.filter(operation => operation.device_id === audit.pilot_id);
assert(pilotOperations.length === audit.operations.length, `Piloten har ${pilotOperations.length} operationer, väntat ${audit.operations.length}.`);
assert(same(pilotOperations, audit.operations), 'De publicerade pilotoperationerna avviker från revisionen.');

const state = materialize(operations);
const pilotCutoff = audit.operations.map(operation => operation.hlc)
  .reduce((latest, value) => !latest || compareHLC(value, latest) > 0 ? value : latest, null);
const snapshotState = materialize(operations.filter(operation => compareHLC(operation.hlc, pilotCutoff) <= 0));
for (const expected of audit.after_entities) {
  const current = state.getEntity(expected.entity_type, expected.entity_id, { includeDeleted: true });
  const normalized = { deleted: current?.deleted ?? null, fields: current?.fields || {} };
  assert(same(normalized, { deleted: expected.deleted, fields: expected.fields }),
    `Berörd entitet har ändrats efter piloten: ${expected.entity_type}:${expected.entity_id}.`);
}

for (const [sourceId, expectedHash] of Object.entries(audit.source_hashes || {})) {
  const entity = state.getEntity('boat-source', sourceId);
  const relativePath = entity?.fields.record?.relative_path;
  assert(relativePath, `Källposten ${sourceId} saknar relativ sökväg.`);
  const sourcePath = await realpath(resolve(sourceRoot, relativePath));
  assert(sourcePath.startsWith(`${sourceRoot}/`), `Källposten ${sourceId} lämnar källroten.`);
  const actualHash = createHash('sha256').update(await readFile(sourcePath)).digest('hex');
  assert(actualHash === expectedHash, `Originalkällan har ändrats: ${sourceId}.`);
}

const expectedCounts = structuredClone(plan.expected_counts || {});
const adjustsDeclaredCount = entityType => Object.hasOwn(expectedCounts, entityType);
const increment = entityType => {
  if (adjustsDeclaredCount(entityType)) expectedCounts[entityType] += 1;
};
for (const _source of plan.sources || []) increment('boat-source');
for (const record of plan.records || []) increment(record.entity_type);
for (const change of plan.changes || []) {
  if (change.create) increment(change.entity_type);
  if (change.delete && adjustsDeclaredCount(change.entity_type)) expectedCounts[change.entity_type] -= 1;
}
increment('boat-pilot-manifest');
for (const [entityType, expected] of Object.entries(expectedCounts)) {
  assert(snapshotState.listEntities(entityType).length === expected,
    `${entityType} var ${snapshotState.listEntities(entityType).length} vid pilotens slut, väntat ${expected}.`);
}

for (const verify of plan.verify || []) {
  const entity = snapshotState.getEntity(verify.entity_type, verify.entity_id, { includeDeleted: true });
  assert(entity, `Verifieringen saknar ${verify.entity_type}:${verify.entity_id}.`);
  if (verify.deleted !== undefined) assert(entity.deleted === verify.deleted,
    `Fel borttagningsstatus för ${verify.entity_type}:${verify.entity_id}.`);
  if (verify.deleted === true) continue;
  for (const [field, expected] of Object.entries(verify.fields || {})) {
    assert(same(entity.fields[field], expected),
      `Fel värde för ${verify.entity_type}:${verify.entity_id}.${field}.`);
  }
}

const sail = state.getEntity('boat', 'snusmumriken');
const kayak = state.getEntity('boat', 'snusmumriken-tävlingskajak');
assert(sail.entity_id !== kayak.entity_id, 'Snusmumriken är inte två separata objekt.');
assert(sail.fields.kategori === 'sailboat' && kayak.fields.kategori === 'kayak', 'Snusmumriken-objektens kategorier är fel.');
const romanNamesAuthorized = state.listEntities('boat-source')
  .some(source => source.fields.record?.statement?.includes('Snusmumriken I och II'));
if (romanNamesAuthorized) {
  assert(sail.fields.namn === 'Snusmumriken I' && kayak.fields.namn === 'Snusmumriken II', 'Det officiella I/II-beslutet för Snusmumriken är fel infört.');
} else {
  assert(sail.fields.namn === kayak.fields.namn, 'De två Snusmumriken-objekten har fått olika namn utan stöd i pilotplanen.');
  assert(!/\bI{1,3}\b/.test(sail.fields.namn) && !/\bI{1,3}\b/.test(kayak.fields.namn), 'Systemet har lagt till obelagda romerska nummer.');
}

const unnamedKayak = state.getEntity('boat', 'lottas-kajak-2026');
assert(unnamedKayak.fields.namn === null && unnamedKayak.fields.visningsnamn.includes('namn okänt'), 'Lottas nya kajak har fått ett påhittat namn.');
const homsanReview = state.getEntity('boat-review-item', 'review:homsan:previous-boving');
const homsanIdentitySource = state.getEntity('boat-source', 'source:simon-2026-08-06-homsan');
if (homsanIdentitySource) {
  const oldMosterGitte = state.getEntity('boat', 'mostergitte', { includeDeleted: true });
  const homsanNames = state.listEntities('boat-name-observation').map(entity => entity.fields.record)
    .filter(record => record?.boat_id === 'homsan');
  const homsanOwners = state.listEntities('boat-ownership-observation').map(entity => entity.fields.record)
    .filter(record => record?.boat_id === 'homsan');
  assert(oldMosterGitte?.deleted === true, 'Moster Gitte ligger kvar som en andra båt efter identitetsbeslutet.');
  assert(homsanNames.some(record => record.value === 'Moster Gitte' && record.end?.year === 2013)
    && homsanNames.some(record => record.value === 'Homsan' && record.start?.year === 2013),
  'Homsans namnbyte 2013 är inte strukturerat.');
  assert(homsanOwners.some(record => record.sequence === 1 && record.end?.year === 2013)
    && homsanOwners.some(record => record.sequence === 2 && record.start?.year === 2013),
  'Homsans ägarbyte 2013 är inte strukturerat.');
} else {
  assert(homsanReview?.fields.record.status === 'open' && homsanReview.fields.record.known.includes('Böving-båt'), 'Homsans tidigare Böving-koppling är varken avgjord eller kvar som öppen fråga.');
}

console.log(JSON.stringify({
  pilot_id: audit.pilot_id,
  verified: true,
  batches: batches.length,
  operations: operations.length,
  pilot_operations: pilotOperations.length,
  snapshot_counts: expectedCounts,
  current_counts: Object.fromEntries(Object.keys(expectedCounts).map(entityType => [entityType, state.listEntities(entityType).length])),
  source_hashes_verified: Object.keys(audit.source_hashes || {}).length,
  rollback_guard_entities: audit.after_entities.length,
}, null, 2));
