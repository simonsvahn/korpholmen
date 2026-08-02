import { canonicalStringify, cloneJson } from '../domain/canonical.js';
import { batchPath, validateBatch } from './batch.js';
import { CursorResetError } from './errors.js';

const normalizePath = value => {
  const path = String(value || '');
  if (!path.startsWith('/') || path.includes('..')) throw new TypeError('Ogiltig transportväg');
  return path;
};

export class MemoryRemoteTransport {
  constructor({ id = 'memory', pageSize = 100 } = {}) {
    this.id = id;
    this.pageSize = pageSize;
    this.files = new Map();
    this.changes = [];
    this.revision = 0;
    this.minimumCursor = 0;
    this.waiters = new Set();
  }

  cursorValue(revision = this.revision) {
    return `m:${revision}`;
  }

  parseCursor(cursor) {
    if (cursor === null || cursor === undefined || cursor === '') return 0;
    const match = /^m:(\d+)$/.exec(String(cursor));
    if (!match) throw new CursorResetError('Ogiltig minnescursor');
    const value = Number(match[1]);
    if (value > this.revision || (value !== 0 && value < this.minimumCursor)) throw new CursorResetError();
    return value;
  }

  notifyWaiters() {
    for (const waiter of [...this.waiters]) {
      if (this.revision > waiter.after) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve({ changes: true });
      }
    }
  }

  record(path, value) {
    this.revision += 1;
    this.files.set(path, cloneJson(value));
    this.changes.push({ revision: this.revision, path });
    this.notifyWaiters();
  }

  async putImmutable(pathValue, value) {
    const path = normalizePath(pathValue);
    const existing = this.files.get(path);
    if (existing !== undefined) {
      if (canonicalStringify(existing) !== canonicalStringify(value)) throw new Error(`Oföränderlig filkollision: ${path}`);
      return { path, created: false };
    }
    this.record(path, value);
    return { path, created: true };
  }

  async putMutable(pathValue, value) {
    const path = normalizePath(pathValue);
    this.record(path, value);
    return { path, created: true };
  }

  async getJson(pathValue) {
    const path = normalizePath(pathValue);
    if (!this.files.has(path)) throw new Error(`Filen saknas: ${path}`);
    return cloneJson(this.files.get(path));
  }

  async putBatch(batch) {
    validateBatch(batch);
    return this.putImmutable(batchPath(batch.device_id, batch.from_seq, batch.to_seq), batch);
  }

  async listChanges(cursor = null, { limit = this.pageSize } = {}) {
    const after = this.parseCursor(cursor);
    const available = this.changes.filter(change => change.revision > after);
    const page = available.slice(0, limit);
    const nextRevision = page.length ? page.at(-1).revision : this.revision;
    return {
      entries: page.map(entry => ({ path: entry.path, revision: entry.revision })),
      cursor: this.cursorValue(nextRevision),
      has_more: available.length > page.length
    };
  }

  async getLatestCursor() {
    return this.cursorValue();
  }

  async waitForChanges(cursor, { timeoutMs = 30_000 } = {}) {
    const after = this.parseCursor(cursor);
    if (this.revision > after) return { changes: true };
    return new Promise(resolve => {
      const waiter = { after, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve({ changes: false });
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  forceCursorResetBefore(revision) {
    this.minimumCursor = Math.max(0, Number(revision) || 0);
  }
}
