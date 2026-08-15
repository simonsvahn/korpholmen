import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { applyMasterChange } from '../packages/master-data-v2/src/master.js';
import { assertWriterDomainFields } from '../packages/master-data-v2/src/domain-contracts.js';

const privateRoot = resolve(process.argv[2] || '/Users/simon/Dropbox/Appar/Korpholmen');
const reviewRoot = resolve(process.argv[3] || join(process.cwd(), 'arbetsmaterial', 'batbildsgranskning-2026-08-16'));
const actor = process.argv[4] || 'simon';
const v2Root = join(privateRoot, 'batregister-generation2');
const pointerPath = join(v2Root, 'active.json');
const decisionsPath = join(reviewRoot, 'beslut.json');
const additionsPath = join(reviewRoot, 'bildtillagg.json');
const stagedImageRoot = join(reviewRoot, 'nya-bilder');
const sha = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const exists = async path => stat(path).then(() => true, () => false);

assert(privateRoot.endsWith('/Dropbox/Appar/Korpholmen'), `Oväntad privat rot: ${privateRoot}`);

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.next-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, path);
}

const pointerBytes = await readFile(pointerPath);
const pointer = JSON.parse(pointerBytes);
assert.equal(pointer.app, 'batregister');
assert(!pointer.master_relative_path.startsWith('/') && !pointer.master_relative_path.includes('..'), 'Ogiltig master_relative_path');
const activeMasterBytes = await readFile(join(v2Root, pointer.master_relative_path));
assert.equal(sha(activeMasterBytes), pointer.master_sha256, 'Aktiv master stämmer inte med active.json');
const activeMaster = JSON.parse(activeMasterBytes);
const decisionDocument = await json(decisionsPath);
const removals = Object.values(decisionDocument.decisions || {}).filter(row => row.decision === 'remove');
const additionDocument = await exists(additionsPath) ? await json(additionsPath) : { additions: [] };
const additions = additionDocument.additions || [];
assert(removals.length > 0 || additions.length > 0, 'Inga bildändringar finns');

const removalsByBoat = new Map();
for (const removal of removals) {
  if (!removalsByBoat.has(removal.boat_id)) removalsByBoat.set(removal.boat_id, new Set());
  removalsByBoat.get(removal.boat_id).add(removal.image_id);
}

const additionsByBoat = new Map();
const assetFiles = new Map();
for (const addition of additions) {
  assert(addition.boat_id && addition.image_id && addition.thumb_file && addition.full_file, 'Bildtillägget saknar obligatoriska fält');
  const image = { id: addition.image_id };
  for (const [role, property, sourceFilename] of [['miniatyr', 'thumb', addition.thumb_file], ['stor', 'full', addition.full_file]]) {
    const stagedPath = join(stagedImageRoot, basename(sourceFilename));
    const bytes = await readFile(stagedPath);
    const hash = sha(bytes);
    const extension = extname(sourceFilename).toLowerCase() || '.jpg';
    const filename = `${hash}${extension}`;
    image[property] = { role, filename, sha256: hash, dropbox_path: `/batregister/bilder/${filename}` };
    assetFiles.set(filename, { staged_path: stagedPath, filename, sha256: hash, bytes: bytes.length, dropbox_path: `/batregister/bilder/${filename}` });
  }
  image.kind = addition.kind || 'register-image';
  image.caption = addition.caption || null;
  image.source = addition.source;
  if (!additionsByBoat.has(addition.boat_id)) additionsByBoat.set(addition.boat_id, []);
  additionsByBoat.get(addition.boat_id).push(image);
}

const mutations = [];
const reportRows = [];
const changedBoatIds = new Set([...removalsByBoat.keys(), ...additionsByBoat.keys()]);
for (const boatId of changedBoatIds) {
  const imageIds = removalsByBoat.get(boatId) || new Set();
  const incoming = additionsByBoat.get(boatId) || [];
  const boat = activeMaster.data.boats.find(row => row.id === boatId && !row.deleted_at);
  assert(boat, `Båten saknas: ${boatId}`);
  const before = boat.images || [];
  for (const imageId of imageIds) assert(before.some(image => image.id === imageId), `Bildposten saknas: ${boatId}:${imageId}`);
  const after = before.filter(image => !imageIds.has(image.id));
  assert.equal(before.length - after.length, imageIds.size, `Alla valda bilder togs inte bort från ${boatId}`);
  for (const image of incoming) {
    assert(!after.some(current => current.id === image.id), `Bild-id finns redan på ${boatId}: ${image.id}`);
    assert(!after.some(current => current.full?.sha256 === image.full?.sha256), `Bildfilen finns redan på ${boatId}: ${image.full?.sha256}`);
    after.push(image);
  }
  mutations.push({ collection: 'boats', entity_id: boatId, action: 'upsert', set: { images: after } });
  reportRows.push({ boat_id: boatId, boat_name: boat.display_name, removed_image_ids: [...imageIds], added_image_ids: incoming.map(image => image.id), images_before: before.length, images_after: after.length });
}

const changedAt = new Date().toISOString();
const changeId = `batregister:repair-image-links:${changedAt}`;
const applied = await applyMasterChange(activeMaster, {
  change_id: changeId,
  expected_master_revision: activeMaster.master_revision,
  changed_at: changedAt,
  changed_by: actor,
  manual_comment: 'Rättar källgranskade bildkopplingar och lägger till källtroget beskurna visningsderivat från fullständiga båtblad. Originalen lämnas orörda.',
  mutations,
});
assertWriterDomainFields(applied.master, { allowMissingCollections: false });
const candidateBytes = Buffer.from(`${JSON.stringify(applied.master, null, 2)}\n`);
const candidateSha256 = sha(candidateBytes);
const candidateRoot = join(reviewRoot, 'kandidat-revision-5');
await atomicJson(join(candidateRoot, 'master.json'), applied.master);
await atomicJson(join(candidateRoot, 'receipt.json'), applied.receipt);
await atomicJson(join(candidateRoot, 'rapport.json'), {
  ok: true,
  state: 'candidate-not-active',
  change_id: changeId,
  previous_master_revision: activeMaster.master_revision,
  previous_master_sha256: pointer.master_sha256,
  candidate_master_revision: applied.master.master_revision,
  candidate_master_sha256: candidateSha256,
  removals: reportRows,
  assets: [...assetFiles.values()],
  remaining_review_decisions: Object.values(decisionDocument.decisions || {}).filter(row => row.decision === 'review'),
});
console.log(JSON.stringify({ state: 'candidate-not-active', candidate_root: candidateRoot, candidate_master_revision: applied.master.master_revision, candidate_master_sha256: candidateSha256, changes: reportRows, assets: [...assetFiles.values()] }, null, 2));
