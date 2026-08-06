export const SPEC_REVIEW_DOCUMENT_VERSION = 1;
export const SPEC_CHANGE_QUEUE_VERSION = 1;

export const SPEC_REVIEW_STATUSES = Object.freeze({
  draft: 'Utkast',
  ready: 'Klar för införande',
});

const clone = value => structuredClone(value);
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

export function emptySpecReviewDocument(pilotId) {
  if (!pilotId) throw new TypeError('Pilot-id saknas');
  return { document_version: SPEC_REVIEW_DOCUMENT_VERSION, pilot_id: pilotId, decisions: {} };
}

export function validateSpecReviewDecision(decision) {
  if (!decision?.decision_id || !decision.boat_id) throw new Error('Specifikationsrättelsen saknar identitet');
  if (!SPEC_REVIEW_STATUSES[decision.status]) throw new Error('Specifikationsrättelsen har en okänd status');
  if (!Array.isArray(decision.expected_specs)) throw new Error('Specifikationsrättelsen saknar före-bild');
  if (!decision.values || Array.isArray(decision.values) || typeof decision.values !== 'object') throw new Error('Specifikationsrättelsen saknar strukturerade värden');
  if (!Array.isArray(decision.resolves_fields) || !decision.resolves_fields.length) throw new Error('Specifikationsrättelsen ändrar inga fält');
  if (new Set(decision.resolves_fields).size !== decision.resolves_fields.length) throw new Error('Samma specifikationsfält anges flera gånger');
  if (!decision.field_actions || Array.isArray(decision.field_actions)) throw new Error('Specifikationsrättelsen saknar fältåtgärder');
  for (const field of decision.resolves_fields) if (!(field in decision.values)) throw new Error(`Specifikationsfältet ${field} saknar värde`);
  for (const field of decision.resolves_fields) {
    const action = decision.field_actions[field];
    if (!action || !['correct-source', 'add-fact'].includes(action.action)) throw new Error(`Specifikationsfältet ${field} saknar en giltig åtgärd`);
    if (action.action === 'correct-source' && !action.target_entity_id) throw new Error(`Källrättelsen för ${field} saknar målpost`);
    if (action.action === 'add-fact' && action.target_entity_id) throw new Error(`Det nya fältet ${field} får inte peka ut en källpost`);
  }
  return true;
}

export function normalizeSpecReviewDocument(value, pilotId) {
  if (!value) return emptySpecReviewDocument(pilotId);
  if (value.document_version !== SPEC_REVIEW_DOCUMENT_VERSION || value.pilot_id !== pilotId || !value.decisions || Array.isArray(value.decisions)) {
    throw new Error('Specifikationsrättelserna har fel format eller hör till en annan pilot');
  }
  const document = emptySpecReviewDocument(pilotId);
  for (const [boatId, decision] of Object.entries(value.decisions)) {
    if (decision?.boat_id !== boatId) throw new Error(`Specifikationsrättelsen har fel båt-ID: ${boatId}`);
    validateSpecReviewDecision(decision);
    document.decisions[boatId] = clone(decision);
  }
  return document;
}

export function saveSpecReviewDecision(document, decision) {
  validateSpecReviewDecision(decision);
  const next = normalizeSpecReviewDocument(document, document.pilot_id);
  next.decisions[decision.boat_id] = clone(decision);
  return next;
}

export function removeSpecReviewDecision(document, boatId) {
  const next = normalizeSpecReviewDocument(document, document.pilot_id);
  delete next.decisions[boatId];
  return next;
}

export function buildSpecChangeQueue({ document, boats = [], specRecords = [], exportedAt = new Date().toISOString() } = {}) {
  const normalized = normalizeSpecReviewDocument(document, document?.pilot_id);
  const boatById = new Map(boats.map(boat => [boat.id, boat]));
  const specsByBoat = new Map();
  for (const record of specRecords) {
    if (!specsByBoat.has(record.boat_id)) specsByBoat.set(record.boat_id, []);
    const { id, ...value } = record;
    specsByBoat.get(record.boat_id).push({ entity_id: id, record: value });
  }
  const decisions = Object.values(normalized.decisions)
    .filter(decision => decision.status === 'ready')
    .sort((left, right) => left.boat_id.localeCompare(right.boat_id, 'sv'))
    .map(decision => {
      validateSpecReviewDecision(decision);
      if (!boatById.has(decision.boat_id)) throw new Error(`Båten ${decision.boat_id} saknas i piloten`);
      const current = [...(specsByBoat.get(decision.boat_id) || [])].sort((left, right) => left.entity_id.localeCompare(right.entity_id));
      const expected = [...decision.expected_specs].sort((left, right) => left.entity_id.localeCompare(right.entity_id));
      if (!same(current, expected)) throw new Error(`Specifikationen har ändrats för ${boatById.get(decision.boat_id).namn || decision.boat_id}`);
      return clone(decision);
    });
  return {
    change_queue_version: SPEC_CHANGE_QUEUE_VERSION,
    source_document_version: SPEC_REVIEW_DOCUMENT_VERSION,
    pilot_id: normalized.pilot_id,
    exported_at: exportedAt,
    decisions,
  };
}
