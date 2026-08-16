import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const privateRoot = resolve(process.env.KORPHOLMEN_PRIVATE_ROOT || '/Users/simon/Dropbox/Appar/Korpholmen');
const v2Root = join(privateRoot, 'korpholmenrunt-generation2');
const pointerPath = join(v2Root, 'active.json');
const candidateRoot = resolve(process.env.KORPHOLMEN_RACE_TIME_CANDIDATE || join(repoRoot, 'arbetsmaterial/korpholmenrunt-tidsnormalisering-2026-08-16/kandidat-revision-5-v4'));
const backupRoot = resolve(process.env.KORPHOLMEN_RACE_TIME_BACKUP || '/Users/simon/Dropbox/AI/Projekt/9 Arkiv/Korpholmen säkerhetskopior/2026-08-16 före Korpholmen runt revision 5');
const mode = process.argv[2] || '--verify-only';
const targetDirectory = 'revision-5';
const targetRoot = join(v2Root, targetDirectory);
const activationId = 'time-normalization:2026-08-16:v1';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const exists = async path => stat(path).then(() => true, () => false);

assert(privateRoot.endsWith('/Dropbox/Appar/Korpholmen'), `Oväntad privat rot: ${privateRoot}`);
assert(candidateRoot.endsWith('/arbetsmaterial/korpholmenrunt-tidsnormalisering-2026-08-16/kandidat-revision-5-v4'), `Oväntad kandidatrot: ${candidateRoot}`);
assert(backupRoot.endsWith('/2026-08-16 före Korpholmen runt revision 5'), `Oväntad backuprot: ${backupRoot}`);
assert(['--verify-only', '--apply'].includes(mode), 'Välj --verify-only eller --apply');

async function atomicJson(path, value) {
  const temporary = `${path}.next-${process.pid}`;
  await writeFile(temporary, jsonBytes(value), { flag: 'wx' });
  await rename(temporary, path);
}

async function writeImmutable(path, bytes) {
  if (await exists(path)) {
    assert.equal(sha(await readFile(path)), sha(bytes), `Befintlig fil har annat innehåll: ${path}`);
    return 'verified-existing';
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: 'wx' });
  return 'written';
}

const [pointerBytes, candidateBytes, candidateReceiptBytes, candidateManifestBytes] = await Promise.all([
  readFile(pointerPath),
  readFile(join(candidateRoot, 'master.json')),
  readFile(join(candidateRoot, 'receipt.json')),
  readFile(join(candidateRoot, 'manifest.json')),
]);
const pointer = JSON.parse(pointerBytes);
const candidate = JSON.parse(candidateBytes);
const candidateReceipt = JSON.parse(candidateReceiptBytes);
const candidateManifest = JSON.parse(candidateManifestBytes);
const candidateSha256 = sha(candidateBytes);
const activeIsBase = pointer.master_revision === candidateManifest.base_master_revision
  && pointer.master_sha256 === candidateManifest.base_master_sha256;
const activeIsCandidate = pointer.master_revision === candidate.master_revision
  && pointer.master_sha256 === candidateSha256;

assert.equal(pointer.app, 'korpholmenrunt');
assert(activeIsBase || activeIsCandidate, 'Aktiv resultatmaster är varken kandidatens grundrevision eller kandidaten');
assert.equal(candidate.master_revision, 5);
assert.equal(candidateSha256, candidateManifest.master_sha256);
assert.equal(candidateSha256, candidateReceipt.candidate_master_sha256);
assert.equal(candidateManifest.changed_results, 39);
assert.equal(candidateReceipt.changed_count, 39);
assert.equal(candidateReceipt.raw_times_unchanged, true);

const baseMasterPath = activeIsBase ? join(v2Root, pointer.master_relative_path) : join(v2Root, targetDirectory, 'base-master.json');
const baseBytes = activeIsBase ? await readFile(baseMasterPath) : await readFile(join(backupRoot, 'korpholmenrunt-generation2', 'revision-4', 'master.json'));
const base = JSON.parse(baseBytes);
assert.equal(sha(baseBytes), candidateManifest.base_master_sha256, 'Grundmasterns SHA-256 stämmer inte');
assert.equal(base.data.results.length, candidate.data.results.length);

const baseResults = new Map(base.data.results.map(result => [result.id, result]));
const changed = [];
for (const result of candidate.data.results) {
  const before = baseResults.get(result.id);
  assert(before, `Kandidaten innehåller ett nytt resultat-ID: ${result.id}`);
  assert.equal(result.time_raw, before.time_raw, `Råtiden har ändrats för ${result.id}`);
  const beforeFacts = { ...before };
  const afterFacts = { ...result };
  for (const field of ['duration_seconds', 'time_status', 'updated_at', 'updated_by']) {
    delete beforeFacts[field];
    delete afterFacts[field];
  }
  assert.deepEqual(afterFacts, beforeFacts, `Andra sakfält än tidsnormaliseringen har ändrats för ${result.id}`);
  if (result.duration_seconds !== before.duration_seconds || result.time_status !== before.time_status) changed.push(result.id);
}
assert.equal(changed.length, 39, 'Kandidaten ändrar inte exakt 39 tidsresultat');
const baseOtherData = { ...base.data, results: undefined };
const candidateOtherData = { ...candidate.data, results: undefined };
assert.deepEqual(candidateOtherData, baseOtherData, 'Någon annan samling än resultat har ändrats');

const activatedAt = new Date().toISOString();
const activeManifest = {
  schema_version: 1,
  app: 'korpholmenrunt',
  status: 'active_private_read_master',
  activation_id: activationId,
  activated_at: activatedAt,
  activated_by: 'simon',
  mode: pointer.mode,
  writer_enabled: pointer.writer_enabled,
  generation_1_writer_state: pointer.generation_1_writer_state,
  master_revision: candidate.master_revision,
  master_sha256: candidateSha256,
  base_master_revision: candidateManifest.base_master_revision,
  base_master_sha256: candidateManifest.base_master_sha256,
  counts: {
    results: candidate.data.results.length,
    editions: candidate.data.editions.length,
    participants: candidate.data.participants.length,
    classes: candidate.data.classes.length,
    courses: candidate.data.courses.length,
    sources: candidate.data.sources.length,
  },
  time_changes: {
    automatic_normalizations: candidateManifest.automatic_normalizations,
    manual_time_decisions: candidateManifest.manual_time_decisions,
    changed_results: changed.length,
    raw_times_unchanged: true,
  },
};
const nextPointer = {
  ...pointer,
  activation_id: activationId,
  activated_at: activatedAt,
  activated_by: 'simon',
  target_directory: targetDirectory,
  manifest_relative_path: `${targetDirectory}/manifest.json`,
  master_relative_path: `${targetDirectory}/master.json`,
  master_revision: candidate.master_revision,
  master_sha256: candidateSha256,
  updated_at: activatedAt,
  updated_by: 'simon',
};
const activationReceipt = {
  schema_version: 1,
  status: 'activated_private_read_master',
  activation_id: activationId,
  activated_at: activatedAt,
  activated_by: 'simon',
  backup_root: backupRoot,
  prior_pointer_sha256: sha(pointerBytes),
  prior_master_revision: candidateManifest.base_master_revision,
  prior_master_sha256: candidateManifest.base_master_sha256,
  master_revision: candidate.master_revision,
  master_sha256: candidateSha256,
  result_count: candidate.data.results.length,
  changed_results: changed,
  validations: {
    all_result_ids_preserved: 'pass',
    all_raw_times_preserved: 'pass',
    only_time_fields_and_audit_metadata_changed: 'pass',
    all_other_collections_unchanged: 'pass',
    writer_mode_unchanged: 'pass',
  },
};
const receiptBytes = jsonBytes(activationReceipt);
const manifest = {
  ...activeManifest,
  files: {
    'master.json': candidateSha256,
    'receipt.json': sha(receiptBytes),
    'candidate-receipt.json': sha(candidateReceiptBytes),
    'candidate-manifest.json': sha(candidateManifestBytes),
  },
};
const manifestBytes = jsonBytes(manifest);
const sumsBytes = Buffer.from([
  `${candidateSha256}  master.json`,
  `${sha(receiptBytes)}  receipt.json`,
  `${sha(candidateReceiptBytes)}  candidate-receipt.json`,
  `${sha(candidateManifestBytes)}  candidate-manifest.json`,
  `${sha(manifestBytes)}  manifest.json`,
  '',
].join('\n'));

async function verifyActive() {
  const [currentPointer, installedMasterBytes, installedManifest] = await Promise.all([
    json(pointerPath),
    readFile(join(targetRoot, 'master.json')),
    json(join(targetRoot, 'manifest.json')),
  ]);
  assert.equal(currentPointer.master_revision, 5);
  assert.equal(currentPointer.master_sha256, candidateSha256);
  assert.equal(currentPointer.master_relative_path, `${targetDirectory}/master.json`);
  assert.equal(sha(installedMasterBytes), candidateSha256);
  assert.equal(installedManifest.status, 'active_private_read_master');
  assert.equal(installedManifest.time_changes.changed_results, 39);
  return currentPointer;
}

const preflight = {
  ok: true,
  mode,
  state: activeIsCandidate ? 'active' : 'ready',
  current_revision: pointer.master_revision,
  candidate_revision: candidate.master_revision,
  candidate_sha256: candidateSha256,
  changed_results: changed.length,
  raw_times_unchanged: true,
  backup_root: backupRoot,
  target: relative(v2Root, targetRoot),
};

if (activeIsCandidate) {
  const verifiedPointer = await verifyActive();
  console.log(JSON.stringify({ ...preflight, state: 'verified-active', active_pointer: verifiedPointer }, null, 2));
  process.exit(0);
}
if (mode === '--verify-only') {
  assert.equal(await exists(targetRoot), false, 'Revision 5 finns redan trots att pekaren står på grundrevisionen');
  assert.equal(await exists(backupRoot), false, 'Backupmålet finns redan före aktivering');
  console.log(JSON.stringify({ ...preflight, state: 'verified-not-active' }, null, 2));
  process.exit(0);
}

await mkdir(backupRoot, { recursive: false });
await mkdir(join(backupRoot, 'korpholmenrunt-generation2'), { recursive: true });
await copyFile(pointerPath, join(backupRoot, 'korpholmenrunt-generation2', 'active.json'));
await cp(dirname(baseMasterPath), join(backupRoot, 'korpholmenrunt-generation2', 'revision-4'), { recursive: true, errorOnExist: true });
await writeFile(join(backupRoot, 'ÅTERSTÄLL.md'), `# Återställ Korpholmen runt revision 4\n\nBackupen innehåller den tidigare aktiva pekaren och hela revision 4. För att återgå: ersätt \`${pointerPath}\` atomärt med backupfilen \`korpholmenrunt-generation2/active.json\`. Revision 4 ligger kvar i den privata appmappen och inga rådata har skrivits över.\n`, { flag: 'wx' });

await mkdir(targetRoot, { recursive: false });
await Promise.all([
  writeImmutable(join(targetRoot, 'master.json'), candidateBytes),
  writeImmutable(join(targetRoot, 'receipt.json'), receiptBytes),
  writeImmutable(join(targetRoot, 'candidate-receipt.json'), candidateReceiptBytes),
  writeImmutable(join(targetRoot, 'candidate-manifest.json'), candidateManifestBytes),
  writeImmutable(join(targetRoot, 'manifest.json'), manifestBytes),
  writeImmutable(join(targetRoot, 'SHA256SUMS.txt'), sumsBytes),
  writeImmutable(join(targetRoot, 'base-master.json'), baseBytes),
  writeImmutable(join(v2Root, 'pointer-history', `before-time-normalization-${sha(pointerBytes)}.json`), pointerBytes),
]);
await atomicJson(pointerPath, nextPointer);
const verifiedPointer = await verifyActive();
console.log(JSON.stringify({ ...preflight, state: 'activated-and-verified', active_pointer: verifiedPointer }, null, 2));
