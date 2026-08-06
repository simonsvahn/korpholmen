import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { batchPath, createBatch } from '../../../packages/core/data-layer.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const document = JSON.parse(await readFile(resolve(ROOT, 'privat/migrering-2026-08-06-fastighetsvisning/clean-v2-ops.json'), 'utf8'));
const requestedRoot = process.argv[2];
if (!requestedRoot) throw new Error('Ange den lokala Dropbox-roten, exempelvis /Users/.../Dropbox/Appar/Korpholmen');
const dropboxRoot = await realpath(resolve(requestedRoot));
if (!dropboxRoot.endsWith('/Dropbox/Appar/Korpholmen')) throw new Error(`Avbryter: målet är inte Dropbox/Appar/Korpholmen: ${dropboxRoot}`);
if (document.migration_id !== '2026-08-06-kartdata-property-owner-display') throw new Error('Kartdatas fastighetsvisningsmigration har oväntat ID');

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
console.log(JSON.stringify({
  target: dropboxRoot,
  migration_id: document.migration_id,
  operations: operations.length,
  data_entries_after_migration: document.counts.entries,
  island_links_after_migration: document.counts.island_links,
  property_links_after_migration: document.counts.property_links,
  owner_links_after_migration: document.counts.owner_links,
  ...counters,
}, null, 2));
