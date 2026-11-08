import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { startConfigServer } from '../src/config-ui/server.js';
import { closeConfigSession } from '../src/config-ui/session.js';
import { callTool } from './helpers/tools.js';
import { createServer } from '../src/mcp/server.js';

test('concurrent opens share one session and open false never calls the browser', async t => {
  const root = 'd138-injected-session';
  let finish, starts = 0, opens = 0;
  const closed = new Promise(resolve => { finish = resolve; });
  t.after(() => closeConfigSession(root));
  const ctx = { root, config: { language: 'pt-BR' },
    openConfigBrowser: () => { opens++; }, startConfigServer: async options => {
      starts++;
      assert.equal(options.background, true);
      assert.equal(options.locale, 'pt-BR');
      return { url: 'http://127.0.0.1:1234/?token=test-only', closed,
        close: () => { finish(); return closed; } };
    } };
  const replies = await Promise.all([1, 2].map(() => callTool('config_ui_open', { open: false }, ctx)));
  assert.equal(starts, 1);
  assert.equal(opens, 0);
  assert.deepEqual(replies.map(reply => reply.reused), [false, true]);
  assert.equal(new URL(replies[0].url).searchParams.get('locale'), 'pt-BR');
  await callTool('config_ui_open', { locale: 'en' }, ctx);
  assert.equal(opens, 1);
  const mcp = createServer({ ctx, input: new PassThrough(), output: new PassThrough() });
  await mcp.stop();
  await closed;
});

// | Input | Must pass | Must refuse |
// | options | open booleans, supported locale | unknown key, wrong type, unsupported locale |
test('config_ui_open refuses invalid input before opening a listener', async () => {
  for (const args of [{ open: 'false' }, { locale: 'fr' }, { extra: true }, []]) {
    await assert.rejects(callTool('config_ui_open', args, { root: '.', config: {} }));
  }
});

test('a background config server does not keep its owning process alive', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import { startConfigServer } from './src/config-ui/server.js'; await startConfigServer({ root: '.', background: true });"],
  { encoding: 'utf8', timeout: 3000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('config_ui_open serves a protected page, reuses it, and stops with the MCP session', async t => {
  const root = await mkdtemp(join(tmpdir(), 'okit-open-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => closeConfigSession(root));
  let session, launches = 0;
  const ctx = { root, config: { language: 'en' }, openConfigBrowser: () => { launches++; },
    startConfigServer: async options => (session = await startConfigServer({ ...options,
      detect: async () => ({ clients: [] }), observe: async config => ({ config, clients: [] }) })) };
  const first = await callTool('config_ui_open', { open: false }, ctx);
  assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]{64}/);
  assert.equal(first.idleMinutes, 10);
  assert.equal(first.reused, false);
  assert.equal(launches, 0);
  assert.equal((await fetch(first.url)).status, 200);
  assert.equal((await fetch(new URL('/', first.url))).status, 403);
  const second = await callTool('config_ui_open', {}, ctx);
  assert.equal(second.url, first.url);
  assert.equal(second.reused, true);
  assert.equal(launches, 1);
  const mcp = createServer({ ctx, input: new PassThrough(), output: new PassThrough() });
  await mcp.stop();
  await session.closed;
  await assert.rejects(fetch(first.url));
});

test('config_ui_open retains idle shutdown and starts fresh after closing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'okit-idle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => closeConfigSession(root));
  let session;
  const ctx = { root, config: {}, startConfigServer: async options =>
    (session = await startConfigServer({ ...options, idleMs: 40 })) };
  const first = await callTool('config_ui_open', { open: false }, ctx);
  await Promise.all([session.closed, new Promise(resolve => setTimeout(resolve, 80))]);
  await assert.rejects(fetch(first.url));
  assert.equal((await callTool('config_ui_open', { open: false }, ctx)).reused, false);
});
