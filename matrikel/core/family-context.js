export const FAMILY_UNIT_TYPE = 'family-unit';
export const KIN_GROUP_TYPE = 'kin-group';

export const KIN_GROUP_KINDS = Object.freeze({
  sibling_group: 'Syskongrupp',
  branch: 'Släktgren',
  stem_line: 'Stamlinje',
  family_circle: 'Släktkrets',
});

export const MEMBERSHIP_RULES = Object.freeze({
  explicit: 'Endast uttryckliga personer',
  anchors_and_children: 'Ankarpersoner och barn',
  anchors_and_descendants: 'Ankarpersoner och efterkommande',
});

export const FAMILY_TARGET_LABELS = Object.freeze({
  person: 'Person',
  [FAMILY_UNIT_TYPE]: 'Familj',
  [KIN_GROUP_TYPE]: 'Släkt',
  property: 'Fastighet',
});

export function normalizeFamilyText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('sv')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function familySlug(value) {
  return normalizeFamilyText(value).replace(/\s+/g, '-') || 'okand';
}

export function isConfirmed(value) {
  return value === true || value === 'ja' || value === 'bekräftad' || value === 'godkänd';
}

export function relationIsConfirmed(relation) {
  return isConfirmed(relation?.confirmed) || isConfirmed(relation?.user_confirmed);
}

export function referencePrefix(entityType) {
  if (entityType === FAMILY_UNIT_TYPE) return 'FAMILJ';
  if (entityType === KIN_GROUP_TYPE) return 'SLÄKT';
  if (entityType === 'person') return 'PERSON';
  if (entityType === 'boat') return 'BÅT';
  if (entityType === 'property') return 'FASTIGHET';
  throw new Error(`Okänd referenstyp: ${entityType}`);
}

export function nextReferenceCode(entityType, records = []) {
  const prefix = referencePrefix(entityType);
  const expression = new RegExp(`^${prefix}-(\\d+)$`, 'i');
  const highest = records.reduce((max, record) => {
    const match = String(record?.reference_code || '').match(expression);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `${prefix}-${String(highest + 1).padStart(3, '0')}`;
}

export function readableReference(record) {
  const code = String(record?.reference_code || '').trim();
  const name = String(record?.name || '').trim();
  if (!code) return name;
  return name ? `${code}--${familySlug(name)}` : code;
}

export function displayReference(record) {
  return [record?.reference_code, record?.name].filter(Boolean).join(' · ');
}

function addToMapSet(map, key, value) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

function addToMapArray(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function propertyIdsByPerson(propertyLinks) {
  const result = new Map();
  for (const link of propertyLinks || []) {
    if (!link?.person_id || !link?.property_id) continue;
    addToMapSet(result, link.person_id, link.property_id);
  }
  return result;
}

export function buildFamilyContext({
  people = [],
  relations = [],
  familyUnits = [],
  kinGroups = [],
  properties = [],
  propertyLinks = [],
} = {}) {
  const propertyIds = propertyIdsByPerson(propertyLinks);
  const enrichedPeople = people.map(person => ({
    ...person,
    property_ids: [...new Set([...(person.property_ids || []), ...(propertyIds.get(person.id) || [])])],
  }));
  const peopleById = new Map(enrichedPeople.map(person => [person.id, person]));
  const childrenByParent = new Map();
  const parentsByChild = new Map();
  const siblingsByPerson = new Map();
  for (const relation of relations) {
    const from = relation?.from_person_id;
    const to = relation?.to_person_id;
    if (!peopleById.has(from) || !peopleById.has(to)) continue;
    if (relation.kind === 'foralder-barn') {
      addToMapArray(childrenByParent, from, { person_id: to, relation });
      addToMapArray(parentsByChild, to, { person_id: from, relation });
    } else if (relation.kind === 'syskon') {
      addToMapArray(siblingsByPerson, from, { person_id: to, relation });
      addToMapArray(siblingsByPerson, to, { person_id: from, relation });
    }
  }
  return {
    people: enrichedPeople,
    peopleById,
    relations,
    childrenByParent,
    parentsByChild,
    siblingsByPerson,
    familyUnits,
    familyUnitById: new Map(familyUnits.map(group => [group.id, group])),
    kinGroups,
    kinGroupById: new Map(kinGroups.map(group => [group.id, group])),
    properties,
    propertyById: new Map(properties.map(property => [property.id, property])),
    propertyLinks,
  };
}

function mergeMembership(result, candidate) {
  const current = result.get(candidate.person_id);
  if (!current) {
    result.set(candidate.person_id, candidate);
    return;
  }
  const candidateHasGeneration = Number.isInteger(candidate.generation);
  const currentHasGeneration = Number.isInteger(current.generation);
  if (candidateHasGeneration && (!currentHasGeneration || candidate.generation < current.generation)) {
    result.set(candidate.person_id, candidate);
    return;
  }
  if (candidate.generation === current.generation && candidate.confirmed && !current.confirmed) {
    result.set(candidate.person_id, candidate);
  }
}

function seedPeople(result, ids, context, confirmed, role = 'uttrycklig medlem') {
  for (const personId of ids || []) {
    if (!context.peopleById.has(personId)) continue;
    mergeMembership(result, { person_id: personId, generation: 1, confirmed, role });
  }
}

function generationSortValue(value) {
  return Number.isInteger(value) ? value : Number.MAX_SAFE_INTEGER;
}

function descendants(anchorIds, context, groupConfirmed, maxDepth = Infinity) {
  const result = new Map();
  const queue = [];
  for (const personId of anchorIds || []) {
    if (!context.peopleById.has(personId)) continue;
    const item = { person_id: personId, generation: 1, confirmed: groupConfirmed, role: 'ankarperson' };
    result.set(personId, item);
    queue.push(item);
  }
  while (queue.length) {
    const current = queue.shift();
    if (current.generation >= maxDepth) continue;
    for (const edge of context.childrenByParent.get(current.person_id) || []) {
      const candidate = {
        person_id: edge.person_id,
        generation: current.generation + 1,
        confirmed: current.confirmed && relationIsConfirmed(edge.relation),
        role: 'efterkommande',
      };
      const previous = result.get(candidate.person_id);
      mergeMembership(result, candidate);
      if (!previous || candidate.generation < previous.generation || (candidate.confirmed && !previous.confirmed)) queue.push(candidate);
    }
  }
  return result;
}

export function familyUnitMemberDetails(group, context) {
  const confirmed = isConfirmed(group?.confirmed);
  const rule = group?.membership_rule || 'anchors_and_children';
  const maxDepth = rule === 'anchors_and_children' ? 2 : rule === 'anchors_and_descendants' ? Infinity : 1;
  const result = descendants(group?.anchor_person_ids || [], context, confirmed, maxDepth);
  seedPeople(result, group?.explicit_person_ids, context, confirmed);
  return [...result.values()].sort((a, b) => generationSortValue(a.generation) - generationSortValue(b.generation)
    || String(context.peopleById.get(a.person_id)?.display_name).localeCompare(String(context.peopleById.get(b.person_id)?.display_name), 'sv'));
}

export function kinGroupMemberDetails(group, context, trail = new Set()) {
  if (!group || trail.has(group.id)) return [];
  const confirmed = isConfirmed(group.confirmed);
  const rule = group.membership_rule || 'explicit';
  const maxDepth = rule === 'anchors_and_descendants' ? Infinity : rule === 'anchors_and_children' ? 2 : 1;
  const result = descendants(group.anchor_person_ids || [], context, confirmed, maxDepth);
  const relativeToThisGroup = descendants(group.anchor_person_ids || [], context, confirmed, Infinity);
  seedPeople(result, group.explicit_person_ids, context, confirmed);
  const nextTrail = new Set(trail).add(group.id);
  for (const childId of group.child_group_ids || []) {
    const child = context.kinGroupById.get(childId);
    for (const member of kinGroupMemberDetails(child, context, nextTrail)) {
      if (result.has(member.person_id)) continue;
      const relative = relativeToThisGroup.get(member.person_id);
      mergeMembership(result, {
        ...member,
        generation: relative?.generation ?? null,
        confirmed: confirmed && member.confirmed && (relative?.confirmed ?? true),
        role: `via ${child?.name || 'undergrupp'}`,
      });
    }
  }
  return [...result.values()].sort((a, b) => generationSortValue(a.generation) - generationSortValue(b.generation)
    || String(context.peopleById.get(a.person_id)?.display_name).localeCompare(String(context.peopleById.get(b.person_id)?.display_name), 'sv'));
}

export function targetMemberDetails(target, context) {
  if (!target?.type || !target?.id) return [];
  if (target.type === 'person') return context.peopleById.has(target.id)
    ? [{ person_id: target.id, generation: 1, confirmed: true, role: 'person' }]
    : [];
  if (target.type === FAMILY_UNIT_TYPE) return familyUnitMemberDetails(context.familyUnitById.get(target.id), context);
  if (target.type === KIN_GROUP_TYPE) return kinGroupMemberDetails(context.kinGroupById.get(target.id), context);
  if (target.type === 'property') {
    return context.people
      .filter(person => (person.property_ids || []).includes(target.id))
      .map(person => ({ person_id: person.id, generation: 1, confirmed: true, role: 'fastighetsgemenskap' }));
  }
  return [];
}

export function targetMemberIds(target, context) {
  return targetMemberDetails(target, context).map(member => member.person_id);
}

export function targetFamilyLabels(target, context) {
  const labels = targetMemberIds(target, context).flatMap(personId => {
    const person = context.peopleById.get(personId);
    return [person?.family, ...(person?.family_labels || [])];
  });
  return [...new Set(labels.map(value => String(value || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'sv'));
}

export function familySelectionMatches({
  target,
  context,
  structuredAssociations = [],
  linkedPersonIds = [],
  legacyFamilyLabels = [],
} = {}) {
  if (!target?.type || !target?.id || !context) return false;
  if (structuredAssociations.some(association => associationAppliesToTarget(association, target, context))) return true;
  const memberIds = new Set(targetMemberIds(target, context));
  if (linkedPersonIds.some(personId => memberIds.has(personId))) return true;
  // Äldre familjeetiketter beskriver släktgrenar, inte säkert en enskild
  // familjebildning. De används därför bara som övergång för SLÄKT-filter.
  if (target.type !== KIN_GROUP_TYPE) return false;
  const targetLabels = new Set(targetFamilyLabels(target, context).map(normalizeFamilyText));
  return legacyFamilyLabels.some(label => targetLabels.has(normalizeFamilyText(label)));
}

export function groupsForPerson(personId, context) {
  const result = [];
  for (const group of context.familyUnits) {
    const membership = familyUnitMemberDetails(group, context).find(member => member.person_id === personId);
    if (membership) result.push({ type: FAMILY_UNIT_TYPE, group, membership });
  }
  for (const group of context.kinGroups) {
    const membership = kinGroupMemberDetails(group, context).find(member => member.person_id === personId);
    if (membership) result.push({ type: KIN_GROUP_TYPE, group, membership });
  }
  return result.sort((a, b) => String(a.group.reference_code).localeCompare(String(b.group.reference_code), 'sv', { numeric: true }));
}

export function familyTargetCatalog(context) {
  return [
    ...context.people
      .slice()
      .sort((a, b) => String(a.display_name).localeCompare(String(b.display_name), 'sv'))
      .map(person => ({ type: 'person', id: person.id, label: person.display_name })),
    ...context.familyUnits.map(group => ({
      type: FAMILY_UNIT_TYPE,
      id: group.id,
      label: displayReference(group),
    })),
    ...context.kinGroups.map(group => ({
      type: KIN_GROUP_TYPE,
      id: group.id,
      label: displayReference(group),
    })),
  ];
}

export function associationMemberIds(association, context) {
  return targetMemberIds({ type: association?.target_type, id: association?.target_id }, context);
}

export function associationAppliesToTarget(association, target, context) {
  if (!association?.target_type || !association?.target_id || !target?.type || !target?.id) return false;
  if (association.target_type === target.type && association.target_id === target.id) return true;
  const associationMembers = new Set(associationMemberIds(association, context));
  return targetMemberIds(target, context).some(personId => associationMembers.has(personId));
}

export function targetTypeLabel(type) {
  return FAMILY_TARGET_LABELS[type] || type || 'Anknytning';
}

export function relativeGenerationLabel(member, group) {
  if (!member || !group || !Number.isInteger(member.generation)) return '';
  const ordinal = member.generation === 1 ? 'första' : member.generation === 2 ? 'andra' : member.generation === 3 ? 'tredje' : `${member.generation}:e`;
  return `${ordinal} släktledet i ${group.name}`;
}
