import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materialize } from '../../../packages/core/domain/materializer.js';
import { validateOperation } from '../../../packages/core/domain/operations.js';
import { validateBatch } from '../../../packages/core/sync/batch.js';

const opsRoot = resolve(process.argv[2] || '');
const imageRootArgument = process.argv[3] || '';
const imageRoot = imageRootArgument ? resolve(imageRootArgument) : null;
const pilotId = process.argv[4] || 'batmaster-pilot-bethge-svahn-20260805-v2';
const matrikelOpsArgument = process.argv[5] || '';
const matrikelOpsRoot = matrikelOpsArgument ? resolve(matrikelOpsArgument) : null;
if (!opsRoot) {
  throw new Error('Användning: node bygg-lokal-pilotpreview.mjs BATREGISTER-OPS-ROT [BATREGISTER-BILDROT] [PILOT-ID] [MATRIKEL-OPS-ROT]');
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'privat/migrering-2026-08-01/initial-ops.json');
const pilotImageRoot = resolve(root, 'privat/migrering-2026-08-01/bilder');
const pilotImageManifestTarget = resolve(root, 'privat/migrering-2026-08-01/pilot-bildmanifest.json');
const matrikelContextTarget = resolve(root, 'privat/migrering-2026-08-01/matrikel-context.json');

async function jsonFiles(path) {
  const output = [];
  async function visit(parent) {
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      const child = join(parent, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && entry.name.endsWith('.json')) output.push(child);
    }
  }
  await visit(path);
  return output.sort();
}

const batches = await Promise.all((await jsonFiles(opsRoot)).map(async path => {
  const batch = JSON.parse(await readFile(path, 'utf8'));
  validateBatch(batch);
  return batch;
}));
const operations = batches.flatMap(batch => batch.ops);
operations.forEach(validateOperation);
const state = materialize(operations);
const pilotRecords = state.listEntities('boat-pilot-manifest').map(entity => ({ id: entity.entity_id, ...entity.fields.record }));
const pilotIdentity = record => record?.pilot_id || record?.id || '';
function latestPilotFor(id) {
  let current = pilotRecords.find(record => pilotIdentity(record) === id);
  const visited = new Set();
  while (current && !visited.has(pilotIdentity(current))) {
    visited.add(pilotIdentity(current));
    const successor = pilotRecords.find(record => record.supersedes === pilotIdentity(current));
    if (!successor) break;
    current = successor;
  }
  return current;
}
const preview = {
  operations_version: 1,
  migration_id: `local-${pilotId}`,
  device_id: 'local-batmaster-pilot-preview',
  operations,
};
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(preview)}\n`);

let matrikelContext = null;
if (matrikelOpsRoot) {
  const matrikelBatches = await Promise.all((await jsonFiles(matrikelOpsRoot)).map(async path => {
    const batch = JSON.parse(await readFile(path, 'utf8'));
    validateBatch(batch);
    return batch;
  }));
  const matrikelOperations = matrikelBatches.flatMap(batch => batch.ops);
  matrikelOperations.forEach(validateOperation);
  const matrikelState = materialize(matrikelOperations);
  const rows = type => matrikelState.listEntities(type).map(entity => ({ id: entity.entity_id, ...entity.fields }));
  matrikelContext = {
    context_version: 1,
    generated_for_pilot: pilotId,
    people: rows('person'),
    relations: rows('relation'),
    family_units: rows('family-unit'),
    kin_groups: rows('kin-group'),
  };
  await writeFile(matrikelContextTarget, `${JSON.stringify(matrikelContext)}\n`);
}

const imageManifest = {
  manifest_version: 1,
  pilot_id: pilotId,
  boat_ids: [],
  boats_with_images: [],
  image_files: [],
};

if (imageRoot) {
  const pilot = latestPilotFor(pilotId);
  if (!pilot) throw new Error(`Pilotmanifest saknas: ${pilotId}`);
  imageManifest.boat_ids = pilot.boat_ids.filter(boatId => state.getEntity('boat', boatId));
  const refs = new Map();
  for (const boatId of imageManifest.boat_ids) {
    const boat = state.getEntity('boat', boatId);
    const images = boat.fields.images || [];
    if (images.length) imageManifest.boats_with_images.push(boatId);
    for (const image of images) {
      for (const ref of [image.thumb, image.full]) {
        if (!ref?.dropbox_path) continue;
        const filename = ref.filename || basename(ref.dropbox_path);
        if (basename(filename) !== filename) throw new Error(`Ogiltigt bildfilnamn: ${filename}`);
        const existing = refs.get(filename);
        if (existing && existing.sha256 !== ref.sha256) throw new Error(`Motstridiga kontrollsummor för ${filename}`);
        refs.set(filename, { filename, dropbox_path: ref.dropbox_path, sha256: ref.sha256 });
      }
    }
  }

  await mkdir(pilotImageRoot, { recursive: true });
  for (const ref of [...refs.values()].sort((left, right) => left.filename.localeCompare(right.filename, 'sv'))) {
    const source = resolve(imageRoot, ref.filename);
    const bytes = await readFile(source);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (ref.sha256 && sha256 !== ref.sha256) throw new Error(`Fel kontrollsumma för ${ref.filename}`);
    await copyFile(source, resolve(pilotImageRoot, ref.filename));
    imageManifest.image_files.push({ ...ref, sha256, bytes: (await stat(source)).size });
  }
  await writeFile(pilotImageManifestTarget, `${JSON.stringify(imageManifest, null, 2)}\n`);
}

console.log(JSON.stringify({
  target,
  batches: batches.length,
  operations: operations.length,
  pilot_id: imageRoot ? pilotId : null,
  pilot_boats: imageManifest.boat_ids.length,
  boats_with_images: imageManifest.boats_with_images.length,
  image_files: imageManifest.image_files.length,
  image_bytes: imageManifest.image_files.reduce((sum, file) => sum + file.bytes, 0),
  pilot_image_manifest: imageRoot ? pilotImageManifestTarget : null,
  matrikel_context: matrikelContext ? matrikelContextTarget : null,
  matrikel_people: matrikelContext?.people.length || 0,
  matrikel_family_units: matrikelContext?.family_units.length || 0,
  matrikel_kin_groups: matrikelContext?.kin_groups.length || 0,
}, null, 2));
