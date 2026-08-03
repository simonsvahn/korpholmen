import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { batchPath, createBatch, materialize } from '../../../packages/core/data-layer.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE = resolve(ROOT, 'privat/migrering-2026-08-03');
const requestedRoot = process.argv[2];
if (!requestedRoot) throw new Error('Ange den lokala Dropbox-roten, exempelvis /Users/.../Dropbox/Appar/Korpholmen');

const dropboxRoot = await realpath(resolve(requestedRoot));
if (!dropboxRoot.endsWith('/Dropbox/Appar/Korpholmen')) throw new Error(`Avbryter: målet är inte Dropbox/Appar/Korpholmen: ${dropboxRoot}`);

const documents = await Promise.all([
  'initial-ops.json',
  'place-names-ops.json',
].map(file => readFile(resolve(PRIVATE, file), 'utf8').then(JSON.parse)));
const allOperations = documents.flatMap(document => document.operations || []);
const counters = { batches_written: 0, batches_identical: 0 };

async function writeImmutableJson(path, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, content, { flag: 'wx' });
    counters.batches_written += 1;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readFile(path, 'utf8');
    if (existing !== content) throw new Error(`Befintlig operationsbatch skiljer sig och skrivs inte över: ${path}`);
    counters.batches_identical += 1;
  }
}

const byDevice = new Map();
for (const operation of allOperations) {
  if (!byDevice.has(operation.device_id)) byDevice.set(operation.device_id, []);
  byDevice.get(operation.device_id).push(operation);
}
for (const deviceOperations of byDevice.values()) {
  deviceOperations.sort((a, b) => a.seq - b.seq);
  for (let index = 0; index < deviceOperations.length; index += 250) {
    const batch = createBatch(deviceOperations.slice(index, index + 250));
    const relative = batchPath(batch.device_id, batch.from_seq, batch.to_seq, '/kartdata/ops').replace(/^\//, '');
    await writeImmutableJson(resolve(dropboxRoot, relative), batch);
  }
}

const state = materialize(allOperations);
console.log(JSON.stringify({
  target: dropboxRoot,
  migrations: documents.map(document => document.migration_id),
  operations: allOperations.length,
  map_entries: state.listEntities('map-entry').length,
  places: state.listEntities('place').length,
  name_records: state.listEntities('name-record').length,
  place_relations: state.listEntities('place-relation').length,
  ...counters,
}, null, 2));
