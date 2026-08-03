import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, '../../kartdata');
const CORE = resolve(ROOT, '../../packages/core');
const FILES = ['index.html', 'styles.css', 'manifest.webmanifest', 'sw.js', 'icons/icon.svg', 'src/config.js', 'src/model.js'];
const CORE_FILES = ['data-layer.js', 'domain/canonical.js', 'domain/hlc.js', 'domain/materializer.js', 'domain/operations.js', 'domain/repository.js', 'storage/indexeddb.js', 'storage/memory.js', 'sync/batch.js', 'sync/dropbox-transport.js', 'sync/errors.js', 'sync/memory-transport.js', 'sync/oauth-flow.js', 'sync/oauth-pkce.js', 'sync/sync-engine.js'];

for (const relative of FILES) {
  const source = resolve(ROOT, relative); if (!(await stat(source)).isFile()) throw new Error(`Publiceringsfil saknas: ${relative}`);
  const target = resolve(OUT, relative); await mkdir(dirname(target), { recursive: true }); await copyFile(source, target);
}
for (const relative of CORE_FILES) {
  const source = resolve(CORE, relative); if (!(await stat(source)).isFile()) throw new Error(`Gemensam kärnfil saknas: ${relative}`);
  const target = resolve(OUT, 'core', relative); await mkdir(dirname(target), { recursive: true }); await copyFile(source, target);
}
const app = (await readFile(resolve(ROOT, 'src/app.js'), 'utf8')).replace("../../../packages/core/data-layer.js", "../core/data-layer.js");
await mkdir(resolve(OUT, 'src'), { recursive: true }); await writeFile(resolve(OUT, 'src/app.js'), app);

const bundle = (await Promise.all([
  ...FILES.map(file => readFile(resolve(OUT, file), 'utf8')),
  ...CORE_FILES.map(file => readFile(resolve(OUT, 'core', file), 'utf8')),
  (async () => app)(),
])).join('\n');
const privateData = JSON.parse(await readFile(resolve(ROOT, 'privat/migrering-2026-08-03/initial-ops.json'), 'utf8'));
const forbiddenNames = privateData.operations
  .filter(operation => operation.entity_type === 'map-entry' && operation.field === 'source_name' && String(operation.value || '').length >= 6)
  .map(operation => operation.value)
  .filter(value => !/Korpholmen|Sviholmen|Svanö|Lövskär|Stugholmen|Skarpholmen/i.test(value));
const workbookHash = privateData.operations.find(operation => operation.entity_type === 'source' && operation.field === 'workbook_sha256')?.value;
if (forbiddenNames.some(name => bundle.includes(String(name))) || bundle.includes('"operations_version"') || (workbookHash && bundle.includes(workbookHash))) {
  throw new Error('Privat kartdata har läckt in i publiceringspaketet');
}
console.log(`Datafri Kartdata byggd: ${FILES.length + CORE_FILES.length + 1} filer.`);
