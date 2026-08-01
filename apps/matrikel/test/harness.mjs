import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MemoryRemoteTransport,
  MemoryStore,
  Repository,
  SyncEngine,
  materialize
} from '../src/data-layer.js';
import { propertyLinkEntityId, relationEntityId, validateArchive } from '../src/domain/slakt-schema.js';
import {
  buildGraph,
  componentSets,
  groupPeople,
  groupPeopleByProperty,
  relationshipPath,
  resolvedIslands,
  shownName,
  visiblePersonIds,
} from '../src/landscape-model.js';

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
});

await test('den visuella huvudvyn och direkta redigeringen finns i appskalet', async () => {
  const appSource = await readFile(resolve(ROOT, 'src/app.js'), 'utf8');
  const html = await readFile(resolve(ROOT, 'index.html'), 'utf8');
  assert.ok(html.includes('<h1>Matrikel</h1>'));
  assert.ok(html.includes('Hur är de släkt?'));
  assert.ok(html.includes('Markera relationsluckor'));
  assert.ok(html.includes('id="living-filter"'));
  assert.ok(html.includes('id="property-filter"'));
  assert.ok(html.includes('id="group-toggle"'));
  assert.ok(appSource.includes("repository.setField('person'"));
  assert.ok(appSource.includes("repository.deleteEntities"));
  assert.ok(appSource.includes('renderLandscape'));
  assert.ok(appSource.includes('renderPropertyLandscape'));
  assert.ok(appSource.includes('componentSets(group.people, currentRelations)'));
  assert.ok(appSource.includes('addPropertyLink'));
  assert.ok(appSource.includes('Okänd livsstatus'));
  assert.ok(appSource.includes('Ö och fastighet säger olika'));
  assert.ok(appSource.includes('Ö men ingen fastighet'));
  assert.equal(appSource.includes('showSaveFilePicker'), false);
});

console.log(`\n${passed} säkerhets- och datakontrakt godkända.`);
