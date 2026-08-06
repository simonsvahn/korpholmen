import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalStringify,
  createDeleteOperation,
  createRestoreOperation,
  createSetOperation,
  materialize,
} from '../../../packages/core/data-layer.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'privat/migrering-2026-08-06-fastighetsvisning');
const DESIRED_PATH = resolve(ROOT, 'privat/migrering-2026-08-02/initial-ops.json');
const DROPBOX_ROOT = resolve(process.argv[2] || '/Users/simon/Dropbox/Appar/Korpholmen');
const OPS_ROOT = resolve(DROPBOX_ROOT, 'fastigheter/ops');
const DEVICE = 'migration-fastigheter-property-owner-display-2026-08-06';
const MIGRATION_ID = '2026-08-06-fastigheter-property-owner-display';
const CLOCK_MS = 1786030200000;
const sha256 = value => createHash('sha256').update(value).digest('hex');

const desiredText = await readFile(DESIRED_PATH, 'utf8');
const desiredDocument = JSON.parse(desiredText);
const remoteFiles = (await readdir(OPS_ROOT)).filter(name => name.endsWith('.json')).sort();
const remoteDocuments = await Promise.all(remoteFiles.map(name => readFile(resolve(OPS_ROOT, name), 'utf8').then(JSON.parse)));
const remoteOperations = remoteDocuments.flatMap(document => document.operations || document.ops || []);
const desiredState = materialize(desiredDocument.operations);
const remoteState = materialize(remoteOperations);
const managedTypes = [...new Set(desiredDocument.operations.map(operation => operation.entity_type))].sort();

let seq = 0;
const operations = [];
const nextHlc = () => `${CLOCK_MS}-${String(seq).padStart(6, '0')}-${DEVICE}`;
function set(entityType, entityId, field, value) {
  seq += 1;
  operations.push(createSetOperation({ deviceId: DEVICE, seq, entityType, entityId, field, value, hlc: nextHlc() }));
}
function restore(entityType, entityId) {
  seq += 1;
  operations.push(createRestoreOperation({ deviceId: DEVICE, seq, entityType, entityId, hlc: nextHlc() }));
}
function remove(entityType, entityId) {
  seq += 1;
  operations.push(createDeleteOperation({ deviceId: DEVICE, seq, entityType, entityId, hlc: nextHlc() }));
}

const changedEntities = new Set();
const deletedEntities = [];
for (const entityType of managedTypes) {
  const desiredEntities = desiredState.listEntities(entityType);
  const desiredIds = new Set(desiredEntities.map(entity => entity.entity_id));
  for (const entity of desiredEntities) {
    const current = remoteState.getEntity(entityType, entity.entity_id, { includeDeleted: true });
    if (current?.deleted) restore(entityType, entity.entity_id);
    for (const [field, value] of Object.entries(entity.fields)) {
      if (!current || current.deleted || !(field in current.fields) || canonicalStringify(current.fields[field]) !== canonicalStringify(value)) {
        set(entityType, entity.entity_id, field, value);
        changedEntities.add(`${entityType}:${entity.entity_id}`);
      }
    }
  }
  for (const current of remoteState.listEntities(entityType)) {
    if (desiredIds.has(current.entity_id)) continue;
    remove(entityType, current.entity_id);
    deletedEntities.push(`${entityType}:${current.entity_id}`);
  }
}

if (!operations.length) throw new Error('Ingen delta behövs; avbryter i stället för att skapa en tom migration.');
const previewState = materialize([...remoteOperations, ...operations]);
for (const entityType of managedTypes) {
  const desiredEntities = desiredState.listEntities(entityType);
  const previewEntities = previewState.listEntities(entityType);
  if (desiredEntities.length !== previewEntities.length) throw new Error(`Delta ger fel antal ${entityType}: ${previewEntities.length}/${desiredEntities.length}`);
  for (const desired of desiredEntities) {
    const preview = previewState.getEntity(entityType, desired.entity_id);
    if (!preview) throw new Error(`Delta saknar ${entityType}:${desired.entity_id}`);
    for (const [field, value] of Object.entries(desired.fields)) {
      if (!(field in preview.fields) || canonicalStringify(preview.fields[field]) !== canonicalStringify(value)) throw new Error(`Delta avviker för ${entityType}:${desired.entity_id}.${field}`);
    }
  }
}

const document = {
  operations_version: 1,
  dataset: desiredDocument.dataset,
  device_id: DEVICE,
  migration_id: MIGRATION_ID,
  based_on_remote_batches: remoteFiles.length,
  desired_source_sha256: sha256(desiredText),
  operations,
};
const manifest = {
  migration_id: MIGRATION_ID,
  desired_source_sha256: document.desired_source_sha256,
  remote_batches_read: remoteFiles.length,
  remote_operations_read: remoteOperations.length,
  operations: operations.length,
  changed_entities: changedEntities.size,
  deleted_entities: deletedEntities,
};
await mkdir(OUT, { recursive: true });
await writeFile(resolve(OUT, 'delta-ops.json'), `${JSON.stringify(document, null, 2)}\n`);
await writeFile(resolve(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
