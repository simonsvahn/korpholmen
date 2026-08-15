import assert from 'node:assert/strict';
import { MemoryRemoteTransport, MemoryStore } from '../../../packages/core/data-layer.js';
import { createEmptyMaster, MasterConflictError } from '../../../packages/master-data-v2/index.js';
import { createMatrikelMembershipWriter } from '../src/matrikel-writer.js';

const source = createEmptyMaster('matrikel');
source.master_revision = 10;
source.data = {
  memberships: [
    {
      id: 'membership:senior-test',
      person_ref: { master: 'people', entity_type: 'person', entity_id: 'senior-test' },
      membership_level: 'senior',
      club_name: 'Broder Test-Test',
    },
    {
      id: 'membership:junior-test',
      person_ref: { master: 'people', entity_type: 'person', entity_id: 'junior-test' },
      membership_level: 'junior',
    },
  ],
  releases: [],
  person_occurrences: [],
  boat_occurrences: [],
  organizations: [],
  roles: [],
  role_terms: [],
  awards: [],
  award_events: [],
};

async function sha256Json(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function setup() {
  const remote = new MemoryRemoteTransport();
  const master = structuredClone(source);
  const hash = await sha256Json(master);
  await remote.putImmutable('/matrikel-generation2/revision-test/master.json', master);
  await remote.putMutable('/matrikel-generation2/active.json', {
    schema_version: 1,
    app: 'matrikel',
    mode: 'read_write',
    writer_enabled: true,
    master_revision: master.master_revision,
    master_sha256: hash,
    master_relative_path: 'revision-test/master.json',
  });
  return { remote, master };
}

const { remote } = await setup();
const phone = createMatrikelMembershipWriter({
  transport: remote,
  pendingStore: new MemoryStore(),
  now: () => '2026-08-15T17:30:00.000Z',
  createId: () => 'phone-save',
});
const computer = createMatrikelMembershipWriter({
  transport: remote,
  pendingStore: new MemoryStore(),
  now: () => '2026-08-15T17:31:00.000Z',
  createId: () => 'computer-save',
});
const phoneBase = await phone.load();
const computerBase = await computer.load();
assert.equal(phoneBase.master.master_revision, 10);
assert.equal(computerBase.master.master_revision, 10);

const target = phoneBase.master.data.memberships.find(row => !row.deleted_at);
const personId = target.person_ref.entity_id;
const originalParticipation = target.participation ?? null;
const saved = await phone.saveMembership(personId, { participation: originalParticipation === 'passive' ? null : 'passive' });
assert.equal(saved.master.master_revision, 11);
assert.equal(saved.receipt.changes.length, 1);
assert.equal(saved.receipt.changes[0].entity_id, target.id);

await assert.rejects(
  computer.saveMembership(personId, { club_name: 'Broder Konfliktprov' }),
  MasterConflictError,
);
assert.equal((await computer.storage.getPending('matrikel-membership:computer-save')).state, 'conflict');

const clean = createMatrikelMembershipWriter({
  transport: remote,
  pendingStore: new MemoryStore(),
  now: () => '2026-08-15T17:32:00.000Z',
  createId: () => 'invalid-save',
});
const cleanBase = await clean.load();
const junior = cleanBase.master.data.memberships.find(row => !row.deleted_at && row.membership_level === 'junior');
assert.ok(junior, 'Testmastern ska innehålla minst en junior för valideringsprovet');
await assert.rejects(clean.saveMembership(junior.person_ref.entity_id, { membership_form: 'corresponding' }), /korresponderande junior/);

const currentPointer = await remote.getJson('/matrikel-generation2/active.json');
assert.equal(currentPointer.master_revision, 11);
assert.equal(currentPointer.writer_enabled, true);
assert.equal((await phone.storage.listPending()).length, 0);
console.log('Matrikel V2-writer: provskrivning, historikkvitto och konfliktspärr godkända');
