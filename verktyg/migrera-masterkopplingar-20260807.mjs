import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  batchPath,
  canonicalStringify,
  compareHLC,
  createBatch,
  createClock,
  createDeleteOperation,
  createSetOperation,
  materialize,
  validateBatch,
} from '../packages/core/data-layer.js';

const requestedRoot = process.argv[2];
const apply = process.argv.includes('--apply');
if (!requestedRoot) throw new Error('Ange Dropbox-roten, exempelvis /Users/.../Dropbox/Appar/Korpholmen');
const dropboxRoot = await realpath(resolve(requestedRoot));
if (!dropboxRoot.endsWith('/Dropbox/Appar/Korpholmen')) throw new Error(`Avbryter: målet är inte Dropbox/Appar/Korpholmen: ${dropboxRoot}`);

async function loadMaster(app) {
  const opsRoot = resolve(dropboxRoot, app, 'ops');
  const batches = await Promise.all((await readdir(opsRoot))
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(async name => {
      const batch = JSON.parse(await readFile(resolve(opsRoot, name), 'utf8'));
      validateBatch(batch);
      return batch;
    }));
  const operations = batches.flatMap(batch => batch.ops);
  return { app, opsRoot, operations, state: materialize(operations) };
}

function operationPlanner(master, deviceId) {
  const currentSeq = master.operations
    .filter(operation => operation.device_id === deviceId)
    .reduce((maximum, operation) => Math.max(maximum, operation.seq), 0);
  const latestHlc = master.operations.map(operation => operation.hlc)
    .reduce((latest, value) => !latest || compareHLC(value, latest) > 0 ? value : latest, null);
  const clock = createClock(deviceId, () => Date.now(), latestHlc);
  let seq = currentSeq;
  const operations = [];
  const same = (left, right) => left === undefined || right === undefined
    ? left === right
    : canonicalStringify(left) === canonicalStringify(right);
  return {
    operations,
    set(entityType, entityId, field, value) {
      const current = master.state.getEntity(entityType, entityId)?.fields?.[field];
      if (same(current, value)) return;
      operations.push(createSetOperation({ deviceId, seq: ++seq, entityType, entityId, field, value, hlc: clock.tick() }));
    },
    delete(entityType, entityId) {
      if (!master.state.getEntity(entityType, entityId)) return;
      operations.push(createDeleteOperation({ deviceId, seq: ++seq, entityType, entityId, hlc: clock.tick() }));
    },
  };
}

async function writeOperations(master, operations) {
  const written = [];
  if (!apply || !operations.length) return written;
  for (let index = 0; index < operations.length; index += 250) {
    const batch = createBatch(operations.slice(index, index + 250));
    const relative = batchPath(batch.device_id, batch.from_seq, batch.to_seq, `/${master.app}/ops`)
      .replace(new RegExp(`^/${master.app}/ops/`), '');
    const path = resolve(master.opsRoot, relative);
    const content = `${JSON.stringify(batch, null, 2)}\n`;
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, content, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readFile(path, 'utf8');
      if (existing !== content) throw new Error(`Befintlig operationsbatch skiljer sig och skrivs inte över: ${path}`);
    }
    const bytes = await readFile(path);
    const expectedHash = createHash('sha256').update(content).digest('hex');
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== expectedHash) throw new Error(`Den skrivna batchen fick fel hash: ${path}`);
    written.push(path);
  }
  return written;
}

const [matrikel, batregister, dokumentarkiv, kartdata] = await Promise.all([
  loadMaster('matrikel'),
  loadMaster('batregister'),
  loadMaster('dokumentarkiv'),
  loadMaster('kartdata'),
]);

const familyMappings = [
  ['filifjonkanii--family--bethge', 'kin-group:20260802:005'],
  ['öskaret--family--une-une-larsson', 'kin-group:model:une-klanen-allan-brita-be5e2d31a0aaaa82'],
  ['sädmåsen--family--risinger-soderberg', 'kin-group:model:risinger-klanen-gunnel-goran-322c9d81ec2dede5'],
  ['häxan_böving--family--boving', 'kin-group:20260802:006'],
  ['pancho--family--boving', 'kin-group:20260802:006'],
  ['piganpiganii--family--boving', 'kin-group:20260802:006'],
  ['puh--family--boving', 'kin-group:20260802:006'],
  ['vift--family--boving', 'kin-group:20260802:006'],
  ['hållidenbuddyholly--family--holm', 'kin-group:model:neretnieks-klanen-ivars-margareta-07377c52c23c826d'],
];
const legacyLinks = batregister.state.listEntities('boat-family-link');
const legacyFamilies = batregister.state.listEntities('family');
if (legacyLinks.length && legacyLinks.length !== familyMappings.length) throw new Error(`Avbryter: fann ${legacyLinks.length} äldre familjelänkar, förväntade ${familyMappings.length}`);
if (legacyFamilies.length && legacyFamilies.length !== 34) throw new Error(`Avbryter: fann ${legacyFamilies.length} äldre familjeposter, förväntade 34`);

const boatPlan = operationPlanner(batregister, 'batregister-masterlinks-20260807');
for (const [legacyId, targetId] of familyMappings) {
  const legacy = batregister.state.getEntity('boat-family-link', legacyId)?.fields;
  const target = matrikel.state.getEntity('kin-group', targetId)?.fields;
  if (!target) throw new Error(`Matrikelgruppen saknas: ${targetId}`);
  if (legacy && !(target.legacy_labels || []).includes(legacy.family_name)) {
    throw new Error(`Avbryter: ${legacy.family_name} är inte en uttrycklig äldre etikett för ${target.name}`);
  }
  const boatId = legacy?.boat_id || legacyId.split('--family--')[0];
  const newId = `${boatId}--group--kin-group--${targetId}`;
  const existingGroupLink = batregister.state.getEntity('boat-group-link', newId)?.fields;
  const source = legacy?.source || existingGroupLink?.source || 'Migrerad från godkänd äldre familjekoppling 2026-08-07';
  for (const [field, value] of Object.entries({
    boat_id: boatId,
    target_type: 'kin-group',
    target_id: targetId,
    target_code: target.reference_code,
    target_name: target.name,
    role: legacy?.role || existingGroupLink?.role || 'ägarfamilj/anknuten familj',
    confirmed: true,
    source,
  })) boatPlan.set('boat-group-link', newId, field, value);
  boatPlan.delete('boat-family-link', legacyId);
}
for (const family of legacyFamilies) boatPlan.delete('family', family.entity_id);
const boatAfter = materialize([...batregister.operations, ...boatPlan.operations]);
if (boatAfter.listEntities('boat-family-link').length || boatAfter.listEntities('family').length) throw new Error('Efter simulering finns äldre familjedata kvar');
for (const [, targetId] of familyMappings) {
  if (!boatAfter.listEntities('boat-group-link').some(entity => entity.fields.target_id === targetId)) throw new Error(`Efter simulering saknas gruppkopplingen ${targetId}`);
}

const archiveMappings = [
  ['place:korpholmen', 'place', 'korpholmen', 'Korpholmen'],
  ['place:sviholmen', 'place', 'sviholmen', 'Sviholmen'],
  ['place:stugholmen', 'place', 'stugholmen', 'Stugholmen'],
  ['place:angsholmen', 'place', 'angsholmen', 'Ängsholmen'],
  ['place:yxlan', 'place', 'yxlan', 'Yxlan'],
  ['place:midsommarangen', 'data-entry', 'K102', 'Midsommarängen'],
  ['house:oroligheten', 'data-entry', 'K13', 'Oroligheten'],
  ['house:korpholmsmuseet', 'data-entry', 'K99', 'Korpholmsmuseet'],
];
const archivePlan = operationPlanner(dokumentarkiv, 'dokumentarkiv-kartdata-links-20260807');
for (const [entityId, externalType, externalId, expectedName] of archiveMappings) {
  const archive = dokumentarkiv.state.getEntity('archive-entity', entityId)?.fields;
  if (!archive || archive.name !== expectedName) throw new Error(`Dokumentarkivets förväntade post saknas: ${entityId} = ${expectedName}`);
  const target = kartdata.state.getEntity(externalType, externalId)?.fields;
  const targetName = externalType === 'place' ? target?.preferred_name : target?.name;
  if (targetName !== expectedName) throw new Error(`Kartdatamålet stämmer inte: ${externalType}:${externalId} = ${targetName}`);
  for (const [field, value] of Object.entries({
    external_id: externalId,
    external_entity_type: externalType,
    app: 'Kartdata',
    match_status: 'kopplad',
    match_method: 'Godkänd masterkoppling av Simon 2026-08-07',
  })) archivePlan.set('archive-entity', entityId, field, value);
}
const brokholmenId = 'place:brockholmen';
const brokholmen = dokumentarkiv.state.getEntity('archive-entity', brokholmenId)?.fields;
if (!brokholmen || brokholmen.name !== 'Brokholmen') throw new Error('Dokumentarkivets Brokholmen-post saknas');
const kartdataHasBrokholmen = [
  ...kartdata.state.listEntities('place').map(entity => entity.fields.preferred_name),
  ...kartdata.state.listEntities('data-entry').map(entity => entity.fields.name),
].includes('Brokholmen');
if (kartdataHasBrokholmen) throw new Error('Avbryter: Kartdata har nu en Brokholmen-post som måste granskas innan saknas-status sätts');
archivePlan.set('archive-entity', brokholmenId, 'match_status', 'saknas');
archivePlan.set('archive-entity', brokholmenId, 'match_method', 'Ingen verifierad Kartdatakoppling 2026-08-07');
archivePlan.set('archive-entity', brokholmenId, 'note', 'Kartdatakoppling saknas. Den schematiska arkivpositionen är inte en verifierad kartpost.');

const archiveAfter = materialize([...dokumentarkiv.operations, ...archivePlan.operations]);
for (const [entityId, externalType, externalId] of archiveMappings) {
  const fields = archiveAfter.getEntity('archive-entity', entityId)?.fields;
  if (fields?.match_status !== 'kopplad' || fields.external_id !== externalId || fields.external_entity_type !== externalType || fields.app !== 'Kartdata') {
    throw new Error(`Efter simulering är ${entityId} inte korrekt kopplad`);
  }
}
const brokholmenAfter = archiveAfter.getEntity('archive-entity', brokholmenId)?.fields;
if (brokholmenAfter?.match_status !== 'saknas' || brokholmenAfter.external_id) throw new Error('Efter simulering är Brokholmen inte uttryckligen okopplad');

const [boatWritten, archiveWritten] = await Promise.all([
  writeOperations(batregister, boatPlan.operations),
  writeOperations(dokumentarkiv, archivePlan.operations),
]);

console.log(JSON.stringify({
  mode: apply ? 'apply' : 'preview',
  batregister: {
    legacy_family_links_before: legacyLinks.length,
    legacy_family_links_after: boatAfter.listEntities('boat-family-link').length,
    legacy_family_records_before: legacyFamilies.length,
    legacy_family_records_after: boatAfter.listEntities('family').length,
    canonical_group_links_verified: familyMappings.length,
    operations: boatPlan.operations.length,
    batches_written: boatWritten,
  },
  dokumentarkiv: {
    kartdata_links: archiveMappings.length,
    brokholmen_status: brokholmenAfter.match_status,
    operations: archivePlan.operations.length,
    batches_written: archiveWritten,
  },
}, null, 2));
