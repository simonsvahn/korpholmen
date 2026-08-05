import {
  FAMILY_UNIT_TYPE,
  KIN_GROUP_TYPE,
  displayReference,
  familySelectionMatches,
  groupsForPerson,
  normalizeFamilyText,
  searchableFamilyTargets,
  targetMemberDetails,
} from '../core/family-context.js?v=2026-08-05-paket-3';

export const connectionTargetValue = target => `${target.type}:${target.id}`;

function personTerms(person) {
  return {
    identity: [person.display_name, person.full_name, person.birth_name, person.club_name, ...(person.aliases || [])]
      .map(normalizeFamilyText).filter(Boolean),
    context: [person.family, person.ui_clan, ...(person.family_labels || [])]
      .map(normalizeFamilyText).filter(Boolean),
  };
}

function termScore(query, term) {
  if (term === query) return 0;
  if (term.startsWith(query)) return 1;
  if (term.split(' ').some(word => word.startsWith(query))) return 2;
  if (term.includes(query)) return 3;
  return Number.MAX_SAFE_INTEGER;
}

export function searchPeopleForConnection(people, value, { limit = 6 } = {}) {
  const query = normalizeFamilyText(value);
  if (!query) return [];
  return people
    .map(person => {
      const terms = personTerms(person);
      const identityScore = terms.identity.length ? Math.min(...terms.identity.map(term => termScore(query, term))) : Number.MAX_SAFE_INTEGER;
      const contextScore = terms.context.length ? Math.min(...terms.context.map(term => termScore(query, term))) + 10 : Number.MAX_SAFE_INTEGER;
      return { person, score: Math.min(identityScore, contextScore) };
    })
    .filter(entry => Number.isFinite(entry.score) && entry.score < Number.MAX_SAFE_INTEGER)
    .sort((left, right) => left.score - right.score
      || String(left.person.display_name).localeCompare(String(right.person.display_name), 'sv'))
    .slice(0, limit)
    .map(entry => entry.person);
}

export function connectionTargetForValue(value, context) {
  if (!value) return null;
  const separator = value.indexOf(':');
  if (separator < 1) return null;
  const type = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (type === 'person') {
    const person = context.peopleById.get(id);
    return person ? { type, id, label: person.display_name, person } : null;
  }
  return searchableFamilyTargets(context).find(target => target.type === type && target.id === id) || null;
}

export function personScopeTargets(personId, context) {
  const person = context.peopleById.get(personId);
  if (!person) return [];
  const directMemberships = groupsForPerson(personId, context);
  const familyMemberships = directMemberships.filter(entry => entry.type === FAMILY_UNIT_TYPE);
  const kinGroups = new Map(directMemberships
    .filter(entry => entry.type === KIN_GROUP_TYPE)
    .map(entry => [entry.group.id, { ...entry.group, type: KIN_GROUP_TYPE }]));
  for (const membership of familyMemberships) {
    for (const kinGroupId of membership.group.kin_group_ids || []) {
      const group = context.kinGroupById.get(kinGroupId);
      if (group) kinGroups.set(group.id, { ...group, type: KIN_GROUP_TYPE });
    }
  }
  const families = familyMemberships.map(entry => ({ ...entry.group, type: FAMILY_UNIT_TYPE }));
  const sortedKinGroups = [...kinGroups.values()].sort((left, right) => {
    const leftCount = targetMemberDetails(left, context).length;
    const rightCount = targetMemberDetails(right, context).length;
    return leftCount - rightCount || String(left.reference_code).localeCompare(String(right.reference_code), 'sv', { numeric: true });
  });
  return [
    { type: 'person', id: person.id, label: person.display_name, person },
    ...families.map(group => ({ ...group, label: displayReference(group) })),
    ...sortedKinGroups.map(group => ({ ...group, label: displayReference(group) })),
  ];
}

export function boatMatchesConnection({
  boat,
  value,
  context,
  personLinks = [],
  groupLinks = [],
  legacyFamilyLabels = [],
} = {}) {
  if (!value) return true;
  const target = connectionTargetForValue(value, context);
  if (!target) return false;
  if (target.type === 'person') {
    return personLinks.some(link => link.person_id === target.id)
      || groupLinks.some(link => targetMemberDetails({ type: link.target_type, id: link.target_id }, context)
        .some(member => member.person_id === target.id));
  }
  return familySelectionMatches({
    target: { type: target.type, id: target.id },
    context,
    structuredAssociations: groupLinks,
    linkedPersonIds: personLinks.map(link => link.person_id),
    legacyFamilyLabels,
  });
}
