import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] || '');
const backupRoot = resolve(process.argv[3] || '');
const command = process.argv[4] || '--verify-only';
const actor = process.argv[5] || 'simon';
if (!process.argv[2] || !process.argv[3]) {
  throw new Error('Användning: node verktyg/aktivera-batregister-writer-byte.mjs <privat rot> <backuprot> [--verify-only|--activate] [aktör]');
}
if (!['--verify-only', '--activate'].includes(command)) throw new Error('Välj --verify-only eller --activate.');

const paths = {
  v1: join(root, 'batregister'),
  v2: join(root, 'batregister-generation2'),
  pointer: join(root, 'batregister-generation2', 'active.json'),
  marker: join(root, 'generation2-cutover', 'batregister.json'),
  peoplePointer: join(root, 'personer-familjer', 'active.json'),
  racePointer: join(root, 'korpholmenrunt-generation2', 'active.json'),
  backupV1: join(backupRoot, 'privat-dropbox', 'batregister'),
  backupManifest: join(backupRoot, 'MANIFEST-SHA256.txt'),
  report: join(backupRoot, 'BATREGISTER-V2-AKTIVERING.json'),
};

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const exists = async path => stat(path).then(() => true, () => false);

async function regularFiles(base, current = base) {
  const entries = await readdir(current, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'sv'))) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) result.push(...await regularFiles(base, path));
    else if (entry.isFile()) result.push(relative(base, path));
  }
  return result;
}

async function treeDigest(base) {
  const rows = [];
  for (const path of await regularFiles(base)) rows.push(`${path}\0${sha(await readFile(join(base, path)))}`);
  return { sha256: sha(rows.join('\n')), files: rows.length };
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.next-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, path);
}

function masterPath(directory, pointer) {
  assert.equal(typeof pointer.master_relative_path, 'string', 'Pekaren saknar master_relative_path');
  assert(!pointer.master_relative_path.startsWith('/') && !pointer.master_relative_path.includes('..'), 'Ogiltig master_relative_path');
  return join(directory, pointer.master_relative_path);
}

function collectBoatRefs(value, result = []) {
  if (Array.isArray(value)) value.forEach(item => collectBoatRefs(item, result));
  else if (value && typeof value === 'object') {
    if (value.master === 'batregister') result.push(value);
    Object.values(value).forEach(item => collectBoatRefs(item, result));
  }
  return result;
}

async function countV1Operations() {
  const opsRoot = join(paths.v1, 'ops');
  const batchFiles = (await regularFiles(opsRoot)).filter(path => path.endsWith('.json'));
  let operations = 0;
  for (const path of batchFiles) {
    const value = await json(join(opsRoot, path));
    const rows = Array.isArray(value) ? value : (value.operations || value.ops);
    assert(Array.isArray(rows), `V1-batch saknar operations: ${path}`);
    operations += rows.length;
  }
  return { batch_files: batchFiles.length, operations };
}

async function inspect() {
  assert(await exists(paths.backupManifest), 'Backupens SHA-256-manifest saknas');
  const [v1, backupV1] = await Promise.all([treeDigest(paths.v1), treeDigest(paths.backupV1)]);
  assert.deepEqual(v1, backupV1, 'Båtregister V1 skiljer sig från den verifierade backupen');

  const pointerBytes = await readFile(paths.pointer);
  const pointer = JSON.parse(pointerBytes);
  assert.equal(pointer.schema_version, 1);
  assert.equal(pointer.app, 'batregister');
  const boatMasterFile = masterPath(paths.v2, pointer);
  const boatMasterBytes = await readFile(boatMasterFile);
  assert.equal(sha(boatMasterBytes), pointer.master_sha256, 'Båtmasterns hash stämmer inte med pekaren');
  const boatMaster = JSON.parse(boatMasterBytes);
  assert.equal(boatMaster.master_revision, pointer.master_revision, 'Båtmaster och pekare har olika revision');

  const boats = (boatMaster.data?.boats || []).filter(row => !row.deleted_at);
  const redirects = (boatMaster.data?.identity_redirects || []).filter(row => !row.deleted_at);
  assert.equal(boats.length, 236, 'Oväntat antal aktiva båtar');
  assert.equal(redirects.length, 2, 'Oväntat antal identitetsompekningar');
  const boatIds = new Set(boats.map(row => row.id));
  const redirectMap = new Map(redirects.map(row => [row.id, row.target_boat_id]));
  for (const [id, target] of redirectMap) assert(boatIds.has(target), `Ompekningen ${id} saknar giltigt mål ${target}`);

  const peoplePointer = await json(paths.peoplePointer);
  assert.equal(pointer.people_master_revision, peoplePointer.master_revision, 'Båtmastern pekar på fel personrevision');
  assert.equal(pointer.people_master_sha256, peoplePointer.master_sha256, 'Båtmastern pekar på fel personhash');

  const racePointer = await json(paths.racePointer);
  const raceMasterBytes = await readFile(masterPath(join(root, 'korpholmenrunt-generation2'), racePointer));
  assert.equal(sha(raceMasterBytes), racePointer.master_sha256, 'Korpholmen runt-masterns hash stämmer inte');
  const raceMaster = JSON.parse(raceMasterBytes);
  assert.equal(racePointer.boat_master_revision, pointer.master_revision, 'Korpholmen runt pekar på fel båtrevision');
  assert.equal(racePointer.boat_master_sha256, pointer.master_sha256, 'Korpholmen runt pekar på fel båthash');
  const refs = collectBoatRefs(raceMaster);
  assert.equal(refs.length, 330, 'Oväntat antal båtreferenser i Korpholmen runt');
  const unresolved = refs.filter(ref => ref.entity_type !== 'boat' || (!boatIds.has(ref.entity_id) && !redirectMap.has(ref.entity_id)));
  assert.equal(unresolved.length, 0, `Olösta båtreferenser i Korpholmen runt: ${unresolved.map(row => row.entity_id).join(', ')}`);

  return {
    pointer, pointerBytes, boatMaster,
    counts: { boats: boats.length, redirects: redirects.length, race_boat_refs: refs.length, ...(await countV1Operations()) },
    v1,
    activeMarker: await exists(paths.marker) ? await json(paths.marker) : null,
  };
}

function assertOperationalState(state) {
  const active = state.activeMarker?.state === 'active';
  if (active) {
    assert.equal(state.pointer.mode, 'read_write', 'Aktiv markör men Båtmastern är inte skrivbar');
    assert.equal(state.pointer.writer_enabled, true, 'Aktiv markör men writern är avstängd');
    assert.equal(state.activeMarker.v1_baseline_manifest_sha256, state.v1.sha256, 'V1 har ändrats sedan aktiveringen');
    assert.equal(state.activeMarker.v2_master_sha256, state.pointer.master_sha256, 'Markör och V2-pekare har olika masterhash');
  } else {
    assert.equal(state.pointer.mode, 'read_only', 'Båtmastern ska vara skrivskyddad före aktivering');
    assert.equal(state.pointer.writer_enabled, false, 'Båtmasterns writer ska vara avstängd före aktivering');
  }
  return active;
}

let state = await inspect();
const alreadyActive = assertOperationalState(state);
if (command === '--verify-only' || alreadyActive) {
  console.log(JSON.stringify({ ok: true, command, state: alreadyActive ? 'active' : 'ready', master_revision: state.pointer.master_revision, master_sha256: state.pointer.master_sha256, v1_tree_sha256: state.v1.sha256, counts: state.counts }, null, 2));
  process.exit(0);
}

assert.equal(state.activeMarker, null, 'En ofärdig Båtregister-markör finns redan; avbryter utan att skriva över den');
const originalPointerBytes = state.pointerBytes;

const timestamp = new Date().toISOString();
const marker = {
  schema_version: 1,
  app: 'batregister',
  state: 'active',
  v1_ops_root: '/batregister/ops',
  v2_pointer_path: '/batregister-generation2/active.json',
  prepared_at: timestamp,
  prepared_by: actor,
  v1_baseline_manifest_sha256: state.v1.sha256,
  v2_master_sha256: state.pointer.master_sha256,
  activated_at: timestamp,
  activated_by: actor,
};
const nextPointer = {
  ...state.pointer,
  activation_id: 'phase12g:activate-batregister-writer:v1',
  activated_at: timestamp,
  activated_by: actor,
  mode: 'read_write',
  writer_enabled: true,
  generation_1_writer_state: 'frozen-by-cutover-marker',
  v1_baseline_manifest_sha256: state.v1.sha256,
};

try {
  await atomicJson(paths.marker, marker);
  await atomicJson(paths.pointer, nextPointer);
  state = await inspect();
  assert.equal(assertOperationalState(state), true);
  const report = {
    schema_version: 1,
    app: 'batregister',
    result: 'activated-and-verified',
    activated_at: timestamp,
    activated_by: actor,
    master_revision: state.pointer.master_revision,
    master_sha256: state.pointer.master_sha256,
    people_master_revision: state.pointer.people_master_revision,
    people_master_sha256: state.pointer.people_master_sha256,
    v1_tree_sha256: state.v1.sha256,
    counts: state.counts,
  };
  await atomicJson(paths.report, report);
  console.log(JSON.stringify({ ok: true, state: 'active', report: paths.report, ...report }, null, 2));
} catch (error) {
  await writeFile(paths.pointer, originalPointerBytes);
  await rm(paths.marker, { force: true });
  throw error;
}
