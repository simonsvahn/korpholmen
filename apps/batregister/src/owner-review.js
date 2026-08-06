const normalize = value => String(value || '')
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu, '')
  .toLowerCase();

export const OWNER_REVIEW_CLASS_LABELS = Object.freeze({
  flera_personer_att_granska: 'Flera personer',
  maskinmatchad_identitet_kallkontroll_kravs: 'Personkandidat',
  'maskinmatchad_identitet_källkontroll_krävs': 'Personkandidat',
  osaker_eller_ofullstandig: 'Osäker eller ofullständig',
  'osäker_eller_ofullständig': 'Osäker eller ofullständig',
  saknar_kopplingskandidat: 'Saknar kandidat',
  tidigare_godkand_identitet_kallkontroll_kravs: 'Tidigare koppling',
  'tidigare_godkänd_identitet_källkontroll_krävs': 'Tidigare koppling',
  agarkedja_kraver_tidstolkning: 'Ägarkedja',
  'ägarkedja_kräver_tidstolkning': 'Ägarkedja',
  aldre_familjekoppling_att_mappa: 'Familjekoppling',
  'äldre_familjekoppling_att_mappa': 'Familjekoppling',
  strukturerad_agarkedja_att_granska: 'Befintlig ägarföljd',
  strukturerat_samagande_att_granska: 'Befintligt samägande',
  strukturerad_dubblett_att_ratta: 'Möjlig dubblett',
  ofullstandig_strukturerad_agarpart: 'Ofullständig ägarpart',
});

export function ownerReviewClassLabel(value) {
  return OWNER_REVIEW_CLASS_LABELS[value] || value || 'Övrigt';
}

export function unresolvedOwnerReviewRows({ inventory, boats = [], ownershipRecords = [] } = {}) {
  if (!Array.isArray(inventory?.rows)) return [];
  const boatIds = new Set(boats.map(boat => boat.id));
  const structuredBoatIds = new Set(ownershipRecords.map(record => record.boat_id).filter(Boolean));
  return inventory.rows
    .filter(row => boatIds.has(row.boat_id) && !structuredBoatIds.has(row.boat_id))
    .sort((left, right) => String(left.boat_name || '').localeCompare(String(right.boat_name || ''), 'sv'));
}

export function filterOwnerReviewRows(rows, { search = '', classification = '' } = {}) {
  const query = normalize(search);
  return rows.filter(row => {
    if (classification && row.classification !== classification) return false;
    if (!query) return true;
    const haystack = [
      row.boat_name,
      row.owner_text,
      ...(row.source_labels || []),
      ...(row.person_links || []).flatMap(link => [link.stored_name, link.person_id]),
      ...(row.family_links || []).flatMap(link => [link.legacy_family_name, link.legacy_family_id]),
      row.review_reason,
      ...(row.existing_ownerships || []).flatMap(item => [item.record?.party_label, item.record?.party_id, ...(item.record?.party_ids || [])]),
    ];
    return normalize(haystack.join(' ')).includes(query);
  });
}
