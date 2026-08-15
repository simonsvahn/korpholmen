import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSetOperation } from '../src/domain/operations.js';
import { batchPath, createBatch } from '../src/sync/batch.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = resolve(process.argv[2] || resolve(ROOT, 'privat/legacy/Slaktlandskap 3 - redigerbar.html'));
const PRIVATE = resolve(ROOT, 'privat/migrering-2026-08-01');
const ARCHIVE = resolve(PRIVATE, 'initial-archive.json');
const OUTPUT = resolve(PRIVATE, 'ui-metadata-ops.json');
const BATCH_DIR = resolve(PRIVATE, 'ui-metadata-ops');
const DEVICE_ID = 'migration-ui-2026-08-01';
const PHYSICAL_TIME = 1785585660000;

function embeddedData(source) {
  const startMarker = 'const D=';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(';\nconst P=', start);
  if (start < 0 || end < 0) throw new Error('Kunde inte hitta den inbyggda datamodellen i referensfilen.');
  return JSON.parse(source.slice(start + startMarker.length, end));
}

function metadataFor(person, data) {
  const color = data.personfarg?.[person.id];
  return {
    ui_clan: person.klan || person.slakt || 'Utan känd släktkoppling',
    ui_generation: person.led ?? null,
    ui_generation_source: person.led_kalla ?? null,
    ui_is_inlaw: Boolean(person.ingift),
    ui_born_in: Boolean(person.fodd_in),
    ui_constructed_club_name: person.kbk_konstruerat ?? null,
    ui_family_origin: person.slakt_ursprung ?? null,
    ui_section: person.sektion ?? null,
    ui_color: color ?? null,
  };
}

const source = await readFile(SOURCE, 'utf8');
const data = embeddedData(source);
const archive = JSON.parse(await readFile(ARCHIVE, 'utf8'));
const archiveIds = new Set(archive.persons.map((person) => person.id));
const sourceIds = new Set(data.personer.map((person) => person.id));
const missingInSource = [...archiveIds].filter((id) => !sourceIds.has(id));
const extraInSource = [...sourceIds].filter((id) => !archiveIds.has(id));
if (missingInSource.length || extraInSource.length) {
  throw new Error(`Person-ID avviker mellan master och referens: saknas ${missingInSource.join(', ') || 'inga'}; extra ${extraInSource.join(', ') || 'inga'}.`);
}

const entries = [{ entityType: 'root', entityId: 'slaktlandskap', field: 'ui_metadata_version', value: 1 }];
for (const person of data.personer) {
  for (const [field, value] of Object.entries(metadataFor(person, data))) {
    entries.push({ entityType: 'person', entityId: person.id, field, value });
  }
}

const operations = entries.map((entry, index) => createSetOperation({
  deviceId: DEVICE_ID,
  seq: index + 1,
  entityType: entry.entityType,
  entityId: entry.entityId,
  field: entry.field,
  value: entry.value,
  hlc: `${PHYSICAL_TIME}-${String(index + 1).padStart(6, '0')}-${DEVICE_ID}`,
}));

const document = {
  operations_version: 1,
  migration_id: '2026-08-01-ui-metadata',
  source_sha256: 'f62468f1f5cc691a4ac0199bbb70b9e3f37dd5d84bd26a83f1f13d91a161c31c',
  device_id: DEVICE_ID,
  people: data.personer.length,
  fields_per_person: 9,
  operations,
};

await mkdir(BATCH_DIR, { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
for (let index = 0; index < operations.length; index += 250) {
  const batch = createBatch(operations.slice(index, index + 250));
  const filename = basename(batchPath(batch.device_id, batch.from_seq, batch.to_seq));
  await writeFile(resolve(BATCH_DIR, filename), `${JSON.stringify(batch, null, 2)}\n`);
}

process.stdout.write(`Skapade ${operations.length} presentationsoperationer i ${Math.ceil(operations.length / 250)} batcher.\n`);
