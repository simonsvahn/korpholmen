import {
  DropboxTransport,
  IndexedDBStore,
  Repository,
  SyncEngine,
  beginDropboxOAuth,
  completeDropboxOAuth,
  createBatch,
  openSlaktlandskapDB,
  validateOperation,
} from './data-layer.js?v=2026-08-01-10';
import { propertyLinkEntityId, relationEntityId } from './domain/slakt-schema.js?v=2026-08-01-10';
import {
  buildGraph,
  clanBase,
  clanDetail,
  componentSets,
  familyHue,
  generationFor,
  groupPeople,
  groupPeopleByProperty,
  lineageIds,
  membership,
  normalizeText,
  personPropertyIds,
  relationDescription,
  relationshipPath,
  resolvedIslands,
  shownName,
  visiblePersonIds,
} from './landscape-model.js?v=2026-08-01-10';
import { DROPBOX_CLIENT_ID, DROPBOX_SCOPES, LOCAL_APPROVED_DATA_URL, LOCAL_BOOTSTRAP_URL, LOCAL_UI_METADATA_URL } from './config.js?v=2026-08-01-10';
import { exchangeDropboxRefreshToken } from './sync/oauth-pkce.js?v=2026-08-01-10';

const $ = (selector) => document.querySelector(selector);
const statusNode = $('#sync-status');
const editStatusNode = $('#edit-status');
const contentNode = $('#content');
const connectButton = $('#connect-dropbox');
const bootstrapButton = $('#bootstrap-local');
const drawer = $('#person-drawer');
const drawerContent = $('#drawer-content');
const personSearch = $('#person-search');
const clanJump = $('#clan-jump');
const islandFilter = $('#island-filter');
const livingFilter = $('#living-filter');
const propertyFilter = $('#property-filter');
const generationButtons = $('#generation-buttons');
const relationPathNode = $('#relation-path');
const isSourceTree = location.pathname.includes('/apps/matrikel/');
const TOKEN_META = 'dropbox:refresh-token-v1';
const BOOTSTRAP_META = 'bootstrap:migration-2026-08-01';

let repository;
let store;
let accessToken = null;
let accessTokenExpiresAt = 0;
let syncPromise = null;
let graph = null;
let currentPeople = [];
let currentRelations = [];
let currentProperties = [];
let currentPropertyLinks = [];
let propertyById = new Map();

const ui = {
  selectedPersonId: null,
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
  view: 'landscape',
  grouping: 'clan',
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
const isOfflineError = error => navigator.onLine === false || error instanceof TypeError || /failed to fetch|load failed|networkerror|internetanslutning|network connection/i.test(String(error?.message || error));

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return null;
  try {
    const hadController = Boolean(navigator.serviceWorker.controller);
    if (hadController) {
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading) return;
        reloading = true;
        location.reload();
      }, { once: true });
    }
    return await navigator.serviceWorker.register('./sw.js', { scope: './' });
  } catch (error) {
    console.warn('Appskalet kunde inte uppdateras', error);
    return null;
  }
}

function setStatus(text, tone = '') {
  statusNode.textContent = text;
  statusNode.dataset.tone = tone;
}

function setEditStatus(text, tone = '') {
  editStatusNode.textContent = text;
  editStatusNode.dataset.tone = tone;
}

function redirectUri() {
  return new URL(isSourceTree ? '../../' : '../', location.href).href;
}

function deviceId() {
  const key = 'slaktlandskap:device-id';
  let value = localStorage.getItem(key);
  if (!value) {
    value = `slakt-web-${crypto.randomUUID()}`;
    localStorage.setItem(key, value);
  }
  return value;
}

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
  return repository.listEntities('property')
    .map((entity) => ({ id: entity.entity_id, ...entity.fields }))
    .sort((a, b) => a.id.localeCompare(b.id, 'sv', { numeric: true }));
}

function propertyLinkRecords() {
  return repository.listEntities('property-link')
    .map((entity) => ({ id: entity.entity_id, ...entity.fields }));
}

function refreshData() {
  const people = personRecords();
  currentRelations = relationRecords();
  currentProperties = propertyRecords();
  currentPropertyLinks = propertyLinkRecords();
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
  if (ui.selectedPersonId && !graph.byId.has(ui.selectedPersonId)) ui.selectedPersonId = null;
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
  clanJump.innerHTML = '<option value="">Välj klan …</option>' + groups
    .map((group) => `<option value="${escapeAttribute(group.name)}">${escapeHtml(group.name)}</option>`).join('');
  if (groups.some((group) => group.name === selectedClan)) clanJump.value = selectedClan;
  clanJump.disabled = ui.grouping === 'property';

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
    + currentProperties.map((property) => `<option value="${escapeAttribute(property.id)}">${escapeHtml(property.id)} · ${propertyCounts.get(property.id) || 0}</option>`).join('')
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
    const isUncertain = links.some((relation) => relation.confidence === 'osäker');
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

function renderStorfamily(name, people, visible, relatedIds) {
  const visiblePeople = people.filter((person) => visible.has(person.id));
  if (!visiblePeople.length) return '';
  const families = unique(visiblePeople.map((person) => person.family || 'utan familjegrupp')).sort((a, b) => a.localeCompare(b, 'sv'));
  const components = componentSets(people, currentRelations);
  const connected = components.filter((component) => component.size > 1 && [...component].some((id) => visible.has(id)));
  const isolated = components.filter((component) => component.size === 1)
    .flatMap((component) => [...component])
    .filter((id) => visible.has(id))
    .map((id) => graph.byId.get(id))
    .filter(Boolean)
    .sort((a, b) => shownName(a).localeCompare(shownName(b), 'sv'));
  return `<section class="storfamily">
    <div class="storfamily-header"><h3>Storfamilj: ${escapeHtml(clanDetail(name))}</h3><div class="family-list">${visiblePeople.length} personer · ${escapeHtml(families.join(' · '))}</div></div>
    <div class="forest">${connected.map((component) => renderComponent(component, visible, relatedIds)).join('') || '<p class="empty-note">Inga belagda relationer inom gruppen.</p>'}</div>
    ${isolated.length ? `<section class="unlinked"><h4>Ännu inte kopplade till en bestämd släktgren · ${isolated.length}</h4><div class="unlinked-grid">${isolated.map((person) => renderPersonCard(person, relatedIds)).join('')}</div></section>` : ''}
  </section>`;
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
      <header class="clan-header"><h2>${escapeHtml(group.name)}</h2><div class="clan-meta">${visibleCount} personer${islands.length ? ` · ${escapeHtml(islands.join(' · '))}` : ''}</div></header>
      ${[...group.families.entries()].map(([name, entries]) => renderStorfamily(name, entries, visible, relatedIds)).join('')}
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
      <header class="property-header"><div><p class="property-kicker">${group.id === '__none__' ? 'Ofullständig koppling' : 'Fastighet'}</p><h2>${escapeHtml(group.id === '__none__' ? property.display_name : property.id)}</h2>${group.id !== '__none__' && property.label ? `<p>${escapeHtml(property.label)}</p>` : ''}</div><div class="property-meta">${people.length} personer${island ? ` · ${escapeHtml(island)}` : ''}</div></header>
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
  return `<section class="register"><table><thead><tr><th>Person</th><th>Lever</th><th>År</th><th>Familj</th><th>Fastighet</th><th>Ö</th><th>Medlemsläge</th></tr></thead><tbody>${rows}</tbody></table></section>`;
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
  if (!currentPeople.length) {
    contentNode.innerHTML = '<section class="empty-card"><h2>Ingen privat släktdata på den här enheten ännu</h2><p>Anslut Dropbox för att hämta den privata mastern.</p></section>';
    closeDrawer(false);
    return;
  }
  const visible = visiblePersonIds(currentPeople, graph, ui);
  const relatedIds = ui.selectedPersonId ? lineageIds(ui.selectedPersonId, graph) : new Set();
  const body = ui.review
    ? renderReview()
    : ui.view === 'register'
      ? renderRegister(visible)
      : ui.grouping === 'property'
        ? renderPropertyLandscape(visible, relatedIds)
        : renderLandscape(visible, relatedIds);
  contentNode.innerHTML = `<section class="summary" aria-label="Datasammanfattning"><div><strong>${currentPeople.length}</strong><span>personer</span></div><div><strong>${currentRelations.length}</strong><span>relationer</span></div><div><strong>${currentProperties.length}</strong><span>fastigheter</span></div><div><strong>${currentPropertyLinks.length}</strong><span>fastighetsband</span></div><div><strong>${visible.size}</strong><span>visas</span></div></section>${body || '<p class="empty-note">Inga personer matchar filtren.</p>'}`;
  $('#filter-count').textContent = `${visible.size} av ${currentPeople.length} personer`;
  document.body.classList.toggle('show-gaps', ui.showGaps);
  document.body.classList.toggle('has-selection', Boolean(ui.selectedPersonId));
  $('#view-toggle').textContent = ui.view === 'register' ? 'Visa släktlandskap' : 'Visa personregister';
  $('#view-toggle').setAttribute('aria-pressed', String(ui.view === 'register'));
  $('#group-toggle').textContent = ui.grouping === 'property' ? 'Gruppera per släkt' : 'Gruppera per fastighet';
  $('#group-toggle').setAttribute('aria-pressed', String(ui.grouping === 'property'));
  $('#review-button').setAttribute('aria-pressed', String(ui.review));
  if (ui.selectedPersonId) renderDrawer(ui.selectedPersonId);
}

function relationRows(links, role) {
  if (!links.length) return '<li class="empty-note">Inga registrerade</li>';
  return links.map((link) => {
    const person = graph.byId.get(link.id);
    const relation = link.relation;
    if (!person) return '';
    const derived = relation.derived;
    return `<li class="relation-row"><button type="button" class="relation-person" data-open-person="${escapeAttribute(person.id)}">${escapeHtml(person.display_name)}${derived ? ' · medförälder' : ''}</button>${derived ? '<span>härledd</span>' : `<select data-relation-field="confidence" data-relation-id="${escapeAttribute(relation.id)}" aria-label="Säkerhet"><option value="säker" ${relation.confidence === 'säker' ? 'selected' : ''}>säker</option><option value="trolig" ${relation.confidence === 'trolig' ? 'selected' : ''}>trolig</option><option value="osäker" ${relation.confidence === 'osäker' ? 'selected' : ''}>osäker</option><option value="okänt" ${!relation.confidence || relation.confidence === 'okänt' ? 'selected' : ''}>okänt</option></select><button type="button" class="icon-button" data-delete-relation="${escapeAttribute(relation.id)}" aria-label="Ta bort relation till ${escapeAttribute(person.display_name)}">×</button>`}</li>`;
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
  const parents = graph.parents.get(person.id) || [];
  const partners = (graph.partners.get(person.id) || []).filter((link) => !link.relation.derived);
  const children = graph.children.get(person.id) || [];
  const propertyLinks = currentPropertyLinks.filter((link) => link.person_id === person.id && propertyById.has(link.property_id));
  const linkedPropertyIds = new Set(propertyLinks.map((link) => link.property_id));
  const availableProperties = currentProperties.filter((property) => !linkedPropertyIds.has(property.id));
  const islands = unique([...currentProperties.map((property) => property.island), ...currentPeople.map((entry) => entry.legacy_island)].filter(Boolean)).sort((a, b) => a.localeCompare(b, 'sv'));
  const propertyRows = propertyLinks.map((link) => {
    const property = propertyById.get(link.property_id);
    return `<li class="property-link-row"><span><b>${escapeHtml(property.id)}</b>${property.island ? ` · ${escapeHtml(property.island)}` : ''}</span><button type="button" class="icon-button" data-delete-property-link="${escapeAttribute(link.id)}" aria-label="Ta bort fastighetskopplingen till ${escapeAttribute(property.id)}">×</button></li>`;
  }).join('');
  drawerContent.innerHTML = `<h2>${escapeHtml(person.display_name)}</h2><p class="drawer-meta">${escapeHtml([person.club_name, years(person), person.family, ...islandNames(person)].filter(Boolean).join(' · '))}</p>
    <h3>Personuppgifter</h3>
    <div class="editor-grid">
      <label class="editor-field wide"><span>Visningsnamn</span><input data-person-field="display_name" value="${escapeAttribute(person.display_name || '')}"></label>
      <label class="editor-field wide"><span>Fullständigt namn</span><input data-person-field="full_name" value="${escapeAttribute(person.full_name || '')}"></label>
      <label class="editor-field"><span>Född</span><input inputmode="numeric" data-person-field="birth" data-value-type="number" value="${escapeAttribute(person.birth ?? '')}"></label>
      <label class="editor-field"><span>Död</span><input inputmode="numeric" data-person-field="death" data-value-type="number" value="${escapeAttribute(person.death ?? '')}"></label>
      <label class="editor-field"><span>Lever</span><select data-person-field="living">${selectOptions([['okänt', 'okänt'], ['ja', 'ja'], ['nej', 'nej']], person.living || 'okänt')}</select></label>
      <label class="editor-field"><span>Medlemsläge</span><select data-person-field="membership_status">${selectOptions([['aktuell', 'aktuell'], ['tidigare', 'tidigare'], ['förväntad', 'förväntad'], ['ej', 'ej medlem']], person.membership_status)}</select></label>
      <label class="editor-field wide"><span>KBK-namn</span><input data-person-field="club_name" value="${escapeAttribute(person.club_name || '')}"></label>
      <label class="editor-field wide"><span>Familj/släkt</span><input data-person-field="family" value="${escapeAttribute(person.family || '')}"></label>
      <label class="editor-field wide"><span>Klan i landskapet</span><input data-person-field="ui_clan" value="${escapeAttribute(person.ui_clan || person.family || '')}"></label>
      <label class="editor-field"><span>Presentationsroll</span><select data-person-field="ui_is_inlaw" data-value-type="boolean">${selectOptions([['false', 'född i/fristående'], ['true', 'ingift']], String(Boolean(person.ui_is_inlaw)))}</select></label>
      <label class="editor-field"><span>Generation</span><select data-person-field="ui_generation" data-value-type="number">${selectOptions([['', 'okänd'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5']], person.ui_generation ?? '')}</select></label>
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
    <div class="add-property"><select data-new-property-id><option value="">Välj fastighet …</option>${availableProperties.map((property) => `<option value="${escapeAttribute(property.id)}">${escapeHtml(property.id)}${property.island ? ` · ${escapeHtml(property.island)}` : ''}</option>`).join('')}</select><button type="button" data-action="add-property">Lägg till</button></div>
    <h3>Föräldrar</h3><ul class="relation-list">${relationRows(parents, 'parent')}</ul>
    <h3>Partner</h3><ul class="relation-list">${relationRows(partners, 'partner')}</ul>
    <h3>Barn</h3><ul class="relation-list">${relationRows(children, 'child')}</ul>
    <h3>Lägg till relation</h3>
    <div class="add-relation"><input list="drawer-person-options" data-new-relation-person placeholder="Välj person …"><select data-new-relation-kind><option value="parent">är förälder till vald person</option><option value="child">är barn till vald person</option><option value="partner">är partner med vald person</option><option value="former">var tidigare partner</option></select><button type="button" data-action="add-relation">Lägg till</button></div>
    <h3>Källa</h3><p class="drawer-meta">${escapeHtml(person.source || '—')}${person.wiki_page ? ` · ${escapeHtml(person.wiki_page)}` : ''}</p>
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
    document.body.classList.remove('has-selection');
    contentNode.querySelectorAll('.is-selected,.is-related').forEach((node) => node.classList.remove('is-selected', 'is-related'));
  }
}

function selectPerson(personId, scroll = false) {
  if (!graph.byId.has(personId)) return;
  ui.selectedPersonId = personId;
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
  } catch (error) {
    console.error(error);
    setEditStatus(`Kunde inte spara · ${error.message}`, 'error');
    render();
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
      { entityType: 'property-link', entityId: id, field: 'source', value: 'Direkt i Matrikeln' },
    ]);
  });
}

async function deletePropertyLink(id) {
  const link = currentPropertyLinks.find((entry) => entry.id === id);
  if (!link) return;
  const person = graph.byId.get(link.person_id)?.display_name || link.person_id;
  if (!window.confirm(`Ta bort fastighetskopplingen mellan ${person} och ${link.property_id}?`)) return;
  await syncEdit(() => repository.deleteEntity('property-link', id));
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
  } else {
    kind = 'partner';
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
      { entityType: 'relation', entityId: id, field: 'confidence', value: 'säker' },
      { entityType: 'relation', entityId: id, field: 'user_confirmed', value: 'ja' },
      { entityType: 'relation', entityId: id, field: 'source', value: 'Direkt i Matrikeln' },
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
  await syncEdit(() => repository.deleteEntity('relation', id));
}

async function deletePerson() {
  const person = graph.byId.get(ui.selectedPersonId);
  if (!person) return;
  const related = currentRelations.filter((relation) => relation.from_person_id === person.id || relation.to_person_id === person.id);
  const propertyLinks = currentPropertyLinks.filter((link) => link.person_id === person.id);
  if (!window.confirm(`Ta bort ${person.display_name}, personens ${related.length} relationer och ${propertyLinks.length} fastighetskopplingar? Borttagningen sparas som återställningsbar historik.`)) return;
  await syncEdit(() => repository.deleteEntities([
    ...related.map((relation) => ({ entityType: 'relation', entityId: relation.id })),
    ...propertyLinks.map((link) => ({ entityType: 'property-link', entityId: link.id })),
    { entityType: 'person', entityId: person.id },
  ]));
  ui.selectedPersonId = null;
  closeDrawer(false);
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

async function syncNow() {
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
    const transport = new DropboxTransport({ accessToken: token, id: 'dropbox-slaktlandskap' });
    const bootstrapUploaded = await uploadBootstrapIfNeeded(transport);
    const engine = new SyncEngine({ repository, transport });
    const result = await engine.syncOnce();
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    render();
    if (!currentPeople.length) setStatus('Dropbox ansluten · ingen privat master hittades ännu', 'warning');
    else setStatus(`Synkad · ${bootstrapUploaded + result.uploadedOps} upp, ${result.downloadedOps} ned`, 'ok');
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
  sessionStorage.setItem('korpholmen:oauth-return', new URL('matrikel/', redirectUri()).pathname);
  const attempt = await beginDropboxOAuth({ clientId: DROPBOX_CLIENT_ID, redirectUri: redirectUri(), scopes: DROPBOX_SCOPES });
  location.assign(attempt.url);
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
  } catch (error) {
    console.warn('Kompletterande godkända data kunde inte läsas lokalt', error);
  }
  await store.putMeta(BOOTSTRAP_META, { pending: true, device_id: document.device_id, migration_id: document.migration_id, operations: document.operations.length });
  bootstrapButton.hidden = true;
  render();
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
  if (event.target.closest('[data-action="delete-person"]')) deletePerson();
});

drawer.addEventListener('change', (event) => {
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
$('#year-slider').addEventListener('input', (event) => { ui.year = Number(event.currentTarget.value); $('#year-out').textContent = ui.year; render(); });
$('#view-toggle').addEventListener('click', () => { ui.view = ui.view === 'register' ? 'landscape' : 'register'; ui.review = false; render(); });
$('#group-toggle').addEventListener('click', () => { ui.grouping = ui.grouping === 'property' ? 'clan' : 'property'; ui.view = 'landscape'; ui.review = false; render(); });
$('#review-button').addEventListener('click', () => { ui.review = !ui.review; render(); });
connectButton.addEventListener('click', () => connectOrSyncDropbox().catch(() => {}));
bootstrapButton.addEventListener('click', () => bootstrapLocal().catch((error) => setStatus(error.message, 'error')));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDrawer(); });
window.addEventListener('online', () => syncNow().catch(() => {}));
window.addEventListener('offline', () => syncNow().catch(() => {}));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow().catch(() => {}); });

async function init() {
  const serviceWorkerPromise = registerServiceWorker();
  const db = await openSlaktlandskapDB();
  store = new IndexedDBStore(db);
  repository = await new Repository({ store, deviceId: deviceId() }).init();
  bootstrapButton.hidden = !isSourceTree || personRecords().length > 0;
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
