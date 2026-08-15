import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { materialize } from '../packages/core/domain/materializer.js';
import { applyMasterChange } from '../packages/master-data-v2/src/master.js';
import { assertWriterDomainFields } from '../packages/master-data-v2/src/domain-contracts.js';

const privateRoot = resolve(process.argv[2] || '');
const backupRoot = resolve(process.argv[3] || '');
const command = process.argv[4] || '--verify-only';
const actor = process.argv[5] || 'simon';

if (!process.argv[2] || !process.argv[3]) {
  throw new Error('Användning: node verktyg/migrera-batbilder-till-v2.mjs <privat rot> <backuprot> [--verify-only|--apply] [aktör]');
}
if (!['--verify-only', '--apply'].includes(command)) throw new Error('Välj --verify-only eller --apply.');

const paths = {
  v1: join(privateRoot, 'batregister'),
  v1Ops: join(privateRoot, 'batregister', 'ops'),
  v2: join(privateRoot, 'batregister-generation2'),
  pointer: join(privateRoot, 'batregister-generation2', 'active.json'),
  cutover: join(privateRoot, 'generation2-cutover', 'batregister.json'),
};

const sha = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const exists = async path => stat(path).then(() => true, () => false);

async function files(base, current = base) {
  const entries = await readdir(current, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'sv'))) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) result.push(...await files(base, path));
    else if (entry.isFile()) result.push(relative(base, path));
  }
  return result;
}

async function treeDigest(base) {
  const rows = [];
  for (const path of await files(base)) rows.push(`${path}\0${sha(await readFile(join(base, path)))}`);
  return { sha256: sha(rows.join('\n')), files: rows.length, rows };
}

function resolveMasterPath(pointer) {
  assert.equal(typeof pointer.master_relative_path, 'string', 'Pekaren saknar master_relative_path');
  assert(!pointer.master_relative_path.startsWith('/') && !pointer.master_relative_path.includes('..'), 'Ogiltig master_relative_path');
  return join(paths.v2, pointer.master_relative_path);
}

async function activeV1Boats() {
  const operations = [];
  const batchFiles = (await files(paths.v1Ops)).filter(path => path.endsWith('.json'));
  for (const path of batchFiles) {
    const batch = await json(join(paths.v1Ops, path));
    const rows = Array.isArray(batch) ? batch : (batch.ops || batch.operations);
    assert(Array.isArray(rows), `V1-batch saknar operationer: ${path}`);
    operations.push(...rows);
  }
  return {
    boats: materialize(operations).listEntities('boat').map(row => ({ id: row.entity_id, ...row.fields })),
    batchFiles: batchFiles.length,
    operations: operations.length,
  };
}

function imageKey(image) {
  return image?.full?.sha256 || image?.full?.dropbox_path || image?.thumb?.sha256 || image?.thumb?.dropbox_path || image?.id;
}

async function verifyImageFile(file) {
  if (!file?.dropbox_path) throw new Error('Bildreferens saknar dropbox_path');
  const relativePath = file.dropbox_path.replace(/^\/+/, '');
  assert(relativePath.startsWith('batregister/bilder/'), `Bildreferensen ligger utanför bildmappen: ${file.dropbox_path}`);
  const bytes = await readFile(join(privateRoot, relativePath));
  const actual = sha(bytes);
  if (file.sha256) assert.equal(actual, file.sha256, `Bildfilens SHA-256 stämmer inte: ${file.dropbox_path}`);
  return { path: file.dropbox_path, sha256: actual, bytes: bytes.length };
}

function mergeImages(existing, incoming, sourceBoatId, targetBoatId) {
  const result = structuredClone(existing || []);
  const keys = new Set(result.map(imageKey));
  const ids = new Map(result.map(image => [image.id, imageKey(image)]));
  for (const image of incoming || []) {
    const key = imageKey(image);
    if (!key) throw new Error(`Bild utan stabil nyckel på V1-båten ${sourceBoatId}`);
    if (keys.has(key)) continue;
    if (image.id && ids.has(image.id) && ids.get(image.id) !== key) {
      throw new Error(`Bild-id ${image.id} betyder olika filer vid sammanslagning till ${targetBoatId}`);
    }
    result.push(structuredClone(image));
    keys.add(key);
    if (image.id) ids.set(image.id, key);
  }
  return result;
}

async function inspect() {
  const pointerBytes = await readFile(paths.pointer);
  const pointer = JSON.parse(pointerBytes);
  assert.equal(pointer.schema_version, 1);
  assert.equal(pointer.app, 'batregister');
  assert.equal(pointer.mode, 'read_write', 'Båtregister V2 är inte aktiv writer');
  assert.equal(pointer.writer_enabled, true, 'Båtregister V2-writern är avstängd');
  const masterPath = resolveMasterPath(pointer);
  const masterBytes = await readFile(masterPath);
  assert.equal(sha(masterBytes), pointer.master_sha256, 'Aktiv V2-master stämmer inte med pekarens hash');
  const master = JSON.parse(masterBytes);
  assert.equal(master.master_revision, pointer.master_revision, 'Aktiv V2-master och pekare har olika revision');
  assertWriterDomainFields(master, { allowMissingCollections: false });

  const v1 = await activeV1Boats();
  const boats = (master.data.boats || []).filter(row => !row.deleted_at);
  const boatById = new Map(boats.map(row => [row.id, row]));
  const redirects = new Map((master.data.identity_redirects || [])
    .filter(row => !row.deleted_at)
    .map(row => [row.id, row.target_boat_id]));
  const sources = v1.boats.filter(row => Array.isArray(row.images) && row.images.length);
  const unmapped = [];
  const incomingByTarget = new Map();
  const imageFiles = new Map();

  for (const source of sources) {
    const targetId = boatById.has(source.id) ? source.id : redirects.get(source.id);
    if (!targetId || !boatById.has(targetId)) {
      unmapped.push({ source_boat_id: source.id, display_name: source.namn || source.id, images: source.images.length });
      continue;
    }
    const current = incomingByTarget.get(targetId) || [];
    incomingByTarget.set(targetId, mergeImages(current, source.images, source.id, targetId));
    for (const image of source.images) for (const file of [image.thumb, image.full].filter(Boolean)) {
      if (!imageFiles.has(file.dropbox_path)) imageFiles.set(file.dropbox_path, await verifyImageFile(file));
    }
  }

  const patches = [];
  for (const [targetId, incoming] of incomingByTarget) {
    const existing = boatById.get(targetId).images || [];
    const merged = mergeImages(existing, incoming, targetId, targetId);
    if (JSON.stringify(merged) !== JSON.stringify(existing)) patches.push({ target_boat_id: targetId, images: merged, added: merged.length - existing.length });
  }

  const resultingImageBoats = new Set([
    ...boats.filter(row => (row.images || []).length).map(row => row.id),
    ...patches.map(row => row.target_boat_id),
  ]);
  return {
    pointer,
    pointerBytes,
    master,
    masterPath,
    v1,
    sources,
    unmapped,
    patches,
    imageFiles: [...imageFiles.values()],
    counts: {
      v1_active_boats: v1.boats.length,
      v1_boats_with_images: sources.length,
      v1_image_records: sources.reduce((sum, row) => sum + row.images.length, 0),
      verified_image_files: imageFiles.size,
      v2_active_boats: boats.length,
      v2_boats_with_images_before: boats.filter(row => (row.images || []).length).length,
      v2_boats_receiving_images: patches.length,
      v2_image_records_added: patches.reduce((sum, row) => sum + row.added, 0),
      v2_boats_with_images_after: resultingImageBoats.size,
      unmapped_image_boats: unmapped.length,
    },
  };
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.next-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, path);
}

async function writeBackup(preflight) {
  assert.equal(await exists(backupRoot), false, `Backupmappen finns redan: ${backupRoot}`);
  await mkdir(join(backupRoot, 'privat-dropbox'), { recursive: true });
  await cp(paths.v2, join(backupRoot, 'privat-dropbox', 'batregister-generation2'), { recursive: true, errorOnExist: true });
  if (await exists(paths.cutover)) {
    await mkdir(join(backupRoot, 'privat-dropbox', 'generation2-cutover'), { recursive: true });
    await cp(paths.cutover, join(backupRoot, 'privat-dropbox', 'generation2-cutover', 'batregister.json'), { errorOnExist: true });
  }
  await atomicJson(join(backupRoot, 'BILDMIGRERING-FORKONTROLL.json'), preflight);
  const digest = await treeDigest(join(backupRoot, 'privat-dropbox'));
  await writeFile(join(backupRoot, 'MANIFEST-SHA256.txt'), `${digest.rows.join('\n')}\n`, { flag: 'wx' });
  const sourceDigest = await treeDigest(paths.v2);
  const copiedDigest = await treeDigest(join(backupRoot, 'privat-dropbox', 'batregister-generation2'));
  assert.deepEqual(
    { sha256: copiedDigest.sha256, files: copiedDigest.files },
    { sha256: sourceDigest.sha256, files: sourceDigest.files },
    'Backupkopian av Båtregister V2 skiljer sig från källan',
  );
  return { backup_tree_sha256: digest.sha256, source_v2_tree_sha256: sourceDigest.sha256, files: digest.files };
}

const state = await inspect();
const preflight = {
  ok: state.unmapped.length === 0,
  command,
  master_revision: state.master.master_revision,
  master_sha256: state.pointer.master_sha256,
  counts: state.counts,
  unmapped: state.unmapped,
};

if (command === '--verify-only') {
  console.log(JSON.stringify(preflight, null, 2));
  process.exit(state.unmapped.length ? 2 : 0);
}

assert.equal(state.unmapped.length, 0, `Bildkopplade V1-båtar saknar V2-identitet: ${state.unmapped.map(row => row.source_boat_id).join(', ')}`);
assert(state.patches.length > 0, 'Inga nya bildkopplingar behöver migreras');
const backup = await writeBackup(preflight);

const changedAt = new Date().toISOString();
const changeId = `batregister:migrate-v1-image-links:${changedAt}`;
const request = {
  change_id: changeId,
  expected_master_revision: state.master.master_revision,
  changed_at: changedAt,
  changed_by: actor,
  manual_comment: 'Återför verifierade bildreferenser från fryst Båtregister V1 till samma stabila båtidentiteter i V2.',
  mutations: state.patches.map(row => ({ collection: 'boats', entity_id: row.target_boat_id, action: 'upsert', set: { images: row.images } })),
};
const applied = await applyMasterChange(state.master, request);
assertWriterDomainFields(applied.master, { allowMissingCollections: false });
const masterBytes = Buffer.from(JSON.stringify(applied.master));
const masterSha256 = sha(masterBytes);
const relativeDirectory = `revisions/revision-${applied.master.master_revision}-${masterSha256.slice(0, 12)}`;
const relativeMasterPath = `${relativeDirectory}/master.json`;
const nextMasterPath = join(paths.v2, relativeMasterPath);
const receiptPath = join(paths.v2, 'history', `${sha(changeId)}.json`);
assert.equal(await exists(nextMasterPath), false, `Ny masterfil finns redan: ${nextMasterPath}`);
assert.equal(await exists(receiptPath), false, `Ändringskvittot finns redan: ${receiptPath}`);
await mkdir(dirname(nextMasterPath), { recursive: true });
await writeFile(nextMasterPath, masterBytes, { flag: 'wx' });
await atomicJson(receiptPath, applied.receipt);

const nextPointer = {
  ...state.pointer,
  master_revision: applied.master.master_revision,
  master_sha256: masterSha256,
  master_relative_path: relativeMasterPath,
  updated_at: applied.master.updated_at,
  updated_by: applied.master.updated_by,
};
await atomicJson(paths.pointer, nextPointer);

const verified = await inspect();
assert.equal(verified.pointer.master_revision, state.pointer.master_revision + 1);
assert.equal(verified.pointer.master_sha256, masterSha256);
assert.equal(verified.patches.length, 0, 'Alla bildreferenser migrerades inte');
assert.equal(verified.unmapped.length, 0);
const report = {
  ok: true,
  result: 'images-migrated-and-verified',
  changed_at: changedAt,
  changed_by: actor,
  change_id: changeId,
  backup_root: backupRoot,
  backup,
  previous_master_revision: state.pointer.master_revision,
  previous_master_sha256: state.pointer.master_sha256,
  master_revision: verified.pointer.master_revision,
  master_sha256: verified.pointer.master_sha256,
  migration_counts: state.counts,
  verification_counts: verified.counts,
};
await atomicJson(join(backupRoot, 'BILDMIGRERING-RESULTAT.json'), report);
console.log(JSON.stringify(report, null, 2));
