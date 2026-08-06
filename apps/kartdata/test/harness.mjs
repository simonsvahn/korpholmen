import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { materialize, validateOperation } from '../../../packages/core/data-layer.js';
import { OBJECT_CLASSES, islandDeletionRefs, nextEntryId, objectTypeLabel, stableEntityId } from '../src/model.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '../..');
const PRIVATE = resolve(ROOT, 'privat/migrering-2026-08-06-fastighetsvisning');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
let passed = 0;
async function test(name, action) { try { await action(); passed += 1; console.log(`✓ ${name}`); } catch (error) { console.error(`✗ ${name}`); throw error; } }

const document = await readJson(resolve(PRIVATE, 'clean-v2-ops.json'));
const verificationBase = await readJson(resolve(PRIVATE, 'verification-base-ops.json'));
const preview = await readJson(resolve(PRIVATE, 'preview.json'));
const manifest = await readJson(resolve(PRIVATE, 'manifest.json'));
const state = materialize([...verificationBase.operations, ...document.operations]);
const rows = type => state.listEntities(type).map(entity => ({ id: entity.entity_id, ...entity.fields }));

await test('alla JavaScript-filer har giltig syntax', async () => {
  for (const file of ['src/app.js', 'src/model.js', 'src/property-selection.js', 'src/config.js', 'sw.js', 'verktyg/bygg-ren-v2.mjs', 'verktyg/skriv-dropbox-ren-v2.mjs', 'verktyg/bygg-aktuella-agare.mjs', 'verktyg/skriv-dropbox-aktuella-agare.mjs', 'verktyg/bygg-lokal-bootstrap.mjs', 'verktyg/bygg-publicering.mjs']) {
    const result = spawnSync(process.execPath, ['--check', file], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
  assert.match(await readFile(resolve(ROOT, 'src/config.js'), 'utf8'), /export const CURRENT_OWNER_BOOTSTRAP_URL/, 'konfigurationen ska vara bakåtkompatibel med ett cachat äldre appskal');
});

await test('v2-migrationen är giltig och har låst identitet', () => {
  assert.equal(document.migration_id, '2026-08-06-kartdata-property-owner-display');
  document.operations.forEach(validateOperation);
  assert.equal(new Set(document.operations.map(operation => operation.op_id)).size, document.operations.length);
  assert.deepEqual(document.counts, manifest.counts);
});

await test('migreringen rör bara ägaretiketter och deras aktuella ägarprojektion', () => {
  const tombstones = document.operations.filter(operation => operation.field === '__deleted');
  assert.deepEqual(Object.fromEntries(['data-entry', 'data-entry-island-link', 'data-entry-property-link'].map(type => [type, tombstones.filter(operation => operation.entity_type === type).length])), {
    'data-entry': 32,
    'data-entry-island-link': 32,
    'data-entry-property-link': 31,
  });
  assert.ok(tombstones.every(operation => ['data-entry', 'data-entry-island-link', 'data-entry-property-link', 'property-owner-link', 'person-ref', 'external-party'].includes(operation.entity_type)));
});

await test('den aktiva datan har 126 sakposter och inga ägaretiketter', () => {
  const entries = rows('data-entry');
  assert.equal(entries.length, 126);
  assert.ok(entries.every(entry => OBJECT_CLASSES.includes(entry.object_type)));
  assert.deepEqual(OBJECT_CLASSES, ['byggnad', 'plats', 'namnform']);
  assert.ok(!entries.some(entry => entry.object_type === 'ägaretikett'));
  for (const removedId of ['K105', 'K161', 'K32']) assert.ok(!entries.some(entry => entry.id === removedId), removedId);
});

await test('de 32 äldre ägaretiketterna finns bara kvar i råarkivet', async () => {
  const archive = await readJson(resolve(ROOT, 'privat/kallkopior/kartdata-source.json'));
  const labels = archive.rows.filter(row => /ägaretikett/i.test(row.raw?.source_name_type || ''));
  assert.equal(labels.length, 32);
  assert.equal(preview.entries.filter(entry => entry.object_type === 'ägaretikett').length, 0);
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

await test('107 poster har säker strukturerad ökoppling och 19 lämnas okopplade', () => {
  const links = rows('data-entry-island-link'); const islandIds = new Set(preview.islands.map(island => island.id)); const entryIds = new Set(preview.entries.map(entry => entry.id));
  assert.equal(links.length, 107);
  assert.equal(preview.entries.filter(entry => !entry.island_id).length, 19);
  assert.ok(links.every(link => islandIds.has(link.island_id) && entryIds.has(link.entry_id)));
});

await test('fastighetskopplingarna pekar bara på de 27 använda referenserna', () => {
  const links = rows('data-entry-property-link'); const refs = new Set(rows('property-ref').map(ref => ref.external_id)); const entries = new Set(rows('data-entry').map(entry => entry.id));
  assert.equal(links.length, 75); assert.equal(preview.properties.length, 27);
  assert.ok(links.every(link => entries.has(link.entry_id) && refs.has(link.property_id)));
});

await test('den äldre ägarreferensmigreringen är bevarad som fullständig fallback', () => {
  assert.equal(rows('property-owner-link').length, 46);
  assert.equal(rows('person-ref').length, 45);
  assert.equal(rows('external-party').length, 1);
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
  assert.equal(nextEntryId(['K1', 'K161', { entity_id: 'K200' }, 'annat']), 'K201');
});

await test('nya kartobjekt får ett stabilt ID och skapas atomiskt med sina länkar', async () => {
  const app = await readFile(resolve(ROOT, 'src/app.js'), 'utf8'); const html = await readFile(resolve(ROOT, 'index.html'), 'utf8');
  assert.ok(html.includes('id="new-entry"'));
  assert.ok(html.includes('id="new-entry" type="button" disabled'));
  assert.ok(html.includes('Nytt kartobjekt'));
  assert.ok(app.includes('openNewEntryDrawer'));
  assert.ok(app.includes('newEntryButton.disabled = false'));
  assert.ok(app.includes("repository.listEntities('data-entry', { includeDeleted: true })"));
  assert.ok(app.includes('await repository.replaceEntities(newEntities)'));
  assert.ok(app.includes("`${fields.name} ${isNew ? 'skapad' : 'uppdaterad'}`"));
});

await test('Kartdata och de två läsmastrarna synkas parallellt', async () => {
  const app = await readFile(resolve(ROOT, 'src/app.js'), 'utf8');
  assert.ok(app.includes('const kartdataSync = new SyncEngine'));
  assert.ok(app.includes('const [result] = await Promise.all(['));
  assert.ok(app.includes('kartdataSync,'));
});

await test('fastigheter visas med nuvarande ägares unika efternamn', () => {
  assert.equal(preview.properties.find(property => property.id === 'Alsvik 3:79')?.display_name, 'Alsvik 3:79 (Bethge)');
  assert.equal(preview.properties.find(property => property.id === 'Alsvik 3:26')?.display_name, 'Alsvik 3:26 (Ilveus, Lindblom och Granath)');
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
  assert.ok(!html.includes('value="ägaretikett"'));
  assert.ok(app.includes('propertyDisplayName'));
});

await test('fastigheter väljs en i taget utan en lång krysslista', async () => {
  const app = await readFile(resolve(ROOT, 'src/app.js'), 'utf8'); const css = await readFile(resolve(ROOT, 'styles.css'), 'utf8');
  assert.ok(app.includes('data-property-picker'));
  assert.ok(app.includes('data-action="add-property"'));
  assert.ok(app.includes('data-action="remove-property"'));
  assert.ok(app.includes('type="hidden" name="property_ids"'));
  assert.ok(app.includes('Okänd fastighet'));
  assert.ok(app.includes('validatePropertySelection'));
  assert.ok(!app.includes('propertyChecklist'));
  assert.ok(!css.includes('.property-checklist'));
});

await test('exportkoden använder v2-format och utesluter arkivposterna', async () => {
  const app = await readFile(resolve(ROOT, 'src/app.js'), 'utf8');
  assert.ok(app.includes('repository.upsertFields(fields)'));
  assert.ok(app.includes("repository.upsertFields(Object.entries({ preferred_name:"));
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
