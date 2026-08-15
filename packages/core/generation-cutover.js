import { cloneJson } from './domain/canonical.js';

const SHA256_RE = /^[a-f0-9]{64}$/;

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} krävs`);
  return value.trim();
}

function isNotFound(error) {
  return error?.status === 409 && String(error?.code || '').includes('path/not_found');
}

export class GenerationCutoverError extends Error {
  constructor(message, { app, marker = null } = {}) {
    super(message);
    this.name = 'GenerationCutoverError';
    this.app = app;
    this.marker = marker ? cloneJson(marker) : null;
  }
}

export function validateGenerationCutoverMarker(marker, expectedApp) {
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) throw new TypeError('Övergångsmarkören måste vara ett objekt');
  if (marker.schema_version !== 1) throw new TypeError('Övergångsmarkören har fel schema_version');
  if (marker.app !== expectedApp) throw new TypeError(`Övergångsmarkören avser fel app: ${marker.app || 'okänd'}`);
  if (!['preparing', 'active'].includes(marker.state)) throw new TypeError('Övergångsmarkören har ogiltigt state');
  requireText(marker.v1_ops_root, 'v1_ops_root');
  requireText(marker.v2_pointer_path, 'v2_pointer_path');
  if (!String(marker.v1_ops_root).startsWith('/') || !String(marker.v2_pointer_path).startsWith('/')) throw new TypeError('Övergångens sökvägar måste vara absoluta');
  if (marker.v1_baseline_manifest_sha256 !== undefined && !SHA256_RE.test(String(marker.v1_baseline_manifest_sha256))) throw new TypeError('v1_baseline_manifest_sha256 är ogiltig');
  if (marker.v2_master_sha256 !== undefined && !SHA256_RE.test(String(marker.v2_master_sha256))) throw new TypeError('v2_master_sha256 är ogiltig');
  if (marker.state === 'active') {
    requireText(marker.activated_at, 'activated_at');
    requireText(marker.activated_by, 'activated_by');
    if (Number.isNaN(Date.parse(marker.activated_at))) throw new TypeError('activated_at är ogiltig');
    if (!SHA256_RE.test(String(marker.v1_baseline_manifest_sha256 || ''))) throw new TypeError('En aktiv övergång saknar V1-baslinje');
    if (!SHA256_RE.test(String(marker.v2_master_sha256 || ''))) throw new TypeError('En aktiv övergång saknar V2-masterhash');
  }
  return cloneJson(marker);
}

export class GenerationCutoverGuard {
  constructor({ app, transport, store, markerPath = null, cacheKey = null, refreshIntervalMs = 30_000, now = () => Date.now() } = {}) {
    this.app = requireText(app, 'app');
    if (typeof transport?.getJson !== 'function') throw new TypeError('GenerationCutoverGuard kräver en lästransport');
    if (typeof store?.getMeta !== 'function' || typeof store?.putMeta !== 'function') throw new TypeError('GenerationCutoverGuard kräver ett metalager');
    this.transport = transport;
    this.store = store;
    this.markerPath = markerPath || `/generation2-cutover/${this.app}.json`;
    if (!this.markerPath.startsWith('/') || this.markerPath.includes('..')) throw new TypeError('markerPath är ogiltig');
    this.cacheKey = cacheKey || `generation2-cutover:${this.app}`;
    this.refreshIntervalMs = Math.max(0, Number(refreshIntervalMs) || 0);
    this.now = now;
    this.lastRefreshAt = 0;
    this.marker = null;
  }

  async cachedMarker() {
    if (this.marker) return cloneJson(this.marker);
    const cached = await this.store.getMeta(this.cacheKey);
    if (!cached) return null;
    this.marker = validateGenerationCutoverMarker(cached, this.app);
    return cloneJson(this.marker);
  }

  async refresh({ force = false } = {}) {
    const cached = await this.cachedMarker();
    if (!force && this.lastRefreshAt && this.now() - this.lastRefreshAt < this.refreshIntervalMs) return cached;
    let remote = null;
    try {
      remote = validateGenerationCutoverMarker(await this.transport.getJson(this.markerPath), this.app);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    this.lastRefreshAt = this.now();
    if (cached?.state === 'active' && remote?.state !== 'active') {
      this.marker = cached;
      return cloneJson(cached);
    }
    this.marker = remote;
    if (remote) await this.store.putMeta(this.cacheKey, remote);
    return remote ? cloneJson(remote) : null;
  }

  async assertGeneration1Writable(context = {}) {
    const marker = await this.refresh();
    if (marker?.state === 'active') {
      throw new GenerationCutoverError(
        `${this.app} generation 1 är fryst sedan ${marker.activated_at}; ändringen får bara sparas i generation 2`,
        { app: this.app, marker },
      );
    }
    return { allowed: true, marker, context: cloneJson(context) };
  }
}
