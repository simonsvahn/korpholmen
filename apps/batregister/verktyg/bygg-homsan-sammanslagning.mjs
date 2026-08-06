import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materialize } from '../../../packages/core/domain/materializer.js';
import { validateBatch } from '../../../packages/core/sync/batch.js';

const [boatOpsArgument] = process.argv.slice(2);
if (!boatOpsArgument) throw new Error('Användning: node bygg-homsan-sammanslagning.mjs BATREGISTER-OPS');

const boatOpsRoot = resolve(boatOpsArgument);
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pilotId = 'batmaster-pilot-registerspec-20260806-a-del-07';

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

function activeRecord(type, id) {
  const record = state.getEntity(type, id)?.fields.record;
  if (!record) throw new Error(`Före-posten saknas: ${type}:${id}`);
  return structuredClone(record);
}

function activeFields(type, id) {
  const entity = state.getEntity(type, id);
  if (!entity) throw new Error(`Före-entiteten saknas: ${type}:${id}`);
  return structuredClone(entity.fields);
}

const homsanFields = activeFields('boat', 'homsan');
const mosterGitteFields = activeFields('boat', 'mostergitte');
const applicationSource = activeRecord('boat-source', 'source:d26-moster-gitte-2007');
const imageSource = activeRecord('boat-source', 'source:d26-image-moster-gitte');
const duplicateApplicationSource = activeRecord('boat-source', 'source:digitalisering-img-7526');
const proposal = activeRecord('boat-name-observation', 'name:mostergitte:proposal-2007');
const oldBovingOwner = activeRecord('boat-ownership-observation', 'owner:mostergitte:boving-2007');
const oldApplicationSpec = activeRecord('boat-spec-observation', 'spec:mostergitte:application-2007');
const homsanName = activeRecord('boat-name-observation', 'name:homsan:inger');
const svahnOwner = activeRecord('boat-ownership-observation', 'owner:homsan:family');
const oldPurchaseEvent = activeRecord('boat-event-observation', 'event:homsan:purchase');
const openIdentityReview = activeRecord('boat-review-item', 'review:homsan:previous-boving');

if (mosterGitteFields.modell !== 'Linder 460' || homsanFields.modell !== 'Linder 460') {
  throw new Error('Homsan och Moster Gitte har inte längre väntad modell.');
}
if (proposal.value !== 'Moster Gitte' || proposal.kind !== 'owner-proposal') {
  throw new Error('Namnförslaget för Moster Gitte har ett oväntat före-värde.');
}
if (svahnOwner.start?.year !== 2013 || oldBovingOwner.start?.year !== 2007) {
  throw new Error('Ägarkedjans årtal har oväntade före-värden.');
}

const transitionId = 'transition:homsan:2013-boving-svahn';
const userSourceId = 'source:simon-2026-08-06-homsan';
const updatedHomsanFields = {
  ...homsanFields,
  langd_m: 4.6,
  period: '2007–',
  tidigare_namn: ['Moster Gitte'],
  images: structuredClone(mosterGitteFields.images || []).map((image, index) => ({
    ...image,
    id: `homsan-moster-gitte-application-${index + 1}`,
  })),
};
const updatedApplicationSource = {
  ...applicationSource,
  entity_ids: ['homsan'],
  authority_for: ['vessel identity', 'model', 'dimensions', 'engine brand', 'horsepower', 'owner statement', 'proposed name'],
};
const updatedImageSource = { ...imageSource, entity_ids: ['homsan'] };
const updatedHomsanName = {
  ...homsanName,
  kind: 'used-name',
  start: { year: 2013, precision: 'year' },
};
const updatedSvahnOwner = {
  ...svahnOwner,
  sequence: 2,
  transition_id: transitionId,
  source_ids: [...new Set([...(svahnOwner.source_ids || []), userSourceId])],
};
const updatedPurchaseEvent = {
  ...oldPurchaseEvent,
  event_type: 'ownership_transfer',
  label: 'Ägarbyte från familjen Böving till Anders och Lotta Svahn',
  transition_id: transitionId,
  source_ids: [...new Set([...(oldPurchaseEvent.source_ids || []), userSourceId])],
};

const records = [
  {
    entity_type: 'boat-name-observation',
    entity_id: 'name:homsan:moster-gitte-used',
    record: {
      boat_id: 'homsan',
      value: 'Moster Gitte',
      kind: 'used-name',
      status: 'accepted',
      start: { year: 2007, precision: 'year' },
      end: { year: 2013, precision: 'year' },
      transition_id: transitionId,
      source_ids: ['source:d26-moster-gitte-2007', userSourceId],
    },
  },
  {
    entity_type: 'boat-name-observation',
    entity_id: 'name:homsan:moster-gitte-proposal-2007',
    record: {
      ...proposal,
      boat_id: 'homsan',
    },
  },
  {
    entity_type: 'boat-ownership-observation',
    entity_id: 'owner:homsan:boving-2007-2013',
    record: {
      ...oldBovingOwner,
      boat_id: 'homsan',
      party_type: 'family-unit',
      party_id: 'family-unit:model:29ad8bfb300904b5',
      party_ids: undefined,
      party_label: 'Helene Böving och Kaj Böving',
      named_person_ids: ['kajböving', 'heleneböving', 'månsböving', 'olaböving'],
      start: { year: 2007, precision: 'year' },
      end: { year: 2013, precision: 'year' },
      sequence: 1,
      transition_id: transitionId,
      source_ids: [...new Set([...(oldBovingOwner.source_ids || []), userSourceId])],
    },
  },
  {
    entity_type: 'boat-spec-observation',
    entity_id: 'spec:homsan:application-2007',
    record: {
      ...oldApplicationSpec,
      boat_id: 'homsan',
    },
  },
  {
    entity_type: 'boat-event-observation',
    entity_id: 'event:homsan:name-change-2013',
    record: {
      boat_id: 'homsan',
      event_type: 'name_change',
      date: { year: 2013, precision: 'year' },
      label: 'Namnbyte från Moster Gitte till Homsan',
      from_name: 'Moster Gitte',
      to_name: 'Homsan',
      transition_id: transitionId,
      status: 'accepted',
      source_ids: [userSourceId, 'source:inger-boats'],
    },
  },
];

const countedTypes = [
  'boat', 'boat-source', 'boat-name-observation', 'boat-ownership-observation',
  'boat-spec-observation', 'boat-event-observation', 'boat-review-item', 'boat-pilot-manifest',
];
const expectedCounts = Object.fromEntries(countedTypes.map(type => [type, state.listEntities(type).length]));
const changes = [
  { entity_type: 'boat', entity_id: 'homsan', expect: homsanFields, set: updatedHomsanFields },
  { entity_type: 'boat', entity_id: 'mostergitte', expect: mosterGitteFields, delete: true },
  { entity_type: 'boat-source', entity_id: 'source:d26-moster-gitte-2007', expect: { record: applicationSource }, set: { record: updatedApplicationSource } },
  { entity_type: 'boat-source', entity_id: 'source:d26-image-moster-gitte', expect: { record: imageSource }, set: { record: updatedImageSource } },
  { entity_type: 'boat-source', entity_id: 'source:digitalisering-img-7526', expect: { record: duplicateApplicationSource }, delete: true },
  { entity_type: 'boat-name-observation', entity_id: 'name:mostergitte:proposal-2007', expect: { record: proposal }, delete: true },
  { entity_type: 'boat-name-observation', entity_id: 'name:homsan:inger', expect: { record: homsanName }, set: { record: updatedHomsanName } },
  { entity_type: 'boat-ownership-observation', entity_id: 'owner:mostergitte:boving-2007', expect: { record: oldBovingOwner }, delete: true },
  { entity_type: 'boat-ownership-observation', entity_id: 'owner:homsan:family', expect: { record: svahnOwner }, set: { record: updatedSvahnOwner } },
  { entity_type: 'boat-spec-observation', entity_id: 'spec:mostergitte:application-2007', expect: { record: oldApplicationSpec }, delete: true },
  { entity_type: 'boat-event-observation', entity_id: 'event:homsan:purchase', expect: { record: oldPurchaseEvent }, set: { record: updatedPurchaseEvent } },
  { entity_type: 'boat-review-item', entity_id: 'review:homsan:previous-boving', expect: { record: openIdentityReview }, delete: true },
];

for (const [type, id] of [
  ['boat-person-link', 'mostergitte--olaböving'],
  ['boat-person-link', 'homsan--anderssvahn'],
  ['boat-person-link', 'homsan--lottasvahn'],
  ['boat-group-link', 'homsan--group--family-unit--family-unit:model:fe57caf35044a8a1'],
]) {
  const fields = activeFields(type, id);
  changes.push({ entity_type: type, entity_id: id, expect: fields, delete: true });
}

const activeBoatIds = state.listEntities('boat').map(boat => boat.entity_id).filter(id => id !== 'mostergitte');
const verify = [
  { entity_type: 'boat', entity_id: 'homsan', fields: updatedHomsanFields },
  { entity_type: 'boat', entity_id: 'mostergitte', deleted: true },
  { entity_type: 'boat-source', entity_id: 'source:d26-moster-gitte-2007', fields: { record: updatedApplicationSource } },
  { entity_type: 'boat-source', entity_id: 'source:d26-image-moster-gitte', fields: { record: updatedImageSource } },
  { entity_type: 'boat-source', entity_id: 'source:digitalisering-img-7526', deleted: true },
  { entity_type: 'boat-name-observation', entity_id: 'name:homsan:inger', fields: { record: updatedHomsanName } },
  { entity_type: 'boat-ownership-observation', entity_id: 'owner:homsan:family', fields: { record: updatedSvahnOwner } },
  { entity_type: 'boat-event-observation', entity_id: 'event:homsan:purchase', fields: { record: updatedPurchaseEvent } },
  { entity_type: 'boat-review-item', entity_id: 'review:homsan:previous-boving', deleted: true },
  ...records.map(record => ({ entity_type: record.entity_type, entity_id: record.entity_id, fields: { record: record.record } })),
];

const plan = {
  schema_version: 1,
  pilot_id: pilotId,
  model_version: 'boat-master-identity-merge-and-transition-v1',
  label: 'Båtmaster · Moster Gitte och Homsan sammanslagna',
  supersedes: 'batmaster-pilot-registerspec-20260806-a-del-06',
  scope: 'Alla kända båtar: en Linder 460 med namn- och ägarbyte 2013',
  boat_ids: activeBoatIds.sort((left, right) => left.localeCompare(right, 'sv')),
  expected_counts: expectedCounts,
  linked_master_requirements: [
    { master: 'matrikel', entity_type: 'family-unit', entity_id: 'family-unit:model:29ad8bfb300904b5', expect: { name: 'Helene Böving och Kaj Böving' } },
    { master: 'matrikel', entity_type: 'family-unit', entity_id: 'family-unit:model:fe57caf35044a8a1', expect: { name: 'Anders Svahn och Lotta Svahn' } },
    { master: 'matrikel', entity_type: 'person', entity_id: 'kajböving', expect: { display_name: 'Kaj Böving' } },
    { master: 'matrikel', entity_type: 'person', entity_id: 'heleneböving', expect: { display_name: 'Helene Böving' } },
    { master: 'matrikel', entity_type: 'person', entity_id: 'månsböving', expect: { display_name: 'Måns Böving' } },
    { master: 'matrikel', entity_type: 'person', entity_id: 'olaböving', expect: { display_name: 'Ola Böving' } },
  ],
  sources: [{
    id: userSourceId,
    label: 'Uppgift om Homsans tidigare identitet',
    kind: 'oral',
    source_date: null,
    speaker: 'Simon Svahn',
    recorded_at: '2026-08-06',
    statement: 'Homsan är samma båt som Moster Gitte.',
    entity_ids: ['homsan'],
    authority_for: ['vessel identity', 'name change at ownership transfer'],
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
