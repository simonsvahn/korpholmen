import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DropboxTransport,
  MemoryRemoteTransport,
  MemoryStore,
  Repository,
  SyncEngine,
  batchPath,
  materialize
} from '../src/data-layer.js';
import { propertyLinkEntityId, relationEntityId, validateArchive } from '../src/domain/slakt-schema.js';
import {
  buildGraph,
  componentSets,
  familyCircleLabel,
  groupPeople,
  groupPeopleByProperty,
  nearFamily,
  relationshipPath,
  resolvedIslands,
  shownName,
  visiblePersonIds,
} from '../src/landscape-model.js';
import {
  FAMILY_UNIT_TYPE,
  KIN_GROUP_TYPE,
  buildFamilyContext,
  familyUnitMemberDetails,
  kinGroupMemberDetails,
  nextReferenceCode,
  readableReference,
  searchFamilyTargets,
} from '../../../packages/core/family-context.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE = resolve(ROOT, 'privat/migrering-2026-08-01');
const sha256 = value => createHash('sha256').update(value).digest('hex');
let passed = 0;

async function test(name, action) {
  try {
    await action();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

const archiveRaw = await readFile(resolve(PRIVATE, 'initial-archive.json'));
const opsRaw = await readFile(resolve(PRIVATE, 'initial-ops.json'));
const manifest = JSON.parse(await readFile(resolve(PRIVATE, 'migreringsmanifest.json'), 'utf8'));
const archive = JSON.parse(archiveRaw);
const operationsDocument = JSON.parse(opsRaw);
const metadataDocument = JSON.parse(await readFile(resolve(PRIVATE, 'ui-metadata-ops.json'), 'utf8'));
const approvedDocument = JSON.parse(await readFile(resolve(PRIVATE, 'approved-excel-ops.json'), 'utf8'));

await test('startmastern är kryptografiskt låst', async () => {
  assert.equal(typeof manifest.source.sha256, 'string');
  assert.equal(manifest.source.sha256.length, 64);
  assert.equal(sha256(archiveRaw), manifest.archive_sha256);
  assert.equal(sha256(opsRaw), manifest.operations_sha256);
  const source = await readFile(resolve(ROOT, 'privat/legacy/Slaktlandskap 3 - redigerbar.html'));
  assert.equal(sha256(source), manifest.source.sha256);
});

await test('arkivet har 214 personer, 231 relationer och inga lösa ändpunkter', () => {
  validateArchive(archive);
  assert.equal(archive.persons.length, 214);
  assert.equal(archive.relations.length, 231);
});

await test('äldre Chrome- och Safari-exporter är registrerade men inte importerade', () => {
  assert.deepEqual(manifest.excluded_sources.map(source => source.changes).sort((a, b) => a - b), [180, 222]);
  assert.ok(manifest.excluded_sources.every(source => source.treatment === 'arkiverad-men-inte-sammanslagen'));
});

await test('personidentiteter och visningsnamn är kompletta och unika', () => {
  const ids = new Set(archive.persons.map(person => person.id));
  const names = new Set(archive.persons.map(person => person.fields.display_name));
  assert.equal(ids.size, archive.persons.length);
  assert.equal(names.size, archive.persons.length);
  assert.ok([...names].every(Boolean));
});

await test('alla 5 061 startoperationer materialiserar exakt samma antal entiteter', () => {
  assert.equal(operationsDocument.operations.length, 5061);
  const state = materialize(operationsDocument.operations);
  assert.equal(state.listEntities('person').length, 214);
  assert.equal(state.listEntities('relation').length, 231);
  assert.equal(state.getEntity('root', 'slaktlandskap').fields.source_sha256, manifest.source.sha256);
});

await test('1 927 presentationsoperationer kompletterar utan att ändra sakdatans antal', () => {
  assert.equal(metadataDocument.operations.length, 1927);
  const state = materialize([...operationsDocument.operations, ...metadataDocument.operations]);
  assert.equal(state.listEntities('person').length, 214);
  assert.equal(state.listEntities('relation').length, 231);
  const presented = state.listEntities('person').filter(person => person.fields.ui_clan);
  assert.equal(presented.length, 214);
  assert.ok(presented.some(person => Number.isFinite(person.fields.ui_generation)));
});

await test('1 114 godkända Exceloperationer ger livsstatus och fastighetskopplingar', () => {
  assert.equal(approvedDocument.operations.length, 1114);
  assert.deepEqual(approvedDocument.counts, {
    people: 214,
    living_yes: 185,
    living_no: 27,
    living_unknown: 2,
    properties: 34,
    property_links: 137,
    people_with_property: 137,
    people_with_island_without_property: 73,
  });
  const state = materialize([
    ...operationsDocument.operations,
    ...metadataDocument.operations,
    ...approvedDocument.operations,
  ]);
  assert.equal(state.listEntities('person').length, 214);
  assert.equal(state.listEntities('relation').length, 231);
  assert.equal(state.listEntities('property').length, 34);
  assert.equal(state.listEntities('property-link').length, 137);

  const people = state.listEntities('person');
  assert.equal(people.filter(person => person.fields.living === 'ja').length, 185);
  assert.equal(people.filter(person => person.fields.living === 'nej').length, 27);
  assert.equal(people.filter(person => person.fields.living === 'okänt').length, 2);
  const personIds = new Set(people.map(person => person.entity_id));
  const propertyIds = new Set(state.listEntities('property').map(property => property.entity_id));
  for (const link of state.listEntities('property-link')) {
    assert.ok(personIds.has(link.fields.person_id), `Okänd person i fastighetskoppling: ${link.entity_id}`);
    assert.ok(propertyIds.has(link.fields.property_id), `Okänd fastighet i fastighetskoppling: ${link.entity_id}`);
    assert.equal(link.fields.confirmed, true);
  }
});

await test('livs- och fastighetsfilter samt härledd ö fungerar tillsammans', () => {
  const state = materialize([
    ...operationsDocument.operations,
    ...metadataDocument.operations,
    ...approvedDocument.operations,
  ]);
  const properties = state.listEntities('property').map(entity => ({ id: entity.entity_id, ...entity.fields }));
  const propertyById = new Map(properties.map(property => [property.id, property]));
  const linksByPerson = new Map();
  for (const entity of state.listEntities('property-link')) {
    const link = { id: entity.entity_id, ...entity.fields };
    if (!linksByPerson.has(link.person_id)) linksByPerson.set(link.person_id, []);
    linksByPerson.get(link.person_id).push(link);
  }
  const people = state.listEntities('person').map(entity => {
    const person = { id: entity.entity_id, ...entity.fields };
    const propertyIds = (linksByPerson.get(person.id) || []).map(link => link.property_id);
    return {
      ...person,
      property_ids: propertyIds,
      property_islands: [...new Set(propertyIds.map(id => propertyById.get(id)?.island).filter(Boolean))],
    };
  });
  const relations = state.listEntities('relation').map(entity => ({ id: entity.entity_id, ...entity.fields }));
  const graph = buildGraph(people, relations);
  const islandConflicts = people.filter(person => {
    const propertyIslands = person.property_islands || [];
    return person.legacy_island && propertyIslands.length && !propertyIslands.includes(person.legacy_island);
  });
  assert.equal(islandConflicts.length, 0);
  const defaults = { generations: new Set(), includeInlaws: true, onlyUnlinked: false, yearOn: false };
  assert.equal(visiblePersonIds(people, graph, { ...defaults, living: 'nej' }).size, 27);
  assert.equal(visiblePersonIds(people, graph, { ...defaults, living: 'okänt' }).size, 2);
  const sampleLink = state.listEntities('property-link')[0];
  assert.ok(visiblePersonIds(people, graph, { ...defaults, property: sampleLink.fields.property_id }).has(sampleLink.fields.person_id));
  assert.equal(visiblePersonIds(people, graph, { ...defaults, property: '__none__' }).size, 77);
  assert.deepEqual(resolvedIslands({ property_islands: ['Svanö'], legacy_island: 'Ängsholmen' }), ['Svanö', 'Ängsholmen']);
  const propertyGroup = groupPeopleByProperty(people, properties).find(group => group.id === sampleLink.fields.property_id);
  assert.ok(propertyGroup.people.some(person => person.id === sampleLink.fields.person_id));
  assert.ok(propertyGroup.people.every(person => Array.isArray(person.property_ids)));
});

await test('fastighetsgrupper visar bara relationer mellan personer på samma fastighet', () => {
  const people = [
    { id: 'mamma', display_name: 'Mamma', property_ids: ['A'] },
    { id: 'partner', display_name: 'Partner', property_ids: ['A'] },
    { id: 'barn', display_name: 'Barn', property_ids: ['B'] },
  ];
  const relations = [
    { id: 'partnerband', kind: 'partner', from_person_id: 'mamma', to_person_id: 'partner' },
    { id: 'barnband', kind: 'foralder-barn', from_person_id: 'mamma', to_person_id: 'barn' },
  ];
  const propertyA = groupPeopleByProperty(people, [{ id: 'A' }, { id: 'B' }]).find((group) => group.id === 'A');
  const components = componentSets(propertyA.people, relations);
  assert.deepEqual([...components[0]].sort(), ['mamma', 'partner']);
  assert.equal(components.some((component) => component.has('barn')), false);
});

await test('landskapsmodellen tål saknade ändpunkter och hittar släktskapsvägar', () => {
  const people = archive.persons.map(person => ({ id: person.id, ...person.fields }));
  const relations = archive.relations.map(relation => ({ id: relation.id, ...relation.fields }));
  const graph = buildGraph(people, [...relations, { id: 'trasig', kind: 'partner', from_person_id: 'saknas', to_person_id: people[0].id }]);
  assert.equal(graph.byId.size, 214);
  assert.equal(shownName(undefined), 'Okänd person');
  assert.ok(groupPeople(people).length > 1);
  const sampleRelation = relations[0];
  const path = relationshipPath(sampleRelation.from_person_id, sampleRelation.to_person_id, graph);
  assert.equal(path.length, 1);
});

await test('familjenivåerna är begripliga utan ny sakdata', () => {
  const people = [
    { id: 'mor', display_name: 'Mor' },
    { id: 'far', display_name: 'Far' },
    { id: 'barn-a', display_name: 'Barn A' },
    { id: 'barn-b', display_name: 'Barn B' },
  ];
  const relations = [
    { id: 'r1', kind: 'partner', from_person_id: 'mor', to_person_id: 'far' },
    { id: 'r2', kind: 'foralder-barn', from_person_id: 'mor', to_person_id: 'barn-a' },
    { id: 'r3', kind: 'foralder-barn', from_person_id: 'far', to_person_id: 'barn-a' },
    { id: 'r4', kind: 'foralder-barn', from_person_id: 'mor', to_person_id: 'barn-b' },
  ];
  const graph = buildGraph(people, relations);
  const family = nearFamily('barn-a', graph);
  assert.deepEqual(family.parents.map((link) => link.id), ['far', 'mor']);
  assert.deepEqual(family.siblings.map((link) => link.id), ['barn-b']);
  assert.equal(family.siblings[0].relation.derived, true);
  assert.equal(familyCircleLabel('Hedström-klanen (Carl Gunder & Bibbi)'), 'Hedström');
});

await test('direkta syskon fungerar utan registrerade föräldrar', () => {
  const people = [
    { id: 'broder-a', display_name: 'Broder A' },
    { id: 'broder-b', display_name: 'Broder B' },
  ];
  const relations = [{ id: 'syskon', kind: 'syskon', from_person_id: 'broder-a', to_person_id: 'broder-b', user_confirmed: true }];
  const graph = buildGraph(people, relations);
  const family = nearFamily('broder-a', graph);
  assert.deepEqual(family.siblings.map(link => link.id), ['broder-b']);
  assert.equal(family.siblings[0].relation.derived, undefined);
  assert.equal(graph.partners.get('broder-a'), undefined);
});

await test('FAMILJ- och SLÄKT-koder är läsbara medan släktled är grupprelativa', () => {
  const people = [
    { id: 'a', display_name: 'Ankare A' },
    { id: 'b', display_name: 'Ankare B' },
    { id: 'barn', display_name: 'Barnet' },
    { id: 'barnbarn', display_name: 'Barnbarnet' },
  ];
  const relations = [
    { kind: 'syskon', from_person_id: 'a', to_person_id: 'b', user_confirmed: true },
    { kind: 'foralder-barn', from_person_id: 'a', to_person_id: 'barn', user_confirmed: true },
    { kind: 'foralder-barn', from_person_id: 'barn', to_person_id: 'barnbarn', user_confirmed: false },
  ];
  const familyUnits = [{ id: 'f1', reference_code: 'FAMILJ-001', name: 'Ankare A och B', anchor_person_ids: ['a', 'b'], membership_rule: 'anchors_and_children', confirmed: true }];
  const kinGroups = [{ id: 's1', reference_code: 'SLÄKT-001', name: 'Syskonen', anchor_person_ids: ['a', 'b'], membership_rule: 'anchors_and_descendants', confirmed: true }];
  const context = buildFamilyContext({ people, relations, familyUnits, kinGroups });
  assert.equal(nextReferenceCode(FAMILY_UNIT_TYPE, familyUnits), 'FAMILJ-002');
  assert.equal(nextReferenceCode(KIN_GROUP_TYPE, kinGroups), 'SLÄKT-002');
  assert.equal(readableReference(kinGroups[0]), 'SLÄKT-001--syskonen');
  assert.deepEqual(familyUnitMemberDetails(familyUnits[0], context).map(member => [member.person_id, member.generation]), [['a', 1], ['b', 1], ['barn', 2]]);
  const descendants = kinGroupMemberDetails(kinGroups[0], context);
  assert.deepEqual(descendants.map(member => [member.person_id, member.generation]), [['a', 1], ['b', 1], ['barn', 2], ['barnbarn', 3]]);
  assert.equal(descendants.find(member => member.person_id === 'barnbarn').confirmed, false);

  const hierarchyGroups = [
    { ...kinGroups[0], child_group_ids: ['s2'] },
    { id: 's2', reference_code: 'SLÄKT-002', name: 'Barnets gren', anchor_person_ids: ['barn'], membership_rule: 'anchors_and_descendants', confirmed: true },
  ];
  const hierarchyContext = buildFamilyContext({ people, relations, kinGroups: hierarchyGroups });
  const hierarchy = kinGroupMemberDetails(hierarchyGroups[0], hierarchyContext);
  assert.equal(hierarchy.find(member => member.person_id === 'barn').generation, 2);
  assert.equal(hierarchy.find(member => member.person_id === 'barnbarn').generation, 3);
});

await test('familjebildningar blandar inte barn från olika relationer', () => {
  const people = [
    { id: 'a', display_name: 'A' },
    { id: 'b', display_name: 'B' },
    { id: 'c', display_name: 'C' },
    { id: 'gemensamt', display_name: 'Gemensamt barn' },
    { id: 'tidigare', display_name: 'Barn från tidigare relation' },
  ];
  const relations = [
    { kind: 'foralder-barn', from_person_id: 'a', to_person_id: 'gemensamt', user_confirmed: true },
    { kind: 'foralder-barn', from_person_id: 'b', to_person_id: 'gemensamt', user_confirmed: true },
    { kind: 'foralder-barn', from_person_id: 'a', to_person_id: 'tidigare', user_confirmed: true },
    { kind: 'foralder-barn', from_person_id: 'c', to_person_id: 'tidigare', user_confirmed: true },
  ];
  const familyUnits = [{ id: 'familj-ab', reference_code: 'FAMILJ-001', name: 'A och B', anchor_person_ids: ['a', 'b'], membership_rule: 'anchors_and_shared_children', confirmed: true }];
  const context = buildFamilyContext({ people, relations, familyUnits });
  assert.deepEqual(familyUnitMemberDetails(familyUnits[0], context).map(member => member.person_id), ['a', 'b', 'gemensamt']);
});

await test('stabila grupper kan sökas via kod, äldre namn och medlemmar', () => {
  const people = [{ id: 'lotta', display_name: 'Lotta Svahn', family: 'Svahn' }];
  const kinGroups = [{ id: 'slakt', reference_code: 'SLÄKT-005', name: 'Inger–Bethge', legacy_labels: ['Svahn'], explicit_person_ids: ['lotta'], membership_rule: 'explicit' }];
  const context = buildFamilyContext({ people, kinGroups });
  assert.equal(searchFamilyTargets(context, 'svahn')[0].id, 'slakt');
  assert.equal(searchFamilyTargets(context, 'SLÄKT-005')[0].id, 'slakt');
  assert.equal(searchFamilyTargets(context, 'Lotta')[0].id, 'slakt');
});

await test('fältändringar från två enheter överlever och synkas åt båda håll', async () => {
  const remote = new MemoryRemoteTransport({ id: 'dropbox-test' });
  const a = await new Repository({ store: new MemoryStore(), deviceId: 'web-a', now: () => 1000 }).init();
  const b = await new Repository({ store: new MemoryStore(), deviceId: 'web-b', now: () => 1000 }).init();
  const syncA = new SyncEngine({ repository: a, transport: remote });
  const syncB = new SyncEngine({ repository: b, transport: remote });
  await a.setField('person', 'person-1', 'display_name', 'A');
  await b.setField('person', 'person-1', 'note', 'B');
  await syncA.syncOnce();
  await syncB.syncOnce();
  await syncA.syncOnce();
  assert.equal(a.getEntity('person', 'person-1').fields.note, 'B');
  assert.equal(b.getEntity('person', 'person-1').fields.display_name, 'A');
});

await test('en tombstone kan inte återupplivas av en vanlig senare redigering', async () => {
  let now = 2000;
  const repository = await new Repository({ store: new MemoryStore(), deviceId: 'web-delete', now: () => ++now }).init();
  await repository.setField('person', 'person-delete', 'display_name', 'Raderas');
  await repository.deleteEntity('person', 'person-delete');
  await repository.setField('person', 'person-delete', 'note', 'senare not');
  assert.equal(repository.getEntity('person', 'person-delete'), null);
  assert.equal(repository.getEntity('person', 'person-delete', { includeDeleted: true }).deleted, true);
  await repository.restoreEntity('person', 'person-delete');
  assert.equal(repository.getEntity('person', 'person-delete').fields.note, 'senare not');
});

await test('publiceringsbygget innehåller bara det datafria appskalet', async () => {
  const build = spawnSync(process.execPath, ['verktyg/bygg-publicering.mjs'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const walk = async directory => {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) files.push(...await walk(path));
      else files.push(path);
    }
    return files;
  };
  const files = await walk(resolve(ROOT, '../../matrikel'));
  const relativeFiles = files.map(file => file.slice(resolve(ROOT, '../../matrikel').length + 1));
  assert.equal(relativeFiles.some(file => /(?:initial-|privat|slaktled_tillagg|\.csv$|\.json$)/.test(file)), false);
  const bundle = (await Promise.all(files.map(file => readFile(file, 'utf8').catch(() => '')))).join('\n');
  const leakedNames = archive.persons.map(person => person.fields.display_name).filter(name => bundle.includes(name));
  assert.deepEqual(leakedNames, []);
});

await test('Dropbox-namnrymden placerar Matrikeln i matrikel/ops', async () => {
  assert.equal(batchPath('web-enhet', 1, 2), '/matrikel/ops/web-enhet-0000000001-0000000002.json');
  const calls = [];
  const transport = new DropboxTransport({
    accessToken: 'test-token',
    opsRoot: '/matrikel/ops',
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ entries: [], cursor: 'cursor-1', has_more: false }) };
    },
  });
  await transport.listChanges(null, { createRoot: false });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/files/list_folder'));
  assert.equal(calls[0].body.path, '/matrikel/ops');
  const appSource = await readFile(resolve(ROOT, 'src/app.js'), 'utf8');
  assert.ok(appSource.includes("id: 'dropbox-matrikel-v2'"));
  assert.ok(appSource.includes("opsRoot: MATRIKEL_OPS_ROOT"));
  assert.ok(appSource.includes("opsRoot: LEGACY_OPS_ROOT"));
});

await test('Dropbox-knappen synkar befintlig anslutning och tom master rapporteras ärligt', async () => {
  const appSource = await readFile(resolve(ROOT, 'src/app.js'), 'utf8');
  assert.ok(appSource.includes("connectButton.addEventListener('click', () => connectOrSyncDropbox()"));
  assert.ok(appSource.includes("connectButton.textContent = 'Synka Dropbox'"));
  assert.ok(appSource.includes('Dropbox ansluten · ingen privat master hittades ännu'));
  assert.equal(appSource.includes("connectButton.addEventListener('click', connectDropbox)"), false);
});

await test('Matrikeln startar och sparar lokalt utan nät efter första anslutningen', async () => {
  const appSource = await readFile(resolve(ROOT, 'src/app.js'), 'utf8');
  const serviceWorker = await readFile(resolve(ROOT, 'sw.js'), 'utf8');
  assert.ok(appSource.includes("navigator.onLine === false"));
  assert.ok(appSource.includes("Offline · lokalt sparat · synkas automatiskt"));
  assert.ok(appSource.includes('const serviceWorkerPromise = registerServiceWorker()'));
  assert.ok(serviceWorker.includes("return cached || network"));
  assert.ok(serviceWorker.includes("cache: 'reload'"));
  assert.ok(serviceWorker.includes("self.location.pathname.includes('/apps/matrikel/')"));
  assert.ok(serviceWorker.includes("'../../packages/core/family-context.js'"));
});

await test('den visuella huvudvyn och direkta redigeringen finns i appskalet', async () => {
  const appSource = await readFile(resolve(ROOT, 'src/app.js'), 'utf8');
  const html = await readFile(resolve(ROOT, 'index.html'), 'utf8');
  assert.ok(html.includes('<h1>Matrikel</h1>'));
  assert.ok(html.includes('Hur är de släkt?'));
  assert.ok(html.includes('Markera relationsluckor'));
  assert.ok(html.includes('id="living-filter"'));
  assert.ok(html.includes('id="property-filter"'));
  assert.ok(html.includes('data-view-mode="kinship"'));
  assert.ok(html.includes('data-view-mode="property"'));
  assert.ok(html.includes('data-view-mode="register"'));
  assert.ok(html.includes('data-view-mode="groups"'));
  assert.ok(html.includes('Familjer &amp; släkter'));
  assert.ok(html.includes('<b>FAMILJ</b>'));
  assert.ok(html.includes('<b>SLÄKT</b>'));
  assert.ok(appSource.includes('Nära familj'));
  assert.ok(appSource.includes('renderGroupView'));
  assert.ok(appSource.includes('familyUnitMemberDetails'));
  assert.ok(appSource.includes('kinGroupMemberDetails'));
  assert.ok(appSource.includes("repository.setField('person'"));
  assert.ok(appSource.includes("repository.deleteEntities"));
  assert.ok(appSource.includes('renderLandscape'));
  assert.ok(appSource.includes('renderPropertyLandscape'));
  assert.ok(appSource.includes('componentSets(group.people, currentRelations)'));
  assert.ok(appSource.includes('nearFamily(person.id, graph)'));
  assert.ok(appSource.includes('addPropertyLink'));
  assert.ok(appSource.includes('Okänd livsstatus'));
  assert.ok(appSource.includes('Ö och fastighet säger olika'));
  assert.ok(appSource.includes('Ö men ingen fastighet'));
  assert.equal(appSource.includes('showSaveFilePicker'), false);
});

console.log(`\n${passed} säkerhets- och datakontrakt godkända.`);
