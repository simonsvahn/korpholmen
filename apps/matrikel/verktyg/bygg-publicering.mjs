import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const CORE_FILES = ['family-context.js'];

async function listFiles(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await listFiles(resolve(directory, entry.name), relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result.sort();
}

for (const relative of FILES) {
  const source = resolve(ROOT, relative);
  if (!(await stat(source)).isFile()) throw new Error(`Publiceringsfil saknas: ${relative}`);
  const target = resolve(OUT, relative);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

for (const relative of CORE_FILES) {
  const source = resolve(CORE, relative);
  if (!(await stat(source)).isFile()) throw new Error(`Gemensam kärnfil saknas: ${relative}`);
  const target = resolve(OUT, 'core', relative);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

const app = (await readFile(resolve(ROOT, 'src/app.js'), 'utf8'))
  .replace("../../../packages/core/family-context.js", "../core/family-context.js");
await mkdir(resolve(OUT, 'src'), { recursive: true });
await writeFile(resolve(OUT, 'src/app.js'), app);

const actual = await listFiles(OUT);
const expected = [...FILES, 'src/app.js', ...CORE_FILES.map(file => `core/${file}`)].sort();
const unexpected = actual.filter(file => !expected.includes(file));
if (unexpected.length) throw new Error(`Vägrar publicera med oväntade filer: ${unexpected.join(', ')}`);
const missing = expected.filter(file => !actual.includes(file));
if (missing.length) throw new Error(`Publiceringspaketet saknar: ${missing.join(', ')}`);

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
