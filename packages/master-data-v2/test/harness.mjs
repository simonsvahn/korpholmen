import assert from 'node:assert/strict';
import {
  applyMasterChange,
  assertWriterDomainFields,
  assertMaster,
  assertBoatCategory,
  assertIdentityRedirect,
  assertPersonRecord,
  assertStableReference,
  assertStructuredEvent,
  assertStructuredTime,
  createEmptyMaster,
  deriveFamilyUnitCandidates,
  familyAnchorKey,
  HistoryPendingError,
  MasterConflictError,
  MasterRepository,
  MasterValidationError,
  MemoryMasterStorage,
  planMissingFamilyUnits,
  RevisionMasterStorage,
} from '../index.js';
import { MemoryRemoteTransport, MemoryStore } from '../../core/data-layer.js';

const at = (minute) => `2026-08-08T01:${String(minute).padStart(2, '0')}:00.000Z`;

function request(base, changeId, mutations, minute = 30) {
  return {
    change_id: changeId,
    expected_master_revision: base.master.master_revision,
    expected_storage_revision: base.storage_revision,
    changed_at: at(minute),
    changed_by: 'simon',
    manual_comment: '',
    mutations,
  };
}

async function setup(app = 'boats') {
  const storage = new MemoryMasterStorage(createEmptyMaster(app));
  return { storage, repository: new MasterRepository(storage), base: await storage.loadMaster() };
}

async function sha256Json(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function setupRevisionStorage(app = 'boats') {
  const remote = new MemoryRemoteTransport();
  const master = createEmptyMaster(app);
  const masterSha256 = await sha256Json(master);
  const masterRelativePath = `revisions/revision-0-${masterSha256.slice(0, 12)}/master.json`;
  await remote.putImmutable(`/${app}-generation2/${masterRelativePath}`, master);
  await remote.putMutable(`/${app}-generation2/active.json`, {
    schema_version: 1,
    app,
    mode: 'read_write',
    writer_enabled: true,
    master_revision: 0,
    master_sha256: masterSha256,
    master_relative_path: masterRelativePath,
    updated_at: null,
    updated_by: null,
  });
  const pendingStore = new MemoryStore();
  const storage = new RevisionMasterStorage({
    app,
    pointerPath: `/${app}-generation2/active.json`,
    transport: remote,
    pendingStore,
  });
  return { remote, pendingStore, storage, repository: new MasterRepository(storage), base: await storage.loadMaster() };
}

{
  const people = ['anna', 'peter', 'barn', 'tidigare', 'ogranskad'].map((id) => ({ id, display_name: id[0].toUpperCase() + id.slice(1) }));
  const relations = [
    { id: 'partner', relation_type: 'partner', from_person_id: 'anna', to_person_id: 'peter', needs_review: false },
    { id: 'anna-barn', relation_type: 'foralder-barn', from_person_id: 'anna', to_person_id: 'barn', needs_review: false },
    { id: 'peter-barn', relation_type: 'foralder-barn', from_person_id: 'peter', to_person_id: 'barn', needs_review: false },
    { id: 'tidigare', relation_type: 'tidigare', from_person_id: 'anna', to_person_id: 'tidigare', needs_review: false },
    { id: 'ogranskad', relation_type: 'partner', from_person_id: 'anna', to_person_id: 'ogranskad', needs_review: true },
  ];
  assert.equal(familyAnchorKey(['peter', 'anna']), 'anna|peter');
  const candidates = deriveFamilyUnitCandidates({ people, relations });
  assert.deepEqual(candidates.map((row) => row.anchor_person_ids), [['anna', 'peter'], ['anna', 'tidigare']]);
  const planned = planMissingFamilyUnits({
    people,
    relations,
    familyUnits: [{ id: 'familj-1', reference_code: 'FAMILJ-001', anchor_person_ids: ['anna', 'peter'] }],
    createId: (ids) => `family-unit:test:${ids.join('-')}`,
    changedAt: at(19),
    changedBy: 'simon',
    decisionId: 'automatic-family-test',
  });
  assert.equal(planned.missing.length, 1);
  assert.equal(planned.missing[0].reference_code, 'FAMILJ-002');
  assert.deepEqual(planned.missing[0].anchor_person_ids, ['anna', 'tidigare']);
  assert.equal(planned.missing[0].allowed_as_owner_target, true);
  assert.match(planned.missing[0].decision_scope, /Fastställer inte båtägande/i);
  const noOp = planMissingFamilyUnits({
    people,
    relations,
    familyUnits: [...planned.missing, { id: 'familj-1', reference_code: 'FAMILJ-001', anchor_person_ids: ['anna', 'peter'] }],
    createId: (ids) => `family-unit:test:${ids.join('-')}`,
    changedAt: at(19),
    changedBy: 'simon',
    decisionId: 'automatic-family-test',
  });
  assert.equal(noOp.missing.length, 0);
}

{
  const master = createEmptyMaster('people');
  assertMaster(master, { app: 'people' });
  assertBoatCategory('motorboat');
  assertStableReference({ master: 'people', entity_type: 'person', entity_id: 'anna' });
  assertStructuredTime({ kind: 'period', original_text: '1970-talet', start_min: 1970, start_max: 1979, precision: 'decade' });
  assertStructuredEvent({
    event_type: 'registered',
    time: { kind: 'point', original_text: 'inreg. 1962', start_min: 1962, start_max: 1962, precision: 'year' },
    participants: [{
      party_ref: { master: 'people', entity_type: 'person', entity_id: 'perolofbethge' },
      role: 'owner',
    }],
  });
  assertStructuredEvent({
    event_type: 'ownership',
    participants: [{
      party_ref: { master: 'people', entity_type: 'family_unit', entity_id: 'family-unit:20260802:004' },
      role: 'owner',
    }],
  });
  assertPersonRecord({
    id: 'aina-sjoblom',
    display_name: 'Aina Sjöblom',
    aliases: [],
    death_time: { kind: 'point', original_text: 'avliden' },
    living: false,
    context_note: 'Historisk handlare i Glyxnäs; finns med för lokala personkopplingar.',
  });
  assertPersonRecord({ id: 'okand', display_name: 'Okänd livsstatus', aliases: [], living: null });
  assert.throws(() => assertPersonRecord({ id: 'utan-liv', display_name: 'Utan livsstatus', aliases: [] }), /living måste väljas/);
  assertIdentityRedirect({
    id: 'extern-erik-akerman',
    target_person_id: 'erikåkerman',
    decision_id: 'decision-1',
  });
  assert.throws(() => assertPersonRecord({ id: 'fel', display_name: 'Fel', living: true, death_time: { kind: 'point' } }), MasterValidationError);
  assert.throws(() => assertStructuredTime({ kind: 'period', precision: 'maybe' }), MasterValidationError);
  assert.throws(() => assertBoatCategory('motorbåt'), MasterValidationError);
  assert.throws(() => assertStructuredEvent({ event_type: 'inregistrerad', time: { kind: 'point' } }), MasterValidationError);
  assert.throws(() => assertStructuredEvent({
    event_type: 'registered',
    time: { kind: 'point', start_min: 1962, start_max: 1962, precision: 'year' },
  }), MasterValidationError);
  assertStructuredEvent({
    event_type: 'name_decided',
    decided_name: 'Daniel Westerlings Prinskorv',
    time: { kind: 'point', start_min: 2009, start_max: 2009, precision: 'year' },
  });
  assert.throws(() => assertStructuredEvent({
    event_type: 'name_decided',
    time: { kind: 'point', start_min: 2009, start_max: 2009, precision: 'year' },
  }), MasterValidationError);
  assertStructuredEvent({
    event_type: 'renamed',
    name_before: 'Filifjonkan',
    name_after: 'Filifjonkan I',
    time: { kind: 'point', start_min: 1980, start_max: 1980, precision: 'year' },
  });
  assert.throws(() => assertStructuredEvent({
    event_type: 'renamed',
    time: { kind: 'point', start_min: 1980, start_max: 1980, precision: 'year' },
  }), MasterValidationError);
  const storage = new MemoryMasterStorage(master);
  await assert.rejects(new MasterRepository(storage).save({ expected_master_revision: 0, expected_storage_revision: 'memory-0' }), MasterValidationError);
  assert.equal((await storage.listPending()).length, 0);
}

{
  const base = createEmptyMaster('people');
  await assert.rejects(applyMasterChange(base, {
    change_id: 'person-without-life-status',
    expected_master_revision: 0,
    changed_at: at(19),
    changed_by: 'simon',
    mutations: [{ collection: 'people', entity_id: 'utan-liv', action: 'upsert', set: { display_name: 'Utan livsstatus', aliases: [] } }],
  }), /living måste väljas/);
  const created = await applyMasterChange(base, {
    change_id: 'create-before-image-test',
    expected_master_revision: 0,
    changed_at: at(20),
    changed_by: 'simon',
    mutations: [{ collection: 'people', entity_id: 'maria', action: 'upsert', set: { display_name: 'Maria', aliases: [], living: null } }],
  });
  const updated = await applyMasterChange(created.master, {
    change_id: 'update-before-image-test',
    expected_master_revision: 1,
    changed_at: at(21),
    changed_by: 'simon',
    mutations: [{ collection: 'people', entity_id: 'maria', action: 'upsert', set: { aliases: ['Maria Une'] } }],
  });
  assert.deepEqual(updated.receipt.changes[0].before.aliases, []);
  assert.deepEqual(updated.receipt.changes[0].after.aliases, ['Maria Une']);
  assert.deepEqual(created.master.data.people[0].aliases, []);
}

{
  const { storage, repository, base } = await setup();
  const saved = await repository.save(request(base, 'change-one-save', [{
    collection: 'boats',
    entity_id: 'dagen',
    action: 'upsert',
    set: { display_name: 'Dagen', year: 1974, needs_review: true, review_comment: 'Ägare och år behöver avgöras.' },
  }]));
  assert.equal(saved.master.master_revision, 1);
  assert.equal(saved.master.data.boats[0].display_name, 'Dagen');
  assert.equal(saved.receipt.changes.length, 1);
  assert.equal((await storage.listPending()).length, 0);
}

{
  const { storage, repository, base } = await setup('people');
  const firstRequest = request(base, 'same-change-id', [{ collection: 'people', entity_id: 'anna', action: 'upsert', set: { display_name: 'Anna', living: null } }]);
  const first = await repository.save(firstRequest);
  const retried = await repository.save(firstRequest);
  assert.equal(first.master.master_revision, 1);
  assert.equal(retried.master.master_revision, 1);
  assert.equal(retried.idempotent, true);
  assert.equal(storage.receipts.size, 1);
}

{
  const { storage, repository, base } = await setup('people');
  await repository.save(request(base, 'phone-save', [{ collection: 'people', entity_id: 'anna', action: 'upsert', set: { display_name: 'Anna', living: null } }]));
  await assert.rejects(
    repository.save(request(base, 'stale-computer-save', [{ collection: 'people', entity_id: 'peter', action: 'upsert', set: { display_name: 'Peter', living: true } }], 31)),
    MasterConflictError,
  );
  const current = await storage.loadMaster();
  assert.deepEqual(current.master.data.people.map((person) => person.id), ['anna']);
  assert.equal((await storage.getPending('stale-computer-save')).state, 'conflict');
}

{
  const { storage, repository, base } = await setup('race');
  const mutations = Array.from({ length: 200 }, (_, index) => ({
    collection: 'results',
    entity_id: `result-${index + 1}`,
    action: 'upsert',
    set: { place: index + 1 },
  }));
  const saved = await repository.save(request(base, 'ai-batch-200', mutations));
  assert.equal(saved.master.master_revision, 1);
  assert.equal(saved.master.data.results.length, 200);
  assert.equal(saved.receipt.changes.length, 200);
}

{
  const { storage, repository, base } = await setup('race');
  const badBatch = request(base, 'invalid-batch', [
    { collection: 'results', entity_id: 'valid', action: 'upsert', set: { place: 1 } },
    { collection: 'results', entity_id: '', action: 'upsert', set: { place: 2 } },
  ]);
  await assert.rejects(repository.save(badBatch), MasterValidationError);
  const current = await storage.loadMaster();
  assert.equal(current.master.master_revision, 0);
  assert.deepEqual(current.master.data, {});
  assert.equal((await storage.getPending('invalid-batch')).state, 'validation_error');
}

{
  const { storage, repository, base } = await setup('boats');
  const created = await repository.save(request(base, 'create-boat', [{ collection: 'boats', entity_id: 'dagen', action: 'upsert', set: { display_name: 'Dagen' } }]));
  const removed = await repository.save(request(created, 'delete-boat', [{ collection: 'boats', entity_id: 'dagen', action: 'delete' }], 32));
  assert.equal(removed.master.data.boats[0].deleted_by, 'simon');
  const restored = await repository.save(request(removed, 'restore-boat', [{ collection: 'boats', entity_id: 'dagen', action: 'restore' }], 33));
  assert.equal('deleted_at' in restored.master.data.boats[0], false);
}

{
  const { storage, repository, base } = await setup('documents');
  storage.failNextHistoryReceipt();
  const saveRequest = request(base, 'receipt-retry', [{ collection: 'documents', entity_id: 'doc-1', action: 'upsert', set: { title: 'Protokoll' } }]);
  await assert.rejects(repository.save(saveRequest), HistoryPendingError);
  assert.equal((await storage.loadMaster()).master.master_revision, 1);
  assert.equal((await storage.getPending('receipt-retry')).state, 'master_committed');
  const recovered = await repository.save(saveRequest);
  assert.equal(recovered.idempotent, true);
  assert.equal((await storage.listPending()).length, 0);
}

{
  const { remote, storage, repository, base } = await setupRevisionStorage('boats');
  const saved = await repository.save(request(base, 'dropbox-style-save', [{
    collection: 'boats',
    entity_id: 'dagen',
    action: 'upsert',
    set: { display_name: 'Dagen' },
  }], 40));
  assert.equal(saved.master.master_revision, 1);
  assert.equal(saved.master.data.boats[0].display_name, 'Dagen');
  assert.match(saved.master_path, /revision-1-[a-f0-9]{12}\/master\.json$/);
  assert.equal((await storage.listPending()).length, 0);
  const pointer = await remote.getJson('/boats-generation2/active.json');
  assert.equal(pointer.mode, 'read_write');
  assert.equal(pointer.writer_enabled, true);
  assert.equal(pointer.master_revision, 1);
  assert.equal((await storage.getHistoryReceipt('dropbox-style-save')).new_master_revision, 1);
}

{
  const { remote, base, repository } = await setupRevisionStorage('race');
  const secondStorage = new RevisionMasterStorage({
    app: 'race',
    pointerPath: '/race-generation2/active.json',
    transport: remote,
    pendingStore: new MemoryStore(),
  });
  const secondRepository = new MasterRepository(secondStorage);
  await repository.save(request(base, 'phone-v2-save', [{ collection: 'results', entity_id: 'r1', action: 'upsert', set: { year: 2026 } }], 41));
  await assert.rejects(
    secondRepository.save(request(base, 'computer-v2-save', [{ collection: 'results', entity_id: 'r2', action: 'upsert', set: { year: 2026 } }], 42)),
    MasterConflictError,
  );
  assert.deepEqual((await secondStorage.loadMaster()).master.data.results.map(row => row.id), ['r1']);
}

{
  const { remote } = await setupRevisionStorage('people');
  const pointer = await remote.getJson('/people-generation2/active.json');
  await remote.putMutable('/people-generation2/active.json', { ...pointer, mode: 'read_only', writer_enabled: false });
  const storage = new RevisionMasterStorage({
    app: 'people',
    pointerPath: '/people-generation2/active.json',
    transport: remote,
    pendingStore: new MemoryStore(),
  });
  await assert.rejects(storage.loadMaster(), /inte aktiverad för skrivning/);
}

{
  const matrikel = createEmptyMaster('matrikel');
  matrikel.data.memberships = [{ id: 'membership:anna', person_ref: { master: 'people', entity_type: 'person', entity_id: 'anna' }, membership_level: 'junior' }];
  assertWriterDomainFields(matrikel);
  const seniorWithoutClubName = createEmptyMaster('matrikel');
  seniorWithoutClubName.data.memberships = [{
    id: 'membership:bo',
    person_ref: { master: 'people', entity_type: 'person', entity_id: 'bo' },
    membership_level: 'senior',
    historical_club_names: [{ name: 'Broder Test-Alexander', release_ids: ['matrikel-1987'] }],
  }];
  assertWriterDomainFields(seniorWithoutClubName);
  const invalidHistoricalClubName = structuredClone(seniorWithoutClubName);
  invalidHistoricalClubName.data.memberships[0].historical_club_names = [{ name: '', release_ids: ['matrikel-1987'] }];
  assert.throws(() => assertWriterDomainFields(invalidHistoricalClubName), /historical_club_names/);
  const duplicateMembership = structuredClone(seniorWithoutClubName);
  duplicateMembership.data.memberships.push({ id: 'membership:bo-2', person_ref: { master: 'people', entity_type: 'person', entity_id: 'bo' }, membership_level: 'senior' });
  assert.throws(() => assertWriterDomainFields(duplicateMembership), /Dubblerad aktiv medlemsrad/);
  const correspondingJunior = createEmptyMaster('matrikel');
  correspondingJunior.data.memberships = [{ id: 'membership:barn', person_ref: { master: 'people', entity_type: 'person', entity_id: 'barn' }, membership_level: 'junior', membership_form: 'corresponding' }];
  assert.throws(() => assertWriterDomainFields(correspondingJunior), /korresponderande junior/);
  matrikel.data.memberships[0].migration_source = 'legacy';
  assert.throws(() => assertWriterDomainFields(matrikel), /Okända vardagsfält/);
  const fastigheter = createEmptyMaster('fastigheter');
  fastigheter.data.properties = [{ id: 'Alsvik 3:26', designation: 'Alsvik 3:26', display_name: 'Alsvik 3:26', place_refs: [], existence_status: 'active' }];
  fastigheter.data.property_parties = [];
  fastigheter.data.affiliations = [];
  fastigheter.data.identity_redirects = [];
  fastigheter.data.timeline_entries = [{
    id: 'timeline:1', property_ids: ['Alsvik 3:26'], entry_type: 'ownership',
    time: { kind: 'unknown', original_text: 'Tid okänd' },
    parties: [{ party_ref: { master: 'people', entity_type: 'person', entity_id: 'anna' }, role: 'ägare' }],
    related_properties: [], source_refs: [],
  }];
  assertWriterDomainFields(fastigheter);

  const batregister = createEmptyMaster('batregister');
  batregister.data.boats = [{
    id: 'testbaten',
    display_name: 'Testbåten',
    category: 'motorboat',
    vessel_designation: 'M/S',
    vessel_type: 'Skärgårdssnipa',
  }];
  batregister.data.identity_redirects = [];
  assertWriterDomainFields(batregister);
  batregister.data.boats[0].vessel_designation = 17;
  assert.throws(() => assertWriterDomainFields(batregister), /vessel_designation måste vara text/);
}

process.stdout.write('master-data-v2: 14 testgrupper godkända\n');
