import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materialize } from '../../../packages/core/domain/materializer.js';
import { validateBatch } from '../../../packages/core/sync/batch.js';

const [boatOpsArgument] = process.argv.slice(2);
if (!boatOpsArgument) throw new Error('Användning: node bygg-borelia-kallrattelse.mjs BATREGISTER-OPS');

const boatOpsRoot = resolve(boatOpsArgument);
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pilotId = 'batmaster-pilot-registerspec-20260806-a-del-06';

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
const sourceSpecId = 'spec:borelia:boats2-register-borelia';
const correctionSpecId = 'spec:borelia:simon-2026-08-06';
const correctionSourceId = 'source:oral-simon-borelia-2026-08-06';
const sourceSpec = state.getEntity('boat-spec-observation', sourceSpecId)?.fields.record;
const correctionSpec = state.getEntity('boat-spec-observation', correctionSpecId)?.fields.record;
const correctionSource = state.getEntity('boat-source', correctionSourceId)?.fields.record;
if (!sourceSpec || sourceSpec.values?.horsepower !== 70 || sourceSpec.source_values?.motor !== 'JOHNSON 70 HKR') {
  throw new Error('Borelias fellästa källobservation har ett oväntat före-värde.');
}
if (!correctionSpec || correctionSpec.values?.horsepower !== 90 || !correctionSource) {
  throw new Error('Det tillfälliga korrigeringslagret för Borelia saknas eller avviker.');
}

const correctedSourceSpec = {
  ...structuredClone(sourceSpec),
  values: { ...sourceSpec.values, horsepower: 90 },
  source_values: { ...sourceSpec.source_values, motor: 'JOHNSON 90 HKR' },
};
const countedTypes = [
  'boat', 'boat-source', 'boat-name-observation', 'boat-ownership-observation',
  'boat-spec-observation', 'boat-event-observation', 'boat-review-item', 'boat-pilot-manifest',
];
const expectedCounts = Object.fromEntries(countedTypes.map(type => [type, state.listEntities(type).length]));
const plan = {
  schema_version: 1,
  pilot_id: pilotId,
  model_version: 'boat-master-source-correction-v1',
  label: 'Båtmaster · Borelias felläsning rättad i källobservationen',
  supersedes: 'batmaster-pilot-registerspec-20260806-a-del-05',
  scope: 'Alla kända båtar: OCR-/läsfelet 70 hk rättas till källans 90 hk utan konkurrerande sakuppgift',
  boat_ids: state.listEntities('boat').map(boat => boat.entity_id).sort((left, right) => left.localeCompare(right, 'sv')),
  expected_counts: expectedCounts,
  linked_master_requirements: [],
  sources: [],
  records: [],
  changes: [
    { entity_type: 'boat-spec-observation', entity_id: sourceSpecId, expect: { record: sourceSpec }, set: { record: correctedSourceSpec } },
    { entity_type: 'boat-spec-observation', entity_id: correctionSpecId, expect: { record: correctionSpec }, delete: true },
    { entity_type: 'boat-source', entity_id: correctionSourceId, expect: { record: correctionSource }, delete: true },
  ],
  verify: [
    { entity_type: 'boat-spec-observation', entity_id: sourceSpecId, fields: { record: correctedSourceSpec } },
    { entity_type: 'boat-spec-observation', entity_id: correctionSpecId, deleted: true },
    { entity_type: 'boat-source', entity_id: correctionSourceId, deleted: true },
  ],
};

const outputRoot = resolve(appRoot, 'privat/piloter', pilotId);
await mkdir(outputRoot, { recursive: true });
const outputPath = resolve(outputRoot, 'plan.json');
await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
console.log(JSON.stringify({ pilot_id: pilotId, plan: outputPath, boats: plan.boat_ids.length, changes: plan.changes.length }, null, 2));
