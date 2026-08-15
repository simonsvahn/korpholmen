import assert from 'node:assert/strict';

import { MemoryRemoteTransport, MemoryStore } from '../../../packages/core/data-layer.js';
import { createBatregisterActiveRuntime } from '../src/batregister-runtime.js';
import { boatTimeLabel, CATEGORY_LABELS, EVENT_LABELS } from '../src/batregister-v2-ui.js';

const record = value => ({ updated_at: '2026-08-15T00:00:00.000Z', updated_by: 'test', ...value });
const people = {
  schema_version: 1, architecture_generation: 2, app: 'people', master_revision: 21,
  last_change_id: 'fixture', updated_at: '2026-08-15T00:00:00.000Z', updated_by: 'test',
  data: {
    people: [record({ id: 'person:test', display_name: 'Testperson', living: true })],
    family_units: [record({ id: 'family:test', display_name: 'Familjen Test', allowed_as_owner_target: true })],
  },
};
const boats = {
  schema_version: 1, architecture_generation: 2, app: 'batregister', master_revision: 3,
  last_change_id: 'fixture', updated_at: '2026-08-15T00:00:00.000Z', updated_by: 'test',
  data: {
    boats: [record({
      id: 'testbaten', display_name: 'Testbåten', category: 'rowboat',
      events: [
        { id: 'event:late', event_type: 'sold', time: { kind: 'point', start_min: 2005, start_max: 2005, precision: 'year' }, participants: [{ role: 'owner', party_ref: { master: 'people', entity_type: 'person', entity_id: 'person:test' } }] },
        { id: 'event:early', event_type: 'registered', time: { kind: 'point', start_min: 1999, start_max: 1999, precision: 'year' }, participants: [{ role: 'owner', party_ref: { master: 'people', entity_type: 'family_unit', entity_id: 'family:test' } }] },
      ],
    })],
    identity_redirects: [],
  },
};

async function hash(value) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const [boatHash, peopleHash] = await Promise.all([hash(boats), hash(people)]);
const remote = new MemoryRemoteTransport();
await remote.putImmutable('/batregister-generation2/revision-test/master.json', boats);
await remote.putImmutable('/personer-familjer/revision-test/master.json', people);
await remote.putMutable('/batregister-generation2/active.json', {
  schema_version: 1, app: 'batregister', mode: 'read_only', writer_enabled: false,
  master_revision: boats.master_revision, master_sha256: boatHash, master_relative_path: 'revision-test/master.json',
  people_master_revision: people.master_revision, people_master_sha256: peopleHash,
});
await remote.putMutable('/personer-familjer/active.json', {
  schema_version: 1, app: 'people', mode: 'read_only', writer_enabled: false,
  master_revision: people.master_revision, master_sha256: peopleHash, master_relative_path: 'revision-test/master.json',
});

const runtime = await createBatregisterActiveRuntime({ store: new MemoryStore() }).init();
assert.equal(runtime.hasData(), false);
assert.deepEqual(await runtime.sync(remote), { boatRevision: 3, peopleRevision: 21, writable: false });
assert.deepEqual(runtime.eventsFor('testbaten').map(row => row.id), ['event:early', 'event:late']);
assert.deepEqual(runtime.latestOwners('testbaten'), []);
assert.equal(runtime.ownersForEvent(runtime.eventsFor('testbaten').at(-1))[0].display_name, 'Testperson');
assert.equal(runtime.resolveParty({ master: 'people', entity_type: 'family_unit', entity_id: 'family:test' }).display_name, 'Familjen Test');
assert.deepEqual(runtime.partyOptions().map(row => row.label), ['Familjen Test', 'Testperson']);
assert.equal(boatTimeLabel({ kind: 'period', start_min: 1970, end_max: 1979 }), '1970–1979');
assert.equal(CATEGORY_LABELS.rowboat, 'Rodbåt');
assert.equal(EVENT_LABELS.registered, 'Inregistrerad');
console.log('Båtregister V2-runtime och enkel vylogik: beroende, tidslinje, ägare, kategorier och årtal godkända');
