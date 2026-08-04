import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'privat/migrering-2026-08-04-lokal-bootstrap');
const dropboxRoot = process.argv[2] || '/Users/simon/Dropbox/Appar/Korpholmen';
const BASE_DEVICE = 'migration-kartdata-clean-v2-2026-08-04';
const opsRoot = resolve(dropboxRoot, 'kartdata', 'ops');
const documents = await Promise.all((await readdir(opsRoot)).filter(name => name.endsWith('.json')).sort().map(name => readFile(resolve(opsRoot, name), 'utf8').then(JSON.parse)));
const operations = documents.flatMap(document => document.operations || document.ops || []).filter(operation => operation.device_id === BASE_DEVICE).sort((a, b) => a.seq - b.seq);
if (!operations.length) throw new Error('Den publicerade rena v2-basen saknas i Dropbox');
if (new Set(operations.map(operation => operation.op_id)).size !== operations.length) throw new Error('V2-basen har dubbla operations-ID:n');
const document = { operations_version: 1, dataset: 'Korpholmen kartdata v2 lokal bas', device_id: BASE_DEVICE, migration_id: '2026-08-04-kartdata-clean-v2', operations };
await mkdir(OUT, { recursive: true });
await writeFile(resolve(OUT, 'clean-v2-base-ops.json'), `${JSON.stringify(document, null, 2)}\n`);
console.log(JSON.stringify({ migration_id: document.migration_id, operations: operations.length }, null, 2));
