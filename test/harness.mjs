import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

console.log(`\n${passed} Korpholmen-kontrakt godkända.`);
