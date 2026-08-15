import assert from 'node:assert/strict';

import { MemoryRemoteTransport, MemoryStore } from '../../../packages/core/data-layer.js';
import { MasterConflictError } from '../../../packages/master-data-v2/index.js';
import { createBatregisterWriter } from '../src/batregister-writer.js';

const record = value => ({ updated_at: '2026-08-15T00:00:00.000Z', updated_by: 'test', ...value });
const master = {
  schema_version: 1,
  architecture_generation: 2,
  app: 'batregister',
  master_revision: 3,
  last_change_id: 'synthetic-fixture',
  updated_at: '2026-08-15T00:00:00.000Z',
  updated_by: 'test',
  data: {
    boats: [record({
      id: 'testbaten',
      display_name: 'Testbåten',
      category: 'rowboat',
      events: [{
        id: 'event:testbaten:registered',
        event_type: 'registered',
        time: { kind: 'point', start_min: 2001, start_max: 2001, precision: 'year', original_text: '2001' },
        participants: [{
          role: 'owner',
          party_ref: { master: 'people', entity_type: 'person', entity_id: 'testperson' },
        }],
      }],
      source_ids: ['source:test'],
    })],
    identity_redirects: [],
  },
};

async function sha256Json(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const remote = new MemoryRemoteTransport();
const masterHash = await sha256Json(master);
await remote.putImmutable('/batregister-generation2/copy/master.json', master);
await remote.putMutable('/batregister-generation2/active.json', {
  schema_version: 1, app: 'batregister', mode: 'read_write', writer_enabled: true,
  master_revision: master.master_revision,
  master_sha256: masterHash, master_relative_path: 'copy/master.json',
});

const phone = createBatregisterWriter({ transport: remote, pendingStore: new MemoryStore(), now: () => '2026-08-15T19:00:00.000Z', createId: () => 'phone-save' });
const computer = createBatregisterWriter({ transport: remote, pendingStore: new MemoryStore(), now: () => '2026-08-15T19:01:00.000Z', createId: () => 'computer-save' });
const phoneBase = await phone.load();
const computerBase = await computer.load();
const target = phoneBase.master.data.boats.find(row => !row.deleted_at);
const saved = await phone.saveBoat(target.id, { display_name: `${target.display_name} · kopieprov` });
assert.equal(saved.master.master_revision, master.master_revision + 1);
assert.equal(saved.receipt.base_master_revision, master.master_revision);
assert.equal((await phone.storage.listPending()).length, 0);
await assert.rejects(computer.saveBoat(target.id, { display_name: 'Föråldrad flik' }), MasterConflictError);
assert.equal((await computer.storage.getPending('batregister:computer-save')).state, 'conflict');

const invalid = createBatregisterWriter({ transport: remote, pendingStore: new MemoryStore(), now: () => '2026-08-15T19:02:00.000Z', createId: () => 'invalid' });
await invalid.load();
await assert.rejects(invalid.saveBoat(target.id, { category: 'flygplan' }), /category är ogiltig/);
console.log('Båtregister V2-writer: provskrivning, domänvalidering och konfliktspärr godkända på datafri minneskopia');
