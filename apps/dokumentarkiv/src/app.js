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
import { resolveArchiveEntity } from '../../../packages/core/master-data.js';
import { ReadOnlyMaster } from '../../../packages/core/read-only-master.js';
import { DROPBOX_CLIENT_ID, DROPBOX_SCOPES, LOCAL_BOOTSTRAP_URL } from './config.js';

const $ = selector => document.querySelector(selector);
const appNode = $('#app-view');
const statusNode = $('#sync-status');
const connectButton = $('#connect-dropbox');
const bootstrapButton = $('#bootstrap-local');
const isSourceTree = location.pathname.includes('/apps/dokumentarkiv/');
const TOKEN_META = 'dropbox:refresh-token';
const BOOTSTRAP_META = 'bootstrap:dokumentarkiv:current';
const CONTENT_IMAGE_KEY_PREFIX = 'dokumentarkiv:innehållsbild:';
const LOCAL_REVIEW_URL = 'http://127.0.0.1:4317/';
const AUTO_SYNC_INTERVAL = 120_000;
const ENTITY_TYPES = ['person', 'båt', 'plats', 'fastighet', 'hus', 'organisation'];
const STOP_WORDS = new Set('och eller men att det den de som när var vad hur vem vilka från till med för vid ett en av på om i ur har hade finns blev blir kan ska skulle är var'.split(' '));
const ui = {
  view: 'overview', search: '', categories: new Set(), entityType: 'alla', status: 'alla', period: '',
  selectedId: '', selectedTrack: '', selectedEntityId: '', selectedPlaceId: '', sourceOpen: false,
  compareHlc: '', question: '',
};
let store;
let repository;
let matrikelMaster;
let batregisterMaster;
let fastigheterMaster;
let kartdataMaster;
let historyOperations = [];
let accessToken = null;
let accessTokenExpiresAt = 0;
let syncPromise = null;
const contentImageUrls = new Map();
const viewCache = createRevisionCache(() => `${repository?.revision || 0}:${matrikelMaster?.revision || 0}:${batregisterMaster?.revision || 0}:${fastigheterMaster?.revision || 0}:${kartdataMaster?.revision || 0}`);

const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const escapeAttribute = escapeHtml;
const normalize = value => String(value || '').normalize('NFC').toLocaleLowerCase('sv');
const typeLabel = type => type ? type.charAt(0).toLocaleUpperCase('sv') + type.slice(1) : 'Okänd';
const recordList = type => viewCache(`records:${type}`, () => repository ? repository.listEntities(type).map(entity => ({ id: entity.entity_id, ...entity.fields })) : []);
const documentRecords = () => viewCache('documents', () => [...recordList('document')].sort((a, b) => String(a.document_date).localeCompare(String(b.document_date), 'sv') || String(a.title || '').localeCompare(String(b.title || ''), 'sv')));
const entityRecords = () => viewCache('archive-entities', () => recordList('archive-entity')
  .map(entity => resolveArchiveEntity(entity, { personMaster: matrikelMaster, boatMaster: batregisterMaster, fastigheterMaster, kartdataMaster }))
  .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'sv')));
const entityMap = () => viewCache('archive-entity-map', () => new Map(entityRecords().map(entity => [entity.id, entity])));
const summaryRecord = () => recordList('archive-summary')[0] || {};
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

function setStatus(text, tone = '') {
  statusNode.textContent = text;
  statusNode.className = tone ? `status-${tone}` : '';
}

const deviceId = () => resolveDeviceId({ store, key: 'korpholmen:dokumentarkiv-device-id', prefix: 'dokumentarkiv-web-' });

function redirectUri() { return new URL(isSourceTree ? '../../' : '../', location.href).href; }
function dateLabel(date) {
  const match = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return date || 'Odaterat';
  return new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${date}T12:00:00`));
}
function yearLabel(document) { return document.year || 'Odaterat'; }
function periodLabel(period) {
  if (!period) return '';
  const [kind, value] = period.split(':');
  if (kind === 'year') return value;
  if (kind === 'decade') return `${value}-talet`;
  return 'Odaterat';
}

function inlineText(value) {
  return escapeHtml(value)
    .replace(/\[(osäker[^\]]*|osäkert[^\]]*|oläsligt[^\]]*|överstruket[^\]]*|handskrivet[^\]]*)\]/gi, '<mark class="osaker">[$1]</mark>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(/&lt;u&gt;(.*?)&lt;\/u&gt;/g, '<u>$1</u>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/ {2}$/g, '<br>');
}

function tableCells(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
}

function contentImageFigure(raw, documentRecord) {
  const match = String(raw || '').match(/^!\[([^\]]*)\]\((?:<([^>]+)>|([^)]+))\)\s*$/);
  if (!match) return '';
  const alt = match[1].trim();
  const filename = String(match[2] || match[3] || '').trim();
  const image = (documentRecord?.content_images || []).find(item => normalize(item.filename) === normalize(filename));
  if (!image) return '';
  const url = contentImageUrls.get(image.sha256);
  return `<figure class="innehallsbild">${url ? `<img src="${escapeAttribute(url)}" alt="${escapeAttribute(alt || image.alt || '')}" loading="lazy">` : '<div class="bildplatshallare">Innehållsbilden hämtas från Dropbox…</div>'}<figcaption>${escapeHtml(alt || image.alt || filename)}</figcaption></figure>`;
}

function markdown(value, documentRecord = null) {
  const lines = String(value || '').split('\n');
  const output = [];
  let list = [];
  let code = null;
  const flushList = () => { if (list.length) output.push(`<ul>${list.map(item => `<li>${inlineText(item)}</li>`).join('')}</ul>`); list = []; };
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw.startsWith('```')) {
      if (code) { output.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`); code = null; }
      else { flushList(); code = []; }
      continue;
    }
    if (code) { code.push(raw); continue; }
    const imageFigure = contentImageFigure(raw, documentRecord);
    if (imageFigure) { flushList(); output.push(imageFigure); continue; }
    if (/^\|.+\|$/.test(raw) && /^\|?[\s:|-]+\|/.test(lines[index + 1] || '')) {
      flushList();
      const header = tableCells(raw);
      index += 1;
      const rows = [];
      while (/^\|.+\|$/.test(lines[index + 1] || '')) rows.push(tableCells(lines[++index]));
      output.push(`<div class="tabellram"><table><thead><tr>${header.map(cell => `<th>${inlineText(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${inlineText(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^-\s+/.test(raw)) { list.push(raw.replace(/^-\s+/, '')); continue; }
    flushList();
    if (raw.startsWith('#### ')) output.push(`<h4>${escapeHtml(raw.slice(5))}</h4>`);
    else if (raw.startsWith('### ')) output.push(`<h3>${escapeHtml(raw.slice(4))}</h3>`);
    else if (raw.startsWith('## ')) output.push(`<h2>${escapeHtml(raw.slice(3))}</h2>`);
    else if (raw.startsWith('> ')) output.push(`<blockquote>${inlineText(raw.slice(2))}</blockquote>`);
    else if (raw.trim()) output.push(`<p>${inlineText(raw)}</p>`);
  }
  flushList();
  return output.join('');
}

function matchesPeriod(document) {
  if (!ui.period) return true;
  const [kind, value] = ui.period.split(':');
  if (kind === 'year') return String(document.year) === value;
  if (kind === 'decade') return String(document.decade) === value;
  return !document.year;
}

function baseFilteredDocuments() {
  const map = entityMap();
  const query = normalize(ui.search.trim());
  return documentRecords().filter(document => {
    const entities = (document.entity_ids || []).map(id => map.get(id)).filter(Boolean);
    if (ui.categories.size && !ui.categories.has(document.category)) return false;
    if (ui.entityType !== 'alla' && !entities.some(entity => entity.entity_type === ui.entityType)) return false;
    if (ui.status !== 'alla' && document.status !== ui.status) return false;
    if (!query) return true;
    const searchText = viewCache(`document-search:${document.id}`, () => normalize([document.title, document.document_type, document.document_date, document.collection, document.transcript, ...entities.map(entity => entity.name)].join(' ')));
    return searchText.includes(query);
  });
}

function filteredDocuments() { return baseFilteredDocuments().filter(matchesPeriod); }

function entityBadge(entity) {
  const initial = entity.entity_type === 'person' ? 'P' : entity.entity_type === 'båt' ? 'B' : entity.entity_type === 'organisation' ? 'O' : 'L';
  return `<button type="button" class="entitetsmarke ${escapeAttribute(entity.match_status)}" data-entity-id="${escapeAttribute(entity.id)}"><span class="entitetsikon">${initial}</span>${escapeHtml(entity.name)}</button>`;
}

function renderFilters(documents) {
  const categories = ['Alla', ...new Set(documentRecords().map(document => document.category))];
  $('#category-filters').innerHTML = categories.map(category => {
    const selected = category === 'Alla' ? ui.categories.size === 0 : ui.categories.has(category);
    return `<button type="button" data-category="${escapeAttribute(category)}" class="${selected ? 'vald' : ''}" aria-pressed="${selected}">${escapeHtml(category)}</button>`;
  }).join('');
  $('#document-total').textContent = String(documentRecords().length);
  const years = documentRecords().map(document => document.year).filter(Number.isFinite);
  $('#year-range').textContent = years.length ? `${Math.min(...years)}–${Math.max(...years)}` : '—';
  $('#clear-search').hidden = !ui.search;
  $('#clear-filters').hidden = !ui.categories.size && ui.entityType === 'alla' && ui.status === 'alla' && !ui.period;
  $('#entity-filter').value = ui.entityType;
  $('#status-filter').value = ui.status;
  $('#view-tabs').querySelectorAll('[data-view]').forEach(button => {
    const active = button.dataset.view === ui.view;
    button.classList.toggle('aktiv', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  $('#live-region').textContent = `${documents.length} handlingar i urvalet`;
}

function emptyState(title, text, icon = '§') {
  const noData = documentRecords().length === 0;
  return `<div class="tomtresultat"><span aria-hidden="true">${icon}</span><h2>${escapeHtml(noData ? 'Arkivet väntar på Dropbox' : title)}</h2><p>${escapeHtml(noData ? 'Anslut Dropbox för att hämta de privata avskrifterna till den här enheten.' : text)}</p>${noData ? '<button type="button" data-action="connect">Anslut Dropbox</button>' : '<button type="button" data-action="clear">Rensa filter</button>'}</div>`;
}

function renderOverview(documents) {
  if (!documentRecords().length) return emptyState('', '');
  const finished = documents.filter(document => document.status === 'färdig').length;
  const review = documents.filter(document => document.status === 'kontroll behövs').length;
  const dated = documents.filter(document => Number.isFinite(document.year));
  const decades = [...new Set(documentRecords().map(document => document.decade).filter(Number.isFinite))].sort((a, b) => a - b);
  const yearCounts = new Map(dated.map(document => document.year).map(year => [year, dated.filter(document => document.year === year).length]));
  const maximum = Math.max(1, ...yearCounts.values());
  const decadeCards = decades.map(decade => {
    const count = documents.filter(document => document.decade === decade).length;
    const total = documentRecords().filter(document => document.decade === decade).length;
    return `<button type="button" class="decenniekort ${ui.period === `decade:${decade}` ? 'aktiv' : ''}" data-decade="${decade}"><span>${decade}-talet</span><strong>${count}</strong><small>${count === total ? plural(total, 'handling', 'handlingar') : `${count} av ${total}`}</small><i style="--andel:${total ? count / total : 0}"></i></button>`;
  }).join('');
  const undated = documents.filter(document => !document.year).length;
  const matrix = decades.map(decade => `<div class="arsrad"><button type="button" data-decade="${decade}" class="arsradetikett">${decade}</button>${Array.from({ length: 10 }, (_, offset) => {
    const year = decade + offset;
    const count = yearCounts.get(year) || 0;
    return `<button type="button" data-year="${year}" class="arcell ${count ? 'har-data' : ''}" style="--styrka:${count / maximum}" aria-label="${year}: ${plural(count, 'handling', 'handlingar')}"><span>${String(year).slice(-2)}</span>${count ? `<strong>${count}</strong>` : '<i></i>'}</button>`;
  }).join('')}</div>`).join('');
  const categories = [...new Set(documentRecords().map(document => document.category))];
  const coverage = categories.map(category => `<div class="tackningsrad"><strong>${escapeHtml(category)}</strong>${decades.map(decade => {
    const count = documents.filter(document => document.category === category && document.decade === decade).length;
    return `<button type="button" data-decade="${decade}" data-category-jump="${escapeAttribute(category)}" class="tackningscell ${count ? 'fylld' : ''}"><span>${decade}</span><b>${count || '·'}</b></button>`;
  }).join('')}</div>`).join('');
  return `<section class="atlas">
    <header class="vyhuvud"><div><p class="overrad">Arkivatlas</p><h2>Se hela samlingen på en gång</h2><p>Varje decennium har samma bredd. Därför syns både de täta åren 1955–1956 och luckorna i samlingen utan att tidslinjen går sönder.</p></div>${ui.period ? `<button type="button" class="periodmarke" data-period-clear>Urval: ${escapeHtml(periodLabel(ui.period))} ×</button>` : ''}</header>
    <div class="statistikrad"><article><span>Handlingar i urvalet</span><strong>${documents.length}</strong><small>${documentRecords().length} i hela arkivet</small></article><article><span>Färdiga</span><strong>${finished}</strong><small>fullständigt kontrollerade</small></article><article><span>Behöver kontroll</span><strong>${review}</strong><small>kompletta arbetsutkast</small></article><article><span>Odaterade</span><strong>${undated}</strong><small>synliga men ej placerade</small></article></div>
    <section class="atlassektion"><div class="sektionsrubrik"><div><p class="overrad">Decenniekarta</p><h3>Arkivets tyngdpunkter</h3></div><p>Klicka på ett decennium för att läsa handlingarna.</p></div><div class="decennier">${decadeCards}</div></section>
    <section class="atlassektion"><div class="sektionsrubrik"><div><p class="overrad">Årsmatris</p><h3>År för år, lucka för lucka</h3></div><p>Färgstyrkan visar mängden handlingar under året.</p></div><div class="arsmatris">${matrix}</div></section>
    <section class="atlassektion"><div class="sektionsrubrik"><div><p class="overrad">Täckningskarta</p><h3>Vad finns – och vad saknas?</h3></div><p>En tom ruta betyder att arkivet saknar handlingar, inte att inget hände.</p></div><div class="tackningsmatris">${coverage}</div></section>
  </section>`;
}

function transcriptVersions(documentId) {
  const operations = historyOperations
    .filter(operation => operation.entity_type === 'document' && operation.entity_id === documentId && operation.field === 'transcript' && typeof operation.value === 'string')
    .sort((a, b) => a.hlc.localeCompare(b.hlc));
  const versions = [];
  for (const operation of operations) if (!versions.some(version => version.value === operation.value)) versions.push(operation);
  return versions;
}

function versionDate(hlc) {
  const timestamp = Number(String(hlc || '').split('-')[0]);
  return Number.isFinite(timestamp) ? new Intl.DateTimeFormat('sv-SE', { dateStyle: 'medium' }).format(new Date(timestamp)) : 'Okänt datum';
}

function comparisonHtml(selected) {
  if (!ui.compareHlc) return '';
  const versions = transcriptVersions(selected.id);
  const previous = versions.find(version => version.hlc === ui.compareHlc);
  if (!previous || previous.value === selected.transcript) return '';
  const oldLines = previous.value.split('\n').map(line => line.trim()).filter(Boolean);
  const newLines = selected.transcript.split('\n').map(line => line.trim()).filter(Boolean);
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const removed = oldLines.filter(line => !newSet.has(line)).slice(0, 24);
  const added = newLines.filter(line => !oldSet.has(line)).slice(0, 24);
  return `<section class="versionsjamforelse"><header><div><p class="overrad">Ändringsjämförelse</p><h3>${escapeHtml(versionDate(previous.hlc))} → aktuell version</h3></div><button type="button" data-action="close-compare">Stäng</button></header><div class="diffkolumner"><div><strong>Tidigare formuleringar</strong>${removed.map(line => `<p class="borttagen">− ${escapeHtml(line)}</p>`).join('') || '<p>Inga borttagna rader.</p>'}</div><div><strong>Nya formuleringar</strong>${added.map(line => `<p class="tillagd">+ ${escapeHtml(line)}</p>`).join('') || '<p>Inga tillagda rader.</p>'}</div></div><p class="kallkritik">Jämförelsen visar ändrade textrader. Bildoriginalet påverkas aldrig.</p></section>`;
}

function versionHistoryHtml(selected) {
  const versions = transcriptVersions(selected.id);
  return `<section class="versionshistorik"><div><p class="overrad">Versionshistorik</p><h3>${plural(versions.length || 1, 'bevarad avskriftsversion', 'bevarade avskriftsversioner')}</h3></div><div class="versioner">${versions.map((version, index) => `<button type="button" data-version-hlc="${escapeAttribute(version.hlc)}" ${index === versions.length - 1 ? 'disabled' : ''}><span>${index === versions.length - 1 ? 'Aktuell' : `Version ${index + 1}`}</span><small>${escapeHtml(versionDate(version.hlc))}</small></button>`).join('') || '<span class="versionensam">Första importerade versionen</span>'}</div></section>${comparisonHtml(selected)}`;
}

function documentCard(document, selectedId = '') {
  return `<button type="button" class="dokumentkort ${document.id === selectedId ? 'aktiv' : ''}" data-document-id="${escapeAttribute(document.id)}"><span class="kortdatum">${escapeHtml(document.document_date)}</span><strong>${escapeHtml(document.title)}</strong><span class="kortfot"><span>${escapeHtml(typeLabel(document.document_type))}</span><span>${document.image_count || 0} ${document.image_count === 1 ? 'bild' : 'bilder/sidor'}</span></span></button>`;
}

function readerHtml(selected, map) {
  if (!selected) return emptyState('Ingen handling hittades', 'Prova ett annat ord eller rensa något av filtren.', '⌕');
  const entities = (selected.entity_ids || []).map(id => map.get(id)).filter(Boolean);
  return `<article class="papper"><div class="halslagskant" aria-hidden="true"><i></i><i></i><i></i></div><header class="dokumenthuvud"><div class="dokumentmeta"><span>${escapeHtml(typeLabel(selected.document_type))}</span><span class="status ${selected.status === 'färdig' ? 'klar' : 'kontroll'}">${escapeHtml(selected.status)}</span></div><p class="dokumentdatum">${escapeHtml(dateLabel(selected.document_date))}</p><h2>${escapeHtml(selected.title)}</h2><p class="ingress">Ordagrann avskrift från ${plural(selected.image_count || 0, 'bild eller sida', 'bilder eller sidor')}. Stavning, interpunktion och dokumentets egen ton är bevarade.</p><div class="entitetsrad">${entities.map(entityBadge).join('')}</div></header><div class="ornament" aria-hidden="true"><span>§</span></div><div class="avskriftstext">${markdown(selected.transcript, selected)}</div><footer class="dokumentfot"><button type="button" data-action="source">${ui.sourceOpen ? 'Dölj källuppgift' : 'Visa källuppgift'}</button><span>Avskrift · Digitalisering 2026</span></footer>${ui.sourceOpen ? `<div class="kallruta"><strong>Källfil</strong><code>${escapeHtml(selected.source_path)}</code><p>Datering: ${escapeHtml(selected.dating)}. Avskriften visas utan modernisering.</p><p>Textfingeravtryck: <code>${escapeHtml(String(selected.transcript_sha256 || '').slice(0, 16))}…</code></p></div>` : ''}${versionHistoryHtml(selected)}</article>`;
}

function entityListHtml(documents, map) {
  const unique = new Map();
  for (const document of documents) for (const id of document.entity_ids || []) if (map.has(id)) unique.set(id, map.get(id));
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, 'sv')).map(entity => {
    const label = entity.match_status === 'kopplad' ? 'Kopplad' : entity.match_status === 'granska' ? 'Granska' : entity.match_status === 'saknas' ? 'Ej funnen' : 'Arkiventitet';
    const link = entity.url && entity.match_status === 'kopplad' ? `<a href="${escapeAttribute(entity.url)}" target="_blank" rel="noreferrer">${escapeHtml(entity.app)} ↗</a>` : '';
    return `<article class="sambandskort"><button type="button" class="sambandsnamn" data-entity-id="${escapeAttribute(entity.id)}"><span class="entitetsikon ${escapeAttribute(entity.entity_type)}">${typeLabel(entity.entity_type).charAt(0)}</span><span><strong>${escapeHtml(entity.name)}</strong><small>${escapeHtml(typeLabel(entity.entity_type))}</small></span></button><div class="kopplingsrad"><span class="kopplingsstatus ${escapeAttribute(entity.match_status)}">${label}</span>${link}</div>${entity.note ? `<p class="kopplingsnot">${escapeHtml(entity.note)}</p>` : ''}</article>`;
  }).join('') || '<p class="tomnot">Inga entiteter i det filtrerade urvalet.</p>';
}

function renderReader(documents) {
  const selected = documents.find(document => document.id === ui.selectedId) || documents[0] || null;
  if (selected) ui.selectedId = selected.id;
  const map = entityMap();
  return `<section class="lasvy"><aside class="dokumentlista" aria-label="Dokumentlista"><div class="listtitel"><span>${ui.period ? periodLabel(ui.period) : 'Handlingar'}</span><strong>${documents.length}</strong></div>${ui.period ? '<button type="button" class="visaalla" data-period-clear>Visa alla år</button>' : ''}<div class="kortlista">${documents.map(document => documentCard(document, selected?.id)).join('')}</div></aside><section id="reader">${readerHtml(selected, map)}</section><aside class="samband" aria-label="Strukturerade samband"><div class="sambandshuvud"><p class="overrad">Registerkopplingar</p><h2>Nämns i urvalet</h2><p>Exakta träffar har stabila ID:n. Föreslagna träffar väntar på källkontroll.</p></div><div class="sambandslista">${entityListHtml(documents, map)}</div></aside></section>`;
}

function renderTracks() {
  const documents = baseFilteredDocuments();
  const summary = summaryRecord();
  const definitions = summary.story_tracks || [];
  const available = definitions.map(track => ({ ...track, documents: documents.filter(document => (document.story_track_ids || []).includes(track.id)) })).filter(track => track.documents.length);
  const selectedTrack = available.find(track => track.id === ui.selectedTrack) || available[0];
  if (selectedTrack) ui.selectedTrack = selectedTrack.id;
  if (!selectedTrack) return emptyState('Inga berättelsespår i urvalet', 'Rensa något filter för att se spåren.');
  const map = entityMap();
  const trackEntities = new Map();
  for (const document of selectedTrack.documents) for (const id of document.entity_ids || []) if (map.has(id)) trackEntities.set(id, (trackEntities.get(id) || 0) + 1);
  const recurring = [...trackEntities.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, count]) => ({ ...map.get(id), count }));
  return `<section class="sparvy"><header class="vyhuvud"><div><p class="overrad">Berättelsespår</p><h2>Handlingar som hör ihop</h2><p>Samma handling kan ingå i flera spår. Källfilen ligger bara på ett ställe.</p></div></header><div class="sparlayout"><aside class="sparkatalog">${available.map(track => `<button type="button" data-track-id="${escapeAttribute(track.id)}" class="${track.id === selectedTrack.id ? 'aktiv' : ''}"><span>${escapeHtml(track.label)}</span><strong>${track.documents.length}</strong><small>${escapeHtml(track.description)}</small></button>`).join('')}</aside><section class="spardossier"><header><p class="overrad">Dokumentdossier</p><h3>${escapeHtml(selectedTrack.label)}</h3><p>${escapeHtml(selectedTrack.description)}</p><div class="entitetsrad">${recurring.map(entityBadge).join('')}</div></header><div class="spartidslinje">${selectedTrack.documents.map(document => `<article><time>${escapeHtml(String(yearLabel(document)))}</time><div><button type="button" data-document-id="${escapeAttribute(document.id)}">${escapeHtml(document.title)}</button><p>${escapeHtml(typeLabel(document.document_type))} · ${escapeHtml(document.collection || document.category)}</p></div></article>`).join('')}</div></section></div></section>`;
}

function documentEntityCounts(documents) {
  const counts = new Map();
  for (const document of documents) for (const id of document.entity_ids || []) counts.set(id, (counts.get(id) || 0) + 1);
  return counts;
}

function renderConnections() {
  const documents = baseFilteredDocuments();
  const map = entityMap();
  const counts = documentEntityCounts(documents);
  const entities = [...counts.entries()].map(([id, count]) => ({ ...map.get(id), count })).filter(entity => entity.name).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'sv'));
  const selected = entities.find(entity => entity.id === ui.selectedEntityId) || entities[0];
  if (!selected) return emptyState('Inga samband i urvalet', 'Rensa något filter eller välj en annan entitetstyp.');
  ui.selectedEntityId = selected.id;
  const linkedDocuments = documents.filter(document => (document.entity_ids || []).includes(selected.id));
  const coCounts = new Map();
  for (const document of linkedDocuments) for (const id of document.entity_ids || []) if (id !== selected.id) coCounts.set(id, (coCounts.get(id) || 0) + 1);
  const coEntities = [...coCounts.entries()].map(([id, count]) => ({ ...map.get(id), count })).filter(entity => entity.name).sort((a, b) => b.count - a.count).slice(0, 18);
  return `<section class="sambandsvy"><header class="vyhuvud"><div><p class="overrad">Sambandskarta</p><h2>Följ beläggen, inte ett spindelnät</h2><p>Välj en person, båt, plats eller fastighet. Kartan visar handlingarna i mitten och vad som förekommer tillsammans med dem.</p></div></header><div class="sambandskarta"><aside class="entitetskatalog"><h3>Välj utgångspunkt</h3>${entities.map(entity => `<button type="button" data-connection-entity="${escapeAttribute(entity.id)}" class="${entity.id === selected.id ? 'aktiv' : ''}"><span class="entitetsikon ${escapeAttribute(entity.entity_type)}">${typeLabel(entity.entity_type).charAt(0)}</span><span><strong>${escapeHtml(entity.name)}</strong><small>${escapeHtml(typeLabel(entity.entity_type))}</small></span><b>${entity.count}</b></button>`).join('')}</aside><section class="sambandscentrum"><div class="utgangsnod"><span>${escapeHtml(typeLabel(selected.entity_type))}</span><strong>${escapeHtml(selected.name)}</strong><small>${plural(linkedDocuments.length, 'källhandling', 'källhandlingar')}</small></div><div class="kallnoder">${linkedDocuments.map(document => `<button type="button" data-document-id="${escapeAttribute(document.id)}"><time>${escapeHtml(String(yearLabel(document)))}</time><strong>${escapeHtml(document.title)}</strong><small>${escapeHtml(typeLabel(document.document_type))}</small></button>`).join('')}</div></section><aside class="samentiteter"><h3>Förekommer tillsammans</h3>${coEntities.map(entity => `<button type="button" data-connection-entity="${escapeAttribute(entity.id)}"><span>${escapeHtml(typeLabel(entity.entity_type))}</span><strong>${escapeHtml(entity.name)}</strong><small>I ${plural(entity.count, 'gemensam handling', 'gemensamma handlingar')}</small></button>`).join('') || '<p>Inga andra strukturerade entiteter i samma handlingar.</p>'}</aside></div><p class="kallkritik">En linje betyder endast att två entiteter förekommer i samma avskrift. Den påstår inte släktskap, ägande eller annan relation utan separat belägg.</p></section>`;
}

function renderPlaces() {
  const documents = baseFilteredDocuments();
  const map = entityMap();
  const counts = documentEntityCounts(documents);
  const places = [...counts.entries()].map(([id, count]) => ({ ...map.get(id), count })).filter(entity => ['plats', 'fastighet', 'hus'].includes(entity.entity_type)).sort((a, b) => b.count - a.count);
  const selected = places.find(place => place.id === ui.selectedPlaceId) || places[0];
  if (!selected) return emptyState('Inga platser i urvalet', 'Arkivet saknar strukturerade platskopplingar för det här urvalet.');
  ui.selectedPlaceId = selected.id;
  const linked = documents.filter(document => (document.entity_ids || []).includes(selected.id));
  const positioned = places.filter(place => Number.isFinite(place.map_x) && Number.isFinite(place.map_y));
  const unpositioned = places.filter(place => !Number.isFinite(place.map_x) || !Number.isFinite(place.map_y));
  return `<section class="platsvy"><header class="vyhuvud"><div><p class="overrad">Dokumentkarta</p><h2>Var utspelar sig arkivet?</h2><p>Den nautiska kartan är schematisk: placeringen hjälper orienteringen men gör inte anspråk på exakta koordinater.</p></div></header><div class="platslayout"><section class="platskarta" aria-label="Schematisk karta över omnämnda platser"><div class="karttext"><span>Yxlan</span><span>Korpholmens övärld</span></div>${positioned.map(place => `<button type="button" data-place-id="${escapeAttribute(place.id)}" class="kartnod ${place.id === selected.id ? 'aktiv' : ''}" style="--x:${place.map_x};--y:${place.map_y};--storlek:${Math.min(1.8, .85 + place.count / 20)}" aria-label="${escapeAttribute(place.name)}, ${plural(place.count, 'handling', 'handlingar')}"><strong>${escapeHtml(place.name)}</strong><small>${place.count}</small></button>`).join('')}</section><aside class="platsdossier"><p class="overrad">Vald plats</p><h3>${escapeHtml(selected.name)}</h3><p>${escapeHtml(typeLabel(selected.entity_type))} · ${plural(selected.count, 'handling', 'handlingar')}</p><div class="platsdokument">${linked.map(document => `<button type="button" data-document-id="${escapeAttribute(document.id)}"><time>${escapeHtml(String(yearLabel(document)))}</time><span>${escapeHtml(document.title)}</span></button>`).join('')}</div>${selected.url ? `<a class="registerlank" href="${escapeAttribute(selected.url)}" target="_blank" rel="noreferrer">Öppna i ${escapeHtml(selected.app)} ↗</a>` : ''}</aside></div>${unpositioned.length ? `<section class="oplacerade"><div><p class="overrad">Strukturerade men ej kartlagda</p><h3>Fastigheter och platser utan schematisk position</h3></div><div>${unpositioned.map(place => `<button type="button" data-place-id="${escapeAttribute(place.id)}" class="${place.id === selected.id ? 'aktiv' : ''}"><strong>${escapeHtml(place.name)}</strong><small>${plural(place.count, 'handling', 'handlingar')}</small></button>`).join('')}</div></section>` : ''}</section>`;
}

function renderWork() {
  const all = documentRecords();
  const summary = summaryRecord();
  const review = all.filter(document => document.status === 'kontroll behövs');
  const updated = all.filter(document => transcriptVersions(document.id).length > 1);
  const pending = summary.inbox_pending_files || [];
  return `<section class="arbetskovy"><header class="vyhuvud"><div><p class="overrad">Arbetskö</p><h2>Från råfil till publicerad handling</h2><p>Arbetsläget skiljer inkorgsfiler från självständiga dokument och visar exakt var kontroll behövs.</p></div></header><section class="granskningsverktyg"><div><p class="overrad">Lokal redaktion</p><h3>Granska avskrift mot läskopia</h3><p>Öppna hela den redigerbara avskriften bredvid samtliga beskurna bilder i dokumentmappen. Rättningar sparas direkt i <em>Digitalisering 2026</em> med versionskopia och granskningslogg.</p><small>Starta först <code>Starta granskningsverktyget.command</code> på den här datorn. Dokumentbilder och Markdown-filer publiceras inte med appskalet.</small></div><a href="${LOCAL_REVIEW_URL}" target="_blank" rel="noopener" data-local-review-link>Öppna granskningsverktyget <span aria-hidden="true">↗</span></a></section><div class="flodeskarta"><article><span>1</span><strong>Inkommet</strong><b>${summary.inbox_total_files || 0}</b><small>råfiler i inkorgen</small></article><i></i><article><span>2</span><strong>Identifierat</strong><b>${summary.inbox_referenced_files || 0}</b><small>filer spårade i avskrifter</small></article><i></i><article><span>3</span><strong>Kontroll</strong><b>${review.length}</b><small>handlingar behöver läskontroll</small></article><i></i><article><span>4</span><strong>Färdigt</strong><b>${all.filter(document => document.status === 'färdig').length}</b><small>kontrollerade handlingar</small></article></div><div class="arbetskolumner"><section><header><p class="overrad">Återstår i inkorgen</p><h3>${plural(pending.length, 'råfil', 'råfiler')}</h3></header>${pending.map(file => `<article class="inkorgsrad"><span>Ny</span><strong>${escapeHtml(file)}</strong><small>Måste först avgränsas och grupperas till ett självständigt dokument.</small></article>`).join('') || '<p class="klartbesked">Alla inkorgsfiler är spårade till dokumentpaket.</p>'}</section><section><header><p class="overrad">Läskontroll</p><h3>${plural(review.length, 'handling', 'handlingar')}</h3></header><div class="kontrollista">${review.slice(0, 24).map(document => `<button type="button" data-document-id="${escapeAttribute(document.id)}"><time>${escapeHtml(String(yearLabel(document)))}</time><span>${escapeHtml(document.title)}</span><small>${document.has_uncertainty ? 'Markerad osäkerhet' : 'Kontrollstatus'}</small></button>`).join('')}</div>${review.length > 24 ? `<p class="listfot">Ytterligare ${review.length - 24} handlingar syns via statusfiltret.</p>` : ''}</section><section><header><p class="overrad">Uppdateringar</p><h3>${plural(updated.length, 'versionsspårad handling', 'versionsspårade handlingar')}</h3></header>${updated.map(document => `<button type="button" class="versionsrad" data-document-id="${escapeAttribute(document.id)}"><strong>${escapeHtml(document.title)}</strong><span>${transcriptVersions(document.id).length} versioner</span></button>`).join('') || '<p class="klartbesked">Denna enhet har ännu bara en importerad version av varje avskrift. Nya importer kommer att bevaras här.</p>'}</section></div><p class="kallkritik">Originalbilden är orörlig. Rättelser i det lokala granskningsverktyget förs in i nästa privata arkivrelease.</p></section>`;
}

function questionTerms(query) {
  return [...new Set(normalize(query).replace(/[^a-zåäö0-9\s-]/g, ' ').split(/\s+/).filter(term => term.length > 2 && !STOP_WORDS.has(term)))];
}

function excerptFor(document, terms) {
  const text = String(document.transcript || '').replace(/\s+/g, ' ');
  const lower = normalize(text);
  const positions = terms.map(term => lower.indexOf(term)).filter(position => position >= 0);
  const center = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, center - 95);
  const excerpt = `${start ? '…' : ''}${text.slice(start, start + 310)}${start + 310 < text.length ? '…' : ''}`;
  let safe = escapeHtml(excerpt);
  for (const term of terms.sort((a, b) => b.length - a.length)) safe = safe.replace(new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'giu'), '<mark>$1</mark>');
  return safe;
}

function questionResults(query) {
  const terms = questionTerms(query);
  if (!terms.length) return [];
  const map = entityMap();
  return documentRecords().map(document => {
    const title = normalize(document.title);
    const transcript = normalize(document.transcript);
    const entities = normalize((document.entity_ids || []).map(id => map.get(id)?.name || '').join(' '));
    let score = 0;
    for (const term of terms) {
      if (title.includes(term)) score += 7;
      if (entities.includes(term)) score += 5;
      const matches = transcript.split(term).length - 1;
      score += Math.min(matches, 6);
    }
    return { document, score, excerpt: excerptFor(document, terms) };
  }).filter(result => result.score > 0).sort((a, b) => b.score - a.score || String(a.document.document_date).localeCompare(String(b.document.document_date), 'sv')).slice(0, 8);
}

function renderQuestion() {
  const results = ui.question ? questionResults(ui.question) : [];
  return `<section class="fragavy"><header class="vyhuvud"><div><p class="overrad">Fråga arkivet</p><h2>Ställ en fråga – få källträffar</h2><p>Sökningen skriver inget eget historiesvar. Den visar de avskrifter och textpassager som kan besvara frågan.</p></div></header><form id="question-form" class="fragaform"><label for="archive-question">Vad vill du hitta?</label><div><input id="archive-question" type="search" value="${escapeAttribute(ui.question)}" placeholder="Exempel: När diskuterades Korpholmen runt?"><button type="submit">Sök i källorna</button></div></form>${ui.question ? `<section class="fragresultat"><div class="sektionsrubrik"><div><p class="overrad">Källträffar</p><h3>${plural(results.length, 'relevant handling', 'relevanta handlingar')}</h3></div><p>För frågan ”${escapeHtml(ui.question)}”</p></div>${results.map(({ document, excerpt }) => `<article><header><time>${escapeHtml(document.document_date)}</time><span>${escapeHtml(typeLabel(document.document_type))}</span></header><h4>${escapeHtml(document.title)}</h4><blockquote>${excerpt}</blockquote><button type="button" data-document-id="${escapeAttribute(document.id)}">Öppna hela avskriften →</button></article>`).join('') || '<p class="ingatraffar">Inga källpassager hittades. Prova färre eller mer konkreta ord.</p>'}</section>` : `<section class="fragexempel"><p>Prova en källbunden fråga:</p><div><button type="button" data-question="När diskuterades Korpholmen runt?">När diskuterades Korpholmen runt?</button><button type="button" data-question="Vilka handlingar nämner Atlanta?">Vilka handlingar nämner Atlanta?</button><button type="button" data-question="Vad finns om hederstecken och medaljer?">Vad finns om hederstecken och medaljer?</button><button type="button" data-question="När förekommer Sågsamfundet?">När förekommer Sågsamfundet?</button></div></section>`}<p class="kallkritik">Träffarna är maskinellt rangordnade. Läs alltid hela avskriften och dess osäkerhetsmarkeringar innan du drar en slutsats.</p></section>`;
}

function render() {
  const documents = filteredDocuments();
  renderFilters(documents);
  if (ui.view === 'overview') appNode.innerHTML = renderOverview(documents);
  else if (ui.view === 'reader') appNode.innerHTML = renderReader(documents);
  else if (ui.view === 'tracks') appNode.innerHTML = renderTracks();
  else if (ui.view === 'connections') appNode.innerHTML = renderConnections();
  else if (ui.view === 'places') appNode.innerHTML = renderPlaces();
  else if (ui.view === 'work') appNode.innerHTML = renderWork();
  else appNode.innerHTML = renderQuestion();
  document.body.dataset.view = ui.view;
}

async function refreshHistory() { historyOperations = store ? await store.getAllOps() : []; }

function allContentImages() {
  return [...new Map(documentRecords().flatMap(document => document.content_images || []).map(image => [image.sha256, image])).values()];
}

function rememberContentImage(image, blob) {
  if (contentImageUrls.has(image.sha256)) return;
  contentImageUrls.set(image.sha256, URL.createObjectURL(blob));
}

async function contentImageHash(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function loadCachedContentImages() {
  for (const image of allContentImages()) {
    if (contentImageUrls.has(image.sha256)) continue;
    const blob = await store.getBlob(`${CONTENT_IMAGE_KEY_PREFIX}${image.sha256}`);
    if (blob) rememberContentImage(image, blob);
  }
}

async function syncContentImages(transport) {
  const images = allContentImages();
  let downloaded = 0;
  let next = 0;
  const worker = async () => {
    while (next < images.length) {
      const image = images[next++];
      if (contentImageUrls.has(image.sha256)) continue;
      let blob = await store.getBlob(`${CONTENT_IMAGE_KEY_PREFIX}${image.sha256}`);
      if (!blob) {
        const remote = await transport.getBlob(image.blob_path);
        blob = new Blob([await remote.arrayBuffer()], { type: image.mime_type });
        if (await contentImageHash(blob) !== image.sha256) throw new Error(`Innehållsbilden har fel kontrollsumma: ${image.filename}`);
        await store.putBlob(`${CONTENT_IMAGE_KEY_PREFIX}${image.sha256}`, blob);
        downloaded += 1;
      }
      rememberContentImage(image, blob);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, images.length) }, () => worker()));
  return { total: images.length, downloaded };
}

async function registerServiceWorker() {
  try { return await registerKorpholmenServiceWorker({ sourceTree: isSourceTree }); }
  catch (error) { console.warn('Appskalet kunde inte uppdateras', error); return null; }
}

async function completeOAuthCallbackIfNeeded() {
  const url = new URL(location.href);
  if (!url.searchParams.has('code') && !url.searchParams.has('error')) return;
  const token = await completeDropboxOAuth(); accessToken = token.access_token;
  accessTokenExpiresAt = Date.now() + Math.max(30, Number(token.expires_in || 0) - 60) * 1000;
  if (token.refresh_token) await store.putMeta(TOKEN_META, token.refresh_token);
  for (const parameter of ['code', 'state', 'error', 'error_description']) url.searchParams.delete(parameter);
  history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

async function currentAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiresAt) return accessToken;
  const refreshToken = await store.getMeta(TOKEN_META);
  if (!refreshToken || !DROPBOX_CLIENT_ID || navigator.onLine === false) return null;
  const token = await exchangeDropboxRefreshToken({ clientId: DROPBOX_CLIENT_ID, refreshToken });
  accessToken = token.access_token; accessTokenExpiresAt = Date.now() + Math.max(30, Number(token.expires_in || 0) - 60) * 1000;
  if (token.refresh_token && token.refresh_token !== refreshToken) await store.putMeta(TOKEN_META, token.refresh_token);
  return accessToken;
}

async function uploadBootstrapOps(transport) {
  const pending = await store.getMeta(BOOTSTRAP_META);
  if (!pending?.pending) return 0;
  const operations = (await store.getAllOps()).filter(operation => operation.device_id === pending.device_id).sort((a, b) => a.seq - b.seq);
  let uploaded = 0;
  for (let index = 0; index < operations.length; index += 250) { const batch = createBatch(operations.slice(index, index + 250)); await transport.putBatch(batch); uploaded += batch.ops.length; }
  await store.putMeta(BOOTSTRAP_META, { ...pending, pending: false, uploaded_at: new Date().toISOString() });
  return uploaded;
}

async function syncNow() {
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    const hasCredential = Boolean(await store.getMeta(TOKEN_META));
    if (navigator.onLine === false) { setStatus(`Offline · ${hasCredential ? 'Dropbox ansluten · ' : ''}arkivet finns lokalt`, 'warning'); return null; }
    const token = await currentAccessToken();
    if (!token) { setStatus('Lokalt arkiv · Dropbox ej ansluten', 'warning'); connectButton.textContent = 'Anslut Dropbox'; return null; }
    connectButton.textContent = 'Synka Dropbox'; setStatus('Synkar arkivet…');
    const transport = new DropboxTransport({ accessToken: token, id: 'dropbox-dokumentarkiv', opsRoot: '/dokumentarkiv/ops' });
    const bootstrap = await uploadBootstrapOps(transport);
    const result = await new SyncEngine({ repository, transport }).syncOnce();
    const referenceResults = await Promise.allSettled([
      matrikelMaster.sync(new DropboxTransport({ accessToken: token, id: 'dropbox-matrikel-read', opsRoot: '/matrikel/ops', readOnly: true })),
      batregisterMaster.sync(new DropboxTransport({ accessToken: token, id: 'dropbox-batregister-read', opsRoot: '/batregister/ops', readOnly: true })),
      fastigheterMaster.sync(new DropboxTransport({ accessToken: token, id: 'dropbox-fastigheter-read', opsRoot: '/fastigheter/ops', readOnly: true })),
      kartdataMaster.sync(new DropboxTransport({ accessToken: token, id: 'dropbox-kartdata-read', opsRoot: '/kartdata/ops', readOnly: true })),
    ]);
    const referenceFailures = referenceResults.filter(item => item.status === 'rejected');
    for (const failure of referenceFailures) console.warn('En referensmaster kunde inte uppdateras; markerad lokal cache används', failure.reason);
    await refreshHistory();
    const images = await syncContentImages(transport);
    render(); setStatus(`Synkad · ${documentRecords().length} handlingar · ${images.total} innehållsbilder · ${bootstrap + result.uploadedOps} upp, ${result.downloadedOps} ned · ${referenceFailures.length ? 'referensnamn från lokal cache' : 'namn från Matrikel, Båtregister, Fastigheter och Kartdata'}`, referenceFailures.length ? 'warning' : 'ok');
    return result;
  })().catch(error => {
    console.error(error);
    if (isOfflineError(error)) { setStatus('Offline · lokalt arkiv tillgängligt', 'warning'); return null; }
    setStatus(`Åtgärd krävs · ${error.message}`, 'error'); throw error;
  }).finally(() => { syncPromise = null; });
  return syncPromise;
}

async function connectDropbox() {
  sessionStorage.setItem('korpholmen:oauth-return', new URL('dokumentarkiv/', redirectUri()).pathname);
  const attempt = await beginDropboxOAuth({ clientId: DROPBOX_CLIENT_ID, redirectUri: redirectUri(), scopes: DROPBOX_SCOPES });
  location.assign(attempt.url);
}

async function bootstrapLocal() {
  if (!isSourceTree) throw new Error('Startkopian kan bara aktiveras från källappen');
  const response = await fetch(LOCAL_BOOTSTRAP_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Startkopian kunde inte läsas (${response.status})`);
  const data = await response.json();
  if (data.operations_version !== 1 || !Array.isArray(data.operations)) throw new Error('Startkopian har fel format');
  data.operations.forEach(validateOperation);
  await repository.applyRemoteOps(data.operations);
  await store.putMeta(BOOTSTRAP_META, { pending: true, device_id: data.device_id, migration_id: data.migration_id, operations: data.operations.length });
  await refreshHistory(); render(); setStatus(`Aktuell källmaster inläst · ${documentRecords().length} handlingar`, 'ok');
}

function clearFilters({ includeSearch = false } = {}) {
  if (includeSearch) { ui.search = ''; $('#search').value = ''; }
  ui.categories.clear(); ui.entityType = 'alla'; ui.status = 'alla'; ui.period = '';
  render();
}

const renderSearch = debounce(render, 120);
$('#search').addEventListener('input', event => { ui.search = event.target.value; renderSearch(); });
$('#clear-search').addEventListener('click', () => { renderSearch.cancel(); ui.search = ''; $('#search').value = ''; render(); });
$('#clear-filters').addEventListener('click', () => clearFilters());
$('#entity-filter').addEventListener('change', event => { ui.entityType = event.target.value; render(); });
$('#status-filter').addEventListener('change', event => { ui.status = event.target.value; render(); });
$('#category-filters').addEventListener('click', event => {
  const button = event.target.closest('[data-category]');
  if (!button) return;
  const category = button.dataset.category;
  if (category === 'Alla') ui.categories.clear();
  else if (ui.categories.has(category)) ui.categories.delete(category);
  else ui.categories.add(category);
  render();
});
$('#view-tabs').addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (!button) return;
  ui.view = button.dataset.view;
  render();
  window.scrollTo({ top: $('#search-band').offsetTop, behavior: 'smooth' });
});
appNode.addEventListener('submit', event => {
  if (event.target.id !== 'question-form') return;
  event.preventDefault(); ui.question = $('#archive-question').value.trim(); render();
});
appNode.addEventListener('click', event => {
  const documentButton = event.target.closest('[data-document-id]');
  if (documentButton) { ui.selectedId = documentButton.dataset.documentId; ui.sourceOpen = false; ui.compareHlc = ''; ui.view = 'reader'; render(); requestAnimationFrame(() => $('#reader')?.scrollIntoView({ behavior: 'smooth', block: 'start' })); return; }
  const decadeButton = event.target.closest('[data-decade]');
  if (decadeButton) { ui.period = `decade:${decadeButton.dataset.decade}`; if (decadeButton.dataset.categoryJump) ui.categories = new Set([decadeButton.dataset.categoryJump]); ui.view = 'reader'; render(); return; }
  const yearButton = event.target.closest('[data-year]');
  if (yearButton) { ui.period = `year:${yearButton.dataset.year}`; ui.view = 'reader'; render(); return; }
  if (event.target.closest('[data-period-clear]')) { ui.period = ''; render(); return; }
  const trackButton = event.target.closest('[data-track-id]');
  if (trackButton) { ui.selectedTrack = trackButton.dataset.trackId; render(); return; }
  const connectionButton = event.target.closest('[data-connection-entity]');
  if (connectionButton) { ui.selectedEntityId = connectionButton.dataset.connectionEntity; render(); return; }
  const placeButton = event.target.closest('[data-place-id]');
  if (placeButton) { ui.selectedPlaceId = placeButton.dataset.placeId; render(); return; }
  const questionButton = event.target.closest('[data-question]');
  if (questionButton) { ui.question = questionButton.dataset.question; render(); return; }
  const versionButton = event.target.closest('[data-version-hlc]');
  if (versionButton && !versionButton.disabled) { ui.compareHlc = versionButton.dataset.versionHlc; render(); requestAnimationFrame(() => $('.versionsjamforelse')?.scrollIntoView({ behavior: 'smooth', block: 'center' })); return; }
  const entityButton = event.target.closest('[data-entity-id]');
  if (entityButton) { ui.selectedEntityId = entityButton.dataset.entityId; ui.view = 'connections'; render(); return; }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'source') { ui.sourceOpen = !ui.sourceOpen; render(); }
  if (action === 'close-compare') { ui.compareHlc = ''; render(); }
  if (action === 'clear') clearFilters({ includeSearch: true });
  if (action === 'connect') connectDropbox().catch(error => setStatus(error.message, 'error'));
});
connectButton.addEventListener('click', () => currentAccessToken().then(token => token ? syncNow() : connectDropbox()).catch(error => setStatus(error.message, 'error')));
bootstrapButton.addEventListener('click', () => bootstrapLocal().catch(error => setStatus(error.message, 'error')));
window.addEventListener('online', () => syncNow().catch(() => {}));
window.addEventListener('korpholmen:dropbox-ready', () => syncNow().catch(() => {}));
window.addEventListener('offline', () => syncNow().catch(() => {}));
document.addEventListener('visibilitychange', () => { if (store && document.visibilityState === 'visible') syncNow().catch(() => {}); });
setInterval(() => { if (store && document.visibilityState === 'visible' && navigator.onLine !== false) syncNow().catch(() => {}); }, AUTO_SYNC_INTERVAL);

async function init() {
  const serviceWorkerPromise = registerServiceWorker();
  const db = await openSlaktlandskapDB({ name: 'korpholmen-dokumentarkiv' });
  store = new IndexedDBStore(db);
  repository = await new Repository({ store, deviceId: await deviceId() }).init();
  matrikelMaster = await new ReadOnlyMaster({ store, cacheKey: 'matrikel' }).init();
  batregisterMaster = await new ReadOnlyMaster({ store, cacheKey: 'batregister' }).init();
  fastigheterMaster = await new ReadOnlyMaster({ store, cacheKey: 'fastigheter' }).init();
  kartdataMaster = await new ReadOnlyMaster({ store, cacheKey: 'kartdata' }).init();
  await refreshHistory();
  await loadCachedContentImages();
  bootstrapButton.hidden = !isSourceTree;
  render();
  await completeOAuthCallbackIfNeeded();
  await syncNow();
  await serviceWorkerPromise;
}

init().catch(error => { console.error(error); setStatus(`Kunde inte starta · ${error.message}`, 'error'); });
