export const OWNER_REVIEW_DOCUMENT_VERSION = 1;
export const OWNER_CHANGE_QUEUE_VERSION = 3;

export const OWNER_REVIEW_STATUSES = Object.freeze({
  unreviewed: 'Ogranskad',
  draft: 'Utkast',
  ready: 'Klar för införande',
  needs_research: 'Behöver utredas',
  applied: 'Införd i master',
});

export const OWNER_ROLES = Object.freeze({ owner: 'Ägare' });
export const OWNER_PARTY_TYPES = Object.freeze(['person', 'person-set', 'family-unit', 'kin-group', 'external-person']);
export const OWNER_DATE_PRECISIONS = Object.freeze(['year', 'circa', 'not_later_than', 'observed']);
const OWNER_AUTHORITY_PATTERN = /(^|\s)(owner|ownership|previous owner|family ownership|seller statement|sale|acquisition)(\s|$)/;

const clone = value => structuredClone(value);
const compact = values => [...new Set((values || []).filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

export function sourceSupportsOwnership(source) {
  return compact(source?.authority_for).some(value => OWNER_AUTHORITY_PATTERN.test(value.toLowerCase()));
}

export function emptyOwnerReviewDocument(pilotId) {
  if (!pilotId) throw new TypeError('Pilot-id saknas');
  return { document_version: OWNER_REVIEW_DOCUMENT_VERSION, pilot_id: pilotId, decisions: {} };
}

export function normalizeOwnerReviewDocument(value, pilotId) {
  if (!value) return emptyOwnerReviewDocument(pilotId);
  if (value.document_version !== OWNER_REVIEW_DOCUMENT_VERSION || value.pilot_id !== pilotId || !value.decisions || Array.isArray(value.decisions)) {
    throw new Error('Granskningsbesluten har fel format eller hör till en annan pilot');
  }
  const document = emptyOwnerReviewDocument(pilotId);
  for (const [boatId, decision] of Object.entries(value.decisions)) {
    if (decision?.boat_id !== boatId) throw new Error(`Granskningsbeslutet har fel båt-ID: ${boatId}`);
    const normalizedDecision = {
      ...clone(decision),
      mode: decision.mode || 'insert',
      expected_ownerships: clone(decision.expected_ownerships || []),
      ownerships: (decision.ownerships || []).map((proposal, index) => ({ ...clone(proposal), sequence: proposal.sequence || index + 1 })),
    };
    validateOwnerReviewDecision(normalizedDecision);
    document.decisions[boatId] = normalizedDecision;
  }
  return document;
}

function validateDate(value, label) {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value.year) || value.year < 1000 || value.year > 2200) throw new Error(`${label} har ett ogiltigt årtal`);
  if (!OWNER_DATE_PRECISIONS.includes(value.precision)) throw new Error(`${label} har en ogiltig tidsprecision`);
}

export function validateOwnerProposal(proposal, { requireSources = false, ownerSourceIds = null } = {}) {
  if (!proposal?.proposal_id) throw new Error('Ägarposten saknar ID');
  if (!OWNER_ROLES[proposal.role]) throw new Error('Ägarposten har en okänd strukturerad roll');
  if (!OWNER_PARTY_TYPES.includes(proposal.party_type)) throw new Error('Ägarposten har en okänd partstyp');
  if (!Number.isInteger(proposal.sequence) || proposal.sequence < 1) throw new Error('Ägarposten saknar en giltig ordningsföljd');
  if (proposal.party_type === 'person-set') {
    const ids = compact(proposal.party_ids);
    if (ids.length < 2) throw new Error('Flera personer kräver minst två separata person-ID:n');
    if (!proposal.party_label) throw new Error('Flerpersonsägandet saknar visningsnamn');
  } else if (proposal.party_type === 'external-person') {
    if (!proposal.party_label) throw new Error('Den externa personen saknar namn');
  } else if (!proposal.party_id || !proposal.party_label) {
    throw new Error('Ägarparten saknar stabilt ID eller visningsnamn');
  }
  validateDate(proposal.start, 'Starttiden');
  validateDate(proposal.end, 'Sluttiden');
  if (proposal.start?.year && proposal.end?.year && proposal.end.year < proposal.start.year) throw new Error('Slutåret kan inte ligga före startåret');
  const sourceIds = compact(proposal.source_ids);
  if (requireSources && !sourceIds.length) throw new Error('Varje ägarpost som ska införas måste ha minst en strukturerad källa');
  if (requireSources && ownerSourceIds && !sourceIds.some(sourceId => ownerSourceIds.has(sourceId))) {
    throw new Error('Varje ägarpost som ska införas måste ha minst en källa som uttryckligen belägger ägande');
  }
  return true;
}

export function validateOwnerReviewDecision(decision, { requireReady = false, ownerSourceIds = null } = {}) {
  if (!decision?.decision_id || !decision.boat_id) throw new Error('Granskningsbeslutet saknar identitet');
  if (!['insert', 'replace'].includes(decision.mode || 'insert')) throw new Error('Granskningsbeslutet har ett okänt ändringsläge');
  if (!['draft', 'ready', 'needs_research'].includes(decision.status)) throw new Error('Granskningsbeslutet har en okänd status');
  if (!Array.isArray(decision.ownerships)) throw new Error('Granskningsbeslutet saknar ägarposter');
  if ((decision.mode || 'insert') === 'replace' && !Array.isArray(decision.expected_ownerships)) throw new Error('Rättningen saknar en före-bild av befintliga ägarposter');
  const ready = requireReady || decision.status === 'ready';
  if (ready && !decision.ownerships.length) throw new Error('Ett beslut som är klart för införande måste innehålla minst en ägarpost');
  decision.ownerships.forEach(proposal => validateOwnerProposal(proposal, { requireSources: ready, ownerSourceIds }));
  if (new Set(decision.ownerships.map(proposal => proposal.sequence)).size !== decision.ownerships.length) throw new Error('Två ägarposter har samma ordningsnummer');
  return true;
}

export function saveOwnerReviewDecision(document, decision) {
  validateOwnerReviewDecision(decision);
  const next = normalizeOwnerReviewDocument(document, document.pilot_id);
  next.decisions[decision.boat_id] = clone(decision);
  return next;
}

export function removeOwnerReviewDecision(document, boatId) {
  const next = normalizeOwnerReviewDocument(document, document.pilot_id);
  delete next.decisions[boatId];
  return next;
}

export function saveOwnerReviewBatch(document, {
  rows,
  party,
  start = null,
  end = null,
  note = '',
  sourceIdsByBoat = {},
  proposalIdsByBoat = {},
  batchId,
  updatedAt,
} = {}) {
  if (!Array.isArray(rows) || !rows.length || !party?.party_type || !party.party_id || !party.party_label || !batchId || !updatedAt) {
    throw new Error('Batchutkastet saknar båtar, ägarpart eller identitet');
  }
  let next = normalizeOwnerReviewDocument(document, document.pilot_id);
  for (const row of rows) {
    if (!row?.boat_id || typeof row.owner_text !== 'string') throw new Error('Batchutkastet innehåller en ofullständig båt');
    const existing = next.decisions[row.boat_id];
    if (existing?.ownerships?.length) throw new Error(`${row.boat_name || row.boat_id} har redan en ägarpost`);
    const proposal = {
      proposal_id: proposalIdsByBoat[row.boat_id],
      role: 'owner',
      party_type: party.party_type,
      party_id: party.party_id,
      party_label: party.party_label,
      start: clone(start),
      end: clone(end),
      sequence: 1,
      status: 'accepted',
      source_ids: compact(sourceIdsByBoat[row.boat_id]),
    };
    const decision = {
      decision_id: existing?.decision_id || `owner-review:${row.boat_id}`,
      boat_id: row.boat_id,
      batch_id: batchId,
      mode: 'insert',
      expected_ownerships: [],
      status: 'draft',
      source_owner_text: row.owner_text,
      note: note || existing?.note || '',
      ownerships: [proposal],
      updated_at: updatedAt,
    };
    next = saveOwnerReviewDecision(next, decision);
  }
  return next;
}

export function buildOwnerChangeQueue({ document, inventory, boats = [], ownershipRecords = [], sources = null, exportedAt = new Date().toISOString() } = {}) {
  const normalized = normalizeOwnerReviewDocument(document, document?.pilot_id);
  const boatById = new Map(boats.map(boat => [boat.id, boat]));
  const inventoryByBoat = new Map([...(inventory?.rows || []), ...(inventory?.structured_review_rows || [])].map(row => [row.boat_id, row]));
  const ownershipByBoat = new Map();
  for (const record of ownershipRecords) {
    if (!ownershipByBoat.has(record.boat_id)) ownershipByBoat.set(record.boat_id, []);
    const { id, ...value } = record;
    ownershipByBoat.get(record.boat_id).push({ entity_id: id, record: value });
  }
  const sourceById = Array.isArray(sources) ? new Map(sources.map(source => [source.id, source])) : null;
  const ownerSourceIds = sourceById ? new Set([...sourceById.values()].filter(sourceSupportsOwnership).map(source => source.id)) : null;
  const decisions = Object.values(normalized.decisions)
    .filter(decision => decision.status === 'ready')
    .sort((left, right) => left.boat_id.localeCompare(right.boat_id, 'sv'))
    .map(decision => {
      validateOwnerReviewDecision(decision, { requireReady: true, ownerSourceIds });
      const boat = boatById.get(decision.boat_id);
      const inventoryRow = inventoryByBoat.get(decision.boat_id);
      if (!boat || !inventoryRow) throw new Error(`Båten ${decision.boat_id} saknas i pilotens inventering`);
      const currentOwnerships = ownershipByBoat.get(decision.boat_id) || [];
      if (decision.mode === 'insert' && currentOwnerships.length) throw new Error(`${inventoryRow.boat_name} har redan strukturerat ägande och måste rättas i korrigeringsläge`);
      if (decision.mode === 'replace') {
        const expected = [...decision.expected_ownerships].sort((left, right) => left.entity_id.localeCompare(right.entity_id));
        const current = [...currentOwnerships].sort((left, right) => left.entity_id.localeCompare(right.entity_id));
        if (!expected.length || !same(expected, current)) throw new Error(`De strukturerade ägarposterna har ändrats för ${inventoryRow.boat_name}`);
      }
      if (decision.source_owner_text !== inventoryRow.owner_text) throw new Error(`Den äldre ägartexten har ändrats för ${inventoryRow.boat_name}`);
      return {
        decision_id: decision.decision_id,
        boat_id: decision.boat_id,
        boat_name: inventoryRow.boat_name,
        source_owner_text: decision.source_owner_text,
        mode: decision.mode,
        expected_ownerships: clone(decision.expected_ownerships),
        note: decision.note || null,
        ownerships: clone(decision.ownerships),
      };
    });
  const referencedSourceIds = compact(decisions.flatMap(decision => decision.ownerships.flatMap(proposal => proposal.source_ids)));
  const referencedSources = sourceById ? referencedSourceIds.map(sourceId => {
    const source = sourceById.get(sourceId);
    if (!source) throw new Error(`Källan saknas i granskningsunderlaget: ${sourceId}`);
    return clone(source);
  }) : [];
  return {
    change_queue_version: OWNER_CHANGE_QUEUE_VERSION,
    source_document_version: OWNER_REVIEW_DOCUMENT_VERSION,
    pilot_id: normalized.pilot_id,
    exported_at: exportedAt,
    sources: referencedSources,
    decisions,
  };
}

export function validateOwnerChangeQueue(queue) {
  if (queue?.change_queue_version !== OWNER_CHANGE_QUEUE_VERSION || !queue.pilot_id || !Array.isArray(queue.sources) || !Array.isArray(queue.decisions)) {
    throw new Error('Ändringskön har fel format');
  }
  const sources = new Map();
  for (const source of queue.sources) {
    if (!source?.id || !source.label || !source.kind || sources.has(source.id)) throw new Error('Ändringskön innehåller en ogiltig källa');
    sources.set(source.id, source);
  }
  const boatIds = new Set();
  for (const decision of queue.decisions) {
    if (!decision?.decision_id || !decision.boat_id || !['insert', 'replace'].includes(decision.mode) || !Array.isArray(decision.ownerships) || !decision.ownerships.length) throw new Error('Ändringskön innehåller ett ofullständigt beslut');
    if (decision.mode === 'replace' && (!Array.isArray(decision.expected_ownerships) || !decision.expected_ownerships.length)) throw new Error('En rättning saknar före-bild');
    if (boatIds.has(decision.boat_id)) throw new Error(`Ändringskön innehåller båten två gånger: ${decision.boat_id}`);
    boatIds.add(decision.boat_id);
    decision.ownerships.forEach(proposal => {
      validateOwnerProposal(proposal, { requireSources: true });
      for (const sourceId of proposal.source_ids) if (!sources.has(sourceId)) throw new Error(`Ändringskön saknar källposten ${sourceId}`);
    });
  }
  return true;
}
