import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, readFile, writeFile, readdir, rm, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { startConfigServer } from '../src/config-ui/server.js';
import { configSet, configMtime, configSetMany, schemaEntries } from '../src/core/config.js';
import { withAccountAdded, withAccountRemoved, withAccountRenamed } from '../src/accounts.js';
import { localizeReason } from '../src/install/present.js';

async function filesOnly(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  assert.ok(entries.every(entry => entry.name !== 'config.lock'), 'config lock was released');
  return entries.filter(entry => !entry.isDirectory()).map(entry => entry.name).sort();
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'okit-config-ui-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = await startConfigServer({ root, env: { HOME: root, PATH: '' },
    detect: async ({ onlyClient }) => ({ clients: [{ client: onlyClient, installed: true,
      source: 'listing', models: ['test-model'] }] }),
    observe: async (config) => ({ config, clients: [] }), ...options });
  t.after(() => session.close());
  return { ...session, root, origin: `http://127.0.0.1:${session.port}` };
}

function request(session, path, { method = 'GET', headers = {}, value, raw } = {}) {
  return new Promise((resolve, reject) => {
    const allHeaders = { origin: session.origin, 'x-okit-token': session.token,
      ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...headers };
    for (const key of Object.keys(allHeaders)) if (allHeaders[key] === null) delete allHeaders[key];
    const req = http.request({ host: '127.0.0.1', port: session.port, path, method, headers: allHeaders }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text,
        json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(raw ?? (value === undefined ? undefined : JSON.stringify(value)));
  });
}

test('account login must refuse unknown client, missing or non-string id, and unknown account without launching', async t => {
  const calls = [];
  const session = await fixture(t, { launchLogin: async input => { calls.push(input); return { launched: true }; } });
  for (const value of [null, [], { client: 'opencode', id: 'default' }, { client: {}, id: 'default' },
    { client: 'codex' }, { client: 'codex', id: 3 }, { client: 'codex', id: {} }, { client: 'codex', id: 'missing' }]) {
    const result = await request(session, '/api/account-login', { method: 'POST', value });
    assert.equal(result.status, 422, result.text);
    assert.equal(typeof result.json().reason, 'string');
    assert.deepEqual(calls, []);
  }
});

test('account login uses saved extra and default, ignoring request commands and folders', async t => {
  const calls = [], env = { HOME: '/test/home', PATH: '' };
  const session = await fixture(t, { env, platform: 'darwin', launchLogin: async input => {
    calls.push(input); return { launched: true, terminal: 'injected', token: 'hidden' };
  } });
  const saved = { accounts: { codex: [{ id: 'work', label: 'Work', configDir: '/saved/work' }] } };
  await writeFile(join(session.root, 'config.json'), JSON.stringify(saved));
  for (const id of ['work', 'default']) {
    const result = await request(session, '/api/account-login', { method: 'POST', value: {
      client: 'codex', id, configDir: '/request/folder', command: 'bad command' } });
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(result.json(), { launched: true, terminal: 'injected', token: '[Redacted]' });
    const expectedAccount = { client: 'codex', id, label: id === 'work' ? 'Work' : 'default',
      configDir: id === 'work' ? '/saved/work' : null, isDefault: id === 'default', key: id === 'work' ? 'codex:work' : 'codex' };
    assert.deepEqual(calls.at(-1), { client: 'codex', account: expectedAccount, saved: true, platform: 'darwin', env });
    assert.strictEqual(calls.at(-1).env, env);
    assert.equal(calls.length, id === 'work' ? 1 : 2);
  }
});

test('injected Windows platform agrees across account add, state and login launch', async t => {
  const calls = [];
  const session = await fixture(t, { platform: 'win32', launchLogin: async input => {
    calls.push(input); return { launched: true };
  } });
  const configDir = join(session.root, 'work');
  const command = `$env:CODEX_HOME='${configDir}'; codex login`;
  const added = await request(session, '/api/account-add', { method: 'POST',
    value: { client: 'codex', label: 'Work', configDir } });
  assert.equal(added.status, 200, added.text);
  assert.equal(added.json().account.loginCommand, command);
  const state = await request(session, '/api/state');
  assert.equal(state.status, 200, state.text);
  assert.equal(state.json().accounts.find(account => account.id === 'work').loginCommand, command);
  const login = await request(session, '/api/account-login', { method: 'POST',
    value: { client: 'codex', id: 'work' } });
  assert.equal(login.status, 200, login.text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].platform, 'win32');
  assert.equal(calls[0].account.configDir, configDir);
});

test('account login failure stays 200 and current saved config is checked on each request', async t => {
  const calls = [], result = { launched: false, reason: 'no-terminal' };
  const session = await fixture(t, { launchLogin: async input => { calls.push(input); return result; } });
  const post = id => request(session, '/api/account-login', { method: 'POST', value: { client: 'claude-code', id } });
  assert.deepEqual((await post('default')).json(), result);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].saved, false);
  assert.equal(calls[0].platform, process.platform);
  await writeFile(join(session.root, 'config.json'), JSON.stringify({ accounts: { 'claude-code': [
    { id: 'work', label: 'Work', configDir: '/saved/claude' }] } }));
  const existing = await post('work');
  assert.equal(existing.status, 200);
  assert.deepEqual(existing.json(), result);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].account.configDir, '/saved/claude');
  await writeFile(join(session.root, 'config.json'), '{}');
  assert.equal((await post('work')).status, 422);
  assert.equal(calls.length, 2);
  const defaultResult = await post('default');
  assert.equal(defaultResult.status, 200);
  assert.deepEqual(defaultResult.json(), result);
});

test('account add returns login help and mtime; removal preserves folder, login and history', async t => {
  const session = await fixture(t);
  const configDir = join(session.root, 'work');
  const add = await request(session, '/api/account-add', { method: 'POST', value: { client: 'codex', label: 'Work', configDir } });
  assert.equal(add.status, 200, add.text);
  assert.deepEqual(add.json().account, { client: 'codex', id: 'work', label: 'Work', configDir,
    login: 'logged-out', loginCommand: `CODEX_HOME=${configDir} codex login` });
  assert.equal(add.json().expectedMtime, await configMtime(session.root));
  if (process.platform !== 'win32') assert.equal((await stat(configDir)).mode & 0o777, 0o700);
  await writeFile(join(configDir, 'auth.json'), 'PRIVATE-CREDENTIAL');
  await writeFile(join(configDir, 'history.jsonl'), 'history');
  const state = (await request(session, '/api/state')).json();
  assert.equal(state.accounts.find(account => account.id === 'work').login, 'logged-in');
  const remove = await request(session, '/api/account-remove', { method: 'POST', value: { client: 'codex', id: 'work' } });
  assert.equal(remove.status, 200, remove.text);
  assert.equal(remove.json().expectedMtime, await configMtime(session.root));
  assert.notEqual(remove.json().expectedMtime, add.json().expectedMtime);
  assert.deepEqual(JSON.parse(await readFile(join(session.root, 'config.json'), 'utf8')).accounts.codex, []);
  assert.equal(await readFile(join(configDir, 'auth.json'), 'utf8'), 'PRIVATE-CREDENTIAL');
  assert.equal(await readFile(join(configDir, 'history.jsonl'), 'utf8'), 'history');
});

// | Corpus | Must pass | Must refuse |
// | account changes | supported client, unique label/folder | relative/duplicate folders, invalid/duplicate labels |
// | transport | authorized POST JSON | missing/wrong token, Host, Origin, method, type, malformed/oversize JSON |
test('account routes refuse invalid unknown inputs without changing config', async t => {
  const session = await fixture(t);
  const value = { client: 'codex', label: 'Work', configDir: join(session.root, 'work') };
  assert.equal((await request(session, '/api/account-add', { method: 'POST', value })).status, 200);
  const before = await readFile(join(session.root, 'config.json'), 'utf8');
  for (const patch of [{ configDir: 'relative' }, { configDir: null }, { configDir: {} },
    { label: '' }, { label: 'x'.repeat(41) }, { label: {} }, { label: 'a\nb' }, { label: 'Work' },
    { configDir: value.configDir }, { configDir: join(session.root, 'work', '..', 'work') },
    { configDir: join(session.root, '.codex') }, { client: 'opencode' }, { client: {} }]) {
    const result = await request(session, '/api/account-add', { method: 'POST', value: {
      ...value, label: 'Other', configDir: join(session.root, 'other'), ...patch } });
    assert.equal(result.status, 422, result.text);
    assert.ok(result.json().reason);
    assert.doesNotMatch(result.text, /stack|profiles|PRIVATE-CREDENTIAL/);
    assert.equal(await readFile(join(session.root, 'config.json'), 'utf8'), before);
  }
  for (const value of [{ client: 'codex', id: 'default' }, { client: 'codex', id: 'missing' },
    { client: 'codex', id: {} }, { client: 'opencode', id: 'work' }]) {
    assert.equal((await request(session, '/api/account-remove', { method: 'POST', value })).status, 422);
    assert.equal(await readFile(join(session.root, 'config.json'), 'utf8'), before);
  }
});

test('account removal rejects non-string ids with the exact reason and preserves config bytes', async t => {
  const session = await fixture(t);
  const configPath = join(session.root, 'config.json');
  await writeFile(configPath, '{ "future": true }\n');
  const before = await readFile(configPath);
  for (const id of [123, null, {}]) {
    const result = await request(session, '/api/account-remove', {
      method: 'POST', value: { client: 'codex', id } });
    assert.equal(result.status, 422, result.text);
    assert.deepEqual(result.json(), { reason: 'Invalid account id.' });
    assert.deepEqual(await readFile(configPath), before);
  }
});

test('account add redacts a sensitive accepted label just as account state does', async t => {
  const session = await fixture(t);
  const label = 'token=abc123';
  const added = await request(session, '/api/account-add', { method: 'POST',
    value: { client: 'codex', label, configDir: join(session.root, 'redacted-label') } });
  assert.equal(added.status, 200, added.text);
  assert.equal(added.json().account.label, '[Redacted]');
  const raw = JSON.parse(await readFile(join(session.root, 'config.json'), 'utf8'));
  assert.equal(raw.accounts.codex[0].label, label);
  const state = await request(session, '/api/state');
  assert.equal(state.status, 200, state.text);
  const account = state.json().accounts.find(account => account.client === 'codex'
    && account.id === added.json().account.id);
  assert.equal(account.label, '[Redacted]');
});

test('both account routes enforce authorization, method and JSON transport before writing', async t => {
  const session = await fixture(t);
  for (const route of ['/api/account-add', '/api/account-remove']) {
    const value = { client: 'codex', label: 'Work', configDir: join(session.root, 'work'), id: 'work' };
    for (const headers of [{ 'x-okit-token': null }, { 'x-okit-token': 'a'.repeat(64) },
      { host: 'attacker.invalid' }, { origin: 'http://attacker.invalid' }, { origin: null }]) {
      assert.equal((await request(session, route, { method: 'POST', value, headers })).status, 403);
    }
    assert.equal((await request(session, route, { method: 'PUT', value })).status, 405);
    assert.equal((await request(session, route, { method: 'POST', value,
      headers: { 'content-type': 'text/plain' } })).status, 415);
    for (const [raw, status] of [['{', 422], ['x'.repeat(65537), 413]]) {
      assert.equal((await request(session, route, { method: 'POST', raw,
        headers: { 'content-type': 'application/json' } })).status, status);
    }
  }
  assert.equal(await configMtime(session.root), null);
});

test('concurrent account adds serialize without losing either saved entry', async t => {
  const session = await fixture(t);
  const results = await Promise.all(['First', 'Second'].map(label => request(session, '/api/account-add', {
    method: 'POST', value: { client: 'codex', label, configDir: join(session.root, label) } })));
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  const raw = JSON.parse(await readFile(join(session.root, 'config.json'), 'utf8'));
  assert.deepEqual(raw.accounts.codex.map(account => account.label).sort(), ['First', 'Second']);
  assert.deepEqual(await readdir(join(session.root, 'locks')), []);
});

test('account state uses install folders, saved default commands and unknown login without credentials', async t => {
  const session = await fixture(t);
  const configDir = join(session.root, 'extra');
  const defaultDir = join(session.root, 'custom-default');
  await mkdir(defaultDir);
  await writeFile(join(defaultDir, 'auth.json'), 'PRIVATE-CREDENTIAL');
  await mkdir(configDir);
  await writeFile(join(configDir, 'config.toml'), 'cli_auth_credentials_store = "keyring"');
  await writeFile(join(session.root, 'config.json'), JSON.stringify({ install: { clients: { codex: { rootParts: ['custom-default'] } } },
    accounts: { codex: [{ id: 'work', label: 'Work', configDir }] } }));
  const response = await request(session, '/api/state');
  assert.equal(response.status, 200, response.text);
  const rows = response.json().accounts.filter(account => account.client === 'codex');
  assert.deepEqual(rows, [{ client: 'codex', id: 'default', label: 'default', configDir: null,
    login: 'logged-in', loginCommand: process.platform === 'win32'
      ? 'Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue; codex login' : 'env -u CODEX_HOME codex login' },
  { client: 'codex', id: 'work', label: 'Work', configDir, login: 'unknown', loginCommand: `CODEX_HOME=${configDir} codex login` }]);
  assert.doesNotMatch(response.text, /PRIVATE-CREDENTIAL/);
});

test('new account refusals use the exact shared CLI reasons in both locales', async t => {
  for (const locale of ['en', 'pt-BR']) {
    const session = await fixture(t, { locale });
    for (const client of ['claude-code', 'codex']) {
      const value = { client, label: 'Work', configDir: join(session.root, client) };
      const added = await request(session, '/api/account-add', { method: 'POST', value });
      assert.equal(added.status, 200, added.text);
      const raw = JSON.parse(await readFile(join(session.root, 'config.json'), 'utf8'));
      for (const patch of [{ configDir: 'relative' }, { label: '' }, { label: 'x'.repeat(41) },
        { label: 'Work' }, { configDir: value.configDir }, { client: 'unknown' }]) {
        const input = { ...value, label: 'Other', configDir: join(session.root, 'other'), ...patch };
        let reason;
        assert.throws(() => withAccountAdded(raw, input.client, input.label, input.configDir), error => {
          reason = localizeReason(error.message, locale); return true;
        });
        const refused = await request(session, '/api/account-add', { method: 'POST', value: input });
        assert.equal(refused.status, 422);
        assert.deepEqual(refused.json(), { reason });
      }
      for (const id of ['default', 'missing']) {
        let reason;
        assert.throws(() => withAccountRemoved(raw, client, id), error => {
          reason = localizeReason(error.message, locale); return true;
        });
        const refused = await request(session, '/api/account-remove', { method: 'POST', value: { client, id } });
        assert.equal(refused.status, 422);
        assert.deepEqual(refused.json(), { reason });
      }
    }
  }
});

test('same-length incorrect tokens must refuse every authenticated route', async t => {
  const session = await fixture(t);
  const wrong = (session.token[0] === 'a' ? 'b' : 'a') + session.token.slice(1);
  assert.equal((await request(session, `/?token=${wrong}`, {
    headers: { 'x-okit-token': null } })).status, 403);
  for (const [path, method] of [['/api/state', 'GET'], ['/api/config', 'PUT']]) {
    assert.equal((await request(session, path, { method, headers: { 'x-okit-token': wrong },
      ...(method === 'PUT' ? { value: { expectedMtime: null, changes: [] } } : {}) })).status, 403);
  }
});

test('internal failures return a fixed reason without filesystem paths', async t => {
  const session = await fixture(t, { observe: async () => { throw new Error('Cannot write /private/root/config.json'); } });
  const result = await request(session, '/api/state');
  assert.equal(result.status, 500);
  assert.deepEqual(result.json(), { reason: 'Request failed.' });
  assert.doesNotMatch(result.text, /private|config\.json/);
});

test('loopback and authorization must-pass / must-refuse pairs', async (t) => {
  const session = await fixture(t);
  assert.equal(session.server.address().address, '127.0.0.1');
  const pass = await request(session, '/api/state');
  assert.equal(pass.status, 200);
  for (const headers of [{ 'x-okit-token': null }, { 'x-okit-token': 'wrong' },
    { host: 'evil.invalid' }, { origin: 'http://evil.invalid' }, { origin: null, 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await request(session, '/api/state', { headers })).status, 403);
  }
  for (const site of [null, 'same-origin', 'none']) {
    assert.equal((await request(session, '/api/state', { headers: { origin: null, 'sec-fetch-site': site } })).status, 200);
  }
  assert.equal((await request(session, '/api/config', { method: 'PUT', headers: { origin: null }, value: {} })).status, 403);
  for (const host of [`localhost:${session.port}`, `127.0.0.1:${session.port}`]) {
    assert.equal((await request(session, '/api/state', { headers: { host, origin: `http://${host}` } })).status, 200);
  }
  assert.equal((await request(session, `/?token=${session.token}`, { headers: { origin: null, 'x-okit-token': null } })).status, 200);
  assert.equal((await request(session, '/?token=wrong', { headers: { origin: null, 'x-okit-token': null } })).status, 403);
  assert.equal((await request(session, `/api/state?token=${session.token}`, { headers: { 'x-okit-token': null } })).status, 403);
  assert.equal(pass.headers['access-control-allow-origin'], undefined);
  assert.equal(pass.headers['set-cookie'], undefined);
  const page = await request(session, '/');
  assert.match(page.headers['content-security-policy'], /default-src 'none'; script-src 'nonce-/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.equal(page.headers['cache-control'], 'no-store');
});

test('chunked bodies over 64 KiB receive 413 and leave the server usable', async t => {
  const session = await fixture(t);
  const bytes = '{"future":true}\n';
  await writeFile(join(session.root, 'config.json'), bytes);
  const result = await new Promise((resolve, reject) => {
    let status, connection;
    const req = http.request({ host: '127.0.0.1', port: session.port, path: '/api/config', method: 'PUT',
      headers: { origin: session.origin, 'x-okit-token': session.token,
        'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, res => {
      status = res.statusCode; connection = res.headers.connection;
      res.resume();
      res.on('end', () => resolve({ status, connection }));
      res.on('error', error => status === 413 ? resolve({ status, connection }) : reject(error));
    });
    req.setTimeout(3000, () => req.destroy(new Error('No chunked response')));
    req.on('error', error => status === 413 ? resolve({ status, connection }) : reject(error));
    for (let index = 0; index < 7; index++) req.write(' '.repeat(10 * 1024));
    req.end();
  });
  assert.equal(result.status, 413);
  assert.equal(result.connection, 'close');
  assert.equal(await readFile(join(session.root, 'config.json'), 'utf8'), bytes);
  assert.equal((await request(session, '/api/state')).status, 200);
});

test('route, method, media type and body size must-pass / must-refuse pairs', async (t) => {
  const session = await fixture(t);
  assert.equal((await request(session, '/unknown')).status, 404);
  assert.equal((await request(session, '/api/state', { method: 'POST' })).status, 405);
  assert.equal((await request(session, '/api/config', { method: 'PUT', raw: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await request(session, '/api/config', { method: 'PUT', value: { changes: [], extra: 'x'.repeat(65536) } })).status, 413);
  const missing = await request(session, '/api/config', { method: 'PUT', value: { changes: [] } });
  assert.equal(missing.status, 422);
  assert.equal(missing.json().reason, 'expectedMtime is required.');
  for (const expectedMtime of ['0', false, {}]) {
    assert.equal((await request(session, '/api/config', { method: 'PUT', value: { changes: [], expectedMtime } })).status, 422);
  }
  assert.equal((await request(session, '/api/config', { method: 'PUT', value: { changes: [], expectedMtime: null } })).status, 200);
});

test('actor writes match config_set bytes, preserve unknown keys and create only config.json', async (t) => {
  const session = await fixture(t);
  const other = await mkdtemp(join(tmpdir(), 'okit-config-reference-'));
  t.after(() => rm(other, { recursive: true, force: true }));
  const raw = { future: { untouched: [1, 'yes'] } };
  const bytes = JSON.stringify(raw);
  await writeFile(join(session.root, 'config.json'), bytes);
  await writeFile(join(other, 'config.json'), bytes);
  const before = await filesOnly(session.root);
  assert.equal((await request(session, '/api/state')).status, 200);
  assert.deepEqual(await filesOnly(session.root), before);
  const result = await request(session, '/api/config', { method: 'PUT', value: { expectedMtime: await configMtime(session.root), changes: [
    { path: 'profiles.codex.simple.model', value: 'test-model' }] } });
  assert.equal(result.status, 200, result.text);
  await configSet(other, { key: 'profiles.codex.simple.model', value: 'test-model' });
  assert.deepEqual(await readFile(join(session.root, 'config.json')), await readFile(join(other, 'config.json')));
  assert.deepEqual(JSON.parse(await readFile(join(session.root, 'config.json'), 'utf8')).future, raw.future);
  assert.equal(result.json().changes[0].after, 'test-model');
  assert.deepEqual(await filesOnly(session.root), before);
});

test('empty HOME remains empty until a save and real read-only observations work', async (t) => {
  const session = await fixture(t, { observe: undefined });
  assert.deepEqual(await readdir(session.root), []);
  assert.equal((await request(session, '/api/state')).status, 200);
  assert.deepEqual(await readdir(session.root), []);
});

test('invalid changes use config_set reasons and leave the whole batch byte-identical', async (t) => {
  const session = await fixture(t);
  await writeFile(join(session.root, 'config.json'), '{"future":true}\n');
  const before = await readFile(join(session.root, 'config.json'));
  for (const [path, value] of [['profiles.codex.simple.model', ''], ['profiles.codex.simple.effort', 'extreme'],
    ['profiles.codex.simple.maxTurns', 0], ['language', 'invalid'], ['lowQuotaPct', 101], ['limits.global', 0]]) {
    let reason;
    try { await configSet(session.root, { key: path, value: String(value) }); }
    catch (error) { reason = error.message; }
    assert.ok(reason, path);
    const result = await request(session, '/api/config', { method: 'PUT', value: { expectedMtime: await configMtime(session.root), changes: [
      { path: 'language', value: 'en' }, { path, value }] } });
    assert.equal(result.status, 422, path);
    assert.equal(result.json().reason, reason);
    assert.deepEqual(await readFile(join(session.root, 'config.json')), before);
  }
});

test('each unconfirmed model needs its own confirmation before any batch write', async t => {
  const session = await fixture(t);
  const bytes = '{"future":true}\n';
  await writeFile(join(session.root, 'config.json'), bytes);
  const changes = [{ path: 'profiles.codex.simple.model', value: 'new-simple', confirm: true },
    { path: 'profiles.codex.hard.model', value: 'new-hard' }];
  const mtime = await configMtime(session.root);
  const send = () => request(session, '/api/config', { method: 'PUT', value: { expectedMtime: mtime, changes } });
  const refused = await send();
  assert.equal(refused.status, 422);
  assert.match(refused.json().reason, /not confirmed/);
  assert.equal(await readFile(join(session.root, 'config.json'), 'utf8'), bytes);
  changes[1].confirm = true;
  assert.equal((await send()).status, 200);
  const saved = JSON.parse(await readFile(join(session.root, 'config.json'), 'utf8'));
  assert.equal(saved.profiles.codex.simple.model, 'new-simple');
  assert.equal(saved.profiles.codex.hard.model, 'new-hard');
});

test('mtime must-pass / must-refuse and unconfirmed model confirmation', async (t) => {
  const session = await fixture(t);
  const state = (await request(session, '/api/state')).json();
  const changes = [{ path: 'profiles.codex.simple.model', value: 'unconfirmed' }];
  const unconfirmed = await request(session, '/api/config', { method: 'PUT', value: { changes, expectedMtime: state.expectedMtime } });
  assert.equal(unconfirmed.status, 422);
  assert.match(unconfirmed.json().reason, /not confirmed/);
  changes[0].confirm = true;
  assert.equal((await request(session, '/api/config', { method: 'PUT', value: { changes, expectedMtime: state.expectedMtime } })).status, 200);
  assert.equal(JSON.parse(await readFile(join(session.root, 'config.json'), 'utf8')).profiles.codex.simple.model, 'unconfirmed');
  const mtime = -1; // Always stale, independent of filesystem timestamp resolution.
  await writeFile(join(session.root, 'config.json'), '{"external":true}\n');
  const before = await readFile(join(session.root, 'config.json'));
  const conflict = await request(session, '/api/config', { method: 'PUT', value: { changes, expectedMtime: mtime } });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await readFile(join(session.root, 'config.json')), before);
});

test('account rename must-pass / must-refuse preserves ids and folders', async (t) => {
  const session = await fixture(t);
  const raw = { future: { keep: true }, accounts: { codex: [
    { id: 'work', label: 'Work', configDir: join(session.root, 'client') }] } };
  await writeFile(join(session.root, 'config.json'), JSON.stringify(raw));
  const rename = (id, label) => request(session, '/api/account-label', { method: 'PUT', value: { client: 'codex', id, label } });
  const before = await readFile(join(session.root, 'config.json'));
  for (const [id, label] of [['work', ''], ['work', 'x'.repeat(41)], ['work', 'bad\nlabel'], ['work', 'default'], ['unknown', 'Good']]) {
    let reason;
    try { withAccountRenamed(raw, 'codex', id, label, { env: { HOME: session.root } }); }
    catch (error) { reason = error.message; }
    const result = await rename(id, label);
    assert.equal(result.status, 422);
    assert.equal(result.json().reason, reason);
    assert.deepEqual(await readFile(join(session.root, 'config.json')), before);
  }
  assert.equal((await rename('work', 'Office')).status, 200);
  const saved = JSON.parse(await readFile(join(session.root, 'config.json'), 'utf8'));
  assert.deepEqual(saved, { ...raw, accounts: { codex: [{ ...raw.accounts.codex[0], label: 'Office' }] } });
  assert.deepEqual(saved.accounts.codex[0], { id: 'work', label: 'Office', configDir: join(session.root, 'client') });
  assert.deepEqual(await filesOnly(session.root), ['config.json']);
  for (const value of [{ client: 'opencode', id: 'work', label: 'Good' }, { client: 'codex', id: 'work', label: 3 }]) {
    assert.equal((await request(session, '/api/account-label', { method: 'PUT', value })).status, 422);
  }
});

test('credentials and wrong JSON types cannot be saved', async (t) => {
  const session = await fixture(t);
  for (const change of [{ path: 'profiles.codex.simple.model', value: 'sk-hidden123', confirm: true },
    { path: 'telemetry.rede.cabecalhos', value: { Authorization: 'Bearer secret' } },
    { path: 'telemetry.rede.cabecalhos', value: { token: 'hidden' } },
    { path: 'telemetry.enabled', value: 'true' }, { path: 'todo.file', value: {} },
    { path: '__proto__.polluted', value: true }]) {
    assert.equal((await request(session, '/api/config', { method: 'PUT', value: { changes: [change], expectedMtime: null } })).status, 422);
  }
  assert.deepEqual(await filesOnly(session.root), []);
  assert.equal((await request(session, '/api/config', { method: 'PUT', value: { changes: [
    { path: 'telemetry.enabled', value: true }], expectedMtime: null } })).status, 200);
});

test('slow model detection does not hold the configuration lock', async t => {
  let started, release;
  const entered = new Promise(resolve => { started = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const session = await fixture(t, { detect: async ({ onlyClient }) => {
    started(); await waiting;
    return { clients: [{ client: onlyClient, installed: true, source: 'listing', models: ['test-model'] }] };
  } });
  const pending = request(session, '/api/config', { method: 'PUT', value: { expectedMtime: null,
    changes: [{ path: 'profiles.codex.simple.model', value: 'test-model' }] } });
  await entered;
  let timer;
  try {
    await Promise.race([configSet(session.root, { key: 'language', value: 'pt-BR' }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Detection held config lock')), 1000); })]);
  } finally { clearTimeout(timer); release(); }
  assert.equal((await pending).status, 409);
});

test('model refresh failure and timeout return saved values with reasons', async (t) => {
  for (const detect of [async () => { throw new Error('failed'); }, () => new Promise(() => {})]) {
    const session = await fixture(t, { detect, modelTimeoutMs: 20 });
    const result = await request(session, '/api/models/refresh', { method: 'POST', value: { client: 'codex' } });
    assert.equal(result.status, 200);
    assert.ok(result.json()[0].reason);
    const state = (await request(session, '/api/state')).json();
    assert.ok(state.actors.find((actor) => actor.client === 'codex').classes[0].model);
    assert.equal((await request(session, '/api/models/refresh', { method: 'POST', value: { client: '../elsewhere' } })).status, 422);
  }
});

async function assertClosed(session) {
  await session.closed;
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = net.connect(session.port, '127.0.0.1');
    socket.on('error', reject);
    socket.on('connect', () => { socket.destroy(); resolve(); });
  }), { code: 'ECONNREFUSED' });
}

test('explicit close, SIGINT and idle timeout remove the listener', async (t) => {
  const session = await fixture(t);
  assert.equal((await request(session, '/api/close', { method: 'POST', value: {} })).status, 200);
  await assertClosed(session);
  const signals = new EventEmitter();
  const interrupted = await fixture(t, { signals });
  signals.emit('SIGINT');
  await assertClosed(interrupted);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  const explicit = await fixture(t);
  await explicit.close();
  await assertClosed(explicit);
  const idle = await fixture(t, { idleMs: 50 });
  await assertClosed(idle);
});

test('model refresh uses injected detection and redacts results', async (t) => {
  const calls = [];
  const session = await fixture(t, { detect: async (options) => {
    calls.push(options);
    return { clients: [{ client: options.onlyClient, installed: true, models: ['test-model'], token: 'hidden' }] };
  } });
  const result = await request(session, '/api/models/refresh', { method: 'POST', value: { client: 'codex' } });
  assert.equal(result.status, 200);
  assert.equal(calls[0].onlyClient, 'codex');
  assert.deepEqual(result.json()[0].models, ['test-model']);
  assert.equal(result.json()[0].token, '[Redacted]');
  assert.doesNotMatch(result.text, /hidden/);
});

test('200, 403, 404 and 422 responses have no CORS or cookie headers', async (t) => {
  const session = await fixture(t);
  for (const [path, options, status] of [['/api/state', {}, 200],
    ['/api/state', { headers: { 'x-okit-token': null } }, 403], ['/missing', {}, 404],
    ['/api/config', { method: 'PUT', value: {} }, 422]]) {
    const result = await request(session, path, options);
    assert.equal(result.status, status);
    assert.deepEqual(Object.keys(result.headers).filter((key) => key.startsWith('access-control-') || key === 'set-cookie'), []);
  }
});

test('GET page requires token and serves nonce-bound scripts and localized HTML', async t => {
  const session = await fixture(t);
  const page = await request(session, `/?token=${session.token}&locale=pt-BR`, { headers: { 'x-okit-token': null, origin: null } });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  const nonce = page.headers['content-security-policy'].match(/'nonce-([^']+)'/)[1];
  const scripts = [...page.text.matchAll(/<script\b([^>]*)>/g)];
  assert.equal(scripts.length, 2);
  for (const script of scripts) assert.ok(script[1].includes(`nonce="${nonce}"`));
  assert.match(page.text, /lang="pt-BR"/);
  const next = await request(session, `/?token=${session.token}`);
  const nextNonce = next.headers['content-security-policy'].match(/'nonce-([^']+)'/)[1];
  assert.notEqual(nextNonce, nonce);
  for (const script of next.text.matchAll(/<script\b([^>]*)>/g)) {
    assert.ok(script[1].includes(`nonce="${nextNonce}"`));
  }
  assert.equal((await request(session, '/', { headers: { 'x-okit-token': null } })).status, 403);
});

async function pageInstance(session) {
  const page = await request(session, '/');
  const state = JSON.parse(page.text.match(/<script[^>]*id="state"[^>]*>(.*?)<\/script>/s)[1]);
  assert.match(state.instance, /^[a-f0-9]{24}$/);
  return state.instance;
}

test('reload and a newer tab ignore late grace from the previous page', async t => {
  const session = await fixture(t, { closeGraceMs: 150 });
  const previous = await pageInstance(session);
  const instance = await pageInstance(session);
  assert.notEqual(instance, previous);
  assert.deepEqual((await request(session, '/api/keepalive', { method: 'POST', value: { instance } })).json(), { ok: true });
  for (const stale of [previous, undefined]) {
    const result = await request(session, '/api/close', { method: 'POST', value: { grace: true, instance: stale } });
    assert.deepEqual(result.json(), { closed: false });
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal((await request(session, '/api/state')).status, 200);
  }
});

test('active grace expires and invalid keepalives cannot cancel it', async t => {
  for (const value of [null, { instance: 'wrong' }, {}, { instance: 42 }, 'wrong']) {
    const session = await fixture(t, { closeGraceMs: 150 });
    const instance = await pageInstance(session);
    const close = await request(session, '/api/close', { method: 'POST', value: { grace: true, instance } });
    assert.deepEqual(close.json(), { closed: true });
    assert.equal(session.server.listening, true);
    if (value !== null) {
      const result = await request(session, '/api/keepalive', { method: 'POST', value });
      assert.equal(result.status, 200);
      assert.deepEqual(result.json(), { ok: false });
    }
    const denied = await request(session, '/api/keepalive', {
      method: 'POST', value: { instance }, headers: { 'x-okit-token': null } });
    assert.equal(denied.status, 403);
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(session.server.listening, false);
    await assertClosed(session);
  }
});

test('keepalive shares POST authorization, body and method rules', async t => {
  const session = await fixture(t);
  const instance = await pageInstance(session);
  for (const headers of [{ host: 'example.com' }, { origin: 'http://example.com' }]) {
    assert.equal((await request(session, '/api/keepalive', {
      method: 'POST', value: { instance }, headers })).status, 403);
  }
  assert.equal((await request(session, '/api/keepalive')).status, 405);
  assert.equal((await request(session, '/api/keepalive', { method: 'POST', raw: '{}' })).status, 415);
  assert.equal((await request(session, '/api/keepalive', {
    method: 'POST', raw: '{', headers: { 'content-type': 'application/json' } })).status, 422);
  assert.equal((await request(session, '/api/keepalive', {
    method: 'POST', value: { instance, padding: 'x'.repeat(65536) } })).status, 413);
});

test('active keepalive cancels pending grace', async t => {
  const session = await fixture(t, { closeGraceMs: 150 });
  const instance = await pageInstance(session);
  await request(session, '/api/close', { method: 'POST', value: { grace: true, instance } });
  const result = await request(session, '/api/keepalive', { method: 'POST', value: { instance } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json(), { ok: true });
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal((await request(session, '/api/state')).status, 200);
});

test('authorized reload cancels pending grace', async t => {
  const session = await fixture(t, { closeGraceMs: 150 });
  const instance = await pageInstance(session);
  await request(session, '/api/close', { method: 'POST', value: { grace: true, instance } });
  await pageInstance(session);
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal((await request(session, '/api/state')).status, 200);
});

test('unset uses CLI bytes, default unset is a no-op, and unset then model set is ordered', async t => {
  const session = await fixture(t);
  const other = await mkdtemp(join(tmpdir(), 'okit-unset-reference-'));
  t.after(() => rm(other, { recursive: true, force: true }));
  const bytes = JSON.stringify({ profiles: { codex: { simple: null } }, future: true });
  await writeFile(join(session.root, 'config.json'), bytes);
  await writeFile(join(other, 'config.json'), bytes);
  const put = async changes => request(session, '/api/config', { method: 'PUT', value: {
    expectedMtime: await configMtime(session.root), changes } });
  assert.equal((await put([{ path: 'profiles.codex.simple', unset: true }])).status, 200);
  await configSet(other, { key: 'profiles.codex.simple' });
  assert.deepEqual(await readFile(join(session.root, 'config.json')), await readFile(join(other, 'config.json')));
  const mtime = await configMtime(session.root);
  const unchanged = await readFile(join(session.root, 'config.json'));
  assert.equal((await put([{ path: 'profiles.codex.simple', unset: true }])).status, 200);
  assert.equal(await configMtime(session.root), mtime);
  assert.deepEqual(await readFile(join(session.root, 'config.json')), unchanged);
  assert.equal((await put([{ path: 'profiles.codex.simple.model', unset: true },
    { path: 'profiles.codex.simple.model', value: 'test-model' }])).status, 200);
  assert.equal(JSON.parse(await readFile(join(session.root, 'config.json'), 'utf8')).profiles.codex.simple.model, 'test-model');
  const before = await readFile(join(session.root, 'config.json'));
  for (const change of [{ path: 'language', value: 'en', unset: true }, { path: 'unknown', unset: true }]) {
    assert.equal((await put([change])).status, 422);
    assert.deepEqual(await readFile(join(session.root, 'config.json')), before);
  }
  assert.deepEqual(await filesOnly(session.root), ['config.json']);
});

test('twenty parallel HTTP writers keep valid state', async t => {
  const session = await fixture(t);
  const values = Array.from({ length: 20 }, (_, index) => index + 1);
  const results = await Promise.all(values.map(value => request(session, '/api/config', {
    method: 'PUT', value: { expectedMtime: null, changes: [{ path: 'limits.global', value }] } })));
  assert.ok(results.some(result => result.status === 200));
  for (const result of results) {
    assert.ok([200, 409].includes(result.status), result.text);
    assert.doesNotMatch(result.text, /ENOENT/);
  }
  assert.ok(values.includes(JSON.parse(await readFile(join(session.root, 'config.json'), 'utf8')).limits.global));
  assert.deepEqual(await filesOnly(session.root), ['config.json']);
  assert.deepEqual(await readdir(join(session.root, 'locks')), []);
});

test('twenty parallel configSet writers keep valid state and retain the locks directory', async t => {
  const values = Array.from({ length: 20 }, (_, index) => index + 1);
  const root = await mkdtemp(join(tmpdir(), 'okit-parallel-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(values.map(value => configSet(root, { key: 'limits.global', value: String(value) })));
  assert.ok(values.includes(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')).limits.global));
  assert.deepEqual(await filesOnly(root), ['config.json']);
  assert.deepEqual(await readdir(join(root, 'locks')), []);
});

test('empty batches and already-default unsets preserve bytes and mtime', async t => {
  const session = await fixture(t);
  const path = join(session.root, 'config.json');
  const bytes = '{  "future": true  }\n';
  await writeFile(path, bytes);
  const mtime = await configMtime(session.root);
  for (const changes of [[], [{ path: 'language', unset: true }]]) {
    const result = await request(session, '/api/config', { method: 'PUT', value: { expectedMtime: mtime, changes } });
    assert.equal(result.status, 200);
    if (!changes.length) assert.deepEqual(result.json(), { changes: [] });
    assert.equal(await readFile(path, 'utf8'), bytes);
    assert.equal(await configMtime(session.root), mtime);
    await configSetMany(session.root, changes);
    assert.equal(await readFile(path, 'utf8'), bytes);
    assert.equal(await configMtime(session.root), mtime);
  }
});

test('configSetMany empty batches preserve existing bytes and absent files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'okit-noop-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual((await configSetMany(root, [])).changes, []);
  assert.equal(await configMtime(root), null);
  const bytes = '{  "future": true  }\n';
  await writeFile(join(root, 'config.json'), bytes);
  const mtime = await configMtime(root);
  for (const changes of [[], [{ path: 'language', unset: true }]]) {
    await configSetMany(root, changes);
    assert.equal(await readFile(join(root, 'config.json'), 'utf8'), bytes);
    assert.equal(await configMtime(root), mtime);
  }
});

test('batch unset matches CLI for every schema entry, aliases, defaults and ordered writes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'okit-batch-unset-'));
  const other = await mkdtemp(join(tmpdir(), 'okit-cli-unset-'));
  t.after(() => Promise.all([root, other].map(path => rm(path, { recursive: true, force: true }))));
  const bytes = JSON.stringify({ profiles: { codex: { simple: null, normal: { model: 'custom' } } },
    limits: { perClient: 2 }, future: { keep: true } });
  for (const entry of schemaEntries({})) {
    await writeFile(join(root, 'config.json'), bytes);
    await writeFile(join(other, 'config.json'), bytes);
    await configSetMany(root, [{ path: entry.path, unset: true }]);
    await configSet(other, { key: entry.path });
    // Already-default unset deliberately preserves bytes instead of rewriting whitespace.
    assert.deepEqual(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')),
      JSON.parse(await readFile(join(other, 'config.json'), 'utf8')), entry.path);
    if (['limits.global', 'profiles.codex.simple', 'profiles.codex.normal.model'].includes(entry.path)) {
      assert.deepEqual(await readFile(join(root, 'config.json')), await readFile(join(other, 'config.json')), entry.path);
    }
  }
  await configSet(root, { key: 'profiles.codex.simple', value: 'null' });
  await writeFile(join(other, 'config.json'), await readFile(join(root, 'config.json')));
  await configSetMany(root, [{ path: 'profiles.codex.simple', unset: true },
    { path: 'profiles.codex.simple.model', value: 'new' }]);
  await configSet(other, { key: 'profiles.codex.simple' });
  await configSet(other, { key: 'profiles.codex.simple.model', value: 'new' });
  assert.deepEqual(await readFile(join(root, 'config.json')), await readFile(join(other, 'config.json')));
  const mtime = await configMtime(root);
  await configSetMany(root, [{ path: 'language', unset: true }]);
  assert.equal(await configMtime(root), mtime);
  const before = await readFile(join(root, 'config.json'));
  await assert.rejects(configSetMany(root, [{ path: 'language', unset: true, value: 'en' }]));
  await assert.rejects(configSetMany(root, [{ path: 'profiles.codex.simple', unset: true }, { path: 'unknown', unset: true }]));
  assert.deepEqual(await readFile(join(root, 'config.json')), before);
  assert.deepEqual(await filesOnly(root), ['config.json']);
});
