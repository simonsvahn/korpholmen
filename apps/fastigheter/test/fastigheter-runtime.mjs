import assert from 'node:assert/strict';

import { MemoryRemoteTransport, MemoryStore } from '../../../packages/core/data-layer.js';
import { createFastigheterActiveRuntime } from '../src/fastigheter-runtime.js';

const record = value => ({ updated_at: '2026-08-15T00:00:00.000Z', updated_by: 'test', ...value });
const properties = {
  schema_version: 1,
  architecture_generation: 2,
  app: 'fastigheter',
  master_revision: 22,
  last_change_id: 'synthetic-fixture',
  updated_at: '2026-08-15T00:00:00.000Z',
  updated_by: 'test',
  data: {
    properties: [record({ id: 'Test 1:1', designation: 'Test 1:1', display_name: 'Test 1:1', place_refs: [{ master: 'kartdata', entity_type: 'place', entity_id: 'place:test' }], existence_status: 'active' })],
    timeline_entries: [
      record({ id: 'event:early', property_ids: ['Test 1:1'], entry_type: 'ownership', time: { kind: 'point', original_text: '1900', start_min: 1900, start_max: 1900 }, chronology_order: 100, parties: [], related_properties: [], source_refs: [] }),
      record({ id: 'event:open', property_ids: ['Test 1:1'], entry_type: 'ownership', time: { kind: 'unknown', original_text: 'efter 1900' }, chronology_order: 200, parties: [], related_properties: [], source_refs: [] }),
      record({ id: 'event:current', property_ids: ['Test 1:1'], entry_type: 'current_ownership', time: { kind: 'observation', original_text: '2026', start_min: 2026, start_max: 2026 }, chronology_order: 300, parties: [{ party_ref: { master: 'people', entity_type: 'person', entity_id: 'person:test' }, role: 'ägare' }], related_properties: [], source_refs: [] }),
    ],
    affiliations: [],
    property_parties: [],
    identity_redirects: [],
  },
};
const people = {
  schema_version: 1,
  architecture_generation: 2,
  app: 'people',
  master_revision: 21,
  last_change_id: 'synthetic-fixture',
  updated_at: '2026-08-15T00:00:00.000Z',
  updated_by: 'test',
  data: { people: [record({ id: 'person:test', display_name: 'Testperson' })] },
};
const kartdata = {
  schema_version: 1,
  architecture_generation: 2,
  app: 'kartdata',
  master_revision: 1,
  last_change_id: 'synthetic-fixture',
  updated_at: '2026-08-15T00:00:00.000Z',
  updated_by: 'test',
  data: { places: [record({ id: 'place:test', preferred_name: 'Testön' })], entries: [] },
};

async function hash(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const [propertyHash, peopleHash, kartdataHash] = await Promise.all([hash(properties), hash(people), hash(kartdata)]);
const remote = new MemoryRemoteTransport();
await remote.putImmutable('/fastigheter-generation2/revision-test/master.json', properties);
await remote.putImmutable('/personer-familjer/revision-test/master.json', people);
await remote.putImmutable('/kartdata-generation2/revision-test/master.json', kartdata);
await remote.putMutable('/fastigheter-generation2/active.json', {
  schema_version: 1, app: 'fastigheter', mode: 'read_only', writer_enabled: false,
  master_revision: properties.master_revision, master_sha256: propertyHash, master_relative_path: 'revision-test/master.json',
  person_master_revision: people.master_revision, person_master_sha256: peopleHash,
});
await remote.putMutable('/personer-familjer/active.json', {
  schema_version: 1, app: 'people', mode: 'read_only', writer_enabled: false,
  master_revision: people.master_revision, master_sha256: peopleHash, master_relative_path: 'revision-test/master.json',
});
await remote.putMutable('/kartdata-generation2/active.json', {
  schema_version: 1, app: 'kartdata', mode: 'read_only', writer_enabled: false,
  master_revision: kartdata.master_revision, master_sha256: kartdataHash, master_relative_path: 'revision-test/master.json',
  property_master_revision: properties.master_revision, property_master_sha256: propertyHash,
});

const runtime = await createFastigheterActiveRuntime({ store: new MemoryStore() }).init();
assert.equal(runtime.hasData(), false);
const result = await runtime.sync(remote);
assert.deepEqual(result, { propertyRevision: 22, peopleRevision: 21, kartdataRevision: 1, writable: false });
assert.equal(runtime.listProperties().length, 1);
assert.deepEqual(runtime.timelineFor('Test 1:1').map(row => row.id), ['event:early', 'event:open', 'event:current']);
assert.equal(runtime.currentOwners('Test 1:1')[0].resolved.display_name, 'Testperson');
assert.deepEqual(runtime.placeNames(runtime.getProperty('Test 1:1')), ['Testön']);
console.log('Fastigheter V2-runtime: master, beroenden, tidslinje, ägare och platsnamn godkända');
