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
  validateOperation
} from './data-layer.js';
import { DROPBOX_CLIENT_ID, DROPBOX_SCOPES, LOCAL_BOOTSTRAP_URL } from './config.js';

const $ = selector => document.querySelector(selector);
const statusNode = $('#sync-status');
const contentNode = $('#content');
const searchNode = $('#search');
const connectButton = $('#connect-dropbox');
const bootstrapButton = $('#bootstrap-local');
const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const TOKEN_META = 'dropbox:refresh-token-v1';
const BOOTSTRAP_META = 'bootstrap:migration-2026-08-01';
let repository;
let store;
let accessToken = null;
let accessTokenExpiresAt = 0;
let syncPromise = null;
let selectedPersonId = null;

const escapeHtml = value => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

function setStatus(text, tone = '') {
  statusNode.textContent = text;
  statusNode.dataset.tone = tone;
}

function redirectUri() {
  return new URL('.', location.href).href;
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
    .map(entity => ({ id: entity.entity_id, ...entity.fields }))
    .sort((a, b) => a.display_name.localeCompare(b.display_name, 'sv'));
}

function relationRecords() {
  return repository.listEntities('relation')
    .map(entity => ({ id: entity.entity_id, ...entity.fields }));
}

function relationsFor(personId) {
  return relationRecords().filter(relation => relation.from_person_id === personId || relation.to_person_id === personId);
}

function relationText(relation, peopleById) {
  const from = peopleById.get(relation.from_person_id)?.display_name || relation.from_person_id;
  const to = peopleById.get(relation.to_person_id)?.display_name || relation.to_person_id;
  if (relation.kind === 'foralder-barn') return `${from} är förälder till ${to}`;
  if (relation.kind === 'tidigare') return `${from} och ${to} var tidigare partner`;
  return `${from} och ${to} är partner`;
}

function render() {
  const allPeople = personRecords();
  const allRelations = relationRecords();
  const peopleById = new Map(allPeople.map(person => [person.id, person]));
  const query = searchNode.value.trim().toLocaleLowerCase('sv');
  const people = query
    ? allPeople.filter(person => [person.display_name, person.full_name, person.club_name, ...(person.aliases || [])]
      .some(value => String(value || '').toLocaleLowerCase('sv').includes(query)))
    : allPeople;
  const selected = selectedPersonId ? peopleById.get(selectedPersonId) : null;

  if (!allPeople.length) {
    contentNode.innerHTML = `
      <section class="empty-card">
        <h2>Ingen privat släktdata på den här enheten ännu</h2>
        <p>Anslut Dropbox för att hämta den privata mastern. Den lokala arbetskopian kan också aktivera den godkända engångsmigreringen.</p>
      </section>`;
    return;
  }

  const detail = selected ? `
    <aside class="person-detail" aria-label="Persondetaljer">
      <button class="close-detail" type="button" data-action="close-detail" aria-label="Stäng">×</button>
      <p class="eyebrow">Person</p>
      <h2>${escapeHtml(selected.display_name)}</h2>
      <dl>
        <div><dt>Född</dt><dd>${escapeHtml(selected.birth ?? 'Okänt')}</dd></div>
        <div><dt>KBK-namn</dt><dd>${escapeHtml(selected.club_name || '—')}</dd></div>
        <div><dt>Familj</dt><dd>${escapeHtml(selected.family || '—')}</dd></div>
        <div><dt>Öanknytning, äldre modell</dt><dd>${escapeHtml(selected.legacy_island || '—')} · ${escapeHtml(selected.residence_status || 'okänt')}</dd></div>
      </dl>
      ${selected.note ? `<p class="note">${escapeHtml(selected.note)}</p>` : ''}
      <h3>Relationer</h3>
      <ul class="relation-list">${relationsFor(selected.id).map(relation => `<li>${escapeHtml(relationText(relation, peopleById))}</li>`).join('') || '<li>Inga registrerade relationer</li>'}</ul>
      <p class="foundation-note">Redigering öppnas i nästa UX-etapp. Den nya lagringsgrunden är redan förberedd för atomiska ändringar och tombstones.</p>
    </aside>` : '';

  contentNode.innerHTML = `
    <section class="summary" aria-label="Datasammanfattning">
      <div><strong>${allPeople.length}</strong><span>personer</span></div>
      <div><strong>${allRelations.length}</strong><span>relationer</span></div>
      <div><strong>${people.length}</strong><span>visas</span></div>
    </section>
    <div class="workspace ${selected ? 'has-detail' : ''}">
      <section class="person-list" aria-label="Personer">
        ${people.map(person => `
          <button class="person-row" type="button" data-person-id="${escapeHtml(person.id)}">
            <span><strong>${escapeHtml(person.display_name)}</strong>${person.club_name ? `<small>${escapeHtml(person.club_name)}</small>` : ''}</span>
            <span class="person-meta">${escapeHtml(person.birth ?? '—')} · ${escapeHtml(person.legacy_island || 'utan ö')}</span>
          </button>`).join('') || '<p class="empty-search">Ingen person matchar sökningen.</p>'}
      </section>
      ${detail}
    </div>`;
}

async function completeOAuthCallback() {
  const url = new URL(location.href);
  if (!url.searchParams.has('code') && !url.searchParams.has('error')) return;
  const token = await completeDropboxOAuth();
  accessToken = token.access_token;
  accessTokenExpiresAt = Date.now() + Math.max(30, Number(token.expires_in || 0) - 60) * 1000;
  if (token.refresh_token) await store.putMeta(TOKEN_META, token.refresh_token);
  url.searchParams.delete('code');
  url.searchParams.delete('state');
  url.searchParams.delete('error');
  url.searchParams.delete('error_description');
  history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

async function currentAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiresAt) return accessToken;
  const refreshToken = await store.getMeta(TOKEN_META);
  if (!refreshToken || !DROPBOX_CLIENT_ID) return null;
  const token = await exchangeDropboxRefreshToken({ clientId: DROPBOX_CLIENT_ID, refreshToken });
  accessToken = token.access_token;
  accessTokenExpiresAt = Date.now() + Math.max(30, Number(token.expires_in || 0) - 60) * 1000;
  return accessToken;
}

async function uploadBootstrapIfNeeded(transport) {
  const pending = await store.getMeta(BOOTSTRAP_META);
  if (!pending?.pending) return 0;
  const operations = (await store.getAllOps())
    .filter(operation => operation.device_id === pending.device_id)
    .sort((a, b) => a.seq - b.seq);
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
    const token = await currentAccessToken();
    if (!token) {
      setStatus(DROPBOX_CLIENT_ID ? 'Lokalt sparat · Dropbox ej ansluten' : 'Lokalt sparat · Dropbox-app återstår', 'warning');
      return;
    }
    setStatus('Synkar…');
    const transport = new DropboxTransport({ accessToken: token, id: 'dropbox-slaktlandskap' });
    const bootstrapUploaded = await uploadBootstrapIfNeeded(transport);
    const engine = new SyncEngine({ repository, transport });
    const result = await engine.syncOnce();
    render();
    setStatus(`Synkad · ${bootstrapUploaded + result.uploadedOps} upp, ${result.downloadedOps} ned`, 'ok');
  })().catch(error => {
    console.error(error);
    setStatus(`Åtgärd krävs · ${error.message}`, 'error');
  }).finally(() => { syncPromise = null; });
  return syncPromise;
}

async function connectDropbox() {
  if (!DROPBOX_CLIENT_ID) {
    setStatus('En separat Dropbox-app måste skapas innan anslutning', 'warning');
    return;
  }
  const attempt = await beginDropboxOAuth({
    clientId: DROPBOX_CLIENT_ID,
    redirectUri: redirectUri(),
    scopes: DROPBOX_SCOPES
  });
  location.assign(attempt.url);
}

async function bootstrapLocal() {
  if (!isLocal) throw new Error('Startkopian kan bara aktiveras från den lokala arbetskopian');
  setStatus('Läser den låsta startkopian…');
  const response = await fetch(LOCAL_BOOTSTRAP_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Startkopian kunde inte läsas (${response.status})`);
  const document = await response.json();
  if (document.operations_version !== 1 || !Array.isArray(document.operations)) throw new Error('Startkopian har fel format');
  document.operations.forEach(validateOperation);
  await repository.applyRemoteOps(document.operations);
  await store.putMeta(BOOTSTRAP_META, {
    pending: true,
    device_id: document.device_id,
    migration_id: document.migration_id,
    operations: document.operations.length
  });
  bootstrapButton.hidden = true;
  render();
  setStatus('Godkänd startkopia aktiverad lokalt · väntar på Dropbox', 'ok');
}

async function init() {
  const db = await openSlaktlandskapDB();
  store = new IndexedDBStore(db);
  repository = await new Repository({ store, deviceId: deviceId() }).init();
  bootstrapButton.hidden = !isLocal || personRecords().length > 0;
  connectButton.textContent = DROPBOX_CLIENT_ID ? 'Anslut eller synka Dropbox' : 'Dropbox-konfiguration återstår';
  connectButton.disabled = !DROPBOX_CLIENT_ID;
  render();
  await completeOAuthCallback();
  await syncNow();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(console.error);
}

searchNode.addEventListener('input', render);
connectButton.addEventListener('click', connectDropbox);
bootstrapButton.addEventListener('click', () => bootstrapLocal().catch(error => setStatus(error.message, 'error')));
contentNode.addEventListener('click', event => {
  const personButton = event.target.closest('[data-person-id]');
  if (personButton) {
    selectedPersonId = personButton.dataset.personId;
    render();
    return;
  }
  if (event.target.closest('[data-action="close-detail"]')) {
    selectedPersonId = null;
    render();
  }
});
window.addEventListener('online', syncNow);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });

init().catch(error => {
  console.error(error);
  setStatus(`Kunde inte starta · ${error.message}`, 'error');
});
