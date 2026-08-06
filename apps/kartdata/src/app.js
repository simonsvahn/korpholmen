import {
  DropboxTransport,
  IndexedDBStore,
  Repository,
  SyncEngine,
  beginDropboxOAuth,
  completeDropboxOAuth,
  createRevisionCache,
  debounce,
  exchangeDropboxRefreshToken,
  isOfflineError,
  openSlaktlandskapDB,
  registerKorpholmenServiceWorker,
  resolveDeviceId,
  validateOperation,
} from '../../../packages/core/data-layer.js';
import { resolveCurrentOwners, resolvePropertyReferences } from '../../../packages/core/master-data.js';
import { ReadOnlyMaster } from '../../../packages/core/read-only-master.js';
import { CLEAN_V2_BOOTSTRAP_URL, DROPBOX_CLIENT_ID, DROPBOX_SCOPES } from './config.js';
import {
  OBJECT_CLASSES,
  REVIEW_STATUSES,
  classLabel,
  entryIdNumber,
  islandDeletionRefs,
  objectTypeLabel,
  reviewStatusLabel,
  splitList,
  stableEntityId,
} from './model.js?v=2026-08-04-2';
import { propertySelectionState, validatePropertySelection } from './property-selection.js';

const $ = selector => document.querySelector(selector);
const content = $('#content');
const summary = $('#summary');
const drawer = $('#entry-drawer');
const drawerContent = $('#drawer-content');
const backdrop = $('#backdrop');
const statusNode = $('#sync-status');
const undoNode = $('#undo-status');
const connectButton = $('#connect-dropbox');
const bootstrapButton = $('#bootstrap-local');
const isSourceTree = location.pathname.includes('/apps/kartdata/');
const TOKEN_META = 'dropbox:refresh-token';
const CLEAN_V2_META = 'bootstrap:kartdata-clean-v2-2026-08-04';

let store;
let repository;
let fastigheterMaster;
let matrikelMaster;
let accessToken = null;
let accessTokenExpiresAt = 0;
let syncPromise = null;
let selectedEntryId = null;
let selectedIslandId = null;
const ui = { search: '', island: '', objectClass: '', subtype: '', property: '', status: '', sort: 'name', view: 'atlas' };
const viewCache = createRevisionCache(() => `${repository?.revision || 0}:${fastigheterMaster?.revision || 0}:${matrikelMaster?.revision || 0}`);

const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const escapeAttribute = escapeHtml;
const normalize = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('sv');
const cssToken = value => String(value || '').replaceAll(' ', '-');
const unique = values => [...new Set(values.filter(Boolean))];
const recordList = type => viewCache(`records:${type}`, () => repository.listEntities(type).map(entity => ({ id: entity.entity_id, ...entity.fields })));
const entryRecords = () => viewCache('data-entries', () => [...recordList('data-entry')].sort((a, b) => entryIdNumber(a.id) - entryIdNumber(b.id)));
const islandRecords = () => viewCache('islands', () => recordList('place').filter(place => place.subtype === 'ö').sort((a, b) => String(a.preferred_name || '').localeCompare(String(b.preferred_name || ''), 'sv')));
const nameRecords = () => recordList('name-record');
const islandLinks = () => recordList('data-entry-island-link');
const entryPropertyLinks = () => recordList('data-entry-property-link');
const legacyPropertyRefs = () => recordList('property-ref');
const propertyRefs = () => resolvePropertyReferences(fastigheterMaster, legacyPropertyRefs()).sort((a, b) => String(a.external_id || '').localeCompare(String(b.external_id || ''), 'sv', { numeric: true }));
const legacyOwnerLinks = () => recordList('property-owner-link').filter(link => link.basis === 'best-known-current');
const legacyPersonRefs = () => recordList('person-ref');
const legacyExternalParties = () => recordList('external-party');
const placeRelations = () => recordList('place-relation');
const oldPropertyLinks = () => recordList('object-property-link');
function setStatus(text, tone = '') { statusNode.textContent = text; statusNode.className = tone ? `status-${tone}` : ''; }
function setUndoStatus(text, tone = '') { undoNode.hidden = !text; undoNode.textContent = text; undoNode.className = tone ? `status-${tone}` : ''; }
function offerUndo(message, restoreEntries, restoredMessage) {
  const actionId = crypto.randomUUID(); setUndoStatus(message, 'warning'); undoNode.dataset.undoAction = actionId;
  const button = document.createElement('button'); button.type = 'button'; button.className = 'undo-action'; button.textContent = 'Ångra';
  button.addEventListener('click', async () => {
    if (undoNode.dataset.undoAction !== actionId) return; delete undoNode.dataset.undoAction; button.disabled = true; setUndoStatus('Återställer…', 'warning');
    try { await repository.restoreEntities(restoreEntries); render(); try { await syncNow(); } catch (_) { /* Lokalt återställd. */ } setUndoStatus(restoredMessage, 'ok'); }
    catch (error) { setUndoStatus(`Kunde inte återställa · ${error.message}`, 'error'); }
  }, { once: true });
  undoNode.append(' · ', button);
  window.setTimeout(() => { if (undoNode.dataset.undoAction === actionId) { delete undoNode.dataset.undoAction; setUndoStatus(`${message} · återställningshistoriken är bevarad`, 'ok'); } }, 15_000);
}
const deviceId = () => resolveDeviceId({ store, key: 'korpholmen:kartdata-device-id', prefix: 'kartdata-web-' });
function redirectUri() { return new URL(isSourceTree ? '../../' : '../', location.href).href; }
function option(value, selected, label) { return `<option value="${escapeAttribute(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`; }
function queueRank(value) { return ({ osäker: 0, ogranskad: 1, rättad: 2, bekräftad: 3, utgår: 4 }[value] ?? 5); }
function nameTypeLabel(value) { return ({ föredraget: 'Föredraget', officiellt: 'Officiellt', alias: 'Alternativt', historiskt: 'Historiskt' }[value] || value || 'Namnform'); }

function islandForEntry(entryId) {
  const link = islandLinks().find(item => item.entry_id === entryId);
  return link ? islandRecords().find(island => island.id === link.island_id) || null : null;
}
function propertyIdsForEntry(entryId) { return entryPropertyLinks().filter(link => link.entry_id === entryId).map(link => link.property_id).sort((a, b) => a.localeCompare(b, 'sv', { numeric: true })); }
function propertyRefById(propertyId) { return propertyRefs().find(item => item.external_id === propertyId) || null; }
function legacyOwnersForProperty(propertyId) {
  return legacyOwnerLinks().filter(link => link.property_id === propertyId).map(link => {
    const ref = link.owner_type === 'person-ref'
      ? legacyPersonRefs().find(item => item.external_id === link.owner_id)
      : legacyExternalParties().find(item => item.external_id === link.owner_id);
    return ref ? { ...link, display_name: ref.display_name, url: ref.url || '#', source_master: ref.source_master, party_type: ref.party_type } : null;
  }).filter(Boolean);
}
function ownersForProperty(propertyId) {
  if (fastigheterMaster?.listEntities('property').length) return resolveCurrentOwners(propertyId, fastigheterMaster, matrikelMaster);
  return legacyOwnersForProperty(propertyId);
}
function ownersForEntry(entryId) { return propertyIdsForEntry(entryId).flatMap(propertyId => ownersForProperty(propertyId).map(owner => ({ ...owner, property_id: propertyId }))); }
function namesForIsland(islandId) { return nameRecords().filter(record => record.target_type === 'place' && record.target_id === islandId); }

function entrySearchText(entry) {
  const island = islandForEntry(entry.id);
  const properties = propertyIdsForEntry(entry.id);
  const owners = ownersForEntry(entry.id);
  return [entry.id, entry.name, entry.object_type, entry.subtype, entry.review_status, island?.preferred_name,
    ...properties, ...owners.map(owner => owner.display_name)].filter(Boolean).join(' ');
}
function compareEntries(a, b) {
  const compare = (x, y) => String(x || '').localeCompare(String(y || ''), 'sv', { numeric: true });
  if (ui.sort === 'island') return compare(islandForEntry(a.id)?.preferred_name, islandForEntry(b.id)?.preferred_name) || compare(a.name, b.name);
  if (ui.sort === 'type') return compare(objectTypeLabel(a.object_type, a.subtype), objectTypeLabel(b.object_type, b.subtype)) || compare(a.name, b.name);
  if (ui.sort === 'status') return queueRank(a.review_status) - queueRank(b.review_status) || compare(a.name, b.name);
  return compare(a.name, b.name) || entryIdNumber(a.id) - entryIdNumber(b.id);
}
function filteredEntries() {
  const query = normalize(ui.search);
  return entryRecords().filter(entry => {
    const island = islandForEntry(entry.id);
    const properties = propertyIdsForEntry(entry.id);
    if (ui.island && island?.id !== ui.island) return false;
    if (ui.objectClass && entry.object_type !== ui.objectClass) return false;
    if (ui.subtype && entry.subtype !== ui.subtype) return false;
    if (ui.property && !properties.includes(ui.property)) return false;
    if (ui.status && entry.review_status !== ui.status) return false;
    if (query && !viewCache(`entry-search:${entry.id}`, () => normalize(entrySearchText(entry))).includes(query)) return false;
    return true;
  }).sort(compareEntries);
}
function reviewCounts(entries = entryRecords()) {
  const counts = Object.fromEntries(REVIEW_STATUSES.map(status => [status, 0]));
  entries.forEach(entry => { counts[entry.review_status || 'ogranskad'] += 1; }); return counts;
}

function renderSummary() {
  if (ui.view === 'structure') {
    const islands = islandRecords(); const confirmed = islands.filter(island => island.review_status === 'bekräftad').length;
    summary.innerHTML = `<div class="summary-copy"><p class="eyebrow dark">Ömaster</p><h2>${islands.length} öar</h2><p>Detta är den aktiva ölistan. Antecknings- och källfält ingår inte längre i datan.</p><div class="progress"><span style="width:${islands.length ? Math.round(confirmed / islands.length * 100) : 0}%"></span></div></div><div class="metric-grid structure-metrics"><button><strong>${islands.length}</strong><span>öar</span></button><button><strong>${confirmed}</strong><span>bekräftade</span></button><button><strong>${islandLinks().length}</strong><span>ö-kopplingar</span></button><button><strong>${entryRecords().filter(entry => !islandForEntry(entry.id)).length}</strong><span>utan ö</span></button></div>`;
    return;
  }
  const entries = entryRecords(); const counts = reviewCounts(entries); const reviewed = entries.length - counts.ogranskad;
  summary.innerHTML = `<div class="summary-copy"><p class="eyebrow dark">Ren aktiv data</p><h2>${entries.length} poster · ${reviewed} granskade</h2><p>Den gamla käll- och förslagstabellen är arkiverad och används inte som aktiv data.</p><div class="progress"><span style="width:${entries.length ? Math.round(reviewed / entries.length * 100) : 0}%"></span></div></div><div class="metric-grid"><button data-summary-status="ogranskad"><strong>${counts.ogranskad}</strong><span>ogranskade</span></button><button data-summary-status="bekräftad"><strong>${counts.bekräftad}</strong><span>bekräftade</span></button><button data-summary-status="rättad"><strong>${counts.rättad}</strong><span>rättade</span></button><button data-summary-status="osäker"><strong>${counts.osäker}</strong><span>osäkra</span></button><button data-summary-status="utgår"><strong>${counts.utgår}</strong><span>utgår</span></button></div>`;
}

function ownerChipsForProperties(propertyIds) {
  const owners = propertyIds.flatMap(propertyId => ownersForProperty(propertyId).map(owner => ({ ...owner, property_id: propertyId })));
  if (!owners.length) return '<span class="muted">Ingen tillräckligt säker ägaruppgift</span>';
  const seen = new Set();
  return owners.filter(owner => { const key = `${owner.owner_type}:${owner.owner_id}`; if (seen.has(key)) return false; seen.add(key); return true; }).map(owner => `<a class="owner-chip ${owner.owner_type === 'party' || owner.owner_type === 'external-party' ? 'external' : ''}" href="${escapeAttribute(owner.url || '#')}" title="${escapeAttribute(`${owner.property_id} · bäst kända nuvarande ägare`)}"><strong>${escapeHtml(owner.display_name)}</strong><small>${owner.owner_type === 'person' || owner.owner_type === 'person-ref' ? 'Matrikeln' : 'extern part'}</small></a>`).join('');
}
function ownerChips(entryId) { return ownerChipsForProperties(propertyIdsForEntry(entryId)); }
function entryCard(entry) {
  const island = islandForEntry(entry.id); const properties = propertyIdsForEntry(entry.id);
  return `<button type="button" class="object-chip class-${escapeAttribute(cssToken(entry.object_type))} status-${escapeAttribute(entry.review_status)}" data-entry-id="${escapeAttribute(entry.id)}"><span class="review-dot"></span><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(objectTypeLabel(entry.object_type, entry.subtype))} · ${escapeHtml(reviewStatusLabel(entry.review_status))}</small><span class="card-context">${escapeHtml(island?.preferred_name || 'Ingen ö')} · ${escapeHtml(properties.join(' + ') || 'ingen fastighet')}</span></button>`;
}
function distribution(entries) {
  const counts = Object.fromEntries(OBJECT_CLASSES.map(value => [value, entries.filter(entry => entry.object_type === value).length]));
  return `<div class="distribution">${OBJECT_CLASSES.filter(value => counts[value]).map(value => `<span class="class-${escapeAttribute(cssToken(value))}" style="width:${counts[value] / (entries.length || 1) * 100}%" title="${escapeAttribute(`${classLabel(value)}: ${counts[value]}`)}"></span>`).join('')}</div>`;
}
function renderAtlas() {
  const entries = filteredEntries(); const groups = new Map();
  for (const entry of entries) { const island = islandForEntry(entry.id); const key = island?.id || ''; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(entry); }
  $('#filter-count').textContent = `${entries.length} av ${entryRecords().length} poster`;
  return [...groups.entries()].sort(([a], [b]) => String(islandRecords().find(item => item.id === a)?.preferred_name || 'Övrigt').localeCompare(String(islandRecords().find(item => item.id === b)?.preferred_name || 'Övrigt'), 'sv')).map(([islandId, islandEntries]) => {
    const island = islandRecords().find(item => item.id === islandId); const properties = new Map();
    for (const entry of islandEntries) { const ids = propertyIdsForEntry(entry.id); const key = ids.join(' + ') || 'Ingen fastighet'; if (!properties.has(key)) properties.set(key, []); properties.get(key).push(entry); }
    return `<section class="island-board"><header><div><p class="eyebrow dark">Ö</p><h2>${escapeHtml(island?.preferred_name || 'Utan kopplad ö')}</h2><p>${islandEntries.length} dataposter.</p></div>${distribution(islandEntries)}</header><div class="property-board">${[...properties.entries()].sort(([a], [b]) => a.localeCompare(b, 'sv', { numeric: true })).map(([property, propertyEntries]) => `<article class="property-cluster"><h3>${escapeHtml(property)}</h3><p>${propertyEntries.length} poster</p><div class="object-cloud">${propertyEntries.map(entryCard).join('')}</div></article>`).join('')}</div></section>`;
  }).join('') || '<section class="empty"><h2>Inga poster matchar filtren.</h2></section>';
}
function renderStructure() {
  const query = normalize(ui.search); const islands = islandRecords().filter(island => {
    if (ui.status && island.review_status !== ui.status) return false;
    if (query && !normalize([island.preferred_name, ...namesForIsland(island.id).map(name => name.name)].join(' ')).includes(query)) return false;
    return true;
  });
  $('#filter-count').textContent = `${islands.length} av ${islandRecords().length} öar`;
  return `<section class="structure-view"><header class="structure-intro"><div><p class="eyebrow dark">Stabila öobjekt</p><h2>Östruktur</h2><p>Namn och alternativa namn kan ändras utan att ö-ID:t ändras.</p></div><button type="button" class="primary new-master" data-action="new-island">+ Ny ö</button></header><div class="master-grid">${islands.map(island => {
    const names = namesForIsland(island.id).filter(name => name.name_type !== 'föredraget'); const linked = entryRecords().filter(entry => islandForEntry(entry.id)?.id === island.id);
    return `<article class="master-card status-${escapeAttribute(island.review_status)}"><header><span class="master-kind">Ö</span><span class="table-status status-${escapeAttribute(island.review_status)}">${escapeHtml(reviewStatusLabel(island.review_status))}</span></header><h3>${escapeHtml(island.preferred_name)}</h3><p>${linked.length} dataposter · ${unique(linked.flatMap(entry => propertyIdsForEntry(entry.id))).length} fastigheter</p>${names.length ? `<div class="name-chips">${names.map(name => `<span>${escapeHtml(nameTypeLabel(name.name_type))}: ${escapeHtml(name.name)}</span>`).join('')}</div>` : ''}<button type="button" class="card-edit" data-island-id="${escapeAttribute(island.id)}">Redigera ön</button></article>`;
  }).join('')}</div></section>`;
}
function renderQueue() {
  const entries = filteredEntries().sort((a, b) => queueRank(a.review_status) - queueRank(b.review_status) || compareEntries(a, b));
  $('#filter-count').textContent = `${entries.length} av ${entryRecords().length} poster`;
  return `<section class="queue-view"><header><p class="eyebrow dark">Data som väntar på kontroll</p><h2>Granskningskö</h2><p>Varje kort innehåller endast den aktiva datan.</p></header><div class="queue-grid">${entries.map(entry => { const island = islandForEntry(entry.id); return `<button type="button" class="queue-card status-${escapeAttribute(entry.review_status)}" data-entry-id="${escapeAttribute(entry.id)}"><span class="source-number">${escapeHtml(entry.id)}</span><h3>${escapeHtml(entry.name)}</h3><p>${escapeHtml(island?.preferred_name || 'Ingen ö')} · ${escapeHtml(propertyIdsForEntry(entry.id).join(' + ') || 'ingen fastighet')}</p><div class="queue-proposal"><span>${escapeHtml(objectTypeLabel(entry.object_type, entry.subtype))}</span></div><strong>${escapeHtml(reviewStatusLabel(entry.review_status))}</strong></button>`; }).join('')}</div></section>`;
}
function renderTable() {
  const entries = filteredEntries(); $('#filter-count').textContent = `${entries.length} av ${entryRecords().length} poster`;
  return `<section class="table-view"><header class="table-intro"><div><p class="eyebrow dark">All aktiv information</p><h2>Tabell</h2><p>Öar, fastigheter och bäst kända nuvarande ägare är strukturerade länkar.</p></div></header><div class="table-scroll polished-table"><table><thead><tr><th class="pin-id">ID</th><th class="pin-name">Namn</th><th>Objektstyp</th><th>Ö</th><th>Fastighet</th><th>Nuvarande ägare</th><th>Granskningsstatus</th><th>Åtgärd</th></tr></thead><tbody>${entries.map(entry => { const island = islandForEntry(entry.id); const properties = propertyIdsForEntry(entry.id); return `<tr class="data-row status-${escapeAttribute(entry.review_status)}"><td class="pin-id"><span class="row-id">${escapeHtml(entry.id)}</span></td><td class="pin-name"><strong>${escapeHtml(entry.name)}</strong></td><td><span class="type-pill class-${escapeAttribute(cssToken(entry.object_type))}">${escapeHtml(objectTypeLabel(entry.object_type, entry.subtype))}</span></td><td><strong>${escapeHtml(island?.preferred_name || '—')}</strong></td><td>${properties.map(id => { const ref = propertyRefById(id); return `<a href="${escapeAttribute(ref?.url || '#')}">${escapeHtml(id)}</a>`; }).join('<br>') || '—'}</td><td><div class="owner-list">${ownerChips(entry.id)}</div></td><td><span class="table-status status-${escapeAttribute(entry.review_status)}">${escapeHtml(reviewStatusLabel(entry.review_status))}</span></td><td><button type="button" class="row-edit" data-entry-id="${escapeAttribute(entry.id)}">Redigera</button></td></tr>`; }).join('')}</tbody></table></div></section>`;
}
function populateFilters() {
  const setOptions = (selector, placeholder, values, selected, label = value => value) => { const node = $(selector); node.innerHTML = `<option value="">${placeholder}</option>${values.map(value => option(value, selected, label(value))).join('')}`; };
  setOptions('#island-filter', 'Alla öar', islandRecords().map(item => item.id), ui.island, id => islandRecords().find(item => item.id === id)?.preferred_name || id);
  setOptions('#subtype-filter', 'Alla undertyper', unique(entryRecords().map(entry => entry.subtype)).sort((a, b) => a.localeCompare(b, 'sv')), ui.subtype);
  setOptions('#property-filter', 'Alla fastigheter', propertyRefs().map(item => item.external_id), ui.property);
}
function render() {
  renderSummary(); populateFilters(); document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === ui.view));
  content.innerHTML = ui.view === 'structure' ? renderStructure() : ui.view === 'queue' ? renderQueue() : ui.view === 'table' ? renderTable() : renderAtlas();
}

function openDrawer(entryId) { selectedIslandId = null; selectedEntryId = entryId; renderEntryDrawer(); drawer.setAttribute('aria-hidden', 'false'); backdrop.hidden = false; }
function openIslandDrawer(islandId = null) { selectedEntryId = null; selectedIslandId = islandId; renderIslandDrawer(); drawer.setAttribute('aria-hidden', 'false'); backdrop.hidden = false; }
function closeDrawer() { selectedEntryId = null; selectedIslandId = null; drawer.setAttribute('aria-hidden', 'true'); backdrop.hidden = true; }

function propertySelectionRow(property) {
  return `<div class="selected-property" data-property-id="${escapeAttribute(property.external_id)}"><input type="hidden" name="property_ids" value="${escapeAttribute(property.external_id)}"><a href="${escapeAttribute(property.url || '#')}">${escapeHtml(property.external_id)}</a><button type="button" data-action="remove-property" aria-label="Ta bort ${escapeAttribute(property.external_id)}">Ta bort</button></div>`;
}
function unknownPropertySelectionRow(propertyId) {
  return `<div class="selected-property unknown" data-property-id="${escapeAttribute(propertyId)}"><input type="hidden" name="property_ids" value="${escapeAttribute(propertyId)}"><span><strong>Okänd fastighet</strong><small>${escapeHtml(propertyId)} · länken behålls tills du tar bort den</small></span><button type="button" data-action="remove-property" aria-label="Ta bort okänd fastighet ${escapeAttribute(propertyId)}">Ta bort</button></div>`;
}
function propertySelectionMarkup(selected) {
  return selected.length ? selected.map(item => item.known ? propertySelectionRow(item.property) : unknownPropertySelectionRow(item.id)).join('') : '<p>Ingen fastighet vald</p>';
}
function propertyPicker(selectedIds) {
  const state = propertySelectionState(selectedIds, propertyRefs());
  return `<div class="property-picker" data-property-picker><div class="selected-properties" data-selected-properties>${propertySelectionMarkup(state.selected)}</div><div class="property-add"><select data-property-select aria-label="Lägg till fastighet"><option value="">Välj fastighet …</option>${state.available.map(property => `<option value="${escapeAttribute(property.external_id)}">${escapeHtml(property.external_id)}</option>`).join('')}</select><button type="button" data-action="add-property" ${state.available.length ? '' : 'disabled'}>Lägg till</button></div><small>De flesta objekt hör till en fastighet. Lägg bara till fler när det verkligen behövs.</small></div>`;
}
function updatePropertyPicker(form, propertyIds) {
  const picker = form.querySelector('[data-property-picker]'); if (!picker) return;
  const state = propertySelectionState(propertyIds, propertyRefs());
  picker.querySelector('[data-selected-properties]').innerHTML = propertySelectionMarkup(state.selected);
  const select = picker.querySelector('[data-property-select]');
  select.innerHTML = `<option value="">Välj fastighet …</option>${state.available.map(property => `<option value="${escapeAttribute(property.external_id)}">${escapeHtml(property.external_id)}</option>`).join('')}`;
  picker.querySelector('[data-action="add-property"]').disabled = !state.available.length;
  const owners = form.querySelector('[data-owner-preview-list]'); if (owners) owners.innerHTML = ownerChipsForProperties(state.selected.map(item => item.id));
}
function renderEntryDrawer() {
  const entry = entryRecords().find(item => item.id === selectedEntryId); if (!entry) return closeDrawer();
  const island = islandForEntry(entry.id); const properties = propertyIdsForEntry(entry.id);
  drawerContent.innerHTML = `<header class="drawer-header"><p class="eyebrow dark">${escapeHtml(entry.id)}</p><h2>${escapeHtml(entry.name)}</h2><span class="large-status status-${escapeAttribute(entry.review_status)}">${escapeHtml(reviewStatusLabel(entry.review_status))}</span></header><section class="drawer-section data-panel"><h3>Data</h3><form id="data-form" class="review-form"><label>Granskningsstatus<select name="review_status">${REVIEW_STATUSES.map(value => option(value, entry.review_status, reviewStatusLabel(value))).join('')}</select></label><label>Objektstyp<select name="object_type">${OBJECT_CLASSES.map(value => option(value, entry.object_type, classLabel(value))).join('')}</select></label><label class="span-2">Namn<input name="name" value="${escapeAttribute(entry.name)}" required></label><label>Undertyp<input name="subtype" value="${escapeAttribute(entry.subtype || '')}" list="subtype-options" placeholder="exempelvis gäststuga eller udde"></label><label>Ö<select name="island_id"><option value="">Ingen ö kopplad</option>${islandRecords().map(item => option(item.id, island?.id || '', item.preferred_name)).join('')}</select></label><fieldset class="span-2"><legend>Fastighet</legend>${propertyPicker(properties)}</fieldset><section class="span-2 owner-preview"><h3>Nuvarande ägare</h3><p>Hämtas skrivskyddat från Fastighetshistorikens granskade nulägesbedömning.</p><div class="owner-list" data-owner-preview-list>${ownerChips(entry.id)}</div></section><div class="form-actions span-2"><button type="submit" class="primary">Spara data</button></div></form><div class="danger-zone"><div><strong>Ta bort dataposten</strong><small>Posten tas bort ur den aktiva v2-datan. Det äldre v1-arkivet används inte av appen.</small></div><button type="button" class="delete-button" data-action="delete-entry">Ta bort</button></div></section>`;
}
function renderIslandDrawer() {
  const island = selectedIslandId ? islandRecords().find(item => item.id === selectedIslandId) : null;
  const names = island ? namesForIsland(island.id) : [];
  const official = names.find(name => name.name_type === 'officiellt')?.name || '';
  const aliases = names.filter(name => name.name_type === 'alias').map(name => name.name).join('\n');
  const historical = names.filter(name => name.name_type === 'historiskt').map(name => name.name).join('\n');
  drawerContent.innerHTML = `<header class="drawer-header"><p class="eyebrow dark">${island ? escapeHtml(`place:${island.id}`) : 'Ny ö'}</p><h2>${escapeHtml(island?.preferred_name || 'Ö')}</h2></header><section class="drawer-section data-panel"><h3>Data</h3><form id="island-form" class="review-form"><label class="span-2">Namn<input name="preferred_name" value="${escapeAttribute(island?.preferred_name || '')}" required></label><label>Stabilt ID<input name="island_id" value="${escapeAttribute(island?.id || '')}" ${island ? 'readonly' : ''} placeholder="skapas från namnet"></label><label>Granskningsstatus<select name="review_status">${REVIEW_STATUSES.map(value => option(value, island?.review_status || 'ogranskad', reviewStatusLabel(value))).join('')}</select></label><label class="span-2">Officiellt namn<input name="official_name" value="${escapeAttribute(official)}"></label><label>Andra namn<textarea name="alias_names" rows="5">${escapeHtml(aliases)}</textarea></label><label>Historiska namn<textarea name="historical_names" rows="5">${escapeHtml(historical)}</textarea></label><label>Gäller från<input name="valid_from" value="${escapeAttribute(island?.valid_from || '')}"></label><label>Gäller till<input name="valid_to" value="${escapeAttribute(island?.valid_to || '')}"></label><div class="form-actions span-2"><button type="submit" class="primary">Spara ön</button></div></form>${island ? `<div class="danger-zone"><div><strong>Ta bort ön</strong><small>Dataposterna behålls men deras strukturerade ökoppling tas bort.</small></div><button type="button" class="delete-button" data-action="delete-island">Ta bort ön</button></div>` : ''}</section>`;
}

async function syncEdit(action, message) {
  await action(); render(); closeDrawer(); setStatus(`${message} · sparat lokalt`, 'ok');
  try { await syncNow(); } catch (_) { setStatus(`${message} · sparat lokalt · synk försöker igen senare`, 'warning'); }
}
async function replaceEntryLinks(entryId, islandId, propertyIds) {
  const oldIslands = islandLinks().filter(link => link.entry_id === entryId);
  const oldProperties = entryPropertyLinks().filter(link => link.entry_id === entryId);
  const deletes = [
    ...oldIslands.filter(link => link.island_id !== islandId).map(link => ({ entityType: 'data-entry-island-link', entityId: link.id })),
    ...oldProperties.filter(link => !propertyIds.includes(link.property_id)).map(link => ({ entityType: 'data-entry-property-link', entityId: link.id })),
  ];
  if (deletes.length) await repository.deleteEntities(deletes);
  const fields = [];
  if (islandId && !oldIslands.some(link => link.island_id === islandId)) {
    const id = `entry:${entryId}:island:${islandId}`;
    fields.push({ entityType: 'data-entry-island-link', entityId: id, field: 'entry_id', value: entryId }, { entityType: 'data-entry-island-link', entityId: id, field: 'island_id', value: islandId });
  }
  for (const propertyId of propertyIds) if (!oldProperties.some(link => link.property_id === propertyId)) {
    const id = `entry:${entryId}:property:${propertyId}`;
    fields.push({ entityType: 'data-entry-property-link', entityId: id, field: 'entry_id', value: entryId }, { entityType: 'data-entry-property-link', entityId: id, field: 'property_id', value: propertyId });
  }
  if (fields.length) await repository.upsertFields(fields);
}
async function saveEntry(form) {
  const data = new FormData(form); const objectType = data.get('object_type'); if (!OBJECT_CLASSES.includes(objectType)) throw new Error('Otillåten objekttyp');
  const islandId = String(data.get('island_id') || ''); if (islandId && !islandRecords().some(island => island.id === islandId)) throw new Error('Den valda ön finns inte');
  const propertyIds = validatePropertySelection({ selectedIds: data.getAll('property_ids'), propertyReferences: propertyRefs(), existingIds: propertyIdsForEntry(selectedEntryId) });
  const fields = { name: String(data.get('name') || '').trim(), object_type: objectType, subtype: String(data.get('subtype') || '').trim() || null, review_status: data.get('review_status') };
  if (!fields.name) throw new Error('Namn saknas');
  await syncEdit(async () => { await repository.setFields(Object.entries(fields).map(([field, value]) => ({ entityType: 'data-entry', entityId: selectedEntryId, field, value }))); await replaceEntryLinks(selectedEntryId, islandId, propertyIds); }, `${fields.name} uppdaterad`);
}
async function deleteEntry() {
  const entry = entryRecords().find(item => item.id === selectedEntryId); if (!entry) return;
  if (!confirm(`Ta bort ${entry.name} ur den aktiva datan?`)) return;
  const refs = [{ entityType: 'data-entry', entityId: entry.id }, ...islandLinks().filter(link => link.entry_id === entry.id).map(link => ({ entityType: 'data-entry-island-link', entityId: link.id })), ...entryPropertyLinks().filter(link => link.entry_id === entry.id).map(link => ({ entityType: 'data-entry-property-link', entityId: link.id }))];
  await syncEdit(() => repository.deleteEntities(refs), `${entry.name} borttagen`);
  offerUndo(`${entry.name} borttagen`, refs, `${entry.name} återställd`);
}
async function saveIsland(form) {
  const data = new FormData(form); const name = String(data.get('preferred_name') || '').trim(); if (!name) throw new Error('Namn saknas');
  const id = selectedIslandId || String(data.get('island_id') || '').trim() || stableEntityId(name); if (!id) throw new Error('Stabilt ID saknas');
  if (!selectedIslandId && repository.getEntity('place', id)) throw new Error(`ID:t ${id} finns redan`);
  const status = data.get('review_status'); const validFrom = String(data.get('valid_from') || '').trim() || null; const validTo = String(data.get('valid_to') || '').trim() || null;
  const desired = [
    { type: 'föredraget', values: [name] },
    { type: 'officiellt', values: splitList(data.get('official_name')) },
    { type: 'alias', values: splitList(data.get('alias_names')) },
    { type: 'historiskt', values: splitList(data.get('historical_names')) },
  ];
  await syncEdit(async () => {
    await repository.upsertFields(Object.entries({ preferred_name: name, subtype: 'ö', review_status: status, source_ids: null, note: null, valid_from: validFrom, valid_to: validTo }).map(([field, value]) => ({ entityType: 'place', entityId: id, field, value })));
    const existing = namesForIsland(id); const keep = new Set(); const fields = [];
    for (const group of desired) for (const [index, value] of group.values.entries()) {
      const previous = existing.find(item => item.name_type === group.type && item.name === value);
      const nameId = previous?.id || `name:place:${id}:${group.type}:${stableEntityId(value)}:${index + 1}`; keep.add(nameId);
      const record = { target_type: 'place', target_id: id, name: value, name_type: group.type, review_status: status, source_ids: null, note: null, valid_from: validFrom, valid_to: validTo };
      fields.push(...Object.entries(record).map(([field, fieldValue]) => ({ entityType: 'name-record', entityId: nameId, field, value: fieldValue })));
    }
    if (fields.length) await repository.upsertFields(fields);
    const obsolete = existing.filter(item => !keep.has(item.id)).map(item => ({ entityType: 'name-record', entityId: item.id })); if (obsolete.length) await repository.deleteEntities(obsolete);
  }, `${name} uppdaterad`);
}
async function deleteIsland() {
  const island = islandRecords().find(item => item.id === selectedIslandId); if (!island) return;
  if (!confirm(`Ta bort ön ${island.preferred_name}? Dataposterna blir kvar utan ökoppling.`)) return;
  const refs = islandDeletionRefs({ id: island.id, names: nameRecords(), islandLinks: islandLinks(), relations: placeRelations(), propertyLinks: oldPropertyLinks() });
  await syncEdit(() => repository.deleteEntities(refs), `${island.preferred_name} borttagen`);
  offerUndo(`${island.preferred_name} borttagen`, refs, `${island.preferred_name} återställd`);
}

function exportData() {
  const payload = {
    format: 'korpholmen-kartdata-v2', exported_at: new Date().toISOString(),
    islands: islandRecords().map(island => ({ id: island.id, name: island.preferred_name, review_status: island.review_status, valid_from: island.valid_from || null, valid_to: island.valid_to || null, names: namesForIsland(island.id).filter(name => name.name_type !== 'föredraget').map(name => ({ name: name.name, name_type: name.name_type, review_status: name.review_status, valid_from: name.valid_from || null, valid_to: name.valid_to || null })) })),
    entries: entryRecords().map(entry => ({ id: entry.id, name: entry.name, object_type: entry.object_type, subtype: entry.subtype || null, review_status: entry.review_status, island_id: islandForEntry(entry.id)?.id || null, property_ids: propertyIdsForEntry(entry.id) })),
    read_projection: {
      note: 'Skrivskyddad nulägesprojektion. Fastigheter och personer ändras i sina ägarmastrar.',
      current_owners: unique(entryRecords().flatMap(entry => ownersForEntry(entry.id)).map(owner => `${owner.property_id}\u0000${owner.owner_type}\u0000${owner.owner_id}`)).map(key => {
        const [propertyId, ownerType, ownerId] = key.split('\u0000'); const owner = ownersForProperty(propertyId).find(item => item.owner_type === ownerType && item.owner_id === ownerId);
        return { property_id: propertyId, owner_type: ownerType, owner_id: ownerId, display_name: owner?.display_name || ownerId, basis: owner?.basis || null, reviewed_on: owner?.reviewed_on || null };
      }),
    },
  };
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `kartdata-v2-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); URL.revokeObjectURL(url);
}

async function registerServiceWorker() { try { return await registerKorpholmenServiceWorker({ sourceTree: isSourceTree }); } catch (error) { console.warn('Appskalet kunde inte uppdateras', error); return null; } }
async function completeOAuthCallbackIfNeeded() { const url = new URL(location.href); if (!url.searchParams.has('code') && !url.searchParams.has('error')) return; const token = await completeDropboxOAuth(); accessToken = token.access_token; accessTokenExpiresAt = Date.now() + Math.max(30, Number(token.expires_in || 0) - 60) * 1000; if (token.refresh_token) await store.putMeta(TOKEN_META, token.refresh_token); for (const parameter of ['code', 'state', 'error', 'error_description']) url.searchParams.delete(parameter); history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`); }
async function currentAccessToken() { if (accessToken && Date.now() < accessTokenExpiresAt) return accessToken; const refreshToken = await store.getMeta(TOKEN_META); if (!refreshToken || !DROPBOX_CLIENT_ID || navigator.onLine === false) return null; const token = await exchangeDropboxRefreshToken({ clientId: DROPBOX_CLIENT_ID, refreshToken }); accessToken = token.access_token; accessTokenExpiresAt = Date.now() + Math.max(30, Number(token.expires_in || 0) - 60) * 1000; if (token.refresh_token && token.refresh_token !== refreshToken) await store.putMeta(TOKEN_META, token.refresh_token); return accessToken; }
async function syncNow() {
  if (syncPromise) return syncPromise;
  syncPromise = (async () => { const hasCredential = Boolean(await store.getMeta(TOKEN_META)); if (navigator.onLine === false) { setStatus(`Offline · ${hasCredential ? 'Dropbox ansluten · ' : ''}ändringar sparas lokalt`, 'warning'); return null; } const token = await currentAccessToken(); if (!token) { setStatus('Lokalt sparat · Dropbox ej ansluten', 'warning'); connectButton.textContent = 'Anslut Dropbox'; return null; } connectButton.textContent = 'Synka Dropbox'; setStatus('Synkar Kartdata och läser mastrar…'); const transport = new DropboxTransport({ accessToken: token, id: 'dropbox-kartdata', opsRoot: '/kartdata/ops' }); const result = await new SyncEngine({ repository, transport }).syncOnce(); await Promise.all([
    fastigheterMaster.sync(new DropboxTransport({ accessToken: token, id: 'dropbox-fastigheter-read', opsRoot: '/fastigheter/ops', readOnly: true })),
    matrikelMaster.sync(new DropboxTransport({ accessToken: token, id: 'dropbox-matrikel-read', opsRoot: '/matrikel/ops', readOnly: true })),
  ]); render(); setStatus(`Synkad · ${result.uploadedOps} upp, ${result.downloadedOps} ned · ägare från Fastigheter`, 'ok'); return result; })().catch(error => { console.error(error); if (isOfflineError(error)) { setStatus('Offline · lokalt sparat · synkas automatiskt', 'warning'); return null; } setStatus(`Åtgärd krävs · ${error.message}`, 'error'); throw error; }).finally(() => { syncPromise = null; }); return syncPromise;
}
async function connectDropbox() { sessionStorage.setItem('korpholmen:oauth-return', new URL('kartdata/', redirectUri()).pathname); const attempt = await beginDropboxOAuth({ clientId: DROPBOX_CLIENT_ID, redirectUri: redirectUri(), scopes: DROPBOX_SCOPES }); location.assign(attempt.url); }
async function bootstrapCleanV2({ force = false } = {}) {
  if (!isSourceTree) throw new Error('Förhandskopian kan bara läsas från källappen');
  if (!force && entryRecords().length) return false;
  const response = await fetch(CLEAN_V2_BOOTSTRAP_URL, { cache: 'no-store' }); if (!response.ok) throw new Error(`Den rena v2-kopian kunde inte läsas (${response.status})`);
  const document = await response.json(); if (document.operations_version !== 1 || !Array.isArray(document.operations)) throw new Error('V2-kopian har fel format');
  document.operations.forEach(validateOperation); await repository.applyRemoteOps(document.operations); await store.putMeta(CLEAN_V2_META, { applied: true, preview_only: true, migration_id: document.migration_id, operations: document.operations.length }); render(); setStatus(`${entryRecords().length} rena dataposter inlästa lokalt`, 'ok'); return true;
}
content.addEventListener('click', event => { const island = event.target.closest('[data-island-id]'); if (island) { openIslandDrawer(island.dataset.islandId); return; } if (event.target.closest('[data-action="new-island"]')) { openIslandDrawer(null); return; } const entry = event.target.closest('[data-entry-id]'); if (entry) openDrawer(entry.dataset.entryId); });
summary.addEventListener('click', event => { const target = event.target.closest('[data-summary-status]'); if (!target) return; ui.status = target.dataset.summaryStatus; $('#status-filter').value = ui.status; render(); });
backdrop.addEventListener('click', closeDrawer);
drawer.addEventListener('click', event => {
  if (event.target.closest('[data-action="close"]')) { closeDrawer(); return; }
  const form = event.target.closest('#data-form');
  if (form && event.target.closest('[data-action="add-property"]')) {
    const select = form.querySelector('[data-property-select]'); const propertyId = select.value;
    if (propertyId) updatePropertyPicker(form, [...new FormData(form).getAll('property_ids').map(String), propertyId]);
    return;
  }
  const removeProperty = event.target.closest('[data-action="remove-property"]');
  if (form && removeProperty) {
    const removedId = removeProperty.closest('[data-property-id]')?.dataset.propertyId;
    updatePropertyPicker(form, new FormData(form).getAll('property_ids').map(String).filter(id => id !== removedId));
    return;
  }
  if (event.target.closest('[data-action="delete-entry"]')) deleteEntry().catch(error => setStatus(error.message, 'error'));
  if (event.target.closest('[data-action="delete-island"]')) deleteIsland().catch(error => setStatus(error.message, 'error'));
});
drawer.addEventListener('submit', event => { event.preventDefault(); if (event.target.id === 'data-form') saveEntry(event.target).catch(error => setStatus(error.message, 'error')); if (event.target.id === 'island-form') saveIsland(event.target).catch(error => setStatus(error.message, 'error')); });
const renderSearch = debounce(render, 120);
$('#search').addEventListener('input', event => { ui.search = event.target.value; renderSearch(); });
$('#island-filter').addEventListener('change', event => { ui.island = event.target.value; render(); });
$('#class-filter').addEventListener('change', event => { ui.objectClass = event.target.value; render(); });
$('#subtype-filter').addEventListener('change', event => { ui.subtype = event.target.value; render(); });
$('#property-filter').addEventListener('change', event => { ui.property = event.target.value; render(); });
$('#status-filter').addEventListener('change', event => { ui.status = event.target.value; render(); });
$('#sort-order').addEventListener('change', event => { ui.sort = event.target.value; render(); });
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { ui.view = button.dataset.view; render(); }));
connectButton.addEventListener('click', () => currentAccessToken().then(token => token ? syncNow() : connectDropbox()).catch(error => setStatus(error.message, 'error')));
bootstrapButton.addEventListener('click', () => bootstrapCleanV2({ force: true }).then(() => setStatus(`${entryRecords().length} rena dataposter inlästa lokalt · ägare läses från Fastigheter`, 'ok')).catch(error => setStatus(error.message, 'error')));
$('#export-json').addEventListener('click', exportData);
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeDrawer(); });
window.addEventListener('online', () => syncNow().catch(() => {})); window.addEventListener('offline', () => syncNow().catch(() => {})); window.addEventListener('korpholmen:dropbox-ready', () => syncNow().catch(() => {}));

async function init() {
  const serviceWorkerPromise = registerServiceWorker(); const db = await openSlaktlandskapDB({ name: 'korpholmen-kartdata-v2' }); store = new IndexedDBStore(db); repository = await new Repository({ store, deviceId: await deviceId() }).init(); fastigheterMaster = await new ReadOnlyMaster({ store, cacheKey: 'fastigheter' }).init(); matrikelMaster = await new ReadOnlyMaster({ store, cacheKey: 'matrikel' }).init(); bootstrapButton.hidden = !isSourceTree; render(); if (isSourceTree && !entryRecords().length) await bootstrapCleanV2(); await completeOAuthCallbackIfNeeded(); await syncNow(); await serviceWorkerPromise;
}
init().catch(error => { console.error(error); setStatus(`Kunde inte starta · ${error.message}`, 'error'); });
