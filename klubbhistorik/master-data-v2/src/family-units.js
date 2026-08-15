import { MasterValidationError } from './errors.js';

const sv = (left, right) => String(left).localeCompare(String(right), 'sv');

function active(record) {
  return record && !record.deleted_at;
}

function approvedRelation(record) {
  return active(record) && record.needs_review !== true;
}

function requirePersonIds(personIds, label = 'anchor_person_ids') {
  if (!Array.isArray(personIds) || personIds.length < 2) {
    throw new MasterValidationError(`${label} måste innehålla minst två personer`);
  }
  if (personIds.some((personId) => typeof personId !== 'string' || !personId.trim())) {
    throw new MasterValidationError(`${label} innehåller ett ogiltigt person-id`);
  }
}

export function familyAnchorKey(personIds) {
  requirePersonIds(personIds);
  return [...new Set(personIds)].sort(sv).join('|');
}

/**
 * Härleder de konkreta familjebildningar som redan följer av godkända
 * personrelationer. Funktionen skapar inga relationer och gör inga påståenden
 * om ägande, medlemskap eller boende.
 */
export function deriveFamilyUnitCandidates({ people = [], relations = [] } = {}) {
  const activePersonIds = new Set(people.filter(active).map((person) => person.id));
  const byKey = new Map();

  function add(personIds, basis) {
    const unique = [...new Set(personIds)].filter((personId) => activePersonIds.has(personId));
    if (unique.length < 2 || unique.length !== new Set(personIds).size) return;
    const key = familyAnchorKey(unique);
    const existing = byKey.get(key) ?? { anchor_person_ids: key.split('|'), bases: [] };
    if (!existing.bases.some((row) => row.kind === basis.kind && row.relation_id === basis.relation_id && row.child_id === basis.child_id)) {
      existing.bases.push(basis);
    }
    byKey.set(key, existing);
  }

  const approved = relations.filter(approvedRelation);
  for (const relation of approved) {
    if (!['partner', 'tidigare'].includes(relation.relation_type)) continue;
    add([relation.from_person_id, relation.to_person_id], {
      kind: relation.relation_type,
      relation_id: relation.id,
    });
  }

  const parentsByChild = new Map();
  for (const relation of approved.filter((row) => row.relation_type === 'foralder-barn')) {
    if (!parentsByChild.has(relation.to_person_id)) parentsByChild.set(relation.to_person_id, new Set());
    parentsByChild.get(relation.to_person_id).add(relation.from_person_id);
  }
  for (const [childId, parentIds] of parentsByChild) {
    if (parentIds.size < 2) continue;
    add([...parentIds], { kind: 'shared_parents', child_id: childId });
  }

  return [...byKey.values()]
    .map((candidate) => ({
      ...candidate,
      bases: candidate.bases.sort((left, right) => sv(`${left.kind}:${left.relation_id ?? left.child_id}`, `${right.kind}:${right.relation_id ?? right.child_id}`)),
    }))
    .sort((left, right) => sv(familyAnchorKey(left.anchor_person_ids), familyAnchorKey(right.anchor_person_ids)));
}

export function planMissingFamilyUnits({
  people = [],
  relations = [],
  familyUnits = [],
  createId,
  changedAt,
  changedBy,
  decisionId,
  firstReferenceNumber,
} = {}) {
  if (typeof createId !== 'function') throw new MasterValidationError('createId måste vara en funktion');
  if (typeof changedAt !== 'string' || Number.isNaN(Date.parse(changedAt))) throw new MasterValidationError('changedAt måste vara en giltig tidsstämpel');
  if (typeof changedBy !== 'string' || !changedBy.trim()) throw new MasterValidationError('changedBy måste anges');
  if (typeof decisionId !== 'string' || !decisionId.trim()) throw new MasterValidationError('decisionId måste anges');

  const peopleById = new Map(people.filter(active).map((person) => [person.id, person]));
  const existingKeys = new Map();
  const existingIds = new Set();
  const usedReferenceNumbers = [];
  for (const family of familyUnits.filter(active)) {
    existingIds.add(family.id);
    existingKeys.set(familyAnchorKey(family.anchor_person_ids), family);
    const match = /^FAMILJ-(\d+)$/.exec(family.reference_code ?? '');
    if (match) usedReferenceNumbers.push(Number(match[1]));
  }
  let nextNumber = Number.isSafeInteger(firstReferenceNumber)
    ? firstReferenceNumber
    : Math.max(0, ...usedReferenceNumbers) + 1;

  const candidates = deriveFamilyUnitCandidates({ people, relations });
  const missing = [];
  for (const candidate of candidates) {
    const key = familyAnchorKey(candidate.anchor_person_ids);
    if (existingKeys.has(key)) continue;
    let id = createId(candidate.anchor_person_ids, candidate);
    if (typeof id !== 'string' || !id.trim()) throw new MasterValidationError(`createId gav inget id för ${key}`);
    if (existingIds.has(id)) throw new MasterValidationError(`createId gav ett befintligt id: ${id}`);
    while (usedReferenceNumbers.includes(nextNumber)) nextNumber += 1;
    const referenceCode = `FAMILJ-${String(nextNumber).padStart(3, '0')}`;
    nextNumber += 1;
    const displayName = candidate.anchor_person_ids
      .map((personId) => peopleById.get(personId)?.display_name ?? personId)
      .join(' och ');
    const family = {
      id,
      reference_code: referenceCode,
      display_name: displayName,
      display_name_mode: 'derived',
      anchor_person_ids: [...candidate.anchor_person_ids],
      membership_rule: 'anchors_and_shared_children',
      related_kin_group_ids: [],
      allowed_as_owner_target: true,
      decision_id: decisionId,
      decision_scope: 'Automatiskt materialiserad teknisk familjeenhet från godkända personrelationer. Fastställer inte båtägande, fastighetsägande, medlemskap eller boende.',
      derivation_bases: candidate.bases,
      needs_review: false,
      review_comment: '',
      updated_at: changedAt,
      updated_by: changedBy,
    };
    missing.push(family);
    existingIds.add(id);
    existingKeys.set(key, family);
    usedReferenceNumbers.push(Number(referenceCode.slice('FAMILJ-'.length)));
  }
  return { candidates, missing };
}
