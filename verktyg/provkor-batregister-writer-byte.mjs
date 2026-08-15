import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { MemoryStore } from '../packages/core/data-layer.js';
import { GenerationCutoverGuard } from '../packages/core/generation-cutover.js';
import { canonicalStringify } from '../packages/master-data-v2/index.js';
import { createBatregisterWriter } from '../apps/batregister/src/batregister-writer.js';

const sourceRoot = resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Ange roten som innehåller batregister-generation2, exempelvis Dropbox/Appar/Korpholmen.');
const sha = value => createHash('sha256').update(value).digest('hex');

async function files(root, current = root) {
  const entries = await (await import('node:fs/promises')).readdir(current, { withFileTypes: true });
  const values = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) values.push(...await files(root, path));
    else if (entry.isFile()) values.push(path.slice(root.length + 1));
  }
  return values;
}

async function treeDigest(root) {
  const rows = [];
  for (const relative of await files(root)) rows.push(`${relative}\0${sha(await readFile(join(root, relative)))}`);
  return sha(rows.join('\n'));
}

class LocalDirectoryTransport {
  constructor(root) { this.root = root; }
  path(remotePath) {
    if (!String(remotePath).startsWith('/') || String(remotePath).includes('..')) throw new Error('Ogiltig lokal transportväg');
    return join(this.root, String(remotePath).slice(1));
  }
  async getBytesWithMetadata(remotePath) {
    const value = await readFile(this.path(remotePath));
    return { value, revision: sha(value), metadata: {} };
  }
  async getBytes(remotePath) { return (await this.getBytesWithMetadata(remotePath)).value; }
  async getJson(remotePath) {
    try { return JSON.parse(await readFile(this.path(remotePath), 'utf8')); }
    catch (error) {
      if (error?.code === 'ENOENT') {
        const notFound = new Error(`Sökvägen saknas: ${remotePath}`);
        notFound.status = 409;
        notFound.code = 'path/not_found/';
        throw notFound;
      }
      throw error;
    }
  }
  async putImmutable(remotePath, value) {
    const path = this.path(remotePath);
    await mkdir(dirname(path), { recursive: true });
    const bytes = Buffer.from(JSON.stringify(value));
    try { await writeFile(path, bytes, { flag: 'wx' }); return { path: remotePath, created: true, revision: sha(bytes) }; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = JSON.parse(await readFile(path, 'utf8'));
      if (canonicalStringify(existing) !== canonicalStringify(value)) throw new Error(`Oföränderlig lokal kollision: ${remotePath}`);
      return { path: remotePath, created: false, revision: sha(await readFile(path)) };
    }
  }
  async putMutableIfRevision(remotePath, value, expectedRevision) {
    const path = this.path(remotePath);
    const current = await readFile(path);
    if (sha(current) !== expectedRevision) return { ok: false, path: remotePath, revision: sha(current) };
    const next = `${path}.next`;
    await writeFile(next, JSON.stringify(value));
    await (await import('node:fs/promises')).rename(next, path);
    return { ok: true, path: remotePath, revision: sha(await readFile(path)) };
  }
}

const scratch = await mkdtemp(join(tmpdir(), 'korpholmen-batregister-writer-test-'));
try {
  const source = join(sourceRoot, 'batregister-generation2');
  if (!(await stat(source)).isDirectory()) throw new Error(`Båtmaster saknas: ${source}`);
  const work = join(scratch, 'batregister-generation2');
  await cp(source, work, { recursive: true, preserveTimestamps: true });
  const baseline = await treeDigest(work);
  const pointerPath = join(work, 'active.json');
  const pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
  pointer.mode = 'read_write';
  pointer.writer_enabled = true;
  await writeFile(pointerPath, JSON.stringify(pointer, null, 2));

  const transport = new LocalDirectoryTransport(scratch);
  const writer = createBatregisterWriter({
    transport,
    pendingStore: new MemoryStore(),
    changedBy: 'kopieprov',
    now: () => '2026-08-15T20:00:00.000Z',
    createId: () => 'copy-test',
  });
  const loaded = await writer.load();
  const boat = loaded.master.data.boats.find(row => !row.deleted_at);
  const saved = await writer.saveBoat(boat.id, { display_name: `${boat.display_name} · kopieprov` }, { manualComment: 'Kopieprov före aktivering' });
  assert.equal(saved.master.master_revision, loaded.master.master_revision + 1);
  assert.equal(saved.receipt.base_master_revision, loaded.master.master_revision);
  assert.equal((await writer.storage.listPending()).length, 0);
  assert.equal((await writer.storage.getHistoryReceipt('batregister:copy-test')).change_id, 'batregister:copy-test');

  const marker = {
    schema_version: 1, app: 'batregister', state: 'active',
    v1_ops_root: '/batregister/ops', v2_pointer_path: '/batregister-generation2/active.json',
    v1_baseline_manifest_sha256: '1'.repeat(64), v2_master_sha256: saved.pointer.master_sha256,
    activated_at: '2026-08-15T20:01:00.000Z', activated_by: 'kopieprov',
  };
  const guard = new GenerationCutoverGuard({ app: 'batregister', transport: { getJson: async () => marker }, store: new MemoryStore(), refreshIntervalMs: 0 });
  await assert.rejects(guard.assertGeneration1Writable({ source: 'copy-test' }), /generation 1 är fryst/);

  await rm(work, { recursive: true });
  await cp(source, work, { recursive: true, preserveTimestamps: true });
  assert.equal(await treeDigest(work), baseline);
  console.log(JSON.stringify({ ok: true, base_revision: loaded.master.master_revision, test_revision: saved.master.master_revision, boat_id: boat.id, history_receipt: true, pending_queue: 0, v1_guard: 'blocked', restored_tree_sha256: baseline }, null, 2));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
