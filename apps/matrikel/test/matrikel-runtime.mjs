import assert from 'node:assert/strict';
import { MemoryStore } from '../../../packages/core/data-layer.js';
import { createEmptyMaster } from '../../../packages/master-data-v2/index.js';
import { createMatrikelActiveRuntime } from '../src/matrikel-runtime.js';

const encoder = new TextEncoder();

async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function addMaster(files, { root, app, revision, data, pointerFields = {}, writable = false }) {
  const master = {
    ...createEmptyMaster(app),
    master_revision: revision,
    data,
  };
  const masterBytes = encoder.encode(JSON.stringify(master));
  const masterHash = await sha256(masterBytes);
  const relativePath = `revision-${revision}/master.json`;
  const pointer = {
    schema_version: 1,
    app,
    mode: writable ? 'read_write' : 'read_only',
    writer_enabled: writable,
    master_revision: revision,
    master_sha256: masterHash,
    master_relative_path: relativePath,
    ...pointerFields,
  };
  files.set(`${root}/active.json`, encoder.encode(JSON.stringify(pointer)));
  files.set(`${root}/${relativePath}`, masterBytes);
  return { pointer, master, masterHash };
}

const files = new Map();
const people = await addMaster(files, {
  root: '/personer-familjer',
  app: 'people',
  revision: 2,
  data: {
    people: [
      { id: 'person-one', display_name: 'Person Ett', aliases: [], living: true },
      { id: 'person-two', display_name: 'Person Två', aliases: [], living: true },
    ],
  },
});
await addMaster(files, {
  root: '/batregister-generation2',
  app: 'batregister',
  revision: 3,
  data: { boats: [{ id: 'boat-one', display_name: 'Testbåten', category: 'rowboat', events: [] }] },
});
const matrikel = await addMaster(files, {
  root: '/matrikel-generation2',
  app: 'matrikel',
  revision: 10,
  pointerFields: {
    person_master_revision: people.pointer.master_revision,
    person_master_sha256: people.masterHash,
    manifest_relative_path: 'revision-10/manifest.json',
  },
  data: {
    memberships: [{
      id: 'membership:person-one',
      person_ref: { master: 'people', entity_type: 'person', entity_id: 'person-one' },
      membership_level: 'senior',
      club_name: 'Broder Test-Test',
    }],
    releases: [{ id: 'release-one', display_name: 'Medlemsmatrikel - 2000', year: 2000 }],
    person_occurrences: [{
      id: 'person-occurrence-one',
      release_id: 'release-one',
      order: 1,
      raw_name: 'Person Ett',
      person_ref: { master: 'people', entity_type: 'person', entity_id: 'person-one' },
    }],
    boat_occurrences: [{
      id: 'boat-occurrence-one',
      release_id: 'release-one',
      order: 1,
      raw_name: 'Testbåten',
      boat_ref: { master: 'boats', entity_type: 'boat', entity_id: 'boat-one' },
    }],
    organizations: [],
    roles: [],
    role_terms: [],
    awards: [],
    award_events: [],
  },
});

const sourceArchive = {
  ...createEmptyMaster('matrikel'),
  master_revision: 8,
  data: {
    source_rows: [
      {
        id: 'source-row:member:one',
        release_id: 'release-one',
        source_document_id: 'source-document:release-one',
        kind: 'person',
        order: 1,
        source_page: 1,
        raw_text: '1953   Person Ett',
        retained: true,
      },
      {
        id: 'source-row:boat:one',
        release_id: 'release-one',
        source_document_id: 'source-document:release-one',
        kind: 'boat',
        order: 1,
        source_page: 1,
        raw_text: 'M/S Testbåten (1962)',
        retained: true,
      },
      {
        id: 'source-row:archived',
        release_id: 'release-one',
        kind: 'person',
        order: 2,
        raw_text: 'Arkiverad variant',
        retained: false,
        lifecycle_status: 'archived_variant',
      },
    ],
    source_layout_rows: [{
      id: 'source-layout-row:one',
      release_id: 'release-one',
      source_document_id: 'source-document:release-one',
      order: 1,
      source_page: 1,
      kind: 'member',
      member_source_row_id: 'source-row:member:one',
      boat_source_row_ids: ['source-row:boat:one'],
      retained: true,
    }],
  },
};
const sourceArchiveBytes = encoder.encode(JSON.stringify(sourceArchive));
const sourceArchiveHash = await sha256(sourceArchiveBytes);
files.set('/matrikel-generation2/revision-8/master.json', sourceArchiveBytes);
files.set('/matrikel-generation2/revision-10/manifest.json', encoder.encode(JSON.stringify({
  schema_version: 1,
  app: 'matrikel',
  master_revision: matrikel.master.master_revision,
  master_sha256: matrikel.masterHash,
  source_archive: {
    master_relative_path: 'revision-8/master.json',
    master_sha256: sourceArchiveHash,
  },
})));

const transport = {
  getBytes: async path => {
    const bytes = files.get(path);
    if (!bytes) throw new Error(`Testfil saknas: ${path}`);
    return bytes;
  },
};

const store = new MemoryStore();
const runtime = await createMatrikelActiveRuntime({ store }).init();
assert.equal(runtime.hasData(), false);
const synced = await runtime.sync(transport);
assert.equal(synced.matrikelRevision, 10);
assert.equal(synced.peopleRevision, 2);
assert.equal(synced.boatRevision, 3);
assert.equal(synced.writable, false);
assert.equal(synced.sourceRows, 2);
assert.equal(synced.sourceLayoutRows, 1);
assert.equal(runtime.repository.listEntities('membership').length, 1);
assert.equal(runtime.repository.listEntities('person-occurrence').length, 1);
assert.equal(runtime.repository.listEntities('boat-occurrence').length, 1);
assert.equal(runtime.repository.listEntities('source-row').length, 2);
assert.equal(runtime.repository.listEntities('source-layout-row').length, 1);
assert.deepEqual(runtime.repository.getEntity('source-layout-row', 'source-layout-row:one').fields.boat_source_row_ids, ['source-row:boat:one']);
assert.equal(runtime.repository.getEntity('source-row', 'source-row:boat:one').fields.raw_text, 'M/S Testbåten (1962)');
assert.equal(runtime.repository.listEntities('person-ref').length, 2);
assert.equal(runtime.repository.listEntities('boat-ref').length, 1);
assert.ok(runtime.personMaster.getEntity('person', 'person-one'));

const offline = await createMatrikelActiveRuntime({ store }).init();
assert.equal(offline.hasData(), true);
assert.equal(offline.repository.listEntities('membership').length, 1);
assert.equal(offline.repository.listEntities('source-row').length, 2);
assert.equal(offline.repository.listEntities('source-layout-row').length, 1);
assert.equal(offline.repository.getEntity('boat-occurrence', 'boat-occurrence-one').fields.boat_ref.entity_id, 'boat-one');
console.log('Matrikel V2-runtime: ren master, personer, båtar och offlinecache godkända');
