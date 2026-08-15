import { canonicalStringify, cloneJson } from './canonical.js';
import { compareHLC, parseHLC } from './hlc.js';
import { DELETE_FIELD, RESET_FIELD, operationFingerprint, validateOperation } from './operations.js';

const entityKey = (type, id) => `${type}\u0000${id}`;
const cloneCell = cell => ({ value: cloneJson(cell.value), hlc: cell.hlc, op_id: cell.op_id });

function compareCell(candidate, current) {
  if (!current) return 1;
  const clockOrder = compareHLC(candidate.hlc, current.hlc);
  if (clockOrder !== 0) return clockOrder;
  return candidate.op_id === current.op_id ? 0 : (candidate.op_id < current.op_id ? -1 : 1);
}

export class Materializer {
  constructor(snapshot = null) {
    this.entities = new Map();
    this.applied = new Map();
    this.opWatermarks = new Map();
    if (snapshot) this.loadSnapshot(snapshot);
  }

  apply(op) {
    validateOperation(op);
    const fingerprint = operationFingerprint(op);
    const previousFingerprint = this.applied.get(op.op_id);
    if (previousFingerprint) {
      if (previousFingerprint !== fingerprint) throw new Error(`Kollision för op_id ${op.op_id}`);
      return { applied: false, reason: 'duplicate' };
    }

    this.opWatermarks.set(op.device_id, Math.max(this.opWatermarks.get(op.device_id) || 0, op.seq));

    const key = entityKey(op.entity_type, op.entity_id);
    let entity = this.entities.get(key);
    if (!entity) {
      entity = { entity_type: op.entity_type, entity_id: op.entity_id, fields: new Map() };
      this.entities.set(key, entity);
    }
    const candidate = { value: cloneJson(op.value), hlc: op.hlc, op_id: op.op_id };
    const current = entity.fields.get(op.field);
    const wins = compareCell(candidate, current) > 0;
    if (wins) entity.fields.set(op.field, candidate);
    this.applied.set(op.op_id, fingerprint);
    return { applied: wins, reason: wins ? 'winner' : 'older' };
  }

  applyAll(ops) {
    const result = { winners: 0, duplicates: 0, older: 0 };
    for (const op of ops) {
      const one = this.apply(op);
      if (one.reason === 'winner') result.winners += 1;
      else if (one.reason === 'duplicate') result.duplicates += 1;
      else result.older += 1;
    }
    return result;
  }

  getEntity(type, id, { includeDeleted = false, includeCells = false } = {}) {
    const entity = this.entities.get(entityKey(type, id));
    if (!entity) return null;
    const reset = entity.fields.get(RESET_FIELD);
    const visibleAfterReset = cell => cell && (!reset || compareCell(cell, reset) > 0);
    const deletedCell = entity.fields.get(DELETE_FIELD);
    const deleted = visibleAfterReset(deletedCell) && deletedCell.value === true;
    if (deleted && !includeDeleted) return null;
    const fields = {};
    for (const [field, cell] of entity.fields) {
      if (field === DELETE_FIELD || field === RESET_FIELD || !visibleAfterReset(cell)) continue;
      fields[field] = includeCells ? cloneCell(cell) : cloneJson(cell.value);
    }
    return { entity_type: type, entity_id: id, deleted, fields };
  }

  listEntities(type, options = {}) {
    const out = [];
    for (const entity of this.entities.values()) {
      if (entity.entity_type !== type) continue;
      const record = this.getEntity(type, entity.entity_id, options);
      if (record) out.push(record);
    }
    return out;
  }

  exportSnapshot({ compactApplied = false } = {}) {
    const entities = [...this.entities.values()]
      .map(entity => ({
        entity_type: entity.entity_type,
        entity_id: entity.entity_id,
        fields: [...entity.fields.entries()]
          .map(([field, cell]) => ({ field, ...cloneCell(cell) }))
          .sort((a, b) => a.field.localeCompare(b.field))
      }))
      .sort((a, b) => (a.entity_type + '\u0000' + a.entity_id).localeCompare(b.entity_type + '\u0000' + b.entity_id));
    const applied = compactApplied ? [] : [...this.applied.entries()]
      .map(([op_id, fingerprint]) => ({ op_id, fingerprint }))
      .sort((a, b) => a.op_id.localeCompare(b.op_id));
    if (!compactApplied) return { snapshot_version: 1, entities, applied };
    const op_watermarks = Object.fromEntries([...this.opWatermarks.entries()].sort(([a], [b]) => a.localeCompare(b)));
    return { snapshot_version: 2, entities, applied, op_watermarks };
  }

  loadSnapshot(snapshot) {
    if (!snapshot || ![1, 2].includes(snapshot.snapshot_version) || !Array.isArray(snapshot.entities) || !Array.isArray(snapshot.applied)) throw new TypeError('Ogiltig snapshot');
    if (snapshot.snapshot_version === 2 && (!snapshot.op_watermarks || typeof snapshot.op_watermarks !== 'object' || Array.isArray(snapshot.op_watermarks))) throw new TypeError('Ogiltiga vattenmärken i snapshot');
    canonicalStringify(snapshot);
    const entityKeys = new Set();
    const appliedIds = new Set();
    for (const raw of snapshot.entities) {
      if (!raw || typeof raw.entity_type !== 'string' || !raw.entity_type || typeof raw.entity_id !== 'string' || !raw.entity_id || !Array.isArray(raw.fields)) throw new TypeError('Ogiltig entitet i snapshot');
      const key = entityKey(raw.entity_type, raw.entity_id);
      if (entityKeys.has(key)) throw new Error(`Dubblerad entitet i snapshot: ${raw.entity_type}:${raw.entity_id}`);
      entityKeys.add(key);
      const fieldNames = new Set();
      for (const cell of raw.fields) {
        if (!cell || typeof cell.field !== 'string' || !cell.field || typeof cell.op_id !== 'string' || !cell.op_id) throw new TypeError('Ogiltig fältcell i snapshot');
        if (fieldNames.has(cell.field)) throw new Error(`Dubblerat fält i snapshot: ${cell.field}`);
        fieldNames.add(cell.field);
        parseHLC(cell.hlc);
        cloneJson(cell.value);
      }
    }
    for (const entry of snapshot.applied) {
      if (!entry || typeof entry.op_id !== 'string' || !entry.op_id || typeof entry.fingerprint !== 'string') throw new TypeError('Ogiltigt applied-index i snapshot');
      if (appliedIds.has(entry.op_id)) throw new Error(`Dubblerat op-id i snapshot: ${entry.op_id}`);
      appliedIds.add(entry.op_id);
    }
    if (snapshot.snapshot_version === 2) {
      for (const [deviceId, seq] of Object.entries(snapshot.op_watermarks)) {
        if (!deviceId || !Number.isSafeInteger(seq) || seq < 0) throw new TypeError('Ogiltigt vattenmärke i snapshot');
      }
    }
    this.entities.clear();
    this.applied.clear();
    this.opWatermarks.clear();
    for (const raw of snapshot.entities) {
      const fields = new Map();
      for (const cell of raw.fields) fields.set(cell.field, { value: cloneJson(cell.value), hlc: cell.hlc, op_id: cell.op_id });
      this.entities.set(entityKey(raw.entity_type, raw.entity_id), { entity_type: raw.entity_type, entity_id: raw.entity_id, fields });
    }
    for (const entry of snapshot.applied) {
      this.applied.set(entry.op_id, entry.fingerprint);
      const separator = entry.op_id.lastIndexOf(':');
      const deviceId = entry.op_id.slice(0, separator);
      const seq = Number(entry.op_id.slice(separator + 1));
      if (deviceId && Number.isSafeInteger(seq)) this.opWatermarks.set(deviceId, Math.max(this.opWatermarks.get(deviceId) || 0, seq));
    }
    if (snapshot.snapshot_version === 2) {
      for (const [deviceId, seq] of Object.entries(snapshot.op_watermarks)) this.opWatermarks.set(deviceId, seq);
    }
  }
}

export function materialize(ops, snapshot = null) {
  const materializer = new Materializer(snapshot);
  materializer.applyAll(ops);
  return materializer;
}
