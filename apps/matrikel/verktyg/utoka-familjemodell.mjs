import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { canonicalStringify } from '../../../packages/core/domain/canonical.js';
import { createClock, parseHLC } from '../../../packages/core/domain/hlc.js';
import { materialize } from '../../../packages/core/domain/materializer.js';
import { createRestoreOperation, createSetOperation } from '../../../packages/core/domain/operations.js';
import { batchPath, createBatch, validateBatch } from '../../../packages/core/sync/batch.js';

const [opsArgument, outputArgument, configurationArgument, migrationArgument] = process.argv.slice(2);
if (!opsArgument || !outputArgument || !configurationArgument || !migrationArgument) {
  throw new Error('Användning: node utoka-familjemodell.mjs OPS-MAPP UTDATA-MAPP KONFIGURATION MIGRERINGS-ID');
}

const opsDirectory = resolve(opsArgument);
const outputDirectory = resolve(outputArgument);
const configurationPath = resolve(configurationArgument);
const migrationId = String(migrationArgument).trim();
if (!/^[a-z0-9][a-z0-9-]{5,80}$/.test(migrationId)) throw new Error('Migrerings-id får bara innehålla a-z, 0-9 och bindestreck.');

const configuration = JSON.parse(await readFile(configurationPath, 'utf8'));
if (configuration.schema_version !== 1) throw new Error('Familjemodellens konfiguration har fel schemaversion.');

const inputFiles = (await readdir(opsDirectory)).filter(name => name.endsWith('.json')).sort();
const inputBatches = await Promise.all(inputFiles.map(async name => {
  const batch = JSON.parse(await readFile(resolve(opsDirectory, name), 'utf8'));
  validateBatch(batch);
  return batch;
}));
const existingOperations = inputBatches.flatMap(batch => batch.ops);
const state = materialize(existingOperations);
const rows = type => state.listEntities(type).map(entity => ({ id: entity.entity_id, ...entity.fields }));
const people = rows('person');
const relations = rows('relation');
const existingFamilyUnits = rows('family-unit');
const existingKinGroups = rows('kin-group');
const peopleById = new Map(people.map(person => [person.id, person]));
const familyById = new Map(existingFamilyUnits.map(group => [group.id, group]));
const kinById = new Map(existingKinGroups.map(group => [group.id, group]));
const kinByReference = new Map(existingKinGroups.map(group => [group.reference_code, group]));
const excludedClans = new Set(configuration.excluded_clans || []);

const clean = values => [...new Set((values || []).filter(Boolean))];
const ordered = values => clean(values).sort((left, right) => String(left).localeCompare(String(right), 'sv'));
const appendUnique = (...lists) => clean(lists.flat());
const anchorsKey = ids => ordered(ids).join('|');
const confirmed = record => record?.confirmed === true || record?.user_confirmed === true;
const same = (left, right) => left === undefined || right === undefined
  ? left === right
  : canonicalStringify(left) === canonicalStringify(right);
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 16);
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('sv').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const personName = id => peopleById.get(id)?.display_name || id;
const joinNames = ids => {
  const names = ids.map(personName);
  if (names.length < 2) return names[0] || 'Namnlös familj';
  return `${names.slice(0, -1).join(', ')} och ${names.at(-1)}`;
};
const nextNumber = (prefix, records) => records.reduce((highest, record) => {
  const match = String(record.reference_code || '').match(new RegExp(`^${prefix}-(\\d+)$`, 'i'));
  return match ? Math.max(highest, Number(match[1])) : highest;
}, 0) + 1;
const code = (prefix, number) => `${prefix}-${String(number).padStart(3, '0')}`;

const parentsByChild = new Map();
for (const relation of relations.filter(entry => entry.kind === 'foralder-barn')) {
  if (!parentsByChild.has(relation.to_person_id)) parentsByChild.set(relation.to_person_id, []);
  parentsByChild.get(relation.to_person_id).push(relation);
}

const candidates = new Map();
function familyCandidate(anchorIds) {
  const ids = ordered(anchorIds);
  const key = anchorsKey(ids);
  if (!candidates.has(key)) candidates.set(key, { key, anchor_ids: ids, basis_types: new Set(), confirmations: [] });
  return candidates.get(key);
}
for (const relation of relations.filter(entry => entry.kind === 'partner' || entry.kind === 'tidigare')) {
  const candidate = familyCandidate([relation.from_person_id, relation.to_person_id]);
  candidate.basis_types.add(relation.kind === 'tidigare' ? 'tidigare_partner' : 'partner');
  candidate.confirmations.push(confirmed(relation));
}
for (const childRelations of parentsByChild.values()) {
  const parentIds = ordered(childRelations.map(relation => relation.from_person_id));
  if (parentIds.length < 2) continue;
  const candidate = familyCandidate(parentIds);
  candidate.basis_types.add('gemensamma_foraldrar');
  candidate.confirmations.push(childRelations.every(confirmed));
}

const currentFamilyByAnchors = new Map(existingFamilyUnits.map(group => [anchorsKey(group.anchor_person_ids), group]));
const clanMembers = new Map();
for (const person of people) {
  const clan = String(person.ui_clan || '').trim();
  if (!clan || excludedClans.has(clan)) continue;
  if (!clanMembers.has(clan)) clanMembers.set(clan, []);
  clanMembers.get(clan).push(person);
}

let nextKinNumber = nextNumber('SLÄKT', existingKinGroups);
const rootByClan = new Map();
const plannedKinGroups = new Map(existingKinGroups.map(group => [group.id, { ...group }]));
for (const clan of [...clanMembers.keys()].sort((a, b) => a.localeCompare(b, 'sv'))) {
  const settings = configuration.clan_groups?.[clan] || {};
  let group = settings.existing_reference_code ? kinByReference.get(settings.existing_reference_code) : null;
  if (!group) group = existingKinGroups.find(entry => (entry.legacy_labels || []).includes(clan));
  if (!group) {
    const id = `kin-group:model:${normalize(clan)}-${digest(clan)}`;
    group = kinById.get(id) || {
      id,
      reference_code: code('SLÄKT', nextKinNumber++),
      name: settings.name || clan.replace(/-klanen\s*\([^)]*\)/i, '').trim(),
      kind: settings.kind || 'family_circle',
      membership_rule: 'explicit',
      confirmed: false,
      model_key: `legacy-clan:${clan}`,
    };
  }
  const members = clanMembers.get(clan);
  const assignedBranchLabels = new Set(Object.entries(configuration.family_group_aliases || {})
    .filter(([, reference]) => reference !== group.reference_code)
    .map(([label]) => label));
  const familyLabels = ordered(members.map(person => person.family).filter(label => !assignedBranchLabels.has(label)));
  const planned = {
    ...group,
    anchor_person_ids: appendUnique(group.anchor_person_ids || [], settings.anchor_person_ids || []),
    explicit_person_ids: ordered([...(group.explicit_person_ids || []), ...members.map(person => person.id)]),
    legacy_labels: ordered([...(group.legacy_labels || []), clan, ...familyLabels]),
  };
  plannedKinGroups.set(planned.id, planned);
  rootByClan.set(clan, planned.id);
}

for (const [familyLabel, referenceCode] of Object.entries(configuration.family_group_aliases || {})) {
  const current = [...plannedKinGroups.values()].find(group => group.reference_code === referenceCode);
  if (!current) throw new Error(`Konfigurationen hänvisar till okänd släktgrupp: ${referenceCode}`);
  plannedKinGroups.set(current.id, {
    ...current,
    legacy_labels: ordered([...(current.legacy_labels || []), familyLabel]),
    search_aliases: ordered([...(current.search_aliases || []), familyLabel]),
  });
}

function kinGroupsForAnchors(anchorIds) {
  const result = new Set();
  for (const personId of anchorIds) {
    const person = peopleById.get(personId);
    const branchReference = configuration.family_group_aliases?.[person?.family];
    const branch = branchReference && [...plannedKinGroups.values()].find(group => group.reference_code === branchReference);
    if (branch) result.add(branch.id);
    else if (rootByClan.has(person?.ui_clan)) result.add(rootByClan.get(person.ui_clan));
  }
  return [...result].sort();
}

let nextFamilyNumber = nextNumber('FAMILJ', existingFamilyUnits);
const plannedFamilyUnits = new Map(existingFamilyUnits.map(group => [group.id, { ...group }]));
for (const candidate of [...candidates.values()].sort((left, right) => joinNames(left.anchor_ids).localeCompare(joinNames(right.anchor_ids), 'sv'))) {
  let group = currentFamilyByAnchors.get(candidate.key);
  const existingGroup = Boolean(group);
  if (!group) {
    const id = `family-unit:model:${digest(candidate.key)}`;
    group = familyById.get(id) || {
      id,
      reference_code: code('FAMILJ', nextFamilyNumber++),
      name: joinNames(candidate.anchor_ids),
      name_status: 'automatiskt_forslag',
      confirmed: candidate.confirmations.length > 0 && candidate.confirmations.every(Boolean),
      model_key: `anchors:${candidate.key}`,
    };
  }
  plannedFamilyUnits.set(group.id, {
    ...group,
    anchor_person_ids: existingGroup ? group.anchor_person_ids : candidate.anchor_ids,
    membership_rule: 'anchors_and_shared_children',
    basis_types: ordered([...(group.basis_types || []), ...candidate.basis_types]),
    kin_group_ids: existingGroup ? ordered(group.kin_group_ids || []) : kinGroupsForAnchors(candidate.anchor_ids),
  });
}

const operations = [];
const deviceId = migrationId;
const migrationWallTime = Math.max(Date.now(), ...existingOperations.map(operation => parseHLC(operation.hlc).wallTime)) + 1;
const clock = createClock(deviceId, () => migrationWallTime);
let sequence = 0;
function restore(entityType, entityId) {
  sequence += 1;
  operations.push(createRestoreOperation({ deviceId, seq: sequence, entityType, entityId, hlc: clock.tick() }));
}
function setField(entityType, entityId, field, value) {
  sequence += 1;
  operations.push(createSetOperation({ deviceId, seq: sequence, entityType, entityId, field, value, hlc: clock.tick() }));
}
function planRecord(entityType, planned, existing) {
  if (!existing) restore(entityType, planned.id);
  for (const [field, value] of Object.entries(planned)) {
    if (field === 'id' || (existing && same(existing[field], value))) continue;
    setField(entityType, planned.id, field, value);
  }
}
for (const group of [...plannedKinGroups.values()].sort((a, b) => String(a.reference_code).localeCompare(String(b.reference_code), 'sv', { numeric: true }))) {
  planRecord('kin-group', group, kinById.get(group.id));
}
for (const group of [...plannedFamilyUnits.values()].sort((a, b) => String(a.reference_code).localeCompare(String(b.reference_code), 'sv', { numeric: true }))) {
  planRecord('family-unit', group, familyById.get(group.id));
}

if (!operations.length) {
  console.log(JSON.stringify({ migration_id: migrationId, input_batches: inputBatches.length, operations: 0, message: 'Familjemodellen är redan aktuell.' }, null, 2));
  process.exit(0);
}

const after = materialize([...existingOperations, ...operations]);
const afterRows = type => after.listEntities(type).map(entity => ({ id: entity.entity_id, ...entity.fields }));
const afterFamilies = afterRows('family-unit');
const afterKinGroups = afterRows('kin-group');
if (afterRows('person').length !== people.length || afterRows('relation').length !== relations.length) throw new Error('Migreringen ändrade personer eller personrelationer.');
if (afterFamilies.length !== plannedFamilyUnits.size || afterKinGroups.length !== plannedKinGroups.size) throw new Error('Alla planerade grupper materialiserades inte.');
const references = [...afterFamilies, ...afterKinGroups].map(group => group.reference_code);
if (new Set(references).size !== references.length) throw new Error('Referenskoder är inte unika.');
for (const group of [...afterFamilies, ...afterKinGroups]) {
  for (const personId of [...(group.anchor_person_ids || []), ...(group.explicit_person_ids || [])]) {
    if (!peopleById.has(personId)) throw new Error(`Okänd person i ${group.reference_code}: ${personId}`);
  }
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
  migration_id: migrationId,
  input_batches: inputBatches.length,
  operations: operations.length,
  output_files: outputFiles,
  before: { people: people.length, relations: relations.length, family_units: existingFamilyUnits.length, kin_groups: existingKinGroups.length },
  after: { people: people.length, relations: relations.length, family_units: afterFamilies.length, kin_groups: afterKinGroups.length },
  family_units_created: afterFamilies.length - existingFamilyUnits.length,
  kin_groups_created: afterKinGroups.length - existingKinGroups.length,
}, null, 2));
