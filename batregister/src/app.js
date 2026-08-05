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
} from '../core/data-layer.js';
import { ReadOnlyMaster } from '../core/read-only-master.js';
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
} from '../core/family-context.js?v=2026-08-05-paket-3';
import {
  boatMatchesConnection,
  connectionTargetForValue,
  connectionTargetValue,
  personScopeTargets,
  searchPeopleForConnection,
} from './connection-filter.js?v=2026-08-05-paket-3';
import {
  DROPBOX_CLIENT_ID,
  DROPBOX_SCOPES,
  LOCAL_BOOTSTRAP_URL,
  LOCAL_IMAGE_BASE_URL,
  LOCAL_IMAGE_MANIFEST_URL,
} from './config.js';

const $ = selector => document.querySelector(selector);
const content = $('#content');
const drawer = $('#boat-drawer');
const drawerContent = $('#drawer-content');
const backdrop = $('#backdrop');
const statusNode = $('#sync-status');
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
const isSourceTree = location.pathname.includes('/apps/batregister/');
const TOKEN_META = 'dropbox:refresh-token';
const BOOTSTRAP_META = 'bootstrap:batregister-2026-08-01';
const IMAGE_BOOTSTRAP_META = 'bootstrap:batregister-images-2026-08-01';
const imageUrls = new Map();
const imageLoads = new Map();

let store;
let repository;
let matrikelMaster;
let accessToken = null;
let accessTokenExpiresAt = 0;
let syncPromise = null;
let selectedBoatId = null;
let matrikelPeople = [];
let matrikelRelations = [];
let matrikelFamilyUnits = [];
let matrikelKinGroups = [];
let connectionSearchActiveIndex = -1;
let connectionPanelMode = 'browse';
let matrikelContextRevision = 0;
const viewCache = createRevisionCache(() => `${repository?.revision || 0}:${matrikelContextRevision}`);

const requestedPersonId = new URL(location.href).searchParams.get('person') || '';
const requestedBoatId = new URL(location.href).searchParams.get('boat') || '';
const ui = {
  search: '',
  type: '',
  connection: requestedPersonId ? `person:${requestedPersonId}` : '',
  nameStatus: '',
  imageStatus: '',
  grouping: 'none',
  layout: 'grid',
};
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

const deviceId = () => resolveDeviceId({ store, key: 'korpholmen:batregister-device-id', prefix: 'bat-web-' });

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
function boatRecords() { return viewCache('boats', () => repository.listEntities('boat').map(entity => ({ id: entity.entity_id, ...entity.fields })).sort((a,b)=>String(a.namn).localeCompare(String(b.namn),'sv'))); }
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
  return [...linksForBoat(boatId).map(personNameForLink), ...linkedFamilyNames(boatId), ...linkedGroupNames(boatId)].filter(Boolean);
}

function boatMatchesConnectionTarget(boat, value = ui.connection) {
  if (!value) return true;
  if (value.startsWith('legacy:')) return [boat.slakt, ...linkedFamilyNames(boat.id)].includes(value.slice('legacy:'.length));
  return boatMatchesConnection({
    boat,
    value,
    context: matrikelFamilyContext(),
    personLinks: linksForBoat(boat.id),
    groupLinks: groupLinksForBoat(boat.id),
    legacyFamilyLabels: [boat.slakt, ...linkedFamilyNames(boat.id)],
  });
}

function filteredBoats() {
  const query = normalize(ui.search);
  return boatRecords().filter(boat => {
    if (ui.type && boat.typ !== ui.type) return false;
    if (!boatMatchesConnectionTarget(boat)) return false;
    if (ui.nameStatus && boat.namnstatus !== ui.nameStatus) return false;
    if (ui.imageStatus === 'with' && !(boat.images || []).length) return false;
    if (ui.imageStatus === 'without' && (boat.images || []).length) return false;
    if (query && !normalize([boat.namn, boat.dopnamn, boat.modell, boat.agare, boat.motor, boat.slakt, boat.island_connection, ...linkedNames(boat.id), ...(boat.kallor_text || [])].join(' ')).includes(query)) return false;
    return true;
  });
}

function era(boat) {
  const year = Number(boat.ar || boat.dopar);
  if (!year) return 'År okänt';
  return `${Math.floor(year / 10) * 10}-talet`;
}

function groupBoats(boats) {
  const key = ui.grouping === 'family' ? boat => [...linkedGroupNames(boat.id), ...linkedFamilyNames(boat.id)].join(' / ') || boat.slakt || 'Övriga och okända'
    : ui.grouping === 'type' ? boat => boat.typ || 'Typ okänd'
      : ui.grouping === 'era' ? era : () => 'Alla båtar';
  const groups = new Map();
  for (const boat of boats) { const label = key(boat); if (!groups.has(label)) groups.set(label, []); groups.get(label).push(boat); }
  return [...groups.entries()].sort(([a],[b])=>a.localeCompare(b,'sv'));
}

function imageRef(boat, role = 'thumb') {
  const image = boat.images?.[0];
  if (!image) return null;
  return image[role] || image.full || image.thumb || null;
}

function imageMarkup(boat) {
  const ref = imageRef(boat, 'thumb');
  if (!ref) return '<div class="image-placeholder">Bild saknas</div>';
  const local = isSourceTree && ref.filename ? `${LOCAL_IMAGE_BASE_URL}${encodeURIComponent(ref.filename)}` : '';
  const cached = imageUrls.get(ref.dropbox_path);
  const source = local || cached || '';
  return `<img class="boat-image" alt="${escapeHtml(boat.namn || 'Båt')}" ${source ? `src="${escapeHtml(source)}"` : ''} data-image-path="${escapeHtml(ref.dropbox_path || '')}" style="${boat.images?.[0]?.focus ? `object-position:${escapeHtml(boat.images[0].focus)}` : ''}">`;
}

function card(boat) {
  const links = linksForBoat(boat.id);
  const familyLinks = familyLinksForBoat(boat.id);
  const groupLinks = groupLinksForBoat(boat.id);
  const connectionCount = links.length + familyLinks.length + groupLinks.length;
  return `<button class="boat-card" type="button" data-boat-id="${escapeHtml(boat.id)}">
    ${imageMarkup(boat)}${connectionCount ? `<span class="linked-count">${connectionCount} koppl.</span>` : ''}
    <span class="boat-copy"><h3>${escapeHtml(boat.namn || 'Namn okänt')}</h3>
      <p>${escapeHtml([boat.modell, boat.ar].filter(Boolean).join(' · ') || 'Modell och år saknas')}</p>
      <p>${escapeHtml(boat.agare || 'Ägare/anknytning saknas')}</p>
      <span class="chips">${boat.typ ? `<span class="chip">${escapeHtml(boat.typ)}</span>` : ''}${boat.slakt ? `<span class="chip">${escapeHtml(boat.slakt)}</span>` : ''}${groupLinks.map(link=>`<span class="chip family-chip">${escapeHtml(groupLinkLabel(link))}</span>`).join('')}${familyLinks.map(link=>`<span class="chip family-chip">${escapeHtml(link.family_name)}</span>`).join('')}${boat.island_connection ? `<span class="chip context-chip">${escapeHtml(boat.island_connection)}</span>` : ''}${boat.namnstatus === 'dopnamn' ? '<span class="chip warn">Endast dopnamn</span>' : ''}</span>
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

function objectUrl(path, blob) {
  let url = imageUrls.get(path);
  if (!url && blob) {
    url = URL.createObjectURL(blob);
    imageUrls.set(path, url);
  }
  return url || '';
}

async function hydrateImages(scope = document) {
  if (isSourceTree) return;
  const nodes = [...scope.querySelectorAll('img[data-image-path]')].filter(node => node.dataset.imagePath && !node.src);
  const transport = accessToken && navigator.onLine !== false
    ? new DropboxTransport({ accessToken, id: 'dropbox-batregister-images', opsRoot: '/batregister/ops' })
    : null;
  await mapConcurrent(nodes, 6, async node => {
    const path = node.dataset.imagePath;
    try {
      const blob = await cachedBlob(path, transport);
      if (blob && node.isConnected) node.src = objectUrl(path, blob);
    } catch (error) {
      if (!isOfflineError(error)) node.alt = `Bild kunde inte hämtas: ${error.message}`;
    }
  });
}

function allImagePaths() {
  return unique(boatRecords().flatMap(boat => (boat.images || []).flatMap(image => [image.thumb?.dropbox_path, image.full?.dropbox_path])));
}

async function cacheAllBoatImages(transport) {
  const paths = allImagePaths();
  let downloaded = 0;
  await mapConcurrent(paths, 4, async path => {
    if (await store.getBlob(path)) return;
    await cachedBlob(path, transport);
    downloaded += 1;
    if (downloaded === 1 || downloaded % 10 === 0) setStatus(`Säkrar bilder för offline-läge · ${downloaded}/${paths.length}`);
  });
  return { total: paths.length, downloaded };
}

async function uploadPendingImages(transport) {
  const pending = await store.listPendingBlobs();
  let uploaded = 0;
  for (const entry of pending) {
    await transport.putBlobImmutable(entry.key, entry.value);
    await store.markBlobUploaded(entry.key);
    uploaded += 1;
  }
  return uploaded;
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
  if (ui.search) chips.push(['search', `Båtsökning · ${ui.search}`]);
  if (ui.connection) chips.push(['connection', connectionFilterLabel(selectedConnection)]);
  if (ui.type) chips.push(['type', `Båttyp · ${ui.type}`]);
  if (ui.imageStatus) chips.push(['image', ui.imageStatus === 'with' ? 'Med bild' : 'Utan bild']);
  if (ui.nameStatus) chips.push(['name', ui.nameStatus === 'namn' ? 'Känt namn' : 'Endast dopnamn']);
  $('#active-filters').innerHTML = chips.map(([key, label]) => `<button class="active-filter-chip" type="button" data-clear-filter="${key}">${escapeHtml(label)}</button>`).join('')
    + (chips.length > 1 ? '<button class="clear-filter-chip" type="button" data-clear-filter="all">Rensa alla</button>' : '');
  $('#clear-all-filters').disabled = !chips.length;
}

function render() {
  const all = boatRecords();
  const typeCounts = new Map();
  for (const boat of all) if (boat.typ) typeCounts.set(boat.typ, (typeCounts.get(boat.typ) || 0) + 1);
  const types = [...typeCounts.keys()].sort((a, b) => a.localeCompare(b, 'sv'));
  $('#type-options').innerHTML = `<button type="button" data-type-filter="" aria-pressed="${!ui.type}">Alla <small>${all.length}</small></button>${types.map(type => `<button type="button" data-type-filter="${escapeHtml(type)}" aria-pressed="${ui.type === type}">${escapeHtml(type)} <small>${typeCounts.get(type)}</small></button>`).join('')}`;
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
  for (const button of document.querySelectorAll('[data-grouping]')) button.setAttribute('aria-pressed', String(button.dataset.grouping === ui.grouping));
  for (const button of document.querySelectorAll('[data-layout]')) button.setAttribute('aria-pressed', String(button.dataset.layout === ui.layout));
  const hiddenFilterCount = [ui.type, ui.imageStatus, ui.nameStatus].filter(Boolean).length;
  const filterBadge = $('#filter-badge');
  filterBadge.hidden = !hiddenFilterCount;
  filterBadge.textContent = hiddenFilterCount || '';
  renderActiveFilters(selectedConnection);
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

function renderDrawer(id) {
  const boat = boatRecords().find(item => item.id === id);
  if (!boat) return closeDrawer();
  const links = linksForBoat(id);
  const familyLinks = familyLinksForBoat(id);
  const groupLinks = groupLinksForBoat(id);
  const families = familyRecords();
  const context = matrikelFamilyContext();
  const relationChoices = relationLinkChoices(context);
  const fullRef = imageRef(boat, 'full');
  const local = isSourceTree && fullRef?.filename ? `${LOCAL_IMAGE_BASE_URL}${encodeURIComponent(fullRef.filename)}` : '';
  const cached = fullRef?.dropbox_path ? imageUrls.get(fullRef.dropbox_path) : '';
  const image = fullRef ? `<img class="drawer-image" alt="${escapeHtml(boat.namn)}" ${local || cached ? `src="${escapeHtml(local || cached)}"` : ''} data-image-path="${escapeHtml(fullRef.dropbox_path || '')}">` : '';
  drawerContent.innerHTML = `<h2 class="drawer-title">${escapeHtml(boat.namn || 'Namn okänt')}</h2>${image}
    <div class="edit-grid">
      ${textField('Namn','namn',boat.namn)}
      <label>Namnstatus<select data-boat-field="namnstatus"><option value="namn" ${boat.namnstatus==='namn'?'selected':''}>Känt namn</option><option value="dopnamn" ${boat.namnstatus==='dopnamn'?'selected':''}>Endast dopnamn</option></select></label>
      ${textField('Dopnamn','dopnamn',boat.dopnamn)}${textField('Önskat namn','onskat_namn',boat.onskat_namn)}
      ${textField('Typ','typ',boat.typ)}${textField('Modell','modell',boat.modell)}
      ${numberField('År','ar',boat.ar)}${numberField('Längd (m)','langd_m',boat.langd_m,'0.1')}
      ${textField('Motor','motor',boat.motor)}${textField('Historisk släkt/grupp','slakt',boat.slakt)}
      ${textField('Period','period',boat.period,'span-2')}${textField('Ägare/anknytning','agare',boat.agare,'span-2')}
      ${textField('Tidigare namn, kommaseparerade','tidigare_namn',(boat.tidigare_namn||[]).join(', '),'span-2')}
      ${textField('Senare namn, kommaseparerade','senare_namn',(boat.senare_namn||[]).join(', '),'span-2')}
    </div>
    <section class="drawer-section"><h3>Kopplingar till Matrikeln</h3><p class="section-help">Koppla till person när en bestämd ägare eller brukare är känd. FAMILJ och SLÄKT används när båten hör till en större gemenskap. Ärftlig synlighet visas som »via« och är inte personligt ägande.</p>
      <div class="link-list">
        ${links.map(link=>`<div class="link-row"><span><a href="../matrikel/?person=${encodeURIComponent(link.person_id)}"><b>${escapeHtml(personNameForLink(link))}</b></a><br><small>Person · ${escapeHtml(link.role || '')}</small></span><button type="button" data-delete-link="${escapeHtml(link.id)}" data-link-type="boat-person-link">Ta bort</button></div>`).join('')}
        ${groupLinks.map(link=>{const target=canonicalGroupTarget(link,context);const targetId=target?.id||link.target_id;const targetType=target?.entity_type||link.target_type;const members=targetMemberDetails({type:targetType,id:targetId},context);const inherited=members.filter(member=>member.generation>1).length;return `<div class="link-row family-row"><span><a href="../matrikel/?group=${encodeURIComponent(targetId)}"><b>${escapeHtml(groupLinkLabel(link,context))}</b></a><br><small>${escapeHtml(targetTypeLabel(targetType))} · ${escapeHtml(link.role || '')} · ${members.length} personer${inherited?` · ${inherited} visas via gruppen`:''}</small></span><button type="button" data-delete-link="${escapeHtml(link.id)}" data-link-type="boat-group-link">Ta bort</button></div>`}).join('')}
        ${familyLinks.map(link=>{const family=families.find(item=>item.id===link.family_id);const members=family?familyMembers(family):[];return `<div class="link-row family-row"><span><b>${escapeHtml(link.family_name || link.family_id)}</b><br><small>Familjegren · ${escapeHtml(link.role || '')}${members.length?` · ${escapeHtml(members.map(person=>person.display_name).join(', '))}`:''}</small></span><button type="button" data-delete-link="${escapeHtml(link.id)}" data-link-type="boat-family-link">Ta bort</button></div>`}).join('')}
        ${links.length || familyLinks.length || groupLinks.length ? '' : '<p>Ingen person, familj eller släkt är kopplad ännu.</p>'}
      </div>
      <label class="full-field">Lägg till koppling<input id="relation-link-search" list="relation-link-options" autocomplete="off" placeholder="Sök person, FAMILJ eller SLÄKT …"><datalist id="relation-link-options">${relationChoices.map(choice=>`<option value="${escapeHtml(choice.label)}"></option>`).join('')}</datalist></label>
      <label class="full-field">Roll<input id="relation-link-role" value="ägare/anknuten"></label>
      <div class="button-row"><button class="secondary" type="button" data-action="add-link">Lägg till koppling</button><button class="secondary" type="button" data-action="refresh-people">Hämta personer från Matrikeln</button></div>
    </section>
    <section class="drawer-section"><h3>Bilder</h3><p>${(boat.images||[]).length} bildposter. Nya bilder lagras privat i Dropbox.</p><input id="image-upload" type="file" accept="image/*"><div class="button-row"><button class="danger" type="button" data-action="delete-boat">Ta bort båten</button></div></section>`;
  drawer.setAttribute('aria-hidden','false'); backdrop.hidden=false;
  hydrateImages(drawer);
}

function openDrawer(id) { selectedBoatId=id; renderDrawer(id); }
function closeDrawer() { selectedBoatId=null; drawer.setAttribute('aria-hidden','true'); backdrop.hidden=true; drawerContent.innerHTML=''; }

function parseField(target) {
  const field = target.dataset.boatField;
  if (['ar','dopar'].includes(field)) return target.value ? Number(target.value) : null;
  if (field === 'langd_m') return target.value ? Number(target.value.replace(',','.')) : null;
  if (['tidigare_namn','senare_namn','smeknamn'].includes(field)) return target.value.split(',').map(value=>value.trim()).filter(Boolean);
  return target.value.trim() || null;
}

async function syncEdit(action) {
  await action(); render();
  try { await syncNow(); } catch (_) { setStatus('Sparat lokalt · synk kräver åtgärd','warning'); }
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
  await syncEdit(()=>repository.deleteEntities([...links.map(link=>({entityType:'boat-person-link',entityId:link.id})),...familyLinks.map(link=>({entityType:'boat-family-link',entityId:link.id})),...groupLinks.map(link=>({entityType:'boat-group-link',entityId:link.id})),{entityType:'boat',entityId:boat.id}]));
  closeDrawer();
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

async function deleteLink(type,id) { await syncEdit(()=>repository.deleteEntity(type,id)); }

async function uploadImage(file) {
  if (!file || !selectedBoatId) return;
  const hashBytes=new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()));
  const hash=[...hashBytes].map(byte=>byte.toString(16).padStart(2,'0')).join('');
  const extension=(file.type.split('/')[1]||'bin').replace('jpeg','jpg');
  const path=`/batregister/bilder/${hash}.${extension}`;
  await store.putBlob(path,file,{pendingUpload:true});
  objectUrl(path,file);
  const boat=boatRecords().find(item=>item.id===selectedBoatId);
  const images=[...(boat.images||[]),{id:crypto.randomUUID(),thumb:{dropbox_path:path,sha256:hash},full:{dropbox_path:path,sha256:hash},source:`Uppladdad ${new Date().toISOString()}`}];
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
  const pending=await store.getMeta(IMAGE_BOOTSTRAP_META); if(!pending?.pending||!isSourceTree)return 0;
  const response=await fetch(LOCAL_IMAGE_MANIFEST_URL,{cache:'no-store'}); if(!response.ok)throw new Error('Bildmanifestet kunde inte läsas');
  const manifest=await response.json(); let uploaded=0;
  for(const file of manifest.image_files){const imageResponse=await fetch(`${LOCAL_IMAGE_BASE_URL}${encodeURIComponent(file.filename)}`,{cache:'no-store'});if(!imageResponse.ok)throw new Error(`Startbild saknas: ${file.filename}`);const blob=await imageResponse.blob();await transport.putBlobImmutable(file.dropbox_path,blob);await store.putBlob(file.dropbox_path,blob);uploaded+=1;if(uploaded%10===0)setStatus(`Laddar upp startbilder · ${uploaded}/${manifest.image_files.length}`)}
  await store.putMeta(IMAGE_BOOTSTRAP_META,{...pending,pending:false,uploaded_at:new Date().toISOString()}); return uploaded;
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

async function syncNow() {
  if(syncPromise)return syncPromise;
  syncPromise=(async()=>{const hasCredential=Boolean(await store.getMeta(TOKEN_META));if(navigator.onLine===false){setStatus(`Offline · ${hasCredential?'Dropbox ansluten · ':''}ändringar sparas lokalt`,'warning');connectButton.textContent=hasCredential?'Offline · Dropbox ansluten':'Anslut Dropbox när du är online';return null}const token=await currentAccessToken();if(!token){setStatus('Lokalt sparat · Dropbox ej ansluten','warning');connectButton.textContent='Anslut Dropbox';return null}
    connectButton.textContent='Synka Dropbox';setStatus('Synkar…');const transport=new DropboxTransport({accessToken:token,id:'dropbox-batregister',opsRoot:'/batregister/ops'});
    const images=await uploadBootstrapImages(transport);const bootstrap=await uploadBootstrapOps(transport);const queuedImages=await uploadPendingImages(transport);const result=await new SyncEngine({repository,transport}).syncOnce();
    const cached=await cacheAllBoatImages(transport);render();
    await loadMatrikelPeople(token).catch(error=>console.warn('Matrikelns familjekontext kunde inte hämtas',error));
    setStatus(`Synkad · ${bootstrap+result.uploadedOps} upp, ${result.downloadedOps} ned · ${cached.total} bilder offline${images+queuedImages?` · ${images+queuedImages} bilder upp`:''}`,'ok');return result})().catch(error=>{console.error(error);if(isOfflineError(error)){setStatus('Offline · lokalt sparat · synkas automatiskt när nätet återkommer','warning');return null}setStatus(`Åtgärd krävs · ${error.message}`,'error');throw error}).finally(()=>{syncPromise=null});
  return syncPromise;
}

async function connectDropbox() {
  sessionStorage.setItem('korpholmen:oauth-return',new URL('batregister/',redirectUri()).pathname);
  const attempt=await beginDropboxOAuth({clientId:DROPBOX_CLIENT_ID,redirectUri:redirectUri(),scopes:DROPBOX_SCOPES});location.assign(attempt.url);
}
async function connectOrSyncDropbox(){return await currentAccessToken()?syncNow():connectDropbox()}

async function bootstrapLocal() {
  if(!isSourceTree)throw new Error('Startkopian kan bara aktiveras från källappen');
  const response=await fetch(LOCAL_BOOTSTRAP_URL,{cache:'no-store'});if(!response.ok)throw new Error(`Startkopian kunde inte läsas (${response.status})`);
  const document=await response.json();if(document.operations_version!==1||!Array.isArray(document.operations))throw new Error('Startkopian har fel format');document.operations.forEach(validateOperation);
  await repository.applyRemoteOps(document.operations);
  await store.putMeta(BOOTSTRAP_META,{pending:true,device_id:document.device_id,migration_id:document.migration_id,operations:document.operations.length});
  await store.putMeta(IMAGE_BOOTSTRAP_META,{pending:true,migration_id:document.migration_id});bootstrapButton.hidden=true;render();setStatus('Startmaster aktiverad lokalt · anslut Dropbox för uppladdning','ok');
}

content.addEventListener('click',event=>{const target=event.target.closest('[data-boat-id]');if(target)openDrawer(target.dataset.boatId)});
backdrop.addEventListener('click',closeDrawer);
drawer.addEventListener('click',event=>{if(event.target.closest('[data-action="close"]'))closeDrawer();const remove=event.target.closest('[data-delete-link]');if(remove)deleteLink(remove.dataset.linkType,remove.dataset.deleteLink);if(event.target.closest('[data-action="add-link"]'))addRelationLink();if(event.target.closest('[data-action="delete-boat"]'))deleteBoat();if(event.target.closest('[data-action="refresh-people"]'))currentAccessToken().then(loadMatrikelPeople)});
drawer.addEventListener('change',event=>{const field=event.target.closest('[data-boat-field]');if(field)syncEdit(()=>repository.setField('boat',selectedBoatId,field.dataset.boatField,parseField(field)));if(event.target.id==='image-upload')uploadImage(event.target.files?.[0]).catch(error=>setStatus(`Bilden kunde inte sparas · ${error.message}`,'error'))});
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
$('#type-options').addEventListener('click',event=>{const button=event.target.closest('[data-type-filter]');if(button){ui.type=button.dataset.typeFilter;render()}});
$('#image-options').addEventListener('click',event=>{const button=event.target.closest('[data-image-status]');if(button){ui.imageStatus=button.dataset.imageStatus;render()}});
$('#name-options').addEventListener('click',event=>{const button=event.target.closest('[data-name-status]');if(button){ui.nameStatus=button.dataset.nameStatus;render()}});
$('#group-options').addEventListener('click',event=>{const button=event.target.closest('[data-grouping]');if(button){ui.grouping=button.dataset.grouping;closeOptionsPanels();render()}});
$('#layout-options').addEventListener('click',event=>{const button=event.target.closest('[data-layout]');if(button){ui.layout=button.dataset.layout;closeOptionsPanels();render()}});
$('#filter-panel-toggle').addEventListener('click',()=>openOptionsPanel(filterPanel));
$('#view-panel-toggle').addEventListener('click',()=>openOptionsPanel(viewPanel));
document.querySelectorAll('[data-close-panel]').forEach(button=>button.addEventListener('click',closeOptionsPanels));
panelBackdrop.addEventListener('click',closeOptionsPanels);
function clearFilter(key) {
  if(key==='all'||key==='search'){ui.search='';$('#search').value=''}
  if(key==='all'||key==='connection'){ui.connection='';connectionFilter.value='';connectionFilterSearch.value=''}
  if(key==='all'||key==='type')ui.type='';
  if(key==='all'||key==='image')ui.imageStatus='';
  if(key==='all'||key==='name')ui.nameStatus='';
  closeConnectionSearch();
  render();
}
$('#active-filters').addEventListener('click',event=>{const button=event.target.closest('[data-clear-filter]');if(button)clearFilter(button.dataset.clearFilter)});
$('#clear-all-filters').addEventListener('click',()=>{clearFilter('all');closeOptionsPanels()});
$('#add-boat').addEventListener('click',addBoat);connectButton.addEventListener('click',()=>connectOrSyncDropbox().catch(()=>{}));bootstrapButton.addEventListener('click',()=>bootstrapLocal().catch(error=>setStatus(error.message,'error')));
document.addEventListener('keydown',event=>{if(event.key==='Escape'){closeDrawer();closeConnectionSearch();closeOptionsPanels()}});window.addEventListener('online',()=>syncNow().catch(()=>{}));window.addEventListener('offline',()=>syncNow().catch(()=>{}));document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')syncNow().catch(()=>{})});

async function init(){const serviceWorkerPromise=registerServiceWorker();const db=await openSlaktlandskapDB({name:'korpholmen-batregister'});store=new IndexedDBStore(db);repository=await new Repository({store,deviceId:await deviceId()}).init();matrikelMaster=await new ReadOnlyMaster({store,cacheKey:'matrikel'}).init();applyMatrikelMaster();bootstrapButton.hidden=!isSourceTree||boatRecords().length>0;if(requestedBoatId&&boatRecords().some(boat=>boat.id===requestedBoatId))selectedBoatId=requestedBoatId;render();await completeOAuthCallbackIfNeeded();await syncNow();await serviceWorkerPromise}
init().catch(error=>{console.error(error);setStatus(`Kunde inte starta · ${error.message}`,'error')});
