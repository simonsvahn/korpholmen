import assert from 'node:assert/strict';

import { MemoryRemoteTransport, MemoryStore } from '../../../packages/core/data-layer.js';
import { MasterConflictError } from '../../../packages/master-data-v2/index.js';
import { createFastigheterWriter } from '../src/fastigheter-writer.js';

const record = value => ({ updated_at: '2026-08-15T00:00:00.000Z', updated_by: 'test', ...value });
const source = {
  schema_version: 1,
  architecture_generation: 2,
  app: 'fastigheter',
  master_revision: 22,
  last_change_id: 'synthetic-fixture',
  updated_at: '2026-08-15T00:00:00.000Z',
  updated_by: 'test',
  data: {
    properties: [record({ id: 'Test 1:1', designation: 'Test 1:1', display_name: 'Test 1:1', place_refs: [], existence_status: 'active' })],
    timeline_entries: [record({ id: 'event:test', property_ids: ['Test 1:1'], entry_type: 'ownership', time: { kind: 'unknown', original_text: 'Okänt' }, chronology_order: 100, parties: [], related_properties: [], source_refs: [], note: 'Ursprunglig not.' })],
    affiliations: [],
    property_parties: [],
    identity_redirects: [],
  },
};

async function sha256Json(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function setup() {
  const remote = new MemoryRemoteTransport();
  const master = structuredClone(source);
  await remote.putImmutable('/fastigheter-generation2/revision-test/master.json', master);
  await remote.putMutable('/fastigheter-generation2/active.json', {
    schema_version: 1, app: 'fastigheter', mode: 'read_write', writer_enabled: true,
    master_revision: master.master_revision, master_sha256: await sha256Json(master), master_relative_path: 'revision-test/master.json',
  });
  return remote;
}

const remote = await setup();
const phone = createFastigheterWriter({ transport: remote, pendingStore: new MemoryStore(), now: () => '2026-08-15T18:00:00.000Z', createId: () => 'phone-save' });
const computer = createFastigheterWriter({ transport: remote, pendingStore: new MemoryStore(), now: () => '2026-08-15T18:01:00.000Z', createId: () => 'computer-save' });

const phoneBase = await phone.load();
const computerBase = await computer.load();
assert.equal(phoneBase.master.master_revision, 22);
assert.equal(computerBase.master.master_revision, 22);

const saved = await phone.saveTimelineEntry('event:test', { note: 'Uppdaterad not.' });
assert.equal(saved.master.master_revision, 23);
assert.equal(saved.receipt.changes.length, 1);
assert.equal(saved.receipt.changes[0].entity_id, 'event:test');
assert.equal((await phone.storage.listPending()).length, 0);

await assert.rejects(
  computer.saveProperty('Test 1:1', { display_name: 'Konfliktprov' }),
  MasterConflictError,
);
assert.equal((await computer.storage.getPending('fastigheter:computer-save')).state, 'conflict');

const invalid = createFastigheterWriter({ transport: remote, pendingStore: new MemoryStore(), now: () => '2026-08-15T18:02:00.000Z', createId: () => 'invalid-save' });
await invalid.load();
await assert.rejects(invalid.saveTimelineEntry('event:invalid', {
  property_ids: ['Test 9:999'], entry_type: 'ownership', time: { kind: 'unknown', original_text: 'Okänt' }, parties: [], related_properties: [], source_refs: [],
}), /okänd fastighet/);

const pointer = await remote.getJson('/fastigheter-generation2/active.json');
assert.equal(pointer.master_revision, 23);
assert.equal(pointer.writer_enabled, true);
console.log('Fastigheter V2-writer: provskrivning, historikkvitto, domänvalidering och konfliktspärr godkända');
