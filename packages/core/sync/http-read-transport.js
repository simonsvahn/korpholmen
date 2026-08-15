export class HttpReadTransport {
  constructor({ baseUrl = globalThis.location?.origin || 'http://127.0.0.1', fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('HttpReadTransport kräver fetch');
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    // Window.fetch throws "Illegal invocation" when it is stored and later
    // called as a plain function. Keep the injected function testable, but
    // always invoke it with the browser global as receiver.
    this.fetchImpl = (...args) => fetchImpl.call(globalThis, ...args);
  }

  async getBytes(path) {
    const relative = String(path || '');
    if (!relative.startsWith('/') || relative.includes('\\')) throw new TypeError('Den lokala lässökvägen måste vara absolut');
    const response = await this.fetchImpl(`${this.baseUrl}${relative}`, { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) {
      const error = new Error(`Den lokala läsmastern kunde inte hämtas (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async putBatch() { throw new Error('HttpReadTransport är skrivskyddad'); }
  async putBytes() { throw new Error('HttpReadTransport är skrivskyddad'); }
}
