const SHA256_RE = /^[a-f0-9]{64}$/;

function requireRevision(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} saknar giltig masterrevision`);
  return value;
}

function requireHash(value, label) {
  if (!SHA256_RE.test(String(value || ''))) throw new TypeError(`${label} saknar giltig masterhash`);
  return value;
}

export function assertCompatibleActiveDependency(currentPointer, recordedDependency, label = 'Beroendet') {
  const currentRevision = requireRevision(currentPointer?.master_revision, `${label}: aktiv pekare`);
  const recordedRevision = requireRevision(recordedDependency?.master_revision, `${label}: sparat beroende`);
  const currentHash = requireHash(currentPointer?.master_sha256, `${label}: aktiv pekare`);
  const recordedHash = requireHash(recordedDependency?.master_sha256, `${label}: sparat beroende`);
  if (currentRevision < recordedRevision) throw new Error(`${label} har gått bakåt från revision ${recordedRevision} till ${currentRevision}`);
  if (currentRevision === recordedRevision && currentHash !== recordedHash) throw new Error(`${label} har samma revision men en annan masterhash`);
  return { compatible: true, advanced: currentRevision > recordedRevision, recorded_revision: recordedRevision, current_revision: currentRevision };
}
