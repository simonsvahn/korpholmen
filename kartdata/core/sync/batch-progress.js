const safeSeq = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0;

function mergeRanges(ranges) {
  const sorted = ranges
    .map(range => [safeSeq(range?.[0]), safeSeq(range?.[1])])
    .filter(([from, to]) => from > 0 && to >= from)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range[0] > previous[1] + 1) merged.push([...range]);
    else previous[1] = Math.max(previous[1], range[1]);
  }
  return merged;
}

function normalizeEntry(value = {}) {
  let contiguous = safeSeq(value.contiguous);
  const pending = mergeRanges(Array.isArray(value.pending) ? value.pending : []);
  while (pending.length && pending[0][0] <= contiguous + 1) {
    const [from, to] = pending.shift();
    if (from <= contiguous + 1) contiguous = Math.max(contiguous, to);
  }
  return { contiguous, pending: pending.filter(([, to]) => to > contiguous) };
}

export function normalizeBatchProgress(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([deviceId]) => typeof deviceId === 'string' && deviceId)
    .map(([deviceId, entry]) => [deviceId, normalizeEntry(entry)]));
}

export function createBatchProgress(watermarks = {}, quarantines = []) {
  const progress = Object.fromEntries(Object.entries(watermarks || {}).map(([deviceId, seq]) => [deviceId, {
    contiguous: safeSeq(seq),
    pending: [],
  }]));
  const gapsByDevice = new Map();
  for (const record of quarantines || []) {
    const deviceId = record?.device_id;
    const fromSeq = safeSeq(record?.from_seq);
    const toSeq = safeSeq(record?.to_seq);
    if (!deviceId || fromSeq < 1 || toSeq < fromSeq) continue;
    if (!gapsByDevice.has(deviceId)) gapsByDevice.set(deviceId, []);
    gapsByDevice.get(deviceId).push([fromSeq, toSeq]);
  }
  for (const [deviceId, gapsValue] of gapsByDevice) {
    const maximum = safeSeq(watermarks?.[deviceId]);
    const gaps = mergeRanges(gapsValue).filter(([from]) => from <= maximum);
    if (!gaps.length) continue;
    const pending = [];
    let next = 1;
    for (const [from, to] of gaps) {
      if (from > next) pending.push([next, Math.min(maximum, from - 1)]);
      next = Math.max(next, to + 1);
    }
    if (next <= maximum) pending.push([next, maximum]);
    progress[deviceId] = normalizeEntry({ contiguous: gaps[0][0] - 1, pending });
  }
  return normalizeBatchProgress(progress);
}

export function addBatchRange(progress, descriptor) {
  if (!descriptor?.deviceId) return progress;
  const fromSeq = safeSeq(descriptor.fromSeq);
  const toSeq = safeSeq(descriptor.toSeq);
  if (fromSeq < 1 || toSeq < fromSeq) return progress;
  const entry = normalizeEntry(progress[descriptor.deviceId]);
  progress[descriptor.deviceId] = normalizeEntry({
    contiguous: entry.contiguous,
    pending: [...entry.pending, [fromSeq, toSeq]],
  });
  return progress;
}

export function contiguousSeq(progress, deviceId) {
  return normalizeEntry(progress?.[deviceId]).contiguous;
}

export function hasBatchGaps(progress) {
  return Object.values(normalizeBatchProgress(progress)).some(entry => entry.pending.length > 0);
}
