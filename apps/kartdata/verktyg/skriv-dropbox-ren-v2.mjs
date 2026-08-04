import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { batchPath, createBatch, materialize } from '../../../packages/core/data-layer.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const document = JSON.parse(await readFile(resolve(ROOT, 'privat/migrering-2026-08-04-ren-v2/clean-v2-ops.json'), 'utf8'));
const requestedRoot = process.argv[2];
if (!requestedRoot) throw new Error('Ange den lokala Dropbox-roten, exempelvis /Users/.../Dropbox/Appar/Korpholmen');
const dropboxRoot = await realpath(resolve(requestedRoot));
if (!dropboxRoot.endsWith('/Dropbox/Appar/Korpholmen')) throw new Error(`Avbryter: målet är inte Dropbox/Appar/Korpholmen: ${dropboxRoot}`);
if (document.migration_id !== '2026-08-04-kartdata-clean-v2') throw new Error('Den rena v2-migrationen har oväntat ID');

const counters = { batches_written: 0, batches_identical: 0 };
async function writeImmutableJson(path, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`; await mkdir(dirname(path), { recursive: true });
  try { await writeFile(path, content, { flag: 'wx' }); counters.batches_written += 1; }
  catch (error) { if (error.code !== 'EEXIST') throw error; const existing = await readFile(path, 'utf8'); if (existing !== content) throw new Error(`Befintlig operationsbatch skiljer sig och skrivs inte över: ${path}`); counters.batches_identical += 1; }
}

const operations = [...document.operations].sort((a, b) => a.seq - b.seq);
for (let index = 0; index < operations.length; index += 250) {
  const batch = createBatch(operations.slice(index, index + 250));
  const relative = batchPath(batch.device_id, batch.from_seq, batch.to_seq, '/kartdata/ops').replace(/^\//, '');
  await writeImmutableJson(resolve(dropboxRoot, relative), batch);
}
const state = materialize(operations);
console.log(JSON.stringify({
  target: dropboxRoot,
  migration_id: document.migration_id,
  operations: operations.length,
  data_entries: state.listEntities('data-entry').length,
  island_links: state.listEntities('data-entry-island-link').length,
  property_links: state.listEntities('data-entry-property-link').length,
  owner_links: state.listEntities('property-owner-link').length,
  ...counters,
}, null, 2));
