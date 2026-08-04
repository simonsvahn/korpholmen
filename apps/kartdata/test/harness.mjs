import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { materialize, validateOperation } from '../../../packages/core/data-layer.js';
import { OBJECT_CLASSES, islandDeletionRefs, objectTypeLabel, stableEntityId } from '../src/model.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '../..');
const PRIVATE = resolve(ROOT, 'privat/migrering-2026-08-04-ren-v2');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
let passed = 0;
async function test(name, action) { try { await action(); passed += 1; console.log(`✓ ${name}`); } catch (error) { console.error(`✗ ${name}`); throw error; } }

const document = await readJson(resolve(PRIVATE, 'clean-v2-ops.json'));
const preview = await readJson(resolve(PRIVATE, 'preview.json'));
const manifest = await readJson(resolve(PRIVATE, 'manifest.json'));
const state = materialize(document.operations);
const rows = type => state.listEntities(type).map(entity => ({ id: entity.entity_id, ...entity.fields }));

await test('alla JavaScript-filer har giltig syntax', () => {
  for (const file of ['src/app.js', 'src/model.js', 'src/config.js', 'sw.js', 'verktyg/bygg-ren-v2.mjs', 'verktyg/skriv-dropbox-ren-v2.mjs', 'verktyg/bygg-aktuella-agare.mjs', 'verktyg/skriv-dropbox-aktuella-agare.mjs', 'verktyg/bygg-lokal-bootstrap.mjs', 'verktyg/bygg-publicering.mjs']) {
    const result = spawnSync(process.execPath, ['--check', file], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});

await test('v2-migrationen är giltig och har låst identitet', () => {
  assert.equal(document.migration_id, '2026-08-04-kartdata-clean-v2');
  document.operations.forEach(validateOperation);
  assert.equal(new Set(document.operations.map(operation => operation.op_id)).size, document.operations.length);
  assert.deepEqual(document.counts, manifest.counts);
});

await test('den aktiva datan har 158 poster och inga förbjudna objekttyper', () => {
  const entries = rows('data-entry');
  assert.equal(entries.length, 158);
  assert.ok(entries.every(entry => OBJECT_CLASSES.includes(entry.object_type)));
  assert.deepEqual(OBJECT_CLASSES, ['byggnad', 'plats', 'namnform', 'ägaretikett']);
  for (const removedId of ['K105', 'K161', 'K32']) assert.ok(!entries.some(entry => entry.id === removedId), removedId);
});

await test('previewfilen saknar källfält, arbetsförslag och anteckningar', () => {
  const forbidden = new Set(['source', 'source_ids', 'source_id', 'source_row', 'source_name', 'source_note', 'note', 'prior_type_decision', 'prior_correction', 'review_note', 'review_basis']);
  const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) { assert.ok(!forbidden.has(key), `förbjudet fält: ${key}`); visit(child); }
  };
  visit(preview);
});

await test('de tio manuellt kvarvarande öarna är v2-mastern', () => {
  assert.equal(preview.islands.length, 10);
  assert.deepEqual(preview.islands.map(island => island.name).sort((a, b) => a.localeCompare(b, 'sv')), ['Blidö', 'Korpholmen', 'Lilla Korpholmen', 'Lilla Sviholmen', 'Lövskär', 'Stugholmen', 'Svanö', 'Sviholmen', 'Yxlan', 'Ängsholmen']);
  assert.equal(rows('place').length, 10);
});

await test('139 poster har säker strukturerad ökoppling och 19 lämnas okopplade', () => {
  const links = rows('data-entry-island-link'); const islandIds = new Set(preview.islands.map(island => island.id)); const entryIds = new Set(preview.entries.map(entry => entry.id));
  assert.equal(links.length, 139);
  assert.equal(preview.entries.filter(entry => !entry.island_id).length, 19);
  assert.ok(links.every(link => islandIds.has(link.island_id) && entryIds.has(link.entry_id)));
});

await test('fastighetskopplingarna pekar bara på de 31 validerade referenserna', () => {
  const links = rows('data-entry-property-link'); const refs = new Set(rows('property-ref').map(ref => ref.external_id)); const entries = new Set(rows('data-entry').map(entry => entry.id));
  assert.equal(links.length, 106); assert.equal(refs.size, 31);
  assert.ok(links.every(link => entries.has(link.entry_id) && refs.has(link.property_id)));
});

await test('den äldre ägarreferensmigreringen är bevarad som fullständig fallback', () => {
  assert.equal(rows('property-owner-link').length, 52);
  assert.equal(rows('person-ref').length, 28);
  assert.equal(rows('external-party').length, 23);
  assert.ok(rows('person-ref').some(ref => ref.external_id === 'olaböving'));
  assert.ok(rows('person-ref').some(ref => ref.external_id === 'månsböving'));
  assert.ok(!rows('property-owner-link').some(link => link.owner_id === 'kajböving' || link.owner_id === 'party-kaj-gunder-boving'));
});

await test('varje ägarlänk kommer från nulägesbedömningen och pekar på en existerande referens', () => {
  const properties = new Set(rows('property-ref').map(ref => ref.external_id));
  const people = new Set(rows('person-ref').map(ref => ref.external_id));
  const parties = new Set(rows('external-party').map(ref => ref.external_id));
  for (const link of rows('property-owner-link')) {
    assert.ok(properties.has(link.property_id)); assert.equal(link.basis, 'best-known-current'); assert.match(link.reviewed_on, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(link.owner_type === 'person-ref' ? people.has(link.owner_id) : parties.has(link.owner_id));
  }
});

await test('den redan manuellt rättade Lilla Kryllbo-posten följer med utan gammal undertyp', () => {
  const entry = preview.entries.find(item => item.id === 'K96');
  assert.deepEqual(entry, { id: 'K96', name: 'Lilla Kryllbo', object_type: 'byggnad', subtype: null, review_status: 'rättad', island_id: 'sviholmen', property_ids: ['Alsvik 3:367'] });
});

await test('modellens typetiketter är rena och ö-ID:n stabila', () => {
  assert.equal(objectTypeLabel('byggnad', 'Gäststuga'), 'Byggnad: Gäststuga');
  assert.equal(objectTypeLabel('plats', null), 'Plats');
  assert.equal(stableEntityId('Stora Sviholmen'), 'stora-sviholmen');
});

await test('borttagning av en ö tar även bort dess ökopplingar men inte dataposterna', () => {
  const refs = islandDeletionRefs({ id: 'korpholmen', names: [{ id: 'n1', target_type: 'place', target_id: 'korpholmen' }], islandLinks: [{ id: 'l1', entry_id: 'K1', island_id: 'korpholmen' }], relations: [], propertyLinks: [] });
  assert.deepEqual(refs, [{ entityType: 'place', entityId: 'korpholmen' }, { entityType: 'name-record', entityId: 'n1' }, { entityType: 'data-entry-island-link', entityId: 'l1' }]);
  assert.ok(!refs.some(ref => ref.entityType === 'data-entry'));
});

await test('appen visar bara Data och de strukturerade sakfälten', async () => {
  const app = await readFile(resolve(ROOT, 'src/app.js'), 'utf8'); const html = await readFile(resolve(ROOT, 'index.html'), 'utf8');
  for (const forbidden of ['Ordagrann källuppgift', 'Tidigare arbetsförslag', 'Godkänt visningsnamn', 'Granskningsnot', 'Käll-ID:n']) assert.ok(!app.includes(forbidden), forbidden);
  for (const required of ["recordList('data-entry')", "recordList('data-entry-island-link')", "recordList('data-entry-property-link')", 'resolveCurrentOwners(propertyId, fastigheterMaster, matrikelMaster)', '<h3>Data</h3>', '>Namn<input', '>Ö<select']) assert.ok(app.includes(required), required);
  assert.ok(app.includes("new ReadOnlyMaster({ store, cacheKey: 'fastigheter' })"));
  assert.ok(app.includes("new ReadOnlyMaster({ store, cacheKey: 'matrikel' })"));
  assert.ok(app.includes("opsRoot: '/fastigheter/ops', readOnly: true"));
  assert.ok(app.includes("opsRoot: '/matrikel/ops', readOnly: true"));
  assert.ok(!app.includes('bootstrapCurrentOwners'));
  assert.ok(!html.includes('value="kartsymbol"')); assert.ok(!html.includes('value="annat"')); assert.ok(html.includes('Exportera data'));
});

await test('fastigheter väljs en i taget utan en lång krysslista', async () => {
  const app = await readFile(resolve(ROOT, 'src/app.js'), 'utf8'); const css = await readFile(resolve(ROOT, 'styles.css'), 'utf8');
  assert.ok(app.includes('data-property-picker'));
  assert.ok(app.includes('data-action="add-property"'));
  assert.ok(app.includes('data-action="remove-property"'));
  assert.ok(app.includes('type="hidden" name="property_ids"'));
  assert.ok(!app.includes('propertyChecklist'));
  assert.ok(!css.includes('.property-checklist'));
});

await test('exportkoden använder v2-format och utesluter arkivposterna', async () => {
  const app = await readFile(resolve(ROOT, 'src/app.js'), 'utf8');
  assert.ok(app.includes("format: 'korpholmen-kartdata-v2'"));
  assert.ok(!app.includes("recordList('map-entry')"));
  assert.ok(!app.includes('source_current_owner'));
  assert.ok(!app.includes('prior_correction'));
  assert.ok(app.includes('read_projection'));
  assert.ok(!app.includes('person_refs:'));
  assert.ok(!app.includes('external_parties:'));
});

await test('publiceringsbygget är datafritt och har den rena appkoden', async () => {
  const result = spawnSync(process.execPath, ['verktyg/bygg-publicering.mjs'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const publishedApp = await readFile(resolve(REPO, 'kartdata/src/app.js'), 'utf8'); const publishedHtml = await readFile(resolve(REPO, 'kartdata/index.html'), 'utf8');
  assert.ok(publishedApp.includes("../core/data-layer.js")); assert.ok(publishedApp.includes("recordList('data-entry')")); assert.ok(!publishedHtml.includes('Lilla Kryllbo')); assert.ok(!publishedApp.includes('Korpholmens Tomtägareförening'));
});

await test('arkitekturen dokumenterar v2-gränsen och skrivskyddade masterläsningar', async () => {
  const model = await readFile(resolve(ROOT, 'DATAMODELL.md'), 'utf8'); const architecture = await readFile(resolve(REPO, 'ARKITEKTUR.md'), 'utf8');
  assert.match(model, /äldre importen.*v1-arkiv/s); assert.match(model, /skrivskyddat/); assert.match(model, /current-owner-assessment/); assert.match(architecture, /Kartdata v2 använder `data-entry`/); assert.match(architecture, /Ett namnbyte görs alltså en gång i Matrikel/);
});

console.log(`\n${passed} Kartdata-v2-kontrakt godkända.`);
