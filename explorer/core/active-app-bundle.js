import { ActiveJsonMaster } from './active-json-master.js';

export class ActiveAppBundle {
  constructor({ store, cacheKey, sources = {} } = {}) {
    this.sources = Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, new ActiveJsonMaster({
      store,
      cacheKey: `${cacheKey}:${name}`,
      pointerPath: source.pointerPath,
      app: source.app,
      requiredCollections: source.requiredCollections || [],
    })]));
  }

  async init() {
    await Promise.all(Object.values(this.sources).map(source => source.init()));
    return this;
  }

  hasData(name) { return Boolean(this.sources[name]?.hasData()); }

  list(name, collection) { return this.sources[name]?.list(collection) || []; }

  get(name, collection, id) { return this.sources[name]?.get(collection, id) || null; }

  pointer(name) { return this.sources[name]?.pointer || null; }

  revision(name) { return this.sources[name]?.masterRevision || 0; }

  async sync(transport) {
    const rows = await Promise.all(Object.entries(this.sources).map(async ([name, source]) => [name, await source.sync(transport)]));
    return Object.fromEntries(rows);
  }
}

export const createActiveAppBundle = options => new ActiveAppBundle(options);
