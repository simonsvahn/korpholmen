import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { canonicalStringify } from '../../../packages/core/domain/canonical.js';
import { compareHLC, createClock, parseHLC } from '../../../packages/core/domain/hlc.js';
import { materialize } from '../../../packages/core/domain/materializer.js';
import { createDeleteOperation, createRestoreOperation, createSetOperation } from '../../../packages/core/domain/operations.js';
import { batchPath, createBatch, validateBatch } from '../../../packages/core/sync/batch.js';

const args = process.argv.slice(2);
const write = args.includes('--write');
const positional = args.filter(value => value !== '--write');
const [planArgument, dropboxArgument, sourceArgument] = positional;
if (!planArgument || !dropboxArgument || !sourceArgument) {
  throw new Error('Användning: node genomfor-batmaster-pilot.mjs PLAN DROPBOX-ROT KÄLLROT [--write]');
}

const planPath = resolve(planArgument);
const planText = await readFile(planPath, 'utf8');
const plan = JSON.parse(planText);
if (plan.schema_version !== 1 || !plan.pilot_id || !Array.isArray(plan.records) || !Array.isArray(plan.changes)) {
  throw new Error('Pilotplanen har fel format.');
}
if (!/^[a-z0-9][a-z0-9-]{5,100}$/.test(plan.pilot_id)) throw new Error('Pilot-id är ogiltigt.');

const dropboxRoot = await realpath(resolve(dropboxArgument));
if (!dropboxRoot.endsWith('/Dropbox/Appar/Korpholmen')) {
  throw new Error(`Avbryter: målet är inte Dropbox/Appar/Korpholmen: ${dropboxRoot}`);
}
const sourceRoot = await realpath(resolve(sourceArgument));
const opsRoot = resolve(dropboxRoot, 'batregister/ops');
const auditRoot = resolve(dropboxRoot, 'batregister/piloter', plan.pilot_id);
const planHash = createHash('sha256').update(planText).digest('hex');
const same = (left, right) => left === undefined || right === undefined
  ? left === right
  : canonicalStringify(left) === canonicalStringify(right);

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

async function loadMaster(app) {
  const root = resolve(dropboxRoot, `${app}/ops`);
  const files = await jsonFiles(root);
  const batches = await Promise.all(files.map(async file => {
    const batch = JSON.parse(await readFile(file, 'utf8'));
    validateBatch(batch);
    return batch;
  }));
  const operations = batches.flatMap(batch => batch.ops);
  return { root, files, operations, state: materialize(operations) };
}

async function allSourceFiles() {
  const output = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) output.push(child);
    }
  }
  await visit(sourceRoot);
  return output;
}

async function resolveSource(source, candidates) {
  if (source.kind === 'linked-master') {
    return { ...source, sha256: null, relative_path: null };
  }
  if (source.kind === 'oral') {
    if (!source.speaker || !source.recorded_at || !source.statement) {
      throw new Error(`Den muntliga källan ${source.id} saknar talare, datum eller ordagrann uppgift.`);
    }
    return { ...source, sha256: null, relative_path: null };
  }
  const normalizedFilename = source.filename.normalize('NFC');
  const normalizedContains = source.path_contains?.normalize('NFC');
  const matches = candidates.filter(path => basename(path).normalize('NFC') === normalizedFilename
    && (!normalizedContains || relative(sourceRoot, path).normalize('NFC').includes(normalizedContains)));
  if (matches.length !== 1) {
    throw new Error(`Källan ${source.id} gav ${matches.length} träffar för filnamnet ${source.filename}.`);
  }
  const path = await realpath(matches[0]);
  if (!path.startsWith(`${sourceRoot}/`)) throw new Error(`Källan lämnar källroten: ${path}`);
  const bytes = await readFile(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (source.expected_sha256 && source.expected_sha256 !== sha256) throw new Error(`Källhashen har ändrats: ${source.id}`);
  return { ...source, sha256, relative_path: relative(sourceRoot, path) };
}

const batregister = await loadMaster('batregister');
const existingPilotOps = batregister.operations.filter(operation => operation.device_id === plan.pilot_id);
if (existingPilotOps.length) {
  const manifest = batregister.state.getEntity('boat-pilot-manifest', plan.pilot_id);
  if (!manifest || manifest.fields.record?.plan_sha256 !== planHash || manifest.fields.record?.operation_count !== existingPilotOps.length) {
    throw new Error('Pilot-id finns redan men matchar inte denna fullständiga plan. Ingenting skrivs.');
  }
  console.log(JSON.stringify({ pilot_id: plan.pilot_id, already_applied: true, operations: existingPilotOps.length, audit_root: auditRoot }, null, 2));
  process.exit(0);
}

const counts = Object.fromEntries(Object.entries(plan.expected_counts || {}).map(([type]) => [type, batregister.state.listEntities(type).length]));
for (const [type, expected] of Object.entries(plan.expected_counts || {})) {
  if (counts[type] !== expected) throw new Error(`Före piloten är ${type} ${counts[type]}, väntat ${expected}.`);
}

const linkedMasters = new Map();
for (const requirement of plan.linked_master_requirements || []) {
  if (!linkedMasters.has(requirement.master)) linkedMasters.set(requirement.master, await loadMaster(requirement.master));
  const entity = linkedMasters.get(requirement.master).state.getEntity(requirement.entity_type, requirement.entity_id);
  if (!entity) throw new Error(`Länkad master saknar ${requirement.entity_type}:${requirement.entity_id}.`);
  for (const [field, expected] of Object.entries(requirement.expect || {})) {
    if (!same(entity.fields[field], expected)) throw new Error(`Länkad master avviker för ${requirement.entity_type}:${requirement.entity_id}.${field}.`);
  }
}

const resolvedSources = [];
const candidates = plan.sources?.length ? await allSourceFiles() : [];
for (const source of plan.sources || []) resolvedSources.push(await resolveSource(source, candidates));
const sourceById = new Map(resolvedSources.map(source => [source.id, source]));
for (const source of batregister.state.listEntities('boat-source')) {
  const record = source.fields.record;
  if (record?.id) sourceById.set(record.id, record);
}
for (const record of plan.records) {
  for (const sourceId of record.record?.source_ids || []) if (!sourceById.has(sourceId)) {
    throw new Error(`Posten ${record.entity_id} refererar okänd källa ${sourceId}.`);
  }
}

const entries = [];
const touched = new Map();
const touch = (entityType, entityId) => {
  const key = `${entityType}\u0000${entityId}`;
  if (!touched.has(key)) {
    const current = batregister.state.getEntity(entityType, entityId, { includeDeleted: true });
    touched.set(key, {
      entity_type: entityType,
      entity_id: entityId,
      existed: Boolean(current),
      deleted: current?.deleted ?? null,
      fields: structuredClone(current?.fields || {}),
    });
  }
};

for (const source of resolvedSources) {
  const entityId = source.id;
  if (batregister.state.getEntity('boat-source', entityId, { includeDeleted: true })) throw new Error(`Källposten finns redan: ${entityId}`);
  touch('boat-source', entityId);
  entries.push({
    entityType: 'boat-source', entityId, restore: true, field: 'record', value: {
      id: source.id,
      label: source.label,
      kind: source.kind,
      source_date: source.source_date ?? null,
      relative_path: source.relative_path,
      master_path: source.master_path ?? null,
      entity_ids: source.entity_ids ?? [],
      speaker: source.speaker ?? null,
      recorded_at: source.recorded_at ?? null,
      statement: source.statement ?? null,
      sha256: source.sha256,
      authority_for: source.authority_for || [],
    },
  });
}

for (const record of plan.records) {
  if (!record.entity_type || !record.entity_id || !record.record) throw new Error('Varje observationspost måste vara komplett.');
  if (batregister.state.getEntity(record.entity_type, record.entity_id, { includeDeleted: true })) throw new Error(`Observationsposten finns redan: ${record.entity_type}:${record.entity_id}`);
  touch(record.entity_type, record.entity_id);
  entries.push({ entityType: record.entity_type, entityId: record.entity_id, restore: true, field: 'record', value: record.record });
}

for (const change of plan.changes) {
  const entityType = change.entity_type;
  const entityId = change.entity_id;
  const current = batregister.state.getEntity(entityType, entityId);
  const includingDeleted = batregister.state.getEntity(entityType, entityId, { includeDeleted: true });
  if (change.create) {
    if (includingDeleted) throw new Error(`Entiteten finns redan: ${entityType}:${entityId}`);
  } else if (!current) throw new Error(`Entiteten saknas: ${entityType}:${entityId}`);
  for (const [field, expected] of Object.entries(change.expect || {})) {
    if (!same(current?.fields[field], expected)) throw new Error(`Före-värdet avviker för ${entityType}:${entityId}.${field}.`);
  }
  touch(entityType, entityId);
  if (change.delete) {
    if (change.create || Object.keys(change.set || {}).length) throw new Error(`En borttagning får inte samtidigt skapa eller ändra ${entityType}:${entityId}.`);
    entries.push({ entityType, entityId, delete: true });
    continue;
  }
  for (const [field, value] of Object.entries(change.set || {})) {
    if (same(current?.fields[field], value)) continue;
    entries.push({ entityType, entityId, restore: Boolean(change.create), field, value });
  }
}

const manifestRecord = {
  pilot_id: plan.pilot_id,
  model_version: plan.model_version,
  label: plan.label ?? null,
  supersedes: plan.supersedes ?? null,
  plan_sha256: planHash,
  scope: plan.scope,
  boat_ids: plan.boat_ids,
  source_ids: resolvedSources.map(source => source.id),
  operation_count: entries.length + 2,
  rollback_policy: 'Återställning tillåts endast om pilotens berörda entiteter är oförändrade.',
};
touch('boat-pilot-manifest', plan.pilot_id);
entries.push({ entityType: 'boat-pilot-manifest', entityId: plan.pilot_id, restore: true, field: 'record', value: manifestRecord });

const latestHlc = batregister.operations.map(operation => operation.hlc)
  .reduce((latest, value) => !latest || compareHLC(value, latest) > 0 ? value : latest, null);
const wallTime = Math.max(Date.now(), latestHlc ? parseHLC(latestHlc).wallTime + 1 : 0);
const clock = createClock(plan.pilot_id, () => wallTime, latestHlc);
const operations = [];
let seq = 0;
const restored = new Set();
for (const entry of entries) {
  const key = `${entry.entityType}\u0000${entry.entityId}`;
  if (entry.delete) {
    operations.push(createDeleteOperation({ deviceId: plan.pilot_id, seq: ++seq, entityType: entry.entityType, entityId: entry.entityId, hlc: clock.tick() }));
    continue;
  }
  if (entry.restore && !restored.has(key)) {
    operations.push(createRestoreOperation({ deviceId: plan.pilot_id, seq: ++seq, entityType: entry.entityType, entityId: entry.entityId, hlc: clock.tick() }));
    restored.add(key);
  }
  operations.push(createSetOperation({ deviceId: plan.pilot_id, seq: ++seq, entityType: entry.entityType, entityId: entry.entityId, field: entry.field, value: entry.value, hlc: clock.tick() }));
}
manifestRecord.operation_count = operations.length;
const manifestOp = operations.find(operation => operation.entity_type === 'boat-pilot-manifest' && operation.field === 'record');
manifestOp.value.operation_count = operations.length;
if (operations.length > 250) throw new Error(`Piloten gav ${operations.length} operationer; högst 250 tillåts för atomisk batch.`);

const after = materialize([...batregister.operations, ...operations]);
for (const verify of plan.verify || []) {
  const entity = after.getEntity(verify.entity_type, verify.entity_id, { includeDeleted: true });
  if (!entity) throw new Error(`Verifieringen saknar ${verify.entity_type}:${verify.entity_id}.`);
  if (verify.deleted !== undefined && entity.deleted !== verify.deleted) throw new Error(`Verifieringen fick fel borttagningsstatus för ${verify.entity_type}:${verify.entity_id}.`);
  if (verify.deleted === true) continue;
  for (const [field, expected] of Object.entries(verify.fields || {})) {
    if (!same(entity.fields[field], expected)) throw new Error(`Verifieringen misslyckades för ${verify.entity_type}:${verify.entity_id}.${field}.`);
  }
}

const afterEntities = [...touched.values()].map(entry => {
  const entity = after.getEntity(entry.entity_type, entry.entity_id, { includeDeleted: true });
  return { entity_type: entry.entity_type, entity_id: entry.entity_id, deleted: entity?.deleted ?? null, fields: structuredClone(entity?.fields || {}) };
});
const audit = {
  audit_version: 1,
  pilot_id: plan.pilot_id,
  plan_sha256: planHash,
  source_hashes: Object.fromEntries(resolvedSources.filter(source => source.sha256).map(source => [source.id, source.sha256])),
  before_entities: [...touched.values()],
  after_entities: afterEntities,
  operation_sha256: createHash('sha256').update(canonicalStringify(operations)).digest('hex'),
  operations,
};
const batch = createBatch(operations);
validateBatch(batch);
const batchName = basename(batchPath(batch.device_id, batch.from_seq, batch.to_seq));

async function writeExact(path, content) {
  try { await writeFile(path, content, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readFile(path, 'utf8');
    if (existing !== content) throw new Error(`Befintlig fil skiljer sig och skrivs inte över: ${path}`);
  }
}

if (write) {
  await mkdir(auditRoot, { recursive: true });
  await mkdir(opsRoot, { recursive: true });
  await writeExact(resolve(auditRoot, 'plan.json'), planText);
  await writeExact(resolve(auditRoot, 'revision.json'), `${JSON.stringify(audit, null, 2)}\n`);
  await writeExact(resolve(opsRoot, batchName), `${JSON.stringify(batch, null, 2)}\n`);
}

console.log(JSON.stringify({
  pilot_id: plan.pilot_id,
  dry_run: !write,
  boats_in_scope: plan.boat_ids.length,
  sources: resolvedSources.length,
  records: plan.records.length,
  changed_entities: touched.size,
  operations: operations.length,
  batch: batchName,
  audit_root: auditRoot,
  source_hashes: audit.source_hashes,
}, null, 2));
