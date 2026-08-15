import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSetOperation } from '../src/domain/operations.js';
import { batchPath, createBatch } from '../src/sync/batch.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE = resolve(ROOT, 'privat/migrering-2026-08-01');
const INPUT = resolve(PRIVATE, 'approved-excel-import.json');
const OUTPUT = resolve(PRIVATE, 'approved-excel-ops.json');
const BATCH_DIR = resolve(PRIVATE, 'approved-excel-ops');
const DEVICE_ID = 'migration-approved-excel-2026-08-01';
const PHYSICAL_TIME = 1785588500000;

const approved = JSON.parse(await readFile(INPUT, 'utf8'));
if (approved.import_version !== 1 || approved.counts?.people !== 214) {
  throw new Error('Den godkända Excelimporten har fel format eller personantal.');
}

const entries = [
  { entityType: 'root', entityId: 'slaktlandskap', field: 'approved_excel_version', value: 1 },
  { entityType: 'root', entityId: 'slaktlandskap', field: 'approved_excel_sha256', value: approved.source_sha256 },
];

for (const person of approved.people) {
  entries.push(
    { entityType: 'person', entityId: person.id, field: 'living', value: person.living },
    { entityType: 'person', entityId: person.id, field: 'legacy_island', value: person.island },
  );
}

for (const property of approved.properties) {
  for (const field of ['display_name', 'island', 'label', 'wiki_page']) {
    entries.push({ entityType: 'property', entityId: property.id, field, value: property[field] });
  }
}

for (const link of approved.links) {
  entries.push(
    { entityType: 'property-link', entityId: link.id, field: 'person_id', value: link.person_id },
    { entityType: 'property-link', entityId: link.id, field: 'property_id', value: link.property_id },
    { entityType: 'property-link', entityId: link.id, field: 'confirmed', value: true },
    { entityType: 'property-link', entityId: link.id, field: 'source', value: link.source },
  );
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
  migration_id: '2026-08-01-approved-excel',
  source_sha256: approved.source_sha256,
  device_id: DEVICE_ID,
  counts: approved.counts,
  operations,
};

await mkdir(BATCH_DIR, { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
for (let index = 0; index < operations.length; index += 250) {
  const batch = createBatch(operations.slice(index, index + 250));
  const filename = basename(batchPath(batch.device_id, batch.from_seq, batch.to_seq));
  await writeFile(resolve(BATCH_DIR, filename), `${JSON.stringify(batch, null, 2)}\n`);
}

process.stdout.write(`Skapade ${operations.length} godkända Exceloperationer i ${Math.ceil(operations.length / 250)} batcher.\n`);
