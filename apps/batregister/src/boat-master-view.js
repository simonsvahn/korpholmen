const SPEC_LABELS = Object.freeze({
  category: 'Kategori',
  model: 'Modell',
  construction_year: 'Byggår',
  construction_year_approx: 'Byggår, cirka',
  sail_number: 'Segelnummer',
  length_m: 'Längd',
  length_ft: 'Längd',
  length_range_m: 'Längd',
  width_m: 'Bredd',
  draft_m: 'Djupgående',
  draft_or_height_m: 'Djup/höjd',
  freeboard_m: 'Fribord',
  weight_kg: 'Vikt',
  volume_l: 'Volym',
  load_capacity_kg: 'Lastkapacitet',
  displacement_t: 'Deplacement',
  color: 'Färg',
  propulsion: 'Framdrivning',
  fuel: 'Drivmedel',
  sail_area_m2: 'Segelyta',
  mast_m: 'Mast',
  stated_mast_m: 'Uppgiven mast',
  construction_material: 'Material',
  engine_brand: 'Motorfabrikat',
  engine_brand_text: 'Motorfabrikat',
  engine_count: 'Antal motorer',
  horsepower: 'Motorstyrka',
  horsepower_text: 'Motorstyrka',
  horsepower_per_engine: 'Motorstyrka per motor',
  engine_power_kw: 'Motorstyrka',
  engine_model: 'Motormodell',
  speed_kn: 'Fart',
  paddle_count: 'Antal paddlar',
  steering: 'Styrning',
  race_class: 'Tävlingsklass',
});

const CATEGORY_LABELS = Object.freeze({
  kayak: 'Kajak',
  motorboat: 'Motorbåt',
  rowboat: 'Rodd-/jollebåt',
  sailboat: 'Segelbåt',
  surfboard: 'Surfbräda',
  kiteboard: 'Kitesurfbräda',
});

export function boatDisplayName(boat) {
  return boat?.visningsnamn || boat?.namn || 'Namn okänt';
}

export function boatDisplayHeading(boat) {
  return [boatDisplayName(boat), boat?.visningsurskiljning].filter(Boolean).join(' · ');
}

export function pilotDisplayLabel(pilot) {
  const scope = String(pilot?.scope || '').split(':')[0].trim() || 'Pilot';
  const count = Array.isArray(pilot?.boat_ids) ? pilot.boat_ids.length : 0;
  return `${scope} · ${count} ${count === 1 ? 'båt' : 'båtar'}`;
}

export function pilotContainsBoat(pilot, boatId) {
  return Array.isArray(pilot?.boat_ids) && pilot.boat_ids.includes(boatId);
}

const pilotIdentity = pilot => pilot?.pilot_id || pilot?.id || '';

export function currentPilotRecords(records) {
  const superseded = new Set(records.map(record => record.supersedes).filter(Boolean));
  return records.filter(record => !superseded.has(pilotIdentity(record)));
}

export function resolvePilotRecord(records, value) {
  let current = records.find(record => pilotIdentity(record) === value) || null;
  const visited = new Set();
  while (current && !visited.has(pilotIdentity(current))) {
    visited.add(pilotIdentity(current));
    const successor = records.find(record => record.supersedes === pilotIdentity(current));
    if (!successor) break;
    current = successor;
  }
  return current;
}

export function formatObservationDate(date) {
  if (!date) return 'Tid okänd';
  if (date.precision === 'not_later_than') return `senast ${date.year}`;
  if (date.precision === 'observed') return `belagd ${date.year}`;
  if (date.precision === 'document_year') return `registrerat ${date.year}`;
  if (date.precision === 'registration_departure') return `${date.year} (registeravgång)`;
  return date.year ? String(date.year) : 'Tid okänd';
}

export function formatOwnershipPeriod(record) {
  if (!record?.start && !record?.end) return 'Tid okänd';
  if (record.start && record.end) {
    if (['not_later_than', 'observed'].includes(record.start.precision)) {
      return `belagd ${record.start.year}–${formatObservationDate(record.end)}`;
    }
    return `${formatObservationDate(record.start)}–${formatObservationDate(record.end)}`;
  }
  if (record.start) {
    if (record.start.precision === 'not_later_than') return `belagd senast ${record.start.year}`;
    if (record.start.precision === 'observed') return `belagd ${record.start.year}`;
    return `från ${formatObservationDate(record.start)}`;
  }
  return `till ${formatObservationDate(record.end)}`;
}

function ownershipPeriodKey(record) {
  return JSON.stringify({ start: record?.start || null, end: record?.end || null });
}

export function visibleOwnershipRecords(records) {
  return records.filter(record => {
    if (record.party_type !== 'person') return true;
    return !records.some(candidate => candidate.party_type === 'family-unit'
      && ownershipPeriodKey(candidate) === ownershipPeriodKey(record)
      && (record.source_ids || []).every(sourceId => (candidate.source_ids || []).includes(sourceId)));
  });
}

function naturalJoin(values) {
  if (values.length < 2) return values[0] || '';
  if (values.length === 2) return `${values[0]} och ${values[1]}`;
  return `${values.slice(0, -1).join(', ')} och ${values.at(-1)}`;
}

export function ownerPartyParts(owner, { people = [], familyUnits = [], kinGroups = [] } = {}) {
  const personById = new Map(people.map(person => [person.id, person]));
  if (owner?.party_type === 'person-set') {
    const linked = (owner.party_ids || []).map(personId => {
      const person = personById.get(personId);
      return person ? { type: 'person', id: personId, label: person.display_name || person.name || owner.party_label } : null;
    }).filter(Boolean);
    const unlinked = (owner.unlinked_party_names || []).map(label => ({ type: 'external-person', id: null, label }));
    if (linked.length === (owner.party_ids || []).length && (linked.length || unlinked.length)) return [...linked, ...unlinked];
    return owner.party_label ? [{ type: 'person-set', id: null, label: owner.party_label }] : [...linked, ...unlinked];
  }
  if (owner?.party_type === 'person' && owner.party_id) {
    const person = personById.get(owner.party_id);
    return [{ type: 'person', id: owner.party_id, label: person?.display_name || person?.name || owner.party_label || owner.party_id }];
  }
  if (owner?.party_type === 'family-unit' && owner.party_id) {
    const family = familyUnits.find(item => item.id === owner.party_id);
    return [{ type: 'family-unit', id: owner.party_id, label: family?.name || owner.party_label || owner.party_id }];
  }
  if (owner?.party_type === 'kin-group' && owner.party_id) {
    const group = kinGroups.find(item => item.id === owner.party_id);
    return [{ type: 'kin-group', id: owner.party_id, label: group?.name || owner.party_label || owner.party_id }];
  }
  return owner?.party_label ? [{ type: owner.party_type || 'external-person', id: owner.party_id || null, label: owner.party_label }] : [];
}

export function ownerPartyText(owner, context = {}) {
  return naturalJoin(ownerPartyParts(owner, context).map(part => part.label).filter(Boolean));
}

export function conflictingSpecFields(observations) {
  const resolvedFields = new Set(observations
    .filter(observation => observation.status === 'accepted')
    .flatMap(observation => observation.resolves_fields || []));
  const valuesByField = new Map();
  for (const observation of observations) {
    for (const [field, value] of Object.entries(observation.values || {})) {
      if (resolvedFields.has(field)) continue;
      if (value === null || value === undefined || value === '') continue;
      if (!valuesByField.has(field)) valuesByField.set(field, new Set());
      valuesByField.get(field).add(JSON.stringify(value));
    }
  }
  return [...valuesByField.entries()].filter(([, values]) => values.size > 1).map(([field]) => field);
}

function acceptedSpecResolutions(observations) {
  const resolutions = new Map();
  observations.forEach((observation, index) => {
    if (observation.status !== 'accepted') return;
    const acceptedAt = Date.parse(observation.accepted_at || '') || 0;
    for (const field of observation.resolves_fields || []) {
      const current = resolutions.get(field);
      if (!current || acceptedAt > current.acceptedAt || (acceptedAt === current.acceptedAt && index > current.index)) {
        resolutions.set(field, { observation, acceptedAt, index });
      }
    }
  });
  return resolutions;
}

export function effectiveSpecValues(observations) {
  const values = {};
  const resolutions = acceptedSpecResolutions(observations);
  for (const [field, { observation }] of resolutions) values[field] = observation.values?.[field] ?? null;
  for (const observation of observations) {
    for (const [field, value] of Object.entries(observation.values || {})) {
      if (field in values || value === null || value === undefined || value === '') continue;
      values[field] = value;
    }
  }
  return values;
}

const DIMENSION_FIELDS = Object.freeze([
  'length_m',
  'length_ft',
  'length_range_m',
  'width_m',
  'draft_m',
  'draft_or_height_m',
  'freeboard_m',
  'weight_kg',
  'displacement_t',
]);

const OWNERSHIP_EVENT_TYPES = new Set([
  'acquired',
  'owner_change',
  'owner_change_recorded',
  'ownership_departure',
  'ownership_transfer',
  'sold',
]);

const hasValue = value => value !== null && value !== undefined && value !== '';

function ownershipPartyKey(record) {
  if (record.party_id) return `${record.party_type || 'party'}:${record.party_id}`;
  if (Array.isArray(record.party_ids) && record.party_ids.length) return `${record.party_type || 'party'}:${[...record.party_ids].sort().join('+')}`;
  return `${record.party_type || 'party'}:${record.party_label || ''}`;
}

export function boatQualityFlags({
  boat,
  nameObservations = [],
  ownershipObservations = [],
  specObservations = [],
  eventObservations = [],
  reviewItems = [],
} = {}) {
  const flags = new Set();
  const specs = specObservations.flatMap(observation => Object.entries(observation.values || {}));
  const owners = visibleOwnershipRecords(ownershipObservations);
  const partyKeys = new Set(owners.map(ownershipPartyKey).filter(key => !key.endsWith(':')));
  const factRecords = [...nameObservations, ...owners, ...specObservations, ...eventObservations];
  const substantiveRecords = [...owners, ...specObservations, ...eventObservations];

  if (specs.some(([field, value]) => ['horsepower', 'horsepower_per_engine'].includes(field) && hasValue(value))) flags.add('horsepower');
  if (specs.some(([field, value]) => field === 'engine_brand' && hasValue(value))) flags.add('engine-brand');
  if (specs.some(([field, value]) => DIMENSION_FIELDS.includes(field) && hasValue(value))) flags.add('dimensions');
  if (owners.length) flags.add('structured-owner');
  if (partyKeys.size > 1 || eventObservations.some(event => OWNERSHIP_EVENT_TYPES.has(event.event_type))) flags.add('ownership-change');
  if (eventObservations.length) flags.add('history');
  if ((boat?.images || []).length > 1) flags.add('multiple-images');
  if (sourceIdsForRecords(factRecords).length > 1) flags.add('multiple-sources');
  if (conflictingSpecFields(specObservations).length) flags.add('conflict');
  if (reviewItems.some(item => item.status !== 'resolved' && item.status !== 'closed')) flags.add('open-review');
  if (!owners.length && hasValue(boat?.agare)) flags.add('unstructured-owner');
  if (!substantiveRecords.length) flags.add('legacy-only');

  return flags;
}

export function specRows(observations) {
  const rows = [];
  for (const [field, value] of Object.entries(effectiveSpecValues(observations))) {
      if (value === null || value === undefined || value === '') continue;
      let display = value;
      if (field === 'category') display = CATEGORY_LABELS[value] || value;
      else if (['length_m', 'width_m', 'draft_m', 'freeboard_m'].includes(field)) display = `${value} m`;
      else if (field === 'length_range_m' && Array.isArray(value)) display = `${value.join('–')} m`;
      else if (field === 'draft_or_height_m') display = `${value} m`;
      else if (field === 'length_ft') display = `${value} fot`;
      else if (field === 'weight_kg') display = `${value} kg`;
      else if (field === 'volume_l') display = `${value} L`;
      else if (field === 'load_capacity_kg') display = `${value} kg`;
      else if (field === 'displacement_t') display = `${value} ton`;
      else if (field === 'sail_area_m2') display = `${value} m²`;
      else if (field === 'mast_m') display = `${value} m`;
      else if (field === 'stated_mast_m') display = `${value} m`;
      else if (['horsepower', 'horsepower_per_engine'].includes(field)) display = `${value} hk`;
      else if (field === 'engine_power_kw') display = `${value} kW`;
      else if (field === 'speed_kn') display = `${value} kn`;
      else if (Array.isArray(value)) display = value.join(', ');
      rows.push({ field, label: SPEC_LABELS[field] || field, value: display });
  }
  return rows;
}

export function sourceIdsForRecords(records) {
  return [...new Set(records.flatMap(record => record.source_ids || []))];
}
