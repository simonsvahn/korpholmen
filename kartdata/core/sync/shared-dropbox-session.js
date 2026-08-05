const DATABASE_NAME = 'korpholmen-shared-v1';
const DATABASE_VERSION = 1;
const STORE_NAME = 'state';
const DROPBOX_TOKEN_KEY = 'dropbox:refresh-token';
const DROPBOX_DISCONNECTED_KEY = 'dropbox:disconnected-at';

const requestResult = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const transactionDone = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = () => reject(transaction.error || new Error('Den gemensamma lagringen avbröts'));
  transaction.onerror = () => reject(transaction.error);
});

export class KorpholmenSharedStore {
  constructor({ indexedDB = globalThis.indexedDB } = {}) {
    this.indexedDB = indexedDB;
    this.databasePromise = null;
  }

  async database() {
    if (!this.databasePromise) {
      if (!this.indexedDB?.open) throw new Error('IndexedDB saknas i denna miljö');
      this.databasePromise = new Promise((resolve, reject) => {
        const request = this.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return this.databasePromise;
  }

  async get(key) {
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const row = await requestResult(transaction.objectStore(STORE_NAME).get(String(key)));
    await transactionDone(transaction);
    return row?.value ?? null;
  }

  async put(key, value) {
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put({ key: String(key), value });
    await transactionDone(transaction);
  }

  async delete(key) {
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(String(key));
    await transactionDone(transaction);
  }
}

export class SharedDropboxSession {
  constructor({ clientId, exchangeRefreshToken, sharedStore = new KorpholmenSharedStore(), now = () => Date.now() } = {}) {
    if (!clientId) throw new TypeError('SharedDropboxSession kräver Dropbox client-id');
    if (typeof exchangeRefreshToken !== 'function') throw new TypeError('SharedDropboxSession kräver tokenväxlare');
    this.clientId = clientId;
    this.exchangeRefreshToken = exchangeRefreshToken;
    this.sharedStore = sharedStore;
    this.now = now;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
  }

  async hasCredential() {
    if (await this.sharedStore.get(DROPBOX_DISCONNECTED_KEY)) return false;
    return Boolean(await this.sharedStore.get(DROPBOX_TOKEN_KEY));
  }

  async getRefreshToken() {
    if (await this.sharedStore.get(DROPBOX_DISCONNECTED_KEY)) return null;
    return this.sharedStore.get(DROPBOX_TOKEN_KEY);
  }

  async acceptTokenResponse(token) {
    if (!token?.access_token) throw new Error('Dropbox returnerade ingen access token');
    this.accessToken = token.access_token;
    this.accessTokenExpiresAt = this.now() + Math.max(30, Number(token.expires_in || 0) - 60) * 1000;
    if (token.refresh_token) {
      await this.sharedStore.put(DROPBOX_TOKEN_KEY, token.refresh_token);
      await this.sharedStore.delete(DROPBOX_DISCONNECTED_KEY);
    }
    return this.accessToken;
  }

  async migrateLegacyStore(store, tokenKeys = ['dropbox:refresh-token', 'dropbox:refresh-token-v1']) {
    if (await this.sharedStore.get(DROPBOX_DISCONNECTED_KEY)) return false;
    if (await this.hasCredential()) return false;
    if (!store?.getMeta) return false;
    for (const key of tokenKeys) {
      const refreshToken = await store.getMeta(key);
      if (!refreshToken) continue;
      await this.sharedStore.put(DROPBOX_TOKEN_KEY, refreshToken);
      return true;
    }
    return false;
  }

  async getAccessToken({ online = true } = {}) {
    if (this.accessToken && this.now() < this.accessTokenExpiresAt) return this.accessToken;
    if (!online) return null;
    if (await this.sharedStore.get(DROPBOX_DISCONNECTED_KEY)) return null;
    const refreshToken = await this.sharedStore.get(DROPBOX_TOKEN_KEY);
    if (!refreshToken) return null;
    const token = await this.exchangeRefreshToken({ clientId: this.clientId, refreshToken });
    await this.acceptTokenResponse(token);
    if (token.refresh_token && token.refresh_token !== refreshToken) await this.sharedStore.put(DROPBOX_TOKEN_KEY, token.refresh_token);
    return this.accessToken;
  }

  async disconnect() {
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    await this.sharedStore.put(DROPBOX_DISCONNECTED_KEY, new Date(this.now()).toISOString());
    await this.sharedStore.delete(DROPBOX_TOKEN_KEY);
  }
}

export const sharedDropboxTokenKey = DROPBOX_TOKEN_KEY;
export const sharedDropboxDisconnectedKey = DROPBOX_DISCONNECTED_KEY;
