import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { canonicalStringify } from '../../../packages/core/domain/canonical.js';
import { createClock, parseHLC } from '../../../packages/core/domain/hlc.js';
import { materialize } from '../../../packages/core/domain/materializer.js';
import { createDeleteOperation, createRestoreOperation, createSetOperation } from '../../../packages/core/domain/operations.js';
import { batchPath, createBatch, validateBatch } from '../../../packages/core/sync/batch.js';

const [opsArgument, outputArgument, planArgument] = process.argv.slice(2);
if (!opsArgument || !outputArgument || !planArgument) {
  throw new Error('Användning: node skapa-korrigeringsbatch.mjs OPS-MAPP UTDATA-MAPP KORRIGERINGSPLAN');
}

const opsDirectory = resolve(opsArgument);
const outputDirectory = resolve(outputArgument);
const planPath = resolve(planArgument);
const plan = JSON.parse(await readFile(planPath, 'utf8'));
if (plan.schema_version !== 1 || !Array.isArray(plan.changes) || !plan.migration_id) {
  throw new Error('Korrigeringsplanen har fel format.');
}
if (!/^[a-z0-9][a-z0-9-]{5,80}$/.test(plan.migration_id)) {
  throw new Error('Migrerings-id får bara innehålla a-z, 0-9 och bindestreck.');
}

const inputFiles = (await readdir(opsDirectory)).filter(name => name.endsWith('.json')).sort();
const inputBatches = await Promise.all(inputFiles.map(async name => {
  const batch = JSON.parse(await readFile(resolve(opsDirectory, name), 'utf8'));
  validateBatch(batch);
  return batch;
}));
const existingOperations = inputBatches.flatMap(batch => batch.ops);
const before = materialize(existingOperations);
const same = (left, right) => left === undefined || right === undefined
  ? left === right
  : canonicalStringify(left) === canonicalStringify(right);
const counts = state => Object.fromEntries(Object.keys(plan.expected_after || plan.expected_before || {})
  .map(entityType => [entityType, state.listEntities(entityType).length]));
const assertCounts = (label, expected, actual) => {
  if (!expected) return;
  for (const [entityType, count] of Object.entries(expected)) {
    if (actual[entityType] !== count) throw new Error(`${label}: ${entityType} är ${actual[entityType]}, väntat ${count}.`);
  }
};
assertCounts('Före korrigering', plan.expected_before, counts(before));

const seenEntities = new Set();
const prepared = [];
for (const change of plan.changes) {
  const entityType = String(change.entity_type || '');
  const entityId = String(change.entity_id || '');
  if (!entityType || !entityId) throw new Error('Varje ändring måste ange entity_type och entity_id.');
  const key = `${entityType}\u0000${entityId}`;
  if (seenEntities.has(key)) throw new Error(`Entiteten förekommer flera gånger i planen: ${entityType}:${entityId}`);
  seenEntities.add(key);
  const existing = before.getEntity(entityType, entityId);
  const deleted = before.getEntity(entityType, entityId, { includeDeleted: true });
  if (change.create === true && change.delete === true) throw new Error(`Entiteten kan inte både skapas och raderas: ${entityType}:${entityId}`);
  if (change.create === true && existing) throw new Error(`Entiteten finns redan: ${entityType}:${entityId}`);
  if (change.create !== true && !existing) throw new Error(`Entiteten saknas: ${entityType}:${entityId}`);
  if (change.create === true && deleted?.deleted) throw new Error(`Entiteten är tombstonad och får inte återanvändas: ${entityType}:${entityId}`);
  if (change.delete === true && (change.set || change.array_updates)) throw new Error(`En radering får inte samtidigt ändra fält: ${entityType}:${entityId}`);
  const fields = structuredClone(existing?.fields || {});
  for (const [field, expected] of Object.entries(change.expect || {})) {
    if (!same(fields[field], expected)) {
      throw new Error(`Förväntningen stämmer inte för ${entityType}:${entityId}.${field}.`);
    }
  }
  for (const [field, value] of Object.entries(change.set || {})) fields[field] = structuredClone(value);
  for (const [field, update] of Object.entries(change.array_updates || {})) {
    if (!Array.isArray(fields[field] || [])) throw new Error(`${entityType}:${entityId}.${field} är inte en lista.`);
    const remove = new Set(update.remove || []);
    const values = (fields[field] || []).filter(value => !remove.has(value));
    for (const value of update.add || []) if (!values.some(existingValue => same(existingValue, value))) values.push(value);
    fields[field] = update.sort === false ? values : values.sort((left, right) => String(left).localeCompare(String(right), 'sv'));
  }
  prepared.push({ entityType, entityId, create: change.create === true, delete: change.delete === true, previous: existing?.fields || {}, fields });
}

const operations = [];
const migrationWallTime = Math.max(Date.now(), ...existingOperations.map(operation => parseHLC(operation.hlc).wallTime)) + 1;
const clock = createClock(plan.migration_id, () => migrationWallTime);
let sequence = 0;
const addRestore = ({ entityType, entityId }) => {
  sequence += 1;
  operations.push(createRestoreOperation({ deviceId: plan.migration_id, seq: sequence, entityType, entityId, hlc: clock.tick() }));
};
const addDelete = ({ entityType, entityId }) => {
  sequence += 1;
  operations.push(createDeleteOperation({ deviceId: plan.migration_id, seq: sequence, entityType, entityId, hlc: clock.tick() }));
};
const addSet = ({ entityType, entityId, field, value }) => {
  sequence += 1;
  operations.push(createSetOperation({ deviceId: plan.migration_id, seq: sequence, entityType, entityId, field, value, hlc: clock.tick() }));
};
for (const entry of prepared) {
  if (entry.delete) {
    addDelete(entry);
    continue;
  }
  if (entry.create) addRestore(entry);
  for (const [field, value] of Object.entries(entry.fields)) {
    if (!entry.create && same(entry.previous[field], value)) continue;
    addSet({ ...entry, field, value });
  }
}
if (!operations.length) throw new Error('Korrigeringsplanen ger inga nya operationer.');

const after = materialize([...existingOperations, ...operations]);
assertCounts('Efter korrigering', plan.expected_after, counts(after));
for (const check of plan.verify || []) {
  const entity = after.getEntity(check.entity_type, check.entity_id);
  if (!entity) throw new Error(`Verifieringen saknar ${check.entity_type}:${check.entity_id}.`);
  for (const [field, expected] of Object.entries(check.fields || {})) {
    if (!same(entity.fields[field], expected)) throw new Error(`Verifieringen misslyckades för ${check.entity_type}:${check.entity_id}.${field}.`);
  }
}
for (const check of plan.verify_deleted || []) {
  const entity = after.getEntity(check.entity_type, check.entity_id);
  const tombstone = after.getEntity(check.entity_type, check.entity_id, { includeDeleted: true });
  if (entity || !tombstone?.deleted) throw new Error(`Raderingsverifieringen misslyckades för ${check.entity_type}:${check.entity_id}.`);
}

await mkdir(outputDirectory, { recursive: true });
const outputFiles = [];
for (let offset = 0; offset < operations.length; offset += 250) {
  const batch = createBatch(operations.slice(offset, offset + 250));
  validateBatch(batch);
  const name = basename(batchPath(batch.device_id, batch.from_seq, batch.to_seq));
  await writeFile(resolve(outputDirectory, name), `${JSON.stringify(batch, null, 2)}\n`, { flag: 'wx' });
  outputFiles.push(name);
}

console.log(JSON.stringify({
  migration_id: plan.migration_id,
  input_batches: inputBatches.length,
  operations: operations.length,
  output_files: outputFiles,
  before: counts(before),
  after: counts(after),
}, null, 2));
