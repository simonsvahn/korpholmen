const uniqueIds = values => [...new Set((values || []).map(value => String(value || '')).filter(Boolean))];

export function propertySelectionState(selectedIds, propertyReferences) {
  const references = Array.isArray(propertyReferences) ? propertyReferences : [];
  const referenceById = new Map(references.map(property => [String(property.external_id), property]));
  const selected = uniqueIds(selectedIds).map(id => ({
    id,
    property: referenceById.get(id) || null,
    known: referenceById.has(id),
  }));
  const selectedSet = new Set(selected.map(item => item.id));
  return {
    selected,
    available: references.filter(property => !selectedSet.has(String(property.external_id))),
  };
}

export function validatePropertySelection({ selectedIds, propertyReferences, existingIds } = {}) {
  const selected = uniqueIds(selectedIds);
  const known = new Set((propertyReferences || []).map(property => String(property.external_id)));
  const existing = new Set(uniqueIds(existingIds));
  const invalid = selected.filter(id => !known.has(id) && !existing.has(id));
  if (invalid.length) throw new Error(`En vald fastighet saknas i Fastighetshistorik: ${invalid.join(', ')}`);
  return selected;
}
