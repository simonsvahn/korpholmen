import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { canonicalStringify } from '../packages/core/domain/canonical.js';
import { Materializer } from '../packages/core/domain/materializer.js';
import { packSnapshot } from '../packages/core/sync/checkpoint-format.js';
import { validateBatch } from '../packages/core/sync/batch.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');

async function writeImmutableBytes(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, bytes, { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readFile(path);
    if (!existing.equals(bytes)) throw new Error(`Oföränderlig checkpointfil skiljer sig: ${path}`);
    return false;
  }
}

export async function buildCheckpointForApp({ outputRoot, app, createdAt = new Date().toISOString() }) {
  if (!outputRoot || !app?.id || !app?.folder || !app?.opsRoot) throw new TypeError('Checkpointbygget saknar app eller mål');
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

  const snapshot = materializer.exportSnapshot({ compactApplied: true });
  const packed = packSnapshot(snapshot);
  const payload = Buffer.from(canonicalStringify(packed));
  const compressed = gzipSync(payload, { level: 9, mtime: 0 });
  const compressedSha256 = sha256(compressed);
  const snapshotRelativePath = `${app.folder}/snapshots/${compressedSha256}.snapshot-v3.json.gz`;
  const snapshotPath = join(outputRoot, snapshotRelativePath);
  const snapshotCreated = await writeImmutableBytes(snapshotPath, compressed);
  const manifest = {
    checkpoint_version: 2,
    app_id: app.id,
    created_at: createdAt,
    ops_root: app.opsRoot,
    snapshot_format: 3,
    compression: 'gzip',
    snapshot_path: `/${snapshotRelativePath}`,
    compressed_sha256: compressedSha256,
    payload_sha256: sha256(payload),
    state_sha256: sha256(Buffer.from(canonicalStringify(snapshot))),
    compressed_bytes: compressed.byteLength,
    payload_bytes: payload.byteLength,
    source_batch_count: files.length,
    source_operation_count: operationCount,
  };

  const checkpointDirectory = join(outputRoot, app.folder, 'checkpoints');
  const target = join(checkpointDirectory, 'latest.json');
  const temporary = join(checkpointDirectory, `latest.json.tmp-${process.pid}`);
  await mkdir(checkpointDirectory, { recursive: true });
  await writeFile(temporary, `${canonicalStringify(manifest)}\n`, 'utf8');
  await rename(temporary, target);
  return { manifest, snapshot, snapshotCreated, target };
}
