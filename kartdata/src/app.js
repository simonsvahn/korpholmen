import {
  DropboxTransport,
  IndexedDBStore,
  Repository,
  SyncEngine,
  beginDropboxOAuth,
  completeDropboxOAuth,
  createBatch,
  exchangeDropboxRefreshToken,
  openSlaktlandskapDB,
  validateOperation,
} from '../core/data-layer.js';
import { DROPBOX_CLIENT_ID, DROPBOX_SCOPES, LOCAL_BOOTSTRAP_URL, PLACE_NAMES_BOOTSTRAP_URL, STRUCTURE_BOOTSTRAP_URL } from './config.js';
import {
  OBJECT_CLASSES,
  REVIEW_STATUSES,
  classLabel,
  effectiveEntry,
  entrySearchText,
  normalizeIslandDisplay,
  objectTypeLabel,
  proposedReview,
  propertyIdsFromText,
  reviewStatusLabel,
  sourceIdNumber,
  splitList,
  stableEntityId,
} from './model.js?v=2026-08-03-5';

const $ = selector => document.querySelector(selector);
const content = $('#content');
const summary = $('#summary');
const drawer = $('#entry-drawer');
const drawerContent = $('#drawer-content');
const backdrop = $('#backdrop');
const statusNode = $('#sync-status');
const connectButton = $('#connect-dropbox');
const bootstrapButton = $('#bootstrap-local');
const isSourceTree = location.pathname.includes('/apps/kartdata/');
const TOKEN_META = 'dropbox:refresh-token';
const BOOTSTRAP_META = 'bootstrap:kartdata-2026-08-03';
const STRUCTURE_META = 'bootstrap:kartdata-place-structure-v1';
const PLACE_NAMES_META = 'bootstrap:kartdata-place-names-v1';
const REVIEW_FIELDS = ['review_name', 'review_object_class', 'review_subtype', 'review_island', 'review_property_ids', 'review_note', 'review_basis'];
const MASTER_FIELDS = ['preferred_name', 'subtype', 'review_status', 'source_ids', 'note', 'valid_from', 'valid_to'];

let store;
let repository;
let accessToken = null;
let accessTokenExpiresAt = 0;
let syncPromise = null;
let selectedEntryId = null;
let selectedMaster = null;
const expandedTableRows = new Set();
const ui = { search: '', island: '', objectClass: '', subtype: '', property: '', status: '', sort: 'source', view: 'atlas', masterFilter: 'all' };

const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const escapeAttribute = escapeHtml;
const nameTypeLabel = value => ({ föredraget: 'Föredraget', officiellt: 'Officiellt', alias: 'Alternativt', historiskt: 'Historiskt' }[value] || value || 'Namnform');
const normalize = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('sv');
const cssToken = value => String(value || '').replaceAll(' ', '-');
const recordList = type => repository.listEntities(type).map(entity => ({ id: entity.entity_id, ...entity.fields }));
const entryRecords = () => recordList('map-entry').sort((a, b) => sourceIdNumber(a.id) - sourceIdNumber(b.id));
const sourceRecords = () => recordList('source');
const placeRecords = () => recordList('place').sort((a, b) => String(a.preferred_name || '').localeCompare(String(b.preferred_name || ''), 'sv'));
const buildingRecords = () => recordList('building').sort((a, b) => String(a.preferred_name || '').localeCompare(String(b.preferred_name || ''), 'sv'));
const masterRecords = () => [...placeRecords().map(record => ({ ...record, entity_type: 'place' })), ...buildingRecords().map(record => ({ ...record, entity_type: 'building' }))];
const nameRecords = () => recordList('name-record');
const placeRelations = () => recordList('place-relation');
const propertyLinks = () => recordList('object-property-link');
const mapEntryLinks = () => recordList('map-entry-link');
const unique = values => [...new Set(values.filter(Boolean))];
const isOfflineError = error => navigator.onLine === false || error instanceof TypeError || /failed to fetch|load failed|networkerror|internetanslutning|network connection/i.test(String(error?.message || error));

function setStatus(text, tone = '') {
  statusNode.textContent = text;
  statusNode.className = tone ? `status-${tone}` : '';
}

function deviceId() {
  const key = 'korpholmen:kartdata-device-id';
  let id = localStorage.getItem(key);
  if (!id) { id = `kartdata-web-${crypto.randomUUID()}`; localStorage.setItem(key, id); }
  return id;
}

function redirectUri() { return new URL(isSourceTree ? '../../' : '../', location.href).href; }

function masterRef(type, id) { return type && id ? `${type}:${id}` : ''; }
function masterByRef(value) {
  const [type, ...parts] = String(value || '').split(':');
  const id = parts.join(':');
  return masterRecords().find(record => record.entity_type === type && record.id === id) || null;
}
function mapEntryLink(entryId) { return mapEntryLinks().find(link => link.map_entry_id === entryId) || null; }
function masterLabel(record) { return record ? `${record.preferred_name || record.id} · ${record.entity_type === 'place' ? 'Plats' : 'Byggnad'}${record.subtype ? `: ${record.subtype}` : ''}` : 'Ingen masterkoppling'; }
function namesFor(type, id) { return nameRecords().filter(record => record.target_type === type && record.target_id === id); }
function relationFor(type, id) { return placeRelations().find(record => record.child_type === type && record.child_id === id && record.relation_type === 'del_av') || null; }
function propertyLinksFor(type, id) { return propertyLinks().filter(link => link.target_type === type && link.target_id === id); }
function parentPlaceName(type, id) {
  const relation = relationFor(type, id); if (!relation) return null;
  return placeRecords().find(place => place.id === relation.parent_place_id)?.preferred_name || relation.parent_place_id;
}
function masterSearchText(record) {
  return [record.id, record.preferred_name, record.subtype, record.review_status, record.note, record.valid_from, record.valid_to,
    ...namesFor(record.entity_type, record.id).flatMap(item => [item.name, item.name_type, item.note, ...(item.source_ids || [])]),
    parentPlaceName(record.entity_type, record.id), ...propertyLinksFor(record.entity_type, record.id).map(item => item.property_id),
  ].filter(Boolean).join(' ');
}

function compareEntries(a, b) {
  const left = effectiveEntry(a); const right = effectiveEntry(b);
  const compare = (x, y) => String(x || '').localeCompare(String(y || ''), 'sv', { numeric: true });
  if (ui.sort === 'name') return compare(left.effective_name, right.effective_name) || sourceIdNumber(a.id) - sourceIdNumber(b.id);
  if (ui.sort === 'island') return compare(left.effective_island, right.effective_island) || compare(left.effective_property_ids?.[0], right.effective_property_ids?.[0]) || compare(left.effective_name, right.effective_name);
  if (ui.sort === 'type') return compare(objectTypeLabel(left.effective_object_class, left.effective_subtype), objectTypeLabel(right.effective_object_class, right.effective_subtype)) || compare(left.effective_name, right.effective_name);
  if (ui.sort === 'status') return queueRank(left.effective_status) - queueRank(right.effective_status) || compare(left.effective_name, right.effective_name);
  return sourceIdNumber(a.id) - sourceIdNumber(b.id);
}

function filteredEntries() {
  const query = normalize(ui.search);
  return entryRecords().filter(entry => {
    const effective = effectiveEntry(entry);
    if (ui.island && effective.effective_island !== ui.island) return false;
    if (ui.objectClass && effective.effective_object_class !== ui.objectClass) return false;
    if (ui.subtype && effective.effective_subtype !== ui.subtype) return false;
    if (ui.property && !(effective.effective_property_ids || []).includes(ui.property)) return false;
    if (ui.status && effective.effective_status !== ui.status) return false;
    if (query && !normalize(entrySearchText(entry)).includes(query)) return false;
    return true;
  }).sort(compareEntries);
}

function reviewCounts(entries = entryRecords()) {
  const counts = Object.fromEntries(REVIEW_STATUSES.map(status => [status, 0]));
  entries.forEach(entry => { counts[entry.review_status || 'ogranskad'] += 1; });
  return counts;
}

function renderSummary() {
  if (ui.view === 'structure') {
    const places = placeRecords(); const buildings = buildingRecords(); const links = mapEntryLinks();
    const linkedObjects = new Set(links.map(link => masterRef(link.target_type, link.target_id))).size;
    const confirmed = [...places, ...buildings].filter(record => record.review_status === 'bekräftad').length;
    summary.innerHTML = `<div class="summary-copy"><p class="eyebrow dark">Plats- och byggnadsmastern</p><h2>${places.length} platser · ${buildings.length} byggnader</h2><p>Varje ö, plats och byggnad finns bara en gång. Kartposter länkas till objekten utan att källtexten skrivs över.</p><div class="progress" aria-label="${places.length + buildings.length ? Math.round(confirmed / (places.length + buildings.length) * 100) : 0} procent bekräftat"><span style="width:${places.length + buildings.length ? Math.round(confirmed / (places.length + buildings.length) * 100) : 0}%"></span></div></div>
      <div class="metric-grid structure-metrics"><button class="${ui.masterFilter === 'all' ? 'active' : ''}" data-master-filter="all"><strong>${places.length + buildings.length}</strong><span>masterobjekt</span></button><button class="${ui.masterFilter === 'place' ? 'active' : ''}" data-master-filter="place"><strong>${places.length}</strong><span>platser</span></button><button class="${ui.masterFilter === 'building' ? 'active' : ''}" data-master-filter="building"><strong>${buildings.length}</strong><span>byggnader</span></button><button class="${ui.masterFilter === 'linked' ? 'active' : ''}" data-master-filter="linked"><strong>${linkedObjects}</strong><span>länkade objekt</span></button><button class="${ui.masterFilter === 'confirmed' ? 'active' : ''}" data-master-filter="confirmed"><strong>${confirmed}</strong><span>bekräftade</span></button></div>`;
    return;
  }
  const entries = entryRecords();
  const counts = reviewCounts(entries);
  const reviewed = entries.length - counts.ogranskad;
  const progress = entries.length ? Math.round(reviewed / entries.length * 100) : 0;
  summary.innerHTML = `<div class="summary-copy"><p class="eyebrow dark">Granskningsläge</p><h2>${reviewed} av ${entries.length} genomgångna</h2><p>Arbetsbokens uppgifter ligger orörda under varje post. Det färgade lagret visar bara tidigare förslag eller dina sparade beslut.</p><div class="progress" aria-label="${progress} procent granskat"><span style="width:${progress}%"></span></div></div>
    <div class="metric-grid">
      <button data-summary-status="ogranskad"><strong>${counts.ogranskad}</strong><span>ogranskade</span></button>
      <button data-summary-status="bekräftad"><strong>${counts.bekräftad}</strong><span>bekräftade</span></button>
      <button data-summary-status="rättad"><strong>${counts.rättad}</strong><span>rättade</span></button>
      <button data-summary-status="osäker"><strong>${counts.osäker}</strong><span>osäkra</span></button>
      <button data-summary-status="utgår"><strong>${counts.utgår}</strong><span>utgår</span></button>
    </div>`;
}

function classChip(entry) {
  const effective = effectiveEntry(entry);
  const status = effective.effective_status;
  return `<button type="button" class="object-chip class-${escapeAttribute(cssToken(effective.effective_object_class))} status-${escapeAttribute(status)}" data-entry-id="${escapeAttribute(entry.id)}" title="${escapeAttribute([entry.source_name_type, entry.prior_type_decision].filter(Boolean).join(' · '))}">
    <span class="review-dot" aria-hidden="true"></span><strong>${escapeHtml(effective.effective_name || 'Namnlös post')}</strong><small>${escapeHtml(objectTypeLabel(effective.effective_object_class, effective.effective_subtype))} · ${escapeHtml(reviewStatusLabel(status))}</small></button>`;
}

function distribution(entries) {
  const classes = ['byggnad', 'plats', 'namnform', 'ägaretikett', 'kartsymbol', 'annat', 'ingen masterpost'];
  const counts = Object.fromEntries(classes.map(value => [value, 0]));
  entries.forEach(entry => { counts[effectiveEntry(entry).effective_object_class] += 1; });
  const total = entries.length || 1;
  return `<div class="distribution" aria-label="Fördelning av objekttyper">${classes.filter(value => counts[value]).map(value => `<span class="class-${escapeAttribute(cssToken(value))}" style="width:${counts[value] / total * 100}%" title="${escapeAttribute(classLabel(value))}: ${counts[value]}"></span>`).join('')}</div>`;
}

function renderAtlas() {
  const entries = filteredEntries();
  const islands = new Map();
  for (const entry of entries) {
    const effective = effectiveEntry(entry);
    const island = effective.effective_island || 'Utan bestämd ö eller plats';
    if (!islands.has(island)) islands.set(island, []);
    islands.get(island).push(entry);
  }
  $('#filter-count').textContent = `${entries.length} av ${entryRecords().length} källrader`;
  return [...islands.entries()].sort(([a], [b]) => a.localeCompare(b, 'sv')).map(([island, islandEntries]) => {
    const properties = new Map();
    for (const entry of islandEntries) {
      const ids = effectiveEntry(entry).effective_property_ids;
      const key = ids.length ? ids.join(' + ') : 'Utan säker fastighetskoppling';
      if (!properties.has(key)) properties.set(key, []);
      properties.get(key).push(entry);
    }
    return `<section class="island-board"><header><div><p class="eyebrow dark">Ö eller kartområde</p><h2>${escapeHtml(island)}</h2><p>${islandEntries.length} källrader · klicka på ett namn för att granska.</p></div>${distribution(islandEntries)}</header>
      <div class="property-board">${[...properties.entries()].sort(([a], [b]) => a.localeCompare(b, 'sv', { numeric: true })).map(([property, propertyEntries]) => `<article class="property-cluster"><h3>${escapeHtml(property)}</h3><p>${propertyEntries.length} poster</p><div class="object-cloud">${propertyEntries.map(classChip).join('')}</div></article>`).join('')}</div></section>`;
  }).join('') || '<section class="empty"><h2>Inga kartposter matchar filtren.</h2></section>';
}

function filteredMasterRecords() {
  const query = normalize(ui.search);
  return masterRecords().filter(record => {
    if (ui.masterFilter === 'place' && record.entity_type !== 'place') return false;
    if (ui.masterFilter === 'building' && record.entity_type !== 'building') return false;
    if (ui.masterFilter === 'linked' && !mapEntryLinks().some(link => link.target_type === record.entity_type && link.target_id === record.id)) return false;
    if (ui.masterFilter === 'confirmed' && record.review_status !== 'bekräftad') return false;
    if (ui.objectClass === 'plats' && record.entity_type !== 'place') return false;
    if (ui.objectClass === 'byggnad' && record.entity_type !== 'building') return false;
    if (ui.objectClass && !['plats', 'byggnad'].includes(ui.objectClass)) return false;
    if (ui.subtype && record.subtype !== ui.subtype) return false;
    if (ui.status && record.review_status !== ui.status) return false;
    if (ui.property && !propertyLinksFor(record.entity_type, record.id).some(link => link.property_id === ui.property)) return false;
    if (ui.island) {
      const parent = parentPlaceName(record.entity_type, record.id);
      if (record.preferred_name !== ui.island && parent !== ui.island) return false;
    }
    if (query && !normalize(masterSearchText(record)).includes(query)) return false;
    return true;
  }).sort((a, b) => String(a.preferred_name || '').localeCompare(String(b.preferred_name || ''), 'sv'));
}

function masterCard(record) {
  const names = namesFor(record.entity_type, record.id);
  const official = names.find(item => item.name_type === 'officiellt')?.name;
  const aliases = names.filter(item => !['föredraget', 'officiellt'].includes(item.name_type)).map(item => item.name);
  const parent = parentPlaceName(record.entity_type, record.id);
  const properties = propertyLinksFor(record.entity_type, record.id).map(link => link.property_id);
  const directLinks = mapEntryLinks().filter(link => link.target_type === record.entity_type && link.target_id === record.id).length;
  const groupedRows = record.entity_type === 'place' ? entryRecords().filter(entry => effectiveEntry(entry).effective_island === record.preferred_name).length : 0;
  return `<article class="master-card status-${escapeAttribute(record.review_status || 'ogranskad')}">
    <header><span class="master-kind">${record.entity_type === 'place' ? 'Plats' : 'Byggnad'} · ${escapeHtml(record.subtype || 'utan undertyp')}</span><span class="table-status status-${escapeAttribute(record.review_status || 'ogranskad')}">${escapeHtml(reviewStatusLabel(record.review_status || 'ogranskad'))}</span></header>
    <h3>${escapeHtml(record.preferred_name || record.id)}</h3>
    <p class="master-id">${escapeHtml(`${record.entity_type}:${record.id}`)}</p>
    <dl class="master-facts"><div><dt>Officiellt namn</dt><dd>${escapeHtml(official || '—')}</dd></div><div><dt>Del av</dt><dd>${escapeHtml(parent || '—')}</dd></div><div><dt>Fastigheter</dt><dd>${escapeHtml(properties.join(', ') || '—')}</dd></div><div><dt>Källkopplingar</dt><dd>${directLinks} direkta${groupedRows ? ` · ${groupedRows} grupperade rader` : ''}</dd></div></dl>
    ${aliases.length ? `<p class="alias-line"><strong>Andra namn:</strong> ${escapeHtml(aliases.join(', '))}</p>` : ''}
    ${record.note ? `<p class="master-note">${escapeHtml(record.note)}</p>` : ''}
    <button type="button" class="edit-master" data-master-type="${escapeAttribute(record.entity_type)}" data-master-id="${escapeAttribute(record.id)}">Redigera metadata</button>
  </article>`;
}

function renderStructure() {
  const records = filteredMasterRecords();
  $('#filter-count').textContent = `${records.length} av ${masterRecords().length} masterobjekt`;
  return `<section class="structure-view"><header class="structure-intro"><div><p class="eyebrow dark">En post per verkligt objekt</p><h2>Östruktur</h2><p>Här byggs den stabila geografin. Namnformer och fastighetskopplingar är egna, källspårbara lager; kartans 161 rader ligger kvar separat.</p></div><button type="button" class="primary new-master" data-action="new-master">+ Ny plats eller byggnad</button></header>
    <div class="structure-callout"><strong>Strukturen är inte samma sak som kartan.</strong><span>En kartpost kan länkas till ett masterobjekt först när identiteten är tillräckligt säker.</span></div>
    <div class="master-grid">${records.map(masterCard).join('')}</div>
    ${records.length ? '' : '<div class="empty"><h2>Inga masterobjekt matchar filtren.</h2></div>'}
  </section>`;
}

function queueRank(status) { return ({ ogranskad: 0, osäker: 1, rättad: 2, bekräftad: 3, utgår: 4 })[status] ?? 9; }

function renderQueue() {
  const entries = filteredEntries().sort((a, b) => queueRank(a.review_status) - queueRank(b.review_status) || sourceIdNumber(a.id) - sourceIdNumber(b.id));
  $('#filter-count').textContent = `${entries.length} poster i kön`;
  return `<section class="review-queue"><header><p class="eyebrow dark">Rad för rad</p><h2>Granskningskö</h2><p>Ogranskade och osäkra poster ligger först. Tidigare beslut visas som förslag, inte som sanning.</p></header><div class="queue-grid">${entries.map(entry => {
    const effective = effectiveEntry(entry); const proposal = proposedReview(entry);
    return `<button type="button" class="queue-card status-${escapeAttribute(effective.effective_status)}" data-entry-id="${escapeAttribute(entry.id)}"><span class="source-number">${escapeHtml(entry.id)} · rad ${entry.source_row}</span><h3>${escapeHtml(entry.source_name || 'Namnlös post')}</h3><p>${escapeHtml([entry.source_island, entry.source_property].filter(Boolean).join(' · '))}</p><div class="queue-proposal"><span>${escapeHtml(objectTypeLabel(effective.effective_object_class, effective.effective_subtype))}</span><span>${escapeHtml(effective.effective_property_ids.join(' + ') || 'utan fastighet')}</span></div><strong>${escapeHtml(reviewStatusLabel(effective.effective_status))}</strong></button>`;
  }).join('')}</div></section>`;
}

function renderTable() {
  const entries = filteredEntries();
  $('#filter-count').textContent = `${entries.length} källrader`;
  return `<section class="table-view"><header class="table-intro"><div><p class="eyebrow dark">Snabb kontroll och redigering</p><h2>Alla kartposter</h2><p>Det viktigaste syns direkt. Öppna en rad för samtliga källfält och granskningsfält, eller välj Redigera för att ändra posten.</p></div><div class="table-legend"><span><i class="source-swatch"></i>Källa</span><span><i class="review-swatch"></i>Granskning</span></div></header><div class="table-scroll polished-table"><table><thead><tr><th class="pin-id">Rad</th><th class="pin-name">Namn</th><th>Ö och fastighet</th><th>Objekt</th><th>Ägare/etikett</th><th>Anteckning</th><th>Granskning</th><th>Åtgärd</th></tr></thead><tbody>${entries.map(entry => {
    const effective = effectiveEntry(entry); const expanded = expandedTableRows.has(entry.id); const link = mapEntryLink(entry.id); const target = link ? masterByRef(masterRef(link.target_type, link.target_id)) : null;
    const nameChanged = effective.effective_name && effective.effective_name !== entry.source_name;
    const sourceDetails = [
      ['Ö', entry.source_island], ['Fastighet', entry.source_property], ['Kartetikett', entry.source_owner_label], ['Dagens ägare i arbetsfilen', entry.source_current_owner],
      ['Namn', entry.source_name], ['Namntyp på kartan', entry.source_name_type], ['Källa', entry.source_origin], ['Anteckning', entry.source_note],
      ['Tidigare typbeslut', entry.prior_type_decision], ['Tidigare kommentar/rättelse', entry.prior_correction], ['Källrad', `${entry.id} · rad ${entry.source_row}`],
    ];
    const reviewDetails = [
      ['Status', reviewStatusLabel(effective.effective_status)], ['Visningsnamn', effective.effective_name], ['Objektstyp', objectTypeLabel(effective.effective_object_class, effective.effective_subtype)],
      ['Ö/överordnad plats', effective.effective_island], ['Fastighets-ID:n', (effective.effective_property_ids || []).join(', ')], ['Masterobjekt', masterLabel(target)],
      ['Granskningsnot', entry.review_note], ['Grund', entry.review_basis],
    ];
    return `<tr class="data-row status-${escapeAttribute(effective.effective_status)}"><td class="pin-id"><span class="row-id">${escapeHtml(entry.id)}</span><small>rad ${entry.source_row}</small></td><td class="pin-name"><strong>${escapeHtml(entry.source_name || 'Namnlös post')}</strong>${nameChanged ? `<small>→ ${escapeHtml(effective.effective_name)}</small>` : `<small>${escapeHtml(entry.source_name_type || '')}</small>`}</td><td><strong>${escapeHtml(effective.effective_island || '—')}</strong><small>${escapeHtml((effective.effective_property_ids || []).join(' + ') || 'utan säker fastighet')}</small></td><td><span class="type-pill class-${escapeAttribute(cssToken(effective.effective_object_class))}">${escapeHtml(objectTypeLabel(effective.effective_object_class, effective.effective_subtype))}</span></td><td><strong>${escapeHtml(entry.source_owner_label || '—')}</strong><small>${escapeHtml(entry.source_current_owner || '')}</small></td><td class="note-cell">${escapeHtml(entry.source_note || entry.prior_correction || '—')}</td><td><span class="table-status status-${escapeAttribute(effective.effective_status)}">${escapeHtml(reviewStatusLabel(effective.effective_status))}</span>${target ? `<small class="master-link-label">${escapeHtml(target.preferred_name)}</small>` : ''}</td><td><div class="row-actions"><button type="button" data-table-toggle="${escapeAttribute(entry.id)}" aria-expanded="${expanded}">${expanded ? 'Dölj' : 'Visa allt'}</button><button type="button" class="row-edit" data-entry-id="${escapeAttribute(entry.id)}">Redigera</button></div></td></tr>
      <tr class="detail-row" ${expanded ? '' : 'hidden'}><td colspan="8"><div class="row-detail"><section><h3>Ordagrann källa</h3><dl>${sourceDetails.map(([label, value]) => sourceField(label, value)).join('')}</dl></section><section><h3>Granskningslager</h3><dl>${reviewDetails.map(([label, value]) => sourceField(label, value)).join('')}</dl><button type="button" class="primary" data-entry-id="${escapeAttribute(entry.id)}">Justera raden</button></section></div></td></tr>`;
  }).join('')}</tbody></table></div></section>`;
}

function updateFilterOptions() {
  const update = (selector, placeholder, values) => {
    const select = $(selector); const current = select.value; const sorted = unique(values).sort((a, b) => String(a).localeCompare(String(b), 'sv', { numeric: true }));
    select.innerHTML = `<option value="">${placeholder}</option>` + sorted.map(value => `<option value="${escapeAttribute(value)}">${escapeHtml(value)}</option>`).join('');
    select.value = sorted.includes(current) ? current : '';
  };
  update('#island-filter', 'Alla öar/områden', [
    ...entryRecords().map(entry => effectiveEntry(entry).effective_island),
    ...placeRecords().filter(place => place.subtype === 'ö').map(place => place.preferred_name),
  ]);
  update('#subtype-filter', 'Alla undertyper', [
    ...entryRecords().map(entry => effectiveEntry(entry).effective_subtype), ...masterRecords().map(record => record.subtype),
  ]);
  update('#property-filter', 'Alla fastigheter', [
    ...entryRecords().flatMap(entry => effectiveEntry(entry).effective_property_ids || []), ...propertyLinks().map(link => link.property_id),
  ]);
}

function render() {
  updateFilterOptions(); renderSummary();
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === ui.view));
  content.innerHTML = ui.view === 'structure' ? renderStructure() : ui.view === 'queue' ? renderQueue() : ui.view === 'table' ? renderTable() : renderAtlas();
  if (selectedEntryId) renderDrawer(selectedEntryId);
  if (selectedMaster) renderMasterDrawer(selectedMaster.type, selectedMaster.id);
}

function sourceField(label, value) { return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? '—')}</dd></div>`; }
function option(value, selected, label = value) { return `<option value="${escapeAttribute(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`; }

function renderDrawer(id) {
  const entry = entryRecords().find(item => item.id === id);
  if (!entry) return closeDrawer();
  const proposal = proposedReview(entry);
  const reviewed = entry.review_status && entry.review_status !== 'ogranskad';
  const form = reviewed ? entry : { ...proposal, review_status: 'rättad' };
  const currentLink = mapEntryLink(entry.id);
  const currentTargetRef = currentLink ? masterRef(currentLink.target_type, currentLink.target_id) : '';
  const targetOptions = masterRecords().map(record => ({ value: masterRef(record.entity_type, record.id), label: masterLabel(record) }));
  drawerContent.innerHTML = `<header class="drawer-header"><p class="eyebrow dark">${escapeHtml(entry.id)} · källrad ${entry.source_row}</p><h2>${escapeHtml(entry.source_name || 'Namnlös kartpost')}</h2><span class="large-status status-${escapeAttribute(entry.review_status || 'ogranskad')}">${escapeHtml(reviewStatusLabel(entry.review_status || 'ogranskad'))}</span></header>
    <section class="drawer-section source-panel"><h3>Ordagrann källuppgift</h3><p>Detta lager är låst och förändras aldrig av granskningen.</p><dl>${sourceField('Ö', entry.source_island)}${sourceField('Fastighet', entry.source_property)}${sourceField('Kartetikett', entry.source_owner_label)}${sourceField('Dagens ägare i arbetsfilen', entry.source_current_owner)}${sourceField('Namn', entry.source_name)}${sourceField('Namntyp på kartan', entry.source_name_type)}${sourceField('Källa', entry.source_origin)}${sourceField('Anteckning', entry.source_note)}</dl></section>
    <section class="drawer-section prior-panel"><h3>Tidigare arbetsförslag</h3><p>Detta kan vara användbart, men betraktas inte som kvalitetsgranskat av dig.</p><dl>${sourceField('Föreslagen typ', entry.prior_type_decision)}${sourceField('Kommentar/rättelse', entry.prior_correction)}${sourceField('Automatiskt läsförslag', `${classLabel(proposal.review_object_class)} · ${proposal.review_island || 'utan område'} · ${proposal.review_property_ids.join(' + ') || 'utan fastighet'}`)}</dl><button type="button" class="approve-button" data-action="approve-proposal">Godkänn tidigare förslag</button></section>
    <section class="drawer-section review-panel"><h3>Ditt granskningslager</h3><form id="review-form" class="review-form">
      <label>Granskningsstatus<select name="review_status">${REVIEW_STATUSES.filter(value => value !== 'ogranskad').map(value => option(value, form.review_status, reviewStatusLabel(value))).join('')}</select></label>
      <label>Objektstyp<select name="review_object_class">${OBJECT_CLASSES.map(value => option(value, form.review_object_class, classLabel(value))).join('')}</select></label>
      <label class="span-2">Länka till masterobjekt<select name="review_target_ref"><option value="">Ingen masterkoppling ännu</option>${targetOptions.map(item => option(item.value, currentTargetRef, item.label)).join('')}</select><small>Skapa först objektet under Östruktur om rätt plats eller byggnad saknas.</small></label>
      <label class="span-2">Godkänt visningsnamn<input name="review_name" value="${escapeAttribute(form.review_name || '')}" required></label>
      <label>Undertyp<input name="review_subtype" value="${escapeAttribute(form.review_subtype || '')}" list="subtype-options" placeholder="bostadshus, udde, äldre namn …"></label>
      <label>Ö eller överordnad plats<input name="review_island" value="${escapeAttribute(form.review_island || normalizeIslandDisplay(entry.source_island) || '')}"></label>
      <label class="span-2">Fastighets-ID:n<input name="review_property_ids" value="${escapeAttribute((form.review_property_ids || []).join(', '))}" placeholder="Alsvik 3:24, Alsvik 3:25"><small>Flera fastigheter skiljs med komma. Tomt fält betyder att kopplingen är okänd eller inte relevant.</small></label>
      <label class="span-2">Granskningsnot<textarea name="review_note" rows="4" placeholder="Varför ändras uppgiften? Vad behöver kontrolleras?">${escapeHtml(form.review_note || '')}</textarea></label>
      <div class="form-actions span-2"><button class="primary" type="submit">Spara granskning</button>${reviewed ? '<button type="button" class="reset-button" data-action="reset-review">Återställ till ogranskad</button>' : ''}</div>
    </form></section>`;
  drawer.setAttribute('aria-hidden', 'false'); backdrop.hidden = false;
}

function renderMasterDrawer(type = 'place', id = null) {
  const record = id ? masterRecords().find(item => item.entity_type === type && item.id === id) : null;
  if (id && !record) return closeDrawer();
  const names = record ? namesFor(type, id) : [];
  const official = names.find(item => item.name_type === 'officiellt')?.name || '';
  const aliases = names.filter(item => item.name_type === 'alias').map(item => item.name).join('\n');
  const historical = names.filter(item => item.name_type === 'historiskt').map(item => item.name).join('\n');
  const relation = record ? relationFor(type, id) : null;
  const properties = record ? propertyLinksFor(type, id).map(link => link.property_id) : [];
  const placeOptions = placeRecords().filter(place => place.id !== id);
  const form = record || { preferred_name: '', subtype: type === 'place' ? 'plats' : 'byggnad', review_status: 'ogranskad', source_ids: [], note: '', valid_from: '', valid_to: '' };
  const nameEvidence = [...names].sort((a, b) => String(a.name_type || '').localeCompare(String(b.name_type || ''), 'sv') || String(a.name || '').localeCompare(String(b.name || ''), 'sv'));
  const nameEvidenceHtml = nameEvidence.length ? `<section class="drawer-section name-evidence"><h3>Källspårbara namnposter</h3><p>Varje rad behåller sin egen källa, datering och osäkerhet. Om du sparar samma namn igen bevaras denna proveniens.</p><div class="name-evidence-list">${nameEvidence.map(item => `<article><header><strong>${escapeHtml(item.name || 'Namnlös form')}</strong><span>${escapeHtml(nameTypeLabel(item.name_type))}</span></header><p>${escapeHtml([item.valid_from && `från ${item.valid_from}`, item.valid_to && `till ${item.valid_to}`, reviewStatusLabel(item.review_status)].filter(Boolean).join(' · '))}</p><p><b>Källa:</b> ${escapeHtml((item.source_ids || []).join(', ') || 'ej angiven')}</p>${item.note ? `<p>${escapeHtml(item.note)}</p>` : ''}</article>`).join('')}</div></section>` : '';
  drawerContent.innerHTML = `<header class="drawer-header"><p class="eyebrow dark">${record ? escapeHtml(`${type}:${id}`) : 'Nytt masterobjekt'}</p><h2>${escapeHtml(record?.preferred_name || 'Plats eller byggnad')}</h2><span class="large-status status-${escapeAttribute(form.review_status || 'ogranskad')}">${escapeHtml(reviewStatusLabel(form.review_status || 'ogranskad'))}</span></header>
    <section class="drawer-section master-explainer"><h3>Ett stabilt verkligt objekt</h3><p>Namn, relationer och fastighetskopplingar sparas i egna källspårbara poster. Att byta namn ändrar därför inte objektets ID.</p></section>
    ${nameEvidenceHtml}
    <section class="drawer-section review-panel"><form id="master-form" class="review-form" data-existing-type="${escapeAttribute(record ? type : '')}" data-existing-id="${escapeAttribute(record ? id : '')}">
      <label>Objektslag<select name="master_type" ${record ? 'disabled' : ''}>${option('place', type, 'Plats')}${option('building', type, 'Byggnad')}</select></label>
      <label>Stabilt ID<input name="master_id" value="${escapeAttribute(id || '')}" ${record ? 'readonly' : ''} placeholder="skapas från namnet om fältet lämnas tomt"><small>ID ändras inte när namnet ändras.</small></label>
      <label class="span-2">Föredraget visningsnamn<input name="preferred_name" value="${escapeAttribute(form.preferred_name || '')}" required></label>
      <label>Undertyp<input name="subtype" value="${escapeAttribute(form.subtype || '')}" list="master-subtype-options" required></label>
      <label>Granskningsstatus<select name="review_status">${REVIEW_STATUSES.map(value => option(value, form.review_status, reviewStatusLabel(value))).join('')}</select></label>
      <label class="span-2">Officiellt namn<input name="official_name" value="${escapeAttribute(official)}" placeholder="Exempel: Stora Korpholmen"></label>
      <label>Andra namn<textarea name="alias_names" rows="4" placeholder="Ett namn per rad">${escapeHtml(aliases)}</textarea></label>
      <label>Historiska namn<textarea name="historical_names" rows="4" placeholder="Ett namn per rad">${escapeHtml(historical)}</textarea></label>
      <label class="span-2">Del av<select name="parent_place_id"><option value="">Ingen överordnad plats</option>${placeOptions.map(place => option(place.id, relation?.parent_place_id || '', place.preferred_name || place.id)).join('')}</select></label>
      <label class="span-2">Fastighets-ID:n<input name="property_ids" value="${escapeAttribute(properties.join(', '))}" placeholder="Alsvik 3:24, Alsvik 3:25"><small>Detta är en geografisk koppling, inte ett påstående om ägande.</small></label>
      <label>Gäller från<input name="valid_from" value="${escapeAttribute(form.valid_from || '')}" placeholder="ÅÅÅÅ eller ÅÅÅÅ-MM-DD"></label>
      <label>Gäller till<input name="valid_to" value="${escapeAttribute(form.valid_to || '')}" placeholder="tomt = fortfarande gällande"></label>
      <label class="span-2">Käll-ID:n<input name="source_ids" value="${escapeAttribute((form.source_ids || []).join(', '))}" placeholder="KARTA-2025, BIO-SIMON"></label>
      <label class="span-2">Notering<textarea name="note" rows="4">${escapeHtml(form.note || '')}</textarea></label>
      <div class="form-actions span-2"><button class="primary" type="submit">Spara masterobjekt</button></div>
    </form></section>`;
  drawer.setAttribute('aria-hidden', 'false'); backdrop.hidden = false;
}

function openDrawer(id) { selectedMaster = null; selectedEntryId = id; renderDrawer(id); drawer.scrollTop = 0; }
function openMasterDrawer(type = 'place', id = null) { selectedEntryId = null; selectedMaster = { type, id }; renderMasterDrawer(type, id); drawer.scrollTop = 0; }
function closeDrawer() { selectedEntryId = null; selectedMaster = null; drawer.setAttribute('aria-hidden', 'true'); backdrop.hidden = true; }

async function syncEdit(action) {
  await action(); render(); setStatus('Sparat lokalt · synkar när Dropbox är tillgänglig', 'ok');
  if (navigator.onLine !== false) syncNow().catch(() => {});
}

async function setReviewFields(entryId, fields) {
  const entries = Object.entries(fields).map(([field, value]) => ({ entityType: 'map-entry', entityId: entryId, field, value }));
  await repository.setFields(entries);
}

async function setReviewAndLink(entryId, fields, targetRef) {
  const entries = Object.entries(fields).map(([field, value]) => ({ entityType: 'map-entry', entityId: entryId, field, value }));
  const target = masterByRef(targetRef);
  const linkId = `entry:${entryId}`;
  if (target) {
    const linkFields = {
      map_entry_id: entryId, target_type: target.entity_type, target_id: target.id,
      review_status: fields.review_status, source_id: entryRecords().find(entry => entry.id === entryId)?.source_document_id || null,
    };
    entries.push(...Object.entries(linkFields).map(([field, value]) => ({ entityType: 'map-entry-link', entityId: linkId, field, value })));
  }
  await repository.setFields(entries);
  if (!target && repository.getEntity('map-entry-link', linkId)) await repository.deleteEntity('map-entry-link', linkId);
}

function relatedEntityRefs(type, id) {
  return [
    ...namesFor(type, id).map(record => ({ entityType: 'name-record', entityId: record.id })),
    ...placeRelations().filter(record => record.child_type === type && record.child_id === id).map(record => ({ entityType: 'place-relation', entityId: record.id })),
    ...propertyLinksFor(type, id).map(record => ({ entityType: 'object-property-link', entityId: record.id })),
  ];
}

function addEntityFields(entries, entityType, entityId, fields) {
  entries.push(...Object.entries(fields).map(([field, value]) => ({ entityType, entityId, field, value })));
}

async function saveMaster(formNode) {
  const data = new FormData(formNode);
  const existingType = formNode.dataset.existingType || null;
  const existingId = formNode.dataset.existingId || null;
  const type = existingType || data.get('master_type');
  const preferredName = String(data.get('preferred_name') || '').trim();
  const id = existingId || stableEntityId(data.get('master_id') || preferredName);
  if (!['place', 'building'].includes(type)) throw new Error('Välj plats eller byggnad');
  if (!id || !/^[a-z0-9-]+$/.test(id)) throw new Error('Stabilt ID får bara innehålla a–z, siffror och bindestreck');
  if (!existingId && repository.getEntity(type, id)) throw new Error(`Det finns redan ett ${type === 'place' ? 'plats' : 'byggnads'}objekt med ID ${id}`);
  const status = data.get('review_status') || 'ogranskad';
  const sourceIds = splitList(data.get('source_ids'));
  if (status === 'bekräftad' && !sourceIds.length) throw new Error('Ett bekräftat masterobjekt måste ha minst ett käll-ID');
  const validFrom = String(data.get('valid_from') || '').trim() || null;
  const validTo = String(data.get('valid_to') || '').trim() || null;
  const common = { review_status: status, source_ids: sourceIds, valid_from: validFrom, valid_to: validTo };
  const existingNames = existingId ? namesFor(type, id) : [];
  const desired = [];
  const desiredRefs = new Set();
  const add = (entityType, entityId, fields) => { desiredRefs.add(`${entityType}\u0000${entityId}`); addEntityFields(desired, entityType, entityId, fields); };

  add(type, id, {
    preferred_name: preferredName,
    subtype: String(data.get('subtype') || '').trim(),
    review_status: status,
    source_ids: sourceIds,
    note: String(data.get('note') || '').trim() || null,
    valid_from: validFrom,
    valid_to: validTo,
  });
  const addName = (nameType, name, fallbackId) => {
    const previous = existingNames.find(item => item.name_type === nameType && item.name === name);
    const fields = {
      target_type: type, target_id: id, name, name_type: nameType,
      ...common,
      source_ids: previous ? unique([...(previous.source_ids || []), ...sourceIds]) : sourceIds,
      valid_from: previous?.valid_from ?? validFrom,
      valid_to: previous?.valid_to ?? validTo,
      note: previous?.note || null,
    };
    add('name-record', previous?.id || fallbackId, fields);
  };
  addName('föredraget', preferredName, `${type}:${id}:preferred`);
  const official = String(data.get('official_name') || '').trim();
  if (official) addName('officiellt', official, `${type}:${id}:official`);
  for (const [nameType, values] of [['alias', splitList(data.get('alias_names'))], ['historiskt', splitList(data.get('historical_names'))]]) {
    values.forEach((name, index) => addName(nameType, name, `${type}:${id}:${nameType}:${stableEntityId(name) || index + 1}`));
  }
  const parentPlaceId = String(data.get('parent_place_id') || '').trim();
  if (parentPlaceId) add('place-relation', `part-of:${type}:${id}:${parentPlaceId}`, { child_type: type, child_id: id, relation_type: 'del_av', parent_place_id: parentPlaceId, ...common });
  for (const propertyId of propertyIdsFromText(data.get('property_ids'))) {
    add('object-property-link', `${type}:${id}:${stableEntityId(propertyId)}`, { target_type: type, target_id: id, property_id: propertyId, relation_type: 'ligger_pa', ...common });
  }

  const obsolete = existingId ? relatedEntityRefs(type, id).filter(ref => !desiredRefs.has(`${ref.entityType}\u0000${ref.entityId}`)) : [];
  await repository.setFields(desired);
  if (obsolete.length) await repository.deleteEntities(obsolete);
  selectedMaster = { type, id };
  render();
  setStatus('Masterobjekt sparat lokalt · synkar när Dropbox är tillgänglig', 'ok');
  if (navigator.onLine !== false) syncNow().catch(() => {});
}

async function approveProposal() {
  const entry = entryRecords().find(item => item.id === selectedEntryId); if (!entry) return;
  await syncEdit(() => setReviewFields(entry.id, proposedReview(entry)));
}

async function saveReview(formNode) {
  if (!selectedEntryId) return;
  const data = new FormData(formNode);
  const propertyIds = propertyIdsFromText(data.get('review_property_ids'));
  const fields = {
    review_status: data.get('review_status'),
    review_name: String(data.get('review_name') || '').trim() || null,
    review_object_class: data.get('review_object_class'),
    review_subtype: String(data.get('review_subtype') || '').trim() || null,
    review_island: normalizeIslandDisplay(data.get('review_island')),
    review_property_ids: propertyIds,
    review_note: String(data.get('review_note') || '').trim() || null,
    review_basis: 'manuellt granskat i Kartdata',
  };
  await syncEdit(() => setReviewAndLink(selectedEntryId, fields, data.get('review_target_ref')));
}

async function resetReview() {
  if (!selectedEntryId || !confirm('Återställa posten till ogranskad? Alla tidigare operationer finns kvar i historiken.')) return;
  const fields = Object.fromEntries(REVIEW_FIELDS.map(field => [field, null])); fields.review_status = 'ogranskad';
  await syncEdit(async () => { await setReviewFields(selectedEntryId, fields); const link = repository.getEntity('map-entry-link', `entry:${selectedEntryId}`); if (link) await repository.deleteEntity('map-entry-link', `entry:${selectedEntryId}`); });
}

function exportReviews() {
  const source = sourceRecords()[0] || {};
  const payload = {
    format: 'korpholmen-kartdata-review-v2',
    exported_at: new Date().toISOString(),
    source: { id: source.id, title: source.title, workbook_sha256: source.workbook_sha256, sheet: source.sheet, range: source.range },
    entries: entryRecords().map(entry => ({
      id: entry.id, source_row: entry.source_row, review_status: entry.review_status || 'ogranskad',
      ...Object.fromEntries(REVIEW_FIELDS.map(field => [field, entry[field] ?? null])),
    })),
    structure: {
      places: placeRecords(), buildings: buildingRecords(), names: nameRecords(),
      place_relations: placeRelations(), property_links: propertyLinks(), map_entry_links: mapEntryLinks(),
    },
  };
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `korpholmen-kartdata-granskning-${new Date().toISOString().slice(0, 10)}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return null;
  try { return await navigator.serviceWorker.register('./sw.js', { scope: './' }); }
  catch (error) { console.warn('Appskalet kunde inte uppdateras', error); return null; }
}

async function completeOAuthCallbackIfNeeded() {
  const url = new URL(location.href); if (!url.searchParams.has('code') && !url.searchParams.has('error')) return;
  const token = await completeDropboxOAuth(); accessToken = token.access_token;
  accessTokenExpiresAt = Date.now() + Math.max(30, Number(token.expires_in || 0) - 60) * 1000;
  if (token.refresh_token) await store.putMeta(TOKEN_META, token.refresh_token);
  for (const parameter of ['code', 'state', 'error', 'error_description']) url.searchParams.delete(parameter);
  history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

async function currentAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiresAt) return accessToken;
  const refreshToken = await store.getMeta(TOKEN_META); if (!refreshToken || !DROPBOX_CLIENT_ID || navigator.onLine === false) return null;
  const token = await exchangeDropboxRefreshToken({ clientId: DROPBOX_CLIENT_ID, refreshToken });
  accessToken = token.access_token; accessTokenExpiresAt = Date.now() + Math.max(30, Number(token.expires_in || 0) - 60) * 1000;
  if (token.refresh_token && token.refresh_token !== refreshToken) await store.putMeta(TOKEN_META, token.refresh_token);
  return accessToken;
}

async function uploadPendingMigration(transport, metaKey) {
  const pending = await store.getMeta(metaKey); if (!pending?.pending) return 0;
  const operations = (await store.getAllOps()).filter(op => op.device_id === pending.device_id && (!pending.first_seq || op.seq >= pending.first_seq) && (!pending.last_seq || op.seq <= pending.last_seq)).sort((a, b) => a.seq - b.seq);
  let uploaded = 0;
  for (let index = 0; index < operations.length; index += 250) { const batch = createBatch(operations.slice(index, index + 250)); await transport.putBatch(batch); uploaded += batch.ops.length; }
  await store.putMeta(metaKey, { ...pending, pending: false, uploaded_at: new Date().toISOString() }); return uploaded;
}

async function syncNow() {
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    const hasCredential = Boolean(await store.getMeta(TOKEN_META));
    if (navigator.onLine === false) { setStatus(`Offline · ${hasCredential ? 'Dropbox ansluten · ' : ''}ändringar sparas lokalt`, 'warning'); return null; }
    const token = await currentAccessToken(); if (!token) { setStatus('Lokalt sparat · Dropbox ej ansluten', 'warning'); connectButton.textContent = 'Anslut Dropbox'; return null; }
    connectButton.textContent = 'Synka Dropbox'; setStatus('Synkar…');
    const transport = new DropboxTransport({ accessToken: token, id: 'dropbox-kartdata', opsRoot: '/kartdata/ops' });
    const bootstrap = await uploadPendingMigration(transport, BOOTSTRAP_META) + await uploadPendingMigration(transport, STRUCTURE_META) + await uploadPendingMigration(transport, PLACE_NAMES_META); const result = await new SyncEngine({ repository, transport }).syncOnce();
    render(); setStatus(`Synkad · ${bootstrap + result.uploadedOps} upp, ${result.downloadedOps} ned`, 'ok'); return result;
  })().catch(error => { console.error(error); if (isOfflineError(error)) { setStatus('Offline · lokalt sparat · synkas automatiskt', 'warning'); return null; } setStatus(`Åtgärd krävs · ${error.message}`, 'error'); throw error; }).finally(() => { syncPromise = null; });
  return syncPromise;
}

async function connectDropbox() {
  sessionStorage.setItem('korpholmen:oauth-return', new URL('kartdata/', redirectUri()).pathname);
  const attempt = await beginDropboxOAuth({ clientId: DROPBOX_CLIENT_ID, redirectUri: redirectUri(), scopes: DROPBOX_SCOPES }); location.assign(attempt.url);
}

async function bootstrapLocal({ force = false } = {}) {
  if (!isSourceTree) throw new Error('Startkopian kan bara aktiveras från källappen');
  if (!force && entryRecords().length) return false;
  const response = await fetch(LOCAL_BOOTSTRAP_URL, { cache: 'no-store' }); if (!response.ok) throw new Error(`Startkopian kunde inte läsas (${response.status})`);
  const document = await response.json(); if (document.operations_version !== 1 || !Array.isArray(document.operations)) throw new Error('Startkopian har fel format');
  document.operations.forEach(validateOperation); await repository.applyRemoteOps(document.operations);
  await store.putMeta(BOOTSTRAP_META, {
    pending: true,
    device_id: document.device_id,
    migration_id: document.migration_id,
    operations: document.operations.length,
    includes_structure: document.operations.some(operation => operation.entity_type === 'place'),
  });
  render(); setStatus('Arbetsbokens 161 källrader inlästa lokalt · ännu inte kvalitetsgranskade', 'ok'); return true;
}

async function bootstrapStructure() {
  if (!isSourceTree) return false;
  const existing = await store.getMeta(STRUCTURE_META);
  if (existing?.applied && placeRecords().length) return false;
  const response = await fetch(STRUCTURE_BOOTSTRAP_URL, { cache: 'no-store' }); if (!response.ok) throw new Error(`Östrukturen kunde inte läsas (${response.status})`);
  const document = await response.json(); if (document.operations_version !== 1 || !Array.isArray(document.operations)) throw new Error('Östrukturen har fel format');
  document.operations.forEach(validateOperation);
  if (!placeRecords().length) await repository.applyRemoteOps(document.operations);
  const sequences = document.operations.map(operation => operation.seq);
  const fullBootstrap = await store.getMeta(BOOTSTRAP_META);
  await store.putMeta(STRUCTURE_META, {
    applied: true, pending: !fullBootstrap?.includes_structure && !existing?.uploaded_at, device_id: document.device_id, migration_id: document.migration_id,
    operations: document.operations.length, first_seq: Math.min(...sequences), last_seq: Math.max(...sequences),
  });
  render(); setStatus(`${placeRecords().length} platsobjekt inlästa · bekräftade beslut och ogranskade förslag hålls isär`, 'ok'); return true;
}

async function bootstrapPlaceNames() {
  if (!isSourceTree) return false;
  const existing = await store.getMeta(PLACE_NAMES_META);
  if (existing?.applied) return false;
  const response = await fetch(PLACE_NAMES_BOOTSTRAP_URL, { cache: 'no-store' }); if (!response.ok) throw new Error(`Namnunderlaget kunde inte läsas (${response.status})`);
  const document = await response.json(); if (document.operations_version !== 1 || !Array.isArray(document.operations)) throw new Error('Namnunderlaget har fel format');
  document.operations.forEach(validateOperation); await repository.applyRemoteOps(document.operations);
  const sequences = document.operations.map(operation => operation.seq);
  await store.putMeta(PLACE_NAMES_META, {
    applied: true, pending: true, device_id: document.device_id, migration_id: document.migration_id,
    operations: document.operations.length, first_seq: Math.min(...sequences), last_seq: Math.max(...sequences),
  });
  render(); setStatus(`${placeRecords().length} platsobjekt och ${nameRecords().length} namnposter inlästa · osäkra namn väntar på din granskning`, 'ok'); return true;
}

content.addEventListener('click', event => {
  const toggle = event.target.closest('[data-table-toggle]');
  if (toggle) { const id = toggle.dataset.tableToggle; if (expandedTableRows.has(id)) expandedTableRows.delete(id); else expandedTableRows.add(id); render(); return; }
  const master = event.target.closest('[data-master-type][data-master-id]'); if (master) { openMasterDrawer(master.dataset.masterType, master.dataset.masterId); return; }
  if (event.target.closest('[data-action="new-master"]')) { openMasterDrawer('place', null); return; }
  const target = event.target.closest('[data-entry-id]'); if (target) openDrawer(target.dataset.entryId);
});
summary.addEventListener('click', event => {
  const master = event.target.closest('[data-master-filter]'); if (master) { ui.masterFilter = master.dataset.masterFilter; render(); return; }
  const target = event.target.closest('[data-summary-status]'); if (!target) return; ui.status = target.dataset.summaryStatus; $('#status-filter').value = ui.status; render();
});
backdrop.addEventListener('click', closeDrawer);
drawer.addEventListener('click', event => {
  if (event.target.closest('[data-action="close"]')) closeDrawer();
  if (event.target.closest('[data-action="approve-proposal"]')) approveProposal().catch(error => setStatus(error.message, 'error'));
  if (event.target.closest('[data-action="reset-review"]')) resetReview().catch(error => setStatus(error.message, 'error'));
});
drawer.addEventListener('submit', event => {
  event.preventDefault();
  if (event.target.id === 'review-form') saveReview(event.target).catch(error => setStatus(error.message, 'error'));
  if (event.target.id === 'master-form') saveMaster(event.target).catch(error => setStatus(error.message, 'error'));
});
$('#search').addEventListener('input', event => { ui.search = event.target.value; render(); });
$('#island-filter').addEventListener('change', event => { ui.island = event.target.value; render(); });
$('#class-filter').addEventListener('change', event => { ui.objectClass = event.target.value; render(); });
$('#subtype-filter').addEventListener('change', event => { ui.subtype = event.target.value; render(); });
$('#property-filter').addEventListener('change', event => { ui.property = event.target.value; render(); });
$('#status-filter').addEventListener('change', event => { ui.status = event.target.value; render(); });
$('#sort-order').addEventListener('change', event => { ui.sort = event.target.value; render(); });
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { ui.view = button.dataset.view; render(); }));
connectButton.addEventListener('click', () => currentAccessToken().then(token => token ? syncNow() : connectDropbox()).catch(error => setStatus(error.message, 'error')));
bootstrapButton.addEventListener('click', () => bootstrapLocal({ force: true }).catch(error => setStatus(error.message, 'error')));
$('#export-json').addEventListener('click', exportReviews);
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeDrawer(); });
window.addEventListener('online', () => syncNow().catch(() => {})); window.addEventListener('offline', () => syncNow().catch(() => {}));

async function init() {
  const serviceWorkerPromise = registerServiceWorker();
  const db = await openSlaktlandskapDB({ name: 'korpholmen-kartdata' }); store = new IndexedDBStore(db);
  repository = await new Repository({ store, deviceId: deviceId() }).init();
  bootstrapButton.hidden = !isSourceTree; render();
  if (isSourceTree && !entryRecords().length) await bootstrapLocal();
  if (isSourceTree) await bootstrapStructure();
  if (isSourceTree) await bootstrapPlaceNames();
  await completeOAuthCallbackIfNeeded(); await syncNow(); await serviceWorkerPromise;
}

init().catch(error => { console.error(error); setStatus(`Kunde inte starta · ${error.message}`, 'error'); });
