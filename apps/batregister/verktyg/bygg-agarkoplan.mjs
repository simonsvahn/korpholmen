import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { canonicalStringify } from '../../../packages/core/domain/canonical.js';
import { materialize } from '../../../packages/core/domain/materializer.js';
import { validateBatch } from '../../../packages/core/sync/batch.js';
import { sourceSupportsOwnership, validateOwnerChangeQueue } from '../src/owner-review-decisions.js';

const [queueArgument, boatOpsArgument, matrikelOpsArgument, outputArgument] = process.argv.slice(2);
if (!queueArgument || !boatOpsArgument || !matrikelOpsArgument || !outputArgument) {
  throw new Error('Användning: node bygg-agarkoplan.mjs ÄNDRINGSKÖ BATREGISTER-OPS MATRIKEL-OPS UTDATA-PLAN');
}

const queuePath = resolve(queueArgument);
const boatOpsRoot = resolve(boatOpsArgument);
const matrikelOpsRoot = resolve(matrikelOpsArgument);
const outputPath = resolve(outputArgument);
const queueText = await readFile(queuePath, 'utf8');
const queue = JSON.parse(queueText);
validateOwnerChangeQueue(queue);
if (!queue.decisions.length) throw new Error('Ändringskön innehåller inga beslut.');

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

async function loadMaster(root) {
  const batches = await Promise.all((await jsonFiles(root)).map(async path => {
    const batch = JSON.parse(await readFile(path, 'utf8'));
    validateBatch(batch);
    return batch;
  }));
  return materialize(batches.flatMap(batch => batch.ops));
}

const boatState = await loadMaster(boatOpsRoot);
const matrikelState = await loadMaster(matrikelOpsRoot);
const sourcePilot = boatState.getEntity('boat-pilot-manifest', queue.pilot_id)?.fields.record;
if (!sourcePilot) throw new Error(`Pilotmanifestet saknas i Båtregistermastern: ${queue.pilot_id}`);
const ownership = boatState.listEntities('boat-ownership-observation').map(entity => ({ id: entity.entity_id, ...entity.fields.record }));
const sources = new Map(boatState.listEntities('boat-source').map(entity => [entity.entity_id, entity.fields.record]));
const queueSources = new Map(queue.sources.map(source => [source.id, source]));
const newSources = new Map();
const requirementMap = new Map();
const records = [];
const changes = [];
const same = (left, right) => canonicalStringify(left) === canonicalStringify(right);

function addRequirement(entityType, entityId) {
  const entity = matrikelState.getEntity(entityType, entityId);
  if (!entity) throw new Error(`Matrikelmastern saknar ${entityType}:${entityId}`);
  const expect = entityType === 'person' ? { display_name: entity.fields.display_name } : { name: entity.fields.name };
  requirementMap.set(`${entityType}:${entityId}`, { master: 'matrikel', entity_type: entityType, entity_id: entityId, expect });
}

for (const decision of queue.decisions) {
  const boat = boatState.getEntity('boat', decision.boat_id);
  if (!boat) throw new Error(`Båtregistermastern saknar båten ${decision.boat_id}`);
  const currentOwnerships = ownership.filter(record => record.boat_id === decision.boat_id);
  if (decision.mode === 'insert') {
    if (currentOwnerships.length) throw new Error(`${decision.boat_name} har redan strukturerat ägande i skarp master.`);
    if (boat.fields.agare !== decision.source_owner_text) throw new Error(`Den äldre ägartexten har ändrats i skarp master för ${decision.boat_name}.`);
  } else {
    const expected = [...decision.expected_ownerships].sort((left, right) => left.entity_id.localeCompare(right.entity_id));
    const current = currentOwnerships.map(({ id, ...record }) => ({ entity_id: id, record })).sort((left, right) => left.entity_id.localeCompare(right.entity_id));
    if (!expected.length || !same(expected, current)) throw new Error(`Den strukturerade ägarföljden har ändrats i skarp master för ${decision.boat_name}.`);
    for (const item of expected) changes.push({
      entity_type: 'boat-ownership-observation',
      entity_id: item.entity_id,
      expect: { record: item.record },
      delete: true,
    });
  }
  for (const [index, proposal] of [...decision.ownerships].sort((left, right) => left.sequence - right.sequence).entries()) {
    if (proposal.role !== 'owner') throw new Error(`Endast den strukturerade rollen owner får införas: ${decision.boat_name}`);
    let hasOwnershipSource = false;
    for (const sourceId of proposal.source_ids) {
      const masterSource = sources.get(sourceId);
      const queueSource = queueSources.get(sourceId);
      const source = masterSource || queueSource;
      if (!source) throw new Error(`Källan saknas i Båtregistermastern: ${sourceId}`);
      if (!(source.entity_ids || []).includes(decision.boat_id)) throw new Error(`Källan ${sourceId} är inte strukturerat kopplad till ${decision.boat_name}`);
      if (sourceSupportsOwnership(source)) hasOwnershipSource = true;
      if (!masterSource) {
        if (!source.relative_path || !source.sha256) throw new Error(`Den nya källan ${sourceId} saknar fil eller kontrollsumma.`);
        newSources.set(sourceId, source);
      }
    }
    if (!hasOwnershipSource) throw new Error(`${decision.boat_name} saknar en källa som uttryckligen belägger ägande.`);
    if (proposal.party_type === 'person') addRequirement('person', proposal.party_id);
    else if (proposal.party_type === 'person-set') proposal.party_ids.forEach(personId => addRequirement('person', personId));
    else if (proposal.party_type === 'family-unit') addRequirement('family-unit', proposal.party_id);
    else if (proposal.party_type === 'kin-group') addRequirement('kin-group', proposal.party_id);
    const { proposal_id: proposalId, ...owner } = proposal;
    const suffix = createHash('sha256').update(proposalId).digest('hex').slice(0, 10);
    const entityId = `owner:${decision.boat_id}:review:${index + 1}:${suffix}`;
    if (boatState.getEntity('boat-ownership-observation', entityId, { includeDeleted: true })) throw new Error(`Ägarposten finns redan: ${entityId}`);
    records.push({
      entity_type: 'boat-ownership-observation',
      entity_id: entityId,
      record: { boat_id: decision.boat_id, ...owner, legacy_owner_text: decision.source_owner_text },
    });
  }
}

const countedTypes = [
  'boat', 'boat-source', 'boat-name-observation', 'boat-ownership-observation',
  'boat-spec-observation', 'boat-event-observation', 'boat-review-item', 'boat-pilot-manifest',
];
const contentHash = createHash('sha256').update(canonicalStringify({ decisions: queue.decisions, sources: [...newSources.values()] })).digest('hex');
const plan = {
  schema_version: 1,
  pilot_id: `batmaster-agarkorrigering-${contentHash.slice(0, 12)}`,
  model_version: 'boat-master-owner-review-v1',
  label: `Båtmaster · ${queue.decisions.length} granskade ägarbeslut`,
  supersedes: queue.pilot_id,
  scope: 'Alla kända båtar: källkontrollerade ägarbeslut från ägargranskningen',
  boat_ids: sourcePilot.boat_ids,
  expected_counts: Object.fromEntries(countedTypes.map(type => [type, boatState.listEntities(type).length])),
  linked_master_requirements: [...requirementMap.values()],
  sources: [...newSources.values()].map(source => ({
    id: source.id,
    label: source.label,
    kind: source.kind,
    filename: basename(source.relative_path),
    path_contains: dirname(source.relative_path),
    expected_sha256: source.sha256,
    source_date: source.source_date ?? null,
    entity_ids: source.entity_ids || [],
    speaker: source.speaker ?? null,
    recorded_at: source.recorded_at ?? null,
    statement: source.statement ?? null,
    authority_for: source.authority_for || [],
  })),
  records,
  changes,
  verify: [
    ...changes.filter(change => change.delete).map(change => ({ entity_type: change.entity_type, entity_id: change.entity_id, deleted: true })),
    ...records.map(record => ({ entity_type: record.entity_type, entity_id: record.entity_id, fields: { record: record.record } })),
  ],
  review_queue: {
    source_pilot_id: queue.pilot_id,
    queue_sha256: createHash('sha256').update(queueText).digest('hex'),
    decision_ids: queue.decisions.map(decision => decision.decision_id),
  },
};

const planText = `${JSON.stringify(plan, null, 2)}\n`;
await mkdir(dirname(outputPath), { recursive: true });
try {
  await writeFile(outputPath, planText, { flag: 'wx' });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  if (await readFile(outputPath, 'utf8') !== planText) throw new Error(`En annan plan finns redan och skrivs inte över: ${outputPath}`);
}

console.log(JSON.stringify({
  plan: outputPath,
  pilot_id: plan.pilot_id,
  decisions: queue.decisions.length,
  ownership_records: records.length,
  linked_master_requirements: plan.linked_master_requirements.length,
  next_dry_run: `node apps/batregister/verktyg/genomfor-batmaster-pilot.mjs ${outputPath} /Users/simon/Dropbox/Appar/Korpholmen \"KÄLLROT\"`,
}, null, 2));
