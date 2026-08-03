export const REVIEW_STATUSES = ['ogranskad', 'bekräftad', 'rättad', 'osäker', 'utgår'];

export const OBJECT_CLASSES = [
  'byggnad',
  'plats',
  'namnform',
  'ägaretikett',
  'kartsymbol',
  'annat',
  'ingen masterpost',
];

export const BUILDING_TYPES = new Set([
  'Bostadshus', 'Gäststuga', 'Bod', 'Annan byggnad', 'Dass', 'Bastu', 'Sjöbod/brygga',
]);

const ISLAND_DISPLAY_NAMES = new Map([
  ['Stora Korpholmen', 'Korpholmen'],
  ['Stora Sviholmen', 'Sviholmen'],
]);

export function normalizeIslandDisplay(value) {
  const text = String(value || '').trim();
  return ISLAND_DISPLAY_NAMES.get(text) || text || null;
}

export function propertyIdsFromText(value) {
  const result = [];
  for (const match of String(value || '').matchAll(/(?:Alsvik\s+)?3:\d+/gi)) {
    const token = match[0].replace(/\s+/g, ' ').trim();
    const id = /^Alsvik\s+/i.test(token) ? `Alsvik ${token.replace(/^Alsvik\s+/i, '')}` : `Alsvik ${token}`;
    if (!result.includes(id)) result.push(id);
  }
  return result;
}

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

function correctedPropertyIds(entry) {
  const correction = String(entry.prior_correction || '');
  const corrected = /^Fastighet\b/i.test(correction) ? propertyIdsFromText(correction) : [];
  return corrected.length ? corrected : propertyIdsFromText(entry.source_property);
}

function correctedName(entry) {
  const correction = String(entry.prior_correction || '').trim();
  if (!correction || /^Fastighet\b/i.test(correction)) return entry.source_name || null;
  if (/^[\p{L}\p{N} .,'’´()\/-]{1,60}$/u.test(correction)) return correction;
  return entry.source_name || null;
}

export function proposedObjectClass(entry) {
  const type = String(entry.prior_type_decision || '');
  const mapType = String(entry.source_name_type || '');
  if (/ägaretikett/i.test(mapType)) return 'ägaretikett';
  if (/symbol/i.test(mapType)) return 'kartsymbol';
  if (type === 'Utgått/fel') return 'ingen masterpost';
  if (BUILDING_TYPES.has(type)) return 'byggnad';
  if (type === 'Plats/ej byggnad') return 'plats';
  if (type === 'Äldre namn' || /äldre namn/i.test(mapType)) return 'namnform';
  if (/ortnamn|plats/i.test(mapType)) return 'plats';
  if (/husnamn/i.test(mapType)) return 'byggnad';
  return 'annat';
}

export function proposedReview(entry) {
  const objectClass = proposedObjectClass(entry);
  return {
    review_status: objectClass === 'ingen masterpost' ? 'utgår' : 'bekräftad',
    review_name: correctedName(entry),
    review_object_class: objectClass,
    review_subtype: entry.prior_type_decision || null,
    review_island: normalizeIslandDisplay(entry.source_island),
    review_property_ids: correctedPropertyIds(entry),
    review_note: null,
    review_basis: 'tidigare arbetsförslag godkänt i Kartdata',
  };
}

export function effectiveEntry(entry) {
  const proposal = proposedReview(entry);
  const reviewed = entry.review_status && entry.review_status !== 'ogranskad';
  return {
    ...entry,
    effective_name: reviewed ? entry.review_name || entry.source_name : proposal.review_name || entry.source_name,
    effective_object_class: reviewed ? entry.review_object_class || proposal.review_object_class : proposal.review_object_class,
    effective_subtype: reviewed ? entry.review_subtype || null : proposal.review_subtype,
    effective_island: reviewed ? entry.review_island || null : proposal.review_island,
    effective_property_ids: reviewed ? entry.review_property_ids || [] : proposal.review_property_ids,
    effective_status: entry.review_status || 'ogranskad',
  };
}

export function classLabel(value) {
  return {
    byggnad: 'Byggnad', plats: 'Plats', namnform: 'Namnform', ägaretikett: 'Ägaretikett',
    kartsymbol: 'Kartsymbol', annat: 'Annat', 'ingen masterpost': 'Ingen masterpost',
  }[value] || value || 'Okänd';
}

export function objectTypeLabel(objectClass, subtype) {
  const base = classLabel(objectClass);
  const detail = String(subtype || '').trim();
  if (!detail || detail === 'Plats/ej byggnad' || detail === 'Utgått/fel') return base;
  if (detail.toLocaleLowerCase('sv') === base.toLocaleLowerCase('sv')) return base;
  return `${base}: ${detail}`;
}

export function reviewStatusLabel(value) {
  return {
    ogranskad: 'Ogranskad', bekräftad: 'Bekräftad', rättad: 'Rättad', osäker: 'Osäker', utgår: 'Utgår',
  }[value] || value || 'Ogranskad';
}

export function entrySearchText(entry) {
  const effective = effectiveEntry(entry);
  return [
    entry.id, entry.source_island, entry.source_property, entry.source_owner_label, entry.source_current_owner,
    entry.source_name, entry.source_name_type, entry.source_note, entry.prior_type_decision, entry.prior_correction,
    effective.effective_name, effective.effective_object_class, effective.effective_subtype,
    effective.effective_island, ...(effective.effective_property_ids || []), entry.review_note,
  ].filter(Boolean).join(' ');
}

export function sourceIdNumber(value) {
  const match = String(value || '').match(/(\d+)/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}
