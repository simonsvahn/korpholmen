import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { assertWriterDomainFields } from '../packages/master-data-v2/src/domain-contracts.js';

const privateRoot = resolve(process.argv[2] || '');
const reviewRoot = resolve(process.argv[3] || '');
const backupRoot = resolve(process.argv[4] || '');
const mode = process.argv[5] || '--verify-only';
const v2Root = join(privateRoot, 'batregister-generation2');
const pointerPath = join(v2Root, 'active.json');
const candidateRoot = join(reviewRoot, 'kandidat-revision-5');
const candidatePath = join(candidateRoot, 'master.json');
const reportPath = join(candidateRoot, 'rapport.json');
const receiptPath = join(candidateRoot, 'receipt.json');
const backupPointerPath = join(backupRoot, 'privat-dropbox', 'batregister-generation2', 'active.json');
const sha = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const exists = async path => stat(path).then(() => true, () => false);

assert(privateRoot.endsWith('/Dropbox/Appar/Korpholmen'), `Oväntad privat rot: ${privateRoot}`);
assert(reviewRoot.endsWith('/arbetsmaterial/batbildsgranskning-2026-08-16'), `Oväntad granskningsrot: ${reviewRoot}`);
assert(backupRoot.endsWith('/2026-08-16 före bildreparation Båtregister'), `Oväntad backuprot: ${backupRoot}`);
assert(['--verify-only', '--apply'].includes(mode), 'Välj --verify-only eller --apply');

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.next-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, path);
}

async function writeImmutableOrVerify(path, bytes) {
  if (await exists(path)) {
    assert.equal(sha(await readFile(path)), sha(bytes), `Befintlig fil har annat innehåll: ${path}`);
    return 'verified-existing';
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: 'wx' });
  return 'written';
}

const [pointer, candidateBytes, report, receipt, backupPointer] = await Promise.all([
  json(pointerPath),
  readFile(candidatePath),
  json(reportPath),
  json(receiptPath),
  json(backupPointerPath),
]);
const candidate = JSON.parse(candidateBytes);
const candidateSha256 = sha(candidateBytes);
assert.equal(pointer.app, 'batregister');
const activeIsBase = pointer.master_revision === report.previous_master_revision
  && pointer.master_sha256 === report.previous_master_sha256;
const activeIsCandidate = pointer.master_revision === candidate.master_revision
  && pointer.master_sha256 === candidateSha256;
assert(activeIsBase || activeIsCandidate, 'Aktiv master är varken kandidatens grundrevision eller den verifierade kandidaten');
assert.equal(backupPointer.master_revision, report.previous_master_revision, 'Backupen avser inte kandidatens grundrevision');
assert.equal(backupPointer.master_sha256, report.previous_master_sha256, 'Backupen avser inte kandidatens grundmaster');
assert.equal(candidate.master_revision, report.previous_master_revision + 1, 'Kandidaten är inte nästa revision efter grundrevisionen');
assert.equal(candidateSha256, report.candidate_master_sha256, 'Kandidatens SHA-256 stämmer inte med rapporten');
assert.equal(receipt.base_master_revision, report.previous_master_revision, 'Kvittot avser fel grundrevision');
assert.equal(receipt.new_master_revision, candidate.master_revision, 'Kvittot avser fel ny revision');
assert.equal(receipt.change_id, candidate.last_change_id, 'Kvittot och kandidaten har olika change_id');
assertWriterDomainFields(candidate, { allowMissingCollections: false });

const assets = report.assets || [];
for (const asset of assets) {
  const bytes = await readFile(asset.staged_path);
  assert.equal(bytes.length, asset.bytes, `Bildstorleken stämmer inte: ${asset.staged_path}`);
  assert.equal(sha(bytes), asset.sha256, `Bildhashen stämmer inte: ${asset.staged_path}`);
  assert.equal(asset.filename, `${asset.sha256}.jpg`, `Bildnamnet är inte innehållsadresserat: ${asset.filename}`);
  assert.equal(asset.dropbox_path, `/batregister/bilder/${asset.filename}`, `Ogiltig bilddestination: ${asset.dropbox_path}`);
}

const relativeMasterPath = `revisions/revision-${candidate.master_revision}-${candidateSha256.slice(0, 12)}/master.json`;
const nextMasterPath = join(v2Root, relativeMasterPath);
const historyPath = join(v2Root, 'history', `${sha(receipt.change_id)}.json`);
const preflight = {
  ok: true,
  mode,
  current_revision: pointer.master_revision,
  current_sha256: pointer.master_sha256,
  candidate_revision: candidate.master_revision,
  candidate_sha256: candidateSha256,
  candidate_master_path: relativeMasterPath,
  assets: assets.length,
  changes: report.removals,
  backup_root: backupRoot,
};

async function verifyInstalledCandidate() {
  assert.equal(pointer.master_relative_path, relativeMasterPath, 'Aktiv pekare har fel sökväg till kandidaten');
  assert.equal(sha(await readFile(nextMasterPath)), candidateSha256, 'Installerad kandidatmaster har fel SHA-256');
  assert(await exists(historyPath), 'Kandidatens historikkvitto saknas');
  for (const asset of assets) {
    const installed = await readFile(join(privateRoot, asset.dropbox_path.replace(/^\/+/, '')));
    assert.equal(sha(installed), asset.sha256, `Installerad bild avviker: ${asset.filename}`);
  }
}

if (activeIsCandidate) {
  await verifyInstalledCandidate();
  console.log(JSON.stringify({ state: 'verified-active', ...preflight, active_pointer: pointer }, null, 2));
  process.exit(0);
}

if (mode === '--verify-only') {
  console.log(JSON.stringify({ state: 'verified-not-active', ...preflight }, null, 2));
  process.exit(0);
}

const assetResults = [];
for (const asset of assets) {
  const bytes = await readFile(asset.staged_path);
  const destination = join(privateRoot, asset.dropbox_path.replace(/^\/+/, ''));
  assetResults.push({ filename: asset.filename, result: await writeImmutableOrVerify(destination, bytes) });
}
await writeImmutableOrVerify(nextMasterPath, candidateBytes);
await writeImmutableOrVerify(historyPath, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`));

const nextPointer = {
  ...pointer,
  master_relative_path: relativeMasterPath,
  master_revision: candidate.master_revision,
  master_sha256: candidateSha256,
  updated_at: candidate.updated_at,
  updated_by: candidate.updated_by,
};
await atomicJson(pointerPath, nextPointer);

const [verifiedPointer, verifiedMasterBytes] = await Promise.all([json(pointerPath), readFile(nextMasterPath)]);
assert.equal(verifiedPointer.master_revision, candidate.master_revision);
assert.equal(verifiedPointer.master_sha256, candidateSha256);
assert.equal(sha(verifiedMasterBytes), candidateSha256);
for (const asset of assets) {
  const installed = await readFile(join(privateRoot, asset.dropbox_path.replace(/^\/+/, '')));
  assert.equal(sha(installed), asset.sha256, `Installerad bild avviker: ${asset.filename}`);
}

console.log(JSON.stringify({ state: 'activated-and-verified', ...preflight, asset_results: assetResults, active_pointer: nextPointer }, null, 2));
