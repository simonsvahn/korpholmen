import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExactPublicationFiles } from '../verktyg/publication-guard.mjs';
import { buildCheckpointForApp } from '../verktyg/sync-checkpoint-builder.mjs';
import { createBatch, decodeCheckpointPayload, Materializer } from '../packages/core/data-layer.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APPS = ['matrikel', 'batregister', 'fastigheter', 'dokumentarkiv', 'korpholmenrunt', 'klubbhistorik', 'kartdata'];
const PROJECTIONS = ['explorer'];
const SURFACES = [...APPS, ...PROJECTIONS];
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
  const explorerHtml = await readFile(resolve(ROOT, 'apps/explorer/index.html'), 'utf8');
  assert.match(explorerHtml, /rel="manifest" href="\.\.\/\.\.\/manifest\.webmanifest"/);
  assert.match(explorerHtml, /src="\.\.\/\.\.\/src\/app-family-bootstrap\.js/);
});

await test('alla publicerade ingångssidor avråder sökmotorer från indexering', async () => {
  const entryPages = [
    resolve(ROOT, 'index.html'),
    ...SURFACES.flatMap(app => [resolve(ROOT, 'apps', app, 'index.html'), resolve(ROOT, app, 'index.html')]),
  ];
  for (const path of entryPages) {
    const html = await readFile(path, 'utf8');
    assert.match(
      html,
      /<meta name="robots" content="[^"]*\bnoindex\b[^"]*">/,
      `${path} saknar noindex`,
    );
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
  assert.match(familySync, /\.downloadRemote\(/, 'bakgrundssynken ska bara dra data och inte skriva andra appars väntande ändringar');
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
  assert.match(familySync, /quarantined_batches/);
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
  const familySync = await readFile(resolve(ROOT, 'packages/core/sync/app-family-sync.js'), 'utf8');
  assert.match(repository, /getOpsAfter/);
  assert.match(repository, /compactApplied:\s*true/);
  assert.match(materializer, /snapshot_version:\s*2/);
  assert.match(indexeddb, /by_device_seq/);
  assert.match(syncEngine, /repository\.saveSnapshot\(\)/);
  assert.match(syncEngine, /requireCheckpointOnEmpty/);
  assert.match(familySync, /id: 'klubbhistorik'.*requireCheckpointOnEmpty: true/);
  const checkpointFormat = await readFile(resolve(ROOT, 'packages/core/sync/checkpoint-format.js'), 'utf8');
  assert.match(checkpointFormat, /decodeCheckpointPayload/);
  for (const app of APPS) {
    const source = await readFile(resolve(ROOT, 'apps', app, 'src/app.js'), 'utf8');
    assert.match(source, /debounce/, `${app} saknar debounce`);
    assert.ok(source.includes('createRevisionCache') || app === 'matrikel' && source.includes('refreshedRepositoryRevision'), `${app} saknar revisionscache`);
  }
  const [clubSource, clubConfig, clubHtml, clubSeed] = await Promise.all([
    readFile(resolve(ROOT, 'apps/klubbhistorik/src/app.js'), 'utf8'),
    readFile(resolve(ROOT, 'apps/klubbhistorik/src/config.js'), 'utf8'),
    readFile(resolve(ROOT, 'apps/klubbhistorik/index.html'), 'utf8'),
    readFile(resolve(ROOT, 'apps/klubbhistorik/verktyg/skriv-dropbox-startmaster.mjs'), 'utf8'),
  ]);
  assert.match(clubSource, /requireCheckpointOnEmpty:true/);
  assert.doesNotMatch(clubSource, /bootstrapLocal/);
  assert.doesNotMatch(clubConfig, /LOCAL_BOOTSTRAP_URLS/);
  assert.doesNotMatch(clubHtml, /Aktivera pilotmaster/);
  assert.match(clubSeed, /buildCheckpointForApp/);
});

await test('checkpointbygget skriver atomiskt manifest och innehållsadresserad gzip-snapshot', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'korpholmen-checkpoint-'));
  try {
    const appRoot = resolve(directory, 'klubbhistorik');
    await mkdir(resolve(appRoot, 'ops'), { recursive: true });
    const operation = {
      op_id: 'checkpoint-test:1',
      device_id: 'checkpoint-test',
      seq: 1,
      entity_type: 'person',
      entity_id: 'p1',
      field: 'name',
      value: 'Snapshotperson',
      hlc: '1785888000000-000000-checkpoint-test',
      schema_version: 1,
    };
    const batch = createBatch([operation]);
    await writeFile(resolve(appRoot, 'ops/checkpoint-test-0000000001-0000000001.json'), JSON.stringify(batch));
    const result = await buildCheckpointForApp({
      outputRoot: directory,
      app: { id: 'klubbhistorik', folder: 'klubbhistorik', opsRoot: '/klubbhistorik/ops' },
      createdAt: '2026-08-05T00:00:00.000Z',
    });
    const manifest = JSON.parse(await readFile(resolve(appRoot, 'checkpoints/latest.json'), 'utf8'));
    const compressed = await readFile(resolve(directory, manifest.snapshot_path.slice(1)));
    const snapshot = await decodeCheckpointPayload(manifest, compressed, { opsRoot: '/klubbhistorik/ops', verifyStateHash: true });
    assert.equal(new Materializer(snapshot).getEntity('person', 'p1').fields.name, 'Snapshotperson');
    assert.equal(result.manifest.compressed_sha256, manifest.compressed_sha256);
    assert.ok(manifest.compressed_bytes < manifest.payload_bytes);
    assert.equal((await stat(resolve(directory, manifest.snapshot_path.slice(1)))).size, manifest.compressed_bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
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

await test('borttagningar kan ångras och granskningsköer har ett källbevarande slutbeslut', async () => {
  for (const app of ['matrikel', 'batregister', 'kartdata']) {
    const source = await readFile(resolve(ROOT, 'apps', app, 'src/app.js'), 'utf8');
    const styles = await readFile(resolve(ROOT, 'apps', app, 'styles.css'), 'utf8');
    const html = await readFile(resolve(ROOT, 'apps', app, 'index.html'), 'utf8');
    assert.match(source, /function offerUndo/);
    assert.match(source, /repository\.restoreEntities\(restoreEntries\)/);
    assert.match(source, /15_000/);
    assert.match(source, /const undoNode = \$\('#undo-status'\)/);
    assert.match(source, /undoNode\.append\(' · ', button\)/);
    assert.doesNotMatch(source, /delete statusNode\.dataset\.undoAction/);
    assert.match(styles, /\.undo-action/);
    assert.match(html, /id="undo-status" role="status" hidden/);
  }
  for (const app of ['klubbhistorik']) {
    const source = await readFile(resolve(ROOT, 'apps', app, 'src/app.js'), 'utf8');
    assert.match(source, /review_decision/);
    assert.match(source, /bevarad okopplad/);
    assert.match(source, /Bevara utan koppling/);
    assert.match(source, /reviewed_at/);
  }
});

await test('publiceringsmanifestet innehåller bara datafria appskalsvägar', async () => {
  const release = JSON.parse(await readFile(resolve(ROOT, 'release-manifest.json'), 'utf8'));
  assert.deepEqual(release.apps, APPS);
  assert.deepEqual(release.projections, PROJECTIONS);
  assert.ok(release.shell_files.length >= 8);
  assert.ok(release.shell_files.every(path => !path.includes('/privat/') && !path.includes('/apps/')));
});

await test('publicerade appmoduler pekar bara inom GitHub Pages-paketet och alla importer finns', async () => {
  for (const app of SURFACES) {
    const source = await readFile(resolve(ROOT, app, 'src/app.js'), 'utf8');
    assert.equal(source.includes('../../../packages/core/'), false, `${app} har en modulväg som lämnar GitHub Pages-projektet`);
  }
  const release = JSON.parse(await readFile(resolve(ROOT, 'release-manifest.json'), 'utf8'));
  for (const path of release.shell_files.filter(value => value.endsWith('.js'))) {
    const localPath = resolve(ROOT, path.replace(/^\.\//, ''));
    const source = await readFile(localPath, 'utf8');
    const imports = [...source.matchAll(/(?:from\s+|import\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)].map(match => match[1]);
    for (const specifier of imports) {
      const target = resolve(dirname(localPath), specifier.split('?')[0]);
      try {
        assert.equal((await stat(target)).isFile(), true);
      } catch {
        assert.fail(`${path} importerar en fil som saknas: ${specifier}`);
      }
    }
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
  for (const path of [resolve(ROOT, 'index.html'), ...SURFACES.flatMap(app => [resolve(ROOT, 'apps', app, 'index.html'), resolve(ROOT, app, 'index.html')])]) {
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
  for (const app of SURFACES) assert.ok(release.shell_files.includes(`./${app}/index.html`));
  for (const path of release.shell_files) {
    const localPath = resolve(ROOT, path.replace(/^\.\//, '').split('?')[0]);
    assert.equal((await stat(localPath)).isFile(), true, `${path} saknas på disk`);
  }
});

await test('alla publiceringsbyggare vägrar oväntade filer och arbetsmaterial är ignorerat', async () => {
  for (const app of SURFACES) {
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

await test('CI är datafri, skrivskyddad och verifierar byggda publiceringskopior', async () => {
  const workflow = await readFile(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /npm run test:ci/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /git diff --exit-code/);
  assert.doesNotMatch(workflow, /secrets\.|contents: write|pull-requests: write/);
  const guard = await readFile(resolve(ROOT, 'verktyg/publication-guard.mjs'), 'utf8');
  assert.match(guard, /readOptionalPrivateJson/);
});

console.log(`\n${passed} Korpholmen-kontrakt godkända.`);
