import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { islandDeletionRefs, nextEntryId, objectTypeLabel, stableEntityId } from '../src/model.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '../..');
let passed = 0;
async function test(name, action) { try { await action(); passed += 1; console.log(`✓ ${name}`); } catch (error) { console.error(`✗ ${name}`); throw error; } }

await test('alla aktiva JavaScript-filer har giltig syntax', async () => {
  for (const file of ['src/app.js', 'src/kart-active-v2.js', 'src/model.js', 'src/property-selection.js', 'src/config.js', 'sw.js', 'verktyg/bygg-publicering.mjs']) {
    const result = spawnSync(process.execPath, ['--check', file], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});

await test('Kartdata läser enbart de aktiva V2-mastrarna', async () => {
  const app = await readFile(resolve(ROOT, 'src/app.js'), 'utf8');
  const reader = await readFile(resolve(ROOT, 'src/kart-active-v2.js'), 'utf8');
  assert.match(app, /kartV2Mode = true/);
  assert.match(reader, /\/kartdata-generation2\/active\.json/);
  assert.match(reader, /\/fastigheter-generation2\/active\.json/);
  assert.match(reader, /requiredCollections: \['places', 'place_names', 'entries', 'entry_names'\]/);
  assert.match(reader, /requiredCollections: \['properties'\]/);
});

await test('fastighet, plats och namnform visas utan att skapa nya fakta', async () => {
  const reader = await readFile(resolve(ROOT, 'src/kart-active-v2.js'), 'utf8');
  assert.match(reader, /property_refs/);
  assert.match(reader, /place_refs/);
  assert.match(reader, /entry_names/);
  assert.match(reader, /place_names/);
  assert.doesNotMatch(reader, /putBatch|putBytes|replaceEntities|upsertFields/);
});

await test('tabellen kan sorteras på varje synlig sakdatakolumn', async () => {
  const reader = await readFile(resolve(ROOT, 'src/kart-active-v2.js'), 'utf8');
  for (const key of ['id', 'name', 'type', 'subtype', 'place', 'property', 'aliases']) assert.ok(reader.includes(`sortButton('${key}'`), key);
  assert.match(reader, /this\.sortDirection \*= -1/);
});

await test('modellens typetiketter och stabila ID-hjälpare finns kvar', () => {
  assert.equal(objectTypeLabel('byggnad', 'Gäststuga'), 'Byggnad: Gäststuga');
  assert.equal(stableEntityId('Stora Sviholmen'), 'stora-sviholmen');
  assert.equal(nextEntryId(['K1', 'K161', { entity_id: 'K200' }, 'annat']), 'K201');
  const refs = islandDeletionRefs({ id: 'korpholmen', names: [{ id: 'n1', target_type: 'place', target_id: 'korpholmen' }], islandLinks: [{ id: 'l1', entry_id: 'K1', island_id: 'korpholmen' }], relations: [], propertyLinks: [] });
  assert.deepEqual(refs, [{ entityType: 'place', entityId: 'korpholmen' }, { entityType: 'name-record', entityId: 'n1' }, { entityType: 'data-entry-island-link', entityId: 'l1' }]);
});

await test('publiceringsbygget är datafritt och innehåller V2-läsaren', async () => {
  const result = spawnSync(process.execPath, ['verktyg/bygg-publicering.mjs'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const publishedApp = await readFile(resolve(REPO, 'kartdata/src/app.js'), 'utf8');
  const publishedReader = await readFile(resolve(REPO, 'kartdata/src/kart-active-v2.js'), 'utf8');
  assert.match(publishedApp, /kartV2Mode = true/);
  assert.match(publishedReader, /\.\.\/core\/active-app-bundle\.js/);
  assert.doesNotMatch(await readFile(resolve(REPO, 'kartdata/index.html'), 'utf8'), /Camnerts udde|Lotsstugan/);
});

console.log(`\n${passed} Kartdata-V2-kontrakt godkända.`);
