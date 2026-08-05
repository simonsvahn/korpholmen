import {
  KORPHOLMEN_APPS,
  SharedDropboxSession,
  beginDropboxOAuth,
  completeDropboxOAuth,
  disconnectDropboxEverywhere,
  exchangeDropboxRefreshToken,
  getAppFamilySyncStatuses,
  migrateLegacyCredentialsToShared,
  mirrorSharedDropboxCredential,
  registerKorpholmenServiceWorker,
  requestPersistentStorage,
  revokeDropboxAccessToken,
  syncAppFamily,
} from '../packages/core/data-layer.js';
import { DROPBOX_CLIENT_ID, DROPBOX_SCOPES } from './config.js';

const syncButton = document.querySelector('#sync-all');
const disconnectButton = document.querySelector('#disconnect-dropbox');
const syncSummary = document.querySelector('#sync-summary');
const releaseStatus = document.querySelector('#release-status');
const session = new SharedDropboxSession({ clientId: DROPBOX_CLIENT_ID, exchangeRefreshToken: exchangeDropboxRefreshToken });
let syncing = false;

const rootUrl = () => new URL('./', location.href);
const formatTime = value => value ? new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '';

function appStatusNode(id) {
  return document.querySelector(`[data-sync-status="${id}"]`);
}

function renderAppStatus(id, status) {
  const node = appStatusNode(id);
  if (!node) return;
  node.className = 'app-card-status';
  if (!status) { node.textContent = 'Inte synkad på den här enheten'; return; }
  if (status.state === 'syncing') { node.textContent = 'Synkar data…'; node.classList.add('is-syncing'); return; }
  if (status.state === 'error') { node.textContent = `Synkfel · ${status.message}`; node.classList.add('is-error'); return; }
  const additions = status.downloaded_ops ? ` · ${status.downloaded_ops.toLocaleString('sv-SE')} nya operationer` : ' · inga nya operationer';
  node.textContent = `Aktuell ${formatTime(status.synced_at)}${additions}`;
  node.classList.add('is-ok');
}

async function renderStatuses() {
  const statuses = await getAppFamilySyncStatuses();
  for (const app of KORPHOLMEN_APPS) renderAppStatus(app.id, statuses[app.id]);
}

async function completeOAuthCallbackIfNeeded() {
  const url = new URL(location.href);
  if (!url.searchParams.has('code') && !url.searchParams.has('error')) return false;
  const token = await completeDropboxOAuth();
  await session.acceptTokenResponse(token);
  await mirrorSharedDropboxCredential({ refreshToken: await session.getRefreshToken() });
  for (const parameter of ['code', 'state', 'error', 'error_description']) url.searchParams.delete(parameter);
  history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  const basePath = rootUrl().pathname;
  const saved = sessionStorage.getItem('korpholmen:oauth-return');
  sessionStorage.removeItem('korpholmen:oauth-return');
  if (saved && saved.startsWith(basePath) && saved !== basePath) {
    location.replace(new URL(saved, location.origin).href);
    return true;
  }
  return false;
}

async function connectDropbox() {
  const redirectUri = rootUrl().href;
  sessionStorage.setItem('korpholmen:oauth-return', rootUrl().pathname);
  const attempt = await beginDropboxOAuth({ clientId: DROPBOX_CLIENT_ID, redirectUri, scopes: DROPBOX_SCOPES });
  location.assign(attempt.url);
}

async function disconnectDropbox() {
  if (!window.confirm('Koppla från Dropbox på den här enheten? Lokala register och bilder behålls.')) return;
  syncButton.disabled = true;
  disconnectButton.disabled = true;
  syncSummary.textContent = 'Kopplar från Dropbox och rensar sparade inloggningskopior…';
  try {
    const result = await disconnectDropboxEverywhere({ session, revokeAccessToken: revokeDropboxAccessToken });
    syncButton.textContent = 'Anslut Dropbox';
    disconnectButton.hidden = true;
    const incomplete = result.revokeError || result.failures.length;
    syncSummary.textContent = incomplete
      ? 'Dropbox är frånkopplad lokalt. Fjärrspärr eller någon äldre tokenkopia kunde inte bekräftas; försök igen när alla appflikar är stängda och nätet fungerar.'
      : 'Dropbox är frånkopplad. Lokala register och bilder finns kvar på enheten.';
    syncSummary.className = incomplete ? 'sync-summary is-error' : 'sync-summary is-ok';
  } catch (error) {
    syncSummary.textContent = `Frånkopplingen misslyckades · ${error.message}`;
    syncSummary.className = 'sync-summary is-error';
  } finally {
    syncButton.disabled = false;
    disconnectButton.disabled = false;
  }
}

async function syncAll({ force = true } = {}) {
  if (syncing) return;
  const token = await session.getAccessToken({ online: navigator.onLine !== false });
  if (!token) return connectDropbox();
  syncing = true;
  syncButton.disabled = true;
  syncButton.textContent = 'Synkar…';
  syncSummary.textContent = 'Hämtar senaste data från samtliga register. Du kan fortsätta använda appen.';
  try {
    const result = await syncAppFamily({
      accessToken: token,
      force,
      onProgress: ({ app, ...status }) => renderAppStatus(app.id, status),
    });
    await renderStatuses();
    const failed = result.results.filter(item => item.state === 'error');
    if (failed.length) {
      syncSummary.textContent = `${result.results.length - failed.length} av ${result.results.length} register synkades. ${failed.length} kräver åtgärd.`;
      syncSummary.className = 'sync-summary is-error';
    } else {
      syncSummary.textContent = result.skipped ? 'Alla register är redan nyligen synkade.' : 'Alla register har senaste Dropbox-data på den här enheten.';
      syncSummary.className = 'sync-summary is-ok';
    }
  } catch (error) {
    syncSummary.textContent = navigator.onLine === false ? 'Offline · lokala data finns kvar på enheten.' : `Totalsynken misslyckades · ${error.message}`;
    syncSummary.className = 'sync-summary is-error';
  } finally {
    syncing = false;
    syncButton.disabled = false;
    syncButton.textContent = 'Synka allt';
  }
}

async function loadRelease() {
  try {
    const response = await fetch('./release-manifest.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(String(response.status));
    const release = await response.json();
    releaseStatus.textContent = `Appversion ${release.release}`;
  } catch (_) {
    releaseStatus.textContent = 'Appversion kunde inte kontrolleras';
  }
}

syncButton.addEventListener('click', () => syncAll({ force: true }));
disconnectButton.addEventListener('click', disconnectDropbox);
window.addEventListener('online', () => syncAll({ force: false }));

async function init() {
  const serviceWorkerPromise = registerKorpholmenServiceWorker({ rootPage: true });
  const persistencePromise = requestPersistentStorage();
  if (await completeOAuthCallbackIfNeeded()) return;
  await migrateLegacyCredentialsToShared();
  await mirrorSharedDropboxCredential({ refreshToken: await session.getRefreshToken() });
  await Promise.all([renderStatuses(), loadRelease()]);
  if (await session.hasCredential()) {
    syncButton.textContent = 'Synka allt';
    disconnectButton.hidden = false;
    await syncAll({ force: false });
  } else {
    syncButton.textContent = 'Anslut Dropbox';
    disconnectButton.hidden = true;
    syncSummary.textContent = 'Anslut en gång för att använda samma Dropbox-inloggning i alla appar.';
  }
  await Promise.all([serviceWorkerPromise, persistencePromise]);
}

init().catch(error => {
  console.error(error);
  syncSummary.textContent = `Korpholmen kunde inte starta · ${error.message}`;
  syncSummary.className = 'sync-summary is-error';
});
