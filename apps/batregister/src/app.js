import {
  DropboxTransport,
  IndexedDBStore,
  Repository,
  SyncEngine,
  beginDropboxOAuth,
  completeDropboxOAuth,
  createRevisionCache,
  createBatch,
  debounce,
  exchangeDropboxRefreshToken,
  isOfflineError,
  openSlaktlandskapDB,
  registerKorpholmenServiceWorker,
  resolveDeviceId,
  validateOperation,
} from '../../../packages/core/data-layer.js';
import { GenerationCutoverGuard } from '../../../packages/core/generation-cutover.js';
import { ReadOnlyMaster } from '../../../packages/core/read-only-master.js';
import { HttpReadTransport } from '../../../packages/core/sync/http-read-transport.js';
import {
  FAMILY_UNIT_TYPE,
  KIN_GROUP_TYPE,
  KIN_GROUP_KINDS,
  buildFamilyContext,
  displayReference,
  familyBrowseHierarchy,
  searchFamilyTargets,
  searchableFamilyTargets,
  targetMemberDetails,
  targetTypeLabel,
} from '../../../packages/core/family-context.js?v=2026-08-05-paket-3';
import {
  boatMatchesConnection,
  connectionTargetForValue,
  connectionTargetValue,
  personScopeTargets,
  searchPeopleForConnection,
} from './connection-filter.js?v=2026-08-05-paket-3';
import {
  prepareImageForStorage,
  uploadBlobWithRetry,
  uploadPendingImageBlobs,
} from './image-pipeline.js';
import {
  boatDisplayHeading,
  boatDisplayName,
  boatQualityFlags,
  conflictingSpecFields,
  currentPilotRecords,
  effectiveSpecValues,
  formatObservationDate,
  formatOwnershipPeriod,
  ownerPartyParts,
  ownerPartyText,
  pilotContainsBoat,
  pilotDisplayLabel,
  resolvePilotRecord,
  sourceIdsForRecords,
  specRows,
  visibleOwnershipRecords,
} from './boat-master-view.js?v=2026-08-06-registerspec-4';
import {
  filterOwnerReviewRows,
  ownerReviewClassLabel,
} from './owner-review.js?v=2026-08-06-owner-review-3';
import {
  OWNER_REVIEW_STATUSES,
  OWNER_ROLES,
  buildOwnerChangeQueue,
  emptyOwnerReviewDocument,
  normalizeOwnerReviewDocument,
  removeOwnerReviewDecision,
  saveOwnerReviewBatch,
  saveOwnerReviewDecision,
  sourceSupportsOwnership,
  validateOwnerReviewDecision,
} from './owner-review-decisions.js?v=2026-08-06-owner-review-4';
import {
  mergedSourceRecords,
  normalizeSourceViewManifest,
  sourceIdsForBoatInManifest,
  sourceViewEntry,
} from './source-review.js?v=2026-08-06-source-review-1';
import {
  buildSpecChangeQueue,
  emptySpecReviewDocument,
  normalizeSpecReviewDocument,
  removeSpecReviewDecision,
  saveSpecReviewDecision,
} from './spec-review-decisions.js?v=2026-08-06-spec-review-3';
import { createBatregisterActiveRuntime } from './batregister-runtime.js?v=2026-08-15-batregister-v2-1';
import { createBatregisterV2Controller } from './batregister-v2-ui.js?v=2026-08-15-batregister-v2-1';
import { createBatregisterWriter } from './batregister-writer.js?v=2026-08-15-batregister-v2-1';
import {
  DROPBOX_CLIENT_ID,
  DROPBOX_SCOPES,
  LOCAL_BOOTSTRAP_URL,
  LOCAL_IMAGE_BASE_URL,
  LOCAL_IMAGE_MANIFEST_URL,
  LOCAL_MATRIKEL_CONTEXT_URL,
} from './config.js?v=2026-08-06-batmaster-pilot-14';

const $ = selector => document.querySelector(selector);
const content = $('#content');
const drawer = $('#boat-drawer');
const drawerContent = $('#drawer-content');
const backdrop = $('#backdrop');
const statusNode = $('#sync-status');
const undoNode = $('#undo-status');
const connectButton = $('#connect-dropbox');
const bootstrapButton = $('#bootstrap-local');
const connectionFilter = $('#connection-filter');
const connectionFilterSearch = $('#connection-filter-search');
const connectionFilterClear = $('#connection-filter-clear');
const connectionFilterResults = $('#connection-filter-results');
const connectionFilterBrowse = $('#connection-filter-browse');
const connectionFilterSummary = $('#connection-filter-summary');
const filterPanel = $('#filter-panel');
const viewPanel = $('#view-panel');
const panelBackdrop = $('#panel-backdrop');
const sourceViewer = $('#source-viewer');
const sourceViewerBody = $('#source-viewer-body');
const ownerBatchDialog = $('#owner-batch-dialog');
const isSourceTree = location.pathname.includes('/apps/batregister/');
const pageUrl = new URL(location.href);
const requestedPersonId = pageUrl.searchParams.get('person') || '';
const requestedBoatId = pageUrl.searchParams.get('boat') || '';
const requestedPilotId = pageUrl.searchParams.get('pilot') || '';
const localPilotPreview = isSourceTree && Boolean(requestedPilotId);
const TOKEN_META = 'dropbox:refresh-token';
const BOOTSTRAP_META = 'bootstrap:batregister-2026-08-01';
const IMAGE_BOOTSTRAP_META = 'bootstrap:batregister-images-2026-08-01';
const OWNER_REVIEW_META_PREFIX = 'owner-review-decisions:';
const SPEC_REVIEW_META_PREFIX = 'spec-review-decisions:';
const imageUrls = new Map();
const imageLoads = new Map();

let store;
let repository;
let matrikelMaster;
let accessToken = null;
let accessTokenExpiresAt = 0;
let syncPromise = null;
let selectedBoatId = null;
let drawerEditMode = false;
let matrikelPeople = [];
let matrikelRelations = [];
let matrikelFamilyUnits = [];
let matrikelKinGroups = [];
let connectionSearchActiveIndex = -1;
let connectionPanelMode = 'browse';
let matrikelContextRevision = 0;
let ownerReviewInventory = null;
let ownerReviewOpen = false;
let ownerReviewSearch = '';
let ownerReviewClassification = '';
let ownerReviewStatus = 'active';
let ownerReviewDocument = null;
let ownerReviewDecisionMode = false;
let ownerReviewDraft = null;
let ownerReviewComposerTargets = [];
let localSourceManifest = null;
let sourceManifestRevision = 0;
let ownerReviewBatchMode = false;
let specReviewDocument = null;
let batregisterV2Mode = false;
let batregisterV2Runtime = null;
let batregisterV2Writer = null;
let batregisterV2Controller = null;
let generationOneGuard = null;
const ownerReviewBatchSelection = new Set();
const viewCache = createRevisionCache(() => `${repository?.revision || 0}:${matrikelContextRevision}:${sourceManifestRevision}`);

const ui = {
  search: '',
  type: '',
  connection: requestedPersonId ? `person:${requestedPersonId}` : '',
  nameStatus: '',
  imageStatus: '',
  qualityFilters: new Set(),
  pilot: requestedPilotId,
  grouping: 'none',
  layout: 'grid',
};

const QUALITY_FILTERS = Object.freeze([
  { id: 'horsepower', label: 'Hästkrafter' },
  { id: 'engine-brand', label: 'Motormärke' },
  { id: 'dimensions', label: 'Mått' },
  { id: 'structured-owner', label: 'Strukturerad ägaruppgift' },
  { id: 'ownership-change', label: 'Ägarbyte' },
  { id: 'history', label: 'Historik' },
  { id: 'multiple-images', label: 'Flera bilder' },
  { id: 'multiple-sources', label: 'Flera källor' },
  { id: 'conflict', label: 'Motstridiga fakta' },
  { id: 'open-review', label: 'Öppen källutredning' },
  { id: 'unstructured-owner', label: 'Ägare ej strukturerad' },
  { id: 'legacy-only', label: 'Enbart äldre grunddata' },
]);
const qualityFilterLabel = id => QUALITY_FILTERS.find(filter => filter.id === id)?.label || id;
const escapeHtml = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const unique = values => [...new Set(values.filter(Boolean))];
const normalize = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();
const slug = value => normalize(value).replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || 'bat';

async function mapConcurrent(values, limit, mapper) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      await mapper(values[index], index);
    }
  }));
}

function setStatus(text, tone = '') {
  statusNode.textContent = text;
  statusNode.className = tone ? `status-${tone}` : '';
}

function setUndoStatus(text, tone = '') {
  undoNode.hidden = !text;
  undoNode.textContent = text;
  undoNode.className = tone ? `status-${tone}` : '';
}

function offerUndo(message, restoreEntries, restoredMessage) {
  const actionId = crypto.randomUUID();
  setUndoStatus(message, 'warning');
  undoNode.dataset.undoAction = actionId;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'undo-action';
  button.textContent = 'Ångra';
  button.addEventListener('click', async () => {
    if (undoNode.dataset.undoAction !== actionId) return;
    delete undoNode.dataset.undoAction;
    button.disabled = true;
    setUndoStatus('Återställer…', 'warning');
    try {
      await repository.restoreEntities(restoreEntries);
      render();
      try { await syncNow(); } catch (_) { /* Lokalt återställd; synken försöker igen senare. */ }
      setUndoStatus(restoredMessage, 'ok');
    } catch (error) {
      setUndoStatus(`Kunde inte återställa · ${error.message}`, 'error');
    }
  }, { once: true });
  undoNode.append(' · ', button);
  window.setTimeout(() => {
    if (undoNode.dataset.undoAction === actionId) {
      delete undoNode.dataset.undoAction;
      setUndoStatus(`${message} · återställningshistoriken är bevarad`, 'ok');
    }
  }, 15_000);
}

const deviceId = () => resolveDeviceId({ store, key: 'korpholmen:batregister-device-id', prefix: 'bat-web-' });

function generationOneTransport(token) {
  const markerTransport = new DropboxTransport({ accessToken: token, id: 'dropbox-batregister-cutover-read', opsRoot: '/batregister/ops', readOnly: true });
  generationOneGuard = new GenerationCutoverGuard({ app: 'batregister', transport: markerTransport, store });
  return new DropboxTransport({
    accessToken: token,
    id: 'dropbox-batregister',
    opsRoot: '/batregister/ops',
    writeGuard: context => generationOneGuard.assertGeneration1Writable(context),
  });
}

async function assertGenerationOneWritable() {
  if (batregisterV2Mode) return true;
  if (generationOneGuard) return generationOneGuard.assertGeneration1Writable({ source: 'batregister-v1-editor' });
  const cachedOnly = { getJson: async () => { const error = new Error('saknas'); error.status = 409; error.code = 'path/not_found'; throw error; } };
  const guard = new GenerationCutoverGuard({ app: 'batregister', transport: cachedOnly, store });
  return guard.assertGeneration1Writable({ source: 'batregister-v1-editor' });
}

function redirectUri() {
  return new URL(isSourceTree ? '../../' : '../', location.href).href;
}

async function registerServiceWorker() {
  try {
    return await registerKorpholmenServiceWorker({ sourceTree: isSourceTree });
  } catch (error) {
    console.warn('Appskalet kunde inte uppdateras', error);
    return null;
  }
}
function boatRecords() { return viewCache('boats', () => repository.listEntities('boat').map(entity => ({ id: entity.entity_id, ...entity.fields })).sort((a,b)=>boatDisplayName(a).localeCompare(boatDisplayName(b),'sv'))); }
function masterRecords(type) { return viewCache(type, () => repository.listEntities(type).map(entity => ({ id: entity.entity_id, ...entity.fields.record }))); }
function masterRecordsForBoat(type, boatId) { return masterRecords(type).filter(record => record.boat_id === boatId); }
function persistedSourceRecords() { return repository.listEntities('boat-source').map(entity => ({ id: entity.entity_id, ...entity.fields.record })); }
function sourceRecords() { return viewCache('boat-sources', () => mergedSourceRecords(persistedSourceRecords(), localSourceManifest)); }
function pilotRecords() { return masterRecords('boat-pilot-manifest'); }
function pilotForValue(value) { return resolvePilotRecord(pilotRecords(), value); }
function updatePilotUrl(value) { const url=new URL(location.href);if(value)url.searchParams.set('pilot',value);else url.searchParams.delete('pilot');history.replaceState(null,'',url) }
function linkRecords() { return viewCache('boat-person-links', () => repository.listEntities('boat-person-link').map(entity => ({ id: entity.entity_id, ...entity.fields }))); }
function linksForBoat(id) { return linkRecords().filter(link => link.boat_id === id); }
function personForId(id) { return matrikelPeople.find(person => person.id === id) || null; }
function personNameForLink(link) { return personForId(link.person_id)?.display_name || link.person_display_name || link.person_id; }
function familyRecords() { return viewCache('families', () => repository.listEntities('family').map(entity => ({ id: entity.entity_id, ...entity.fields })).sort((a,b)=>String(a.name).localeCompare(String(b.name),'sv'))); }
function familyLinkRecords() { return viewCache('boat-family-links', () => repository.listEntities('boat-family-link').map(entity => ({ id: entity.entity_id, ...entity.fields }))); }
function familyLinksForBoat(id) { return familyLinkRecords().filter(link => link.boat_id === id); }
function groupLinkRecords() { return viewCache('boat-group-links', () => repository.listEntities('boat-group-link').map(entity => ({ id: entity.entity_id, ...entity.fields }))); }
function groupLinksForBoat(id) { return groupLinkRecords().filter(link => link.boat_id === id); }
function matrikelFamilyContext() { return viewCache('matrikel-family-context', () => buildFamilyContext({ people: matrikelPeople, relations: matrikelRelations, familyUnits: matrikelFamilyUnits, kinGroups: matrikelKinGroups })); }

function closeConnectionSearch() {
  connectionFilterResults.hidden = true;
  connectionFilterSearch.setAttribute('aria-expanded', 'false');
  connectionFilterBrowse.setAttribute('aria-expanded', 'false');
  connectionFilterSearch.removeAttribute('aria-activedescendant');
  connectionSearchActiveIndex = -1;
}

function countBoatsForConnection(value) {
  return boatRecords().filter(boat => boatMatchesConnectionTarget(boat, value)).length;
}

function connectionResultButton({ value, label, eyebrow, meta, index, personId = '' }) {
  const data = personId
    ? `data-connection-person="${escapeHtml(personId)}"`
    : `data-connection-value="${escapeHtml(value)}" data-connection-label="${escapeHtml(label)}"`;
  return `<button class="family-result-option connection-result-option" type="button" id="connection-result-${index}" role="option" ${data} aria-selected="${index === connectionSearchActiveIndex}"><span>${escapeHtml(eyebrow)}</span><b>${escapeHtml(label)}</b>${meta ? `<small>${escapeHtml(meta)}</small>` : ''}</button>`;
}

function renderConnectionSearchResults() {
  connectionPanelMode = 'search';
  const context = matrikelFamilyContext();
  const people = searchPeopleForConnection(matrikelPeople, connectionFilterSearch.value, { limit: 6 });
  const targets = searchFamilyTargets(context, connectionFilterSearch.value, { limit: 14 });
  const families = targets.filter(target => target.type === FAMILY_UNIT_TYPE).slice(0, 6);
  const kinGroups = targets.filter(target => target.type === KIN_GROUP_TYPE).slice(0, 6);
  const total = people.length + families.length + kinGroups.length;
  connectionSearchActiveIndex = total ? Math.min(Math.max(connectionSearchActiveIndex, 0), total - 1) : -1;
  let index = 0;
  const peopleHtml = people.map(person => connectionResultButton({
    value: `person:${person.id}`,
    label: person.display_name,
    eyebrow: 'Person',
    meta: `${countBoatsForConnection(`person:${person.id}`)} båtar · välj sedan nivå`,
    index: index++,
    personId: person.id,
  })).join('');
  const familiesHtml = families.map(target => connectionResultButton({
    value: connectionTargetValue(target),
    label: target.label,
    eyebrow: 'Nära familj',
    meta: `${targetMemberDetails(target, context).length} personer · ${countBoatsForConnection(connectionTargetValue(target))} båtar`,
    index: index++,
  })).join('');
  const kinGroupsHtml = kinGroups.map(target => connectionResultButton({
    value: connectionTargetValue(target),
    label: target.label,
    eyebrow: KIN_GROUP_KINDS[target.kind] || 'Släkt',
    meta: `${targetMemberDetails(target, context).length} personer · ${countBoatsForConnection(connectionTargetValue(target))} båtar`,
    index: index++,
  })).join('');
  const section = (title, body) => body ? `<section class="connection-result-group"><h3>${title}</h3>${body}</section>` : '';
  connectionFilterResults.setAttribute('role', 'listbox');
  connectionFilterResults.setAttribute('aria-label', 'Sökresultat för personer, familjer och släkter');
  connectionFilterResults.innerHTML = total
    ? `${section('Personer', peopleHtml)}${section('Familjer', familiesHtml)}${section('Släkter', kinGroupsHtml)}`
    : '<p>Ingen person, familj eller släkt matchar sökningen.</p>';
  connectionFilterResults.hidden = false;
  connectionFilterSearch.setAttribute('aria-expanded', 'true');
  connectionFilterBrowse.setAttribute('aria-expanded', 'false');
  if (connectionSearchActiveIndex >= 0) connectionFilterSearch.setAttribute('aria-activedescendant', `connection-result-${connectionSearchActiveIndex}`);
  else connectionFilterSearch.removeAttribute('aria-activedescendant');
}

function renderPersonScopeResults(personId) {
  connectionPanelMode = 'scope';
  connectionSearchActiveIndex = -1;
  connectionFilterSearch.removeAttribute('aria-activedescendant');
  const context = matrikelFamilyContext();
  const person = context.peopleById.get(personId);
  const scopes = personScopeTargets(personId, context);
  connectionFilterResults.removeAttribute('role');
  connectionFilterResults.setAttribute('aria-label', `Välj omfattning för ${person?.display_name || 'personen'}`);
  connectionFilterResults.innerHTML = person
    ? `<section class="connection-scope-panel"><header><button type="button" data-connection-back aria-label="Tillbaka till sökresultaten">←</button><div><span>Välj omfattning</span><b>${escapeHtml(person.display_name)}</b></div><button type="button" data-connection-close aria-label="Stäng">×</button></header><p>Vill du se personens egna båtar eller båtar som hör till en av personens familje- och släktgemenskaper?</p>${scopes.map(target => {
      const value = connectionTargetValue(target);
      const isPerson = target.type === 'person';
      const eyebrow = isPerson ? 'Bara personen' : target.type === FAMILY_UNIT_TYPE ? 'Nära familj' : KIN_GROUP_KINDS[target.kind] || 'Släkt';
      const memberCount = isPerson ? '' : `${targetMemberDetails(target, context).length} personer · `;
      return `<button class="connection-scope-option" type="button" data-connection-value="${escapeHtml(value)}" data-connection-label="${escapeHtml(target.label)}"><span>${escapeHtml(eyebrow)}</span><b>${escapeHtml(target.label)}</b><small>${escapeHtml(memberCount)}${countBoatsForConnection(value)} båtar</small></button>`;
    }).join('')}</section>`
    : '<p>Personen finns inte längre i Matrikeln. Synka Dropbox och försök igen.</p>';
  connectionFilterResults.hidden = false;
  connectionFilterSearch.setAttribute('aria-expanded', 'true');
  connectionFilterBrowse.setAttribute('aria-expanded', 'false');
}

function familyTreeTargetButton(target, actionLabel, className = 'family-tree-select') {
  const value = connectionTargetValue(target);
  return `<button class="${className}" type="button" data-connection-value="${escapeHtml(value)}" data-connection-label="${escapeHtml(displayReference(target))}" ${ui.connection === value ? 'aria-current="true"' : ''}><span>${escapeHtml(actionLabel)}</span><b>${escapeHtml(displayReference(target))}</b></button>`;
}

function familyTreeBranch(group, hierarchy, context, trail = new Set()) {
  if (trail.has(group.id)) return '';
  const nextTrail = new Set(trail).add(group.id);
  const children = hierarchy.childGroupsByParentId.get(group.id) || [];
  const families = context.familyUnits.filter(family => (family.kin_group_ids || []).includes(group.id));
  const descendants = [
    familyTreeTargetButton({ ...group, type: KIN_GROUP_TYPE }, 'Hela gruppen'),
    ...families.map(family => familyTreeTargetButton({ ...family, type: FAMILY_UNIT_TYPE }, 'Nära familj', 'family-tree-family')),
    ...children.map(child => familyTreeBranch(child, hierarchy, context, nextTrail)),
  ].join('');
  const count = families.length + children.length;
  return `<details class="family-tree-node"><summary><span>${escapeHtml(group.reference_code || 'SLÄKT')}</span><b>${escapeHtml(group.name || 'Namnlös släkt')}</b>${count ? `<small>${count} undergrupp${count === 1 ? '' : 'er'}</small>` : ''}</summary><div class="family-tree-children">${descendants}</div></details>`;
}

function renderConnectionBrowseResults() {
  connectionPanelMode = 'browse';
  connectionSearchActiveIndex = -1;
  connectionFilterSearch.removeAttribute('aria-activedescendant');
  const context = matrikelFamilyContext();
  const hierarchy = familyBrowseHierarchy(context);
  const counts = `${context.kinGroups.length} släkter · ${context.familyUnits.length} familjer`;
  const roots = hierarchy.roots.map(group => familyTreeBranch(group, hierarchy, context)).join('');
  const unlinkedFamilies = context.familyUnits.filter(family => !(family.kin_group_ids || []).length);
  const unlinked = unlinkedFamilies.length
    ? `<details class="family-tree-node"><summary><span>FAMILJ</span><b>Familjer utan överordnad släkt</b><small>${unlinkedFamilies.length}</small></summary><div class="family-tree-children">${unlinkedFamilies.map(family => familyTreeTargetButton({ ...family, type: FAMILY_UNIT_TYPE }, 'Nära familj', 'family-tree-family')).join('')}</div></details>`
    : '';
  connectionFilterResults.removeAttribute('role');
  connectionFilterResults.setAttribute('aria-label', 'Hierarkisk lista över familjer och släkter');
  connectionFilterResults.innerHTML = context.kinGroups.length || context.familyUnits.length
    ? `<section class="family-tree-panel"><header><div><b>Alla familjer och släkter</b><span>${escapeHtml(counts)}</span></div><button type="button" data-connection-close aria-label="Stäng familjelistan">×</button></header><p class="family-tree-help">Öppna en släkt för att se dess grenar och familjer. En familj som hör till två släkter visas under båda.</p>${roots}${unlinked}</section>`
    : '<p>Ingen familjedata har laddats ännu. Synka Dropbox och öppna sedan listan igen.</p>';
  connectionFilterResults.hidden = false;
  connectionFilterSearch.setAttribute('aria-expanded', 'false');
  connectionFilterBrowse.setAttribute('aria-expanded', 'true');
}

function selectConnectionFilter(value, label) {
  ui.connection = value;
  connectionFilter.value = value;
  connectionFilterSearch.value = label;
  connectionFilterClear.hidden = !value;
  closeConnectionSearch();
  render();
}

function relationLinkChoices(context = matrikelFamilyContext()) {
  return [
    ...matrikelPeople.map(person => ({ value: `person:${person.id}`, label: `Person · ${person.display_name}${person.club_name ? ` · ${person.club_name}` : ''}` })),
    ...searchableFamilyTargets(context).map(target => ({ value: connectionTargetValue(target), label: `${targetTypeLabel(target.type)} · ${target.label}` })),
  ].sort((a, b) => a.label.localeCompare(b.label, 'sv'));
}
function familyMembers(family) {
  const ids = new Set(family.explicit_person_ids || []);
  for (const person of matrikelPeople) if ((family.match_family_labels || []).includes(person.family)) ids.add(person.id);
  return [...ids].map(id => matrikelPeople.find(person => person.id === id)).filter(Boolean).sort((a,b)=>a.display_name.localeCompare(b.display_name,'sv'));
}
function linkedFamilyNames(boatId) { return familyLinksForBoat(boatId).map(link => link.family_name).filter(Boolean); }
function canonicalGroupTarget(link, context = matrikelFamilyContext()) {
  return (link.target_type === FAMILY_UNIT_TYPE ? context.familyUnitById : context.kinGroupById).get(link.target_id) || null;
}
function groupLinkLabel(link, context = matrikelFamilyContext()) {
  const target = canonicalGroupTarget(link, context);
  return target ? displayReference(target) : [link.target_code, link.target_name || link.target_id].filter(Boolean).join(' · ');
}
function linkedGroupNames(boatId) { const context = matrikelFamilyContext(); return groupLinksForBoat(boatId).map(link => groupLinkLabel(link, context)).filter(Boolean); }
function linkedNames(boatId) {
  return [...linksForBoat(boatId).map(personNameForLink), ...linkedFamilyNames(boatId), ...linkedGroupNames(boatId), ...masterRecordsForBoat('boat-ownership-observation', boatId).map(owner => owner.party_label)].filter(Boolean);
}

function ownershipConnectionRecords(boatId) {
  const personLinks = [];
  const groupLinks = [];
  for (const owner of masterRecordsForBoat('boat-ownership-observation', boatId)) {
    if (owner.party_type === 'person' && owner.party_id) personLinks.push({ person_id:owner.party_id });
    if (owner.party_type === 'person-set') {
      for (const personId of owner.party_ids || []) personLinks.push({ person_id:personId });
    }
    if ([FAMILY_UNIT_TYPE, KIN_GROUP_TYPE].includes(owner.party_type) && owner.party_id) {
      groupLinks.push({ target_type:owner.party_type, target_id:owner.party_id });
    }
  }
  return { personLinks, groupLinks };
}

function boatMatchesConnectionTarget(boat, value = ui.connection) {
  if (!value) return true;
  if (value.startsWith('legacy:')) return [boat.slakt, ...linkedFamilyNames(boat.id)].includes(value.slice('legacy:'.length));
  const ownership = ownershipConnectionRecords(boat.id);
  return boatMatchesConnection({
    boat,
    value,
    context: matrikelFamilyContext(),
    personLinks: [...linksForBoat(boat.id), ...ownership.personLinks],
    groupLinks: [...groupLinksForBoat(boat.id), ...ownership.groupLinks],
    legacyFamilyLabels: [boat.slakt, ...linkedFamilyNames(boat.id)],
  });
}

function qualityFlagsForBoat(boat) {
  return viewCache(`quality:${boat.id}`, () => boatQualityFlags({
    boat,
    nameObservations: masterRecordsForBoat('boat-name-observation', boat.id),
    ownershipObservations: masterRecordsForBoat('boat-ownership-observation', boat.id),
    specObservations: masterRecordsForBoat('boat-spec-observation', boat.id),
    eventObservations: masterRecordsForBoat('boat-event-observation', boat.id),
    reviewItems: masterRecordsForBoat('boat-review-item', boat.id),
  }));
}

function filteredBoats() {
  const query = normalize(ui.search);
  const pilot = pilotForValue(ui.pilot);
  return boatRecords().filter(boat => {
    if (ui.pilot && (!pilot || !pilotContainsBoat(pilot, boat.id))) return false;
    if (ui.type && boat.typ !== ui.type) return false;
    if (!boatMatchesConnectionTarget(boat)) return false;
    if (ui.nameStatus && boat.namnstatus !== ui.nameStatus) return false;
    if (ui.imageStatus === 'with' && !(boat.images || []).length) return false;
    if (ui.imageStatus === 'without' && (boat.images || []).length) return false;
    const qualityFlags = qualityFlagsForBoat(boat);
    if ([...ui.qualityFilters].some(filter => !qualityFlags.has(filter))) return false;
    if (query && !normalize([boatDisplayName(boat), boat.visningsurskiljning, boat.dopnamn, boat.modell, boat.agare, boat.motor, boat.slakt, boat.island_connection, ...linkedNames(boat.id), ...(boat.kallor_text || [])].join(' ')).includes(query)) return false;
    return true;
  });
}

function era(boat) {
  const year = Number(boat.ar || boat.dopar);
  if (!year) return 'År okänt';
  return `${Math.floor(year / 10) * 10}-talet`;
}

function groupBoats(boats) {
  const pilot = pilotForValue(ui.pilot);
  const key = ui.grouping === 'family' ? boat => [...linkedGroupNames(boat.id), ...linkedFamilyNames(boat.id)].join(' / ') || boat.slakt || 'Övriga och okända'
    : ui.grouping === 'type' ? boat => boat.typ || 'Typ okänd'
      : ui.grouping === 'era' ? era : () => pilot ? String(pilot.scope || 'Urval').split(':')[0].trim() : 'Alla båtar';
  const groups = new Map();
  for (const boat of boats) { const label = key(boat); if (!groups.has(label)) groups.set(label, []); groups.get(label).push(boat); }
  return [...groups.entries()].sort(([a],[b])=>a.localeCompare(b,'sv'));
}

function imageRef(boat, role = 'thumb') {
  const image = boat.images?.[0];
  if (!image) return null;
  return image[role] || image.full || image.thumb || null;
}

const imageKindLabel = kind => ({
  'register-image': 'Registerbild',
  'document-image': 'Dokumentbild',
  'model-illustration': 'Modellbild',
  'documentary-illustration': 'Illustration',
  'route-diagram': 'Karta',
  'historical-document-photo': 'Historisk bild',
  'historical-photo': 'Historisk bild',
}[kind] || '');

function imageElement(boat, image, role, className, index = 0) {
  const ref = image?.[role] || image?.full || image?.thumb;
  if (!ref) return '';
  const local = isSourceTree && ref.filename ? `${LOCAL_IMAGE_BASE_URL}${encodeURIComponent(ref.filename)}` : '';
  const cached = imageUrls.get(ref.dropbox_path);
  const source = local || cached || '';
  const label = imageKindLabel(image.kind);
  const visibleName = boat.display_name || boatDisplayName(boat);
  return `<figure class="boat-media ${escapeHtml(image.kind || 'boat-photo')}">
    <img class="${className}" alt="${escapeHtml(`${visibleName}${index ? `, bild ${index + 1}` : ''}`)}" ${source ? `src="${escapeHtml(source)}"` : ''} data-image-path="${escapeHtml(ref.dropbox_path || '')}" style="${image.focus ? `object-position:${escapeHtml(image.focus)}` : ''}">
    ${label ? `<figcaption>${escapeHtml(label)}${image.caption ? ` · ${escapeHtml(image.caption)}` : ''}</figcaption>` : ''}
  </figure>`;
}

function imageMarkup(boat) {
  const image = boat.images?.[0];
  if (!image) return '<div class="image-placeholder">Bild saknas</div>';
  return imageElement(boat, image, 'thumb', 'boat-image');
}

function drawerGalleryMarkup(boat) {
  const images = boat.images || [];
  if (!images.length) return '';
  return `<section class="drawer-gallery" aria-label="Bilder">
    ${images.map((image, index) => imageElement(boat, image, 'full', index ? 'drawer-gallery-image' : 'drawer-image', index)).join('')}
  </section>`;
}

function card(boat) {
  const ownerContext = matrikelFamilyContext();
  const owners = visibleOwnershipRecords(masterRecordsForBoat('boat-ownership-observation', boat.id))
    .sort((left, right) => Number(left.start?.year || 0) - Number(right.start?.year || 0));
  const ownerLabel = unique(owners.map(owner => ownerPartyText(owner, ownerContext)).filter(Boolean)).join(' → ');
  return `<button class="boat-card" type="button" data-boat-id="${escapeHtml(boat.id)}">
    ${imageMarkup(boat)}
    <span class="boat-copy"><h3>${escapeHtml(boatDisplayName(boat))}</h3>
      ${boat.visningsurskiljning ? `<p class="boat-disambiguator">${escapeHtml(boat.visningsurskiljning)}</p>` : ''}
      ${[boat.modell, boat.ar].filter(Boolean).length ? `<p>${escapeHtml([boat.modell, boat.ar].filter(Boolean).join(' · '))}</p>` : ''}
      ${ownerLabel ? `<p>${escapeHtml(ownerLabel)}</p>` : ''}
      <span class="chips">${boat.typ && boat.typ !== '—' ? `<span class="chip">${escapeHtml(boat.typ)}</span>` : ''}${boat.namnstatus === 'dopnamn' ? '<span class="chip warn">Endast dopnamn</span>' : ''}${boat.namnstatus === 'saknas' ? '<span class="chip warn">Namn okänt</span>' : ''}</span>
    </span></button>`;
}

async function cachedBlob(path, transport = null) {
  if (!path) return null;
  if (imageLoads.has(path)) return imageLoads.get(path);
  const promise = (async () => {
    let blob = await store.getBlob(path);
    if (!blob && transport) {
      blob = await transport.getBlob(path);
      await store.putBlob(path, blob);
    }
    return blob;
  })().finally(() => imageLoads.delete(path));
  imageLoads.set(path, promise);
  return promise;
}

async function localImageBlob(path) {
  if (!isSourceTree || !path?.startsWith('/batregister/bilder/')) return null;
  try {
    const response = await fetch(path, { cache: 'no-store' });
    return response.ok ? await response.blob() : null;
  } catch {
    return null;
  }
}

function objectUrl(path, blob) {
  let url = imageUrls.get(path);
  if (!url && blob) {
    url = URL.createObjectURL(blob);
    imageUrls.set(path, url);
  }
  return url || '';
}

async function hydrateImages(scope = document) {
  const transport = accessToken && navigator.onLine !== false
    ? new DropboxTransport({ accessToken, id: 'dropbox-batregister-images', opsRoot: '/batregister/ops' })
    : null;
  const loadRemote = async node => {
    const path = node.dataset.imagePath;
    try {
      let blob = await cachedBlob(path);
      if (!blob) {
        blob = await localImageBlob(path);
        if (blob) await store.putBlob(path, blob);
      }
      if (!blob && transport) blob = await cachedBlob(path, transport);
      if (blob && node.isConnected) node.src = objectUrl(path, blob);
    } catch (error) {
      if (!isOfflineError(error)) node.alt = `Bild kunde inte hämtas: ${error.message}`;
    }
  };
  const allNodes = [...scope.querySelectorAll('img[data-image-path]')].filter(node => node.dataset.imagePath);
  for (const node of allNodes) {
    if (node.src && !node.dataset.remoteFallbackInstalled) {
      node.dataset.remoteFallbackInstalled = 'true';
      node.addEventListener('error', () => {
        node.removeAttribute('src');
        loadRemote(node);
      }, { once: true });
    }
  }
  await mapConcurrent(allNodes.filter(node => !node.src), 6, loadRemote);
}

function allImagePaths() {
  return unique(boatRecords().flatMap(boat => (boat.images || []).flatMap(image => [image.thumb?.dropbox_path, image.full?.dropbox_path])));
}

async function cacheAllBoatImages(transport) {
  const paths = allImagePaths();
  let downloaded = 0;
  const failures = [];
  await mapConcurrent(paths, 4, async path => {
    try {
      if (await store.getBlob(path)) return;
      await cachedBlob(path, transport);
      downloaded += 1;
      if (downloaded === 1 || downloaded % 10 === 0) setStatus(`Säkrar bilder för offline-läge · ${downloaded}/${paths.length}`);
    } catch (error) {
      failures.push({ path, error, message: error?.message || String(error) });
    }
  });
  return { total: paths.length, downloaded, failures };
}

function closeOptionsPanels() {
  for (const panel of [filterPanel, viewPanel]) panel.hidden = true;
  panelBackdrop.hidden = true;
  document.body.classList.remove('panel-open');
  $('#filter-panel-toggle').setAttribute('aria-expanded', 'false');
  $('#view-panel-toggle').setAttribute('aria-expanded', 'false');
}

function openOptionsPanel(panel) {
  const opening = panel.hidden;
  closeOptionsPanels();
  if (!opening) return;
  panel.hidden = false;
  panelBackdrop.hidden = false;
  document.body.classList.add('panel-open');
  const toggle = panel === filterPanel ? $('#filter-panel-toggle') : $('#view-panel-toggle');
  toggle.setAttribute('aria-expanded', 'true');
  panel.querySelector('button')?.focus();
}

function connectionFilterLabel(target) {
  if (!target) return 'Anknytning';
  if (target.type === 'person') return `Person · ${target.label}`;
  if (target.type === FAMILY_UNIT_TYPE) return `Nära familj · ${target.label}`;
  return `${KIN_GROUP_KINDS[target.kind] || 'Släkt'} · ${target.label}`;
}

function renderActiveFilters(selectedConnection) {
  const chips = [];
  const pilot = pilotForValue(ui.pilot);
  if (ui.search) chips.push(['search', `Båtsökning · ${ui.search}`]);
  if (pilot) chips.push(['pilot', `Urval · ${pilotDisplayLabel(pilot)}`]);
  if (ui.connection) chips.push(['connection', connectionFilterLabel(selectedConnection)]);
  if (ui.type) chips.push(['type', `Båttyp · ${ui.type}`]);
  if (ui.imageStatus) chips.push(['image', ui.imageStatus === 'with' ? 'Med bild' : 'Utan bild']);
  if (ui.nameStatus) chips.push(['name', ui.nameStatus === 'namn' ? 'Känt namn' : ui.nameStatus === 'saknas' ? 'Namn okänt' : 'Endast dopnamn']);
  for (const filter of ui.qualityFilters) chips.push([`quality:${filter}`, qualityFilterLabel(filter)]);
  $('#active-filters').innerHTML = chips.map(([key, label]) => `<button class="active-filter-chip" type="button" data-clear-filter="${key}">${escapeHtml(label)}</button>`).join('')
    + (chips.length > 1 ? '<button class="clear-filter-chip" type="button" data-clear-filter="all">Rensa alla</button>' : '');
  $('#clear-all-filters').disabled = !chips.length;
}

function ownerReviewCandidateMarkup(row) {
  const people = (row.person_links || []).map(link => {
    const label = escapeHtml(link.stored_name || link.person_id);
    return link.person_id
      ? `<a href="../personer-familjer/?person=${encodeURIComponent(link.person_id)}">${label}</a>`
      : `<span>${label}</span>`;
  });
  const families = (row.family_links || []).map(link => `<span>${escapeHtml(link.legacy_family_name || link.legacy_family_id)}</span>`);
  const candidates = [...people, ...families];
  return candidates.length ? candidates.join('') : '<em>Ingen strukturerad kandidat ännu</em>';
}

function ownerReviewRows() {
  if (!ownerReviewInventory?.rows) return [];
  const boatIds = new Set(boatRecords().map(boat => boat.id));
  const structured = new Set(masterRecords('boat-ownership-observation').map(record => record.boat_id));
  return [...ownerReviewInventory.rows, ...(ownerReviewInventory.structured_review_rows || [])].filter(row => boatIds.has(row.boat_id)).map(row => {
    const decision = ownerReviewDocument?.decisions?.[row.boat_id] || null;
    const correction = row.review_kind === 'correction';
    return { ...row, decision, review_status: correction ? decision?.status || 'unreviewed' : structured.has(row.boat_id) ? 'applied' : decision?.status || 'unreviewed' };
  });
}

const activeOwnerReviewRows = rows => rows.filter(row => row.review_status !== 'applied');
const ownerReviewBatchEligible = row => row.review_kind !== 'correction' && row.review_status !== 'applied' && !(row.decision?.ownerships || []).length;

function reviewStatusLabel(status) {
  return OWNER_REVIEW_STATUSES[status] || status;
}

function reviewDecisionPartyMarkup(decision) {
  if (!decision?.ownerships?.length) return '';
  return decision.ownerships.map(owner => `<span>${escapeHtml(ownerPartyText(owner, matrikelFamilyContext()))}</span>`).join('');
}

function reviewStatusCounts(rows) {
  return Object.fromEntries(Object.keys(OWNER_REVIEW_STATUSES).map(status => [status, rows.filter(row => row.review_status === status).length]));
}

function ownerReviewStatusScope(rows) {
  if (ownerReviewStatus === 'active') return activeOwnerReviewRows(rows);
  return rows.filter(row => row.review_status === ownerReviewStatus);
}

function renderOwnerReview() {
  const toggle = $('#owner-review-toggle');
  const view = $('#owner-review-view');
  const available = localPilotPreview && Boolean(ownerReviewInventory && ownerReviewDocument);
  toggle.hidden = !available;
  if (!available) {
    view.hidden = true;
    content.hidden = false;
    document.body.classList.remove('owner-review-open');
    return;
  }

  const allRows = ownerReviewRows();
  const active = activeOwnerReviewRows(allRows);
  const statusCounts = reviewStatusCounts(allRows);
  const readyCount = statusCounts.ready || 0;
  toggle.setAttribute('aria-expanded', String(ownerReviewOpen));
  $('#owner-review-badge').textContent = active.length;
  view.hidden = !ownerReviewOpen;
  content.hidden = ownerReviewOpen;
  document.body.classList.toggle('owner-review-open', ownerReviewOpen);
  if (!ownerReviewOpen) return;

  const statusSelect = $('#owner-review-status');
  statusSelect.innerHTML = `<option value="active">Aktiva (${active.length})</option>${Object.entries(OWNER_REVIEW_STATUSES).map(([status, label]) => `<option value="${status}">${escapeHtml(label)} (${statusCounts[status] || 0})</option>`).join('')}`;
  statusSelect.value = ownerReviewStatus;
  const statusScope = ownerReviewStatusScope(allRows);
  const classCounts = new Map();
  for (const row of statusScope) classCounts.set(row.classification, (classCounts.get(row.classification) || 0) + 1);
  const classifications = [...classCounts.keys()].sort((left, right) => ownerReviewClassLabel(left).localeCompare(ownerReviewClassLabel(right), 'sv'));
  const classSelect = $('#owner-review-class');
  classSelect.innerHTML = `<option value="">Alla typer (${statusScope.length})</option>${classifications.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(ownerReviewClassLabel(value))} (${classCounts.get(value)})</option>`).join('')}`;
  if (ownerReviewClassification && !classCounts.has(ownerReviewClassification)) ownerReviewClassification = '';
  classSelect.value = ownerReviewClassification;

  const rows = filterOwnerReviewRows(statusScope, { search: ownerReviewSearch, classification: ownerReviewClassification });
  const eligibleIds = new Set(allRows.filter(ownerReviewBatchEligible).map(row => row.boat_id));
  for (const boatId of ownerReviewBatchSelection) if (!eligibleIds.has(boatId)) ownerReviewBatchSelection.delete(boatId);
  $('#owner-review-batch-toggle').textContent = ownerReviewBatchMode ? 'Avsluta batchläge' : 'Batchläge';
  $('#owner-review-batch-toggle').setAttribute('aria-pressed', String(ownerReviewBatchMode));
  $('#owner-review-batch-actions').hidden = !ownerReviewBatchMode;
  $('#owner-review-batch-count').textContent = `${ownerReviewBatchSelection.size} valda`;
  $('#owner-review-batch-open').disabled = !ownerReviewBatchSelection.size;
  const correctionCount = allRows.filter(row => row.review_kind === 'correction' && row.review_status !== 'ready').length;
  $('#owner-review-summary').textContent = `${active.length} öppna ägargranskningar · ${correctionCount} gäller befintlig struktur · ${readyCount} klara för införande.`;
  $('#owner-review-count').textContent = `${rows.length} visas`;
  $('#owner-review-export-ready').disabled = !readyCount;
  $('#owner-review-export-ready').textContent = `Hämta ändringskö${readyCount ? ` (${readyCount})` : ''}`;
  $('#owner-review-list').innerHTML = rows.map(row => `<article class="owner-review-card${ownerReviewBatchMode ? ' batch-enabled' : ''}">
    <header><div>${ownerReviewBatchMode ? `<label class="batch-card-check"><input type="checkbox" data-owner-review-select="${escapeHtml(row.boat_id)}" ${ownerReviewBatchSelection.has(row.boat_id) ? 'checked' : ''} ${ownerReviewBatchEligible(row) ? '' : 'disabled'}><span>${ownerReviewBatchEligible(row) ? 'Välj' : 'Har beslut'}</span></label>` : ''}<span>${escapeHtml(ownerReviewClassLabel(row.classification))}</span><h3>${escapeHtml(row.boat_name)}</h3><small class="review-status status-${escapeHtml(row.review_status)}">${escapeHtml(reviewStatusLabel(row.review_status))}</small></div>${row.observation_year ? `<time>${escapeHtml(row.observation_year)}</time>` : ''}</header>
    <div class="owner-review-facts"><section><span>${row.review_kind === 'correction' ? 'Nuvarande ägarstruktur' : 'Äldre ägaruppgift'}</span><p>${escapeHtml(row.owner_text)}</p>${row.review_reason ? `<small>${escapeHtml(row.review_reason)}</small>` : ''}</section><section><span>${row.decision?.ownerships?.length ? 'Ägarföljd efter beslut' : 'Föreslagna kopplingar'}</span><div class="owner-review-candidates">${row.decision?.ownerships?.length ? reviewDecisionPartyMarkup(row.decision) : ownerReviewCandidateMarkup(row)}</div></section></div>
    ${(row.source_labels || []).length ? `<details><summary>Källor</summary><p>${escapeHtml(row.source_labels.join(' · '))}</p></details>` : ''}
    <button type="button" data-owner-review-boat="${escapeHtml(row.boat_id)}" data-owner-review-mode="${row.review_status === 'applied' ? 'read' : 'decision'}">${row.review_status === 'applied' ? 'Öppna båt' : row.decision ? 'Granska beslut' : row.review_kind === 'correction' ? 'Rätta ägarstruktur' : 'Skapa beslut'}</button>
  </article>`).join('') || '<p class="no-results">Inga ägaruppgifter matchar sökningen.</p>';
}

function setOwnerReviewOpen(open) {
  ownerReviewOpen = Boolean(open);
  if (ownerReviewOpen) {
    closeOptionsPanels();
    closeDrawer();
  }
  renderOwnerReview();
  if (ownerReviewOpen) $('#owner-review-search').focus();
}

function render() {
  if (batregisterV2Mode) return batregisterV2Controller?.render();
  const all = boatRecords();
  const allPilots = pilotRecords();
  const pilots = currentPilotRecords(allPilots);
  const selectedPilot = pilotForValue(ui.pilot);
  if(ui.pilot&&selectedPilot&&ui.pilot!==(selectedPilot.pilot_id||selectedPilot.id)){ui.pilot=selectedPilot.pilot_id||selectedPilot.id;updatePilotUrl(ui.pilot)}
  if (ui.pilot && allPilots.length && !selectedPilot) { ui.pilot = ''; updatePilotUrl(''); }
  const pilotSection = $('#pilot-filter-section');
  pilotSection.hidden = !pilots.length;
  $('#pilot-options').innerHTML = `<button type="button" data-pilot-filter="" aria-pressed="${!ui.pilot}">Alla båtar <small>${all.length}</small></button>${pilots.map(pilot => `<button type="button" data-pilot-filter="${escapeHtml(pilot.pilot_id || pilot.id)}" aria-pressed="${ui.pilot === (pilot.pilot_id || pilot.id)}">${escapeHtml(pilotDisplayLabel(pilot))}</button>`).join('')}`;
  const typeCounts = new Map();
  for (const boat of all) if (boat.typ) typeCounts.set(boat.typ, (typeCounts.get(boat.typ) || 0) + 1);
  const types = [...typeCounts.keys()].sort((a, b) => a.localeCompare(b, 'sv'));
  $('#type-options').innerHTML = `<button type="button" data-type-filter="" aria-pressed="${!ui.type}">Alla <small>${all.length}</small></button>${types.map(type => `<button type="button" data-type-filter="${escapeHtml(type)}" aria-pressed="${ui.type === type}">${escapeHtml(type)} <small>${typeCounts.get(type)}</small></button>`).join('')}`;
  const qualitySection = $('#quality-filter-section');
  qualitySection.hidden = !localPilotPreview && !selectedPilot;
  const qualityScope = selectedPilot ? all.filter(boat => pilotContainsBoat(selectedPilot, boat.id)) : all;
  const qualityCounts = new Map(QUALITY_FILTERS.map(filter => [filter.id, qualityScope.filter(boat => qualityFlagsForBoat(boat).has(filter.id)).length]));
  $('#quality-options').innerHTML = QUALITY_FILTERS.map(filter => `<button type="button" data-quality-filter="${escapeHtml(filter.id)}" aria-pressed="${ui.qualityFilters.has(filter.id)}">${escapeHtml(filter.label)} <small>${qualityCounts.get(filter.id)}</small></button>`).join('');
  const context = matrikelFamilyContext();
  connectionFilterSummary.textContent = context.kinGroups.length || context.familyUnits.length || matrikelPeople.length
    ? `${matrikelPeople.length} personer · ${context.familyUnits.length} familjer · ${context.kinGroups.length} släkter`
    : 'Ingen familjedata laddad';
  let selectedConnection = connectionTargetForValue(ui.connection, context);
  const hasMatrikelContext = Boolean(matrikelPeople.length || context.familyUnits.length || context.kinGroups.length);
  if (ui.connection && hasMatrikelContext && !selectedConnection) {
    ui.connection = '';
    selectedConnection = null;
  }
  connectionFilter.value = ui.connection;
  connectionFilterClear.hidden = !ui.connection;
  if (document.activeElement !== connectionFilterSearch || connectionFilterResults.hidden) {
    connectionFilterSearch.value = selectedConnection?.label || (ui.connection ? 'Vald person laddas …' : '');
  }
  if (!connectionFilterResults.hidden) {
    if (connectionPanelMode === 'browse') renderConnectionBrowseResults();
    else if (connectionPanelMode === 'search') renderConnectionSearchResults();
  }
  for (const button of document.querySelectorAll('[data-image-status]')) button.setAttribute('aria-pressed', String(button.dataset.imageStatus === ui.imageStatus));
  for (const button of document.querySelectorAll('[data-name-status]')) button.setAttribute('aria-pressed', String(button.dataset.nameStatus === ui.nameStatus));
  for (const button of document.querySelectorAll('[data-quality-filter]')) button.setAttribute('aria-pressed', String(ui.qualityFilters.has(button.dataset.qualityFilter)));
  for (const button of document.querySelectorAll('[data-pilot-filter]')) button.setAttribute('aria-pressed', String(button.dataset.pilotFilter === ui.pilot));
  for (const button of document.querySelectorAll('[data-grouping]')) button.setAttribute('aria-pressed', String(button.dataset.grouping === ui.grouping));
  for (const button of document.querySelectorAll('[data-layout]')) button.setAttribute('aria-pressed', String(button.dataset.layout === ui.layout));
  const hiddenFilterCount = [ui.pilot, ui.connection, ui.type, ui.imageStatus, ui.nameStatus].filter(Boolean).length + ui.qualityFilters.size;
  const filterBadge = $('#filter-badge');
  filterBadge.hidden = !hiddenFilterCount;
  filterBadge.textContent = hiddenFilterCount || '';
  renderActiveFilters(selectedConnection);
  renderOwnerReview();
  const shown = filteredBoats();
  $('#filter-count').textContent = `${shown.length} av ${all.length} båtar`;
  if (!all.length) {
    content.innerHTML = `<section class="empty"><h2>Ingen privat båtdata på den här enheten ännu</h2><p>Anslut Dropbox för att hämta mastern. Den lokala arbetskopian kan aktivera den låsta startkopian.</p></section>`;
    return;
  }
  content.innerHTML = groupBoats(shown).map(([label, boats])=>`<section class="group ${ui.grouping === 'none' ? 'ungrouped' : ''}"><h2>${escapeHtml(label)} <small>(${boats.length})</small></h2><div class="boat-grid ${ui.layout === 'list' ? 'list-layout' : ''}">${boats.map(card).join('')}</div></section>`).join('') || '<p class="no-results">Inga båtar matchar filtren.</p>';
  hydrateImages(content);
  if (selectedBoatId) renderDrawer(selectedBoatId);
}

const textField = (label, field, value, className='') => `<label class="${className}">${label}<input data-boat-field="${field}" value="${escapeHtml(value ?? '')}"></label>`;
const numberField = (label, field, value, step='1') => `<label>${label}<input type="number" step="${step}" data-boat-field="${field}" value="${value ?? ''}"></label>`;

const SOURCE_KIND_LABELS = Object.freeze({
  'boat-register-sheet': 'Båtregister',
  'boat-image': 'Bild',
  'book-transcription': 'Bok',
  'contemporary-letter': 'Samtida skrivelse',
  'linked-master': 'Annat register',
  'membership-application': 'Medlemsansökan',
  memoir: 'Berättelse',
  oral: 'Muntlig uppgift',
  protocol: 'Protokoll',
  'protocol-working-note': 'Arbetsanteckning',
  'race-result': 'Tävlingsresultat',
  'register-leaf': 'Registerblad',
  'registration-application': 'Registreringsansökan',
  'direct-entry': 'Inlagt i appen',
});

function ownerPartyHref(part) {
  if (part.type === 'person' && part.id) return `../personer-familjer/?person=${encodeURIComponent(part.id)}`;
  if ([FAMILY_UNIT_TYPE, KIN_GROUP_TYPE].includes(part.type) && part.id) return `../personer-familjer/?group=${encodeURIComponent(part.id)}`;
  return '';
}

function ownerPartyMarkup(owner) {
  const parts = ownerPartyParts(owner, matrikelFamilyContext());
  const labels = parts.map(part => {
    const label = escapeHtml(part.label || 'Ägare saknas');
    const href = ownerPartyHref(part);
    return href ? `<a href="${href}">${label}</a>` : `<strong>${label}</strong>`;
  });
  if (labels.length < 2) return labels[0] || '<strong>Ägare saknas</strong>';
  if (labels.length === 2) return `${labels[0]} och ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')} och ${labels.at(-1)}`;
}

function renderSourceEvidence(sources, reviews) {
  if (!sources.length && !reviews.length) return '';
  return `<details class="source-evidence"><summary>Källor</summary><div>
    ${sources.map(source => {
      const meta = [SOURCE_KIND_LABELS[source.kind] || source.kind, source.source_date].filter(Boolean).join(' · ');
      const path = source.relative_path || source.master_path || [source.speaker, source.recorded_at].filter(Boolean).join(' · ');
      return `<article><div><b>${escapeHtml(source.label)}</b>${meta ? `<span>${escapeHtml(meta)}</span>` : ''}${path ? `<small>${escapeHtml(path)}</small>` : ''}${source.statement ? `<blockquote>${escapeHtml(source.statement)}</blockquote>` : ''}</div>${sourceHasView(source.id) ? `<button type="button" data-view-source="${escapeHtml(source.id)}">Visa källa</button>` : ''}</article>`;
    }).join('')}
    ${reviews.length ? `<section class="source-research"><h4>Källutredning</h4>${reviews.map(review => `<article><b>${escapeHtml(review.question)}</b>${review.known ? `<p>${escapeHtml(review.known)}</p>` : ''}</article>`).join('')}</section>` : ''}
  </div></details>`;
}

const SOURCE_ARTIFACT_ORDER = Object.freeze({ original: 0, 'läsbild': 1, avskrift: 2, bilaga: 3 });

function sourceArtifactUrl(artifact) {
  return `./privat/piloter/${encodeURIComponent(requestedPilotId)}/${artifact.web_path}`;
}

function sortedSourceArtifacts(entry) {
  return [...(entry?.artifacts || [])].sort((left, right) => (SOURCE_ARTIFACT_ORDER[left.role] ?? 9) - (SOURCE_ARTIFACT_ORDER[right.role] ?? 9)
    || left.label.localeCompare(right.label, 'sv'));
}

async function renderSourceArtifact(sourceId, index = 0) {
  const entry = sourceViewEntry(localSourceManifest, sourceId);
  const source = sourceRecords().find(item => item.id === sourceId);
  const artifacts = sortedSourceArtifacts(entry);
  const artifact = artifacts[index] || null;
  $('#source-viewer-artifacts').innerHTML = artifacts.map((item, artifactIndex) => `<button type="button" data-source-artifact-index="${artifactIndex}" aria-pressed="${artifactIndex === index}">${escapeHtml(item.label)}</button>`).join('');
  $('#source-viewer-path').textContent = source?.relative_path || source?.master_path || '';
  sourceViewerBody.innerHTML = '<p class="source-loading">Laddar källan…</p>';
  if (!artifact) {
    sourceViewerBody.innerHTML = source?.statement ? `<blockquote>${escapeHtml(source.statement)}</blockquote>` : '<p>Den här källposten har ingen lokal visningsfil.</p>';
    return;
  }
  const url = sourceArtifactUrl(artifact);
  if (artifact.mime_type.startsWith('image/')) {
    sourceViewerBody.innerHTML = `<img src="${escapeHtml(url)}" alt="${escapeHtml(`${source?.label || 'Källa'} · ${artifact.label}`)}">`;
  } else if (artifact.mime_type === 'application/pdf') {
    sourceViewerBody.innerHTML = `<iframe src="${escapeHtml(url)}" title="${escapeHtml(source?.label || 'Källa')}"></iframe>`;
  } else if (artifact.mime_type.startsWith('text/')) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Källtexten kunde inte läsas (${response.status})`);
    const pre = document.createElement('pre');
    pre.textContent = await response.text();
    sourceViewerBody.replaceChildren(pre);
  } else {
    sourceViewerBody.innerHTML = `<p>Filen kan öppnas separat.</p><a class="source-open-file" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Öppna filen</a>`;
  }
  const openLink = $('#source-viewer-open');
  openLink.href = url;
  openLink.hidden = false;
}

async function openSourceViewer(sourceId) {
  const source = sourceRecords().find(item => item.id === sourceId);
  if (!source) return setStatus('Källposten kunde inte hittas', 'warning');
  const meta = [SOURCE_KIND_LABELS[source.kind] || source.kind, source.source_date].filter(Boolean).join(' · ');
  sourceViewer.dataset.sourceId = sourceId;
  $('#source-viewer-title').textContent = source.label;
  $('#source-viewer-meta').textContent = meta;
  $('#source-viewer-open').hidden = true;
  sourceViewer.showModal();
  try { await renderSourceArtifact(sourceId, 0); }
  catch (error) { sourceViewerBody.innerHTML = `<p>Källan kunde inte visas: ${escapeHtml(error.message)}</p>`; }
}

function closeSourceViewer() {
  if (sourceViewer.open) sourceViewer.close();
  sourceViewerBody.innerHTML = '';
}

function closeOwnerBatchDialog() {
  if (ownerBatchDialog.open) ownerBatchDialog.close();
  $('#owner-batch-list').innerHTML = '';
}

function selectedOwnerBatchRows() {
  const selected = ownerReviewBatchSelection;
  return ownerReviewRows().filter(row => selected.has(row.boat_id) && ownerReviewBatchEligible(row));
}

function ownerBatchSourceSelect(row) {
  const sources = sourceOptionsForBoat(row.boat_id);
  if (!sources.length) return '<span class="owner-batch-no-source">Ingen ägarkälla kopplad</span>';
  const selected = sources.length === 1 ? sources[0].id : '';
  return `<div class="owner-batch-source"><select data-owner-batch-source="${escapeHtml(row.boat_id)}" aria-label="Källa för ${escapeHtml(row.boat_name)}"><option value="">${sources.length > 1 ? 'Välj källa senare' : 'Ingen källa'}</option>${sources.map(source => `<option value="${escapeHtml(source.id)}" ${source.id === selected ? 'selected' : ''}>${escapeHtml(source.label)}</option>`).join('')}</select><button type="button" data-view-source="${escapeHtml(selected)}" ${selected ? '' : 'hidden'}>Visa källa</button></div>`;
}

function openOwnerBatchDialog() {
  const rows = selectedOwnerBatchRows();
  if (!rows.length) return setStatus('Välj minst en båt för batchen', 'warning');
  const choices = ownerPartyChoices();
  $('#owner-batch-party-options').innerHTML = choices.map(choice => `<option value="${escapeHtml(choice.label)}"></option>`).join('');
  $('#owner-batch-party-search').value = '';
  $('#owner-batch-start-year').value = '';
  $('#owner-batch-end-year').value = '';
  $('#owner-batch-start-precision').value = 'observed';
  $('#owner-batch-note').value = '';
  $('#owner-batch-boats-title').textContent = `${rows.length} valda båtar`;
  $('#owner-batch-list').innerHTML = rows.map(row => `<article data-owner-batch-boat="${escapeHtml(row.boat_id)}"><div><b>${escapeHtml(row.boat_name)}</b><small>${escapeHtml(row.owner_text)}</small></div>${ownerBatchSourceSelect(row)}</article>`).join('');
  ownerBatchDialog.showModal();
  $('#owner-batch-party-search').focus();
}

async function saveOwnerBatch() {
  try {
    const input = $('#owner-batch-party-search');
    const choice = ownerPartyChoices().find(item => item.label === input.value);
    if (!choice) throw new Error('Välj personen, familjen eller släkten ur söklistan');
    const rows = selectedOwnerBatchRows();
    if (!rows.length) throw new Error('Inga valda båtar kan läggas i batchen');
    const startYear = yearValue($('#owner-batch-start-year'));
    const endYear = yearValue($('#owner-batch-end-year'));
    if (startYear && endYear && endYear < startYear) throw new Error('Slutåret kan inte ligga före startåret');
    const note = $('#owner-batch-note').value.trim();
    const batchId = `owner-batch:${crypto.randomUUID()}`;
    const sourceIdsByBoat = Object.fromEntries(rows.map(row => {
      const sourceId = ownerBatchDialog.querySelector(`[data-owner-batch-source="${CSS.escape(row.boat_id)}"]`)?.value || '';
      return [row.boat_id, sourceId ? [sourceId] : []];
    }));
    const proposalIdsByBoat = Object.fromEntries(rows.map(row => [row.boat_id, `owner-proposal:${row.boat_id}:${crypto.randomUUID().slice(0, 8)}`]));
    const document = saveOwnerReviewBatch(ownerReviewDocument, {
      rows,
      party: choice,
      start: startYear ? { year: startYear, precision: $('#owner-batch-start-precision').value } : null,
      end: endYear ? { year: endYear, precision: 'year' } : null,
      note,
      sourceIdsByBoat,
      proposalIdsByBoat,
      batchId,
      updatedAt: new Date().toISOString(),
    });
    await persistOwnerReviewDocument(document);
    ownerReviewBatchSelection.clear();
    closeOwnerBatchDialog();
    renderOwnerReview();
    setStatus(`${rows.length} separata ägarutkast sparades i batchen`, 'ok');
  } catch (error) {
    setStatus(error.message, 'warning');
  }
}

function renderMasterProfile(boat) {
  const names = masterRecordsForBoat('boat-name-observation', boat.id);
  const allOwners = masterRecordsForBoat('boat-ownership-observation', boat.id)
    .sort((a, b) => Number(a.start?.year || 0) - Number(b.start?.year || 0));
  const owners = visibleOwnershipRecords(allOwners);
  const specs = masterRecordsForBoat('boat-spec-observation', boat.id);
  const events = masterRecordsForBoat('boat-event-observation', boat.id)
    .sort((a, b) => Number(a.date?.year || 0) - Number(b.date?.year || 0));
  const reviews = masterRecordsForBoat('boat-review-item', boat.id).filter(record => record.status !== 'resolved');
  const allRecords = [...names, ...allOwners, ...specs, ...events, ...reviews];
  if (!allRecords.length) return '';
  const sourcesById = new Map(sourceRecords().map(source => [source.id, source]));
  const sources = sourceIdsForRecords(allRecords).map(id => sourcesById.get(id)).filter(Boolean);
  const facts = specRows(specs);
  const conflicts = conflictingSpecFields(specs);
  const hasReviewedConflict = conflicts.length && reviews.some(review => String(review.id).includes('conflict'));
  const nameRows = names
    .filter(record => !['proposal', 'owner-proposal', 'meeting-proposal'].includes(record.kind))
    .sort((left, right) => Number(left.start?.year || 0) - Number(right.start?.year || 0))
    .map(record => ({
      value: [record.prefix, record.value].filter(Boolean).join(' '),
      period: record.start || record.end ? formatOwnershipPeriod(record) : '',
    }))
    .filter((record, index, rows) => rows.findIndex(candidate => candidate.value === record.value && candidate.period === record.period) === index);
  return `<section class="master-profile" aria-label="Båtuppgifter">
    ${owners.length ? `<section class="profile-block"><h3>Ägare</h3><div class="owner-timeline">${owners.map(owner => {
      const period = formatOwnershipPeriod(owner);
      return `<article>${ownerPartyMarkup(owner)}${period && period !== 'Tid okänd' ? `<span>(${escapeHtml(period)})</span>` : ''}</article>`;
    }).join('')}</div></section>` : ''}
    ${facts.length ? `<section class="profile-block"><div class="fact-heading"><h3>Specifikation</h3>${hasReviewedConflict ? '<span class="fact-variance">Uppgifter skiljer sig</span>' : ''}</div><dl class="spec-list">${facts.map(fact => `<div><dt>${escapeHtml(fact.label)}</dt><dd>${escapeHtml(fact.value)}</dd></div>`).join('')}</dl></section>` : ''}
    ${events.length ? `<section class="profile-block"><h3>Historik</h3><ol class="event-list">${events.map(event => `<li>${event.date ? `<time>${escapeHtml(formatObservationDate(event.date))}</time>` : ''}<span>${escapeHtml(event.label)}</span></li>`).join('')}</ol></section>` : ''}
    ${nameRows.length > 1 || boat.visningsurskiljning ? `<section class="profile-block"><h3>Namn</h3><div class="name-timeline">${nameRows.map(name => `<article><strong>${escapeHtml(name.value)}</strong>${name.period ? `<span>${escapeHtml(name.period)}</span>` : ''}</article>`).join('')}</div></section>` : ''}
    ${renderSourceEvidence(sources, reviews)}
  </section>`;
}

function renderFallbackProfile(boat) {
  const facts = [
    ['Modell', boat.modell], ['År', boat.ar], ['Längd', boat.langd_m ? `${boat.langd_m} m` : null], ['Motor', boat.motor],
  ].filter(([, value]) => value !== null && value !== undefined && value !== '');
  if (!facts.length) return '';
  return `<section class="master-profile" aria-label="Båtuppgifter">
    ${facts.length ? `<section class="profile-block"><h3>Specifikation</h3><dl class="spec-list">${facts.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl></section>` : ''}
  </section>`;
}

function ownershipPrecisionOptions(value = 'year') {
  return `<option value="year" ${value === 'year' ? 'selected' : ''}>Från år</option><option value="circa" ${value === 'circa' ? 'selected' : ''}>Cirka år</option><option value="not_later_than" ${value === 'not_later_than' ? 'selected' : ''}>Belagd senast</option><option value="observed" ${value === 'observed' ? 'selected' : ''}>Belagd detta år</option>`;
}

function ownerPartyChoices(context = matrikelFamilyContext()) {
  return [
    ...matrikelPeople.map(person => ({ value: `person:${person.id}`, label: `Person · ${person.display_name}`, party_type: 'person', party_id: person.id, party_label: person.display_name })),
    ...context.familyUnits.map(family => ({ value: `${FAMILY_UNIT_TYPE}:${family.id}`, label: `Familj · ${displayReference(family)}`, party_type: FAMILY_UNIT_TYPE, party_id: family.id, party_label: family.name || displayReference(family), target: family })),
    ...context.kinGroups.map(group => ({ value: `${KIN_GROUP_TYPE}:${group.id}`, label: `Släkt · ${displayReference(group)}`, party_type: KIN_GROUP_TYPE, party_id: group.id, party_label: group.name || displayReference(group), target: group })),
  ].sort((a, b) => a.label.localeCompare(b.label, 'sv'));
}

function renderOwnershipEditor(boat) {
  const owners = masterRecordsForBoat('boat-ownership-observation', boat.id)
    .sort((a, b) => Number(a.start?.year || 0) - Number(b.start?.year || 0));
  const choices = ownerPartyChoices();
  return `<section class="drawer-section ownership-editor"><h3>Ägare</h3><p class="section-help">Årtal och tidsstatus lagras strukturerat. Lämna slutåret tomt om det inte är känt.</p>
    <div class="owner-edit-list">${owners.map(owner => `<article class="owner-edit-card" data-owner-record-id="${escapeHtml(owner.id)}"><header>${ownerPartyMarkup(owner)}</header><div class="structured-date-grid">
      <label>Tidsstatus<select data-owner-start-precision>${ownershipPrecisionOptions(owner.start?.precision || 'year')}</select></label>
      <label>Start/belägg<input type="number" inputmode="numeric" data-owner-start-year value="${escapeHtml(owner.start?.year || '')}"></label>
      <label>Slutår<input type="number" inputmode="numeric" data-owner-end-year value="${escapeHtml(owner.end?.year || '')}"></label>
    </div><div class="button-row"><button class="secondary" type="button" data-action="save-owner">Spara ägarperiod</button><button class="danger subtle-danger" type="button" data-action="delete-owner">Ta bort</button></div></article>`).join('') || '<p>Ingen strukturerad ägare finns ännu.</p>'}</div>
    <details class="add-owner"><summary>Lägg till ägare</summary><div>
      <label class="full-field">Person eller familj<input id="ownership-party-search" list="ownership-party-options" autocomplete="off" placeholder="Sök i Matrikeln …"><datalist id="ownership-party-options">${choices.map(choice => `<option value="${escapeHtml(choice.label)}"></option>`).join('')}</datalist></label>
      <div class="structured-date-grid"><label>Tidsstatus<select id="ownership-start-precision">${ownershipPrecisionOptions()}</select></label><label>Start/belägg<input id="ownership-start-year" type="number" inputmode="numeric"></label><label>Slutår<input id="ownership-end-year" type="number" inputmode="numeric"></label></div>
      <button class="secondary" type="button" data-action="add-owner">Lägg till ägare</button>
    </div></details>
  </section>`;
}

function renderConnectionsEditor(boat) {
  const links = linksForBoat(boat.id);
  const familyLinks = familyLinksForBoat(boat.id);
  const groupLinks = groupLinksForBoat(boat.id);
  const families = familyRecords();
  const context = matrikelFamilyContext();
  const relationChoices = relationLinkChoices(context);
  return `<section class="drawer-section"><h3>Övriga kopplingar</h3><p class="section-help">Kopplingar används för sökning och gruppering. Ägande registreras i avsnittet ovan.</p>
    <div class="link-list">
      ${links.map(link=>`<div class="link-row"><span><a href="../personer-familjer/?person=${encodeURIComponent(link.person_id)}"><b>${escapeHtml(personNameForLink(link))}</b></a><br><small>Person · ${escapeHtml(link.role || '')}</small></span><button type="button" data-delete-link="${escapeHtml(link.id)}" data-link-type="boat-person-link">Ta bort</button></div>`).join('')}
      ${groupLinks.map(link=>{const target=canonicalGroupTarget(link,context);const targetId=target?.id||link.target_id;const targetType=target?.entity_type||link.target_type;const members=targetMemberDetails({type:targetType,id:targetId},context);const inherited=members.filter(member=>member.generation>1).length;const memberText=members.length?` · ${members.length} personer${inherited?` · ${inherited} via gruppen`:''}`:'';return `<div class="link-row family-row"><span><a href="../personer-familjer/?group=${encodeURIComponent(targetId)}"><b>${escapeHtml(groupLinkLabel(link,context))}</b></a><br><small>${escapeHtml(targetTypeLabel(targetType))} · ${escapeHtml(link.role || '')}${escapeHtml(memberText)}</small></span><button type="button" data-delete-link="${escapeHtml(link.id)}" data-link-type="boat-group-link">Ta bort</button></div>`}).join('')}
      ${familyLinks.map(link=>{const family=families.find(item=>item.id===link.family_id);const members=family?familyMembers(family):[];return `<div class="link-row family-row"><span><b>${escapeHtml(link.family_name || link.family_id)}</b><br><small>Familjegren · ${escapeHtml(link.role || '')}${members.length?` · ${escapeHtml(members.map(person=>person.display_name).join(', '))}`:''}</small></span><button type="button" data-delete-link="${escapeHtml(link.id)}" data-link-type="boat-family-link">Ta bort</button></div>`}).join('')}
      ${links.length || familyLinks.length || groupLinks.length ? '' : '<p>Inga övriga kopplingar.</p>'}
    </div>
    <label class="full-field">Lägg till koppling<input id="relation-link-search" list="relation-link-options" autocomplete="off" placeholder="Sök person, familj eller släkt …"><datalist id="relation-link-options">${relationChoices.map(choice=>`<option value="${escapeHtml(choice.label)}"></option>`).join('')}</datalist></label>
    <label class="full-field">Roll<input id="relation-link-role" value="anknuten"></label>
    <div class="button-row"><button class="secondary" type="button" data-action="add-link">Lägg till koppling</button><button class="secondary" type="button" data-action="refresh-people">Hämta från Matrikeln</button></div>
  </section>`;
}

const SPEC_EDIT_FIELDS = Object.freeze([
  { field: 'category', label: 'Kategori', kind: 'category' },
  { field: 'model', label: 'Modell' },
  { field: 'construction_year', label: 'Byggår', kind: 'number', step: '1' },
  { field: 'length_m', label: 'Längd (m)', kind: 'number', step: '0.01' },
  { field: 'width_m', label: 'Bredd (m)', kind: 'number', step: '0.01' },
  { field: 'draft_m', label: 'Djupgående (m)', kind: 'number', step: '0.01' },
  { field: 'freeboard_m', label: 'Fribord (m)', kind: 'number', step: '0.01' },
  { field: 'weight_kg', label: 'Vikt (kg)', kind: 'number', step: '0.1' },
  { field: 'volume_l', label: 'Volym (L)', kind: 'number', step: '0.1' },
  { field: 'load_capacity_kg', label: 'Lastkapacitet (kg)', kind: 'number', step: '0.1' },
  { field: 'construction_material', label: 'Material' },
  { field: 'color', label: 'Färg' },
  { field: 'engine_brand', label: 'Motormärke' },
  { field: 'horsepower', label: 'Motorstyrka (hk)', kind: 'number', step: '0.1' },
  { field: 'engine_power_kw', label: 'Motorstyrka (kW)', kind: 'number', step: '0.1' },
  { field: 'engine_model', label: 'Motormodell' },
  { field: 'fuel', label: 'Drivmedel' },
  { field: 'sail_area_m2', label: 'Segelyta (m²)', kind: 'number', step: '0.1' },
  { field: 'mast_m', label: 'Mast (m)', kind: 'number', step: '0.1' },
  { field: 'speed_kn', label: 'Fart (kn)', kind: 'number', step: '0.1' },
]);

function specEditInput(definition, value) {
  if (definition.kind === 'category') {
    const choices = [
      ['', 'Ej angiven'], ['motorboat', 'Motorbåt'], ['sailboat', 'Segelbåt'],
      ['rowboat', 'Rodd-/jollebåt'], ['kayak', 'Kajak'], ['surfboard', 'Surfbräda'],
      ['kiteboard', 'Kitesurfbräda'],
    ];
    return `<label>${definition.label}<select data-spec-field="${definition.field}">${choices.map(([id, label]) => `<option value="${id}" ${value === id ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`;
  }
  const type = definition.kind === 'number' ? 'number' : 'text';
  const step = definition.kind === 'number' ? ` step="${definition.step || 'any'}"` : '';
  return `<label>${definition.label}<input type="${type}"${step} data-spec-field="${definition.field}" value="${escapeHtml(value ?? '')}"></label>`;
}

function expectedSpecRecords(boatId) {
  return masterRecordsForBoat('boat-spec-observation', boatId).map(({ id, ...record }) => ({ entity_id: id, record }));
}

function renderStructuredSpecEditor(boat) {
  const decision = specReviewDocument?.decisions?.[boat.id] || null;
  const expected = decision?.expected_specs || expectedSpecRecords(boat.id);
  const baseline = effectiveSpecValues(expected.map(item => item.record));
  const shown = { ...baseline, ...(decision?.values || {}) };
  const status = decision ? (decision.status === 'ready' ? 'Klar för införande' : 'Utkast sparat') : '';
  const actions = `<button type="button" data-action="save-spec-draft">Spara utkast</button><button class="primary" type="button" data-action="save-spec-ready">Klar för införande</button>${decision ? '<button class="danger subtle-danger" type="button" data-action="clear-spec-review">Rensa utkast</button>' : ''}${specReviewDocument && Object.values(specReviewDocument.decisions).some(item => item.status === 'ready') ? '<button type="button" data-action="export-spec-queue">Hämta specifikationskö</button>' : ''}`;
  return `<section class="drawer-section structured-spec-editor"><div class="fact-heading"><h3>Specifikation</h3>${status ? `<span class="review-status status-${escapeHtml(decision.status)}">${status}</span>` : ''}</div>
    <p class="section-help">Ändra ett befintligt värde när källan har lästs fel. Då rättas källposten; det gamla läsfelet blir inte en konkurrerande uppgift. Tomma fält kan kompletteras som nya fakta.</p>
    <div class="edit-grid">${SPEC_EDIT_FIELDS.map(definition => specEditInput(definition, shown[definition.field])).join('')}</div>
    <label class="full-field">Källa eller kommentar <textarea data-spec-note rows="2" placeholder="Valfritt; ange helst vem eller vilket dokument uppgiften kommer från.">${escapeHtml(decision?.note || '')}</textarea></label>
    <div class="decision-actions">${actions}</div>
  </section>`;
}

function renderEditor(boat) {
  if (localPilotPreview) return `<section class="boat-editor" aria-label="Redigera båt">${renderStructuredSpecEditor(boat)}</section>`;
  return `<section class="boat-editor" aria-label="Redigera båt">
    <section class="drawer-section"><h3>Grunduppgifter</h3><div class="edit-grid">
      ${textField('Namn','namn',boat.namn)}
      <label>Namnstatus<select data-boat-field="namnstatus"><option value="namn" ${boat.namnstatus==='namn'?'selected':''}>Känt namn</option><option value="dopnamn" ${boat.namnstatus==='dopnamn'?'selected':''}>Endast dopnamn</option><option value="saknas" ${boat.namnstatus==='saknas'?'selected':''}>Namn okänt</option></select></label>
      ${textField('Dopnamn','dopnamn',boat.dopnamn)}${textField('Önskat namn','onskat_namn',boat.onskat_namn)}
      ${textField('Typ','typ',boat.typ)}${textField('Modell','modell',boat.modell)}
      ${numberField('År','ar',boat.ar)}${numberField('Längd (m)','langd_m',boat.langd_m,'0.1')}
      ${textField('Motor','motor',boat.motor)}${textField('Historisk släkt/grupp','slakt',boat.slakt)}
      ${textField('Period, äldre fritext','period',boat.period,'span-2')}${textField('Ägare, äldre fritext','agare',boat.agare,'span-2')}
      ${textField('Tidigare namn, kommaseparerade','tidigare_namn',(boat.tidigare_namn||[]).join(', '),'span-2')}
      ${textField('Senare namn, kommaseparerade','senare_namn',(boat.senare_namn||[]).join(', '),'span-2')}
    </div></section>
    ${renderOwnershipEditor(boat)}
    ${renderConnectionsEditor(boat)}
    <section class="drawer-section"><h3>Bilder</h3><p>${(boat.images||[]).length} bildposter.</p><input id="image-upload" type="file" accept="image/*"></section>
    <section class="drawer-section danger-zone"><button class="danger" type="button" data-action="delete-boat">Ta bort båten</button></section>
  </section>`;
}

function ownerReviewRowForBoat(boatId) {
  return [...(ownerReviewInventory?.rows || []), ...(ownerReviewInventory?.structured_review_rows || [])].find(row => row.boat_id === boatId) || null;
}

function newOwnerReviewDecision(boatId) {
  const row = ownerReviewRowForBoat(boatId);
  if (!row) return null;
  return {
    decision_id: `owner-review:${boatId}`,
    boat_id: boatId,
    mode: row.review_kind === 'correction' ? 'replace' : 'insert',
    expected_ownerships: structuredClone(row.existing_ownerships || []),
    status: 'draft',
    source_owner_text: row.owner_text,
    note: '',
    ownerships: [],
    updated_at: null,
  };
}

function sourceOptionsForBoat(boatId) {
  return sourcesForBoat(boatId).filter(sourceSupportsOwnership)
    .sort((left, right) => String(left.label).localeCompare(String(right.label), 'sv'));
}

function sourcesForBoat(boatId) {
  const manifestIds = new Set(sourceIdsForBoatInManifest(localSourceManifest, boatId));
  return sourceRecords().filter(source => manifestIds.has(source.id) || (source.entity_ids || []).includes(boatId))
    .sort((left, right) => String(left.label).localeCompare(String(right.label), 'sv'));
}

function sourceLocalStatus(sourceId) {
  return sourceViewEntry(localSourceManifest, sourceId)?.local_status || 'master';
}

function sourceHasView(sourceId) {
  return Boolean(sourceViewEntry(localSourceManifest, sourceId)?.artifacts?.length);
}

function reviewEvidenceMarkup(boatId) {
  const sources = sourcesForBoat(boatId);
  if (!sources.length) return '<section class="review-evidence"><div><h4>Originalkällor</h4><p>Ingen originalfil är ännu kopplad till båten.</p></div></section>';
  return `<section class="review-evidence"><header><div><h4>Originalkällor</h4><p>Öppna underlaget och jämför det med ägartexten och den strukturerade kopplingen.</p></div><span>${sources.length}</span></header><div>${sources.map(source => {
    const meta = [SOURCE_KIND_LABELS[source.kind] || source.kind, source.source_date].filter(Boolean).join(' · ');
    const localStatus = sourceLocalStatus(source.id);
    const status = localStatus === 'candidate' ? 'Möjlig fil' : sourceSupportsOwnership(source) ? 'Ägaruppgift' : '';
    return `<article><div><b>${escapeHtml(source.label)}</b>${meta ? `<small>${escapeHtml(meta)}</small>` : ''}${status ? `<span class="source-use source-use-${escapeHtml(localStatus)}">${escapeHtml(status)}</span>` : ''}</div>${sourceHasView(source.id) ? `<button type="button" data-view-source="${escapeHtml(source.id)}">Visa källa</button>` : '<em>Ingen visningsfil</em>'}</article>`;
  }).join('')}</div></section>`;
}

function naturalList(values) {
  if (values.length < 2) return values[0] || '';
  if (values.length === 2) return `${values[0]} och ${values[1]}`;
  return `${values.slice(0, -1).join(', ')} och ${values.at(-1)}`;
}

function reviewProposalFromComposer(boatId, targets = ownerReviewComposerTargets) {
  if (!targets.length) throw new Error('Välj minst en person, familj eller släkt som ägarpart');
  const multiple = targets.length > 1;
  if (multiple && targets.some(target => target.party_type !== 'person')) throw new Error('Flera val kan bara kombineras när samtliga är personer');
  const first = targets[0];
  const startYear = yearValue($('#review-owner-start-year'));
  const endYear = yearValue($('#review-owner-end-year'));
  const sourceIds = [...drawer.querySelectorAll('[data-review-source-id]:checked')].map(input => input.dataset.reviewSourceId);
  const record = {
    proposal_id: `owner-proposal:${boatId}:${crypto.randomUUID().slice(0, 8)}`,
    role: $('#review-owner-role')?.value || 'owner',
    party_type: multiple ? 'person-set' : first.party_type,
    ...(multiple ? { party_ids: targets.map(target => target.party_id), party_label: naturalList(targets.map(target => target.party_label)) }
      : { party_id: first.party_id, party_label: first.party_label }),
    start: startYear ? { year: startYear, precision: $('#review-owner-start-precision').value } : null,
    end: endYear ? { year: endYear, precision: 'year' } : null,
    sequence: (ownerReviewDraft?.ownerships?.length || 0) + 1,
    status: 'accepted',
    source_ids: sourceIds,
  };
  validateOwnerReviewDecision({ decision_id: 'temporary', boat_id: boatId, status: 'draft', ownerships: [record] });
  return record;
}

function renderOwnerReviewDecisionEditor(boat) {
  const row = ownerReviewRowForBoat(boat.id);
  const decision = ownerReviewDraft || newOwnerReviewDecision(boat.id);
  if (!row || !decision) return '<p>Granskningsunderlag saknas för båten.</p>';
  const sources = sourceOptionsForBoat(boat.id);
  const choices = ownerPartyChoices();
  const savedStatus = ownerReviewDocument?.decisions?.[boat.id]?.status || 'unreviewed';
  const correction = decision.mode === 'replace';
  const nextOwnerLabel = decision.ownerships.length ? 'Lägg till nästa ägare' : 'Lägg till första ägare';
  return `<section class="owner-decision-editor" aria-label="Granskningsbeslut för ägare">
    <header><div><span>${correction ? 'Rättar befintlig ägarstruktur' : 'Granskningsbeslut'}</span><h3>${escapeHtml(reviewStatusLabel(savedStatus))}</h3></div><span class="structured-role">Roll · ${escapeHtml(OWNER_ROLES.owner)}</span></header>
    <section class="decision-source-text"><span>${correction ? 'Nuvarande struktur' : 'Äldre ägaruppgift'}</span><p>${escapeHtml(row.owner_text)}</p>${row.review_reason ? `<small>${escapeHtml(row.review_reason)}</small>` : ''}</section>
    ${reviewEvidenceMarkup(boat.id)}
    <section class="decision-proposals"><h4>${correction ? 'Ägarföljd efter rättning' : 'Ägarföljd som ska införas'}</h4>${decision.ownerships.length ? [...decision.ownerships].sort((left, right) => left.sequence - right.sequence).map(proposal => {
      const proposalSources = proposal.source_ids.map(id => sources.find(source => source.id === id)?.label || id);
      return `<article data-review-proposal-id="${escapeHtml(proposal.proposal_id)}"><div><span class="owner-sequence">${escapeHtml(proposal.sequence)}</span><b>${ownerPartyMarkup(proposal)}</b><span>${escapeHtml(OWNER_ROLES[proposal.role])}${formatOwnershipPeriod(proposal) !== 'Tid okänd' ? ` · ${escapeHtml(formatOwnershipPeriod(proposal))}` : ''}</span>${proposalSources.length ? `<small>${escapeHtml(proposalSources.join(' · '))}</small>` : '<small class="missing-source">Källa måste väljas före införande</small>'}</div><button type="button" data-action="review-remove-proposal">Ta bort</button></article>`;
    }).join('') : '<p>Ingen strukturerad ägarpost tillagd ännu.</p>'}</section>
    <details class="decision-add" open><summary>Lägg till ägarpost</summary><div>
      <div class="decision-role-row"><label>Roll<select id="review-owner-role"><option value="owner">Ägare</option></select></label><p>Rollen sparas som den strukturerade koden <code>owner</code>.</p></div>
      ${(row.person_links || []).length ? `<div class="review-candidate-buttons"><span>Personkandidater</span>${row.person_links.filter(link => link.person_id).map(link => `<button class="secondary" type="button" data-review-candidate-person="${escapeHtml(link.person_id)}">Välj ${escapeHtml(link.stored_name || link.person_id)}</button>`).join('')}</div>` : ''}
      <label class="full-field">Person, familj eller släkt<input id="review-party-search" list="review-party-options" autocomplete="off" placeholder="Sök i Matrikeln …"><datalist id="review-party-options">${choices.map(choice => `<option value="${escapeHtml(choice.label)}"></option>`).join('')}</datalist></label>
      <div class="button-row"><button class="secondary" type="button" data-action="review-select-target">Välj som ägare</button><button class="secondary" type="button" data-action="review-add-coowner">Lägg till som samägare</button></div>
      <div class="review-party-targets">${ownerReviewComposerTargets.map((target, index) => `<span>${escapeHtml(target.party_label)}<button type="button" data-review-remove-target="${index}" aria-label="Ta bort ${escapeHtml(target.party_label)}">×</button></span>`).join('') || '<em>Ingen ägarpart vald.</em>'}</div>
      <div class="structured-date-grid"><label>Tidsstatus<select id="review-owner-start-precision">${ownershipPrecisionOptions('observed')}</select></label><label>Start/belägg<input id="review-owner-start-year" type="number" inputmode="numeric" value="${escapeHtml(row.observation_year || '')}"></label><label>Slutår<input id="review-owner-end-year" type="number" inputmode="numeric"></label></div>
      <fieldset class="review-source-options"><legend>Källa för just denna ägarpost</legend>${sources.length ? sources.map(source => `<div class="review-source-choice"><label><input type="checkbox" data-review-source-id="${escapeHtml(source.id)}"><span><b>${escapeHtml(source.label)}</b><small>${escapeHtml(SOURCE_KIND_LABELS[source.kind] || source.kind || '')}</small></span></label>${sourceHasView(source.id) ? `<button type="button" data-view-source="${escapeHtml(source.id)}">Visa källa</button>` : ''}</div>`).join('') : '<p>Ingen källa som uttryckligen anger ägaren är ännu kopplad till båten. Beslutet kan sparas som utkast eller utredning, men inte göras klart för införande.</p>'}</fieldset>
      <button class="secondary decision-add-button" type="button" data-action="review-add-proposal">${nextOwnerLabel}</button>
      <p class="decision-save-help">Varje ägarbyte blir en ny, ordnad ägarpost. Använd ”samägare” bara när personerna ägde båten samtidigt.</p>
    </div></details>
    <label class="full-field">Anteckning för granskningen<textarea id="review-decision-note" rows="3" placeholder="Vad behöver kontrolleras eller varför är kopplingen riktig?">${escapeHtml(decision.note || '')}</textarea></label>
    <div class="decision-actions"><button type="button" data-action="review-save-draft">Spara utkast</button><button class="secondary" type="button" data-action="review-needs-research">Behöver utredas</button><button class="primary" type="button" data-action="review-ready">Klar för införande</button>${ownerReviewDocument?.decisions?.[boat.id] ? '<button class="danger subtle-danger" type="button" data-action="review-clear">Rensa beslut</button>' : ''}</div>
  </section>`;
}

function renderDrawer(id) {
  const boat = boatRecords().find(item => item.id === id);
  if (!boat) return closeDrawer();
  const profile = renderMasterProfile(boat) || renderFallbackProfile(boat);
  const editButton = ownerReviewDecisionMode ? '' : `<button class="edit-toggle" type="button" data-action="toggle-edit">${drawerEditMode ? 'Klar' : 'Redigera'}</button>`;
  drawerContent.innerHTML = `<header class="drawer-heading"><h2 class="drawer-title">${escapeHtml(boatDisplayHeading(boat))}</h2>${editButton}</header>${drawerGalleryMarkup(boat)}${profile}${ownerReviewDecisionMode ? renderOwnerReviewDecisionEditor(boat) : drawerEditMode ? renderEditor(boat) : ''}`;
  drawer.setAttribute('aria-label', ownerReviewDecisionMode ? `Granska ägare för ${boatDisplayName(boat)}` : drawerEditMode ? `Redigera ${boatDisplayName(boat)}` : boatDisplayName(boat));
  drawer.setAttribute('aria-hidden','false'); backdrop.hidden=false;
  hydrateImages(drawer);
}

function openDrawer(id, { reviewDecision = false } = {}) {
  if (batregisterV2Mode) return batregisterV2Controller?.open(id);
  selectedBoatId=id;
  drawerEditMode=false;
  ownerReviewDecisionMode=reviewDecision;
  ownerReviewComposerTargets=[];
  ownerReviewDraft=reviewDecision ? structuredClone(ownerReviewDocument?.decisions?.[id] || newOwnerReviewDecision(id)) : null;
  renderDrawer(id);
}
function closeDrawer() { if (batregisterV2Mode) return batregisterV2Controller?.close(); selectedBoatId=null; drawerEditMode=false; ownerReviewDecisionMode=false; ownerReviewDraft=null; ownerReviewComposerTargets=[]; drawer.setAttribute('aria-hidden','true'); backdrop.hidden=true; drawerContent.innerHTML=''; }

function parseField(target) {
  const field = target.dataset.boatField;
  if (['ar','dopar'].includes(field)) return target.value ? Number(target.value) : null;
  if (field === 'langd_m') return target.value ? Number(target.value.replace(',','.')) : null;
  if (['tidigare_namn','senare_namn','smeknamn'].includes(field)) return target.value.split(',').map(value=>value.trim()).filter(Boolean);
  return target.value.trim() || null;
}

async function syncEdit(action) {
  await assertGenerationOneWritable();
  await action(); render();
  try { await syncNow(); } catch (_) { setStatus('Sparat lokalt · synk kräver åtgärd','warning'); }
}

function parseSpecInput(input) {
  if (!input.value.trim()) return null;
  if (input.type !== 'number') return input.value.trim();
  const value = Number(input.value.replace(',', '.'));
  if (!Number.isFinite(value)) throw new Error(`${input.closest('label')?.firstChild?.textContent?.trim() || 'Fältet'} måste vara ett tal`);
  return value;
}

function collectSpecCorrection(expectedSpecs) {
  const baseline = effectiveSpecValues(expectedSpecs.map(item => item.record));
  const values = {};
  const resolvesFields = [];
  for (const input of drawerContent.querySelectorAll('[data-spec-field]')) {
    const field = input.dataset.specField;
    const value = parseSpecInput(input);
    if (JSON.stringify(value) === JSON.stringify(baseline[field] ?? null)) continue;
    values[field] = value;
    resolvesFields.push(field);
  }
  if (!resolvesFields.length) throw new Error('Inga specifikationsfält har ändrats');
  return {
    values,
    resolves_fields: resolvesFields,
    note: drawerContent.querySelector('[data-spec-note]')?.value.trim() || '',
  };
}

function specFieldActions(expectedSpecs, fields) {
  return Object.fromEntries(fields.map(field => {
    const targets = expectedSpecs.filter(item => field in (item.record.values || {}));
    if (targets.length > 1) throw new Error(`${field} finns i flera källobservationer och måste granskas mot källorna innan det rättas`);
    return [field, targets.length
      ? { action: 'correct-source', target_entity_id: targets[0].entity_id }
      : { action: 'add-fact', target_entity_id: null }];
  }));
}

async function persistSpecReviewDocument(document) {
  specReviewDocument = normalizeSpecReviewDocument(document, requestedPilotId);
  await store.putMeta(`${SPEC_REVIEW_META_PREFIX}${requestedPilotId}`, specReviewDocument);
}

async function saveSpecReview(status) {
  try {
    const boat = boatRecords().find(item => item.id === selectedBoatId);
    if (!boat) return;
    const existing = specReviewDocument?.decisions?.[boat.id] || null;
    const expectedSpecs = existing?.expected_specs || expectedSpecRecords(boat.id);
    const correction = collectSpecCorrection(expectedSpecs);
    const decision = {
      decision_id: existing?.decision_id || `spec-review:${boat.id}`,
      boat_id: boat.id,
      status,
      expected_specs: structuredClone(expectedSpecs),
      values: correction.values,
      resolves_fields: correction.resolves_fields,
      field_actions: specFieldActions(expectedSpecs, correction.resolves_fields),
      note: correction.note,
      updated_at: new Date().toISOString(),
    };
    const document = saveSpecReviewDecision(specReviewDocument || emptySpecReviewDocument(requestedPilotId), decision);
    await persistSpecReviewDocument(document);
    renderDrawer(boat.id);
    setStatus(status === 'ready' ? 'Specifikationsrättelsen är klar för införande' : 'Specifikationsutkastet är sparat lokalt', 'ok');
  } catch (error) {
    setStatus(error.message, 'warning');
  }
}

async function clearSpecReview() {
  if (!specReviewDocument?.decisions?.[selectedBoatId]) return;
  await persistSpecReviewDocument(removeSpecReviewDecision(specReviewDocument, selectedBoatId));
  renderDrawer(selectedBoatId);
  setStatus('Specifikationsutkastet rensat · mastern är oförändrad', 'ok');
}

function exportSpecReviewChangeQueue() {
  try {
    const queue = buildSpecChangeQueue({
      document: specReviewDocument,
      boats: boatRecords(),
      specRecords: masterRecords('boat-spec-observation'),
    });
    if (!queue.decisions.length) throw new Error('Inga specifikationsrättelser är klara för införande');
    downloadJson(`batregister-specifikationsko-${new Date().toISOString().slice(0, 10)}.json`, queue);
    setStatus(`${queue.decisions.length} specifikationsrättelser exporterade · mastern är ännu oförändrad`, 'ok');
  } catch (error) {
    setStatus(error.message, 'warning');
  }
}

const yearValue = input => input?.value ? Number(input.value) : null;

async function saveOwnership(button) {
  const card = button.closest('[data-owner-record-id]');
  const current = masterRecords('boat-ownership-observation').find(record => record.id === card?.dataset.ownerRecordId);
  if (!current) return;
  const startYear = yearValue(card.querySelector('[data-owner-start-year]'));
  const endYear = yearValue(card.querySelector('[data-owner-end-year]'));
  if (startYear && endYear && endYear < startYear) {
    setStatus('Slutåret kan inte ligga före startåret.','warning');
    return;
  }
  const { id, ...record } = current;
  const value = {
    ...record,
    start: startYear ? { year: startYear, precision: card.querySelector('[data-owner-start-precision]').value } : null,
    end: endYear ? { year: endYear, precision: 'year' } : null,
  };
  await syncEdit(() => repository.setField('boat-ownership-observation', id, 'record', value));
}

async function addOwnership() {
  const input = $('#ownership-party-search');
  const choice = ownerPartyChoices().find(item => item.label === input?.value);
  if (!choice) {
    setStatus('Välj en person eller familj ur listan.','warning');
    return;
  }
  const startYear = yearValue($('#ownership-start-year'));
  const endYear = yearValue($('#ownership-end-year'));
  if (startYear && endYear && endYear < startYear) {
    setStatus('Slutåret kan inte ligga före startåret.','warning');
    return;
  }
  const sourceId = 'source:direct-app-entry';
  const existingDirectSource = sourceRecords().find(source => source.id === sourceId);
  const ownerId = `owner:${selectedBoatId}:${slug(choice.party_id)}:${crypto.randomUUID().slice(0,8)}`;
  const record = {
    boat_id: selectedBoatId,
    role: 'owner',
    party_type: choice.party_type,
    party_id: choice.party_id,
    party_label: choice.party_label,
    start: startYear ? { year:startYear, precision:$('#ownership-start-precision').value } : null,
    end: endYear ? { year:endYear, precision:'year' } : null,
    status: 'accepted',
    source_ids: [sourceId],
  };
  await syncEdit(() => repository.upsertFields([
    { entityType:'boat-source', entityId:sourceId, field:'record', value:{ id:sourceId, label:'Uppgift inlagd direkt i Båtregistret', kind:'direct-entry', source_date:null, relative_path:null, master_path:'/batregister/ops', entity_ids:unique([...(existingDirectSource?.entity_ids || []), selectedBoatId]), speaker:null, recorded_at:null, statement:null, sha256:null, authority_for:['manually entered fact'] } },
    { entityType:'boat-ownership-observation', entityId:ownerId, field:'record', value:record },
  ]));
}

async function deleteOwnership(button) {
  const id = button.closest('[data-owner-record-id]')?.dataset.ownerRecordId;
  if (!id) return;
  const restoreEntries = [{ entityType:'boat-ownership-observation', entityId:id }];
  await syncEdit(() => repository.deleteEntity('boat-ownership-observation', id));
  offerUndo('Ägaruppgiften borttagen', restoreEntries, 'Ägaruppgiften återställd');
}

function reviewChoiceForInput() {
  const input = $('#review-party-search');
  return ownerPartyChoices().find(choice => choice.label === input?.value) || null;
}

function selectReviewComposerTarget() {
  const choice = reviewChoiceForInput();
  if (!choice) return setStatus('Välj en person, familj eller släkt ur listan.','warning');
  ownerReviewComposerTargets = [choice];
  renderDrawer(selectedBoatId);
}

function addReviewComposerCoowner() {
  const choice = reviewChoiceForInput();
  if (!choice) return setStatus('Välj en person ur listan.','warning');
  if (choice.party_type !== 'person') return setStatus('Samägare kan bara vara uttryckligen namngivna personer. Välj annars familjen som en enda ägarpart.','warning');
  if (ownerReviewComposerTargets.some(target => target.value === choice.value)) return setStatus('Samägaren är redan vald.','warning');
  const combined = [...ownerReviewComposerTargets, choice];
  if (combined.length > 1 && combined.some(target => target.party_type !== 'person')) return setStatus('En familj eller släkt måste vara ensam ägarpart.','warning');
  ownerReviewComposerTargets = combined;
  renderDrawer(selectedBoatId);
}

function selectReviewCandidate(personId) {
  const choice = ownerPartyChoices().find(candidate => candidate.party_type === 'person' && candidate.party_id === personId);
  if (!choice) return setStatus('Personkandidaten finns inte i Matrikelmastern.','warning');
  ownerReviewComposerTargets = [choice];
  renderDrawer(selectedBoatId);
}

function removeReviewComposerTarget(index) {
  ownerReviewComposerTargets = ownerReviewComposerTargets.filter((_, candidateIndex) => candidateIndex !== Number(index));
  renderDrawer(selectedBoatId);
}

function addReviewProposal() {
  try {
    const proposal = reviewProposalFromComposer(selectedBoatId);
    ownerReviewDraft.ownerships.push(proposal);
    ownerReviewDraft.status = 'draft';
    ownerReviewComposerTargets = [];
    renderDrawer(selectedBoatId);
    setStatus('Ägarpost tillagd i utkastet. Beslutet är ännu inte infört i master.','ok');
  } catch (error) {
    setStatus(error.message, 'warning');
  }
}

function removeReviewProposal(proposalId) {
  ownerReviewDraft.ownerships = ownerReviewDraft.ownerships.filter(proposal => proposal.proposal_id !== proposalId).map((proposal, index) => ({ ...proposal, sequence: index + 1 }));
  ownerReviewDraft.status = 'draft';
  renderDrawer(selectedBoatId);
}

async function persistOwnerReviewDocument(document) {
  ownerReviewDocument = normalizeOwnerReviewDocument(document, requestedPilotId);
  await store.putMeta(`${OWNER_REVIEW_META_PREFIX}${requestedPilotId}`, ownerReviewDocument);
}

async function saveReviewDecision(status) {
  try {
    const inputChoice = reviewChoiceForInput();
    const typedChoice = $('#review-party-search')?.value.trim() || '';
    if (typedChoice && !inputChoice) throw new Error('Välj personen, familjen eller släkten ur söklistan innan du sparar');
    const pendingTargets = [...ownerReviewComposerTargets];
    if (inputChoice && !pendingTargets.length) pendingTargets.push(inputChoice);
    else if (inputChoice && !pendingTargets.some(target => target.value === inputChoice.value)) throw new Error('Tryck ”Välj som ägare” eller ”Lägg till som samägare” innan du sparar');
    const draft = structuredClone(ownerReviewDraft);
    if (pendingTargets.length) draft.ownerships.push(reviewProposalFromComposer(selectedBoatId, pendingTargets));
    const decision = {
      ...draft,
      status,
      note: $('#review-decision-note')?.value.trim() || '',
      updated_at: new Date().toISOString(),
    };
    const ownerSourceIds = new Set(sourceOptionsForBoat(decision.boat_id).map(source => source.id));
    validateOwnerReviewDecision(decision, { requireReady: status === 'ready', ownerSourceIds });
    const document = saveOwnerReviewDecision(ownerReviewDocument, decision);
    await persistOwnerReviewDocument(document);
    ownerReviewDraft = structuredClone(decision);
    ownerReviewComposerTargets = [];
    render();
    setStatus(status === 'ready' ? 'Beslutet ligger i ändringskön · mastern är ännu oförändrad' : status === 'needs_research' ? 'Markerad för fortsatt utredning' : 'Utkastet är sparat lokalt', 'ok');
  } catch (error) {
    setStatus(error.message, 'warning');
  }
}

async function clearReviewDecision() {
  const row = ownerReviewRowForBoat(selectedBoatId);
  if (!confirm(`Rensa det lokala granskningsbeslutet för ${row?.boat_name || selectedBoatId}? Båtmastern påverkas inte.`)) return;
  await persistOwnerReviewDocument(removeOwnerReviewDecision(ownerReviewDocument, selectedBoatId));
  ownerReviewDraft = newOwnerReviewDecision(selectedBoatId);
  ownerReviewComposerTargets = [];
  render();
  setStatus('Det lokala granskningsbeslutet är rensat · mastern var oförändrad','ok');
}

async function addBoat() {
  const name = prompt('Båtens namn (kan ändras senare):');
  if (!name?.trim()) return;
  const id = `${slug(name)}-${crypto.randomUUID().slice(0,8)}`;
  await syncEdit(()=>repository.setFields([
    {entityType:'boat',entityId:id,field:'namn',value:name.trim()},
    {entityType:'boat',entityId:id,field:'namnstatus',value:'namn'},
    {entityType:'boat',entityId:id,field:'images',value:[]},
    {entityType:'boat',entityId:id,field:'kallor',value:['direkt i Båtregister']},
  ]));
  openDrawer(id);
}

async function deleteBoat() {
  const boat = boatRecords().find(item=>item.id===selectedBoatId); if(!boat)return;
  const links=linksForBoat(boat.id);
  const familyLinks=familyLinksForBoat(boat.id);
  const groupLinks=groupLinksForBoat(boat.id);
  if(!confirm(`Ta bort ${boat.namn} och ${links.length+familyLinks.length+groupLinks.length} kopplingar? Historiken finns kvar som tombstones.`))return;
  const restoreEntries=[...links.map(link=>({entityType:'boat-person-link',entityId:link.id})),...familyLinks.map(link=>({entityType:'boat-family-link',entityId:link.id})),...groupLinks.map(link=>({entityType:'boat-group-link',entityId:link.id})),{entityType:'boat',entityId:boat.id}];
  await syncEdit(()=>repository.deleteEntities(restoreEntries));
  closeDrawer();
  offerUndo(`${boat.namn} borttagen`,restoreEntries,`${boat.namn} återställd`);
}

async function addRelationLink() {
  const input=$('#relation-link-search');const choice=relationLinkChoices().find(item=>item.label===input?.value);const value=choice?.value;if(!value){setStatus('Välj en person, FAMILJ eller SLÄKT ur söklistan.','warning');return}
  const separator=value.indexOf(':');const kind=value.slice(0,separator);const id=value.slice(separator+1); const role=$('#relation-link-role').value.trim()||'ägare/anknuten';
  if(kind==='person'){
    const person=matrikelPeople.find(item=>item.id===id); if(!person)return;
    const linkId=`${selectedBoatId}--${person.id}`;
    await syncEdit(()=>repository.upsertFields([
      {entityType:'boat-person-link',entityId:linkId,field:'boat_id',value:selectedBoatId},
      {entityType:'boat-person-link',entityId:linkId,field:'person_id',value:person.id},
      {entityType:'boat-person-link',entityId:linkId,field:'role',value:role},
      {entityType:'boat-person-link',entityId:linkId,field:'confidence',value:'godkänd i appen'},
    ]));
    return;
  }
  if(kind===FAMILY_UNIT_TYPE||kind===KIN_GROUP_TYPE){
    const context=matrikelFamilyContext();
    const target=(kind===FAMILY_UNIT_TYPE?context.familyUnitById:context.kinGroupById).get(id);if(!target)return;
    const linkId=`${selectedBoatId}--group--${kind}--${id}`;
    await syncEdit(()=>repository.upsertFields([
      {entityType:'boat-group-link',entityId:linkId,field:'boat_id',value:selectedBoatId},
      {entityType:'boat-group-link',entityId:linkId,field:'target_type',value:kind},
      {entityType:'boat-group-link',entityId:linkId,field:'target_id',value:target.id},
      {entityType:'boat-group-link',entityId:linkId,field:'target_code',value:target.reference_code},
      {entityType:'boat-group-link',entityId:linkId,field:'target_name',value:target.name},
      {entityType:'boat-group-link',entityId:linkId,field:'role',value:role},
      {entityType:'boat-group-link',entityId:linkId,field:'confirmed',value:true},
    ]));
    return;
  }
  if(kind==='legacy-family'){
    const family=familyRecords().find(item=>item.id===id); if(!family)return;
    const linkId=`${selectedBoatId}--family--${family.id}`;
    await syncEdit(()=>repository.upsertFields([
      {entityType:'boat-family-link',entityId:linkId,field:'boat_id',value:selectedBoatId},
      {entityType:'boat-family-link',entityId:linkId,field:'family_id',value:family.id},
      {entityType:'boat-family-link',entityId:linkId,field:'family_name',value:family.name},
      {entityType:'boat-family-link',entityId:linkId,field:'role',value:role},
      {entityType:'boat-family-link',entityId:linkId,field:'confidence',value:'godkänd i appen'},
    ]));
  }
}

async function deleteLink(type,id) {
  const restoreEntries=[{entityType:type,entityId:id}];
  await syncEdit(()=>repository.deleteEntity(type,id));
  offerUndo('Kopplingen borttagen',restoreEntries,'Kopplingen återställd');
}

async function uploadImage(file) {
  if (!file || !selectedBoatId) return;
  setStatus('Förbereder bilden…');
  const prepared=await prepareImageForStorage(file);
  const hashBytes=new Uint8Array(await crypto.subtle.digest('SHA-256',await prepared.blob.arrayBuffer()));
  const hash=[...hashBytes].map(byte=>byte.toString(16).padStart(2,'0')).join('');
  const extension=prepared.extension;
  const path=`/batregister/bilder/${hash}.${extension}`;
  await store.putBlob(path,prepared.blob,{pendingUpload:true});
  objectUrl(path,prepared.blob);
  const boat=boatRecords().find(item=>item.id===selectedBoatId);
  const dimensions=prepared.width&&prepared.height?`, ${prepared.width}×${prepared.height}px`:'';
  const images=[...(boat.images||[]),{id:crypto.randomUUID(),thumb:{dropbox_path:path,sha256:hash},full:{dropbox_path:path,sha256:hash},source:`Uppladdad ${new Date().toISOString()}${prepared.resized?` · nedskalad${dimensions}`:''}`}];
  await syncEdit(()=>repository.setField('boat',boat.id,'images',images));
}

async function completeOAuthCallbackIfNeeded() {
  const url=new URL(location.href); if(!url.searchParams.has('code')&&!url.searchParams.has('error'))return;
  const token=await completeDropboxOAuth(); accessToken=token.access_token;
  accessTokenExpiresAt=Date.now()+Math.max(30,Number(token.expires_in||0)-60)*1000;
  if(token.refresh_token)await store.putMeta(TOKEN_META,token.refresh_token);
  for(const parameter of ['code','state','error','error_description'])url.searchParams.delete(parameter);
  history.replaceState({},'',`${url.pathname}${url.search}${url.hash}`);
}

async function currentAccessToken() {
  if(accessToken&&Date.now()<accessTokenExpiresAt)return accessToken;
  const refreshToken=await store.getMeta(TOKEN_META); if(!refreshToken||!DROPBOX_CLIENT_ID)return null;
  if(navigator.onLine===false)return null;
  const token=await exchangeDropboxRefreshToken({clientId:DROPBOX_CLIENT_ID,refreshToken});
  accessToken=token.access_token; accessTokenExpiresAt=Date.now()+Math.max(30,Number(token.expires_in||0)-60)*1000;if(token.refresh_token&&token.refresh_token!==refreshToken)await store.putMeta(TOKEN_META,token.refresh_token);return accessToken;
}

async function uploadBootstrapOps(transport) {
  const pending=await store.getMeta(BOOTSTRAP_META); if(!pending?.pending)return 0;
  const operations=(await store.getAllOps()).filter(op=>op.device_id===pending.device_id).sort((a,b)=>a.seq-b.seq);
  let uploaded=0; for(let index=0;index<operations.length;index+=250){const batch=createBatch(operations.slice(index,index+250));await transport.putBatch(batch);uploaded+=batch.ops.length;setStatus(`Laddar upp startmaster · ${uploaded}/${operations.length}`)}
  await store.putMeta(BOOTSTRAP_META,{...pending,pending:false,uploaded_at:new Date().toISOString()}); return uploaded;
}

async function uploadBootstrapImages(transport) {
  const pending=await store.getMeta(IMAGE_BOOTSTRAP_META); if(!pending?.pending||!isSourceTree)return {total:0,uploaded:0,failures:[]};
  const response=await fetch(LOCAL_IMAGE_MANIFEST_URL,{cache:'no-store'}); if(!response.ok)throw new Error('Bildmanifestet kunde inte läsas');
  const manifest=await response.json();
  const completed=new Set(Array.isArray(pending.completed_paths)?pending.completed_paths:[]);
  const failures=[];
  let uploaded=0;
  for(const file of manifest.image_files){
    if(completed.has(file.dropbox_path))continue;
    try{
      const imageResponse=await fetch(`${LOCAL_IMAGE_BASE_URL}${encodeURIComponent(file.filename)}`,{cache:'no-store'});
      if(!imageResponse.ok)throw new Error(`Startbild saknas: ${file.filename}`);
      const blob=await imageResponse.blob();
      await uploadBlobWithRetry({transport,path:file.dropbox_path,blob});
      await store.putBlob(file.dropbox_path,blob);
      completed.add(file.dropbox_path);uploaded+=1;
      await store.putMeta(IMAGE_BOOTSTRAP_META,{...pending,pending:true,completed_paths:[...completed]});
      if(uploaded===1||uploaded%10===0)setStatus(`Laddar upp startbilder · ${completed.size}/${manifest.image_files.length}`);
    }catch(error){failures.push({path:file.dropbox_path,error,message:error?.message||String(error)})}
  }
  const done=completed.size===manifest.image_files.length;
  await store.putMeta(IMAGE_BOOTSTRAP_META,done
    ?{...pending,pending:false,completed_paths:[],failed_paths:[],image_count:completed.size,uploaded_at:new Date().toISOString()}
    :{...pending,pending:true,completed_paths:[...completed],failed_paths:failures.map(item=>item.path),last_attempt_at:new Date().toISOString()});
  return {total:manifest.image_files.length,uploaded,failures};
}

async function loadMatrikelPeople(token) {
  if(!token)return [];
  const transport=new DropboxTransport({accessToken:token,id:'dropbox-matrikel-read',opsRoot:'/matrikel/ops',readOnly:true});
  await matrikelMaster.sync(transport);
  applyMatrikelMaster();
  render(); return matrikelPeople;
}

function applyMatrikelMaster() {
  const list=type=>matrikelMaster.listEntities(type).map(entity=>({id:entity.entity_id,...entity.fields}));
  matrikelPeople=list('person').sort((a,b)=>a.display_name.localeCompare(b.display_name,'sv'));
  matrikelRelations=list('relation');
  matrikelFamilyUnits=list(FAMILY_UNIT_TYPE);
  matrikelKinGroups=list(KIN_GROUP_TYPE);
  matrikelContextRevision += 1;
}

async function loadLocalMatrikelContext() {
  if (!localPilotPreview) return false;
  const response = await fetch(LOCAL_MATRIKEL_CONTEXT_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Matrikelns pilotkopia kunde inte läsas (${response.status})`);
  const context = await response.json();
  if (context.context_version !== 1 || !Array.isArray(context.people)) throw new Error('Matrikelns pilotkopia har fel format');
  matrikelPeople = context.people.sort((a, b) => String(a.display_name || '').localeCompare(String(b.display_name || ''), 'sv'));
  matrikelRelations = Array.isArray(context.relations) ? context.relations : [];
  matrikelFamilyUnits = Array.isArray(context.family_units) ? context.family_units : [];
  matrikelKinGroups = Array.isArray(context.kin_groups) ? context.kin_groups : [];
  matrikelContextRevision += 1;
  return true;
}

async function loadOwnerReviewInventory() {
  if (!localPilotPreview || !requestedPilotId) return false;
  const url = `./privat/piloter/${encodeURIComponent(requestedPilotId)}/agarinventering.json`;
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Ägarinventeringen kunde inte läsas (${response.status})`);
  const inventory = await response.json();
  if (![1, 2].includes(inventory.inventory_version) || !Array.isArray(inventory.rows) || (inventory.inventory_version === 2 && !Array.isArray(inventory.structured_review_rows))) throw new Error('Ägarinventeringen har fel format');
  ownerReviewInventory = inventory;
  render();
  return true;
}

async function loadLocalSourceManifest() {
  if (!localPilotPreview || !requestedPilotId) return false;
  const url = `./privat/piloter/${encodeURIComponent(requestedPilotId)}/kallmanifest.json`;
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Källvisningen kunde inte läsas (${response.status})`);
  localSourceManifest = normalizeSourceViewManifest(await response.json(), requestedPilotId);
  sourceManifestRevision += 1;
  render();
  return true;
}

async function loadOwnerReviewDecisions() {
  if (!localPilotPreview || !requestedPilotId) return false;
  const stored = await store.getMeta(`${OWNER_REVIEW_META_PREFIX}${requestedPilotId}`);
  ownerReviewDocument = normalizeOwnerReviewDocument(stored, requestedPilotId);
  return true;
}

async function loadSpecReviewDecisions() {
  if (!localPilotPreview || !requestedPilotId) return false;
  const stored = await store.getMeta(`${SPEC_REVIEW_META_PREFIX}${requestedPilotId}`);
  specReviewDocument = normalizeSpecReviewDocument(stored, requestedPilotId);
  return true;
}

function downloadJson(filename, value) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function exportOwnerReviewChangeQueue() {
  try {
    const queue = buildOwnerChangeQueue({
      document: ownerReviewDocument,
      inventory: ownerReviewInventory,
      boats: boatRecords(),
      ownershipRecords: masterRecords('boat-ownership-observation'),
      sources: sourceRecords(),
    });
    if (!queue.decisions.length) throw new Error('Inga beslut är klara för införande');
    downloadJson(`batregister-agarkoe-${new Date().toISOString().slice(0, 10)}.json`, queue);
    setStatus(`${queue.decisions.length} beslut exporterade · mastern är ännu oförändrad`, 'ok');
  } catch (error) {
    setStatus(error.message, 'warning');
  }
}

function exportOwnerReviewBackup() {
  downloadJson(`batregister-agarbeslut-${new Date().toISOString().slice(0, 10)}.json`, ownerReviewDocument);
  setStatus('Lokal säkerhetskopia av granskningsbesluten hämtad', 'ok');
}

async function importOwnerReviewBackup(file) {
  if (!file) return;
  try {
    const imported = normalizeOwnerReviewDocument(JSON.parse(await file.text()), requestedPilotId);
    const count = Object.keys(imported.decisions).length;
    if (!confirm(`Ersätt den lokala beslutslistan med ${count} importerade beslut? Båtmastern påverkas inte.`)) return;
    await persistOwnerReviewDocument(imported);
    render();
    setStatus(`${count} granskningsbeslut importerade lokalt`, 'ok');
  } catch (error) {
    setStatus(`Importen avbröts · ${error.message}`, 'warning');
  } finally {
    $('#owner-review-import').value = '';
  }
}

async function syncNow() {
  if (batregisterV2Mode) return syncBatregisterV2();
  if(syncPromise)return syncPromise;
  syncPromise=(async()=>{
    const hasCredential=Boolean(await store.getMeta(TOKEN_META));
    if(navigator.onLine===false){setStatus(`Offline · ${hasCredential?'Dropbox ansluten · ':''}ändringar sparas lokalt`,'warning');connectButton.textContent=hasCredential?'Offline · Dropbox ansluten':'Anslut Dropbox när du är online';return null}
    const token=await currentAccessToken();
    if(!token){setStatus('Lokalt sparat · Dropbox ej ansluten','warning');connectButton.textContent='Anslut Dropbox';return null}
    connectButton.textContent='Synka Dropbox';setStatus('Synkar data…');
    const transport=generationOneTransport(token);
    let bootstrap=0;let bootstrapError=null;
    try{bootstrap=await uploadBootstrapOps(transport)}catch(error){bootstrapError=error;console.warn('Startmastern kunde inte laddas upp',error)}
    const result=await new SyncEngine({repository,transport}).syncOnce();
    await loadMatrikelPeople(token).catch(error=>console.warn('Matrikelns familjekontext kunde inte hämtas',error));
    render();

    let bootstrapImages={total:0,uploaded:0,failures:[]};
    try{bootstrapImages=await uploadBootstrapImages(transport)}catch(error){bootstrapImages.failures.push({error,message:error?.message||String(error)})}
    let queuedImages={total:0,uploaded:0,failures:[]};
    try{queuedImages=await uploadPendingImageBlobs({store,transport,onProgress:({uploaded,total})=>setStatus(`Synkad data · laddar upp bilder ${uploaded}/${total}`)})}
    catch(error){queuedImages.failures.push({error,message:error?.message||String(error)})}
    const cached=await cacheAllBoatImages(transport);
    render();
    const imageFailures=bootstrapImages.failures.length+queuedImages.failures.length+cached.failures.length;
    const warnings=imageFailures+(bootstrapError?1:0);
    const uploadedImages=bootstrapImages.uploaded+queuedImages.uploaded;
    const summary=`Synkad data · ${bootstrap+result.uploadedOps} upp, ${result.downloadedOps} ned · ${cached.total-cached.failures.length}/${cached.total} bilder offline${uploadedImages?` · ${uploadedImages} bilder upp`:''}`;
    setStatus(warnings?`${summary} · ${warnings} väntar på nytt försök`:summary,warnings?'warning':'ok');
    return {...result,imageUploads:queuedImages,imageBootstrap:bootstrapImages,imageCache:cached};
  })().catch(error=>{console.error(error);if(isOfflineError(error)){setStatus('Offline · lokalt sparat · synkas automatiskt när nätet återkommer','warning');return null}setStatus(`Åtgärd krävs · ${error.message}`,'error');throw error}).finally(()=>{syncPromise=null});
  return syncPromise;
}

function batregisterV2WriteTransport(token) {
  const root = '/batregister-generation2';
  return new DropboxTransport({
    accessToken: token,
    id: 'dropbox-batregister-generation2-write',
    opsRoot: `${root}/ops`,
    writeGuard: ({ path }) => {
      if (path !== root && !path.startsWith(`${root}/`)) throw new Error('Båtregistrets writer försökte skriva utanför sin egen namnrymd');
    },
  });
}

async function uploadBatregisterV2Image({ file, boat, writer }) {
  if (!file || !boat || !writer) throw new Error('Båt, bild eller writer saknas.');
  const prepared = await prepareImageForStorage(file);
  const hashBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', await prepared.blob.arrayBuffer()));
  const hash = [...hashBytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const path = `/batregister/bilder/${hash}.${prepared.extension}`;
  const token = await currentAccessToken();
  if (!token) throw new Error('Anslut Dropbox innan en bild sparas.');
  const imageTransport = new DropboxTransport({ accessToken: token, id: 'dropbox-batregister-v2-images', opsRoot: '/batregister/ops' });
  await uploadBlobWithRetry({ transport: imageTransport, path, blob: prepared.blob });
  await store.putBlob(path, prepared.blob);
  objectUrl(path, prepared.blob);
  const dimensions = prepared.width && prepared.height ? ` · ${prepared.width}×${prepared.height}px` : '';
  const images = [...(boat.images || []), {
    id: crypto.randomUUID(),
    thumb: { dropbox_path: path, sha256: hash },
    full: { dropbox_path: path, sha256: hash },
    source: `Uppladdad ${new Date().toISOString()}${prepared.resized ? ` · nedskalad${dimensions}` : ''}`,
  }];
  return writer.saveBoat(boat.id, { images }, { manualComment: 'Bild tillagd i Båtregistret' });
}

async function syncBatregisterV2() {
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    let localTransport = null;
    if (isSourceTree) {
      try {
        const response = await fetch('/batregister-generation2/active.json', { method: 'HEAD', cache: 'no-store' });
        if (response.ok) localTransport = new HttpReadTransport();
      } catch { /* Dropbox eller cache används i stället. */ }
    }
    const token = localTransport ? null : await currentAccessToken();
    if (!localTransport && !token) {
      batregisterV2Writer = null;
      batregisterV2Controller?.setWriter(null);
      if (batregisterV2Runtime.hasData()) {
        setStatus('Offline · senast verifierade Båtmaster visas', 'warning');
        return null;
      }
      setStatus('Anslut Dropbox för att läsa Båtmastern', 'warning');
      return null;
    }
    setStatus('Läser Båtmaster och Personmaster…');
    const readTransport = localTransport || new DropboxTransport({ accessToken: token, id: 'dropbox-batregister-generation2-read', opsRoot: '/batregister-generation2/ops', readOnly: true });
    const result = await batregisterV2Runtime.sync(readTransport);
    batregisterV2Writer = result.writable && token ? createBatregisterWriter({ transport: batregisterV2WriteTransport(token), pendingStore: store }) : null;
    if (batregisterV2Writer) await batregisterV2Writer.load();
    batregisterV2Controller.setWriter(batregisterV2Writer);
    if (token) {
      setStatus(`Båtmaster · revision ${result.boatRevision} · läser tidigare strukturerade uppgifter…`);
      try {
        await batregisterV2Runtime.syncLegacy(new DropboxTransport({ accessToken: token, id: 'dropbox-batregister-generation1-supplement', opsRoot: '/batregister/ops', readOnly: true }));
        batregisterV2Controller.render();
        if (batregisterV2Controller.selectedBoatId) batregisterV2Controller.open(batregisterV2Controller.selectedBoatId, { updateUrl: false });
      } catch (legacyError) {
        console.warn('Det äldre läskomplementet kunde inte uppdateras', legacyError);
      }
    }
    connectButton.textContent = token ? 'Synka Dropbox' : 'Anslut Dropbox';
    setStatus(`Båtmaster · revision ${result.boatRevision} · ${batregisterV2Writer ? 'skrivmaster' : result.writable ? 'anslut Dropbox för att skriva' : 'förhandsläge'}`, 'ok');
    return result;
  })().catch(error => {
    console.error(error);
    if (isOfflineError(error) && batregisterV2Runtime?.hasData()) {
      batregisterV2Controller?.render();
      setStatus('Offline · senast verifierade Båtmaster visas', 'warning');
      return null;
    }
    setStatus(`Åtgärd krävs · ${error.message}`, 'error');
    throw error;
  }).finally(() => { syncPromise = null; });
  return syncPromise;
}

async function activeBatregisterCutover(token) {
  const missing = { getJson: async () => { const error = new Error('saknas'); error.status = 409; error.code = 'path/not_found'; throw error; } };
  const transport = token ? new DropboxTransport({ accessToken: token, id: 'dropbox-batregister-cutover-detect', opsRoot: '/batregister/ops', readOnly: true }) : missing;
  const guard = new GenerationCutoverGuard({ app: 'batregister', transport, store });
  return token ? guard.refresh({ force: true }) : guard.cachedMarker();
}

async function localBatregisterV2Available() {
  if (!isSourceTree) return false;
  try { return (await fetch('/batregister-generation2/active.json', { method: 'HEAD', cache: 'no-store' })).ok; }
  catch { return false; }
}

async function initBatregisterV2Mode() {
  batregisterV2Mode = true;
  bootstrapButton.hidden = true;
  document.documentElement.dataset.batregisterV2 = 'true';
  document.querySelector('.site-header .intro').textContent = 'Båtar, ägare och strukturerad tidslinje.';
  batregisterV2Runtime = await createBatregisterActiveRuntime({ store }).init();
  batregisterV2Controller = createBatregisterV2Controller({
    runtime: batregisterV2Runtime,
    content,
    drawer,
    drawerContent,
    backdrop,
    statusNode,
    renderImage: imageMarkup,
    renderGallery: drawerGalleryMarkup,
    hydrateImages,
    uploadImage: uploadBatregisterV2Image,
    onSaved: async () => {
      const token = await currentAccessToken();
      if (!token) throw new Error('Revisionen sparades, men återläsning väntar tills Dropbox är ansluten.');
      await batregisterV2Runtime.sync(new DropboxTransport({ accessToken: token, id: 'dropbox-batregister-generation2-after-save', opsRoot: '/batregister-generation2/ops', readOnly: true }));
      await batregisterV2Writer.load();
    },
  });
  batregisterV2Controller.configureShell();
  if (batregisterV2Runtime.hasData()) batregisterV2Controller.render();
  await syncBatregisterV2();
  const requested = new URL(location.href).searchParams.get('boat');
  if (requested) batregisterV2Controller.open(requested, { updateUrl: false });
}

async function connectDropbox() {
  sessionStorage.setItem('korpholmen:oauth-return',new URL('batregister/',redirectUri()).pathname);
  const attempt=await beginDropboxOAuth({clientId:DROPBOX_CLIENT_ID,redirectUri:redirectUri(),scopes:DROPBOX_SCOPES});location.assign(attempt.url);
}
async function connectOrSyncDropbox(){return await currentAccessToken()?syncNow():connectDropbox()}

async function bootstrapLocal({ preview = false } = {}) {
  if(!isSourceTree)throw new Error('Startkopian kan bara aktiveras från källappen');
  const response=await fetch(LOCAL_BOOTSTRAP_URL,{cache:'no-store'});if(!response.ok)throw new Error(`Startkopian kunde inte läsas (${response.status})`);
  const document=await response.json();if(document.operations_version!==1||!Array.isArray(document.operations))throw new Error('Startkopian har fel format');document.operations.forEach(validateOperation);
  await repository.applyRemoteOps(document.operations);
  if(!preview){
    await store.putMeta(BOOTSTRAP_META,{pending:true,device_id:document.device_id,migration_id:document.migration_id,operations:document.operations.length});
    await store.putMeta(IMAGE_BOOTSTRAP_META,{pending:true,migration_id:document.migration_id});
  }
  bootstrapButton.hidden=true;render();setStatus(preview?'Pilotdata laddad lokalt · ingen Dropbox-synk':'Startmaster aktiverad lokalt · anslut Dropbox för uppladdning','ok');
}

content.addEventListener('click',event=>{if(batregisterV2Mode){const target=event.target.closest('[data-v2-boat]');if(target)batregisterV2Controller.open(target.dataset.v2Boat);return}const target=event.target.closest('[data-boat-id]');if(target)openDrawer(target.dataset.boatId)});
backdrop.addEventListener('click',closeDrawer);
drawer.addEventListener('click',event=>{
  if(event.target.closest('[data-action="close"]'))return closeDrawer();
  if(batregisterV2Mode){
    if(event.target.closest('[data-v2-edit-boat]'))return batregisterV2Controller.openBoatEditor(batregisterV2Runtime.getBoat(batregisterV2Controller.selectedBoatId));
    if(event.target.closest('[data-v2-new-event]'))return batregisterV2Controller.openEventEditor();
    const eventButton=event.target.closest('[data-v2-edit-event]');
    if(eventButton){const boat=batregisterV2Runtime.getBoat(batregisterV2Controller.selectedBoatId);return batregisterV2Controller.openEventEditor((boat.events||[]).find(row=>row.id===eventButton.dataset.v2EditEvent))}
    return;
  }
  const sourceButton=event.target.closest('[data-view-source]');if(sourceButton)return openSourceViewer(sourceButton.dataset.viewSource);
  if(event.target.closest('[data-action="review-select-target"]'))return selectReviewComposerTarget();
  if(event.target.closest('[data-action="review-add-coowner"]'))return addReviewComposerCoowner();
  const candidateButton=event.target.closest('[data-review-candidate-person]');if(candidateButton)return selectReviewCandidate(candidateButton.dataset.reviewCandidatePerson);
  const removeReviewTarget=event.target.closest('[data-review-remove-target]');if(removeReviewTarget)return removeReviewComposerTarget(removeReviewTarget.dataset.reviewRemoveTarget);
  if(event.target.closest('[data-action="review-add-proposal"]'))return addReviewProposal();
  const removeReviewProposalButton=event.target.closest('[data-action="review-remove-proposal"]');if(removeReviewProposalButton)return removeReviewProposal(removeReviewProposalButton.closest('[data-review-proposal-id]')?.dataset.reviewProposalId);
  if(event.target.closest('[data-action="review-save-draft"]'))return saveReviewDecision('draft');
  if(event.target.closest('[data-action="review-needs-research"]'))return saveReviewDecision('needs_research');
  if(event.target.closest('[data-action="review-ready"]'))return saveReviewDecision('ready');
  if(event.target.closest('[data-action="review-clear"]'))return clearReviewDecision();
  if(event.target.closest('[data-action="toggle-edit"]')){drawerEditMode=!drawerEditMode;renderDrawer(selectedBoatId);return}
  if(event.target.closest('[data-action="save-spec-draft"]'))return saveSpecReview('draft');
  if(event.target.closest('[data-action="save-spec-ready"]'))return saveSpecReview('ready');
  if(event.target.closest('[data-action="clear-spec-review"]'))return clearSpecReview();
  if(event.target.closest('[data-action="export-spec-queue"]'))return exportSpecReviewChangeQueue();
  const remove=event.target.closest('[data-delete-link]');if(remove)return deleteLink(remove.dataset.linkType,remove.dataset.deleteLink);
  const saveOwner=event.target.closest('[data-action="save-owner"]');if(saveOwner)return saveOwnership(saveOwner);
  const deleteOwner=event.target.closest('[data-action="delete-owner"]');if(deleteOwner)return deleteOwnership(deleteOwner);
  if(event.target.closest('[data-action="add-owner"]'))return addOwnership();
  if(event.target.closest('[data-action="add-link"]'))return addRelationLink();
  if(event.target.closest('[data-action="delete-boat"]'))return deleteBoat();
  if(event.target.closest('[data-action="refresh-people"]'))return currentAccessToken().then(loadMatrikelPeople);
});
drawer.addEventListener('change',event=>{if(batregisterV2Mode){if(event.target.id==='v2-image-upload')batregisterV2Controller.handleImage(event.target.files?.[0]).catch(error=>setStatus(`Bilden kunde inte sparas · ${error.message}`,'error'));return}const field=event.target.closest('[data-boat-field]');if(field)syncEdit(()=>repository.setField('boat',selectedBoatId,field.dataset.boatField,parseField(field)));if(event.target.id==='image-upload')uploadImage(event.target.files?.[0]).catch(error=>setStatus(`Bilden kunde inte sparas · ${error.message}`,'error'))});
const renderSearch = debounce(render, 120);
const renderConnectionSearch = debounce(() => {
  if (connectionFilterSearch.value.trim()) renderConnectionSearchResults();
  else renderConnectionBrowseResults();
}, 100);
$('#search').addEventListener('input',event=>{ui.search=event.target.value;renderSearch()});
connectionFilterSearch.addEventListener('focus',()=>connectionFilterSearch.value.trim() && !ui.connection ? renderConnectionSearchResults() : renderConnectionBrowseResults());
connectionFilterSearch.addEventListener('input',()=>{
  if (ui.connection) {
    ui.connection = '';
    connectionFilter.value = '';
    connectionFilterClear.hidden = true;
  }
  connectionSearchActiveIndex = 0;
  renderConnectionSearch();
});
connectionFilterSearch.addEventListener('keydown',event=>{
  let options=[...connectionFilterResults.querySelectorAll('[data-connection-person],[data-connection-value]')];
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){
    event.preventDefault();
    if(connectionFilterResults.hidden){renderConnectionSearchResults();options=[...connectionFilterResults.querySelectorAll('[data-connection-person],[data-connection-value]')]}
    const direction=event.key==='ArrowDown'?1:-1;
    connectionSearchActiveIndex=Math.max(0,Math.min(options.length-1,connectionSearchActiveIndex+direction));
    renderConnectionSearchResults();
  }else if(event.key==='Enter'&&connectionSearchActiveIndex>=0){
    event.preventDefault();
    connectionFilterResults.querySelectorAll('[data-connection-person],[data-connection-value]')[connectionSearchActiveIndex]?.click();
  }else if(event.key==='Escape')closeConnectionSearch();
});
connectionFilterResults.addEventListener('mousedown',event=>{if(event.target.closest('[data-connection-person],[data-connection-value],[data-connection-close],[data-connection-back]'))event.preventDefault()});
connectionFilterResults.addEventListener('click',event=>{
  if(event.target.closest('[data-connection-close]'))return closeConnectionSearch();
  if(event.target.closest('[data-connection-back]'))return renderConnectionSearchResults();
  const person=event.target.closest('[data-connection-person]');
  if(person)return renderPersonScopeResults(person.dataset.connectionPerson);
  const option=event.target.closest('[data-connection-value]');
  if(option)selectConnectionFilter(option.dataset.connectionValue,option.dataset.connectionLabel);
});
connectionFilterBrowse.addEventListener('click',()=>connectionFilterResults.hidden||connectionPanelMode!=='browse'?renderConnectionBrowseResults():closeConnectionSearch());
connectionFilterClear.addEventListener('click',()=>selectConnectionFilter('',''));
document.addEventListener('click',event=>{if(!event.target.closest('.connection-search-field'))closeConnectionSearch()});
$('#type-options').addEventListener('click',event=>{const button=event.target.closest('[data-type-filter]');if(button){if(batregisterV2Mode)return batregisterV2Controller.setFilter('category',button.dataset.typeFilter);ui.type=button.dataset.typeFilter;render()}});
$('#pilot-options').addEventListener('click',event=>{const button=event.target.closest('[data-pilot-filter]');if(button){ui.pilot=button.dataset.pilotFilter;updatePilotUrl(ui.pilot);render()}});
$('#image-options').addEventListener('click',event=>{const button=event.target.closest('[data-image-status]');if(button){if(batregisterV2Mode)return batregisterV2Controller.setFilter('image',button.dataset.imageStatus);ui.imageStatus=button.dataset.imageStatus;render()}});
$('#name-options').addEventListener('click',event=>{const button=event.target.closest('[data-name-status]');if(button){ui.nameStatus=button.dataset.nameStatus;render()}});
$('#quality-options').addEventListener('click',event=>{const button=event.target.closest('[data-quality-filter]');if(button){const filter=button.dataset.qualityFilter;if(ui.qualityFilters.has(filter))ui.qualityFilters.delete(filter);else ui.qualityFilters.add(filter);render()}});
$('#group-options').addEventListener('click',event=>{const button=event.target.closest('[data-grouping]');if(button){ui.grouping=button.dataset.grouping;closeOptionsPanels();render()}});
$('#layout-options').addEventListener('click',event=>{const button=event.target.closest('[data-layout]');if(button){ui.layout=button.dataset.layout;closeOptionsPanels();render()}});
$('#filter-panel-toggle').addEventListener('click',()=>openOptionsPanel(filterPanel));
$('#view-panel-toggle').addEventListener('click',()=>openOptionsPanel(viewPanel));
$('#owner-review-toggle').addEventListener('click',()=>setOwnerReviewOpen(!ownerReviewOpen));
$('#owner-review-close').addEventListener('click',()=>setOwnerReviewOpen(false));
$('#owner-review-search').addEventListener('input',event=>{ownerReviewSearch=event.target.value;renderOwnerReview()});
$('#owner-review-class').addEventListener('change',event=>{ownerReviewClassification=event.target.value;renderOwnerReview()});
$('#owner-review-status').addEventListener('change',event=>{ownerReviewStatus=event.target.value;ownerReviewClassification='';renderOwnerReview()});
$('#owner-review-export-ready').addEventListener('click',exportOwnerReviewChangeQueue);
$('#owner-review-export-backup').addEventListener('click',exportOwnerReviewBackup);
$('#owner-review-import-button').addEventListener('click',()=>$('#owner-review-import').click());
$('#owner-review-import').addEventListener('change',event=>importOwnerReviewBackup(event.target.files?.[0]));
$('#owner-review-batch-toggle').addEventListener('click',()=>{ownerReviewBatchMode=!ownerReviewBatchMode;if(!ownerReviewBatchMode)ownerReviewBatchSelection.clear();renderOwnerReview()});
$('#owner-review-batch-clear').addEventListener('click',()=>{ownerReviewBatchSelection.clear();renderOwnerReview()});
$('#owner-review-batch-open').addEventListener('click',openOwnerBatchDialog);
$('#owner-review-list').addEventListener('click',event=>{const sourceButton=event.target.closest('[data-view-source]');if(sourceButton)return openSourceViewer(sourceButton.dataset.viewSource);const button=event.target.closest('[data-owner-review-boat]');if(button)openDrawer(button.dataset.ownerReviewBoat,{reviewDecision:button.dataset.ownerReviewMode==='decision'})});
$('#owner-review-list').addEventListener('change',event=>{const input=event.target.closest('[data-owner-review-select]');if(!input)return;if(input.checked)ownerReviewBatchSelection.add(input.dataset.ownerReviewSelect);else ownerReviewBatchSelection.delete(input.dataset.ownerReviewSelect);renderOwnerReview()});
sourceViewer.addEventListener('click',event=>{if(event.target===sourceViewer||event.target.closest('[data-action="close-source-viewer"]'))return closeSourceViewer();const artifactButton=event.target.closest('[data-source-artifact-index]');if(artifactButton)renderSourceArtifact(sourceViewer.dataset.sourceId,Number(artifactButton.dataset.sourceArtifactIndex)).catch(error=>{sourceViewerBody.innerHTML=`<p>Källan kunde inte visas: ${escapeHtml(error.message)}</p>`})});
ownerBatchDialog.addEventListener('click',event=>{if(event.target===ownerBatchDialog||event.target.closest('[data-action="close-owner-batch"]'))return closeOwnerBatchDialog();const sourceButton=event.target.closest('[data-view-source]');if(sourceButton&&sourceButton.dataset.viewSource)return openSourceViewer(sourceButton.dataset.viewSource);if(event.target.closest('[data-action="save-owner-batch"]'))return saveOwnerBatch()});
ownerBatchDialog.addEventListener('change',event=>{const select=event.target.closest('[data-owner-batch-source]');if(!select)return;const button=select.parentElement.querySelector('[data-view-source]');button.dataset.viewSource=select.value;button.hidden=!select.value});
document.querySelectorAll('[data-close-panel]').forEach(button=>button.addEventListener('click',closeOptionsPanels));
panelBackdrop.addEventListener('click',closeOptionsPanels);
function clearFilter(key) {
  if(batregisterV2Mode){
    if(key==='all'||key==='search'){$('#search').value=''}
    if(key==='all'||key==='type')batregisterV2Controller.category='';
    if(key==='all'||key==='image')batregisterV2Controller.imageStatus='';
    batregisterV2Controller.render();
    return;
  }
  if(key==='all'||key==='search'){ui.search='';$('#search').value=''}
  if(key==='all'||key==='connection'){ui.connection='';connectionFilter.value='';connectionFilterSearch.value=''}
  if(key==='all'||key==='type')ui.type='';
  if(key==='all'||key==='image')ui.imageStatus='';
  if(key==='all'||key==='name')ui.nameStatus='';
  if(key==='all')ui.qualityFilters.clear();
  if(key.startsWith('quality:'))ui.qualityFilters.delete(key.slice('quality:'.length));
  if(key==='all'||key==='pilot'){ui.pilot='';updatePilotUrl('')}
  closeConnectionSearch();
  render();
}
$('#active-filters').addEventListener('click',event=>{const button=event.target.closest('[data-clear-filter]');if(button)clearFilter(button.dataset.clearFilter)});
$('#clear-all-filters').addEventListener('click',()=>{clearFilter('all');closeOptionsPanels()});
$('#add-boat').addEventListener('click',()=>batregisterV2Mode?batregisterV2Controller.openBoatEditor():addBoat());connectButton.addEventListener('click',()=>connectOrSyncDropbox().catch(()=>{}));bootstrapButton.addEventListener('click',()=>bootstrapLocal({preview:localPilotPreview}).catch(error=>setStatus(error.message,'error')));
document.addEventListener('keydown',event=>{if(event.key==='Escape'){if(sourceViewer.open)return closeSourceViewer();if(ownerBatchDialog.open)return closeOwnerBatchDialog();if(ownerReviewOpen&&drawer.getAttribute('aria-hidden')==='true')setOwnerReviewOpen(false);else closeDrawer();closeConnectionSearch();closeOptionsPanels()}});window.addEventListener('online',()=>syncNow().catch(()=>{}));window.addEventListener('offline',()=>syncNow().catch(()=>{}));window.addEventListener('korpholmen:dropbox-ready',()=>syncNow().catch(()=>{}));document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')syncNow().catch(()=>{})});
window.addEventListener('pagehide',()=>{for(const url of imageUrls.values())URL.revokeObjectURL(url);imageUrls.clear()});

async function init(){
  const serviceWorkerPromise=registerServiceWorker();
  const db=await openSlaktlandskapDB({name:'korpholmen-batregister',onBlocked:()=>setStatus('En annan Båtregister-flik blockerar uppdateringen · stäng den och ladda om','warning')});
  store=new IndexedDBStore(db);
  await completeOAuthCallbackIfNeeded();
  const parameters=new URL(location.href).searchParams;
  const token=await currentAccessToken();
  const cutover=await activeBatregisterCutover(token);
  if(cutover?.state==='active'||await localBatregisterV2Available()||(isSourceTree&&parameters.get('boatmaster')==='next')){
    await initBatregisterV2Mode();
    await serviceWorkerPromise;
    return;
  }
  repository=await new Repository({store,deviceId:await deviceId()}).init();
  matrikelMaster=await new ReadOnlyMaster({store,cacheKey:'matrikel'}).init();
  applyMatrikelMaster();
  if(localPilotPreview){
    connectButton.hidden=true;
    $('#add-boat').hidden=true;
    setStatus('Laddar pilotdata…');
    try{await bootstrapLocal({preview:true})}catch(error){bootstrapButton.hidden=false;setStatus(`Pilotdata kunde inte laddas · ${error.message}`,'error')}
    if(boatRecords().length){
      await loadLocalMatrikelContext().catch(error=>console.warn(error.message));
      await loadLocalSourceManifest().catch(error=>console.warn(error.message));
      await loadOwnerReviewDecisions().catch(error=>console.warn(error.message));
      await loadSpecReviewDecisions().catch(error=>console.warn(error.message));
      await loadOwnerReviewInventory().catch(error=>console.warn(error.message));
    }
  }
  bootstrapButton.hidden=!isSourceTree||boatRecords().length>0;
  if(requestedBoatId&&boatRecords().some(boat=>boat.id===requestedBoatId))selectedBoatId=requestedBoatId;
  render();
  if(!localPilotPreview){await syncNow()}
  else if(boatRecords().length)setStatus('Förhandsvisning · pilotdata laddad lokalt','ok');
  await serviceWorkerPromise;
}
init().catch(error=>{console.error(error);setStatus(`Kunde inte starta · ${error.message}`,'error')});
