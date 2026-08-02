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
import { DROPBOX_CLIENT_ID, DROPBOX_SCOPES, LOCAL_BOOTSTRAP_URL } from './config.js';

const $ = selector => document.querySelector(selector);
const listNode = $('#document-list');
const readerNode = $('#reader');
const entityNode = $('#entity-list');
const statusNode = $('#sync-status');
const connectButton = $('#connect-dropbox');
const bootstrapButton = $('#bootstrap-local');
const isSourceTree = location.pathname.includes('/apps/dokumentarkiv/');
const TOKEN_META = 'dropbox:refresh-token';
const BOOTSTRAP_META = 'bootstrap:dokumentarkiv-2026-08-02';
const ENTITY_TYPES = ['person', 'båt', 'plats', 'fastighet', 'hus', 'organisation'];
const ui = { search: '', category: 'Alla', entityType: 'alla', selectedId: '', sourceOpen: false };
let store;
let repository;
let accessToken = null;
let accessTokenExpiresAt = 0;
let syncPromise = null;

const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const escapeAttribute = escapeHtml;
const normalize = value => String(value || '').normalize('NFC').toLocaleLowerCase('sv');
const recordList = type => repository ? repository.listEntities(type).map(entity => ({ id: entity.entity_id, ...entity.fields })) : [];
const documentRecords = () => recordList('document').sort((a, b) => String(a.document_date).localeCompare(String(b.document_date), 'sv') || a.title.localeCompare(b.title, 'sv'));
const entityRecords = () => recordList('archive-entity').sort((a, b) => a.name.localeCompare(b.name, 'sv'));
const entityMap = () => new Map(entityRecords().map(entity => [entity.id, entity]));
const isOfflineError = error => navigator.onLine === false || error instanceof TypeError || /failed to fetch|load failed|networkerror|internetanslutning|network connection/i.test(String(error?.message || error));

function setStatus(text, tone = '') {
  statusNode.textContent = text;
  statusNode.className = tone ? `status-${tone}` : '';
}

function deviceId() {
  const key = 'korpholmen:dokumentarkiv-device-id';
  let id = localStorage.getItem(key);
  if (!id) { id = `dokumentarkiv-web-${crypto.randomUUID()}`; localStorage.setItem(key, id); }
  return id;
}

function redirectUri() { return new URL(isSourceTree ? '../../' : '../', location.href).href; }
function typeLabel(type) { return type ? type.charAt(0).toLocaleUpperCase('sv') + type.slice(1) : 'Okänd'; }
function dateLabel(date) {
  const match = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return date || 'Odaterat';
  return new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${date}T12:00:00`));
}

function inlineText(value) {
  return escapeHtml(value)
    .replace(/\[(osäker[^\]]*|oläsligt[^\]]*|överstruket[^\]]*|handskrivet[^\]]*)\]/gi, '<mark class="osaker">[$1]</mark>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/&lt;u&gt;(.*?)&lt;\/u&gt;/g, '<u>$1</u>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function markdown(value) {
  const output = [];
  let list = [];
  let code = null;
  const flushList = () => { if (list.length) output.push(`<ul>${list.map(item => `<li>${inlineText(item)}</li>`).join('')}</ul>`); list = []; };
  for (const raw of String(value || '').split('\n')) {
    if (raw.startsWith('```')) {
      if (code) { output.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`); code = null; }
      else { flushList(); code = []; }
      continue;
    }
    if (code) { code.push(raw); continue; }
    if (/^-\s+/.test(raw)) { list.push(raw.replace(/^-\s+/, '')); continue; }
    flushList();
    if (raw.startsWith('### ')) output.push(`<h3>${escapeHtml(raw.slice(4))}</h3>`);
    else if (raw.startsWith('## ')) output.push(`<h2>${escapeHtml(raw.slice(3))}</h2>`);
    else if (raw.trim()) output.push(`<p>${inlineText(raw.replace(/\s{2}$/, ''))}</p>`);
  }
  flushList();
  return output.join('');
}

function filteredDocuments() {
  const map = entityMap();
  const query = normalize(ui.search.trim());
  return documentRecords().filter(document => {
    const entities = (document.entity_ids || []).map(id => map.get(id)).filter(Boolean);
    if (ui.category !== 'Alla' && document.category !== ui.category) return false;
    if (ui.entityType !== 'alla' && !entities.some(entity => entity.entity_type === ui.entityType)) return false;
    if (!query) return true;
    return normalize([document.title, document.document_type, document.document_date, document.transcript, ...entities.map(entity => entity.name)].join(' ')).includes(query);
  });
}

function entityBadge(entity) {
  const initial = entity.entity_type === 'person' ? 'P' : entity.entity_type === 'båt' ? 'B' : entity.entity_type === 'organisation' ? 'O' : 'L';
  return `<button type="button" class="entitetsmarke ${escapeAttribute(entity.match_status)}" data-entity-id="${escapeAttribute(entity.id)}"><span class="entitetsikon">${initial}</span>${escapeHtml(entity.name)}</button>`;
}

function renderFilters(documents) {
  const categories = ['Alla', ...new Set(documentRecords().map(document => document.category))];
  $('#category-filters').innerHTML = categories.map(category => `<button type="button" data-category="${escapeAttribute(category)}" class="${ui.category === category ? 'vald' : ''}" aria-pressed="${ui.category === category}">${escapeHtml(category)}</button>`).join('');
  $('#result-count').textContent = String(documents.length);
  $('#document-total').textContent = String(documentRecords().length);
  const years = documentRecords().map(document => document.year).filter(Boolean);
  $('#year-range').textContent = years.length ? `${Math.min(...years)}–${Math.max(...years)}` : '—';
}

function renderDocumentList(documents, selected) {
  listNode.innerHTML = documents.map(document => `<button type="button" class="dokumentkort ${document.id === selected?.id ? 'aktiv' : ''}" data-document-id="${escapeAttribute(document.id)}"><span class="kortdatum">${escapeHtml(document.document_date)}</span><strong>${escapeHtml(document.title)}</strong><span class="kortfot"><span>${escapeHtml(typeLabel(document.document_type))}</span><span>${document.image_count} ${document.image_count === 1 ? 'bild' : 'bilder'}</span></span></button>`).join('');
}

function renderReader(selected, map) {
  if (!selected) {
    const noData = documentRecords().length === 0;
    readerNode.innerHTML = `<div class="tomtresultat"><span aria-hidden="true">${noData ? '§' : '⌕'}</span><h2>${noData ? 'Arkivet väntar på Dropbox' : 'Ingen handling hittades'}</h2><p>${noData ? 'Anslut Dropbox för att hämta de privata, digitaliserade avskrifterna till den här enheten.' : 'Prova ett annat ord eller rensa något av filtren.'}</p>${noData ? '<button type="button" data-action="connect">Anslut Dropbox</button>' : '<button type="button" data-action="clear">Rensa filter</button>'}</div>`;
    return;
  }
  const entities = (selected.entity_ids || []).map(id => map.get(id)).filter(Boolean);
  readerNode.innerHTML = `<article class="papper"><div class="halslagskant" aria-hidden="true"><i></i><i></i><i></i></div><header class="dokumenthuvud"><div class="dokumentmeta"><span>${escapeHtml(typeLabel(selected.document_type))}</span><span class="status ${selected.status === 'färdig' ? 'klar' : 'kontroll'}">${escapeHtml(selected.status)}</span></div><p class="dokumentdatum">${escapeHtml(dateLabel(selected.document_date))}</p><h2>${escapeHtml(selected.title)}</h2><p class="ingress">Ordagrann avskrift från ${selected.image_count} ${selected.image_count === 1 ? 'bild' : 'bilder'}. Stavning, interpunktion och dokumentets egen ton är bevarade.</p><div class="entitetsrad">${entities.map(entityBadge).join('')}</div></header><div class="ornament" aria-hidden="true"><span>§</span></div><div class="avskriftstext">${markdown(selected.transcript)}</div><footer class="dokumentfot"><button type="button" data-action="source">${ui.sourceOpen ? 'Dölj källuppgift' : 'Visa källuppgift'}</button><span>Avskrift · Digitalisering 2026</span></footer>${ui.sourceOpen ? `<div class="kallruta"><strong>Källfil</strong><code>${escapeHtml(selected.source_path)}</code><p>Datering: ${escapeHtml(selected.dating)}. Avskriften visas utan modernisering.</p></div>` : ''}</article>`;
}

function renderEntities(documents, map) {
  const unique = new Map();
  for (const document of documents) for (const id of document.entity_ids || []) if (map.has(id)) unique.set(id, map.get(id));
  entityNode.innerHTML = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, 'sv')).map(entity => {
    const label = entity.match_status === 'kopplad' ? 'Kopplad' : entity.match_status === 'granska' ? 'Granska' : entity.match_status === 'saknas' ? 'Ej funnen' : 'Arkiventitet';
    const initial = typeLabel(entity.entity_type).charAt(0);
    const link = entity.url && entity.match_status === 'kopplad' ? `<a href="${escapeAttribute(entity.url)}" target="_blank" rel="noreferrer">${escapeHtml(entity.app)} ↗</a>` : '';
    return `<article class="sambandskort"><button type="button" class="sambandsnamn" data-entity-id="${escapeAttribute(entity.id)}"><span class="entitetsikon ${escapeAttribute(entity.entity_type)}">${initial}</span><span><strong>${escapeHtml(entity.name)}</strong><small>${escapeHtml(typeLabel(entity.entity_type))}</small></span></button><div class="kopplingsrad"><span class="kopplingsstatus ${escapeAttribute(entity.match_status)}">${label}</span>${link}</div>${entity.note ? `<p class="kopplingsnot">${escapeHtml(entity.note)}</p>` : ''}${entity.external_id ? `<code>${escapeHtml(entity.external_id)}</code>` : ''}</article>`;
  }).join('') || '<p class="tomnot">Inga entiteter i det filtrerade urvalet.</p>';
}

function render() {
  const documents = filteredDocuments();
  const selected = documents.find(document => document.id === ui.selectedId) || documents[0] || null;
  if (selected) ui.selectedId = selected.id;
  const map = entityMap();
  renderFilters(documents);
  renderDocumentList(documents, selected);
  renderReader(selected, map);
  renderEntities(documents, map);
  $('#clear-search').hidden = !ui.search;
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return null;
  try { return await navigator.serviceWorker.register('./sw.js', { scope: './' }); }
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
    render(); setStatus(`Synkad · ${documentRecords().length} handlingar · ${bootstrap + result.uploadedOps} upp, ${result.downloadedOps} ned`, 'ok');
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
  render(); setStatus('Aktuell källmaster inläst lokalt · anslut Dropbox för uppladdning', 'ok');
}

$('#search').addEventListener('input', event => { ui.search = event.target.value; render(); });
$('#clear-search').addEventListener('click', () => { ui.search = ''; $('#search').value = ''; render(); });
$('#entity-filter').addEventListener('change', event => { ui.entityType = event.target.value; render(); });
$('#category-filters').addEventListener('click', event => { const button = event.target.closest('[data-category]'); if (button) { ui.category = button.dataset.category; render(); } });
listNode.addEventListener('click', event => { const button = event.target.closest('[data-document-id]'); if (button) { ui.selectedId = button.dataset.documentId; ui.sourceOpen = false; render(); document.querySelector('.papper')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } });
document.addEventListener('click', event => {
  const entityButton = event.target.closest('[data-entity-id]');
  if (entityButton) { const entity = entityMap().get(entityButton.dataset.entityId); if (entity) { ui.search = entity.name; ui.entityType = ENTITY_TYPES.includes(entity.entity_type) ? entity.entity_type : 'alla'; $('#search').value = ui.search; $('#entity-filter').value = ui.entityType; render(); } }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'source') { ui.sourceOpen = !ui.sourceOpen; render(); }
  if (action === 'clear') { ui.search = ''; ui.category = 'Alla'; ui.entityType = 'alla'; $('#search').value = ''; $('#entity-filter').value = 'alla'; render(); }
  if (action === 'connect') connectDropbox().catch(error => setStatus(error.message, 'error'));
});
connectButton.addEventListener('click', () => currentAccessToken().then(token => token ? syncNow() : connectDropbox()).catch(error => setStatus(error.message, 'error')));
bootstrapButton.addEventListener('click', () => bootstrapLocal().catch(error => setStatus(error.message, 'error')));
window.addEventListener('online', () => syncNow().catch(() => {}));
window.addEventListener('offline', () => syncNow().catch(() => {}));

async function init() {
  const serviceWorkerPromise = registerServiceWorker();
  const db = await openSlaktlandskapDB({ name: 'korpholmen-dokumentarkiv' });
  store = new IndexedDBStore(db);
  repository = await new Repository({ store, deviceId: deviceId() }).init();
  bootstrapButton.hidden = !isSourceTree;
  render();
  await completeOAuthCallbackIfNeeded();
  await syncNow();
  await serviceWorkerPromise;
}

init().catch(error => { console.error(error); setStatus(`Kunde inte starta · ${error.message}`, 'error'); });
