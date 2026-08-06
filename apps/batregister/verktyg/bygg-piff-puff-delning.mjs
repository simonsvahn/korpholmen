import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materialize } from '../../../packages/core/domain/materializer.js';
import { validateBatch } from '../../../packages/core/sync/batch.js';

const [boatOpsArgument] = process.argv.slice(2);
if (!boatOpsArgument) throw new Error('Användning: node bygg-piff-puff-delning.mjs BATREGISTER-OPS');

const boatOpsRoot = resolve(boatOpsArgument);
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pilotId = 'batmaster-pilot-registerspec-20260806-a-del-04';

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
const oldBoat = state.getEntity('boat', 'piffpuff');
if (!oldBoat) throw new Error('Det sammanslagna Piff & Puff-objektet saknas.');
if (state.getEntity('boat', 'piff', { includeDeleted: true }) || state.getEntity('boat', 'puff', { includeDeleted: true })) {
  throw new Error('Piff eller Puff finns redan.');
}
const expectedOld = {
  namn: 'Piff & Puff',
  typ: 'R/S',
  modell: 'R/S kajaker; 3,68',
  agare: 'Junior Filip resp. Junior Linus',
};
for (const [field, value] of Object.entries(expectedOld)) {
  if (JSON.stringify(oldBoat.fields[field]) !== JSON.stringify(value)) throw new Error(`Piff & Puff har oväntat före-värde i ${field}.`);
}

const imageSource = state.getEntity('boat-source', 'source:batar2-image-piff-och-puff-jpg')?.fields.record;
if (!imageSource || JSON.stringify(imageSource.entity_ids) !== JSON.stringify(['piffpuff'])) {
  throw new Error('Piff & Puffs bildkälla har oväntad koppling.');
}

function imagesFor(boatId) {
  return structuredClone(oldBoat.fields.images || []).map((image, index) => ({
    ...image,
    id: `${boatId}-piff-puff-register-${index + 1}`,
  }));
}

function boatFields(id, name, ownerLabel, personText) {
  return {
    id,
    namn: name,
    namnstatus: 'namn',
    grundid: id,
    typ: 'R/S',
    kategori: 'kayak',
    modell: 'Kajak',
    agare: ownerLabel,
    kbk_personer: [personText],
    period: 'ansökan',
    kallor: ['blad'],
    kallor_text: ['Registerblad (Båtar 2)'],
    images: imagesFor(id),
  };
}

const piffFields = boatFields('piff', 'Piff', 'Filip Åkerman', 'Junior Filip = Filip Åkerman');
const puffFields = boatFields('puff', 'Puff', 'Linus Gunnarsson', 'Junior Linus = Linus Gunnarsson');
const registerSourceId = 'source:boats2-register-piff-puff';
const sharedValues = {
  category: 'kayak',
  length_m: 3.68,
  width_m: 0.52,
  draft_m: 0.27,
  volume_l: 160,
  weight_kg: 17,
  load_capacity_kg: 100,
};
const sharedSourceValues = {
  length_m: '368 cm',
  width_m: '52 cm',
  draft_m: '27 cm',
  volume_l: '160 L',
  weight_kg: '17 kg',
  load_capacity_kg: '100 kg',
};

const records = [
  { entity_type: 'boat-name-observation', entity_id: 'name:piff:boats2-register', record: { boat_id: 'piff', value: 'Piff', kind: 'used-name', status: 'source-observation', source_ids: [registerSourceId] } },
  { entity_type: 'boat-name-observation', entity_id: 'name:puff:boats2-register', record: { boat_id: 'puff', value: 'Puff', kind: 'used-name', status: 'source-observation', source_ids: [registerSourceId] } },
  { entity_type: 'boat-spec-observation', entity_id: 'spec:piff:boats2-register', record: { boat_id: 'piff', values: sharedValues, source_values: sharedSourceValues, qualifiers: null, source_ids: [registerSourceId] } },
  { entity_type: 'boat-spec-observation', entity_id: 'spec:puff:boats2-register', record: { boat_id: 'puff', values: sharedValues, source_values: sharedSourceValues, qualifiers: null, source_ids: [registerSourceId] } },
  { entity_type: 'boat-ownership-observation', entity_id: 'owner:piff:boats2-register', record: { boat_id: 'piff', role: 'owner', party_type: 'person', party_id: 'filipåkerman', party_label: 'Filip Åkerman', start: null, end: null, sequence: 1, status: 'accepted', source_ids: [registerSourceId], legacy_owner_text: 'Junior Filip' } },
  { entity_type: 'boat-ownership-observation', entity_id: 'owner:puff:boats2-register', record: { boat_id: 'puff', role: 'owner', party_type: 'person', party_id: 'linusgunnarsson', party_label: 'Linus Gunnarsson', start: null, end: null, sequence: 1, status: 'accepted', source_ids: [registerSourceId], legacy_owner_text: 'Junior Linus' } },
];

const countedTypes = [
  'boat', 'boat-source', 'boat-name-observation', 'boat-ownership-observation',
  'boat-spec-observation', 'boat-event-observation', 'boat-review-item', 'boat-pilot-manifest',
];
const expectedCounts = Object.fromEntries(countedTypes.map(type => [type, state.listEntities(type).length]));
const updatedImageSource = { ...structuredClone(imageSource), entity_ids: ['piff', 'puff'] };
const changes = [
  { entity_type: 'boat', entity_id: 'piffpuff', expect: expectedOld, delete: true },
  { entity_type: 'boat-source', entity_id: imageSource.id, expect: { record: imageSource }, set: { record: updatedImageSource } },
  { entity_type: 'boat', entity_id: 'piff', create: true, expect: {}, set: piffFields },
  { entity_type: 'boat', entity_id: 'puff', create: true, expect: {}, set: puffFields },
];
const activeBoatIds = state.listEntities('boat').map(boat => boat.entity_id).filter(id => id !== 'piffpuff');
activeBoatIds.push('piff', 'puff');

const verify = [
  { entity_type: 'boat', entity_id: 'piffpuff', deleted: true },
  { entity_type: 'boat-source', entity_id: imageSource.id, fields: { record: updatedImageSource } },
  { entity_type: 'boat', entity_id: 'piff', fields: piffFields },
  { entity_type: 'boat', entity_id: 'puff', fields: puffFields },
  ...records.map(record => ({ entity_type: record.entity_type, entity_id: record.entity_id, fields: { record: record.record } })),
];
const plan = {
  schema_version: 1,
  pilot_id: pilotId,
  model_version: 'boat-master-identity-split-v1',
  label: 'Båtmaster · Piff och Puff som två båtar',
  supersedes: 'batmaster-pilot-registerspec-20260806-a-del-03',
  scope: 'Alla kända båtar: Piff och Puff delas till två källbelagda objekt',
  boat_ids: activeBoatIds.sort((left, right) => left.localeCompare(right, 'sv')),
  expected_counts: expectedCounts,
  linked_master_requirements: [
    { master: 'matrikel', entity_type: 'person', entity_id: 'filipåkerman', expect: { display_name: 'Filip Åkerman' } },
    { master: 'matrikel', entity_type: 'person', entity_id: 'linusgunnarsson', expect: { display_name: 'Linus Gunnarsson' } },
  ],
  sources: [{
    id: registerSourceId,
    label: 'Originalregisterblad: Piff och Puff',
    kind: 'register-leaf',
    filename: 'Piff och Puff.pdf',
    path_contains: 'källmaterial/07 KBK-arkivet/Båtar 2 - Scannade av Broder Peter-Pedal (Holm)',
    source_date: null,
    entity_ids: ['piff', 'puff'],
    authority_for: ['vessel identity', 'vessel specifications as written on register leaf', 'owner identity as written on register leaf'],
  }],
  records,
  changes,
  verify,
};

const outputRoot = resolve(appRoot, 'privat/piloter', pilotId);
await mkdir(outputRoot, { recursive: true });
const outputPath = resolve(outputRoot, 'plan.json');
await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
console.log(JSON.stringify({ pilot_id: pilotId, plan: outputPath, boats: plan.boat_ids.length, records: records.length, changes: changes.length }, null, 2));
