import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExactPublicationFiles } from '../../../verktyg/publication-guard.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, '../../matrikel');
const CORE = resolve(ROOT, '../../packages/core');
const FILES = [
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'sw.js',
  'icons/icon.svg',
  'src/landscape-model.js',
  'src/config.js',
  'src/data-layer.js',
  'src/domain/canonical.js',
  'src/domain/hlc.js',
  'src/domain/materializer.js',
  'src/domain/operations.js',
  'src/domain/repository.js',
  'src/domain/slakt-schema.js',
  'src/storage/indexeddb.js',
  'src/storage/memory.js',
  'src/sync/batch.js',
  'src/sync/dropbox-transport.js',
  'src/sync/errors.js',
  'src/sync/memory-transport.js',
  'src/sync/oauth-flow.js',
  'src/sync/oauth-pkce.js',
  'src/sync/sync-engine.js'
];
const CORE_FILES = ['data-layer.js', 'runtime-safety.js', 'family-context.js', 'master-data.js', 'read-only-master.js', 'domain/canonical.js', 'domain/hlc.js', 'domain/materializer.js', 'domain/operations.js', 'domain/repository.js', 'pwa/korpholmen-service-worker.js', 'storage/indexeddb.js', 'storage/memory.js', 'sync/app-family-sync.js', 'sync/batch.js', 'sync/checkpoint-format.js', 'sync/dropbox-transport.js', 'sync/errors.js', 'sync/memory-transport.js', 'sync/oauth-flow.js', 'sync/oauth-pkce.js', 'sync/shared-dropbox-session.js', 'sync/sync-engine.js'];

for (const relative of FILES) {
  const source = resolve(ROOT, relative);
  if (!(await stat(source)).isFile()) throw new Error(`Publiceringsfil saknas: ${relative}`);
  const target = resolve(OUT, relative);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

const sharedIndex = (await readFile(resolve(ROOT, 'index.html'), 'utf8'))
  .replaceAll('../../manifest.webmanifest', '../manifest.webmanifest')
  .replaceAll('../../icons/korpholmen.svg', '../icons/korpholmen.svg')
  .replaceAll('../../icons/korpholmen-180.png', '../icons/korpholmen-180.png')
  .replaceAll('../../src/app-family-bootstrap.js', '../src/app-family-bootstrap.js');
await writeFile(resolve(OUT, 'index.html'), sharedIndex);

for (const relative of CORE_FILES) {
  const source = resolve(CORE, relative);
  if (!(await stat(source)).isFile()) throw new Error(`Gemensam kärnfil saknas: ${relative}`);
  const target = resolve(OUT, 'core', relative);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

const dataLayer = (await readFile(resolve(ROOT, 'src/data-layer.js'), 'utf8'))
  .replaceAll('../../../packages/core/', '../core/');
await writeFile(resolve(OUT, 'src/data-layer.js'), dataLayer);

const app = (await readFile(resolve(ROOT, 'src/app.js'), 'utf8'))
  .replace("../../../packages/core/family-context.js", "../core/family-context.js");
await mkdir(resolve(OUT, 'src'), { recursive: true });
await writeFile(resolve(OUT, 'src/app.js'), app);

const expected = [...FILES, 'src/app.js', ...CORE_FILES.map(file => `core/${file}`)].sort();
const actual = await assertExactPublicationFiles(OUT, expected);

const textBundle = (await Promise.all(actual
  .filter(file => /\.(?:html|css|js|webmanifest|svg)$/.test(file))
  .map(file => readFile(resolve(OUT, file), 'utf8')))).join('\n');
const privateArchive = JSON.parse(await readFile(resolve(ROOT, 'privat/migrering-2026-08-01/initial-archive.json'), 'utf8'));
const leakedNames = privateArchive.persons
  .map(person => person.fields.display_name)
  .filter(name => name && textBundle.includes(name));
if (leakedNames.length) throw new Error(`Persondata har läckt in i appskalet: ${leakedNames.slice(0, 3).join(', ')}`);
if (textBundle.includes('const D={') || textBundle.includes('"operations_version": 1')) {
  throw new Error('Inbyggd privat data upptäcktes i publiceringspaketet');
}

console.log(`Datafritt publiceringspaket verifierat: ${actual.length} filer.`);
