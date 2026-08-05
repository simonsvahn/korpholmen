import { isAbsolute, resolve } from 'node:path';
import { buildCheckpointForApp } from './sync-checkpoint-builder.mjs';

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
  const result = await buildCheckpointForApp({ outputRoot, app });
  console.log(`${app.id}: ${result.manifest.source_batch_count} batcher, ${result.manifest.source_operation_count} operationer → ${result.manifest.compressed_bytes} byte checkpoint`);
}
