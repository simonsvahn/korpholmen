import { deriveMembershipViewStatus, membershipPersonId } from '../../../packages/core/membership-model.js';

export const MATRIKEL_CANARY_QUERY_PARAMETER = 'matrikelmaster';

export const MATRIKEL_CANARY_URLS = Object.freeze({
  manifest: '/privat/matrikel-canary/manifest.json',
  master: '/privat/matrikel-canary/master.json',
  retiredReferences: '/privat/matrikel-canary/legacy/retired-reference-projections.json',
  personPointer: '/privat/person-master/active.json',
  personMaster: '/privat/person-master/master.json',
  lifeSyncReport: '/privat/matrikel-life-sync/report.json',
});

export const MATRIKEL_MEMBERSHIP_REVIEW_URL = '/api/matrikel-membership-decisions';

const TYPE_TO_COLLECTION = Object.freeze({
  membership: 'memberships',
  'matrikel-release': 'releases',
  'source-document': 'source_documents',
  'source-row': 'source_rows',
  'source-layout-row': 'source_layout_rows',
  'person-occurrence': 'person_occurrences',
  'boat-occurrence': 'boat_occurrences',
  'name-change-candidate': 'name_change_candidates',
  organization: 'organizations',
  role: 'roles',
  'role-term': 'role_terms',
  award: 'awards',
  'award-event': 'award_events',
});

const LEGACY_REQUIRED_COLLECTIONS = Object.freeze(['memberships', 'releases', 'source_documents', 'source_rows', 'source_layout_rows', 'person_occurrences', 'boat_occurrences', 'name_change_candidates']);
const CLEAN_REQUIRED_COLLECTIONS = Object.freeze(['memberships', 'releases', 'person_occurrences', 'boat_occurrences', 'organizations', 'roles', 'role_terms', 'awards', 'award_events']);

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

function scalarYear(value) {
  if (Number.isInteger(value) && value >= 1000 && value <= 2100) return value;
  const match = String(value ?? '').match(/(?:^|\D)(1\d{3}|20\d{2}|2100)(?:\D|$)/);
  return match ? Number(match[1]) : null;
}

function pointTimeYear(value) {
  if (!value || typeof value !== 'object') return null;
  if (Number.isInteger(value.start_min) && Number.isInteger(value.start_max)) return value.start_min === value.start_max ? scalarYear(value.start_min) : null;
  if (value.kind === 'point') return scalarYear(value.original_text);
  return null;
}

function pointTimeLabel(value) {
  const exact = pointTimeYear(value);
  if (exact) return String(exact);
  if (value?.kind === 'point' && Number.isInteger(value.start_min) && Number.isInteger(value.start_max) && value.start_min < value.start_max) {
    return `${value.start_min}–${value.start_max}`;
  }
  return null;
}

function sourceDeathYear(row) {
  for (const value of [row.death_year, row.death_year_raw, row.death_date, row.death_date_raw]) {
    const year = scalarYear(value);
    if (year) return year;
  }
  const match = String(row.raw_text || '').match(/(?:död|avliden|†)\s*(?:år\s*)?(1\d{3}|20\d{2}|2100)/i);
  return match ? Number(match[1]) : null;
}

export function matrikelPersonLifeYears(person = {}) {
  const birthYear = pointTimeYear(person.birth_time) || scalarYear(person.birth);
  const deathYear = pointTimeYear(person.death_time) || scalarYear(person.death);
  const birthLabel = pointTimeLabel(person.birth_time) || (birthYear ? String(birthYear) : null);
  const deathLabel = pointTimeLabel(person.death_time) || (deathYear ? String(deathYear) : null);
  return { birthYear, deathYear, birthLabel, deathLabel };
}

export function matrikelOccurrenceLifeData({ occurrence, person } = {}) {
  const row = occurrence && typeof occurrence === 'object' ? occurrence : {};
  const hasPerson = Boolean(person && typeof person === 'object');
  const master = matrikelPersonLifeYears(hasPerson ? person : {});
  const sourceBirthYear = scalarYear(row.birth_year) || scalarYear(row.birth_date) || scalarYear(row.birth_year_raw) || scalarYear(row.birth_date_raw);
  const sourceDeath = sourceDeathYear(row);
  const issues = [];
  for (const [field, sourceYear, masterYear] of [
    ['birth_year', sourceBirthYear, master.birthYear],
    ['death_year', sourceDeath, master.deathYear],
  ]) {
    if (!hasPerson || !sourceYear) continue;
    if (!masterYear) issues.push({ field, kind: 'missing_in_person_master', source_year: sourceYear, master_year: null });
    else if (masterYear !== sourceYear) issues.push({ field, kind: 'conflict', source_year: sourceYear, master_year: masterYear });
  }
  return {
    masterBirthYear: master.birthYear,
    masterDeathYear: master.deathYear,
    sourceBirthYear,
    sourceDeathYear: sourceDeath,
    displayBirthYear: master.birthLabel || sourceBirthYear,
    displayDeathYear: master.deathLabel || sourceDeath,
    issues,
  };
}

export function matrikelOccurrenceClubName({ occurrence, releaseYear, membershipClubName = '', referenceClubName = '' } = {}) {
  const row = occurrence && typeof occurrence === 'object' ? occurrence : {};
  const rawText = String(row.raw_text || '');
  const sourceClubName = String(row.club_name_raw || row.club_name_core_raw || '').trim();
  const masterClubName = String(membershipClubName || referenceClubName || '').trim();
  if (Number(releaseYear) >= 2020) {
    const rawLines = rawText.split(/\r?\n/);
    const extracted = [];
    for (let index = 0; index < rawLines.length; index += 1) {
      const match = /(?:^|\s)(Broder|Syster|S\.)(\s*)(.+)$/iu.exec(rawLines[index]);
      if (!match) continue;
      const clubNameColumn = match[3].split(/\s{2,}/u)[0];
      let candidate = `${match[1]}${match[1].toLocaleLowerCase('sv') === 's.' ? '' : ' '}${clubNameColumn}`.replace(/\s+/g, ' ').trim();
      const continuation = String(rawLines[index + 1] || '').trim();
      if (continuation && !/\d/u.test(continuation) && !/(?:Broder|Syster|S\.)/iu.test(continuation) && continuation.length <= 40) {
        candidate = candidate.endsWith('-') ? `${candidate}${continuation}` : `${candidate} ${continuation}`;
      }
      extracted.push(candidate);
    }
    const normalized = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('sv').replace(/[^a-z0-9]+/g, ' ').trim();
    const withoutTitle = value => normalized(value).replace(/^(?:broder|syster|s)\s+/, '');
    const masterNormalized = normalized(masterClubName);
    const masterCore = withoutTitle(masterClubName);
    const personFirst = normalized(row.person_name_raw).split(' ')[0] || '';
    const masterFirst = masterCore.split(' ')[0] || '';
    const editDistanceAtMost = (left, right, maximum) => {
      if (left === right) return true;
      if (Math.abs(left.length - right.length) > maximum) return false;
      const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
      for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
        const current = [leftIndex];
        for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
          current[rightIndex] = Math.min(
            current[rightIndex - 1] + 1,
            previous[rightIndex] + 1,
            previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
          );
        }
        previous.splice(0, previous.length, ...current);
      }
      return previous[right.length] <= maximum;
    };
    const sourceBacked = extracted.find(candidate => {
      const candidateCore = withoutTitle(candidate);
      const candidateFirst = candidateCore.split(' ')[0] || '';
      if (masterFirst.length >= 4) return candidateFirst.length >= 4 && editDistanceAtMost(candidateFirst, masterFirst, 2);
      return personFirst.length >= 4 && candidateFirst.length >= 4 && editDistanceAtMost(candidateFirst, personFirst, 1);
    });
    if (sourceBacked) return sourceBacked;
    const normalizedRawText = normalized(rawText);
    if (masterClubName && (normalizedRawText.includes(masterNormalized) || (masterCore.length >= 5 && normalizedRawText.includes(masterCore)))) return masterClubName;
    if (row.person_id) return '';
    return extracted[0] || sourceClubName;
  }
  if (masterClubName && rawText.includes(masterClubName)) return masterClubName;
  return sourceClubName;
}

export class MatrikelCanaryReadOnlyError extends Error {
  constructor(message = 'Matrikelkandidaten är skrivskyddad.') {
    super(message);
    this.name = 'MatrikelCanaryReadOnlyError';
    this.code = 'MATRIKEL_CANARY_READ_ONLY';
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} måste vara ett objekt.`);
  return value;
}

function requireRecords(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} måste vara en lista.`);
  const ids = new Set();
  for (const record of value) {
    requireObject(record, `${label}-post`);
    if (typeof record.id !== 'string' || !record.id) throw new TypeError(`${label} innehåller en post utan id.`);
    if (ids.has(record.id)) throw new TypeError(`${label} innehåller dubblerat id: ${record.id}.`);
    ids.add(record.id);
  }
  return value;
}

async function sha256Text(text, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle?.digest) throw new TypeError('Web Crypto med SHA-256 krävs för canarykontrollen.');
  const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function fetchText(fetchImpl, url) {
  const response = await fetchImpl(url, { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Kunde inte läsa ${url} (${response.status}).`);
  return response.text();
}

function validateMatrikelMaster(master) {
  requireObject(master, 'Matrikelmastern');
  if (master.schema_version !== 1 || master.architecture_generation !== 2 || master.app !== 'matrikel') throw new TypeError('Matrikelmastern har fel format.');
  if (!Number.isSafeInteger(master.master_revision) || master.master_revision < 2) throw new TypeError('Matrikelmastern saknar giltig revision.');
  requireObject(master.data, 'Matrikelmasterns data');
  const cleanWriterModel = Array.isArray(master.data.organizations) && !Object.hasOwn(master.data, 'source_rows');
  for (const collection of cleanWriterModel ? CLEAN_REQUIRED_COLLECTIONS : LEGACY_REQUIRED_COLLECTIONS) requireRecords(master.data[collection], `data.${collection}`);
  const activeReleases = master.data.releases.filter(row => !row.deleted_at && (cleanWriterModel || row.lifecycle_status === 'active'));
  if (activeReleases.length !== 16) throw new TypeError('Matrikelmastern ska ha 16 aktiva utgåvor.');
  const founder = activeReleases.find(row => row.is_reconstruction);
  if (!founder || founder.display_name !== 'Grundarmatrikel' || founder.year !== 1947) throw new TypeError('Grundarmatrikeln har fel namn eller år.');
  if (!activeReleases.filter(row => !row.is_reconstruction).every(row => row.display_name === `Medlemsmatrikel - ${row.year}`)) throw new TypeError('En aktiv medlemsmatrikel har fel visningsnamn.');
  const memberships = master.data.memberships.filter(row => !row.deleted_at);
  const cleanMembershipModel = memberships.some(row => row.membership_level);
  if (cleanMembershipModel) {
    if (!memberships.every(row => ['junior', 'senior'].includes(row.membership_level))) throw new TypeError('En medlemsrad saknar giltig medlemsnivå.');
    if (!memberships.every(row => row.person_ref?.master === 'people' && row.person_ref?.entity_type === 'person' && row.person_ref?.entity_id)) throw new TypeError('En medlemsrad saknar stabil personreferens.');
    if (memberships.some(row => 'status' in row || 'person_id' in row || 'membership_status_legacy' in row)) throw new TypeError('Den rena medlemsmodellen innehåller legacyfält.');
  } else if (memberships.some(row => row.status === 'expected')) {
    throw new TypeError('Förväntad medlem får inte finnas kvar som aktiv status.');
  }
  return master;
}

export const matrikelMembershipPersonId = membershipPersonId;
export const matrikelDerivedMembershipStatus = deriveMembershipViewStatus;

function validatePersonMaster(master) {
  requireObject(master, 'Personmastern');
  if (master.schema_version !== 1 || master.architecture_generation !== 2 || master.app !== 'people') throw new TypeError('Personmastern har fel format.');
  requireObject(master.data, 'Personmasterns data');
  requireRecords(master.data.people, 'data.people');
  return master;
}

function validateRetiredReferences(value) {
  requireObject(value, 'Referensprojektionen');
  requireRecords(value.person_refs, 'person_refs');
  requireRecords(value.boat_refs, 'boat_refs');
  requireRecords(value.club_history_roots, 'club_history_roots');
  return value;
}

function validateLifeSyncReport(value, { masterSha256, personMasterSha256 }) {
  requireObject(value, 'Livsårssynkrapporten');
  if (value.schema_version !== 1 || !['phase5e:matrikel-person-life-sync:v1', 'phase5f:matrikel-person-life-sync:v2', 'phase5g:matrikel-person-life-sync:v3', 'phase5h:matrikel-person-life-sync:v4', 'phase5i:matrikel-person-life-sync:v5', 'phase8b:matrikel-person-life-sync:v6'].includes(value.report_id)) throw new TypeError('Livsårssynkrapporten har fel format.');
  if (value.matrikel_candidate?.sha256 !== masterSha256 || value.person_master?.sha256 !== personMasterSha256) throw new TypeError('Livsårssynkrapporten avser andra masterversioner.');
  if (!Array.isArray(value.issues) || !Array.isArray(value.decisions)) throw new TypeError('Livsårssynkrapporten saknar ärenden eller beslut.');
  return value;
}

export function matrikelCanaryRequestState(url, { sourceTree } = {}) {
  const parsed = url instanceof URL ? url : new URL(String(url), 'http://localhost/');
  const value = parsed.searchParams.get(MATRIKEL_CANARY_QUERY_PARAMETER);
  const mode = value === 'canary' || value === 'review' || value === 'active' ? value : null;
  const requested = Boolean(mode);
  return {
    requested,
    enabled: requested && sourceTree === true,
    refused: requested && sourceTree !== true,
    mode,
    reviewEnabled: mode === 'review' && sourceTree === true,
  };
}

function validateMembershipReview(review, bundle) {
  requireObject(review, 'Medlemsgranskningen');
  if (review.schema_version !== 1 || review.base_master_sha256 !== bundle.masterSha256) throw new TypeError('Medlemsgranskningen avser fel Matrikelkandidat.');
  if (!Number.isSafeInteger(review.review_revision) || review.review_revision < 0) throw new TypeError('Medlemsgranskningen saknar giltig revision.');
  requireRecords(review.memberships, 'medlemsgranskning.memberships');
  requireObject(review.row_sha256_by_person, 'medlemsgranskning.row_sha256_by_person');
  if (!Array.isArray(review.decisions)) throw new TypeError('Medlemsgranskningens beslut måste vara en lista.');
  const candidateIds = new Set(bundle.master.data.memberships.filter(row => !row.deleted_at).map(row => row.id));
  if (review.memberships.length !== candidateIds.size || review.memberships.some(row => !candidateIds.has(row.id))) throw new TypeError('Medlemsgranskningen har en annan raduppsättning än kandidaten.');
  return review;
}

export async function loadMatrikelMembershipReview({
  fetchImpl = globalThis.fetch,
  url = MATRIKEL_MEMBERSHIP_REVIEW_URL,
  bundle,
} = {}) {
  if (!bundle) throw new TypeError('Matrikelpaketet krävs för medlemsgranskningen.');
  const text = await fetchText(fetchImpl, url);
  return validateMembershipReview(JSON.parse(text), bundle);
}

export async function loadMatrikelCanaryBundle({
  fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto,
  urls = MATRIKEL_CANARY_URLS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch krävs för att läsa Matrikelkandidaten.');
  const [manifestText, masterText, retiredText, personPointerText, personMasterText, lifeSyncText] = await Promise.all([
    fetchText(fetchImpl, urls.manifest),
    fetchText(fetchImpl, urls.master),
    fetchText(fetchImpl, urls.retiredReferences),
    fetchText(fetchImpl, urls.personPointer),
    fetchText(fetchImpl, urls.personMaster),
    fetchText(fetchImpl, urls.lifeSyncReport),
  ]);
  const manifest = requireObject(JSON.parse(manifestText), 'Canarymanifestet');
  const isLockedCandidate = manifest.active_pointer_must_remain_absent === true;
  const isLockedActiveMaster = manifest.active_pointer_must_remain_absent === false && manifest.mode === 'read_only' && manifest.status === 'active_private_read_master';
  if (manifest.writer_enabled !== false || (!isLockedCandidate && !isLockedActiveMaster)) throw new TypeError('Matrikelmanifestet saknar skrivskyddsspärr.');
  const masterHash = await sha256Text(masterText, cryptoImpl);
  if (masterHash !== manifest.master_sha256) throw new Error('Matrikelmasterns SHA-256 stämmer inte med manifestet.');
  const retiredHash = await sha256Text(retiredText, cryptoImpl);
  if (retiredHash !== manifest.retired_projections_sha256) throw new Error('Referensprojektionens SHA-256 stämmer inte med manifestet.');
  const personPointer = requireObject(JSON.parse(personPointerText), 'Personpekarens data');
  if (personPointer.mode !== 'read_only' || personPointer.writer_enabled !== false) throw new TypeError('Personmastern är inte aktiverad enbart för läsning.');
  const personMasterHash = await sha256Text(personMasterText, cryptoImpl);
  if (personMasterHash !== personPointer.master_sha256 || personMasterHash !== manifest.dependencies?.people?.master_sha256) throw new Error('Matrikelkandidaten och den aktiva personmastern har olika SHA-256.');
  const lifeSyncReport = validateLifeSyncReport(JSON.parse(lifeSyncText), { masterSha256: masterHash, personMasterSha256: personMasterHash });
  return {
    manifest,
    master: validateMatrikelMaster(JSON.parse(masterText)),
    retiredReferences: validateRetiredReferences(JSON.parse(retiredText)),
    personPointer,
    personMaster: validatePersonMaster(JSON.parse(personMasterText)),
    lifeSyncReport,
    masterSha256: masterHash,
    personMasterSha256: personMasterHash,
  };
}

function asEntity(type, record) {
  const { id, ...fields } = record;
  return { entity_type: type, entity_id: id, deleted: Boolean(record.deleted_at), fields: clone(fields) };
}

export class MatrikelCanaryRepository {
  constructor(bundle, { membershipReview = null } = {}) {
    this.bundle = bundle;
    this.revision = bundle.master.master_revision;
    this.membershipReview = null;
    const peopleById = new Map(bundle.personMaster.data.people.filter(row => !row.deleted_at).map(row => [row.id, row]));
    const memberships = bundle.master.data.memberships.filter(row => !row.deleted_at);
    const derivedStatuses = memberships.map(row => matrikelDerivedMembershipStatus(row, peopleById.get(matrikelMembershipPersonId(row)) || {}));
    this.canaryInfo = {
      masterRevision: bundle.master.master_revision,
      membershipModel: memberships.every(row => row.membership_level) ? 'clean_v2' : 'legacy_v1',
      memberships: memberships.length,
      activeMemberships: derivedStatuses.filter(status => status === 'active').length,
      passiveMemberships: derivedStatuses.filter(status => status === 'passive').length,
      previousMemberships: derivedStatuses.filter(status => status === 'previous').length,
      unclearMemberships: derivedStatuses.filter(status => status === 'unclear').length,
      activeReleases: bundle.master.data.releases.filter(row => !row.deleted_at && (!Object.hasOwn(bundle.master.data, 'source_rows') || row.lifecycle_status === 'active')).length,
      personOccurrences: bundle.master.data.person_occurrences.filter(row => !row.deleted_at).length,
    };
    if (membershipReview) this.applyMembershipReview(membershipReview);
  }

  records(type) {
    const collection = TYPE_TO_COLLECTION[type];
    if (type === 'membership' && this.membershipReview) return this.membershipReview.memberships;
    if (collection) return this.bundle.master.data[collection] || [];
    if (type === 'person-ref') return this.bundle.retiredReferences.person_refs;
    if (type === 'boat-ref') return this.bundle.retiredReferences.boat_refs;
    if (type === 'club-history-root') return this.bundle.retiredReferences.club_history_roots;
    return [];
  }

  listEntities(type, { includeDeleted = false } = {}) {
    return this.records(type).filter(record => includeDeleted || !record.deleted_at).map(record => asEntity(type, record));
  }

  getEntity(type, id, { includeDeleted = false } = {}) {
    const record = this.records(type).find(candidate => candidate.id === id);
    if (!record || (!includeDeleted && record.deleted_at)) return null;
    return asEntity(type, record);
  }

  applyMembershipReview(review) {
    this.membershipReview = clone(validateMembershipReview(review, this.bundle));
    this.revision = `${this.bundle.master.master_revision}:membership-review:${review.review_revision}`;
    return this;
  }

  membershipReviewInfo(personId) {
    if (!this.membershipReview) return null;
    return {
      baseMasterSha256: this.membershipReview.base_master_sha256,
      rowSha256: this.membershipReview.row_sha256_by_person[personId] || null,
      reviewRevision: this.membershipReview.review_revision,
      latestDecisionId: this.membershipReview.latest_decision_by_person?.[personId] || null,
    };
  }

  setFields() { throw new MatrikelCanaryReadOnlyError(); }
  setField() { throw new MatrikelCanaryReadOnlyError(); }
  deleteEntity() { throw new MatrikelCanaryReadOnlyError(); }
  restoreEntity() { throw new MatrikelCanaryReadOnlyError(); }
  applyRemoteOps() { throw new MatrikelCanaryReadOnlyError(); }
}

export class MatrikelPersonReadOnlyMaster {
  constructor(bundle) {
    this.bundle = bundle;
    this.initialized = true;
    this.revision = bundle.personMaster.master_revision;
  }

  listEntities(type, { includeDeleted = false } = {}) {
    if (type !== 'person') return [];
    return this.bundle.personMaster.data.people.filter(record => includeDeleted || !record.deleted_at).map(record => asEntity('person', record));
  }

  getEntity(type, id, { includeDeleted = false } = {}) {
    if (type !== 'person') return null;
    const record = this.bundle.personMaster.data.people.find(candidate => candidate.id === id);
    if (!record || (!includeDeleted && record.deleted_at)) return null;
    return asEntity('person', record);
  }
}

export function createMatrikelCanaryRepository(bundle, options) {
  return new MatrikelCanaryRepository(bundle, options);
}

export function createMatrikelPersonReadOnlyMaster(bundle) {
  return new MatrikelPersonReadOnlyMaster(bundle);
}
