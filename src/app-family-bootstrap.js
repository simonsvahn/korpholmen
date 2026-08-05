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
const activeApp = KORPHOLMEN_APPS.find(app => location.pathname.includes(`/${app.id}/`))?.id || null;
const session = new SharedDropboxSession({ clientId: DROPBOX_CLIENT_ID, exchangeRefreshToken: exchangeDropboxRefreshToken });

async function start() {
  await Promise.all([registerKorpholmenServiceWorker({ sourceTree }), requestPersistentStorage()]);
  await migrateLegacyCredentialsToShared();
  const refreshToken = await session.getRefreshToken();
  if (!refreshToken) return;
  await mirrorSharedDropboxCredential({ refreshToken });
  const accessToken = await session.getAccessToken({ online: navigator.onLine !== false });
  if (!accessToken) return;
  scheduleAppFamilySync({ accessToken, skipApp: activeApp }).catch(error => console.warn('Korpholmens bakgrundssynk kunde inte slutföras', error));
}

start().catch(error => console.warn('Korpholmens gemensamma appskal kunde inte starta', error));
