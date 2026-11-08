import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { fixture } from './helpers/install-fixture.js';
import { changeAccount } from '../src/accounts-cli.js';
import { ensureCollector, collectorState } from '../src/quota/collector-registration.js';
import { describeAccount, buildState } from '../src/config-ui/state.js';
import { renderPage } from '../src/config-ui/page.js';
import { startConfigServer } from '../src/config-ui/server.js';
import { panelState } from '../src/panel-state.js';
import { viewModel } from '../adapters/claude-code/panel/panel.js';

// | Corpus | Must pass | Must refuse |
// | command | executable collector with valid arguments | echo mentions, invalid collector arguments |
// | account | extra Claude settings only | credentials, default changes, Codex collector |
async function world(t) {
  const f = await fixture(t);
  Object.assign(f.io.env, { CLAUDE_CONFIG_DIR: join(f.home, 'override'), CODEX_HOME: join(f.home, 'codex'), OKWORK_HOME: f.root });
  const raw = JSON.parse(await fs.readFile(join(f.root, 'config.json'), 'utf8'));
  raw.quotaPoll = { enabled: false };
  raw.accounts = { 'claude-code': [{ id: 'extra', label: 'Extra', configDir: join(f.home, 'extra') }] };
  await fs.writeFile(join(f.root, 'config.json'), JSON.stringify(raw));
  const guard = { ...fs, readFile: (file, ...args) => {
    assert.ok(!/(?:\.credentials|auth)\.json$/.test(String(file)), `credential read: ${file}`);
    return fs.readFile(file, ...args);
  } };
  f.io.fs = guard;
  return { ...f, raw, account: { ...raw.accounts['claude-code'][0], client: 'claude-code', isDefault: false },
    ctx: { ...f.io, fs: guard, out: f.io.out, locale: 'en', now: () => Date.now() } };
}
const command = async account => JSON.parse(await fs.readFile(join(account.configDir, 'settings.json'), 'utf8')).statusLine.command;

test('CLI add registers without a manual install and reports the state', async t => {
  const f = await world(t), folder = join(f.home, 'cli');
  assert.equal(await main(['account', 'add', 'claude-code', 'CLI', '--config-dir', folder], f.io), 0);
  assert.match(await command({ configDir: folder }), /statusline-collector/);
  assert.match(f.output.join('\n'), /Registered.*Waiting for first reading/);
});
test('install registers every saved account without statusline flag', async t => {
  const f = await world(t);
  assert.equal(await main(['install', '--client', 'claude-code'], f.io), 0, f.output.join('\n'));
  assert.match(await command(f.account), /statusline-collector/);
});
test('install --no-statusline leaves saved accounts unregistered; a default account is never registered', async t => {
  const f = await world(t);
  assert.equal(await main(['install', '--client', 'claude-code', '--no-statusline'], f.io), 0, f.output.join('\n'));
  await assert.rejects(fs.stat(join(f.account.configDir, 'settings.json')), { code: 'ENOENT' });
  const folder = join(f.home, 'default-folder');
  await ensureCollector(f.ctx, f.raw, { id: 'default', client: 'claude-code', label: 'default', configDir: folder, isDefault: true });
  await assert.rejects(fs.stat(join(folder, 'settings.json')), { code: 'ENOENT' });
});
test('update repairs a saved account absent from installation registrations', async t => {
  const f = await world(t);
  assert.equal(await main(['install', '--client', 'claude-code'], f.io), 0);
  await fs.rm(join(f.account.configDir, 'settings.json'));
  assert.equal(await main(['update', '--client', 'claude-code'], f.io), 0, f.output.join('\n'));
  assert.match(await command(f.account), /statusline-collector/);
});
test('doctor --fix repairs a missing collector, default remains untouched', async t => {
  const f = await world(t);
  await main(['doctor', '--fix', '--client', 'claude-code'], f.io);
  assert.match(await command(f.account), /statusline-collector/);
  assert.ok(!f.output.some(line => /Unknown flag: --fix/.test(line)));
  await assert.rejects(fs.stat(join(f.home, '.claude', 'settings.json')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(join(f.io.env.CLAUDE_CONFIG_DIR, 'settings.json')), { code: 'ENOENT' });
});

test('foreign command and settings are preserved with an exact backup; repeat is idempotent', async t => {
  const f = await world(t), original = '{"theme":"dark","statusLine":{"type":"command","command":"foreign-bar --color | cat"}}\n';
  await fs.mkdir(f.account.configDir);
  await fs.writeFile(join(f.account.configDir, 'settings.json'), original);
  await ensureCollector(f.ctx, f.raw, f.account);
  assert.match(await command(f.account), /--previous.*foreign-bar --color \| cat/);
  assert.equal(JSON.parse(await fs.readFile(join(f.account.configDir, 'settings.json'))).theme, 'dark');
  assert.equal(await fs.readFile(join(f.root, 'claude-statusline.original.extra'), 'utf8'), original);
  const before = await command(f.account);
  await ensureCollector(f.ctx, f.raw, f.account);
  assert.equal(await command(f.account), before);
  assert.equal(await fs.readFile(join(f.root, 'claude-statusline.original.extra'), 'utf8'), original);
});
test('Codex add does not create a collector; registration failure never fails a shared add', async t => {
  const f = await world(t), folder = join(f.home, 'codex-extra');
  const next = await changeAccount(f.ctx, 'add', { client: 'codex', name: 'Second', directory: folder });
  await assert.rejects(fs.stat(join(folder, 'settings.json')), { code: 'ENOENT' });
  assert.equal((await collectorState(f.ctx, next, { client: 'codex' })).state, 'not-needed');
  const failing = { ...f.ctx, fs: { ...f.ctx.fs, rename: async () => { throw Object.assign(new Error('secret contents'), { code: 'EACCES' }); } } };
  const added = await changeAccount(failing, 'add', { client: 'claude-code', name: 'Broken', directory: join(f.home, 'broken') });
  const account = { ...added.accounts['claude-code'].at(-1), client: 'claude-code' };
  const state = await describeAccount(account, added, failing);
  assert.equal(state.collector.state, 'not registered');
  assert.match(state.collector.reason, /permissions/);
  assert.ok(!JSON.stringify(state).includes('secret contents'));
});

test('web add registers through the shared mutation and returns collector state', async t => {
  const f = await world(t);
  let server;
  try {
    server = await startConfigServer({ root: f.root, env: f.io.env,
      detect: async () => ({ clients: [] }), observe: async () => ({ clients: [] }) });
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    t.skip(`not run in sandbox: ${error.message}`); return;
  }
  t.after(() => server.close());
  const result = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.port, path: '/api/account-add', method: 'POST',
      headers: { origin: `http://127.0.0.1:${server.port}`, 'x-okit-token': server.token, 'content-type': 'application/json' } }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ client: 'claude-code', label: 'Web', configDir: join(f.home, 'web') }));
  });
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.account.collector.state, 'registered');
  assert.match(await command(result.value.account), /statusline-collector/);
});

test('four states reach web and panel in both locales, without credentials or active-reading confusion', async t => {
  const f = await world(t);
  const expected = { en: ['Not registered', 'Registered', 'Waiting for first reading', 'Reading received'],
    'pt-BR': ['Não registrado', 'Registrado', 'Aguardando primeira leitura', 'Leitura recebida'] }; // locale:pt-BR
  for (const locale of ['en', 'pt-BR']) {
    const ctx = { ...f.ctx, locale };
    await fs.mkdir(f.account.configDir, { recursive: true });
    for (const invalid of ['echo okit-plugin statusline-collector', 'okit-plugin statusline-collector --invalid']) {
      await fs.writeFile(join(f.account.configDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: invalid } }));
      assert.equal((await collectorState(ctx, f.raw, f.account)).text, expected[locale][0]);
    }
    await ensureCollector(ctx, f.raw, f.account);
    await fs.rm(join(f.root, 'quota', 'claude-code-statusline.extra.json'), { force: true });
    await fs.writeFile(join(f.root, 'quota', 'claude-code.extra.json'), '{}');
    for (const received of [false, true]) {
      if (received) await fs.writeFile(join(f.root, 'quota', 'claude-code-statusline.extra.json'), '{}');
      const row = await describeAccount(f.account, f.raw, ctx);
      assert.equal(row.collector.text, expected[locale][1]);
      assert.equal(row.collector.detail, expected[locale][received ? 3 : 2]);
      const web = buildState({ raw: f.raw, accountStates: [row], locale });
      assert.deepEqual(web.accounts.find(a => a.id === 'extra').collector, row.collector);
      const html = renderPage(web, { locale, nonce: 'test', token: 'test' }).split('<script')[0];
      assert.ok(html.includes(`data-account-collector>${row.collector.text}: ${row.collector.detail}</p>`));
      const panel = await panelState(ctx, 'claude');
      assert.deepEqual(panel.accounts.find(a => a.id === 'extra').collector, row.collector);
      const rendered = viewModel({ ok: true, state: panel }, ctx.now());
      assert.ok(rendered[1].rows.some(line => line.includes(row.collector.detail)));
    }
  }
});
