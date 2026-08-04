import assert from 'node:assert/strict';
import {
  DropboxTransport,
  MemoryRemoteTransport,
  MemoryStore,
  ReadOnlyMaster,
  Repository,
  SyncEngine,
  mergePersonReferences,
  resolveCurrentOwners,
} from '../data-layer.js';

let passed = 0;
async function test(name, action) {
  await action(); passed += 1; console.log(`✓ ${name}`);
}

async function writableMaster(deviceId, remote) {
  const repository = await new Repository({ store: new MemoryStore(), deviceId }).init();
  return { repository, sync: () => new SyncEngine({ repository, transport: remote }).syncOnce() };
}

await test('en skrivskyddad master cachar främmande operationer utan att blanda dem med appens op-logg', async () => {
  const remote = new MemoryRemoteTransport({ id: 'matrikel' });
  const source = await writableMaster('matrikel-test', remote);
  await source.repository.setField('person', 'p1', 'display_name', 'Första namnet');
  await source.sync();
  const cache = new MemoryStore();
  const reader = await new ReadOnlyMaster({ store: cache, cacheKey: 'matrikel' }).init();
  await reader.sync(remote);
  assert.equal(reader.getEntity('person', 'p1').fields.display_name, 'Första namnet');
  assert.equal((await cache.getAllOps()).length, 0);
  const offlineReader = await new ReadOnlyMaster({ store: cache, cacheKey: 'matrikel' }).init();
  assert.equal(offlineReader.getEntity('person', 'p1').fields.display_name, 'Första namnet');
});

await test('ett namnbyte i Matrikel slår igenom i referenser och aktuella fastighetsägare', async () => {
  const personRemote = new MemoryRemoteTransport({ id: 'matrikel' });
  const propertyRemote = new MemoryRemoteTransport({ id: 'fastigheter' });
  const persons = await writableMaster('matrikel-test', personRemote);
  const properties = await writableMaster('fastigheter-test', propertyRemote);
  await persons.repository.setField('person', 'p1', 'display_name', 'Anna Före');
  await properties.repository.setFields([
    { entityType: 'property', entityId: 'Alsvik 3:1', field: 'display_name', value: 'Alsvik 3:1' },
    { entityType: 'party', entityId: 'party-anna', field: 'name', value: 'Källnamn Anna' },
    { entityType: 'party', entityId: 'party-anna', field: 'person_id', value: 'p1' },
    { entityType: 'current-owner-assessment', entityId: 'owner-3-1', field: 'property_id', value: 'Alsvik 3:1' },
    { entityType: 'current-owner-assessment', entityId: 'owner-3-1', field: 'owner_party_ids', value: ['party-anna'] },
  ]);
  await persons.sync(); await properties.sync();
  const cache = new MemoryStore();
  const personReader = await new ReadOnlyMaster({ store: cache, cacheKey: 'matrikel' }).init();
  const propertyReader = await new ReadOnlyMaster({ store: cache, cacheKey: 'fastigheter' }).init();
  await personReader.sync(personRemote); await propertyReader.sync(propertyRemote);
  assert.equal(mergePersonReferences([{ external_id: 'p1', display_name: 'Gammal kopia' }], personReader)[0].display_name, 'Anna Före');
  assert.equal(resolveCurrentOwners('Alsvik 3:1', propertyReader, personReader)[0].display_name, 'Anna Före');
  await persons.repository.setField('person', 'p1', 'display_name', 'Anna Efter'); await persons.sync(); await personReader.sync(personRemote);
  assert.equal(mergePersonReferences([{ external_id: 'p1', display_name: 'Gammal kopia' }], personReader)[0].display_name, 'Anna Efter');
  assert.equal(resolveCurrentOwners('Alsvik 3:1', propertyReader, personReader)[0].display_name, 'Anna Efter');
});

await test('skrivskyddad Dropbox-transport avvisar uppladdning', async () => {
  const transport = new DropboxTransport({ accessToken: 'test', readOnly: true, fetchImpl: async () => { throw new Error('fetch ska inte anropas'); } });
  await assert.rejects(() => transport.putMutable('/x.json', {}), /Skrivskyddad/);
});

console.log(`\n${passed} kärnkontrakt godkända.`);
