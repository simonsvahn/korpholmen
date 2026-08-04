export const REVIEW_STATUSES = ['ogranskad', 'bekräftad', 'rättad', 'osäker', 'utgår'];

// Kartdata v2 innehåller bara saktyper som ska kunna finnas i den aktiva datan.
// Kartsymbol, annat och den äldre pseudotypen "ingen masterpost" är avsiktligt
// inte tillåtna.
export const OBJECT_CLASSES = ['byggnad', 'plats', 'namnform', 'ägaretikett'];

export function stableEntityId(value) {
  return String(value || '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('sv')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function splitList(value) {
  return [...new Set(String(value || '').split(/[\n,;]+/).map(item => item.trim()).filter(Boolean))];
}

export function classLabel(value) {
  return { byggnad: 'Byggnad', plats: 'Plats', namnform: 'Namnform', ägaretikett: 'Ägaretikett' }[value] || value || 'Okänd';
}

export function objectTypeLabel(objectClass, subtype) {
  const base = classLabel(objectClass);
  const detail = String(subtype || '').trim();
  if (!detail || detail.toLocaleLowerCase('sv') === base.toLocaleLowerCase('sv')) return base;
  return `${base}: ${detail}`;
}

export function reviewStatusLabel(value) {
  return {
    ogranskad: 'Ogranskad', bekräftad: 'Bekräftad', rättad: 'Rättad', osäker: 'Osäker', utgår: 'Utgår',
  }[value] || value || 'Ogranskad';
}

export function entryIdNumber(value) {
  const match = String(value || '').match(/(\d+)/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function islandDeletionRefs({ id, names = [], islandLinks = [], relations = [], propertyLinks = [] }) {
  if (!id) return [];
  const refs = [{ entityType: 'place', entityId: id }];
  const add = (entityType, records) => records.forEach(record => refs.push({ entityType, entityId: record.id }));
  add('name-record', names.filter(record => record.target_type === 'place' && record.target_id === id));
  add('data-entry-island-link', islandLinks.filter(record => record.island_id === id));
  add('place-relation', relations.filter(record => record.child_id === id || record.parent_place_id === id));
  add('object-property-link', propertyLinks.filter(record => record.target_type === 'place' && record.target_id === id));
  return [...new Map(refs.map(ref => [`${ref.entityType}\u0000${ref.entityId}`, ref])).values()];
}
