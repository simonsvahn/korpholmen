import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExactPublicationFiles } from '../verktyg/publication-guard.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APPS = ['matrikel', 'batregister', 'fastigheter', 'dokumentarkiv', 'korpholmenrunt', 'klubbhistorik', 'kartdata'];
let passed = 0;
async function test(name, action) { await action(); passed += 1; console.log(`✓ ${name}`); }

await test('Korpholmen är den enda installerbara PWA:n och omfattar alla appar', async () => {
  const manifest = JSON.parse(await readFile(resolve(ROOT, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.id, './');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some(icon => icon.src === './icons/korpholmen-192.png' && icon.sizes === '192x192'));
  assert.ok(manifest.icons.some(icon => icon.src === './icons/korpholmen-512.png' && icon.sizes === '512x512'));
  const rootHtml = await readFile(resolve(ROOT, 'index.html'), 'utf8');
  assert.match(rootHtml, /rel="manifest" href="\.\/manifest\.webmanifest"/);
  assert.match(rootHtml, /rel="apple-touch-icon" sizes="180x180" href="\.\/icons\/korpholmen-180\.png"/);
  for (const app of APPS) {
    const html = await readFile(resolve(ROOT, 'apps', app, 'index.html'), 'utf8');
    assert.match(html, /rel="manifest" href="\.\.\/\.\.\/manifest\.webmanifest"/, `${app} måste peka på rotmanifestet`);
    assert.match(html, /src="\.\.\/\.\.\/src\/app-family-bootstrap\.js/, `${app} måste starta den gemensamma synken`);
  }
});

await test('alla appar registrerar rotens service worker och inte en egen', async () => {
  for (const app of APPS) {
    const source = await readFile(resolve(ROOT, 'apps', app, 'src/app.js'), 'utf8');
    assert.match(source, /registerKorpholmenServiceWorker/);
    assert.doesNotMatch(source, /serviceWorker\.register\('\.\/sw\.js/);
  }
  const worker = await readFile(resolve(ROOT, 'sw.js'), 'utf8');
  assert.match(worker, /release-manifest\.json/);
  assert.match(worker, /url\.pathname\.includes\('\/privat\/'\)/);
  assert.match(worker, /url\.pathname\.includes\('\/apps\/'\)/);
});

await test('Dropbox-inloggningen och totalsynken är gemensamma men mastrarna förblir sju', async () => {
  const bootstrap = await readFile(resolve(ROOT, 'src/app-family-bootstrap.js'), 'utf8');
  const familySync = await readFile(resolve(ROOT, 'packages/core/sync/app-family-sync.js'), 'utf8');
  assert.match(bootstrap, /migrateLegacyCredentialsToShared/);
  assert.match(bootstrap, /mirrorSharedDropboxCredential/);
  assert.match(bootstrap, /scheduleAppFamilySync/);
  assert.match(familySync, /downloadRemote\(\)/, 'bakgrundssynken ska bara dra data och inte skriva andra appars väntande ändringar');
  assert.doesNotMatch(familySync, /\.syncOnce\(\)/);
  for (const path of ['/matrikel/ops', '/batregister/ops', '/fastigheter/ops', '/dokumentarkiv/ops', '/korpholmenrunt/ops', '/klubbhistorik/ops', '/kartdata/ops']) assert.ok(familySync.includes(path));
});

await test('lagring, offlinefel och Dropbox-frånkoppling hanteras gemensamt', async () => {
  const rootHtml = await readFile(resolve(ROOT, 'index.html'), 'utf8');
  const rootApp = await readFile(resolve(ROOT, 'src/app.js'), 'utf8');
  const bootstrap = await readFile(resolve(ROOT, 'src/app-family-bootstrap.js'), 'utf8');
  const runtimeSafety = await readFile(resolve(ROOT, 'packages/core/runtime-safety.js'), 'utf8');
  const familySync = await readFile(resolve(ROOT, 'packages/core/sync/app-family-sync.js'), 'utf8');
  assert.match(rootHtml, /id="disconnect-dropbox"/);
  assert.match(rootApp, /disconnectDropboxEverywhere/);
  assert.match(rootApp, /revokeDropboxAccessToken/);
  assert.match(rootApp, /requestPersistentStorage/);
  assert.match(bootstrap, /requestPersistentStorage/);
  assert.match(runtimeSafety, /device-identity:/);
  assert.match(runtimeSafety, /failed to fetch/);
  assert.doesNotMatch(runtimeSafety, /instanceof TypeError/);
  assert.match(familySync, /sharedDropboxDisconnectedKey/);
  assert.match(familySync, /clearLegacyCredentialStores/);
  for (const app of APPS) {
    const source = await readFile(resolve(ROOT, 'apps', app, 'src/app.js'), 'utf8');
    const builder = await readFile(resolve(ROOT, 'apps', app, 'verktyg/bygg-publicering.mjs'), 'utf8');
    assert.match(source, /resolveDeviceId/, `${app} saknar säker enhetsidentitet`);
    assert.match(source, /deviceId:\s*await deviceId\(\)/, `${app} väntar inte in enhetsidentiteten`);
    assert.match(source, /isOfflineError/, `${app} saknar gemensam offlineklassning`);
    assert.doesNotMatch(source, /instanceof TypeError/, `${app} döljer programfel som offlinefel`);
    assert.match(builder, /runtime-safety\.js/, `${app} publicerar inte runtime-safety`);
  }
});

await test('alla appar använder kompakta checkpoints, revisionscache och debounce', async () => {
  const repository = await readFile(resolve(ROOT, 'packages/core/domain/repository.js'), 'utf8');
  const materializer = await readFile(resolve(ROOT, 'packages/core/domain/materializer.js'), 'utf8');
  const indexeddb = await readFile(resolve(ROOT, 'packages/core/storage/indexeddb.js'), 'utf8');
  const syncEngine = await readFile(resolve(ROOT, 'packages/core/sync/sync-engine.js'), 'utf8');
  assert.match(repository, /getOpsAfter/);
  assert.match(repository, /compactApplied:\s*true/);
  assert.match(materializer, /snapshot_version:\s*2/);
  assert.match(indexeddb, /by_device_seq/);
  assert.match(syncEngine, /repository\.saveSnapshot\(\)/);
  for (const app of APPS) {
    const source = await readFile(resolve(ROOT, 'apps', app, 'src/app.js'), 'utf8');
    assert.match(source, /debounce/, `${app} saknar debounce`);
    assert.ok(source.includes('createRevisionCache') || app === 'matrikel' && source.includes('refreshedRepositoryRevision'), `${app} saknar revisionscache`);
  }
});

await test('Dokumentarkiv och Båtregister använder levande masterreferenser och djuplänkar', async () => {
  const archive = await readFile(resolve(ROOT, 'apps/dokumentarkiv/src/app.js'), 'utf8');
  const archiveBuilder = await readFile(resolve(ROOT, 'apps/dokumentarkiv/verktyg/bygg-startmaster.mjs'), 'utf8');
  const boats = await readFile(resolve(ROOT, 'apps/batregister/src/app.js'), 'utf8');
  assert.match(archive, /new ReadOnlyMaster\(\{ store, cacheKey: 'matrikel' \}\)/);
  assert.match(archive, /new ReadOnlyMaster\(\{ store, cacheKey: 'batregister' \}\)/);
  assert.match(archive, /resolveArchiveEntity/);
  assert.match(archive, /dropbox-batregister-read/);
  assert.match(archiveBuilder, /batregister\/\?boat=/);
  assert.match(boats, /requestedBoatId/);
  assert.match(boats, /groupLinkLabel/);
  assert.match(boats, /canonicalGroupTarget/);
});

await test('publiceringsmanifestet innehåller bara datafria appskalsvägar', async () => {
  const release = JSON.parse(await readFile(resolve(ROOT, 'release-manifest.json'), 'utf8'));
  assert.deepEqual(release.apps, APPS);
  assert.ok(release.shell_files.length >= 8);
  assert.ok(release.shell_files.every(path => !path.includes('/privat/') && !path.includes('/apps/')));
});

await test('publicerade appmoduler pekar bara inom GitHub Pages-paketet', async () => {
  for (const app of APPS) {
    const source = await readFile(resolve(ROOT, app, 'src/app.js'), 'utf8');
    assert.equal(source.includes('../../../packages/core/'), false, `${app} har en modulväg som lämnar GitHub Pages-projektet`);
  }
});

await test('en releasesanning styr service worker, manifest och HTML-cachebrytare', async () => {
  const config = JSON.parse(await readFile(resolve(ROOT, 'verktyg/release.json'), 'utf8'));
  const release = JSON.parse(await readFile(resolve(ROOT, 'release-manifest.json'), 'utf8'));
  const worker = await readFile(resolve(ROOT, 'sw.js'), 'utf8');
  assert.equal(release.release, config.release);
  assert.equal(release.generated_at, config.generated_at);
  assert.ok(worker.includes(`const RELEASE = '${config.release}'`));
  assert.ok(!worker.includes('__KORPHOLMEN_RELEASE__'));
  for (const path of [resolve(ROOT, 'index.html'), ...APPS.flatMap(app => [resolve(ROOT, 'apps', app, 'index.html'), resolve(ROOT, app, 'index.html')])]) {
    const html = await readFile(path, 'utf8');
    const versions = [...html.matchAll(/\?v=([^"'\s<>&]+)/g)].map(match => match[1]);
    assert.ok(versions.length, `${path} saknar versionsbundna skalfiler`);
    assert.ok(versions.every(version => version === config.release), `${path} avviker från releasesanningen`);
  }
});

await test('offlinepaketet har riktiga appfallbacks, querymatchning och inga OG-bilder', async () => {
  const release = JSON.parse(await readFile(resolve(ROOT, 'release-manifest.json'), 'utf8'));
  const worker = await readFile(resolve(ROOT, 'sw.js'), 'utf8');
  const client = await readFile(resolve(ROOT, 'packages/core/pwa/korpholmen-service-worker.js'), 'utf8');
  assert.ok(worker.includes("caches.match(request, { ignoreSearch: true })"));
  assert.ok(worker.includes('const appIndex = await caches.match'));
  assert.ok(worker.includes('containsOAuthResponse'));
  assert.ok(worker.includes('Promise.allSettled'));
  assert.ok(client.includes('reloadOnUpdate = false'));
  assert.ok(release.shell_files.every(path => !/\/og\.png$/i.test(path)));
  for (const app of APPS) assert.ok(release.shell_files.includes(`./${app}/index.html`));
  for (const path of release.shell_files) {
    const localPath = resolve(ROOT, path.replace(/^\.\//, '').split('?')[0]);
    assert.equal((await stat(localPath)).isFile(), true, `${path} saknas på disk`);
  }
});

await test('alla publiceringsbyggare vägrar oväntade filer och arbetsmaterial är ignorerat', async () => {
  for (const app of APPS) {
    const source = await readFile(resolve(ROOT, 'apps', app, 'verktyg/bygg-publicering.mjs'), 'utf8');
    assert.ok(source.includes('assertExactPublicationFiles'), `${app} saknar exakt-fil-vakten`);
  }
  const gitignore = await readFile(resolve(ROOT, '.gitignore'), 'utf8');
  assert.match(gitignore, /^arbetsmaterial\/$/m);

  const directory = await mkdtemp(resolve(tmpdir(), 'korpholmen-publication-guard-'));
  try {
    await mkdir(resolve(directory, 'src'));
    await writeFile(resolve(directory, 'index.html'), '<!doctype html>');
    await writeFile(resolve(directory, 'src/app.js'), 'export {};');
    await assertExactPublicationFiles(directory, ['index.html', 'src/app.js']);
    await writeFile(resolve(directory, 'privat.json'), '{}');
    await assert.rejects(assertExactPublicationFiles(directory, ['index.html', 'src/app.js']), /oväntade filer: privat\.json/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

console.log(`\n${passed} Korpholmen-kontrakt godkända.`);
