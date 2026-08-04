import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, '../../kartdata');
const CORE = resolve(ROOT, '../../packages/core');
const FILES = ['index.html', 'styles.css', 'manifest.webmanifest', 'sw.js', 'icons/icon.svg', 'src/config.js', 'src/model.js'];
const CORE_FILES = ['data-layer.js', 'master-data.js', 'read-only-master.js', 'domain/canonical.js', 'domain/hlc.js', 'domain/materializer.js', 'domain/operations.js', 'domain/repository.js', 'pwa/korpholmen-service-worker.js', 'storage/indexeddb.js', 'storage/memory.js', 'sync/app-family-sync.js', 'sync/batch.js', 'sync/dropbox-transport.js', 'sync/errors.js', 'sync/memory-transport.js', 'sync/oauth-flow.js', 'sync/oauth-pkce.js', 'sync/shared-dropbox-session.js', 'sync/sync-engine.js'];

for (const relative of FILES) {
  const source = resolve(ROOT, relative); if (!(await stat(source)).isFile()) throw new Error(`Publiceringsfil saknas: ${relative}`);
  const target = resolve(OUT, relative); await mkdir(dirname(target), { recursive: true }); await copyFile(source, target);
}
const sharedIndex = (await readFile(resolve(ROOT, 'index.html'), 'utf8')).replaceAll('../../manifest.webmanifest', '../manifest.webmanifest').replaceAll('../../icons/korpholmen.svg', '../icons/korpholmen.svg').replaceAll('../../icons/korpholmen-180.png', '../icons/korpholmen-180.png').replaceAll('../../src/app-family-bootstrap.js', '../src/app-family-bootstrap.js');
await writeFile(resolve(OUT, 'index.html'), sharedIndex);
for (const relative of CORE_FILES) {
  const source = resolve(CORE, relative); if (!(await stat(source)).isFile()) throw new Error(`Gemensam kärnfil saknas: ${relative}`);
  const target = resolve(OUT, 'core', relative); await mkdir(dirname(target), { recursive: true }); await copyFile(source, target);
}
const app = (await readFile(resolve(ROOT, 'src/app.js'), 'utf8')).replaceAll('../../../packages/core/', '../core/');
await mkdir(resolve(OUT, 'src'), { recursive: true }); await writeFile(resolve(OUT, 'src/app.js'), app);

const bundle = (await Promise.all([
  ...FILES.map(file => readFile(resolve(OUT, file), 'utf8')),
  ...CORE_FILES.map(file => readFile(resolve(OUT, 'core', file), 'utf8')),
  (async () => app)(),
])).join('\n');
const privateData = JSON.parse(await readFile(resolve(ROOT, 'privat/migrering-2026-08-04-ren-v2/clean-v2-ops.json'), 'utf8'));
const forbiddenNames = privateData.operations
  .filter(operation => operation.entity_type === 'data-entry' && operation.field === 'name' && String(operation.value || '').length >= 6)
  .map(operation => operation.value)
  .filter(value => !/Korpholmen|Sviholmen|Svanö|Lövskär|Stugholmen|Skarpholmen/i.test(value));
if (forbiddenNames.some(name => bundle.includes(String(name))) || bundle.includes('"operations_version"')) {
  throw new Error('Privat kartdata har läckt in i publiceringspaketet');
}
console.log(`Datafri Kartdata byggd: ${FILES.length + CORE_FILES.length + 1} filer.`);
