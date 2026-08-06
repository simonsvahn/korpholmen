import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { batchPath, createBatch, createDeleteOperation, materialize } from '../../../packages/core/data-layer.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE = resolve(ROOT, 'privat/aktuell-startmaster');
const requestedRoot = process.argv[2];
const apply = process.argv.includes('--apply');
const expectedIndex = process.argv.indexOf('--expected');
const expected = expectedIndex >= 0 ? Number(process.argv[expectedIndex + 1]) : null;

if (!requestedRoot) throw new Error('Ange Dropbox-roten');
if (!Number.isSafeInteger(expected) || expected < 1) throw new Error('Ange --expected med exakt förväntat antal');

const dropboxRoot = await realpath(resolve(requestedRoot));
if (!dropboxRoot.endsWith('/Dropbox/Appar/Korpholmen')) {
  throw new Error(`Avbryter: målet är inte Dropbox/Appar/Korpholmen: ${dropboxRoot}`);
}

const opsRoot = resolve(dropboxRoot, 'dokumentarkiv/ops');
const remoteOperations = [];
let latestClock = 0;
for (const entry of await readdir(opsRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
  const batch = JSON.parse(await readFile(resolve(opsRoot, entry.name), 'utf8'));
  for (const operation of batch.ops || []) {
    remoteOperations.push(operation);
    const milliseconds = Number(String(operation.hlc || '').split('-')[0]);
    if (Number.isFinite(milliseconds)) latestClock = Math.max(latestClock, milliseconds);
  }
}

const currentMaster = JSON.parse(await readFile(resolve(PRIVATE, 'initial-ops.json'), 'utf8'));
const wantedState = materialize(currentMaster.operations);
const remoteState = materialize(remoteOperations);
const wantedIds = new Set(wantedState.listEntities('document').map(entity => entity.entity_id));
const stale = remoteState.listEntities('document')
  .filter(entity => !wantedIds.has(entity.entity_id))
  .map(entity => ({
    entity_id: entity.entity_id,
    title: entity.fields.title,
    document_date: entity.fields.document_date,
    source_path: entity.fields.source_path,
  }))
  .sort((a, b) => String(a.document_date).localeCompare(String(b.document_date), 'sv') || String(a.title).localeCompare(String(b.title), 'sv'));

if (stale.length !== expected) {
  throw new Error(`Avbryter: fann ${stale.length} ersatta poster, förväntade exakt ${expected}`);
}

const clockMs = Math.max(Date.now(), latestClock + 1000);
const stamp = new Date(clockMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const deviceId = `cleanup-dokumentarkiv-${stamp}`;
const operations = stale.map((entity, index) => {
  const seq = index + 1;
  return createDeleteOperation({
    deviceId,
    seq,
    entityType: 'document',
    entityId: entity.entity_id,
    hlc: `${clockMs}-${String(seq).padStart(6, '0')}-${deviceId}`,
  });
});

const after = materialize([...remoteOperations, ...operations]);
const wantedCount = wantedState.listEntities('document').length;
if (after.listEntities('document').length !== wantedCount) {
  throw new Error(`Efter simulering skulle ${after.listEntities('document').length} dokument visas, förväntade ${wantedCount}`);
}

const report = {
  mode: apply ? 'apply' : 'preview',
  visible_before: remoteState.listEntities('document').length,
  visible_after: after.listEntities('document').length,
  tombstones: operations.length,
  stale,
};

if (apply) {
  const batch = createBatch(operations);
  const relative = batchPath(batch.device_id, batch.from_seq, batch.to_seq, '/dokumentarkiv/ops').replace(/^\//, '');
  const target = resolve(dropboxRoot, relative);
  const content = `${JSON.stringify(batch, null, 2)}\n`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, { flag: 'wx' });
  const written = await readFile(target);
  if (createHash('sha256').update(written).digest('hex') !== createHash('sha256').update(content).digest('hex')) {
    throw new Error(`Den skrivna tombstone-batchen fick fel hash: ${target}`);
  }
  report.batch_file = target;
}

console.log(JSON.stringify(report, null, 2));
