import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materialize } from '../../../packages/core/domain/materializer.js';
import { validateOperation } from '../../../packages/core/domain/operations.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_PATH = resolve(ROOT, 'privat/kallkopior/kartdata-source.json');
const PLACE_SEED_PATH = resolve(ROOT, 'privat/kallkopior/platsregister-seed.json');
const PLACE_NAME_SEED_PATH = resolve(ROOT, 'privat/kallkopior/platsnamn-seed.json');
const OUT = resolve(ROOT, 'privat/migrering-2026-08-03');
const DEVICE = 'migration-kartdata-2026-08-03';
const PLACE_NAME_DEVICE = 'migration-kartdata-place-names-2026-08-03';
const CLOCK_MS = 1785776400000;
const PLACE_NAME_CLOCK_MS = 1785776460000;
const MIGRATION_ID = '2026-08-03-kartdata-source-v1';
const PLACE_NAME_MIGRATION_ID = '2026-08-03-kartdata-place-names-v1';
const sha256 = value => createHash('sha256').update(value).digest('hex');

await mkdir(OUT, { recursive: true });
const sourceText = await readFile(SOURCE_PATH, 'utf8');
const source = JSON.parse(sourceText);
const placeSeedText = await readFile(PLACE_SEED_PATH, 'utf8');
const placeSeed = JSON.parse(placeSeedText);
const placeNameSeedText = await readFile(PLACE_NAME_SEED_PATH, 'utf8');
const placeNameSeed = JSON.parse(placeNameSeedText);

if (source.format !== 'korpholmen-kartdata-source-v1') throw new Error('Källkopian har fel format');
if (source.source?.sheet !== 'Kartans namn' || source.source?.range !== 'A1:K162') throw new Error('Oväntat blad eller intervall');
if (!Array.isArray(source.rows) || source.rows.length !== 161) throw new Error(`Förväntade 161 källrader, fick ${source.rows?.length}`);
const ids = new Set(source.rows.map(row => row.id));
if (ids.size !== source.rows.length || source.rows.some(row => !/^K\d+$/.test(row.id))) throw new Error('Källraderna har tomma eller dubbla ID:n');
if (placeSeed.format !== 'korpholmen-place-seed-v1' || !Array.isArray(placeSeed.places)) throw new Error('Platsregistrets startfil har fel format');
const placeIds = new Set(placeSeed.places.map(place => place.id));
if (placeIds.size !== placeSeed.places.length || placeSeed.places.some(place => !/^[a-z0-9-]+$/.test(place.id))) throw new Error('Platsregistrets startfil har tomma eller dubbla ID:n');
if (placeSeed.places.some(place => place.parent_place_id && !placeIds.has(place.parent_place_id))) throw new Error('En överordnad plats saknas i startfilen');
if (placeNameSeed.format !== 'korpholmen-place-name-seed-v1' || !Array.isArray(placeNameSeed.new_places) || !Array.isArray(placeNameSeed.names)) throw new Error('Namnunderlagets startfil har fel format');
const newPlaceIds = new Set(placeNameSeed.new_places.map(place => place.id));
if (newPlaceIds.size !== placeNameSeed.new_places.length || placeNameSeed.new_places.some(place => !/^[a-z0-9-]+$/.test(place.id) || placeIds.has(place.id))) throw new Error('Namnunderlaget har tomma eller dubbla nya plats-ID:n');
const allPlaceIds = new Set([...placeIds, ...newPlaceIds]);
if (placeNameSeed.new_places.some(place => place.parent_place_id && !allPlaceIds.has(place.parent_place_id))) throw new Error('En överordnad plats i namnunderlaget saknas');
const nameIds = new Set(placeNameSeed.names.map(name => name.id));
if (nameIds.size !== placeNameSeed.names.length || placeNameSeed.names.some(name => !/^[a-z0-9-]+$/.test(name.id) || !allPlaceIds.has(name.target_id))) throw new Error('Namnunderlaget har ogiltiga namn-ID:n eller mål');
if (placeNameSeed.names.some(name => !['officiellt', 'alias', 'historiskt'].includes(name.name_type) || !['ogranskad', 'osäker'].includes(name.review_status))) throw new Error('Namnunderlaget har en otillåten namn- eller granskningsstatus');

let seq = 0;
const operations = [];
function set(entityType, entityId, field, value) {
  seq += 1;
  const operation = {
    op_id: `${DEVICE}:${seq}`,
    device_id: DEVICE,
    seq,
    entity_type: entityType,
    entity_id: entityId,
    field,
    value,
    hlc: `${CLOCK_MS}-${String(seq).padStart(6, '0')}-${DEVICE}`,
    schema_version: 1,
  };
  validateOperation(operation);
  operations.push(operation);
}

set('root', 'kartdata', 'schema_version', 1);
set('root', 'kartdata', 'migration_id', MIGRATION_ID);
set('root', 'kartdata', 'source_id', source.source.id);
set('root', 'kartdata', 'source_json_sha256', sha256(sourceText));
set('root', 'kartdata', 'review_principle', 'Källfälten är oföränderliga. Tidigare beslut är arbetsförslag tills Simon granskar posten i appen.');

const sourceFields = {
  title: source.source.title,
  source_path: source.source.source_path,
  workbook_sha256: source.source.source_sha256,
  sheet: source.source.sheet,
  range: source.source.range,
  columns: source.source.columns,
  imported_on: source.source.imported_on,
  quality_status: source.source.quality_status,
  row_count: source.rows.length,
};
for (const [field, value] of Object.entries(sourceFields)) set('source', source.source.id, field, value);

for (const row of source.rows) {
  const fields = {
    source_document_id: source.source.id,
    source_row: row.source_row,
    ...row.raw,
    review_status: 'ogranskad',
  };
  for (const [field, value] of Object.entries(fields)) set('map-entry', row.id, field, value);
}

// Allt ovan behåller den första migrationens op-id:n oförändrade. Platslagret
// läggs efteråt så att det kan appliceras säkert på en redan använd lokal databas.
const structureStart = operations.length;
set('root', 'kartdata', 'place_schema_version', 1);
set('root', 'kartdata', 'place_seed_sha256', sha256(placeSeedText));
for (const place of placeSeed.places) {
  const fields = {
    preferred_name: place.preferred_name,
    subtype: place.subtype,
    review_status: place.review_status,
    source_ids: place.source_ids || [],
    note: place.note || null,
    valid_from: null,
    valid_to: null,
  };
  for (const [field, value] of Object.entries(fields)) set('place', place.id, field, value);

  const preferredName = {
    target_type: 'place', target_id: place.id, name: place.preferred_name,
    name_type: 'föredraget', review_status: place.review_status,
    source_ids: place.source_ids || [], valid_from: null, valid_to: null,
  };
  for (const [field, value] of Object.entries(preferredName)) set('name-record', `place:${place.id}:preferred`, field, value);
  if (place.official_name) {
    const officialName = { ...preferredName, name: place.official_name, name_type: 'officiellt' };
    for (const [field, value] of Object.entries(officialName)) set('name-record', `place:${place.id}:official`, field, value);
  }
  if (place.parent_place_id) {
    const relation = {
      child_type: 'place', child_id: place.id, relation_type: 'del_av',
      parent_place_id: place.parent_place_id, review_status: place.review_status,
      source_ids: place.source_ids || [], valid_from: null, valid_to: null,
    };
    for (const [field, value] of Object.entries(relation)) set('place-relation', `part-of:place:${place.id}:${place.parent_place_id}`, field, value);
  }
}
const structureOperations = operations.slice(structureStart);

// Det historiska namnunderlaget är en egen enhet och migration. Därmed ändras
// inga op-id:n i den redan publicerbara käll- eller strukturmigrationen.
let placeNameSeq = 0;
const placeNameOperations = [];
function setPlaceName(entityType, entityId, field, value) {
  placeNameSeq += 1;
  const operation = {
    op_id: `${PLACE_NAME_DEVICE}:${placeNameSeq}`,
    device_id: PLACE_NAME_DEVICE,
    seq: placeNameSeq,
    entity_type: entityType,
    entity_id: entityId,
    field,
    value,
    hlc: `${PLACE_NAME_CLOCK_MS}-${String(placeNameSeq).padStart(6, '0')}-${PLACE_NAME_DEVICE}`,
    schema_version: 1,
  };
  validateOperation(operation);
  placeNameOperations.push(operation);
}

setPlaceName('root', 'kartdata', 'place_name_migration_id', PLACE_NAME_MIGRATION_ID);
setPlaceName('root', 'kartdata', 'place_name_seed_sha256', sha256(placeNameSeedText));
setPlaceName('root', 'kartdata', 'place_name_review_principle', 'Historiska och alternativa namn är separata, källspårbara granskningsposter. Osäker geografisk identitet skrivs inte över som ett alias på en befintlig ö.');

for (const place of placeNameSeed.new_places) {
  const fields = {
    preferred_name: place.preferred_name,
    subtype: place.subtype,
    review_status: place.review_status,
    source_ids: place.source_ids || [],
    note: place.note || null,
    valid_from: null,
    valid_to: null,
  };
  for (const [field, value] of Object.entries(fields)) setPlaceName('place', place.id, field, value);
  const preferred = {
    target_type: 'place', target_id: place.id, name: place.preferred_name,
    name_type: 'föredraget', review_status: place.review_status,
    source_ids: place.source_ids || [], valid_from: null, valid_to: null,
    note: place.note || null,
  };
  for (const [field, value] of Object.entries(preferred)) setPlaceName('name-record', `seed-name:place:${place.id}:preferred`, field, value);
  if (place.parent_place_id) {
    const relation = {
      child_type: 'place', child_id: place.id, relation_type: 'del_av',
      parent_place_id: place.parent_place_id, review_status: place.review_status,
      source_ids: place.source_ids || [], valid_from: null, valid_to: null,
    };
    for (const [field, value] of Object.entries(relation)) setPlaceName('place-relation', `seed-part-of:place:${place.id}:${place.parent_place_id}`, field, value);
  }
}

for (const name of placeNameSeed.names) {
  const fields = {
    target_type: 'place', target_id: name.target_id, name: name.name,
    name_type: name.name_type, review_status: name.review_status,
    source_ids: name.source_ids || [], valid_from: name.valid_from || null,
    valid_to: name.valid_to || null, note: name.note || null,
  };
  for (const [field, value] of Object.entries(fields)) setPlaceName('name-record', `seed-name:place:${name.id}`, field, value);
}

const state = materialize(operations);
const combinedState = materialize([...operations, ...placeNameOperations]);
if (state.listEntities('map-entry').length !== 161) throw new Error('Materialiseringen tappade kartposter');
if (state.listEntities('map-entry').some(entry => entry.fields.review_status !== 'ogranskad')) throw new Error('En källrad blev felaktigt förhandsgranskad');
if (state.listEntities('place').length !== placeSeed.places.length) throw new Error('Materialiseringen tappade platsobjekt');
if (combinedState.listEntities('place').length !== placeSeed.places.length + placeNameSeed.new_places.length) throw new Error('Namnmaterialiseringen tappade platsobjekt');
if (combinedState.listEntities('name-record').length !== state.listEntities('name-record').length + placeNameSeed.new_places.length + placeNameSeed.names.length) throw new Error('Namnmaterialiseringen tappade namnposter');

const document = {
  operations_version: 1,
  dataset: 'Korpholmen kartdata',
  device_id: DEVICE,
  migration_id: MIGRATION_ID,
  counts: { source: 1, map_entry: source.rows.length, place: placeSeed.places.length, name_record: state.listEntities('name-record').length, place_relation: state.listEntities('place-relation').length, operations: operations.length },
  operations,
};
const structureDocument = {
  operations_version: 1,
  dataset: 'Korpholmen platsregister',
  device_id: DEVICE,
  migration_id: '2026-08-03-kartdata-place-structure-v1',
  counts: { place: placeSeed.places.length, name_record: state.listEntities('name-record').length, place_relation: state.listEntities('place-relation').length, operations: structureOperations.length },
  operations: structureOperations,
};
const placeNameDocument = {
  operations_version: 1,
  dataset: 'Korpholmen historiska och alternativa platsnamn',
  device_id: PLACE_NAME_DEVICE,
  migration_id: PLACE_NAME_MIGRATION_ID,
  counts: {
    new_place: placeNameSeed.new_places.length,
    new_name_record: placeNameSeed.new_places.length + placeNameSeed.names.length,
    new_place_relation: placeNameSeed.new_places.filter(place => place.parent_place_id).length,
    operations: placeNameOperations.length,
  },
  operations: placeNameOperations,
};
const manifest = {
  format: 'korpholmen-kartdata-manifest-v1',
  migration_id: MIGRATION_ID,
  generated_on: new Date().toISOString(),
  workbook_sha256: source.source.source_sha256,
  source_json_sha256: sha256(sourceText),
  place_seed_sha256: sha256(placeSeedText),
  place_name_seed_sha256: sha256(placeNameSeedText),
  rows: source.rows.length,
  places: combinedState.listEntities('place').length,
  name_records: combinedState.listEntities('name-record').length,
  place_relations: combinedState.listEntities('place-relation').length,
  operations: operations.length + placeNameOperations.length,
  quality_status: source.source.quality_status,
};
const report = `# Importkontroll — Kartdata\n\n- Källa: ${source.source.title}\n- Blad/intervall: ${source.source.sheet}!${source.source.range}\n- Arbetsbokens SHA-256: \`${source.source.source_sha256}\`\n- Källrader: ${source.rows.length}\n- Platsobjekt efter namntillägget: ${combinedState.listEntities('place').length}\n- Namnposter efter namntillägget: ${combinedState.listEntities('name-record').length}\n- Platsrelationer efter namntillägget: ${combinedState.listEntities('place-relation').length}\n- Grundoperationer: ${operations.length}\n- Separata namnoperationer: ${placeNameOperations.length}\n- Kvalitetsläge: **${source.source.quality_status}**\n\nAlla elva arbetsbokskolumner har bevarats per rad. Fälten \`prior_type_decision\` och \`prior_correction\` är tidigare arbetsförslag, inte godkänd masterdata. Bekräftade startposter bygger på uttryckliga beslut. Historiska och alternativa namn samt oidentifierade holmnamn ligger i en egen migration och är märkta \`ogranskad\` eller \`osäker\` tills Simon granskar dem i appen.\n`;

await writeFile(resolve(OUT, 'initial-ops.json'), `${JSON.stringify(document, null, 2)}\n`);
await writeFile(resolve(OUT, 'structure-ops.json'), `${JSON.stringify(structureDocument, null, 2)}\n`);
await writeFile(resolve(OUT, 'place-names-ops.json'), `${JSON.stringify(placeNameDocument, null, 2)}\n`);
await writeFile(resolve(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(resolve(OUT, 'importkontroll.md'), report);
console.log(`Kartdata-startmaster byggd: ${source.rows.length} ogranskade källrader, ${combinedState.listEntities('place').length} platsobjekt, ${combinedState.listEntities('name-record').length} namnposter, ${operations.length + placeNameOperations.length} operationer.`);
