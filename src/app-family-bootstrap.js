import {
  KORPHOLMEN_APPS,
  SharedDropboxSession,
  exchangeDropboxRefreshToken,
  migrateLegacyCredentialsToShared,
  mirrorSharedDropboxCredential,
  registerKorpholmenServiceWorker,
  requestPersistentStorage,
  scheduleAppFamilySync,
} from '../packages/core/data-layer.js';
import { DROPBOX_CLIENT_ID } from './config.js';

const sourceTree = location.pathname.includes('/apps/');
const activeAppConfig = KORPHOLMEN_APPS.find(app => location.pathname.includes(`/${app.id}/`)) || null;
const activeApp = activeAppConfig?.id || null;
const session = new SharedDropboxSession({ clientId: DROPBOX_CLIENT_ID, exchangeRefreshToken: exchangeDropboxRefreshToken });

async function start() {
  const shellPromise = Promise.all([registerKorpholmenServiceWorker({ sourceTree }), requestPersistentStorage()]);
  await migrateLegacyCredentialsToShared({ appList: activeAppConfig ? [activeAppConfig] : [] });
  const refreshToken = await session.getRefreshToken();
  if (!refreshToken) return shellPromise;
  await mirrorSharedDropboxCredential({ refreshToken, appList: activeAppConfig ? [activeAppConfig] : [] });
  window.dispatchEvent(new CustomEvent('korpholmen:dropbox-ready', { detail: { app: activeApp } }));
  const accessToken = await session.getAccessToken({ online: navigator.onLine !== false });
  if (!accessToken) return shellPromise;
  scheduleAppFamilySync({ accessToken, skipApp: activeApp }).catch(error => console.warn('Korpholmens bakgrundssynk kunde inte slutföras', error));
  await shellPromise;
}

start().catch(error => console.warn('Korpholmens gemensamma appskal kunde inte starta', error));
