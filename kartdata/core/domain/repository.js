import { compareHLC, createClock } from './hlc.js';
import { Materializer } from './materializer.js';
import { createDeleteOperation, createResetOperation, createRestoreOperation, createSetOperation, validateOperation } from './operations.js';

export class Repository {
  constructor({ store, deviceId, now = () => Date.now() }) {
    const required = ['appendOps', 'commitLocalOps', 'getAllOps', 'getMeta', 'putMeta', 'getSnapshot', 'saveSnapshot'];
    if (!store || required.some(method => typeof store[method] !== 'function')) throw new TypeError('Repository kräver ett komplett op-lager');
    if (typeof deviceId !== 'string' || !deviceId) throw new TypeError('Repository kräver deviceId');
    this.store = store;
    this.deviceId = deviceId;
    this.now = now;
    this.state = new Materializer();
    this.seq = 0;
    this.clock = null;
    this.initialized = false;
    // Monoton lokal revisionsräknare för billiga läscacher. Den beskriver
    // materialiserarens tillstånd, inte synksekvensen och sparas därför inte.
    this.revision = 0;
  }

  async init() {
    const ops = await this.store.getAllOps();
    const latestSnapshotId = await this.store.getMeta('latest_snapshot');
    const snapshot = latestSnapshotId ? await this.store.getSnapshot(latestSnapshotId) : null;
    this.state = new Materializer(snapshot);
    this.state.applyAll(ops);
    const snapshotOwnMax = snapshot?.applied?.reduce((max, entry) => {
      const prefix = `${this.deviceId}:`;
      if (!entry.op_id.startsWith(prefix)) return max;
      const seq = Number(entry.op_id.slice(prefix.length));
      return Number.isSafeInteger(seq) ? Math.max(max, seq) : max;
    }, 0) ?? 0;
    const ownMax = ops.reduce((max, op) => op.device_id === this.deviceId ? Math.max(max, op.seq) : max, snapshotOwnMax);
    const storedSeq = await this.store.getMeta(`seq:${this.deviceId}`);
    this.seq = Math.max(ownMax, Number.isSafeInteger(storedSeq) ? storedSeq : 0);
    const snapshotHlcs = snapshot?.entities?.flatMap(entity => entity.fields.map(cell => cell.hlc)) ?? [];
    const latestHlc = [...snapshotHlcs, ...ops.map(op => op.hlc)].reduce((latest, value) => !latest || compareHLC(value, latest) > 0 ? value : latest, null);
    this.clock = createClock(this.deviceId, this.now, latestHlc);
    this.initialized = true;
    this.revision += 1;
    return this;
  }

  assertReady() {
    if (!this.initialized) throw new Error('Repository.init() måste köras först');
  }

  async commit(factory) {
    this.assertReady();
    const [operation] = await this.store.commitLocalOps({
      deviceId: this.deviceId,
      minimumSeq: this.seq,
      build: nextSeq => [factory(nextSeq, this.clock.tick())]
    });
    this.state.apply(operation);
    this.seq = operation.seq;
    this.revision += 1;
    return operation;
  }

  async commitMany(factories) {
    this.assertReady();
    if (!Array.isArray(factories) || !factories.length) return [];
    const operations = await this.store.commitLocalOps({
      deviceId: this.deviceId,
      minimumSeq: this.seq,
      build: nextSeq => factories.map((factory, index) => factory(nextSeq + index, this.clock.tick()))
    });
    this.state.applyAll(operations);
    this.seq = operations.at(-1).seq;
    this.revision += 1;
    return operations;
  }

  setField(entityType, entityId, field, value) {
    return this.commit((seq, hlc) => createSetOperation({
      deviceId: this.deviceId, seq, entityType, entityId, field, value, hlc
    }));
  }

  // En användarhandling med flera fält blir en enda atomisk lokal commit.
  // Lagret tilldelar sekvensintervallet i samma transaktion som operationerna
  // skrivs, så två flikar med samma deviceId aldrig kan återanvända ett op-id.
  setFields(entries) {
    return this.commitMany(entries.map(entry => (seq, hlc) => createSetOperation({
      deviceId: this.deviceId,
      seq,
      entityType: entry.entityType,
      entityId: entry.entityId,
      field: entry.field,
      value: entry.value,
      hlc
    })));
  }

  // Deterministiska länkar kan ha tombstonats tidigare. En ny användarhandling
  // ska då återställa länken och skriva dess fält i samma lokala transaktion.
  // Aktiva och helt nya entiteter får ingen onödig restore-operation.
  upsertFields(entries) {
    this.assertReady();
    if (!Array.isArray(entries) || !entries.length) return Promise.resolve([]);
    const factories = [];
    const seen = new Set();
    for (const entry of entries) {
      const key = `${entry.entityType}\u0000${entry.entityId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const current = this.state.getEntity(entry.entityType, entry.entityId, { includeDeleted: true });
      if (current?.deleted) factories.push((seq, hlc) => createRestoreOperation({
        deviceId: this.deviceId,
        seq,
        entityType: entry.entityType,
        entityId: entry.entityId,
        hlc
      }));
    }
    factories.push(...entries.map(entry => (seq, hlc) => createSetOperation({
      deviceId: this.deviceId,
      seq,
      entityType: entry.entityType,
      entityId: entry.entityId,
      field: entry.field,
      value: entry.value,
      hlc
    })));
    return this.commitMany(factories);
  }

  deleteEntity(entityType, entityId) {
    return this.commit((seq, hlc) => createDeleteOperation({
      deviceId: this.deviceId, seq, entityType, entityId, hlc
    }));
  }

  deleteEntities(entries) {
    return this.commitMany(entries.map(entry => (seq, hlc) => createDeleteOperation({
      deviceId: this.deviceId,
      seq,
      entityType: entry.entityType,
      entityId: entry.entityId,
      hlc
    })));
  }

  restoreEntity(entityType, entityId) {
    return this.commit((seq, hlc) => createRestoreOperation({
      deviceId: this.deviceId, seq, entityType, entityId, hlc
    }));
  }

  restoreEntities(entries) {
    return this.commitMany(entries.map(entry => (seq, hlc) => createRestoreOperation({
      deviceId: this.deviceId,
      seq,
      entityType: entry.entityType,
      entityId: entry.entityId,
      hlc
    })));
  }

  // Exakt restore: varje entitet får först en reset-gräns som gör samtliga
  // äldre fält osynliga. Därefter skrivs exakt målfälten och slutligen önskat
  // tombstone-läge. Hela planen får ett atomiskt sekvensintervall i lagret.
  replaceEntities(entries) {
    if (!Array.isArray(entries) || !entries.length) return Promise.resolve([]);
    const factories = [];
    for (const entry of entries) {
      factories.push((seq, hlc) => createResetOperation({
        deviceId: this.deviceId, seq, entityType: entry.entityType, entityId: entry.entityId, hlc
      }));
    }
    for (const entry of entries) {
      for (const [field, value] of Object.entries(entry.fields || {})) {
        factories.push((seq, hlc) => createSetOperation({
          deviceId: this.deviceId, seq, entityType: entry.entityType, entityId: entry.entityId, field, value, hlc
        }));
      }
    }
    for (const entry of entries) {
      const create = entry.deleted ? createDeleteOperation : createRestoreOperation;
      factories.push((seq, hlc) => create({
        deviceId: this.deviceId, seq, entityType: entry.entityType, entityId: entry.entityId, hlc
      }));
    }
    return this.commitMany(factories);
  }

  async applyRemoteOps(ops) {
    this.assertReady();
    ops.forEach(validateOperation);
    await this.store.appendOps(ops);
    const result = this.state.applyAll(ops);
    const latest = ops.reduce((value, op) => !value || compareHLC(op.hlc, value) > 0 ? op.hlc : value, null);
    if (latest) this.clock.observe(latest);
    const ownMax = ops.reduce((max, op) => op.device_id === this.deviceId ? Math.max(max, op.seq) : max, this.seq);
    this.seq = ownMax;
    if (ops.length) this.revision += 1;
    return result;
  }

  getEntity(type, id, options) {
    this.assertReady();
    return this.state.getEntity(type, id, options);
  }

  listEntities(type, options) {
    this.assertReady();
    return this.state.listEntities(type, options);
  }

  async saveSnapshot(id = 'latest') {
    this.assertReady();
    const snapshot = this.state.exportSnapshot();
    await this.store.saveSnapshot(id, snapshot);
    await this.store.putMeta('latest_snapshot', String(id));
    return snapshot;
  }
}
