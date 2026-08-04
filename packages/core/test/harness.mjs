import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DropboxTransport,
  MemoryRemoteTransport,
  MemoryStore,
  ReadOnlyMaster,
  Repository,
  SharedDropboxSession,
  SyncEngine,
  mergePersonReferences,
  resolveCurrentOwners,
} from '../data-layer.js';

let passed = 0;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
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

await test('en gemensam Dropbox-session återanvänder och förnyar samma inloggning', async () => {
  const values = new Map();
  const sharedStore = {
    get: async key => values.get(key) ?? null,
    put: async (key, value) => values.set(key, value),
    delete: async key => values.delete(key),
  };
  let exchanges = 0;
  let now = 1_000;
  const session = new SharedDropboxSession({
    clientId: 'client',
    sharedStore,
    now: () => now,
    exchangeRefreshToken: async ({ refreshToken }) => { exchanges += 1; assert.equal(refreshToken, 'refresh-1'); return { access_token: 'access-2', expires_in: 3600 }; },
  });
  await session.acceptTokenResponse({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 1 });
  assert.equal(await session.hasCredential(), true);
  assert.equal(await session.getRefreshToken(), 'refresh-1');
  now = 32_000;
  assert.equal(await session.getAccessToken(), 'access-2');
  assert.equal(exchanges, 1);
});

await test('nya mastermoduler importeras direkt så att äldre appcache förblir kompatibel', async () => {
  const apps = ['batregister', 'fastigheter', 'kartdata', 'klubbhistorik', 'korpholmenrunt'];
  for (const app of apps) {
    const source = await readFile(resolve(REPO_ROOT, 'apps', app, 'src/app.js'), 'utf8');
    const barrelFields = source.match(/import\s*\{([\s\S]*?)\}\s*from\s*'\.\.\/\.\.\/\.\.\/packages\/core\/data-layer\.js';/)?.[1] || '';
    for (const field of ['ReadOnlyMaster', 'mergePersonReferences', 'resolveCurrentOwners', 'resolvePropertyReferences', 'resolvePartyName']) {
      assert.ok(!new RegExp(`\\b${field}\\b`).test(barrelFields), `${app} importerar ${field} genom den cachekänsliga data-layer-filen`);
    }
    assert.match(source, /packages\/core\/read-only-master\.js/, `${app} ska importera ReadOnlyMaster direkt`);
  }
});

console.log(`\n${passed} kärnkontrakt godkända.`);
