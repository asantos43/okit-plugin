import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startConfigServer } from '../../src/config-ui/server.js';

export async function wizardServer(t, firstRun = null) {
  const root = await mkdtemp(join(tmpdir(), 'wizard-http-'));
  let handle;
  const server = new EventEmitter();
  Object.assign(server, { listen(_port, host, ready) { if (host !== '127.0.0.1') throw new Error('public bind'); ready(); },
    address: () => ({ port: 32123 }), close(done) { done(); }, closeAllConnections() {}, unref() {} });
  const session = await startConfigServer({ root, env: { HOME: root, CODEX_HOME: root, CLAUDE_CONFIG_DIR: root },
    signals: new EventEmitter(), firstRun, detect: async () => ({ clients: [] }), observe: async () => ({ clients: [] }),
    install: { wizardObserve: async () => ({ detection: [{ client: 'codex', installed: true, executable: 'codex', version: '1' }], requirements: [], platform: 'linux', recovery: [] }) },
    createServer(callback) { handle = callback; return server; } });
  t.after(async () => { await session.close(); await rm(root, { recursive: true, force: true }); });
  const request = (path = '/', method = 'GET', headers = {}, raw = '{}') => new Promise((resolve) => {
    const req = Readable.from([Buffer.from(raw)]);
    Object.assign(req, { method, url: path, headers: { host: '127.0.0.1:32123', origin: 'http://127.0.0.1:32123',
      'x-okit-token': session.token, 'content-type': 'application/json', ...headers } });
    const res = new EventEmitter(); res.setHeader = () => {};
    res.writeHead = (status, values) => { res.status = status; res.headers = values; };
    res.end = (text) => { resolve({ status: res.status, text, headers: res.headers,
      json: () => JSON.parse(text) }); res.emit('finish'); };
    handle(req, res);
  });
  return { ...session, request };
}
