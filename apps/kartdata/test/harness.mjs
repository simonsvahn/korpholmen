import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { materialize, validateOperation } from '../../../packages/core/data-layer.js';
import { effectiveEntry, objectTypeLabel, proposedReview, propertyIdsFromText, splitList, stableEntityId } from '../src/model.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '../..');
const PRIVATE = resolve(ROOT, 'privat/migrering-2026-08-03');
const SOURCE_PATH = resolve(ROOT, 'privat/kallkopior/kartdata-source.json');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
let passed = 0;
async function test(name, action) { try { await action(); passed += 1; console.log(`✓ ${name}`); } catch (error) { console.error(`✗ ${name}`); throw error; } }

await test('byggaren skapar startmastern reproducerbart', () => {
  const result = spawnSync(process.execPath, ['verktyg/bygg-startmaster.mjs'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /161 ogranskade källrader/);
});

const source = await readJson(SOURCE_PATH);
const document = await readJson(resolve(PRIVATE, 'initial-ops.json'));
const structureDocument = await readJson(resolve(PRIVATE, 'structure-ops.json'));
const placeNameDocument = await readJson(resolve(PRIVATE, 'place-names-ops.json'));
const state = materialize(document.operations);
const combinedState = materialize([...document.operations, ...placeNameDocument.operations]);
const entries = new Map(state.listEntities('map-entry').map(entity => [entity.entity_id, { id: entity.entity_id, ...entity.fields }]));
const places = new Map(combinedState.listEntities('place').map(entity => [entity.entity_id, { id: entity.entity_id, ...entity.fields }]));

await test('alla JavaScript-filer har giltig syntax', () => {
  for (const file of ['src/app.js', 'src/model.js', 'src/config.js', 'sw.js', 'verktyg/bygg-startmaster.mjs', 'verktyg/bygg-publicering.mjs', 'verktyg/skriv-dropbox-startmaster.mjs']) {
    const result = spawnSync(process.execPath, ['--check', file], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});

await test('källkopian har exakt 161 unika rader och rätt arbetsbokshash', () => {
  assert.equal(source.rows.length, 161);
  assert.equal(new Set(source.rows.map(row => row.id)).size, 161);
  assert.equal(source.source.source_sha256, '499330cbfcfca55eaa65d32c169a6c4b262f71cd5e4d6f9b04ff153ca0ea459b');
  assert.deepEqual(source.source.columns, ['Nr', 'Ö', 'Fastighet', 'Kartetikett', 'Dagens ägare', 'Namn', 'Namntyp (kartan)', 'Källa', 'Anteckning', 'Typ (ditt beslut)', 'Kommentar/rättelse']);
});

await test('samtliga startoperationer är giltiga och materialiserar 161 ogranskade poster', () => {
  document.operations.forEach(validateOperation);
  structureDocument.operations.forEach(validateOperation);
  placeNameDocument.operations.forEach(validateOperation);
  assert.equal(entries.size, 161);
  assert.ok([...entries.values()].every(entry => entry.review_status === 'ogranskad'));
  assert.equal(state.listEntities('source').length, 1);
});

await test('östrukturen har stabila plats-, namn- och relationsobjekt utan att förgranska kartposter', () => {
  assert.equal(places.size, 19);
  assert.equal(combinedState.listEntities('name-record').length, 57);
  assert.equal(combinedState.listEntities('place-relation').length, 2);
  assert.equal(places.get('korpholmen').preferred_name, 'Korpholmen');
  assert.equal(places.get('sviholmen').preferred_name, 'Sviholmen');
  assert.equal(places.get('sahlskar').subtype, 'halvö/tomt');
  assert.equal(combinedState.getEntity('place-relation', 'part-of:place:sahlskar:korpholmen').fields.parent_place_id, 'korpholmen');
  assert.equal(combinedState.getEntity('place-relation', 'seed-part-of:place:lill-yxlan:svano').fields.parent_place_id, 'svano');
  assert.equal(Math.min(...structureDocument.operations.map(operation => operation.seq)), document.operations.length - structureDocument.operations.length + 1);
});

await test('historiska namn är en separat additiv och källspårbar migration', () => {
  assert.equal(placeNameDocument.device_id, 'migration-kartdata-place-names-2026-08-03');
  assert.ok(placeNameDocument.operations.every(operation => operation.device_id !== document.device_id));
  assert.equal(placeNameDocument.counts.new_place, 8);
  assert.equal(placeNameDocument.counts.new_name_record, 44);
  const names = combinedState.listEntities('name-record').map(entity => ({ id: entity.entity_id, ...entity.fields }));
  const find = (targetId, name) => names.find(item => item.target_id === targetId && item.name === name);
  assert.deepEqual(find('korpholmen', 'Kårpholm').source_ids, ['KARTA-1639']);
  assert.equal(find('svano', 'Starrholmen').name_type, 'officiellt');
  assert.equal(find('lilla-sviholmen', 'Lillswedholmen').review_status, 'osäker');
  assert.equal(find('lovskar', 'Barnholmen').valid_to, '1916');
  assert.equal(places.get('korpholmens-ogrupp').review_status, 'osäker');
  assert.equal(places.get('bockholmen').review_status, 'osäker');
});

await test('alla elva arbetsbokskolumner bevaras cell för cell', () => {
  for (const row of source.rows) {
    const entry = entries.get(row.id); assert.ok(entry, row.id);
    assert.equal(entry.source_row, row.source_row, row.id);
    assert.equal(entry.source_document_id, 'BESLUT-KARTNAMN', row.id);
    for (const [field, value] of Object.entries(row.raw)) assert.deepEqual(entry[field], value, `${row.id}.${field}`);
  }
});

await test('tidigare beslut ligger bara som förslag och ändrar inte granskningsstatus', () => {
  const sahlskar = entries.get('K25');
  const proposal = proposedReview(sahlskar);
  assert.equal(sahlskar.review_status, 'ogranskad');
  assert.equal(proposal.review_object_class, 'plats');
  assert.equal(proposal.review_island, 'Korpholmen');
  assert.deepEqual(proposal.review_property_ids, ['Alsvik 3:377', 'Alsvik 3:27']);
  assert.equal(effectiveEntry(sahlskar).effective_status, 'ogranskad');
});

await test('rättelsekolumnens fastighet och rena namnförslag kan läsas utan att källan skrivs över', () => {
  assert.deepEqual(proposedReview(entries.get('K101')).review_property_ids, ['Alsvik 3:180']);
  assert.equal(proposedReview(entries.get('K16')).review_name, 'Miniori');
  assert.equal(entries.get('K16').source_name, 'Mini-ori');
  assert.deepEqual(propertyIdsFromText('Alsvik 3:377 och 3:27'), ['Alsvik 3:377', 'Alsvik 3:27']);
});

await test('plats och delområde är en gemensam objektklass medan byggnad hålls separat', async () => {
  const model = await readFile(resolve(ROOT, 'DATAMODELL.md'), 'utf8');
  assert.match(model, /`plats` och `delområde` är samma objektklass/);
  assert.match(model, /`byggnad` förblir en egen fysisk objektklass/);
  assert.equal(proposedReview(entries.get('K100')).review_object_class, 'plats');
  assert.equal(proposedReview(entries.get('K101')).review_object_class, 'byggnad');
});

await test('översiktskortens typetikett visar meningsfull undertyp', () => {
  assert.equal(objectTypeLabel('byggnad', 'Gäststuga'), 'Byggnad: Gäststuga');
  assert.equal(objectTypeLabel('plats', 'udde'), 'Plats: udde');
  assert.equal(objectTypeLabel('plats', 'Plats/ej byggnad'), 'Plats');
  assert.equal(objectTypeLabel('ägaretikett', 'Utgått/fel'), 'Ägaretikett');
  assert.equal(stableEntityId('Stora Sviholmen'), 'stora-sviholmen');
  assert.deepEqual(splitList('KARTA-2025, BIO-SIMON\nKARTA-2025'), ['KARTA-2025', 'BIO-SIMON']);
});

await test('appen skiljer källgranskning från platsmaster och har fyra arbetsvyer', async () => {
  const app = await readFile(resolve(ROOT, 'src/app.js'), 'utf8');
  const html = await readFile(resolve(ROOT, 'index.html'), 'utf8');
  assert.ok(!app.includes('data-source-field'));
  assert.ok(app.includes("entityType: 'map-entry'"));
  assert.ok(app.includes("'name-record'"));
  assert.ok(app.includes("'object-property-link'"));
  assert.ok(app.includes("'map-entry-link'"));
  assert.ok(app.includes("opsRoot: '/kartdata/ops'"));
  assert.ok(app.includes('PLACE_NAMES_META'));
  assert.ok(app.includes('Källspårbara namnposter'));
  assert.ok(html.includes('data-view="atlas"'));
  assert.ok(html.includes('data-view="structure"'));
  assert.ok(html.includes('data-view="queue"'));
  assert.ok(html.includes('data-view="table"'));
  assert.ok(html.includes('Exportera granskning'));
});

await test('tabellvyn är filtrerbar, expanderbar och redigerbar utan att dölja källfälten', async () => {
  const app = await readFile(resolve(ROOT, 'src/app.js'), 'utf8');
  const html = await readFile(resolve(ROOT, 'index.html'), 'utf8');
  for (const id of ['search', 'island-filter', 'class-filter', 'subtype-filter', 'property-filter', 'status-filter', 'sort-order']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(app.includes('data-table-toggle'));
  assert.ok(app.includes('Ordagrann källa'));
  assert.ok(app.includes('Tidigare kommentar/rättelse'));
  assert.ok(app.includes('Justera raden'));
});

await test('publiceringsbygget är datafritt och har egen offlinebar kärna', async () => {
  const result = spawnSync(process.execPath, ['verktyg/bygg-publicering.mjs'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const publishedApp = await readFile(resolve(REPO, 'kartdata/src/app.js'), 'utf8');
  const publishedCore = await readFile(resolve(REPO, 'kartdata/core/data-layer.js'), 'utf8');
  const publishedHtml = await readFile(resolve(REPO, 'kartdata/index.html'), 'utf8');
  assert.ok(publishedApp.includes("../core/data-layer.js"));
  assert.ok(publishedCore.includes("./storage/indexeddb.js"));
  assert.ok(!publishedHtml.includes('Sahlskär'));
  assert.ok(!publishedApp.includes('Hjärterum'));
  assert.ok(!publishedApp.includes('Kårpholm'));
});

await test('appnavet och den gemensamma byggkedjan känner till Kartdata', async () => {
  const hub = await readFile(resolve(REPO, 'index.html'), 'utf8');
  const rootPackage = JSON.parse(await readFile(resolve(REPO, 'package.json'), 'utf8'));
  assert.ok(hub.includes('./kartdata/'));
  assert.match(rootPackage.scripts.test, /apps\/kartdata/);
  assert.match(rootPackage.scripts.build, /apps\/kartdata/);
});

console.log(`\n${passed} Kartdata-kontrakt godkända.`);
