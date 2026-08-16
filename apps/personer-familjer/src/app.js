import {
  DropboxTransport,
  IndexedDBStore,
  Repository,
  SyncEngine,
  beginDropboxOAuth,
  completeDropboxOAuth,
  createBatch,
  debounce,
  isOfflineError,
  openSlaktlandskapDB,
  registerKorpholmenServiceWorker,
  resolveDeviceId,
  validateOperation,
} from './data-layer.js?v=2026-08-02-3';
import { propertyLinkEntityId, relationEntityId } from './domain/slakt-schema.js?v=2026-08-01-10';
import {
  buildGraph,
  clanBase,
  clanDetail,
  componentSets,
  familyCircleLabel,
  familyHue,
  familyStemLabel,
  generationFor,
  groupPeople,
  groupPeopleByProperty,
  lineageIds,
  membership,
  nearFamily,
  normalizeText,
  personPropertyIds,
  relationDescription,
  relationshipPath,
  resolvedIslands,
  shownName,
  visiblePersonIds,
} from './landscape-model.js?v=2026-08-01-12';
import {
  FAMILY_UNIT_TYPE,
  KIN_GROUP_KINDS,
  KIN_GROUP_TYPE,
  MEMBERSHIP_RULES,
  buildFamilyContext,
  displayReference,
  familyUnitMemberDetails,
  groupsForPerson,
  isConfirmed,
  kinGroupMemberDetails,
  nextReferenceCode,
  relativeGenerationLabel,
  wouldCreateParentChildCycle,
} from '../../../packages/core/family-context.js?v=2026-08-05-paket-3';
import { resolvePropertyIslandNames, resolvePropertyReferences } from '../../../packages/core/master-data.js?v=2026-08-07-master-integrations';
import { ReadOnlyMaster } from '../../../packages/core/read-only-master.js?v=2026-08-06-property-owner-display';
import { HttpReadTransport } from '../../../packages/core/sync/http-read-transport.js?v=2026-08-15-active-v2';
import { DropboxTransport as ActiveDropboxTransport } from '../../../packages/core/sync/dropbox-transport.js?v=2026-08-16-person-v2-transport-1';
import { DROPBOX_CLIENT_ID, DROPBOX_SCOPES, LOCAL_APPROVED_DATA_URL, LOCAL_BOOTSTRAP_URL, LOCAL_EXTERNAL_PROPERTY_OWNERS_URL, LOCAL_FAMILY_MODEL_URL, LOCAL_UI_METADATA_URL } from './config.js?v=2026-08-04-personmaster';
import { exchangeDropboxRefreshToken } from './sync/oauth-pkce.js?v=2026-08-01-10';
import { createPeopleV2Runtime } from './people-v2-runtime.js?v=2026-08-15-active-v2';
import { createPeopleV2Controller } from './people-v2-ui.js?v=2026-08-15-active-v2';

const $ = (selector) => document.querySelector(selector);
const statusNode = $('#sync-status');
const undoNode = $('#undo-status');
const editStatusNode = $('#edit-status');
const contentNode = $('#content');
const connectButton = $('#connect-dropbox');
const bootstrapButton = $('#bootstrap-local');
const familyModelButton = $('#family-model-local');
const drawer = $('#person-drawer');
const drawerContent = $('#drawer-content');
const personSearch = $('#person-search');
const clanJump = $('#clan-jump');
const islandFilter = $('#island-filter');
const livingFilter = $('#living-filter');
const propertyFilter = $('#property-filter');
const generationButtons = $('#generation-buttons');
const relationPathNode = $('#relation-path');
const filterPanel = $('#filter-panel');
const filterBackdrop = $('#filter-backdrop');
const filterToggle = $('#filter-panel-toggle');
const relationToggle = $('#relation-panel-toggle');
const relationTools = $('#relation-tools');
const activeFiltersNode = $('#active-filters');
const isSourceTree = location.pathname.includes('/apps/personer-familjer/');
const TOKEN_META = 'dropbox:refresh-token-v1';
const BOOTSTRAP_META = 'bootstrap:migration-2026-08-01';
const LEGACY_MIGRATION_META = 'migration:legacy-ops-to-matrikel-v1';
const FAMILY_MODEL_META = 'migration:familjemodell-2026-08-02';
const MATRIKEL_OPS_ROOT = '/matrikel/ops';
const LEGACY_OPS_ROOT = '/ops';

let repository;
let store;
let fastigheterMaster;
let kartdataMaster;
let accessToken = null;
let accessTokenExpiresAt = 0;
let syncPromise = null;
let graph = null;
let currentPeople = [];
let currentRelations = [];
let currentProperties = [];
let currentPropertyLinks = [];
let currentFamilyUnits = [];
let currentKinGroups = [];
let refreshedRepositoryRevision = -1;
let familyContext = null;
let propertyById = new Map();
let requestedPersonApplied = false;
let requestedGroupApplied = false;
let filterReturnFocus = null;
let peopleV2Mode = true;
let peopleV2Runtime = null;
let peopleV2Controller = null;

const ui = {
  selectedPersonId: null,
  selectedGroup: null,
  clubNamesFirst: false,
  showGaps: false,
  island: '',
  living: '',
  property: '',
  generations: new Set(),
  includeInlaws: true,
  onlyUnlinked: false,
  yearOn: false,
  year: new Date().getFullYear(),
  view: 'groups',
  review: false,
  pathIds: new Set(),
};

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const escapeAttribute = escapeHtml;
const unique = (items) => [...new Set(items)];
const slug = (value) => normalizeText(value).replace(/\s+/g, '-') || 'grupp';

async function registerServiceWorker() {
  try {
    return await registerKorpholmenServiceWorker({ sourceTree: isSourceTree });
  } catch (error) {
    console.warn('Appskalet kunde inte uppdateras', error);
    return null;
  }
}

function setStatus(text, tone = '') {
  statusNode.textContent = text;
  statusNode.dataset.tone = tone;
}

function setUndoStatus(text, tone = '') {
  undoNode.hidden = !text;
  undoNode.textContent = text;
  undoNode.dataset.tone = tone;
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
      try { await syncNow(); } catch (_) { /* Lokalt återställd. */ }
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

function setEditStatus(text, tone = '') {
  editStatusNode.textContent = text;
  editStatusNode.dataset.tone = tone;
}

function redirectUri() {
  return new URL(isSourceTree ? '../../' : '../', location.href).href;
}

const deviceId = () => resolveDeviceId({ store, key: 'slaktlandskap:device-id', prefix: 'slakt-web-' });

function personRecords() {
  return repository.listEntities('person')
    .map((entity) => ({ id: entity.entity_id, ...entity.fields }))
    .sort((a, b) => shownName(a).localeCompare(shownName(b), 'sv'));
}

function relationRecords() {
  return repository.listEntities('relation')
    .map((entity) => ({ id: entity.entity_id, ...entity.fields }));
}

function propertyRecords() {
  const fallbacks = repository.listEntities('property')
    .map((entity) => ({ id: entity.entity_id, external_id: entity.entity_id, ...entity.fields }));
  return resolvePropertyReferences(
    fastigheterMaster,
    fallbacks,
    null,
    { includeOwnerLabel: false },
  )
    .map((property) => {
      const id = property.external_id || property.id;
      const islandNames = resolvePropertyIslandNames(id, kartdataMaster, { fallback: [property.island] });
      return { ...property, id, display_name: id, island: islandNames.join(' / '), island_names: islandNames };
    })
    .sort((a, b) => a.id.localeCompare(b.id, 'sv', { numeric: true }));
}

function propertyLinkRecords() {
  return repository.listEntities('property-link')
    .map((entity) => ({ id: entity.entity_id, ...entity.fields }));
}

function familyUnitRecords() {
  return repository.listEntities(FAMILY_UNIT_TYPE)
    .map(entity => ({ id: entity.entity_id, ...entity.fields }))
    .sort((a, b) => String(a.reference_code).localeCompare(String(b.reference_code), 'sv', { numeric: true }));
}

function kinGroupRecords() {
  return repository.listEntities(KIN_GROUP_TYPE)
    .map(entity => ({ id: entity.entity_id, ...entity.fields }))
    .sort((a, b) => String(a.reference_code).localeCompare(String(b.reference_code), 'sv', { numeric: true }));
}

function refreshData() {
  if (refreshedRepositoryRevision === repository.revision) return;
  const people = personRecords();
  currentRelations = relationRecords();
  currentProperties = propertyRecords();
  currentPropertyLinks = propertyLinkRecords();
  currentFamilyUnits = familyUnitRecords();
  currentKinGroups = kinGroupRecords();
  propertyById = new Map(currentProperties.map((property) => [property.id, property]));
  const linksByPerson = new Map();
  for (const link of currentPropertyLinks) {
    if (!linksByPerson.has(link.person_id)) linksByPerson.set(link.person_id, []);
    linksByPerson.get(link.person_id).push(link);
  }
  currentPeople = people.map((person) => {
    const links = (linksByPerson.get(person.id) || []).filter((link) => propertyById.has(link.property_id));
    const propertyIds = links.map((link) => link.property_id);
    return {
      ...person,
      property_ids: propertyIds,
      property_islands: unique(propertyIds.map((propertyId) => propertyById.get(propertyId)?.island).filter(Boolean)),
    };
  });
  graph = buildGraph(currentPeople, currentRelations);
  familyContext = buildFamilyContext({
    people: currentPeople,
    relations: currentRelations,
    familyUnits: currentFamilyUnits,
    kinGroups: currentKinGroups,
    properties: currentProperties,
    propertyLinks: currentPropertyLinks,
  });
  if (!requestedPersonApplied) {
    const requestedPersonId = new URL(location.href).searchParams.get('person');
    if (requestedPersonId && graph.byId.has(requestedPersonId)) ui.selectedPersonId = requestedPersonId;
    if (requestedPersonId && graph.byId.has(requestedPersonId)) requestedPersonApplied = true;
  }
  if (!requestedGroupApplied) {
    const requestedGroupId = new URL(location.href).searchParams.get('group');
    const family = currentFamilyUnits.find(entry => entry.id === requestedGroupId);
    const kin = currentKinGroups.find(entry => entry.id === requestedGroupId);
    if (family || kin) {
      ui.selectedGroup = { entityType: family ? FAMILY_UNIT_TYPE : KIN_GROUP_TYPE, id: requestedGroupId };
      ui.view = 'groups';
      requestedGroupApplied = true;
    }
  }
  if (ui.selectedPersonId && !graph.byId.has(ui.selectedPersonId)) ui.selectedPersonId = null;
  if (ui.selectedGroup) {
    const records = ui.selectedGroup.entityType === FAMILY_UNIT_TYPE ? currentFamilyUnits : currentKinGroups;
    if (!records.some(group => group.id === ui.selectedGroup.id)) ui.selectedGroup = null;
  }
  refreshedRepositoryRevision = repository.revision;
}

function propertyNames(person) {
  return personPropertyIds(person).map((propertyId) => propertyById.get(propertyId)?.display_name || propertyId);
}

function islandNames(person) {
  return resolvedIslands(person);
}

function islandPropertyConflict(person) {
  const propertyIslands = Array.isArray(person.property_islands) ? person.property_islands.filter(Boolean) : [];
  return Boolean(person.legacy_island && propertyIslands.length && !propertyIslands.includes(person.legacy_island));
}

function years(person) {
  if (person.birth && person.death) return `${person.birth}–${String(person.death).slice(0, 4)}`;
  if (person.birth) return `f. ${person.birth}`;
  if (person.death) return `d. ${String(person.death).slice(0, 4)}`;
  return 'år okänt';
}

function familyColor(person) {
  if (person.ui_color === 'stam') return 'hsl(38 20% 55%)';
  if (Number.isFinite(Number(person.ui_color))) return `hsl(${Number(person.ui_color)} 60% 45%)`;
  return `hsl(${familyHue(person.family)} 42% 46%)`;
}

function personLabel(person) {
  return `${person.display_name}${person.birth ? ` (f. ${person.birth})` : ''} · ${person.family || 'utan släktgrupp'}`;
}

function lookupPerson(text) {
  const query = normalizeText(text);
  if (!query) return null;
  let matches = currentPeople.filter((person) => normalizeText(personLabel(person)) === query);
  if (matches.length !== 1) {
    matches = currentPeople.filter((person) => [
      person.display_name,
      person.full_name,
      person.birth_name,
      person.club_name,
      person.ui_constructed_club_name,
      ...(Array.isArray(person.aliases) ? person.aliases : []),
    ].some((value) => normalizeText(value) === query));
  }
  if (matches.length !== 1) {
    matches = currentPeople.filter((person) => normalizeText(person.display_name).includes(query));
  }
  return matches.length === 1 ? matches[0] : null;
}

function refreshControls() {
  const labels = currentPeople.map((person) => `<option value="${escapeAttribute(personLabel(person))}"></option>`).join('');
  $('#person-options').innerHTML = labels;
  $('#drawer-person-options').innerHTML = labels;

  const selectedClan = clanJump.value;
  const groups = groupPeople(currentPeople);
  clanJump.innerHTML = '<option value="">Välj släktkrets …</option>' + groups
    .map((group) => `<option value="${escapeAttribute(group.name)}">${escapeHtml(familyCircleLabel(group.name))}</option>`).join('');
  if (groups.some((group) => group.name === selectedClan)) clanJump.value = selectedClan;
  clanJump.disabled = ui.view !== 'kinship';
  generationButtons.closest('.generation-filter').hidden = ui.view !== 'kinship';
  $('.kinship-filter').hidden = ui.view !== 'kinship';

  const islands = unique(currentPeople.flatMap(islandNames)).sort((a, b) => a.localeCompare(b, 'sv'));
  islandFilter.innerHTML = '<option value="">Alla öar</option>' + islands
    .map((island) => `<option value="${escapeAttribute(island)}">${escapeHtml(island)}</option>`).join('');
  islandFilter.value = islands.includes(ui.island) ? ui.island : '';

  livingFilter.value = ui.living;
  const propertyCounts = new Map(currentProperties.map((property) => [property.id, 0]));
  let withoutProperty = 0;
  for (const person of currentPeople) {
    const propertyIds = personPropertyIds(person);
    if (!propertyIds.length) withoutProperty += 1;
    for (const propertyId of propertyIds) propertyCounts.set(propertyId, (propertyCounts.get(propertyId) || 0) + 1);
  }
  propertyFilter.innerHTML = '<option value="">Alla fastigheter</option>'
    + currentProperties.map((property) => `<option value="${escapeAttribute(property.id)}">${escapeHtml(property.display_name)} · ${propertyCounts.get(property.id) || 0}</option>`).join('')
    + `<option value="__none__">Utan fastighet · ${withoutProperty}</option>`;
  propertyFilter.value = ui.property && (ui.property === '__none__' || propertyById.has(ui.property)) ? ui.property : '';

  const generations = unique(currentPeople.map((person) => generationFor(person) ?? 'okand'))
    .sort((a, b) => String(a).localeCompare(String(b), 'sv', { numeric: true }));
  generationButtons.innerHTML = `<button type="button" class="generation-button" data-generation="all" aria-pressed="${ui.generations.size ? 'false' : 'true'}">Alla</button>`
    + generations.map((generation) => `<button type="button" class="generation-button" data-generation="${generation}" aria-pressed="${ui.generations.has(String(generation))}">${generation === 'okand' ? 'Okänd' : generation}</button>`).join('');
}

function relevantGap(person) {
  return !(graph.parents.get(person.id) || []).length
    && generationFor(person) !== 1
    && person.ui_generation_source !== 'gifte'
    && person.membership_status !== 'ej';
}

function cardClasses(person, relatedIds) {
  return [
    'person-card',
    `living-${person.living || 'okänt'}`,
    relevantGap(person) ? 'has-gap' : '',
    ui.selectedPersonId === person.id ? 'is-selected' : '',
    relatedIds.has(person.id) && ui.selectedPersonId !== person.id ? 'is-related' : '',
    ui.pathIds.has(person.id) ? 'is-path' : '',
  ].filter(Boolean).join(' ');
}

function renderPersonCard(person, relatedIds) {
  const member = membership(person);
  const club = person.club_name || person.ui_constructed_club_name || '';
  const primary = shownName(person, ui.clubNamesFirst);
  const secondary = ui.clubNamesFirst && club ? person.display_name : club;
  const generation = generationFor(person);
  const livingLabel = person.living === 'ja' ? 'Levande' : person.living === 'nej' ? 'Avliden' : 'Livsstatus okänd';
  const livingMark = person.living === 'nej' ? '<span class="living-mark" title="Avliden">†</span>' : person.living === 'okänt' || !person.living ? '<span class="living-mark unknown" title="Livsstatus okänd">?</span>' : '';
  const approximate = generation && person.ui_generation_source !== 'kedja' && person.ui_generation_source !== 'gifte';
  return `<button type="button" class="${cardClasses(person, relatedIds)}" data-person-id="${escapeAttribute(person.id)}" style="--family-accent:${familyColor(person)}" aria-label="${escapeAttribute(`${primary}. ${livingLabel}. ${member.label}. Generation ${generation ?? 'okänd'}. Familj ${person.family || 'okänd'}.`)}">
    <span class="family-name">${escapeHtml(person.family || 'utan familjegrupp')}</span>
    <span class="name-line"><span class="member-symbol ${member.className}" aria-hidden="true">${member.symbol}</span><span class="primary-name">${escapeHtml(primary)}</span><span class="gap-mark" aria-label="Relevant föräldrakoppling saknas">⚑</span></span>
    <span class="meta-line"><span class="secondary-name">${escapeHtml(secondary || ' ')}</span><span class="years">${escapeHtml(years(person))}</span>${livingMark}${approximate ? '<span class="provenance" title="Generation uppskattad">≈</span>' : ''}</span>
  </button>`;
}

function renderBranch(id, component, visited, visible, relatedIds, uncertain = false) {
  if (visited.has(id)) return '';
  const person = graph.byId.get(id);
  if (!person) return '';
  visited.add(id);
  const partnerLinks = (graph.partners.get(id) || [])
    .filter((link) => component.has(link.id) && !visited.has(link.id))
    .sort((a, b) => (a.relation.kind === 'tidigare') - (b.relation.kind === 'tidigare') || shownName(graph.byId.get(a.id)).localeCompare(shownName(graph.byId.get(b.id)), 'sv'));
  partnerLinks.forEach((link) => visited.add(link.id));
  const householdIds = [id, ...partnerLinks.map((link) => link.id)];
  const childIds = unique(householdIds.flatMap((personId) => (graph.children.get(personId) || []).map((link) => link.id)))
    .filter((childId) => component.has(childId) && !visited.has(childId))
    .sort((a, b) => (generationFor(graph.byId.get(a)) ?? 99) - (generationFor(graph.byId.get(b)) ?? 99) || shownName(graph.byId.get(a)).localeCompare(shownName(graph.byId.get(b)), 'sv'));
  const childHtml = childIds.map((childId) => {
    const links = currentRelations.filter((relation) => relation.kind === 'foralder-barn' && relation.to_person_id === childId && householdIds.includes(relation.from_person_id));
    const isUncertain = links.some((relation) => !isConfirmed(relation.user_confirmed));
    return renderBranch(childId, component, visited, visible, relatedIds, isUncertain);
  }).join('');
  const visibleHousehold = householdIds.filter((personId) => visible.has(personId));
  if (!visibleHousehold.length && !childHtml) return '';

  let row;
  if (!visibleHousehold.length) {
    const names = householdIds.map((personId) => shownName(graph.byId.get(personId))).filter(Boolean);
    row = `<button type="button" class="bridge-row" data-person-id="${escapeAttribute(id)}">via ${escapeHtml(names.join(' och '))} · ${names.length > 1 ? 'dolda' : 'dold'} av filtret</button>`;
  } else {
    row = `<div class="couple-row">
      ${visible.has(id) ? renderPersonCard(person, relatedIds) : `<button type="button" class="bridge-chip" data-person-id="${escapeAttribute(id)}">via ${escapeHtml(shownName(person))} · dold</button>`}
      ${partnerLinks.map((link) => {
        const partner = graph.byId.get(link.id);
        const previous = link.relation.kind === 'tidigare';
        const coparent = link.relation.kind === 'coparent';
        const marker = `<span class="partner-mark ${previous ? 'previous' : coparent ? 'coparent' : ''}" aria-label="${previous ? 'Tidigare partner' : coparent ? 'Har barn tillsammans' : 'Partner'}">${previous ? 'förr' : coparent ? '+' : '—'}</span>`;
        return marker + (visible.has(link.id) ? renderPersonCard(partner, relatedIds) : `<button type="button" class="bridge-chip" data-person-id="${escapeAttribute(link.id)}">via ${escapeHtml(shownName(partner))} · dold</button>`);
      }).join('')}
    </div>`;
  }
  return `<div class="tree-node ${uncertain ? 'uncertain' : ''}">${row}${childHtml ? `<div class="children">${childHtml}</div>` : ''}</div>`;
}

function renderComponent(component, visible, relatedIds) {
  const visited = new Set();
  const roots = [...component]
    .map((id) => graph.byId.get(id))
    .filter(Boolean)
    .filter((person) => !(graph.parents.get(person.id) || []).some((link) => component.has(link.id)))
    .sort((a, b) => (generationFor(a) ?? 99) - (generationFor(b) ?? 99) || shownName(a).localeCompare(shownName(b), 'sv'));
  const html = [];
  for (const root of roots) if (!visited.has(root.id)) html.push(renderBranch(root.id, component, visited, visible, relatedIds));
  for (const id of component) if (!visited.has(id)) html.push(renderBranch(id, component, visited, visible, relatedIds));
  return `<div class="component">${html.join('')}</div>`;
}

function renderFamilyStem(name, people, visible, relatedIds) {
  const visiblePeople = people.filter((person) => visible.has(person.id));
  if (!visiblePeople.length) return '';
  const families = unique(visiblePeople.map((person) => person.family || 'utan familjegrupp')).sort((a, b) => a.localeCompare(b, 'sv'));
  const stem = familyStemLabel(name);
  const components = componentSets(people, currentRelations);
  const connected = components.filter((component) => component.size > 1 && [...component].some((id) => visible.has(id)));
  const isolated = components.filter((component) => component.size === 1)
    .flatMap((component) => [...component])
    .filter((id) => visible.has(id))
    .map((id) => graph.byId.get(id))
    .filter(Boolean)
    .sort((a, b) => shownName(a).localeCompare(shownName(b), 'sv'));
  return `<section class="family-stem">
    <div class="family-stem-header"><div><p class="section-kicker">${stem ? 'Stamfamilj' : 'Familjegrupp'}</p><h3>${escapeHtml(stem || clanDetail(name))}</h3></div><div class="family-list">${visiblePeople.length} personer · familjegrenar: ${escapeHtml(families.join(' · '))}</div></div>
    <div class="forest">${connected.map((component) => renderComponent(component, visible, relatedIds)).join('') || '<p class="empty-note">Inga belagda relationer inom gruppen.</p>'}</div>
    ${isolated.length ? `<section class="unlinked"><h4>Ännu inte kopplade till en bestämd släktgren · ${isolated.length}</h4><div class="unlinked-grid">${isolated.map((person) => renderPersonCard(person, relatedIds)).join('')}</div></section>` : ''}
  </section>`;
}

function confirmationBadge(value) {
  return isConfirmed(value)
    ? '<span class="confirmation confirmed">Bekräftad</span>'
    : '<span class="confirmation unconfirmed">Ej bekräftad</span>';
}

function memberButtons(details, limit = 10) {
  const shown = details.slice(0, limit).map(member => {
    const person = familyContext.peopleById.get(member.person_id);
    if (!person) return '';
    return `<button type="button" class="group-person ${member.confirmed ? '' : 'unconfirmed'}" data-person-id="${escapeAttribute(person.id)}" title="${escapeAttribute(relativeGenerationLabel(member, { name: 'gruppen' }))}">${escapeHtml(person.display_name)}${member.generation > 1 ? ` · led ${member.generation}` : ''}</button>`;
  }).join('');
  return `${shown}${details.length > limit ? `<span class="more-members">+ ${details.length - limit} till</span>` : ''}`;
}

function countNoun(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function renderFamilyUnitCard(group, visible) {
  const members = familyUnitMemberDetails(group, familyContext);
  if (members.length && !members.some(member => visible.has(member.person_id))) return '';
  const confirmedMembers = members.filter(member => member.confirmed).length;
  const anchorCount = (group.anchor_person_ids || []).filter(id => familyContext.peopleById.has(id)).length;
  return `<article class="family-unit-card">
    <button type="button" class="group-card-heading" data-group-type="${FAMILY_UNIT_TYPE}" data-group-id="${escapeAttribute(group.id)}">
      <span><small>${escapeHtml(group.reference_code || 'FAMILJ')}</small><b>${escapeHtml(group.name || 'Namnlös familj')}</b></span>${confirmationBadge(group.confirmed)}
    </button>
    <p>${countNoun(anchorCount, 'ankarperson', 'ankarpersoner')} · ${countNoun(members.length, 'person i familjen', 'personer i familjen')} · ${confirmedMembers} genom helt bekräftade led</p>
    <div class="group-people">${memberButtons(members)}</div>
  </article>`;
}

function renderKinGroupNode(group, visible, rendered) {
  if (!group || rendered.has(group.id)) return '';
  rendered.add(group.id);
  const members = kinGroupMemberDetails(group, familyContext);
  if (members.length && !members.some(member => visible.has(member.person_id))) return '';
  const confirmedMembers = members.filter(member => member.confirmed).length;
  const anchorCount = (group.anchor_person_ids || []).filter(id => familyContext.peopleById.has(id)).length;
  const childIds = new Set(group.child_group_ids || []);
  for (const candidate of currentKinGroups) if ((candidate.parent_group_ids || []).includes(group.id)) childIds.add(candidate.id);
  const families = currentFamilyUnits.filter(unit => (unit.kin_group_ids || []).includes(group.id));
  return `<section class="kin-group-card kind-${escapeAttribute(group.kind || 'family_circle')}">
    <header class="kin-group-heading">
      <button type="button" data-group-type="${KIN_GROUP_TYPE}" data-group-id="${escapeAttribute(group.id)}"><small>${escapeHtml(group.reference_code || 'SLÄKT')}</small><b>${escapeHtml(group.name || 'Namnlös släktgrupp')}</b></button>
      <div><span class="group-kind">${escapeHtml(KIN_GROUP_KINDS[group.kind] || 'Släktgrupp')}</span>${confirmationBadge(group.confirmed)}</div>
    </header>
    <p class="group-summary">${countNoun(anchorCount, 'ankarperson', 'ankarpersoner')} · ${countNoun(members.length, 'person synlig', 'personer synliga')} i gruppen och dess undergrupper · ${confirmedMembers} genom helt bekräftade led · släktleden räknas från denna grupp</p>
    <div class="group-people">${memberButtons(members)}</div>
    ${families.length ? `<div class="family-unit-list">${families.map(unit => renderFamilyUnitCard(unit, visible)).join('')}</div>` : ''}
    ${childIds.size ? `<div class="child-groups">${[...childIds].map(id => renderKinGroupNode(familyContext.kinGroupById.get(id), visible, rendered)).join('')}</div>` : ''}
  </section>`;
}

function renderGroupView(visible) {
  if (!currentFamilyUnits.length && !currentKinGroups.length) return `<section class="model-empty"><h2>Familjer och släkter har ännu inte strukturerats</h2><p>Personrelationerna finns kvar. Skapa stabila familjer och släktgrupper utan att ändra de underliggande fakta som ännu inte är bekräftade.</p><div class="button-row"><button type="button" data-action="create-family-unit">Ny familj</button><button type="button" data-action="create-kin-group">Ny släktgrupp</button></div></section>`;
  const childIds = new Set(currentKinGroups.flatMap(group => group.child_group_ids || []));
  const roots = currentKinGroups.filter(group => !(group.parent_group_ids || []).length && !childIds.has(group.id));
  const rendered = new Set();
  const rootHtml = roots.map(group => renderKinGroupNode(group, visible, rendered)).join('');
  const orphanHtml = currentKinGroups.filter(group => !rendered.has(group.id)).map(group => renderKinGroupNode(group, visible, rendered)).join('');
  const unplacedFamilies = currentFamilyUnits.filter(unit => !(unit.kin_group_ids || []).some(id => familyContext.kinGroupById.has(id)));
  return `<section class="group-model-intro"><div><p class="section-kicker">Stabila identiteter</p><h2>Familjer och släkter</h2><p>FAMILJ är en konkret familjebildning. SLÄKT är en namngiven syskongrupp, gren, stamlinje eller släktkrets. Bekräftelse av en grupp ändrar aldrig automatiskt en personrelation.</p></div><div class="button-row"><button type="button" data-action="create-family-unit">Ny familj</button><button type="button" data-action="create-kin-group">Ny släktgrupp</button></div></section>
    <div class="kin-group-list">${rootHtml}${orphanHtml}</div>
    ${unplacedFamilies.length ? `<section class="unplaced-families"><h2>Familjer utan vald släktgrupp</h2><div class="family-unit-list">${unplacedFamilies.map(group => renderFamilyUnitCard(group, visible)).join('')}</div></section>` : ''}`;
}

function renderLandscape(visible, relatedIds) {
  const groups = groupPeople(currentPeople);
  const accents = [205, 145, 18, 278, 188, 332];
  return groups.map((group, index) => {
    const people = [...group.families.values()].flat();
    const visibleCount = people.filter((person) => visible.has(person.id)).length;
    if (!visibleCount) return '';
    const islands = unique(people.filter((person) => visible.has(person.id)).flatMap(islandNames)).sort((a, b) => a.localeCompare(b, 'sv'));
    return `<section class="clan" id="clan-${slug(group.name)}" style="--clan-accent:hsl(${accents[index % accents.length]} 42% 42%)">
      <header class="clan-header"><div><p class="section-kicker">Släktkrets</p><h2>${escapeHtml(familyCircleLabel(group.name))}</h2></div><div class="clan-meta">${visibleCount} personer${islands.length ? ` · ${escapeHtml(islands.join(' · '))}` : ''}</div></header>
      ${[...group.families.entries()].map(([name, entries]) => renderFamilyStem(name, entries, visible, relatedIds)).join('')}
    </section>`;
  }).join('');
}

function renderPropertyLandscape(visible, relatedIds) {
  return groupPeopleByProperty(currentPeople, currentProperties).map((group) => {
    const people = group.people.filter((person) => visible.has(person.id));
    if (!people.length) return '';
    const components = componentSets(group.people, currentRelations)
      .filter((component) => [...component].some((id) => visible.has(id)));
    const connected = components.filter((component) => component.size > 1);
    const isolated = components.filter((component) => component.size === 1)
      .flatMap((component) => [...component])
      .filter((id) => visible.has(id))
      .map((id) => graph.byId.get(id))
      .filter(Boolean)
      .sort((a, b) => shownName(a).localeCompare(shownName(b), 'sv'));
    const property = group.property;
    const island = group.id === '__none__'
      ? unique(people.flatMap(islandNames)).join(' · ')
      : property.island;
    return `<section class="property-group" id="property-${slug(group.id)}">
      <header class="property-header"><div><p class="property-kicker">${group.id === '__none__' ? 'Ofullständig koppling' : 'Fastighet'}</p><h2>${escapeHtml(property.display_name)}</h2></div><div class="property-meta">${people.length} personer${island ? ` · ${escapeHtml(island)}` : ''}</div></header>
      <div class="property-families">
        ${connected.map((component) => {
          const visibleIds = [...component].filter((id) => visible.has(id));
          const familyNames = unique([...component]
            .map((id) => graph.byId.get(id)?.family || 'Utan känd familj/släkt'))
            .sort((a, b) => a.localeCompare(b, 'sv'));
          return `<section class="property-family"><h3>${escapeHtml(familyNames.join(' · '))} <small>${visibleIds.length}</small></h3><div class="forest">${renderComponent(component, visible, relatedIds)}</div></section>`;
        }).join('')}
        ${isolated.length ? `<section class="property-family property-unlinked"><h3>Personer utan registrerad relation på fastigheten <small>${isolated.length}</small></h3><div class="unlinked-grid">${isolated.map((person) => renderPersonCard(person, relatedIds)).join('')}</div></section>` : ''}
      </div>
    </section>`;
  }).join('');
}

function renderRegister(visible) {
  const rows = currentPeople.filter((person) => visible.has(person.id)).map((person) => `<tr>
    <td><button type="button" data-person-id="${escapeAttribute(person.id)}">${escapeHtml(person.display_name)}</button>${person.club_name ? `<small>${escapeHtml(person.club_name)}</small>` : ''}</td>
    <td>${escapeHtml(person.living || 'okänt')}</td><td>${escapeHtml(years(person))}</td><td>${escapeHtml(person.family || '—')}</td><td>${escapeHtml(propertyNames(person).join(' · ') || '—')}</td><td>${escapeHtml(islandNames(person).join(' · ') || '—')}</td><td>${escapeHtml(person.membership_status || '—')}</td>
  </tr>`).join('');
  return `<section class="register"><table><thead><tr><th>Person</th><th>Lever</th><th>År</th><th>Familjegren</th><th>Fastighet</th><th>Ö</th><th>Medlemsläge</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function renderReview() {
  const inlaws = currentPeople.filter((person) => person.ui_is_inlaw);
  const gaps = currentPeople.filter(relevantGap);
  const estimated = currentPeople.filter((person) => generationFor(person) != null && !['kedja', 'gifte'].includes(person.ui_generation_source));
  const unknownLiving = currentPeople.filter((person) => !person.living || person.living === 'okänt');
  const islandWithoutProperty = currentPeople.filter((person) => islandNames(person).length && !personPropertyIds(person).length);
  const islandConflicts = currentPeople.filter(islandPropertyConflict);
  const section = (title, description, people) => `<section class="review-section"><h2>${escapeHtml(title)} (${people.length})</h2><p>${escapeHtml(description)}</p>${people.map((person) => `<div class="review-row"><span><b>${escapeHtml(person.display_name)}</b> · ${escapeHtml(person.family || '—')}</span><button type="button" data-person-id="${escapeAttribute(person.id)}">Öppna</button></div>`).join('') || '<p>Inga.</p>'}</section>`;
  return `<div class="review-list">
    ${section('Okänd livsstatus', 'Komplettera levande eller avliden direkt i personpanelen.', unknownLiving)}
    ${section('Ö och fastighet säger olika', 'Båda uppgifterna bevaras tills motsägelsen är avgjord.', islandConflicts)}
    ${section('Ö men ingen fastighet', 'Ö-kopplingen är bevarad manuellt tills en fastighet kan anges.', islandWithoutProperty)}
    ${section('Ingifta enligt presentationsdata', 'Kontrollera genom att öppna personen och ändra presentationsrollen om den är fel.', inlaws)}
    ${section('Relevanta relationsluckor', 'Personer utan kända föräldrar trots att de ligger efter första generationen.', gaps)}
    ${section('Uppskattade generationer', 'Generationer som inte vilar på en fullständig föräldra–barn-kedja.', estimated)}
  </div>`;
}

function render() {
  refreshData();
  refreshControls();
  renderActiveFilters();
  if (!currentPeople.length) {
    contentNode.innerHTML = '<section class="empty-card"><h2>Ingen privat släktdata på den här enheten ännu</h2><p>Anslut Dropbox för att hämta den privata mastern.</p></section>';
    closeDrawer(false);
    return;
  }
  const visible = visiblePersonIds(currentPeople, graph, ui);
  const relatedIds = ui.selectedPersonId ? lineageIds(ui.selectedPersonId, graph) : new Set();
  const body = ui.review
    ? renderReview()
    : ui.view === 'groups'
      ? renderGroupView(visible)
      : ui.view === 'register'
      ? renderRegister(visible)
      : ui.view === 'property'
        ? renderPropertyLandscape(visible, relatedIds)
        : renderLandscape(visible, relatedIds);
  contentNode.innerHTML = `<section class="summary" aria-label="Datasammanfattning"><div><strong>${currentPeople.length}</strong><span>personer</span></div><div><strong>${currentRelations.length}</strong><span>relationer</span></div><div><strong>${currentFamilyUnits.length}</strong><span>familjer</span></div><div><strong>${currentKinGroups.length}</strong><span>släktgrupper</span></div><div><strong>${visible.size}</strong><span>personer visas</span></div></section>${body || '<p class="empty-note">Inga personer matchar filtren.</p>'}`;
  $('#filter-count').textContent = `${visible.size} av ${currentPeople.length} personer`;
  document.body.classList.toggle('show-gaps', ui.showGaps);
  document.body.classList.toggle('has-selection', Boolean(ui.selectedPersonId));
  document.querySelectorAll('[data-view-mode]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.viewMode === ui.view)));
  $('#review-button').setAttribute('aria-pressed', String(ui.review));
  if (ui.selectedPersonId) renderDrawer(ui.selectedPersonId);
  else if (ui.selectedGroup) renderGroupDrawer(ui.selectedGroup.entityType, ui.selectedGroup.id);
}

function filterLabel(key) {
  if (key === 'living') return ui.living === 'ja' ? 'Levande' : ui.living === 'nej' ? 'Avlidna' : 'Okänd livsstatus';
  if (key === 'property') return ui.property === '__none__' ? 'Utan fastighet' : propertyById.get(ui.property)?.display_name || ui.property;
  if (key === 'generations') return 'Presentationsled ' + [...ui.generations].join(', ');
  if (key === 'year') return 'Levde år ' + ui.year;
  if (key === 'inlaws') return 'Utan ingifta';
  if (key === 'unlinked') return 'Utan kända band';
  return ui.island;
}

function renderActiveFilters() {
  const keys = [];
  if (ui.island) keys.push('island');
  if (ui.living) keys.push('living');
  if (ui.property) keys.push('property');
  if (ui.generations.size) keys.push('generations');
  if (ui.yearOn) keys.push('year');
  if (!ui.includeInlaws) keys.push('inlaws');
  if (ui.onlyUnlinked) keys.push('unlinked');
  activeFiltersNode.innerHTML = keys
    .map((key) => '<button type="button" class="active-filter-chip" data-clear-filter="' + key + '">' + escapeHtml(filterLabel(key)) + '<span aria-hidden="true">×</span></button>')
    .join('');
  $('#filter-badge').hidden = keys.length === 0;
  $('#filter-badge').textContent = keys.length ? String(keys.length) : '';
}

function clearFilter(key) {
  if (key === 'island') ui.island = '';
  if (key === 'living') ui.living = '';
  if (key === 'property') ui.property = '';
  if (key === 'generations') ui.generations.clear();
  if (key === 'year') ui.yearOn = false;
  if (key === 'inlaws') ui.includeInlaws = true;
  if (key === 'unlinked') ui.onlyUnlinked = false;
  $('#year-on').setAttribute('aria-pressed', String(ui.yearOn));
  $('#year-slider').disabled = !ui.yearOn;
  $('#year-out').textContent = ui.yearOn ? ui.year : 'alla år';
  $('#include-inlaws').checked = ui.includeInlaws;
  $('#toggle-lonely').setAttribute('aria-pressed', String(ui.onlyUnlinked));
  render();
}

function visibleFilterControls() {
  return [...filterPanel.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled])')]
    .filter((node) => node.offsetParent !== null);
}

function openFilterPanel() {
  filterReturnFocus = document.activeElement;
  filterPanel.hidden = false;
  filterBackdrop.hidden = false;
  filterToggle.setAttribute('aria-expanded', 'true');
  document.body.classList.add('filter-open');
  filterPanel.querySelector('[data-close-filter]')?.focus();
}

function closeFilterPanel(restoreFocus = true) {
  if (filterPanel.hidden) return;
  filterPanel.hidden = true;
  filterBackdrop.hidden = true;
  filterToggle.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('filter-open');
  if (restoreFocus && filterReturnFocus instanceof HTMLElement) filterReturnFocus.focus();
}

function toggleRelationTools() {
  relationTools.hidden = !relationTools.hidden;
  relationToggle.setAttribute('aria-expanded', String(!relationTools.hidden));
  if (!relationTools.hidden) $('#rel-a').focus();
}

function handleGlobalKeydown(event) {
  if (event.key === 'Escape' && !filterPanel.hidden) {
    event.preventDefault();
    closeFilterPanel();
    return;
  }
  if (event.key === 'Tab' && !filterPanel.hidden) {
    const controls = visibleFilterControls();
    if (!controls.length) return;
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
    return;
  }
  if (event.key === 'Escape' && !relationTools.hidden) {
    relationTools.hidden = true;
    relationToggle.setAttribute('aria-expanded', 'false');
    relationToggle.focus();
    return;
  }
  if (event.key === 'Escape') closeDrawer();
}

function relationRows(links) {
  if (!links.length) return '<li class="empty-note">Inga registrerade</li>';
  return links.map((link) => {
    const person = graph.byId.get(link.id);
    const relation = link.relation;
    if (!person) return '';
    const derived = relation.derived;
    return `<li class="relation-row"><button type="button" class="relation-person" data-open-person="${escapeAttribute(person.id)}">${escapeHtml(person.display_name)}</button>${derived ? `<span class="derived-label">via gemensam förälder</span>` : `<select data-relation-field="user_confirmed" data-value-type="boolean" data-relation-id="${escapeAttribute(relation.id)}" aria-label="Bekräftelse"><option value="true" ${isConfirmed(relation.user_confirmed) ? 'selected' : ''}>bekräftad</option><option value="false" ${!isConfirmed(relation.user_confirmed) ? 'selected' : ''}>ej bekräftad</option></select><button type="button" class="icon-button" data-delete-relation="${escapeAttribute(relation.id)}" aria-label="Ta bort relation till ${escapeAttribute(person.display_name)}">×</button>`}</li>`;
  }).join('');
}

function selectOptions(values, selected) {
  return values.map(([value, label]) => `<option value="${escapeAttribute(value)}" ${String(value) === String(selected ?? '') ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');
}

function renderDrawer(personId) {
  const person = graph.byId.get(personId);
  if (!person) {
    closeDrawer(false);
    return;
  }
  const closeFamily = nearFamily(person.id, graph);
  const groupMemberships = groupsForPerson(person.id, familyContext);
  const familyMemberships = groupMemberships.filter(entry => entry.type === FAMILY_UNIT_TYPE);
  const kinMemberships = groupMemberships.filter(entry => entry.type === KIN_GROUP_TYPE);
  const propertyLinks = currentPropertyLinks.filter((link) => link.person_id === person.id && propertyById.has(link.property_id));
  const linkedPropertyIds = new Set(propertyLinks.map((link) => link.property_id));
  const availableProperties = currentProperties.filter((property) => !linkedPropertyIds.has(property.id));
  const islands = unique([...currentProperties.map((property) => property.island), ...currentPeople.map((entry) => entry.legacy_island)].filter(Boolean)).sort((a, b) => a.localeCompare(b, 'sv'));
  const propertyRows = propertyLinks.map((link) => {
    const property = propertyById.get(link.property_id);
    return `<li class="property-link-row"><span><b>${escapeHtml(property.display_name)}</b>${property.island ? ` · ${escapeHtml(property.island)}` : ''}</span><button type="button" class="icon-button" data-delete-property-link="${escapeAttribute(link.id)}" aria-label="Ta bort fastighetskopplingen till ${escapeAttribute(property.display_name)}">×</button></li>`;
  }).join('');
  drawerContent.innerHTML = `<h2>${escapeHtml(person.display_name)}</h2><p class="drawer-meta">${escapeHtml([person.club_name, years(person), ...islandNames(person)].filter(Boolean).join(' · '))}</p>
    <section class="belonging-card" aria-label="Personens tillhörigheter">
      <div><span>Familjer</span><strong>${familyMemberships.length ? familyMemberships.map(entry => escapeHtml(displayReference(entry.group))).join('<br>') : 'Ingen strukturerad'}</strong></div>
      <div><span>Släkter</span><strong>${kinMemberships.length ? kinMemberships.map(entry => `${escapeHtml(displayReference(entry.group))}<small>${escapeHtml(relativeGenerationLabel(entry.membership, entry.group))}${entry.membership.confirmed ? '' : ' · ej helt bekräftat'}</small>`).join('<br>') : 'Ingen strukturerad'}</strong></div>
      <div><span>Fastighet</span><strong>${escapeHtml(propertyNames(person).join(' · ') || 'Ingen registrerad')}</strong></div>
    </section>
    <h3>Personuppgifter</h3>
    <div class="editor-grid">
      <label class="editor-field wide"><span>Visningsnamn</span><input data-person-field="display_name" value="${escapeAttribute(person.display_name || '')}"></label>
      <label class="editor-field wide"><span>Fullständigt namn</span><input data-person-field="full_name" value="${escapeAttribute(person.full_name || '')}"></label>
      <label class="editor-field wide"><span>Födelsenamn</span><input data-person-field="birth_name" value="${escapeAttribute(person.birth_name || '')}" placeholder="Tidigare efternamn eller fullständigt födelsenamn"></label>
      <label class="editor-field"><span>Född</span><input inputmode="numeric" data-person-field="birth" data-value-type="number" value="${escapeAttribute(person.birth ?? '')}"></label>
      <label class="editor-field"><span>Död</span><input inputmode="numeric" data-person-field="death" data-value-type="number" value="${escapeAttribute(person.death ?? '')}"></label>
      <label class="editor-field"><span>Lever</span><select data-person-field="living">${selectOptions([['okänt', 'okänt'], ['ja', 'ja'], ['nej', 'nej']], person.living || 'okänt')}</select></label>
      <label class="editor-field"><span>Medlemsläge</span><select data-person-field="membership_status">${selectOptions([['aktuell', 'aktuell'], ['tidigare', 'tidigare'], ['förväntad', 'förväntad'], ['ej', 'ej medlem']], person.membership_status)}</select></label>
      <label class="editor-field wide"><span>KBK-namn</span><input data-person-field="club_name" value="${escapeAttribute(person.club_name || '')}"></label>
      <label class="editor-field"><span>Presentationsroll</span><select data-person-field="ui_is_inlaw" data-value-type="boolean">${selectOptions([['false', 'född i/fristående'], ['true', 'ingift']], String(Boolean(person.ui_is_inlaw)))}</select></label>
      <label class="editor-field"><span>Manuell ö utan fastighet</span><select data-person-field="legacy_island"><option value="">Ingen angiven</option>${islands.map((island) => `<option value="${escapeAttribute(island)}" ${person.legacy_island === island ? 'selected' : ''}>${escapeHtml(island)}</option>`).join('')}</select></label>
      <label class="editor-field"><span>Ö-status</span><select data-person-field="residence_status">${selectOptions([['okänt', 'okänt'], ['bor', 'bor'], ['avflyttad', 'avflyttad']], person.residence_status || 'okänt')}</select></label>
      <label class="editor-field wide"><span>Roll</span><input data-person-field="role" value="${escapeAttribute(person.role || '')}"></label>
      <label class="editor-field wide"><span>Not</span><textarea data-person-field="note">${escapeHtml(person.note || '')}</textarea></label>
    </div>
    <p class="drawer-note${islandPropertyConflict(person) ? ' warning' : ''}">${islandPropertyConflict(person)
      ? `Motsägelse: godkänd ö är ${escapeHtml(person.legacy_island)}, men fastigheten ligger på ${escapeHtml(person.property_islands.join(' · '))}. Båda uppgifterna bevaras tills detta är rättat.`
      : 'Om personen har en fastighet hämtas ön automatiskt därifrån. Den manuella ön ligger kvar som reservuppgift.'}</p>
    <h3>Fastigheter</h3>
    <ul class="property-link-list">${propertyRows || '<li class="empty-note">Ingen fastighet registrerad</li>'}</ul>
    <div class="add-property"><select data-new-property-id><option value="">Välj fastighet …</option>${availableProperties.map((property) => `<option value="${escapeAttribute(property.id)}">${escapeHtml(property.display_name)}${property.island ? ` · ${escapeHtml(property.island)}` : ''}</option>`).join('')}</select><button type="button" data-action="add-property">Lägg till</button></div>
    <h3>Nära familj</h3>
    <div class="close-family-grid">
      <section><h4>Föräldrar</h4><ul class="relation-list">${relationRows(closeFamily.parents)}</ul></section>
      <section><h4>Syskon</h4><ul class="relation-list">${relationRows(closeFamily.siblings)}</ul></section>
      <section><h4>Partner</h4><ul class="relation-list">${relationRows(closeFamily.partners)}</ul></section>
      ${closeFamily.formerPartners.length ? `<section><h4>Tidigare partner</h4><ul class="relation-list">${relationRows(closeFamily.formerPartners)}</ul></section>` : ''}
      ${closeFamily.coparents.length ? `<section><h4>Medföräldrar</h4><ul class="relation-list">${relationRows(closeFamily.coparents)}</ul></section>` : ''}
      <section><h4>Barn</h4><ul class="relation-list">${relationRows(closeFamily.children)}</ul></section>
    </div>
    <h3>Lägg till relation</h3>
    <div class="add-relation"><input list="drawer-person-options" data-new-relation-person placeholder="Välj person …"><select data-new-relation-kind><option value="parent">är förälder till vald person</option><option value="child">är barn till vald person</option><option value="sibling">är syskon med vald person</option><option value="partner">är partner med vald person</option><option value="former">var tidigare partner</option></select><button type="button" data-action="add-relation">Lägg till</button></div>
    <p><a class="cross-app-link" href="../batregister/?person=${encodeURIComponent(person.id)}">Visa båtar kopplade till ${escapeHtml(person.display_name)}</a></p>
    <div class="danger-zone"><button type="button" class="danger-button" data-action="delete-person">Ta bort personen…</button></div>`;
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  document.body.classList.add('drawer-open');
}

function closeDrawer(clearSelection = true) {
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('drawer-open');
  if (clearSelection) {
    ui.selectedPersonId = null;
    ui.selectedGroup = null;
    document.body.classList.remove('has-selection');
    contentNode.querySelectorAll('.is-selected,.is-related').forEach((node) => node.classList.remove('is-selected', 'is-related'));
  }
}

function selectPerson(personId, scroll = false) {
  if (!graph.byId.has(personId)) return;
  ui.selectedPersonId = personId;
  ui.selectedGroup = null;
  ui.review = false;
  render();
  if (scroll) {
    const card = contentNode.querySelector(`[data-person-id="${CSS.escape(personId)}"]`);
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function parseFieldValue(element) {
  const text = element.value.trim();
  if (element.dataset.valueType === 'number') return text === '' ? null : Number(text);
  if (element.dataset.valueType === 'boolean') return text === 'true';
  return text === '' ? null : text;
}

function groupRecordsForType(entityType) {
  return entityType === FAMILY_UNIT_TYPE ? currentFamilyUnits : currentKinGroups;
}

function groupTypeName(entityType) {
  return entityType === FAMILY_UNIT_TYPE ? 'Familj' : 'Släktgrupp';
}

function kinGroupDescendantIds(groupId) {
  const descendants = new Set();
  const queue = [groupId];
  while (queue.length) {
    const parentId = queue.shift();
    for (const group of currentKinGroups) {
      const isChild = (group.parent_group_ids || []).includes(parentId)
        || (currentKinGroups.find(entry => entry.id === parentId)?.child_group_ids || []).includes(group.id);
      if (!isChild || descendants.has(group.id) || group.id === groupId) continue;
      descendants.add(group.id);
      queue.push(group.id);
    }
  }
  return descendants;
}

function renderGroupDrawer(entityType, groupId) {
  const group = groupRecordsForType(entityType).find(entry => entry.id === groupId);
  if (!group) return closeDrawer(false);
  ui.selectedPersonId = null;
  ui.selectedGroup = { entityType, id: groupId };
  const anchors = (group.anchor_person_ids || []).map(personId => familyContext.peopleById.get(personId)).filter(Boolean);
  const explicitMembers = (group.explicit_person_ids || []).map(personId => familyContext.peopleById.get(personId)).filter(Boolean);
  const parentId = entityType === KIN_GROUP_TYPE ? group.parent_group_ids?.[0] || '' : '';
  const disallowedParentIds = entityType === KIN_GROUP_TYPE ? kinGroupDescendantIds(group.id) : new Set();
  const parentOptions = currentKinGroups.filter(entry => entry.id !== group.id && !disallowedParentIds.has(entry.id))
    .map(entry => `<option value="${escapeAttribute(entry.id)}" ${entry.id === parentId ? 'selected' : ''}>${escapeHtml(displayReference(entry))}</option>`).join('');
  const familyKinOptions = currentKinGroups
    .map(entry => `<label><input type="checkbox" data-family-kin-group="${escapeAttribute(entry.id)}" ${(group.kin_group_ids || []).includes(entry.id) ? 'checked' : ''}><span>${escapeHtml(displayReference(entry))}</span></label>`).join('');
  drawerContent.innerHTML = `<h2>${escapeHtml(group.name || groupTypeName(entityType))}</h2><p class="drawer-meta">${escapeHtml(group.reference_code || '')} · stabil referenskod</p>
    <section class="belonging-card"><div><span>Full läsbar referens</span><strong>${escapeHtml(displayReference(group))}</strong></div><div><span>Status</span><strong>${isConfirmed(group.confirmed) ? 'Bekräftad' : 'Ej bekräftad'}</strong></div></section>
    <h3>${escapeHtml(groupTypeName(entityType))}</h3>
    <div class="editor-grid">
      <label class="editor-field wide"><span>Namn</span><input data-group-field="name" value="${escapeAttribute(group.name || '')}"></label>
      <label class="editor-field"><span>Bekräftelse</span><select data-group-field="confirmed" data-value-type="boolean">${selectOptions([['false', 'ej bekräftad'], ['true', 'bekräftad']], String(isConfirmed(group.confirmed)))}</select></label>
      ${entityType === KIN_GROUP_TYPE ? `<label class="editor-field"><span>Art</span><select data-group-field="kind">${selectOptions(Object.entries(KIN_GROUP_KINDS), group.kind || 'family_circle')}</select></label>` : ''}
      <label class="editor-field wide"><span>Omfattning</span><select data-group-field="membership_rule">${selectOptions(Object.entries(MEMBERSHIP_RULES), group.membership_rule || (entityType === FAMILY_UNIT_TYPE ? 'anchors_and_shared_children' : 'explicit'))}</select></label>
      ${entityType === KIN_GROUP_TYPE ? `<label class="editor-field wide"><span>Överordnad släktgrupp</span><select data-group-parent><option value="">Ingen vald</option>${parentOptions}</select></label>` : ''}
    </div>
    ${entityType === FAMILY_UNIT_TYPE ? `<h3>Tillhör släktgrupper</h3><div class="group-membership-options">${familyKinOptions || '<p class="empty-note">Inga släktgrupper finns.</p>'}</div><p class="drawer-note">En familj kan tillhöra flera släktgrupper, exempelvis när två släktgrenar möts. Det kopplar familjen till båda grenarna men slår inte ihop hela släkterna.</p>` : ''}
    <h3>Ankarpersoner</h3>
    <ul class="property-link-list">${anchors.map(person => `<li class="property-link-row"><button type="button" class="relation-person" data-open-person="${escapeAttribute(person.id)}">${escapeHtml(person.display_name)}</button><button type="button" class="icon-button" data-remove-group-anchor="${escapeAttribute(person.id)}">×</button></li>`).join('') || '<li class="empty-note">Inga ankarpersoner</li>'}</ul>
    <div class="add-relation"><input list="drawer-person-options" data-new-group-anchor placeholder="Välj person …"><button type="button" data-action="add-group-anchor">Lägg till ankare</button></div>
    <h3>Uttryckliga medlemmar</h3>
    <ul class="property-link-list">${explicitMembers.map(person => `<li class="property-link-row"><button type="button" class="relation-person" data-open-person="${escapeAttribute(person.id)}">${escapeHtml(person.display_name)}</button><button type="button" class="icon-button" data-remove-group-member="${escapeAttribute(person.id)}">×</button></li>`).join('') || '<li class="empty-note">Inga uttryckliga medlemmar</li>'}</ul>
    <div class="add-relation"><input list="drawer-person-options" data-new-group-member placeholder="Välj person …"><button type="button" data-action="add-group-member">Lägg till medlem</button></div>
    <p class="drawer-note">Namnet och visningen får ändras. Referenskoden och det interna id:t förblir desamma. Släktled räknas från ankarpersonerna och är aldrig globala.</p>
    <div class="danger-zone"><button type="button" class="danger-button" data-action="delete-group">Ta bort ${entityType === FAMILY_UNIT_TYPE ? 'familjen' : 'släktgruppen'}…</button></div>`;
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  document.body.classList.add('drawer-open');
}

async function createGroup(entityType) {
  const records = groupRecordsForType(entityType);
  const id = `${entityType}:${crypto.randomUUID()}`;
  const referenceCode = nextReferenceCode(entityType, records);
  const name = entityType === FAMILY_UNIT_TYPE ? 'Ny familj' : 'Ny släktgrupp';
  await syncEdit(async () => {
    await repository.restoreEntity(entityType, id);
    await repository.setFields([
      { entityType, entityId: id, field: 'reference_code', value: referenceCode },
      { entityType, entityId: id, field: 'name', value: name },
      { entityType, entityId: id, field: 'confirmed', value: false },
      { entityType, entityId: id, field: 'anchor_person_ids', value: [] },
      { entityType, entityId: id, field: 'membership_rule', value: entityType === FAMILY_UNIT_TYPE ? 'anchors_and_shared_children' : 'explicit' },
      ...(entityType === KIN_GROUP_TYPE ? [{ entityType, entityId: id, field: 'kind', value: 'family_circle' }] : []),
    ]);
  });
  renderGroupDrawer(entityType, id);
}

async function updateGroupParent(value) {
  const selected = ui.selectedGroup;
  if (!selected || selected.entityType !== KIN_GROUP_TYPE) return;
  if (value === selected.id || kinGroupDescendantIds(selected.id).has(value)) {
    setEditStatus('En släktgrupp kan inte läggas under sig själv eller en undergrupp.', 'error');
    return renderGroupDrawer(selected.entityType, selected.id);
  }
  const changes = [{ entityType: KIN_GROUP_TYPE, entityId: selected.id, field: 'parent_group_ids', value: value ? [value] : [] }];
  for (const group of currentKinGroups) {
    if (group.id === selected.id) continue;
    const withoutSelected = (group.child_group_ids || []).filter(id => id !== selected.id);
    const childIds = group.id === value ? [...new Set([...withoutSelected, selected.id])] : withoutSelected;
    if (JSON.stringify(childIds) !== JSON.stringify(group.child_group_ids || [])) {
      changes.push({ entityType: KIN_GROUP_TYPE, entityId: group.id, field: 'child_group_ids', value: childIds });
    }
  }
  await syncEdit(() => repository.setFields(changes));
}

async function updateFamilyKinGroup(kinGroupId, checked) {
  const selected = ui.selectedGroup;
  const family = selected?.entityType === FAMILY_UNIT_TYPE
    ? currentFamilyUnits.find(entry => entry.id === selected.id)
    : null;
  if (!family || !currentKinGroups.some(group => group.id === kinGroupId)) return;
  const current = new Set(family.kin_group_ids || []);
  if (checked) current.add(kinGroupId);
  else current.delete(kinGroupId);
  const value = [...current].sort((a, b) => a.localeCompare(b, 'sv'));
  await syncEdit(() => repository.setField(FAMILY_UNIT_TYPE, family.id, 'kin_group_ids', value));
}

async function addGroupAnchor() {
  const selected = ui.selectedGroup;
  const group = selected && groupRecordsForType(selected.entityType).find(entry => entry.id === selected.id);
  const input = drawerContent.querySelector('[data-new-group-anchor]');
  const person = lookupPerson(input?.value);
  if (!group || !person) return setEditStatus('Välj en entydig person ur listan.', 'error');
  const anchors = [...new Set([...(group.anchor_person_ids || []), person.id])];
  await syncEdit(() => repository.setField(selected.entityType, selected.id, 'anchor_person_ids', anchors));
}

async function removeGroupAnchor(personId) {
  const selected = ui.selectedGroup;
  const group = selected && groupRecordsForType(selected.entityType).find(entry => entry.id === selected.id);
  if (!group) return;
  await syncEdit(() => repository.setField(selected.entityType, selected.id, 'anchor_person_ids', (group.anchor_person_ids || []).filter(id => id !== personId)));
}

async function addGroupMember() {
  const selected = ui.selectedGroup;
  const group = selected && groupRecordsForType(selected.entityType).find(entry => entry.id === selected.id);
  const input = drawerContent.querySelector('[data-new-group-member]');
  const person = lookupPerson(input?.value);
  if (!group || !person) return setEditStatus('Välj en entydig person ur listan.', 'error');
  const members = [...new Set([...(group.explicit_person_ids || []), person.id])];
  await syncEdit(() => repository.setField(selected.entityType, selected.id, 'explicit_person_ids', members));
}

async function removeGroupMember(personId) {
  const selected = ui.selectedGroup;
  const group = selected && groupRecordsForType(selected.entityType).find(entry => entry.id === selected.id);
  if (!group) return;
  await syncEdit(() => repository.setField(selected.entityType, selected.id, 'explicit_person_ids', (group.explicit_person_ids || []).filter(id => id !== personId)));
}

async function deleteGroup() {
  const selected = ui.selectedGroup;
  const group = selected && groupRecordsForType(selected.entityType).find(entry => entry.id === selected.id);
  if (!group || !window.confirm(`Ta bort ${displayReference(group)}? Personer och personrelationer påverkas inte.`)) return;
  const restoreEntries = [{ entityType: selected.entityType, entityId: selected.id }];
  if (!await syncEdit(() => repository.deleteEntity(selected.entityType, selected.id))) return;
  ui.selectedGroup = null;
  closeDrawer(false);
  offerUndo(`${displayReference(group)} borttagen`, restoreEntries, `${displayReference(group)} återställd`);
}

async function applyFamilyModelLocal() {
  if (!isSourceTree) throw new Error('Familjemodellen kan bara aktiveras från den privata arbetskopian.');
  const response = await fetch(LOCAL_FAMILY_MODEL_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Familjemodellen kunde inte läsas (${response.status}).`);
  const plan = await response.json();
  if (plan.schema_version !== 1 || !Array.isArray(plan.relations) || !Array.isArray(plan.family_units) || !Array.isArray(plan.kin_groups)) throw new Error('Familjemodellen har fel format.');
  const personIds = new Set(currentPeople.map(person => person.id));
  const groups = [
    ...plan.family_units.map(group => ({ entityType: FAMILY_UNIT_TYPE, ...group })),
    ...plan.kin_groups.map(group => ({ entityType: KIN_GROUP_TYPE, ...group })),
  ];
  for (const relation of plan.relations) if (!personIds.has(relation.from_person_id) || !personIds.has(relation.to_person_id)) throw new Error(`Okänd person i familjemodellen: ${relation.from_person_id} / ${relation.to_person_id}`);
  for (const group of groups) for (const personId of [...(group.anchor_person_ids || []), ...(group.explicit_person_ids || [])]) if (!personIds.has(personId)) throw new Error(`Okänd ankarperson i ${group.reference_code}: ${personId}`);
  const relationEntities = plan.relations.map(relation => ({
    entityType: 'relation',
    id: relationEntityId(relation.kind, relation.from_person_id, relation.to_person_id),
    fields: {
      kind: relation.kind,
      from_person_id: relation.from_person_id,
      to_person_id: relation.to_person_id,
      user_confirmed: Boolean(relation.confirmed),
      confidence: null,
      form: null,
      note: null,
      ...(relation.parent_role ? { parent_role: relation.parent_role } : {}),
    },
  }));
  await repository.restoreEntities([
    ...relationEntities.map(entity => ({ entityType: entity.entityType, entityId: entity.id })),
    ...groups.map(group => ({ entityType: group.entityType, entityId: group.id })),
  ]);
  await repository.setFields([
    ...relationEntities.flatMap(entity => Object.entries(entity.fields).map(([field, value]) => ({ entityType: entity.entityType, entityId: entity.id, field, value }))),
    ...groups.flatMap(group => Object.entries(group).filter(([field]) => !['entityType', 'id'].includes(field)).map(([field, value]) => ({ entityType: group.entityType, entityId: group.id, field, value }))),
  ]);
  await store.putMeta(FAMILY_MODEL_META, { applied: true, migration_id: plan.migration_id, applied_at: new Date().toISOString() });
  familyModelButton.hidden = true;
  render();
  setEditStatus('Familjemodellen sparades lokalt · synkar med Dropbox…');
  await syncNow();
}

async function syncEdit(action) {
  setEditStatus('Sparar ändringen lokalt…');
  try {
    await action();
    render();
    setEditStatus('Sparad lokalt · synkar med Dropbox…');
    try {
      const result = await syncNow();
      if (result) setEditStatus('Sparad lokalt och synkad med Dropbox.', 'ok');
      else setEditStatus(navigator.onLine === false ? 'Sparad lokalt · offline · synkas automatiskt senare.' : 'Sparad lokalt · anslut Dropbox för synk.', 'warning');
    } catch (syncError) {
      console.error(syncError);
      setEditStatus('Sparad lokalt · Dropbox-synken misslyckades och försöker igen senare.', 'warning');
    }
    return true;
  } catch (error) {
    console.error(error);
    setEditStatus(`Kunde inte spara · ${error.message}`, 'error');
    render();
    return false;
  }
}

async function addPropertyLink() {
  const select = drawerContent.querySelector('[data-new-property-id]');
  const propertyId = select?.value;
  const personId = ui.selectedPersonId;
  if (!propertyId || !propertyById.has(propertyId) || !graph.byId.has(personId)) {
    setEditStatus('Välj en fastighet ur listan.', 'error');
    return;
  }
  const id = propertyLinkEntityId(personId, propertyId);
  if (currentPropertyLinks.some((link) => link.id === id)) {
    setEditStatus('Fastighetskopplingen finns redan.', 'error');
    return;
  }
  await syncEdit(async () => {
    await repository.restoreEntity('property-link', id);
    await repository.setFields([
      { entityType: 'property-link', entityId: id, field: 'person_id', value: personId },
      { entityType: 'property-link', entityId: id, field: 'property_id', value: propertyId },
      { entityType: 'property-link', entityId: id, field: 'confirmed', value: true },
    ]);
  });
}

async function deletePropertyLink(id) {
  const link = currentPropertyLinks.find((entry) => entry.id === id);
  if (!link) return;
  const person = graph.byId.get(link.person_id)?.display_name || link.person_id;
  const propertyName = propertyById.get(link.property_id)?.display_name || link.property_id;
  if (!window.confirm(`Ta bort fastighetskopplingen mellan ${person} och ${propertyName}?`)) return;
  const restoreEntries = [{ entityType: 'property-link', entityId: id }];
  if (await syncEdit(() => repository.deleteEntity('property-link', id))) offerUndo('Fastighetskopplingen borttagen', restoreEntries, 'Fastighetskopplingen återställd');
}

async function addRelation() {
  const input = drawerContent.querySelector('[data-new-relation-person]');
  const kindNode = drawerContent.querySelector('[data-new-relation-kind]');
  const other = lookupPerson(input.value);
  if (!other || other.id === ui.selectedPersonId) {
    setEditStatus('Välj en annan, entydig person ur listan.', 'error');
    return;
  }
  let kind = kindNode.value;
  let from = ui.selectedPersonId;
  let to = other.id;
  if (kind === 'parent') {
    from = other.id;
    kind = 'foralder-barn';
  } else if (kind === 'child') {
    kind = 'foralder-barn';
  } else if (kind === 'former') {
    kind = 'tidigare';
  } else if (kind === 'sibling') {
    kind = 'syskon';
  } else {
    kind = 'partner';
  }
  if (kind === 'foralder-barn' && wouldCreateParentChildCycle(from, to, familyContext)) {
    setEditStatus('Relationen skulle skapa en cirkel mellan förälder och barn.', 'error');
    return;
  }
  const id = relationEntityId(kind, from, to);
  if (currentRelations.some((relation) => relation.id === id)) {
    setEditStatus('Den relationen finns redan.', 'error');
    return;
  }
  await syncEdit(async () => {
    await repository.restoreEntity('relation', id);
    await repository.setFields([
      { entityType: 'relation', entityId: id, field: 'kind', value: kind },
      { entityType: 'relation', entityId: id, field: 'from_person_id', value: from },
      { entityType: 'relation', entityId: id, field: 'to_person_id', value: to },
      { entityType: 'relation', entityId: id, field: 'form', value: null },
      { entityType: 'relation', entityId: id, field: 'confidence', value: null },
      { entityType: 'relation', entityId: id, field: 'user_confirmed', value: true },
      { entityType: 'relation', entityId: id, field: 'note', value: null },
    ]);
  });
}

async function deleteRelation(id) {
  const relation = currentRelations.find((entry) => entry.id === id);
  if (!relation) return;
  const from = graph.byId.get(relation.from_person_id)?.display_name || relation.from_person_id;
  const to = graph.byId.get(relation.to_person_id)?.display_name || relation.to_person_id;
  if (!window.confirm(`Ta bort relationen mellan ${from} och ${to}? Ändringen sparas med återställningsbar historik.`)) return;
  const restoreEntries = [{ entityType: 'relation', entityId: id }];
  if (await syncEdit(() => repository.deleteEntity('relation', id))) offerUndo('Relationen borttagen', restoreEntries, 'Relationen återställd');
}

async function deletePerson() {
  const person = graph.byId.get(ui.selectedPersonId);
  if (!person) return;
  const related = currentRelations.filter((relation) => relation.from_person_id === person.id || relation.to_person_id === person.id);
  const propertyLinks = currentPropertyLinks.filter((link) => link.person_id === person.id);
  if (!window.confirm(`Ta bort ${person.display_name}, personens ${related.length} relationer och ${propertyLinks.length} fastighetskopplingar? Borttagningen sparas som återställningsbar historik.`)) return;
  const restoreEntries = [
    ...related.map((relation) => ({ entityType: 'relation', entityId: relation.id })),
    ...propertyLinks.map((link) => ({ entityType: 'property-link', entityId: link.id })),
    { entityType: 'person', entityId: person.id },
  ];
  if (!await syncEdit(() => repository.deleteEntities(restoreEntries))) return;
  ui.selectedPersonId = null;
  closeDrawer(false);
  offerUndo(`${person.display_name} borttagen`, restoreEntries, `${person.display_name} återställd`);
}

async function completeOAuthCallback() {
  const url = new URL(location.href);
  if (!url.searchParams.has('code') && !url.searchParams.has('error')) return;
  const token = await completeDropboxOAuth();
  accessToken = token.access_token;
  accessTokenExpiresAt = Date.now() + Math.max(30, Number(token.expires_in || 0) - 60) * 1000;
  if (token.refresh_token) await store.putMeta(TOKEN_META, token.refresh_token);
  for (const parameter of ['code', 'state', 'error', 'error_description']) url.searchParams.delete(parameter);
  history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

async function currentAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiresAt) return accessToken;
  const refreshToken = await store.getMeta(TOKEN_META);
  if (!refreshToken || !DROPBOX_CLIENT_ID) return null;
  if (navigator.onLine === false) return null;
  const token = await exchangeDropboxRefreshToken({ clientId: DROPBOX_CLIENT_ID, refreshToken });
  accessToken = token.access_token;
  accessTokenExpiresAt = Date.now() + Math.max(30, Number(token.expires_in || 0) - 60) * 1000;
  if (token.refresh_token && token.refresh_token !== refreshToken) await store.putMeta(TOKEN_META, token.refresh_token);
  return accessToken;
}

async function uploadBootstrapIfNeeded(transport) {
  const pending = await store.getMeta(BOOTSTRAP_META);
  if (!pending?.pending) return 0;
  const operations = (await store.getAllOps()).filter((operation) => operation.device_id === pending.device_id).sort((a, b) => a.seq - b.seq);
  let uploaded = 0;
  for (let index = 0; index < operations.length; index += 250) {
    const batch = createBatch(operations.slice(index, index + 250));
    await transport.putBatch(batch);
    uploaded += batch.ops.length;
  }
  await store.putMeta(BOOTSTRAP_META, { ...pending, pending: false, uploaded_at: new Date().toISOString() });
  return uploaded;
}

async function migrateLateLegacyBatches(primaryTransport, token) {
  if ((await store.getMeta(LEGACY_MIGRATION_META))?.completed_at) return 0;
  const legacyTransport = new DropboxTransport({
    accessToken: token,
    id: 'dropbox-matrikel-legacy-read',
    opsRoot: LEGACY_OPS_ROOT,
  });
  let cursor = null;
  let migratedOps = 0;
  try {
    while (true) {
      const page = await legacyTransport.listChanges(cursor, { createRoot: false });
      for (const entry of page.entries) {
        const batch = await legacyTransport.getJson(entry.path);
        await primaryTransport.putBatch(batch);
        migratedOps += batch.ops.length;
      }
      cursor = page.cursor;
      if (!page.has_more) break;
    }
  } catch (error) {
    const missingLegacyFolder = error?.status === 409 && String(error?.code || '').includes('not_found');
    if (!missingLegacyFolder) throw error;
  }
  await store.putMeta(LEGACY_MIGRATION_META, {
    completed_at: new Date().toISOString(),
    migrated_operations: migratedOps,
  });
  return migratedOps;
}

async function syncNow() {
  if (peopleV2Mode) return syncPeopleV2();
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    const hasCredential = Boolean(await store.getMeta(TOKEN_META));
    if (navigator.onLine === false) {
      setStatus(`Offline · ${hasCredential ? 'Dropbox ansluten · ' : ''}ändringar sparas lokalt`, 'warning');
      connectButton.textContent = hasCredential ? 'Offline · Dropbox ansluten' : 'Anslut Dropbox när du är online';
      return null;
    }
    const token = await currentAccessToken();
    if (!token) {
      setStatus(DROPBOX_CLIENT_ID ? 'Lokalt sparat · Dropbox ej ansluten' : 'Lokalt sparat · Dropbox-app återstår', 'warning');
      connectButton.textContent = DROPBOX_CLIENT_ID ? 'Anslut Dropbox' : 'Dropbox-konfiguration återstår';
      return null;
    }
    connectButton.textContent = 'Synka Dropbox';
    setStatus('Synkar…');
    // Ny transportidentitet gör att en gammal /ops-cursor aldrig återanvänds
    // mot den nya namnrymden. Oföränderliga batcher tål säker återuppladdning.
    const transport = new DropboxTransport({ accessToken: token, id: 'dropbox-matrikel-v2', opsRoot: MATRIKEL_OPS_ROOT });
    const migratedLegacyOps = await migrateLateLegacyBatches(transport, token);
    const bootstrapUploaded = await uploadBootstrapIfNeeded(transport);
    const engine = new SyncEngine({ repository, transport });
    const result = await engine.syncOnce();
    await Promise.all([
      fastigheterMaster.sync(new DropboxTransport({ accessToken: token, id: 'dropbox-fastigheter-read', opsRoot: '/fastigheter/ops', readOnly: true })),
      kartdataMaster.sync(new DropboxTransport({ accessToken: token, id: 'dropbox-kartdata-read', opsRoot: '/kartdata/ops', readOnly: true })),
    ]);
    refreshedRepositoryRevision = -1;
    render();
    familyModelButton.hidden = !isSourceTree || Boolean((await store.getMeta(FAMILY_MODEL_META))?.applied) || !currentPeople.length;
    if (!currentPeople.length) setStatus('Dropbox ansluten · ingen privat master hittades ännu', 'warning');
    else setStatus(`Synkad · ${bootstrapUploaded + result.uploadedOps} upp, ${result.downloadedOps} ned${migratedLegacyOps ? ` · ${migratedLegacyOps} äldre operationer flyttade` : ''}`, 'ok');
    return result;
  })().catch((error) => {
    console.error(error);
    if (isOfflineError(error)) {
      setStatus('Offline · lokalt sparat · synkas automatiskt när nätet återkommer', 'warning');
      return null;
    }
    setStatus(`Åtgärd krävs · ${error.message}`, 'error');
    throw error;
  }).finally(() => { syncPromise = null; });
  return syncPromise;
}

async function connectDropbox() {
  if (!DROPBOX_CLIENT_ID) return;
  sessionStorage.setItem('korpholmen:oauth-return', new URL('personer-familjer/', redirectUri()).pathname);
  const attempt = await beginDropboxOAuth({ clientId: DROPBOX_CLIENT_ID, redirectUri: redirectUri(), scopes: DROPBOX_SCOPES });
  location.assign(attempt.url);
}

async function syncPeopleV2() {
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    let localTransport = null;
    if (isSourceTree) {
      try {
        const response = await fetch('/personer-familjer/active.json', { method: 'HEAD', cache: 'no-store' });
        if (response.ok) localTransport = new HttpReadTransport();
      } catch { /* Dropbox eller verifierad cache används. */ }
    }
    const token = localTransport ? null : await currentAccessToken();
    if (!localTransport && !token) {
      peopleV2Controller.render();
      setStatus(peopleV2Runtime.hasData() ? 'Offline · senast verifierade Personmaster visas' : 'Anslut Dropbox för att läsa Personmastern', 'warning');
      connectButton.textContent = 'Anslut Dropbox';
      return null;
    }
    setStatus('Läser aktiv Person- och Matrikelmaster…');
    const transport = localTransport || new ActiveDropboxTransport({ accessToken: token, id: 'dropbox-people-active-v2', opsRoot: '/personer-familjer/ops', readOnly: true });
    const result = await peopleV2Runtime.sync(transport);
    peopleV2Controller.render();
    connectButton.textContent = token ? 'Synka Dropbox' : 'Lokal V2-master';
    setStatus(result.contextError
      ? `Personmaster · revision ${result.peopleRevision} · övriga register visas från verifierad cache`
      : `Personmaster · revision ${result.peopleRevision} · Matrikel revision ${result.matrikelRevision} · fyra sammanhangsregister`,
    result.contextError ? 'warning' : 'ok');
    const route = new URL(location.href).searchParams;
    const requestedPerson = route.get('person');
    const requestedFamily = route.get('family');
    if (requestedPerson) peopleV2Controller.open(requestedPerson, { updateUrl: false });
    else if (requestedFamily) peopleV2Controller.openFamily(requestedFamily, { updateUrl: false });
    return result;
  })().catch(error => {
    console.error(error);
    if (peopleV2Runtime?.hasData()) {
      peopleV2Controller.render();
      setStatus(`Senast verifierade Personmaster visas · ${error.message}`, 'warning');
      return null;
    }
    setStatus(`Åtgärd krävs · ${error.message}`, 'error');
    throw error;
  }).finally(() => { syncPromise = null; });
  return syncPromise;
}

async function connectOrSyncDropbox() {
  const token = await currentAccessToken();
  if (token) return syncNow();
  return connectDropbox();
}

async function bootstrapLocal() {
  if (!isSourceTree) throw new Error('Startkopian kan bara aktiveras från källappen');
  setStatus('Läser den låsta startkopian…');
  const response = await fetch(LOCAL_BOOTSTRAP_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Startkopian kunde inte läsas (${response.status})`);
  const document = await response.json();
  if (document.operations_version !== 1 || !Array.isArray(document.operations)) throw new Error('Startkopian har fel format');
  document.operations.forEach(validateOperation);
  await repository.applyRemoteOps(document.operations);
  try {
    const metadataResponse = await fetch(LOCAL_UI_METADATA_URL, { cache: 'no-store' });
    if (metadataResponse.ok) {
      const metadata = await metadataResponse.json();
      metadata.operations.forEach(validateOperation);
      await repository.applyRemoteOps(metadata.operations);
    }
    const approvedResponse = await fetch(LOCAL_APPROVED_DATA_URL, { cache: 'no-store' });
    if (approvedResponse.ok) {
      const approved = await approvedResponse.json();
      approved.operations.forEach(validateOperation);
      await repository.applyRemoteOps(approved.operations);
    }
    const externalOwnersResponse = await fetch(LOCAL_EXTERNAL_PROPERTY_OWNERS_URL, { cache: 'no-store' });
    if (externalOwnersResponse.ok) {
      const externalOwners = await externalOwnersResponse.json();
      externalOwners.operations.forEach(validateOperation);
      await repository.applyRemoteOps(externalOwners.operations);
    }
  } catch (error) {
    console.warn('Kompletterande godkända data kunde inte läsas lokalt', error);
  }
  await store.putMeta(BOOTSTRAP_META, { pending: true, device_id: document.device_id, migration_id: document.migration_id, operations: document.operations.length });
  bootstrapButton.hidden = true;
  render();
  familyModelButton.hidden = Boolean((await store.getMeta(FAMILY_MODEL_META))?.applied);
  setStatus('Godkänd startkopia aktiverad lokalt · väntar på Dropbox', 'ok');
}

function showRelationshipPath() {
  const from = lookupPerson($('#rel-a').value);
  const to = lookupPerson($('#rel-b').value);
  if (!from || !to) {
    relationPathNode.hidden = false;
    relationPathNode.textContent = 'Välj två entydiga personer ur listorna.';
    return;
  }
  const path = relationshipPath(from.id, to.id, graph);
  ui.pathIds = new Set(path ? [from.id, ...path.map((step) => step.to)] : []);
  relationPathNode.hidden = false;
  relationPathNode.innerHTML = path == null
    ? `Ingen registrerad väg hittades mellan <b>${escapeHtml(from.display_name)}</b> och <b>${escapeHtml(to.display_name)}</b>.`
    : path.length === 0
      ? 'Du har valt samma person två gånger.'
      : `<b>${escapeHtml(from.display_name)} → ${escapeHtml(to.display_name)}</b><ol>${path.map((step) => `<li>${escapeHtml(relationDescription(step, graph))}</li>`).join('')}</ol>`;
  render();
}

function findPerson() {
  const person = lookupPerson(personSearch.value);
  if (!person) {
    setEditStatus('Hittade ingen entydig person med det namnet.', 'error');
    return;
  }
  selectPerson(person.id, true);
}

contentNode.addEventListener('click', (event) => {
  if (event.target.closest('[data-action="create-family-unit"]')) return createGroup(FAMILY_UNIT_TYPE);
  if (event.target.closest('[data-action="create-kin-group"]')) return createGroup(KIN_GROUP_TYPE);
  const groupButton = event.target.closest('[data-group-id]');
  if (groupButton) return renderGroupDrawer(groupButton.dataset.groupType, groupButton.dataset.groupId);
  const personButton = event.target.closest('[data-person-id]');
  if (personButton) selectPerson(personButton.dataset.personId, false);
});

drawer.addEventListener('click', (event) => {
  if (event.target.closest('[data-action="close-drawer"]')) closeDrawer();
  const open = event.target.closest('[data-open-person]');
  if (open) selectPerson(open.dataset.openPerson, true);
  const remove = event.target.closest('[data-delete-relation]');
  if (remove) deleteRelation(remove.dataset.deleteRelation);
  const removeProperty = event.target.closest('[data-delete-property-link]');
  if (removeProperty) deletePropertyLink(removeProperty.dataset.deletePropertyLink);
  if (event.target.closest('[data-action="add-relation"]')) addRelation();
  if (event.target.closest('[data-action="add-property"]')) addPropertyLink();
  if (event.target.closest('[data-action="add-group-anchor"]')) addGroupAnchor();
  if (event.target.closest('[data-action="add-group-member"]')) addGroupMember();
  const removeAnchor = event.target.closest('[data-remove-group-anchor]');
  if (removeAnchor) removeGroupAnchor(removeAnchor.dataset.removeGroupAnchor);
  const removeMember = event.target.closest('[data-remove-group-member]');
  if (removeMember) removeGroupMember(removeMember.dataset.removeGroupMember);
  if (event.target.closest('[data-action="delete-group"]')) deleteGroup();
  if (event.target.closest('[data-action="delete-person"]')) deletePerson();
});

drawer.addEventListener('change', (event) => {
  const groupField = event.target.closest('[data-group-field]');
  if (groupField && ui.selectedGroup) {
    const value = parseFieldValue(groupField);
    if (groupField.dataset.groupField === 'name' && !value) {
      setEditStatus('Gruppnamnet får inte vara tomt.', 'error');
      return renderGroupDrawer(ui.selectedGroup.entityType, ui.selectedGroup.id);
    }
    syncEdit(() => repository.setField(ui.selectedGroup.entityType, ui.selectedGroup.id, groupField.dataset.groupField, value));
    return;
  }
  const groupParent = event.target.closest('[data-group-parent]');
  if (groupParent && ui.selectedGroup) {
    updateGroupParent(groupParent.value);
    return;
  }
  const familyKinGroup = event.target.closest('[data-family-kin-group]');
  if (familyKinGroup && ui.selectedGroup) {
    updateFamilyKinGroup(familyKinGroup.dataset.familyKinGroup, familyKinGroup.checked);
    return;
  }
  const personField = event.target.closest('[data-person-field]');
  if (personField) {
    const field = personField.dataset.personField;
    const value = parseFieldValue(personField);
    if (field === 'display_name' && !value) {
      setEditStatus('Visningsnamnet får inte vara tomt.', 'error');
      renderDrawer(ui.selectedPersonId);
      return;
    }
    syncEdit(() => repository.setField('person', ui.selectedPersonId, field, value));
    return;
  }
  const relationField = event.target.closest('[data-relation-field]');
  if (relationField) syncEdit(() => repository.setField('relation', relationField.dataset.relationId, relationField.dataset.relationField, parseFieldValue(relationField)));
});

$('#find-person').addEventListener('click', findPerson);
personSearch.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); findPerson(); } });
$('#find-rel').addEventListener('click', showRelationshipPath);
filterToggle.addEventListener('click', () => filterPanel.hidden ? openFilterPanel() : closeFilterPanel());
filterBackdrop.addEventListener('click', () => closeFilterPanel());
filterPanel.addEventListener('click', (event) => {
  if (event.target.closest('[data-close-filter]')) closeFilterPanel();
});
activeFiltersNode.addEventListener('click', (event) => {
  const button = event.target.closest('[data-clear-filter]');
  if (button) clearFilter(button.dataset.clearFilter);
});
relationToggle.addEventListener('click', toggleRelationTools);
clanJump.addEventListener('change', () => {
  if (!clanJump.value) return;
  document.getElementById(`clan-${slug(clanJump.value)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('#toggle-names').addEventListener('click', (event) => {
  ui.clubNamesFirst = !ui.clubNamesFirst;
  event.currentTarget.setAttribute('aria-pressed', String(ui.clubNamesFirst));
  event.currentTarget.textContent = ui.clubNamesFirst ? 'Visa personnamn först' : 'Visa klubbnamn först';
  render();
});
$('#toggle-gaps').addEventListener('click', (event) => {
  ui.showGaps = !ui.showGaps;
  event.currentTarget.setAttribute('aria-pressed', String(ui.showGaps));
  render();
});
islandFilter.addEventListener('change', () => { ui.island = islandFilter.value; render(); });
livingFilter.addEventListener('change', () => { ui.living = livingFilter.value; render(); });
propertyFilter.addEventListener('change', () => { ui.property = propertyFilter.value; render(); });
generationButtons.addEventListener('click', (event) => {
  const button = event.target.closest('[data-generation]');
  if (!button) return;
  const generation = button.dataset.generation;
  if (generation === 'all') ui.generations.clear();
  else if (ui.generations.has(generation)) ui.generations.delete(generation);
  else ui.generations.add(generation);
  render();
});
$('#include-inlaws').addEventListener('change', (event) => { ui.includeInlaws = event.currentTarget.checked; render(); });
$('#toggle-lonely').addEventListener('click', (event) => {
  ui.onlyUnlinked = !ui.onlyUnlinked;
  event.currentTarget.setAttribute('aria-pressed', String(ui.onlyUnlinked));
  render();
});
$('#year-on').addEventListener('click', (event) => {
  ui.yearOn = !ui.yearOn;
  event.currentTarget.setAttribute('aria-pressed', String(ui.yearOn));
  $('#year-slider').disabled = !ui.yearOn;
  $('#year-out').textContent = ui.yearOn ? ui.year : 'alla år';
  render();
});
const renderYear = debounce(render, 80);
$('#year-slider').addEventListener('input', (event) => { ui.year = Number(event.currentTarget.value); $('#year-out').textContent = ui.year; renderYear(); });
document.querySelectorAll('[data-view-mode]').forEach((button) => button.addEventListener('click', () => {
  ui.view = button.dataset.viewMode;
  ui.review = false;
  render();
}));
$('#review-button').addEventListener('click', () => { ui.review = !ui.review; render(); });
connectButton.addEventListener('click', () => connectOrSyncDropbox().catch(() => {}));
bootstrapButton.addEventListener('click', () => bootstrapLocal().catch((error) => setStatus(error.message, 'error')));
familyModelButton.addEventListener('click', () => applyFamilyModelLocal().catch(error => setEditStatus(error.message, 'error')));
document.addEventListener('keydown', handleGlobalKeydown);
window.addEventListener('online', () => syncNow().catch(() => {}));
window.addEventListener('korpholmen:dropbox-ready', () => syncNow().catch(() => {}));
window.addEventListener('offline', () => syncNow().catch(() => {}));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow().catch(() => {}); });

async function init() {
  const serviceWorkerPromise = registerServiceWorker();
  const db = await openSlaktlandskapDB();
  store = new IndexedDBStore(db);
  if (peopleV2Mode) {
    await completeOAuthCallback();
    peopleV2Runtime = await createPeopleV2Runtime({ store }).init();
    peopleV2Controller = createPeopleV2Controller({ runtime: peopleV2Runtime, content: contentNode, drawer, drawerContent, statusNode });
    peopleV2Controller.configureShell();
    peopleV2Controller.render();
    await syncPeopleV2();
    const route = new URL(location.href).searchParams;
    const requestedPerson = route.get('person');
    const requestedFamily = route.get('family');
    if (requestedPerson) peopleV2Controller.open(requestedPerson, { updateUrl: false });
    else if (requestedFamily) peopleV2Controller.openFamily(requestedFamily, { updateUrl: false });
    await serviceWorkerPromise;
    return;
  }
  repository = await new Repository({ store, deviceId: await deviceId() }).init();
  fastigheterMaster = await new ReadOnlyMaster({ store, cacheKey: 'fastigheter' }).init();
  kartdataMaster = await new ReadOnlyMaster({ store, cacheKey: 'kartdata' }).init();
  bootstrapButton.hidden = !isSourceTree || personRecords().length > 0;
  familyModelButton.hidden = !isSourceTree || Boolean((await store.getMeta(FAMILY_MODEL_META))?.applied) || personRecords().length === 0;
  connectButton.textContent = DROPBOX_CLIENT_ID ? 'Kontrollerar Dropbox…' : 'Dropbox-konfiguration återstår';
  connectButton.disabled = !DROPBOX_CLIENT_ID;
  $('#year-slider').max = new Date().getFullYear();
  $('#year-slider').value = ui.year;
  render();
  await completeOAuthCallback();
  await syncNow();
  await serviceWorkerPromise;
}

init().catch((error) => {
  console.error(error);
  setStatus(`Kunde inte starta · ${error.message}`, 'error');
});
