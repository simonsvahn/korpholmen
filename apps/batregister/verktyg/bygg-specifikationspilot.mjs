import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materialize } from '../../../packages/core/domain/materializer.js';
import { validateBatch } from '../../../packages/core/sync/batch.js';

const [auditArgument, boatOpsArgument] = process.argv.slice(2);
if (!auditArgument || !boatOpsArgument) {
  throw new Error('Användning: node bygg-specifikationspilot.mjs AUDIT-JSON BATREGISTER-OPS');
}

const auditPath = resolve(auditArgument);
const boatOpsRoot = resolve(boatOpsArgument);
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const audit = JSON.parse(await readFile(auditPath, 'utf8'));

if (audit.schema_version !== 1 || !audit.pilot_id || !Array.isArray(audit.observations)) {
  throw new Error('Specifikationsauditen har fel format.');
}
if (!/^[a-z0-9][a-z0-9-]{5,100}$/.test(audit.pilot_id)) throw new Error('Pilot-id är ogiltigt.');

async function jsonFiles(root) {
  const output = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && entry.name.endsWith('.json')) output.push(child);
    }
  }
  await visit(root);
  return output.sort();
}

const batches = await Promise.all((await jsonFiles(boatOpsRoot)).map(async path => {
  const batch = JSON.parse(await readFile(path, 'utf8'));
  validateBatch(batch);
  return batch;
}));
const state = materialize(batches.flatMap(batch => batch.ops));
const boats = state.listEntities('boat');
const boatIds = new Set(boats.map(boat => boat.entity_id));
const existingSources = new Map(state.listEntities('boat-source')
  .map(source => [source.entity_id, source.fields.record]));

const countedTypes = [
  'boat', 'boat-source', 'boat-name-observation', 'boat-ownership-observation',
  'boat-spec-observation', 'boat-event-observation', 'boat-review-item', 'boat-pilot-manifest',
];
const initialCounts = Object.fromEntries(countedTypes.map(type => [type, state.listEntities(type).length]));
const seenEntityKeys = new Set();
const auditChanges = audit.changes || [];

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} måste vara ett objekt.`);
}

const groupsBySource = new Map();
for (const observation of audit.observations) {
  requireObject(observation, 'Varje auditpost');
  if (!boatIds.has(observation.boat_id)) throw new Error(`Okänd båt i auditen: ${observation.boat_id}`);
  requireObject(observation.source, `Källan för ${observation.boat_id}`);
  const source = { ...(audit.source_defaults || {}), ...observation.source };
  if (!source.id) throw new Error(`Källan saknar id för ${observation.boat_id}`);
  const existingSource = existingSources.get(source.id);
  if (source.existing) {
    if (!existingSource) throw new Error(`Befintlig källa saknas: ${source.id}`);
  } else if (existingSource) {
    throw new Error(`Källan finns redan men är inte markerad existing: ${source.id}`);
  } else if (!source.filename || !source.path_contains) {
    throw new Error(`Ny källa saknar filnamn eller sökväg: ${source.id}`);
  }

  const records = [];
  if (observation.values) {
    requireObject(observation.values, `values för ${observation.boat_id}`);
    if (!Object.keys(observation.values).length) throw new Error(`Tom specifikationspost: ${observation.boat_id}`);
    const entityId = observation.spec_id || `spec:${observation.boat_id}:${source.id.replace(/^source:/, '').replaceAll(':', '-')}`;
    const entityKey = `boat-spec-observation\0${entityId}`;
    if (seenEntityKeys.has(entityKey) || state.getEntity('boat-spec-observation', entityId, { includeDeleted: true })) {
      throw new Error(`Specifikationsposten finns redan eller är duplicerad: ${entityId}`);
    }
    seenEntityKeys.add(entityKey);
    records.push({
      entity_type: 'boat-spec-observation',
      entity_id: entityId,
      record: {
        boat_id: observation.boat_id,
        values: observation.values,
        source_values: observation.source_values || null,
        qualifiers: observation.qualifiers || null,
        source_ids: [source.id],
      },
    });
  }

  for (const event of observation.events || []) {
    requireObject(event, `Händelse för ${observation.boat_id}`);
    if (!event.id || !event.event_type || !event.label) throw new Error(`Ofullständig händelse för ${observation.boat_id}`);
    const entityKey = `boat-event-observation\0${event.id}`;
    if (seenEntityKeys.has(entityKey) || state.getEntity('boat-event-observation', event.id, { includeDeleted: true })) {
      throw new Error(`Händelseposten finns redan eller är duplicerad: ${event.id}`);
    }
    seenEntityKeys.add(entityKey);
    records.push({
      entity_type: 'boat-event-observation',
      entity_id: event.id,
      record: {
        boat_id: observation.boat_id,
        event_type: event.event_type,
        label: event.label,
        date: event.date || null,
        source_value: event.source_value || null,
        source_ids: [source.id],
      },
    });
  }
  if (!records.length) throw new Error(`Auditposten saknar fakta: ${observation.boat_id}`);
  const group = groupsBySource.get(source.id);
  if (group) {
    if (JSON.stringify(group.source) !== JSON.stringify(source)) throw new Error(`Källan har motstridiga definitioner: ${source.id}`);
    group.records.push(...records);
  } else {
    groupsBySource.set(source.id, { source, records });
  }
}

const groups = [...groupsBySource.values()].map(group => ({
  ...group,
  cost: group.records.length * 2 + (group.source.existing ? 0 : 2),
}));

const chunks = [];
for (const group of groups) {
  if (group.cost + 2 > 250) throw new Error(`En källgrupp är för stor: ${group.source.id}`);
  let chunk = chunks.at(-1);
  if (!chunk || chunk.cost + group.cost + 2 > 250) {
    chunk = { groups: [], cost: 0 };
    chunks.push(chunk);
  }
  chunk.groups.push(group);
  chunk.cost += group.cost;
}

let changeCost = 0;
for (const change of auditChanges) {
  requireObject(change, 'Varje masterrättning');
  if (!change.entity_type || !change.entity_id || !change.expect || !change.set) throw new Error('Masterrättningen är ofullständig.');
  if (!state.getEntity(change.entity_type, change.entity_id)) throw new Error(`Entiteten för rättning saknas: ${change.entity_type}:${change.entity_id}`);
  changeCost += Object.keys(change.set).length;
}
if (changeCost) {
  if (changeCost + 2 > 250) throw new Error('Masterrättningarna ryms inte i en atomisk batch.');
  const first = chunks[0];
  if (first && first.cost + changeCost + 2 <= 250) first.cost += changeCost;
  else chunks.unshift({ groups: [], cost: changeCost });
  chunks[0].changes = auditChanges;
}

const outputRoot = resolve(appRoot, 'privat/piloter', audit.pilot_id);
await mkdir(outputRoot, { recursive: true });
let supersedes = audit.supersedes || null;
const runningCounts = { ...initialCounts };
const outputs = [];

for (let index = 0; index < chunks.length; index += 1) {
  const chunk = chunks[index];
  const part = chunks.length === 1 ? '' : `-del-${String(index + 1).padStart(2, '0')}`;
  const pilotId = `${audit.pilot_id}${part}`;
  const sources = chunk.groups.filter(group => !group.source.existing).map(group => ({
    id: group.source.id,
    label: group.source.label,
    kind: group.source.kind || 'register-leaf',
    filename: group.source.filename,
    path_contains: group.source.path_contains,
    source_date: group.source.source_date ?? null,
    entity_ids: group.source.entity_ids || [],
    authority_for: group.source.authority_for || ['vessel specifications as written on register leaf'],
  }));
  const duplicateSourceIds = sources.map(source => source.id).filter((id, sourceIndex, ids) => ids.indexOf(id) !== sourceIndex);
  if (duplicateSourceIds.length) throw new Error(`Ny källa förekommer flera gånger: ${duplicateSourceIds[0]}`);
  const records = chunk.groups.flatMap(group => group.records);
  const plan = {
    schema_version: 1,
    pilot_id: pilotId,
    model_version: audit.model_version || 'boat-master-register-spec-import-v1',
    label: chunks.length === 1 ? audit.label : `${audit.label} · del ${index + 1} av ${chunks.length}`,
    supersedes,
    scope: audit.scope,
    boat_ids: boats.map(boat => boat.entity_id),
    expected_counts: { ...runningCounts },
    linked_master_requirements: [],
    sources,
    records,
    changes: chunk.changes || [],
    verify: [
      ...records.map(record => ({
        entity_type: record.entity_type,
        entity_id: record.entity_id,
        fields: { record: record.record },
      })),
      ...(chunk.changes || []).map(change => ({
        entity_type: change.entity_type,
        entity_id: change.entity_id,
        fields: change.set,
      })),
    ],
  };
  const planPath = resolve(outputRoot, `plan${part || '-01'}.json`);
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  outputs.push({ pilot_id: pilotId, plan: planPath, sources: sources.length, records: records.length, operations: chunk.cost + 2 });
  runningCounts['boat-source'] += sources.length;
  for (const record of records) runningCounts[record.entity_type] += 1;
  runningCounts['boat-pilot-manifest'] += 1;
  supersedes = pilotId;
}

console.log(JSON.stringify({ audit: auditPath, observations: audit.observations.length, parts: outputs }, null, 2));
