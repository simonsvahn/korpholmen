import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { canonicalStringify } from '../../../packages/core/domain/canonical.js';
import { compareHLC, createClock, parseHLC } from '../../../packages/core/domain/hlc.js';
import { materialize } from '../../../packages/core/domain/materializer.js';
import { createDeleteOperation, createResetOperation, createRestoreOperation, createSetOperation, validateOperation } from '../../../packages/core/domain/operations.js';
import { batchPath, createBatch, validateBatch } from '../../../packages/core/sync/batch.js';

const args = process.argv.slice(2);
const write = args.includes('--write');
const appOption = args.find(value => value.startsWith('--app='));
const app = appOption?.slice('--app='.length) || 'batregister';
if (!['batregister', 'korpholmenrunt'].includes(app)) throw new Error(`Otillåten master för återställning: ${app}`);
const positional = args.filter(value => value !== '--write' && value !== appOption);
const [auditArgument, dropboxArgument] = positional;
if (!auditArgument || !dropboxArgument) throw new Error('Användning: node aterstall-batmaster-pilot.mjs REVISION DROPBOX-ROT [--app=batregister|korpholmenrunt] [--write]');
const auditPath = resolve(auditArgument);
const audit = JSON.parse(await readFile(auditPath, 'utf8'));
const auditId = audit.pilot_id || audit.correction_id;
if (audit.audit_version !== 1 || !auditId || !Array.isArray(audit.before_entities) || !Array.isArray(audit.after_entities)) {
  throw new Error('Revisionsfilen har fel format.');
}
const dropboxRoot = await realpath(resolve(dropboxArgument));
if (!dropboxRoot.endsWith('/Dropbox/Appar/Korpholmen')) throw new Error('Avbryter: målet är inte Dropbox/Appar/Korpholmen.');
const opsRoot = resolve(dropboxRoot, `${app}/ops`);
const rollbackId = `rollback-${auditId}`;
const rollbackPlanPath = resolve(dirname(auditPath), 'aterstallningsplan.json');
const rollbackReceiptPath = resolve(dirname(auditPath), 'aterstallning.json');
const same = (left, right) => canonicalStringify(left) === canonicalStringify(right);

async function readOptionalJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writeExact(path, content) {
  try { await writeFile(path, content, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await readFile(path, 'utf8') !== content) throw new Error(`Befintlig fil skiljer sig och skrivs inte över: ${path}`);
  }
}

async function files(root) {
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
const batches = await Promise.all((await files(opsRoot)).map(async file => {
  const batch = JSON.parse(await readFile(file, 'utf8'));
  validateBatch(batch);
  return batch;
}));
const existingOps = batches.flatMap(batch => batch.ops);
const existingRollback = existingOps.filter(operation => operation.device_id === rollbackId);
const savedPlan = await readOptionalJson(rollbackPlanPath);
if (existingRollback.length && !savedPlan) throw new Error('En ofullständig återställning finns utan revisionsplan. Ingenting skrivs.');
if (savedPlan && (savedPlan.rollback_plan_version !== 1 || savedPlan.rollback_id !== rollbackId || !Array.isArray(savedPlan.operations))) {
  throw new Error('Återställningsplanen har fel format.');
}
if (savedPlan) savedPlan.operations.forEach(validateOperation);
if (savedPlan && savedPlan.operation_sha256 !== createHash('sha256').update(canonicalStringify(savedPlan.operations)).digest('hex')) {
  throw new Error('Återställningsplanens kontrollsumma stämmer inte.');
}
if (savedPlan) {
  const plannedById = new Map(savedPlan.operations.map(operation => [operation.op_id, operation]));
  for (const operation of existingRollback) {
    if (!plannedById.has(operation.op_id) || !same(plannedById.get(operation.op_id), operation)) {
      throw new Error(`Befintlig återställningsoperation avviker: ${operation.op_id}`);
    }
  }
}
const state = materialize(existingOps);
if (!savedPlan) {
  for (const expected of audit.after_entities) {
    const current = state.getEntity(expected.entity_type, expected.entity_id, { includeDeleted: true });
    const normalized = { deleted: current?.deleted ?? null, fields: current?.fields || {} };
    if (!same(normalized, { deleted: expected.deleted, fields: expected.fields })) {
      throw new Error(`Piloten kan inte återställas automatiskt: ${expected.entity_type}:${expected.entity_id} har ändrats efter piloten.`);
    }
  }
}

let operations = savedPlan?.operations || null;
if (!operations) {
  const latestHlc = existingOps.map(operation => operation.hlc).reduce((latest, value) => !latest || compareHLC(value, latest) > 0 ? value : latest, null);
  const wallTime = Math.max(Date.now(), latestHlc ? parseHLC(latestHlc).wallTime + 1 : 0);
  const clock = createClock(rollbackId, () => wallTime, latestHlc);
  let seq = 0;
  operations = [];
  for (const previous of audit.before_entities) {
    operations.push(createResetOperation({ deviceId: rollbackId, seq: ++seq, entityType: previous.entity_type, entityId: previous.entity_id, hlc: clock.tick() }));
    for (const [field, value] of Object.entries(previous.fields || {})) {
      operations.push(createSetOperation({ deviceId: rollbackId, seq: ++seq, entityType: previous.entity_type, entityId: previous.entity_id, field, value, hlc: clock.tick() }));
    }
    const tombstoneFactory = !previous.existed || previous.deleted === true
      ? createDeleteOperation
      : previous.deleted === false ? createRestoreOperation : null;
    if (tombstoneFactory) operations.push(tombstoneFactory({ deviceId: rollbackId, seq: ++seq, entityType: previous.entity_type, entityId: previous.entity_id, hlc: clock.tick() }));
  }
}
const after = materialize([...existingOps, ...operations]);
for (const previous of audit.before_entities) {
  const current = after.getEntity(previous.entity_type, previous.entity_id, { includeDeleted: true });
  const normalized = { deleted: current?.deleted ?? null, fields: current?.fields || {} };
  const expected = { deleted: previous.existed ? previous.deleted : true, fields: previous.fields || {} };
  if (!same(normalized, expected)) throw new Error(`Återställningen kunde inte verifiera ${previous.entity_type}:${previous.entity_id}.`);
}
const rollbackBatches = [];
for (let index = 0; index < operations.length; index += 250) {
  const batch = createBatch(operations.slice(index, index + 250));
  validateBatch(batch);
  rollbackBatches.push({ batch, name: basename(batchPath(batch.device_id, batch.from_seq, batch.to_seq)) });
}
const planRecord = savedPlan || {
  rollback_plan_version: 1,
  rollback_id: rollbackId,
  pilot_id: auditId,
  operation_sha256: createHash('sha256').update(canonicalStringify(operations)).digest('hex'),
  batch_names: rollbackBatches.map(entry => entry.name),
  operations,
};
if (write) {
  await mkdir(opsRoot, { recursive: true });
  await writeExact(rollbackPlanPath, `${JSON.stringify(planRecord, null, 2)}\n`);
  for (const entry of rollbackBatches) await writeExact(resolve(opsRoot, entry.name), `${JSON.stringify(entry.batch, null, 2)}\n`);
  const receipt = {
    rollback_id: rollbackId,
    pilot_id: auditId,
    operation_sha256: planRecord.operation_sha256,
    operations: operations.length,
    batches: rollbackBatches.map(entry => entry.name),
  };
  await writeExact(rollbackReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
}
console.log(JSON.stringify({ rollback_id: rollbackId, dry_run: !write, resumed: Boolean(savedPlan), operations: operations.length, batches: rollbackBatches.map(entry => entry.name) }, null, 2));
