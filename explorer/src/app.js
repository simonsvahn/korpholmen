import { DropboxTransport, IndexedDBStore, SharedDropboxSession, exchangeDropboxRefreshToken, openSlaktlandskapDB } from '../core/data-layer.js';
import { createActiveAppBundle } from '../core/active-app-bundle.js';
import { HttpReadTransport } from '../core/sync/http-read-transport.js';
import { DROPBOX_CLIENT_ID } from '../../src/config.js';

const SOURCES = {
  people: { pointerPath: '/personer-familjer/active.json', app: 'people', requiredCollections: ['people', 'relations', 'family_units'] },
  matrikel: { pointerPath: '/matrikel-generation2/active.json', app: 'matrikel', requiredCollections: ['memberships', 'releases', 'person_occurrences'] },
  boats: { pointerPath: '/batregister-generation2/active.json', app: 'batregister', requiredCollections: ['boats', 'identity_redirects'] },
  properties: { pointerPath: '/fastigheter-generation2/active.json', app: 'fastigheter', requiredCollections: ['properties', 'timeline_entries', 'affiliations'] },
  documents: { pointerPath: '/dokumentarkiv-generation2/active.json', app: 'dokumentarkiv', requiredCollections: ['documents', 'document_links'] },
  race: { pointerPath: '/korpholmenrunt-generation2/active.json', app: 'korpholmenrunt', requiredCollections: ['editions', 'results', 'participants'] },
  kart: { pointerPath: '/kartdata-generation2/active.json', app: 'kartdata', requiredCollections: ['places', 'place_names', 'entries', 'entry_names'] },
};
const TYPE_LABELS = { person: 'Person', boat: 'Båt', property: 'Fastighet', document: 'Handling', race: 'Tävling', place: 'Plats', map: 'Kartobjekt' };
const viewNode = document.querySelector('#explorer-view');
const searchForm = document.querySelector('#explorer-search-form');
const searchInput = document.querySelector('#explorer-search');
const reloadButton = document.querySelector('#reload-data');
const statusNode = document.querySelector('#explorer-status');
const session = new SharedDropboxSession({ clientId: DROPBOX_CLIENT_ID, exchangeRefreshToken: exchangeDropboxRefreshToken });
let store;
let bundle;
let searchIndex = [];
let loading = false;

const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const normalize = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('sv').replace(/[^a-z0-9]+/g, ' ').trim();
const unique = values => [...new Set(values.filter(Boolean))];
const list = (source, collection) => bundle.list(source, collection);
const get = (source, collection, id) => bundle.get(source, collection, id);
const setStatus = (text, tone = '') => { statusNode.textContent = text; statusNode.className = tone ? `is-${tone}` : ''; };
const item = ({ type, id, label, detail = '', search = [] }) => ({ type, id, label, detail, normalizedLabel: normalize(label), normalizedSearch: normalize([label, detail, ...search].join(' ')) });

function membership(personId) { return list('matrikel', 'memberships').find(row => row.person_id === personId) || null; }
function buildIndex() {
  const rows = [];
  for (const person of list('people', 'people')) { const member = membership(person.id); rows.push(item({ type: 'person', id: person.id, label: person.display_name, detail: unique([member?.club_name, member?.status, person.living === false ? 'Avliden' : '']).join(' · '), search: [person.birth_name, ...(person.aliases || [])] })); }
  for (const boat of list('boats', 'boats')) rows.push(item({ type: 'boat', id: boat.id, label: boat.display_name, detail: unique([boat.vessel_type, boat.category, boat.model]).join(' · '), search: [boat.notes, ...(boat.events || []).flatMap(event => event.participants || []).map(p => p.party_ref?.entity_id)] }));
  for (const property of list('properties', 'properties')) rows.push(item({ type: 'property', id: property.id, label: property.display_name || property.designation || property.id, detail: 'Fastighetsmaster', search: [property.designation] }));
  for (const document of list('documents', 'documents')) rows.push(item({ type: 'document', id: document.id, label: document.title, detail: unique([document.time?.original_text, ...(document.type_ids || [])]).join(' · '), search: [document.category_id] }));
  const resultCounts = new Map(); for (const result of list('race', 'results')) resultCounts.set(result.year, (resultCounts.get(result.year) || 0) + 1);
  for (const [year, count] of [...resultCounts].sort((a, b) => b[0] - a[0])) rows.push(item({ type: 'race', id: String(year), label: `Korpholmen runt ${year}`, detail: `${count} resultat` }));
  for (const place of list('kart', 'places')) rows.push(item({ type: 'place', id: place.id, label: place.preferred_name, detail: unique([place.kind, get('kart', 'places', place.parent_place_id)?.preferred_name]).join(' · '), search: list('kart', 'place_names').filter(name => name.place_id === place.id).map(name => name.name) }));
  for (const entry of list('kart', 'entries')) rows.push(item({ type: 'map', id: entry.id, label: entry.name, detail: unique([entry.entry_type, entry.subtype]).join(' · '), search: list('kart', 'entry_names').filter(name => name.entry_id === entry.id).map(name => name.name) }));
  return rows;
}
function href(item) {
  if (item.type === 'person') return `../personer-familjer/?person=${encodeURIComponent(item.id)}`;
  if (item.type === 'boat') return `../batregister/?boat=${encodeURIComponent(item.id)}`;
  if (item.type === 'property') return `../fastigheter/?property=${encodeURIComponent(item.id)}`;
  if (item.type === 'document') return `../dokumentarkiv/?document=${encodeURIComponent(item.id)}`;
  if (item.type === 'race') return `../korpholmenrunt/?year=${encodeURIComponent(item.id)}`;
  if (item.type === 'place') return `../kartdata/?place=${encodeURIComponent(item.id)}`;
  return `../kartdata/?entry=${encodeURIComponent(item.id)}`;
}
function resultHtml(entry) { return `<a class="search-result" href="${href(entry)}"><span class="result-type">${escapeHtml(TYPE_LABELS[entry.type])}</span><span class="result-copy"><strong>${escapeHtml(entry.label)}</strong><span>${escapeHtml(entry.detail)}</span></span><span class="result-arrow" aria-hidden="true">→</span></a>`; }
function search(value) {
  const needle = normalize(value);
  if (!needle) return [];
  return searchIndex.map(entry => ({ entry, score: entry.normalizedLabel === needle ? 0 : entry.normalizedLabel.startsWith(needle) ? 1 : entry.normalizedLabel.includes(needle) ? 2 : entry.normalizedSearch.includes(needle) ? 3 : 99 })).filter(row => row.score < 99).sort((a, b) => a.score - b.score || a.entry.label.localeCompare(b.entry.label, 'sv', { numeric: true })).slice(0, 80).map(row => row.entry);
}
function renderStart() {
  const counts = Object.fromEntries(Object.keys(SOURCES).map(source => [source, Object.values(bundle.sources[source]?.state?.master?.data || {}).reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0)]));
  viewNode.innerHTML = `<div class="start-grid"><section class="start-card"><p class="eyebrow">Aktiva V2-mastrar</p><h2>Sök på tvären</h2><p>Personer, båtar, fastigheter, handlingar, tävlingsår och kartobjekt öppnas i den app som äger uppgiften.</p></section><aside class="start-card"><p class="eyebrow">Inläst</p><h2>${searchIndex.length.toLocaleString('sv-SE')} sökbara objekt</h2><p>${Object.values(counts).reduce((a, b) => a + b, 0).toLocaleString('sv-SE')} strukturerade poster i sju verifierade V2-mastrar.</p></aside></div>`;
  viewNode.setAttribute('aria-busy', 'false');
}
function renderSearch(value) {
  const results = search(value);
  viewNode.innerHTML = results.length ? `<header class="search-heading"><h2>${results.length} träffar</h2><p>Enbart aktiva V2-mastrar</p></header><div class="search-results">${results.map(resultHtml).join('')}</div>` : `<section class="empty-state"><h2>Ingen träff</h2><p>Prova ett personnamn, klubbnamn, en båt, fastighet, handling eller plats.</p></section>`;
  viewNode.setAttribute('aria-busy', 'false');
}
function renderRoute() { const query = new URL(location.href).searchParams.get('q') || searchInput.value.trim(); if (query) { searchInput.value = query; renderSearch(query); } else renderStart(); }
async function localTransport() { try { return (await fetch('/personer-familjer/active.json', { method: 'HEAD', cache: 'no-store' })).ok ? new HttpReadTransport() : null; } catch { return null; } }
async function load({ force = false } = {}) {
  if (loading) return; loading = true; reloadButton.disabled = true; viewNode.setAttribute('aria-busy', 'true');
  try {
    const http = await localTransport(); const token = http ? null : await session.getAccessToken({ online: navigator.onLine !== false });
    if ((http || token) && (force || !Object.values(SOURCES).every((_, index) => bundle.hasData(Object.keys(SOURCES)[index])))) {
      setStatus('Läser sju aktiva V2-mastrar…');
      await bundle.sync(http || new DropboxTransport({ accessToken: token, id: 'dropbox-explorer-active-v2', opsRoot: '/explorer-v2-read', readOnly: true }));
    }
    searchIndex = buildIndex(); renderRoute();
    const revisions = Object.keys(SOURCES).map(source => bundle.revision(source)).join('/');
    setStatus(`${searchIndex.length.toLocaleString('sv-SE')} sökbara objekt · V2-revisioner ${revisions} · skrivskyddad`, 'ok');
  } catch (error) {
    console.error(error);
    if (Object.keys(SOURCES).some(source => bundle.hasData(source))) { searchIndex = buildIndex(); renderRoute(); setStatus(`Senast verifierade V2-data visas · ${error.message}`, 'warning'); }
    else { setStatus(`Kunde inte läsa V2-mastrarna · ${error.message}`, 'error'); viewNode.innerHTML = `<section class="empty-state"><h2>Explorer kunde inte starta</h2><p>${escapeHtml(error.message)}</p></section>`; }
  } finally { loading = false; reloadButton.disabled = false; }
}

searchForm.addEventListener('submit', event => { event.preventDefault(); const query = searchInput.value.trim(); const url = new URL(location.href); if (query) url.searchParams.set('q', query); else url.searchParams.delete('q'); history.pushState({}, '', `${url.pathname}${url.search}`); query ? renderSearch(query) : renderStart(); });
searchInput.addEventListener('input', () => searchInput.value.trim().length >= 2 ? renderSearch(searchInput.value.trim()) : !searchInput.value.trim() && renderStart());
reloadButton.addEventListener('click', () => load({ force: true }));
window.addEventListener('popstate', renderRoute);
window.addEventListener('korpholmen:dropbox-ready', () => load({ force: true }));

async function init() { const database = await openSlaktlandskapDB({ name: 'korpholmen-explorer-v2' }); store = new IndexedDBStore(database); bundle = await createActiveAppBundle({ store, cacheKey: 'explorer-active-v2', sources: SOURCES }).init(); if (Object.keys(SOURCES).some(source => bundle.hasData(source))) { searchIndex = buildIndex(); renderRoute(); } await load(); }
init().catch(error => { console.error(error); setStatus(error.message, 'error'); });
