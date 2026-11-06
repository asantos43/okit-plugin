import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import * as filesystem from 'node:fs/promises';
import { configOf } from '../profiles.js';
import { readJson } from '../state.js';
import { configMtime, configSetMany, mutateState } from '../core/config.js';
import { Refusal } from '../core/refusal.js';
import { UsageError, OperationalError } from '../install/exit.js';
import { localizeReason } from '../install/present.js';
import { changeAccount } from '../accounts-cli.js';
import { withAccountRenamed, accountFiles, accountsOf, accountEnv, ACCOUNT_CLIENTS, requireAccount } from '../accounts.js';
import { launchLogin as launchAccountLogin } from '../accounts-login-launch.js';
import { defaultFolderOf } from '../install/config.js';
import { detectClients, confirmedModels } from '../env/models.js';
import { environmentSnapshot } from '../env/snapshot.js';
import { limitsStatus } from '../limits.js';
import { buildState, describeAccount, redact, sensitive } from './state.js';
import { renderPage } from './page.js';

const fail = (status, reason) => Object.assign(new Error(reason), { status });
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const run = promisify(execFile);
const noClientFiles = { readFile: async () => { throw new Error('Client file reads are disabled.'); },
  stat: async () => { throw new Error('Client file reads are disabled.'); } };

export async function startConfigServer({ root, env = process.env, locale = 'en', idleMs = 600_000,
  modelTimeoutMs = 5000, closeGraceMs = 3000, detect = detectClients, observe, signals = process,
  platform = process.platform, launchLogin = launchAccountLogin } = {}) {
  const token = randomBytes(32).toString('hex');
  const observations = new Map();
  const controllers = new Set();
  let timer, graceTimer, port, activeInstance, stopping = false, resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const server = http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      if (error.status === 413) response.setHeader('Connection', 'close');
      const status = typeof error.status === 'number' ? error.status
        : error instanceof Refusal || error instanceof UsageError ? 422 : 500;
      if (!response.headersSent) send(response, status, { reason: status === 500 ? 'Request failed.' : redact(error.message) });
      else response.destroy();
    });
  });
  const close = () => {
    if (stopping) return closed;
    stopping = true;
    clearTimeout(timer);
    clearTimeout(graceTimer);
    signals.removeListener('SIGINT', close);
    for (const controller of controllers) controller.abort();
    server.close(() => resolveClosed());
    server.closeAllConnections();
    return closed;
  };
  const touch = () => { clearTimeout(timer); timer = setTimeout(close, idleMs); };
  const send = (response, status, value) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    response.end(JSON.stringify(value));
  };
  async function refresh(config, client) {
    if (!Object.hasOwn(config.profiles, client)) throw fail(422, 'Unknown client.');
    const controller = new AbortController();
    controllers.add(controller);
    let timeout;
    try {
      const result = await Promise.race([
        new Promise((_, reject) => controller.signal.addEventListener('abort',
          () => reject(new Error('Model refresh stopped.')), { once: true })),
        Promise.all((ACCOUNT_CLIENTS.includes(client) ? accountsOf(config, client) : [{ id: 'default' }])
          .map(async (account) => {
            const childEnv = ACCOUNT_CLIENTS.includes(client) ? accountEnv(client, account, env, undefined, config) : env;
            const result = await detect({ config, env: childEnv, onlyClient: client, account: account.id,
              run: async ({ command, args, env: runEnv }) => ({
                ...await run(command, args, { env: runEnv ?? childEnv, timeout: modelTimeoutMs,
                  signal: controller.signal, maxBuffer: 1024 * 1024 }), code: 0 }) });
            return (result.clients.length ? result.clients : [{ client, models: [], source: 'catalog',
              reason: 'Client is unavailable.' }]).map((entry) => ({ ...entry, account: account.id }));
          })).then((rows) => ({ clients: rows.flat() })),
        new Promise((_, reject) => { timeout = setTimeout(() => {
          controller.abort(); reject(new Error('Model list timed out.'));
        }, modelTimeoutMs); }),
      ]);
      observations.set(client, result.clients);
    } catch {
      observations.set(client, [{ client, installed: null, models: [], source: 'catalog',
        reason: 'Model list is unavailable.' }]);
    } finally { clearTimeout(timeout); controllers.delete(controller); }
    return observations.get(client);
  }
  async function load() {
    const expectedMtime = await configMtime(root);
    const raw = await readJson(join(root, 'config.json'), {});
    return { raw, config: configOf(raw), expectedMtime };
  }
  async function state(chosenLocale) {
    const loaded = await load();
    await Promise.all(Object.keys(loaded.config.profiles).map((client) =>
      observations.has(client) ? undefined : refresh(loaded.config, client)));
    const readings = [...observations.values()].flat();
    const snapshot = observe ? await observe(loaded.config, readings)
      : await environmentSnapshot({ root, config: loaded.config, env, fs: noClientFiles,
        record: false, cache: new Map(), plugin: { onPath: null },
        versions: Object.fromEntries(readings.map((entry) => [entry.client, { installed: entry.installed }])),
        limits: await limitsStatus(root, loaded.config),
        detectClients: async ({ onlyClient, account }) => ({ clients: readings.filter((entry) =>
          (!onlyClient || entry.client === onlyClient) && (entry.account ?? 'default') === (account ?? 'default')) }),
        readQuota: (client, id) => ACCOUNT_CLIENTS.includes(client)
          ? readJson(join(root, 'quota', accountFiles(client, id).reading), null) : null });
    const accountStates = await Promise.all(ACCOUNT_CLIENTS.flatMap((client) => accountsOf(loaded.raw, client))
      .map((account) => describeAccount(account, loaded.raw, { env })));
    return buildState({ ...loaded, observations: readings, snapshot, accountStates, locale: chosenLocale });
  }
  function authorize(request, url) {
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(request.headers.host)) throw fail(403, 'Invalid Host.');
    const origin = request.headers.origin;
    if (origin !== undefined ? !hosts.map((host) => `http://${host}`).includes(origin)
      : request.method !== 'GET' || ![undefined, 'same-origin', 'none'].includes(request.headers['sec-fetch-site'])) {
      throw fail(403, 'Invalid Origin.');
    }
    const supplied = request.headers['x-okit-token']
      ?? (request.method === 'GET' && url.pathname === '/' ? url.searchParams.get('token') : null);
    const actual = Buffer.from(typeof supplied === 'string' ? supplied : '');
    if (actual.length !== token.length || !timingSafeEqual(actual, Buffer.from(token))) throw fail(403, 'Invalid token.');
  }
  async function body(request) {
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw fail(415, 'Use application/json.');
    }
    if (Number(request.headers['content-length']) > 65536) throw fail(413, 'Body exceeds 64 KiB.');
    let size = 0;
    const chunks = [];
    await new Promise((resolve, reject) => {
      const collect = (chunk) => {
        size += chunk.length;
        if (size > 65536) {
          request.removeListener('data', collect);
          chunks.length = 0;
          request.resume();
          reject(fail(413, 'Body exceeds 64 KiB.'));
        } else chunks.push(chunk);
      };
      request.on('data', collect);
      request.once('end', resolve);
      request.once('error', reject);
    });
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw fail(422, 'Invalid JSON.'); }
  }
  async function handle(request, response) {
    const url = new URL(request.url, 'http://127.0.0.1');
    authorize(request, url);
    if (url.pathname !== '/api/keepalive') clearTimeout(graceTimer);
    touch();
    const routes = { '/': 'GET', '/api/state': 'GET', '/api/config': 'PUT',
      '/api/account-label': 'PUT', '/api/account-add': 'POST', '/api/account-remove': 'POST',
      '/api/account-login': 'POST',
      '/api/models/refresh': 'POST', '/api/close': 'POST', '/api/keepalive': 'POST' };
    if (!Object.hasOwn(routes, url.pathname)) throw fail(404, 'Not found.');
    if (request.method !== routes[url.pathname]) throw fail(405, 'Method not allowed.');
    if (url.pathname === '/') return page(response, url.searchParams.get('locale'));
    if (url.pathname === '/api/state') return send(response, 200, await state(url.searchParams.get('locale') ?? locale));
    const input = await body(request);
    if (url.pathname === '/api/keepalive') {
      const ok = typeof input?.instance === 'string' && input.instance === activeInstance;
      if (ok) clearTimeout(graceTimer);
      return send(response, 200, { ok });
    }
    if (url.pathname === '/api/close') {
      if (input?.grace === true) {
        if (typeof input.instance !== 'string' || input.instance !== activeInstance) {
          return send(response, 200, { closed: false });
        }
        graceTimer = setTimeout(close, closeGraceMs);
      }
      else response.once('finish', close);
      send(response, 200, { closed: true });
      return;
    }
    if (url.pathname === '/api/models/refresh') {
      if (!object(input) || typeof input.client !== 'string') throw fail(422, 'Client is required.');
      const { config } = await load();
      return send(response, 200, redact(await refresh(config, input.client)));
    }
    if (url.pathname === '/api/account-login') return login(input, response);
    if (url.pathname === '/api/account-label') return rename(input, response);
    if (url.pathname === '/api/account-add' || url.pathname === '/api/account-remove') {
      return change(input, response, url.pathname === '/api/account-add' ? 'add' : 'remove');
    }
    if (!object(input) || !Object.hasOwn(input, 'expectedMtime')) throw fail(422, 'expectedMtime is required.');
    if (input.expectedMtime !== null && (typeof input.expectedMtime !== 'number' || !Number.isFinite(input.expectedMtime))) {
      throw fail(422, 'expectedMtime must be a number or null.');
    }
    const changes = input.changes;
    if (!Array.isArray(changes) || changes.some((change) => !object(change)
      || typeof change.path !== 'string'
      || (Object.hasOwn(change, 'value') ? change.unset === true : change.unset !== true))) throw fail(422, 'Changes must set or unset a path.');
    const modelClients = [...new Set(changes.filter(change => /^profiles\.[^.]+\.[^.]+\.model$/.test(change.path))
      .map(change => change.path.split('.')[1]))];
    if (modelClients.some(client => !observations.has(client))) {
      const { config } = await load();
      await Promise.all(modelClients.map(client => observations.has(client) ? undefined : refresh(config, client)));
    }
    const result = await configSetMany(root, changes, { expectedMtime: input.expectedMtime,
      validate: async (change, config) => {
        if (containsSecret(change.value, change.path)) throw fail(422, 'Credentials cannot be saved here.');
        if (!/^profiles\.[^.]+\.[^.]+\.model$/.test(change.path)) return;
        const client = change.path.split('.')[1];
        const readings = observations.get(client);
        if (readings.some((reading) => !confirmedModels(config, client, reading, reading.installed).includes(change.value.trim()))
          && change.confirm !== true) throw fail(422, 'Model is not confirmed by the client; confirm this change explicitly.');
      } });
    send(response, result.conflict ? 409 : 200, result.conflict ? { reason: 'Configuration changed on disk.' } : redact({ changes: result.changes }));
  }
  async function login(input, response) {
    try {
      if (!object(input) || typeof input.client !== 'string' || !ACCOUNT_CLIENTS.includes(input.client)) {
        throw new UsageError('Unsupported account client.');
      }
      if (typeof input.id !== 'string') throw new UsageError('Invalid account id.');
      const { raw } = await load();
      const account = requireAccount(raw, input.client, input.id);
      const saved = Object.hasOwn(raw.accounts ?? {}, input.client);
      const result = await launchLogin({ client: input.client, account, saved, platform, env });
      send(response, 200, redact(result));
    } catch (error) {
      if (!(error instanceof UsageError || error instanceof OperationalError || error instanceof Refusal)) throw error;
      send(response, 422, { reason: localizeReason(redact(error.message), locale) });
    }
  }
  async function change(input, response, action) {
    try {
      if (!object(input) || typeof input.client !== 'string' || !ACCOUNT_CLIENTS.includes(input.client)) {
        throw new UsageError('Unsupported account client.');
      }
      if (action === 'remove' && typeof input.id !== 'string') throw new UsageError('Invalid account id.');
      const result = await changeAccount({ root, env, platform: process.platform, fs: filesystem }, action,
        { client: input.client, name: action === 'add' ? input.label : input.id, directory: input.configDir },
        async (next) => ({ expectedMtime: await configMtime(root),
          ...(action === 'add' ? { account: await describeAccount(accountsOf(next, input.client).at(-1), next, { env }) }
            : { client: input.client, id: input.id }) }));
      send(response, 200, redact(result));
    } catch (error) {
      if (!(error instanceof UsageError || error instanceof OperationalError)) throw error;
      send(response, 422, { reason: localizeReason(redact(error.message), locale) });
    }
  }
  async function rename(input, response) {
    if (!object(input) || typeof input.client !== 'string' || typeof input.id !== 'string') throw fail(422, 'Client and account id are required.');
    if (!ACCOUNT_CLIENTS.includes(input.client)) throw fail(422, 'Unsupported account client.');
    if (typeof input.label !== 'string') throw fail(422, 'Account label must be a string.');
    if (containsSecret(input.label)) throw fail(422, 'Credentials cannot be saved here.');
    await mutateState(root, (raw) => {
      const options = { env, platform: process.platform };
      const currentDefaultDir = defaultFolderOf(input.client, { ...options, config: raw });
      const defaultDir = defaultFolderOf(input.client, { ...options,
        config: { ...raw, accounts: { ...raw.accounts, [input.client]: raw.accounts?.[input.client] ?? [] } } });
      const next = withAccountRenamed(raw, input.client, input.id, input.label, { ...options, defaultDir, currentDefaultDir });
      return { write: next };
    });
    send(response, 200, { client: input.client, id: input.id, label: redact(input.label) });
  }
  async function page(response, requestedLocale) {
    const nonce = randomBytes(18).toString('base64');
    const chosenLocale = ['en', 'pt-BR'].includes(requestedLocale) ? requestedLocale : locale;
    const pageState = await state(chosenLocale);
    activeInstance = randomBytes(12).toString('hex');
    const html = renderPage(pageState, { locale: chosenLocale, nonce, token, instance: activeInstance });
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
    response.end(html);
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
  signals.on('SIGINT', close);
  touch();
  return { url: `http://127.0.0.1:${port}/?token=${token}`, token, port, server, close, closed };
}

function containsSecret(value, path = '') {
  return sensitive(path, value) || value && typeof value === 'object'
    && Object.entries(value).some(([key, item]) => containsSecret(item, `${path}.${key}`));
}
