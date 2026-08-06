export const SOURCE_VIEW_MANIFEST_VERSION = 1;

const clone = value => structuredClone(value);

export function normalizeSourceViewManifest(value, pilotId) {
  if (!value) return null;
  if (value.source_view_manifest_version !== SOURCE_VIEW_MANIFEST_VERSION || value.pilot_id !== pilotId || !Array.isArray(value.sources)) {
    throw new Error('Källvisningen har fel format eller hör till en annan pilot');
  }
  const sourceIds = new Set();
  const manifest = clone(value);
  for (const entry of manifest.sources) {
    if (!entry?.source?.id || sourceIds.has(entry.source.id) || !Array.isArray(entry.artifacts)) throw new Error('Källvisningen innehåller en ogiltig källpost');
    sourceIds.add(entry.source.id);
  }
  manifest.boat_source_ids = manifest.boat_source_ids && !Array.isArray(manifest.boat_source_ids) ? manifest.boat_source_ids : {};
  return manifest;
}

export function mergedSourceRecords(masterSources = [], manifest = null) {
  const records = new Map(masterSources.map(source => [source.id, source]));
  for (const entry of manifest?.sources || []) if (!records.has(entry.source.id)) records.set(entry.source.id, clone(entry.source));
  return [...records.values()];
}

export function sourceViewEntry(manifest, sourceId) {
  return manifest?.sources?.find(entry => entry.source.id === sourceId) || null;
}

export function sourceIdsForBoatInManifest(manifest, boatId) {
  return [...new Set(manifest?.boat_source_ids?.[boatId] || [])];
}
