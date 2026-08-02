import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBatch, validateBatch } from '../../../packages/core/sync/batch.js';
import { createClock } from '../../../packages/core/domain/hlc.js';
import { materialize } from '../../../packages/core/domain/materializer.js';
import { createRestoreOperation, createSetOperation } from '../../../packages/core/domain/operations.js';
import { relationEntityId } from '../src/domain/slakt-schema.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLAN_PATH = resolve(ROOT, 'privat/familjemodell-2026-08-02.json');
const OUTPUT_PATH = resolve(process.argv[2] || resolve(ROOT, 'privat/familjemodell-2026-08-02-batch.json'));
const EXISTING_OPS_DIR = process.argv[3] ? resolve(process.argv[3]) : null;
const DEVICE_ID = 'migration-family-model-2026-08-02';
const FIXED_WALL_TIME = Date.UTC(2026, 7, 2, 12, 0, 0);

const plan = JSON.parse(await readFile(PLAN_PATH, 'utf8'));
if (plan.schema_version !== 1) throw new Error('Familjemodellen har fel schemaversion.');

const clock = createClock(DEVICE_ID, () => FIXED_WALL_TIME);
const operations = [];
let seq = 0;

function restore(entityType, entityId) {
  seq += 1;
  operations.push(createRestoreOperation({ deviceId: DEVICE_ID, seq, entityType, entityId, hlc: clock.tick() }));
}

function setField(entityType, entityId, field, value) {
  seq += 1;
  operations.push(createSetOperation({ deviceId: DEVICE_ID, seq, entityType, entityId, field, value, hlc: clock.tick() }));
}

for (const relation of plan.relations) {
  const entityId = relationEntityId(relation.kind, relation.from_person_id, relation.to_person_id);
  restore('relation', entityId);
  const fields = {
    kind: relation.kind,
    from_person_id: relation.from_person_id,
    to_person_id: relation.to_person_id,
    user_confirmed: Boolean(relation.confirmed),
    confidence: null,
    form: null,
    note: null,
    ...(relation.parent_role ? { parent_role: relation.parent_role } : {}),
  };
  for (const [field, value] of Object.entries(fields)) setField('relation', entityId, field, value);
}

for (const [entityType, records] of [['family-unit', plan.family_units], ['kin-group', plan.kin_groups]]) {
  for (const record of records) {
    restore(entityType, record.id);
    for (const [field, value] of Object.entries(record)) if (field !== 'id') setField(entityType, record.id, field, value);
  }
}

const batch = createBatch(operations);
validateBatch(batch);

if (EXISTING_OPS_DIR) {
  const existingBatches = [];
  for (const file of (await readdir(EXISTING_OPS_DIR)).filter(name => name.endsWith('.json')).sort()) {
    const candidate = JSON.parse(await readFile(resolve(EXISTING_OPS_DIR, file), 'utf8'));
    validateBatch(candidate);
    existingBatches.push(candidate);
  }
  const existingOps = existingBatches.flatMap(candidate => candidate.ops);
  const existingIds = new Set(existingOps.map(operation => operation.op_id));
  for (const operation of operations) if (existingIds.has(operation.op_id)) throw new Error(`Operations-id finns redan: ${operation.op_id}`);
  const before = materialize(existingOps);
  const people = new Set(before.listEntities('person').map(entity => entity.entity_id));
  for (const relation of plan.relations) {
    if (!people.has(relation.from_person_id) || !people.has(relation.to_person_id)) throw new Error(`Okänd person i relation: ${relation.from_person_id} / ${relation.to_person_id}`);
  }
  for (const group of [...plan.family_units, ...plan.kin_groups]) {
    for (const personId of [...(group.anchor_person_ids || []), ...(group.explicit_person_ids || [])]) if (!people.has(personId)) throw new Error(`Okänd person i ${group.reference_code}: ${personId}`);
  }
  const beforeCounts = {
    people: before.listEntities('person').length,
    relations: before.listEntities('relation').length,
    family_units: before.listEntities('family-unit').length,
    kin_groups: before.listEntities('kin-group').length,
  };
  const after = materialize([...existingOps, ...operations]);
  const afterCounts = {
    people: after.listEntities('person').length,
    relations: after.listEntities('relation').length,
    family_units: after.listEntities('family-unit').length,
    kin_groups: after.listEntities('kin-group').length,
  };
  if (afterCounts.people !== beforeCounts.people) throw new Error('Familjemodellen ändrade antalet personer.');
  if (afterCounts.relations !== beforeCounts.relations + plan.relations.length) throw new Error('Oväntat antal relationer efter familjemodellen.');
  if (afterCounts.family_units !== plan.family_units.length || afterCounts.kin_groups !== plan.kin_groups.length) throw new Error('Familje- eller släktgrupper saknas efter materialisering.');
  batch.verification = { existing_batches: existingBatches.length, before: beforeCounts, after: afterCounts };
}

await writeFile(OUTPUT_PATH, `${JSON.stringify(batch, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output: OUTPUT_PATH, operations: operations.length, verification: batch.verification || null }, null, 2));
