const LEGACY_VIEW_STATUS = Object.freeze({
  current: 'active',
  former: 'previous',
  not_member: 'not_member',
  unclear: 'unclear',
  passive: 'passive',
});

const LEGACY_CORE_STATUS = Object.freeze({
  active: 'current',
  previous: 'former',
  not_member: 'not_member',
  unclear: 'unclear',
  passive: 'passive',
});

export function membershipPersonId(membership = {}) {
  const reference = membership.person_ref;
  if (reference?.master === 'people' && reference.entity_type === 'person') return reference.entity_id || null;
  return membership.person_id || null;
}

export function deriveMembershipViewStatus(membership = {}, person = {}) {
  if (!membership.membership_level) return LEGACY_VIEW_STATUS[membership.status] || 'unclear';
  if (membership.membership_ended === true || person.living === false) return 'previous';
  if (person.living !== true) return 'unclear';
  if (membership.participation === 'passive') return 'passive';
  return 'active';
}

export function deriveLegacyMembershipStatus(membership = {}, person = {}) {
  return LEGACY_CORE_STATUS[deriveMembershipViewStatus(membership, person)] || 'unclear';
}
