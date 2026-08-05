import { canonicalStringify } from '../domain/canonical.js';
import { formatHLC, parseHLC, validateNodeId } from '../domain/hlc.js';
import { Materializer } from '../domain/materializer.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
const SNAPSHOT_FORMAT = 3;
const DEFAULT_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

const assertSafeInteger = (value, label, minimum = 0) => {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${label} är ogiltigt`);
  return value;
};

const splitOperationId = value => {
  const text = String(value || '');
  const separator = text.lastIndexOf(':');
  if (separator < 1) throw new TypeError('Snapshotfältet har ogiltigt operations-id');
  const deviceId = text.slice(0, separator);
  const seq = Number(text.slice(separator + 1));
  assertSafeInteger(seq, 'Snapshotfältets operationssekvens', 1);
  return { deviceId, seq };
};

export function packSnapshot(snapshot) {
  if (snapshot?.snapshot_version !== 2 || !snapshot.op_watermarks || !Array.isArray(snapshot.entities)) {
    throw new TypeError('Endast kompakt snapshot v2 kan packas');
  }
  new Materializer(snapshot);
  const deviceIds = new Set(Object.keys(snapshot.op_watermarks));
  for (const entity of snapshot.entities) {
    for (const cell of entity.fields) {
      deviceIds.add(parseHLC(cell.hlc).node);
      deviceIds.add(splitOperationId(cell.op_id).deviceId);
    }
  }
  const devices = [...deviceIds].sort();
  const deviceIndex = new Map(devices.map((deviceId, index) => [deviceId, index]));
  return {
    snapshot_format: SNAPSHOT_FORMAT,
    devices: devices.map(deviceId => [deviceId, snapshot.op_watermarks[deviceId] ?? null]),
    entities: snapshot.entities.map(entity => [
      entity.entity_type,
      entity.entity_id,
      entity.fields.map(cell => {
        const hlc = parseHLC(cell.hlc);
        const operation = splitOperationId(cell.op_id);
        return [
          cell.field,
          cell.value,
          hlc.wallTime,
          hlc.counter,
          deviceIndex.get(hlc.node),
          deviceIndex.get(operation.deviceId),
          operation.seq,
        ];
      }),
    ]),
  };
}

export function unpackSnapshot(packed) {
  if (!packed || packed.snapshot_format !== SNAPSHOT_FORMAT || !Array.isArray(packed.devices) || !Array.isArray(packed.entities)) {
    throw new TypeError('Ogiltigt packat snapshotformat');
  }
  const deviceIds = [];
  const opWatermarks = {};
  for (const entry of packed.devices) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !entry[0]) {
      throw new TypeError('Ogiltig enhetstabell i snapshot');
    }
    if (deviceIds.includes(entry[0])) throw new Error(`Dubblerad snapshotenhet: ${entry[0]}`);
    deviceIds.push(validateNodeId(entry[0]));
    if (entry[1] !== null) opWatermarks[entry[0]] = assertSafeInteger(entry[1], 'Snapshotens vattenmärke');
  }
  const deviceAt = index => {
    assertSafeInteger(index, 'Snapshotens enhetsindex');
    if (index >= deviceIds.length) throw new RangeError('Snapshotens enhetsindex ligger utanför tabellen');
    return deviceIds[index];
  };
  const entities = packed.entities.map(rawEntity => {
    if (!Array.isArray(rawEntity) || rawEntity.length !== 3 || typeof rawEntity[0] !== 'string' || typeof rawEntity[1] !== 'string' || !Array.isArray(rawEntity[2])) {
      throw new TypeError('Ogiltig packad entitet');
    }
    return {
      entity_type: rawEntity[0],
      entity_id: rawEntity[1],
      fields: rawEntity[2].map(rawCell => {
        if (!Array.isArray(rawCell) || rawCell.length !== 7 || typeof rawCell[0] !== 'string' || !rawCell[0]) {
          throw new TypeError('Ogiltigt packat snapshotfält');
        }
        const wallTime = assertSafeInteger(rawCell[2], 'Snapshotfältets HLC-tid');
        const counter = assertSafeInteger(rawCell[3], 'Snapshotfältets HLC-räknare');
        const hlcDeviceId = deviceAt(rawCell[4]);
        const operationDeviceId = deviceAt(rawCell[5]);
        const seq = assertSafeInteger(rawCell[6], 'Snapshotfältets operationssekvens', 1);
        return {
          field: rawCell[0],
          value: rawCell[1],
          hlc: formatHLC({ wallTime, counter, node: hlcDeviceId }),
          op_id: `${operationDeviceId}:${seq}`,
        };
      }),
    };
  });
  const snapshot = { snapshot_version: 2, entities, applied: [], op_watermarks: opWatermarks };
  new Materializer(snapshot);
  return snapshot;
}

export async function sha256Hex(value, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle?.digest) throw new Error('SHA-256 saknas i denna webbläsare');
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  const digest = await cryptoImpl.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function validateCheckpointManifest(manifest, { opsRoot } = {}) {
  if (!manifest || manifest.checkpoint_version !== 2 || manifest.snapshot_format !== SNAPSHOT_FORMAT) {
    throw new TypeError('Ogiltigt checkpointmanifest');
  }
  if (manifest.compression !== 'gzip') throw new TypeError('Checkpointen har en okänd komprimering');
  if (typeof manifest.app_id !== 'string' || !manifest.app_id) throw new TypeError('Checkpointen saknar app-id');
  if (typeof manifest.ops_root !== 'string' || !manifest.ops_root.startsWith('/')) throw new TypeError('Checkpointen saknar operationsrot');
  if (opsRoot && manifest.ops_root !== opsRoot) throw new Error('Checkpointen tillhör fel operationsrot');
  const expectedAppId = manifest.ops_root.split('/').filter(Boolean).at(-2);
  if (manifest.app_id !== expectedAppId) throw new Error('Checkpointen tillhör fel app');
  const expectedSnapshotRoot = `${manifest.ops_root.slice(0, manifest.ops_root.lastIndexOf('/'))}/snapshots/`;
  if (typeof manifest.snapshot_path !== 'string' || !manifest.snapshot_path.startsWith(expectedSnapshotRoot) || manifest.snapshot_path.includes('..')) {
    throw new TypeError('Checkpointen har en ogiltig snapshotväg');
  }
  for (const field of ['compressed_sha256', 'payload_sha256', 'state_sha256']) {
    if (!SHA256_RE.test(String(manifest[field] || ''))) throw new TypeError(`Checkpointen har ogiltig ${field}`);
  }
  if (!manifest.snapshot_path.endsWith(`/${manifest.compressed_sha256}.snapshot-v3.json.gz`)) {
    throw new Error('Checkpointens sökväg matchar inte innehållshashen');
  }
  for (const field of ['compressed_bytes', 'payload_bytes', 'source_batch_count', 'source_operation_count']) {
    assertSafeInteger(manifest[field], `Checkpointens ${field}`);
  }
  if (!manifest.created_at || Number.isNaN(Date.parse(manifest.created_at))) throw new TypeError('Checkpointen saknar giltig tidpunkt');
  return manifest;
}

async function gunzip(bytes, DecompressionStreamImpl = globalThis.DecompressionStream) {
  if (typeof DecompressionStreamImpl !== 'function') throw new Error('Webbläsaren saknar stöd för komprimerade snapshots');
  const input = new Blob([bytes]).stream();
  const output = input.pipeThrough(new DecompressionStreamImpl('gzip'));
  return new Uint8Array(await new Response(output).arrayBuffer());
}

export async function decodeCheckpointPayload(manifestValue, compressedValue, options = {}) {
  const manifest = validateCheckpointManifest(manifestValue, options);
  const compressed = new Uint8Array(compressedValue);
  if (compressed.byteLength !== manifest.compressed_bytes) throw new Error('Checkpointens komprimerade storlek stämmer inte');
  if (await sha256Hex(compressed, options.cryptoImpl) !== manifest.compressed_sha256) throw new Error('Checkpointens komprimerade hash stämmer inte');
  const payload = await gunzip(compressed, options.DecompressionStreamImpl);
  const maximum = options.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED_BYTES;
  if (payload.byteLength > maximum || payload.byteLength !== manifest.payload_bytes) throw new Error('Checkpointens uppackade storlek stämmer inte');
  if (await sha256Hex(payload, options.cryptoImpl) !== manifest.payload_sha256) throw new Error('Checkpointens innehållshash stämmer inte');
  let packed;
  try { packed = JSON.parse(new TextDecoder().decode(payload)); }
  catch { throw new Error('Checkpointens JSON kan inte läsas'); }
  const snapshot = unpackSnapshot(packed);
  if (options.verifyStateHash && await sha256Hex(canonicalStringify(snapshot), options.cryptoImpl) !== manifest.state_sha256) {
    throw new Error('Checkpointens tillståndshash stämmer inte');
  }
  return snapshot;
}
