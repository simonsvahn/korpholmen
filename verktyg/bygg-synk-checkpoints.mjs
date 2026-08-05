import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { canonicalStringify } from '../packages/core/domain/canonical.js';
import { Materializer } from '../packages/core/domain/materializer.js';
import { validateBatch } from '../packages/core/sync/batch.js';

const APPS = Object.freeze([
  { id: 'matrikel', folder: 'matrikel', opsRoot: '/matrikel/ops' },
  { id: 'batregister', folder: 'batregister', opsRoot: '/batregister/ops' },
  { id: 'fastigheter', folder: 'fastigheter', opsRoot: '/fastigheter/ops' },
  { id: 'dokumentarkiv', folder: 'dokumentarkiv', opsRoot: '/dokumentarkiv/ops' },
  { id: 'korpholmenrunt', folder: 'korpholmenrunt', opsRoot: '/korpholmenrunt/ops' },
  { id: 'klubbhistorik', folder: 'klubbhistorik', opsRoot: '/klubbhistorik/ops' },
  { id: 'kartdata', folder: 'kartdata', opsRoot: '/kartdata/ops' },
]);

const requestedRoot = process.argv[2];
if (!requestedRoot) throw new Error('Ange den uttryckliga Dropbox-roten som första argument');
const outputRoot = resolve(requestedRoot);
if (!isAbsolute(outputRoot) || outputRoot === '/' || !outputRoot.endsWith('/Korpholmen')) {
  throw new Error('Checkpointbygget kräver en uttrycklig Korpholmen-mapp och vägrar breda mål');
}

for (const app of APPS) {
  const opsDirectory = join(outputRoot, app.folder, 'ops');
  const files = (await readdir(opsDirectory)).filter(file => file.endsWith('.json')).sort();
  const materializer = new Materializer();
  let operationCount = 0;
  for (const file of files) {
    const batch = JSON.parse(await readFile(join(opsDirectory, file), 'utf8'));
    validateBatch(batch);
    materializer.applyAll(batch.ops);
    operationCount += batch.ops.length;
  }
  const checkpoint = {
    checkpoint_version: 1,
    created_at: new Date().toISOString(),
    ops_root: app.opsRoot,
    source_batch_count: files.length,
    source_operation_count: operationCount,
    snapshot: materializer.exportSnapshot({ compactApplied: true }),
  };
  const checkpointDirectory = join(outputRoot, app.folder, 'checkpoints');
  const target = join(checkpointDirectory, 'latest.json');
  const temporary = join(checkpointDirectory, `latest.json.tmp-${process.pid}`);
  await mkdir(checkpointDirectory, { recursive: true });
  await writeFile(temporary, `${canonicalStringify(checkpoint)}\n`, 'utf8');
  await rename(temporary, target);
  console.log(`${app.id}: ${files.length} batcher, ${operationCount} operationer → ${target}`);
}
