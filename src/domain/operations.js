import { canonicalStringify, cloneJson } from './canonical.js?v=2026-08-01-8';
import { parseHLC } from './hlc.js?v=2026-08-01-8';

export const DELETE_FIELD = '__deleted';
export const RESET_FIELD = '__reset';
const IDENTIFIER_RE = /^[^\u0000-\u001f]{1,240}$/;

function requiredString(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} måste vara en sträng`);
  const text = value;
  if (!IDENTIFIER_RE.test(text)) throw new TypeError(`${label} är ogiltigt`);
  return text;
}

export function validateOperation(op) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) throw new TypeError('Operationen måste vara ett objekt');
  const deviceId = requiredString(op.device_id, 'device_id');
  if (!Number.isSafeInteger(op.seq) || op.seq < 1) throw new TypeError('seq måste vara ett positivt heltal');
  if (op.op_id !== `${deviceId}:${op.seq}`) throw new TypeError('op_id matchar inte device_id och seq');
  requiredString(op.entity_type, 'entity_type');
  requiredString(op.entity_id, 'entity_id');
  requiredString(op.field, 'field');
  const clock = parseHLC(op.hlc);
  if (clock.node !== deviceId) throw new TypeError('HLC-noden matchar inte device_id');
  cloneJson(op.value);
  if (!Number.isSafeInteger(op.schema_version) || op.schema_version < 1) throw new TypeError('schema_version är ogiltig');
  return op;
}

export function createSetOperation({ deviceId, seq, entityType, entityId, field, value, hlc, schemaVersion = 1 }) {
  if (field === DELETE_FIELD || field === RESET_FIELD) throw new TypeError('Använd den reserverade operationstypen för delete/restore/reset');
  const operation = {
    op_id: `${requiredString(deviceId, 'deviceId')}:${seq}`,
    device_id: deviceId,
    seq,
    entity_type: requiredString(entityType, 'entityType'),
    entity_id: requiredString(entityId, 'entityId'),
    field: requiredString(field, 'field'),
    value: cloneJson(value),
    hlc,
    schema_version: schemaVersion
  };
  validateOperation(operation);
  return Object.freeze(operation);
}

function tombstoneOperation(args, deleted) {
  const operation = {
    op_id: `${requiredString(args.deviceId, 'deviceId')}:${args.seq}`,
    device_id: args.deviceId,
    seq: args.seq,
    entity_type: requiredString(args.entityType, 'entityType'),
    entity_id: requiredString(args.entityId, 'entityId'),
    field: DELETE_FIELD,
    value: deleted,
    hlc: args.hlc,
    schema_version: args.schemaVersion ?? 1
  };
  validateOperation(operation);
  return Object.freeze(operation);
}

export const createDeleteOperation = args => tombstoneOperation(args, true);
export const createRestoreOperation = args => tombstoneOperation(args, false);

export function createResetOperation(args) {
  const operation = {
    op_id: `${requiredString(args.deviceId, 'deviceId')}:${args.seq}`,
    device_id: args.deviceId,
    seq: args.seq,
    entity_type: requiredString(args.entityType, 'entityType'),
    entity_id: requiredString(args.entityId, 'entityId'),
    field: RESET_FIELD,
    value: true,
    hlc: args.hlc,
    schema_version: args.schemaVersion ?? 1
  };
  validateOperation(operation);
  return Object.freeze(operation);
}

export function operationFingerprint(op) {
  validateOperation(op);
  return canonicalStringify(op);
}
