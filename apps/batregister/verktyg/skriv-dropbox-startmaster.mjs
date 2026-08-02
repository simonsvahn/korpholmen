import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { batchPath, createBatch, materialize } from '../../../packages/core/data-layer.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE = resolve(ROOT, 'privat/migrering-2026-08-01');
const CORRECTIONS = resolve(ROOT, 'privat/korrigeringar');
const requestedRoot = process.argv[2];
if (!requestedRoot) throw new Error('Ange den lokala Dropbox-roten, exempelvis /Users/.../Dropbox/Appar/Korpholmen');

const dropboxRoot = await realpath(resolve(requestedRoot));
if (!dropboxRoot.endsWith('/Dropbox/Appar/Korpholmen')) {
  throw new Error(`Avbryter: målet är inte Dropbox/Appar/Korpholmen: ${dropboxRoot}`);
}

const document = JSON.parse(await readFile(resolve(PRIVATE, 'initial-ops.json'), 'utf8'));
const manifest = JSON.parse(await readFile(resolve(PRIVATE, 'bildmanifest.json'), 'utf8'));
async function readCorrectionOperations() {
  let files;
  try {
    files = (await readdir(CORRECTIONS)).filter(file => file.endsWith('.json')).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const documents = await Promise.all(files.map(file => readFile(resolve(CORRECTIONS, file), 'utf8').then(JSON.parse)));
  return documents.flatMap(item => item.operations || item.ops || []);
}
const correctionOperations = await readCorrectionOperations();
const allOperations = [...document.operations, ...correctionOperations];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const counters = { batches_written: 0, batches_identical: 0, images_written: 0, images_identical: 0 };

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
    const relative = batchPath(batch.device_id, batch.from_seq, batch.to_seq, '/batregister/ops').replace(/^\//, '');
    await writeImmutableJson(resolve(dropboxRoot, relative), batch);
  }
}

for (const file of manifest.image_files) {
  const source = resolve(PRIVATE, 'bilder', file.filename);
  const target = resolve(dropboxRoot, file.dropbox_path.replace(/^\//, ''));
  await mkdir(dirname(target), { recursive: true });
  try {
    await copyFile(source, target, constants.COPYFILE_EXCL);
    counters.images_written += 1;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readFile(target);
    if (sha256(existing) !== file.sha256) throw new Error(`Befintlig bild skiljer sig och skrivs inte över: ${target}`);
    counters.images_identical += 1;
  }
}

const state = materialize(allOperations);
console.log(JSON.stringify({
  target: dropboxRoot,
  base_operations: document.operations.length,
  correction_operations: correctionOperations.length,
  operations: allOperations.length,
  boats: state.listEntities('boat').length,
  boat_person_links: state.listEntities('boat-person-link').length,
  families: state.listEntities('family').length,
  boat_family_links: state.listEntities('boat-family-link').length,
  images: manifest.image_files.length,
  ...counters,
}, null, 2));
