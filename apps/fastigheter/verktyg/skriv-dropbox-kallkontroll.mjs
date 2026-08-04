import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { batchPath, createBatch } from '../../../packages/core/data-layer.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const document = JSON.parse(await readFile(resolve(ROOT, 'privat/migrering-2026-08-04-kallkontroll/delta-ops.json'), 'utf8'));
const requestedRoot = process.argv[2];
if (!requestedRoot) throw new Error('Ange den lokala Dropbox-roten');
const dropboxRoot = await realpath(resolve(requestedRoot));
if (!dropboxRoot.endsWith('/Dropbox/Appar/Korpholmen')) throw new Error(`Avbryter: oväntat mål ${dropboxRoot}`);
if (document.migration_id !== '2026-08-04-fastigheter-source-audit') throw new Error('Oväntat migrations-ID');

let written = 0;
let identical = 0;
for (let index = 0; index < document.operations.length; index += 250) {
  const batch = createBatch(document.operations.slice(index, index + 250));
  const target = resolve(dropboxRoot, batchPath(batch.device_id, batch.from_seq, batch.to_seq, '/fastigheter/ops').replace(/^\//, ''));
  const content = `${JSON.stringify(batch, null, 2)}\n`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(target, content, { flag: 'wx' });
    written += 1;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await readFile(target, 'utf8') !== content) throw new Error(`Befintlig batch skiljer sig: ${target}`);
    identical += 1;
  }
}
console.log(JSON.stringify({ migration_id: document.migration_id, operations: document.operations.length, batches_written: written, batches_identical: identical }, null, 2));
