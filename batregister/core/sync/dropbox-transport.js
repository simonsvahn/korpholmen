import { canonicalStringify, cloneJson } from '../domain/canonical.js';
import { batchPath, validateBatch } from './batch.js';
import { decodeCheckpointPayload } from './checkpoint-format.js';
import { CursorResetError, TransportError } from './errors.js';

const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';
const NOTIFY = 'https://notify.dropboxapi.com/2';

const normalizePath = value => {
  const path = String(value || '');
  if (!path.startsWith('/') || path.includes('..')) throw new TypeError('Ogiltig Dropbox-väg');
  return path;
};

const parentPath = path => path.slice(0, path.lastIndexOf('/')) || '/';
const childPath = (path, child) => path === '/' ? `/${child}` : `${path}/${child}`;

export class DropboxTransport {
  constructor({ accessToken, fetchImpl = (...args) => globalThis.fetch(...args), id = 'dropbox', opsRoot = '/ops', readOnly = false, requestTimeoutMs = 45_000 }) {
    if (!accessToken) throw new TypeError('Dropbox access token saknas');
    if (!fetchImpl) throw new TypeError('fetch saknas');
    this.accessToken = accessToken;
    this.fetch = fetchImpl.bind(globalThis);
    this.id = id;
    this.opsRoot = normalizePath(opsRoot).replace(/\/$/, '') || '/';
    this.readOnly = Boolean(readOnly);
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 0) throw new TypeError('Ogiltig Dropbox-timeout');
    this.requestTimeoutMs = requestTimeoutMs;
    this.checkpointPath = childPath(parentPath(this.opsRoot), 'checkpoints/latest.json');
    this.knownFolders = new Set(['/']);
  }

  async request(url, init, timeoutMs = this.requestTimeoutMs) {
    if (!(timeoutMs > 0) || typeof globalThis.AbortController !== 'function') return this.fetch(url, init);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        throw new TransportError(`Dropbox svarade inte inom ${Math.ceil(timeoutMs / 1000)} sekunder`, { code: 'request_timeout' });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async parseError(response) {
    const text = await response.text().catch(() => '');
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch (_) { payload = {}; }
    const summary = payload.error_summary || payload.error?.['.tag'] || text || `HTTP ${response.status}`;
    if (summary.includes('reset')) throw new CursorResetError(summary);
    const retryHeader = response.headers?.get?.('Retry-After');
    const retryAfter = retryHeader === null || retryHeader === undefined ? null : Number(retryHeader);
    throw new TransportError(`Dropbox: ${summary}`, {
      status: response.status,
      code: summary,
      retryAfter: Number.isFinite(retryAfter) ? retryAfter : null
    });
  }

  async rpc(route, body) {
    const response = await this.request(`${API}${route}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) return this.parseError(response);
    return response.json();
  }

  async ensureFolder(pathValue) {
    if (this.readOnly) throw new Error('Skrivskyddad Dropbox-transport får inte skapa mappar');
    const path = normalizePath(pathValue);
    if (path === '/' || this.knownFolders.has(path)) return;
    await this.ensureFolder(parentPath(path));
    try {
      await this.rpc('/files/create_folder_v2', { path, autorename: false });
    } catch (error) {
      if (!(error instanceof TransportError) || error.status !== 409 || !String(error.code).includes('conflict/folder')) throw error;
    }
    this.knownFolders.add(path);
  }

  async upload(pathValue, value, mode) {
    if (this.readOnly) throw new Error('Skrivskyddad Dropbox-transport får inte ladda upp data');
    const path = normalizePath(pathValue);
    await this.ensureFolder(parentPath(path));
    const response = await this.request(`${CONTENT}/files/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ path, mode, autorename: false, mute: true, strict_conflict: true })
      },
      body: JSON.stringify(value)
    });
    if (!response.ok) return this.parseError(response);
    return response.json();
  }

  async putImmutable(path, value) {
    try {
      await this.upload(path, value, 'add');
      return { path, created: true };
    } catch (error) {
      if (!(error instanceof TransportError) || error.status !== 409 || !String(error.code).includes('conflict')) throw error;
      const existing = await this.getJson(path);
      if (canonicalStringify(existing) !== canonicalStringify(value)) throw new Error(`Oföränderlig Dropbox-kollision: ${path}`);
      return { path, created: false };
    }
  }

  async putMutable(path, value) {
    await this.upload(path, value, 'overwrite');
    return { path, created: true };
  }

  async getJson(pathValue) {
    const path = normalizePath(pathValue);
    const response = await this.request(`${CONTENT}/files/download`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Dropbox-API-Arg': JSON.stringify({ path }) }
    });
    if (!response.ok) return this.parseError(response);
    return cloneJson(await response.json());
  }

  async putBatch(batch) {
    validateBatch(batch);
    return this.putImmutable(batchPath(batch.device_id, batch.from_seq, batch.to_seq, this.opsRoot), batch);
  }

  async getCheckpoint() {
    try {
      const checkpoint = await this.getJson(this.checkpointPath);
      if (checkpoint?.checkpoint_version === 1) return checkpoint;
      if (checkpoint?.checkpoint_version !== 2) throw new TypeError('Dropbox-checkpointen har ett okänt format');
      const compressed = await this.getBytes(checkpoint.snapshot_path);
      const snapshot = await decodeCheckpointPayload(checkpoint, compressed, { opsRoot: this.opsRoot });
      return { ...checkpoint, snapshot };
    } catch (error) {
      if (error instanceof TransportError && error.status === 409 && String(error.code).includes('path/not_found')) return null;
      throw error;
    }
  }

  async putCheckpoint(checkpoint) {
    if (this.readOnly) throw new Error('Skrivskyddad Dropbox-transport får inte publicera checkpoints');
    return this.putMutable(this.checkpointPath, checkpoint);
  }

  async listChanges(cursor = null) {
    let result;
    if (cursor) {
      try {
        result = await this.rpc('/files/list_folder/continue', { cursor });
      } catch (error) {
        // En cursor är bunden till mappen som listades. Om appens namnrymd har
        // flyttats eller bytt namn kan Dropbox svara path/not_found i stället
        // för reset. Låt synkmotorn börja om från den aktuella ops-mappen.
        if (error instanceof TransportError && error.status === 409 && String(error.code).includes('path/not_found')) {
          throw new CursorResetError(error.code);
        }
        throw error;
      }
    } else {
      if (!this.readOnly) await this.ensureFolder(this.opsRoot);
      result = await this.rpc('/files/list_folder', {
        path: this.opsRoot, recursive: false, include_deleted: false, include_non_downloadable_files: false
      });
    }
    return {
      entries: (result.entries || [])
        .filter(entry => entry['.tag'] === 'file' && entry.path_display?.endsWith('.json'))
        .map(entry => ({ path: entry.path_display, rev: entry.rev })),
      cursor: result.cursor,
      has_more: Boolean(result.has_more)
    };
  }

  async getLatestCursor() {
    if (!this.readOnly) await this.ensureFolder(this.opsRoot);
    const result = await this.rpc('/files/list_folder/get_latest_cursor', {
      path: this.opsRoot, recursive: false, include_deleted: false, include_non_downloadable_files: false
    });
    return result.cursor;
  }

  async waitForChanges(cursor, { timeoutMs = 30_000 } = {}) {
    const timeout = Math.max(30, Math.min(480, Math.ceil(timeoutMs / 1000)));
    const response = await this.request(`${NOTIFY}/files/list_folder/longpoll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor, timeout })
    }, Math.max(this.requestTimeoutMs, (timeout + 15) * 1000));
    if (!response.ok) return this.parseError(response);
    const result = await response.json();
    return { changes: Boolean(result.changes), backoff: result.backoff ?? null };
  }

  async putBlobImmutable(pathValue, blob) {
    const path = normalizePath(pathValue);
    try {
      await this.uploadBytes(path, blob, 'add');
      return { path, created: true };
    } catch (error) {
      if (!(error instanceof TransportError) || error.status !== 409 || !String(error.code).includes('conflict')) throw error;
      return { path, created: false };
    }
  }

  async uploadBytes(pathValue, body, mode = 'overwrite') {
    const path = normalizePath(pathValue);
    await this.ensureFolder(parentPath(path));
    const response = await this.request(`${CONTENT}/files/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ path, mode, autorename: false, mute: true, strict_conflict: true })
      },
      body
    });
    if (!response.ok) return this.parseError(response);
    return response.json();
  }

  async getBlob(pathValue) {
    const path = normalizePath(pathValue);
    const response = await this.request(`${CONTENT}/files/download`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Dropbox-API-Arg': JSON.stringify({ path }) }
    });
    if (!response.ok) return this.parseError(response);
    return response.blob();
  }

  async getBytes(pathValue) {
    const path = normalizePath(pathValue);
    const response = await this.request(`${CONTENT}/files/download`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Dropbox-API-Arg': JSON.stringify({ path }) }
    });
    if (!response.ok) return this.parseError(response);
    return new Uint8Array(await response.arrayBuffer());
  }
}
