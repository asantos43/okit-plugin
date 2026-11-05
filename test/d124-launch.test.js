// D124: a launch for an account that is not logged in stops before any file or process, and the child of an extra
// account gets its own folder variable on every platform. The login marker is only ever looked up, never read.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { AccountNotLoggedIn, loginCommand } from '../src/accounts-login.js';
import { tick } from '../src/daemon.js';
import { inboxAdd } from '../src/inbox.js';
import { makeSpawner } from '../src/spawn-process.js';
import { writeJsonAtomic } from '../src/state.js';
import { paths } from '../src/store.js';

const SECRET = 'sekret-value-0123';
const FOLDER = { 'claude-code': 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' };
const enoent = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
// The marker of every account exists / is missing / cannot be told: stat results of the injected filesystem.
const present = { async stat() { return { isFile: () => true }; }, async readFile() { throw enoent(); } };
const absent = { async stat() { throw enoent(); }, async readFile() { throw enoent(); } };
const unreadable = { async stat() { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }, async readFile() { throw enoent(); } };

const child = () => Object.assign(new EventEmitter(), { pid: 321, unref() {} });

/** A scratch state folder with the saved accounts (`work` for each client) and a spawn double that counts. */
async function scene(t, { accounts = true, config = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'd124-launch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dirs = { 'claude-code': join(root, 'accounts', 'claude-work'), codex: join(root, 'accounts', 'codex-work') };
  const saved = accounts ? { accounts: Object.fromEntries(Object.keys(dirs)
    .map((client) => [client, [{ id: 'work', label: 'Work', configDir: dirs[client] }]])) } : {};
  await writeJsonAtomic(join(root, 'config.json'), { ...saved, ...config });
  const calls = [];
  const spawn = (command, args, options) => { calls.push({ command, args, options }); return child(); };
  const launch = (extra = {}) => makeSpawner({ logDir: join(root, 'runs'), cwd: root, spawn, env: { HOME: root, KEEP: 'same', OTHER_TOKEN: SECRET }, ...extra });
  return { root, dirs, calls, launch };
}
const demand = { title: 'test' };
const options = (client, account, more = {}) => ({ client, account, runId: `${client}-${account ?? 'none'}`, profile: { model: 'm' }, ...more });
const failure = (promise) => promise.then(() => null, (thrown) => thrown);

test('an extra account that is not logged in stops before any file or process, with a structured refusal', async (t) => {
  const { root, dirs, calls, launch } = await scene(t);
  for (const client of ['claude-code', 'codex']) {
    const error = await failure(launch()(demand, options(client, 'work')));
    assert.ok(error instanceof AccountNotLoggedIn, `${client}: ${error?.message}`);
    assert.equal(error.code, 'account-not-logged-in');
    assert.equal(error.client, client);
    assert.equal(error.account, 'work');
    assert.equal(error.loginCommand, loginCommand(client, { configDir: dirs[client] }, process.platform));
    assert.ok(error.loginCommand.includes(dirs[client]) && error.loginCommand.includes(FOLDER[client]));
    assert.match(error.message, /is not logged in/);
    assert.ok(error.message.includes(error.loginCommand));
  }
  assert.equal(calls.length, 0, 'the spawn double was never called');
  assert.deepEqual(await readdir(root), ['config.json'], 'no runs folder, no output file, no run record');
});

test('the refusal carries no credential path and no value of the environment', async (t) => {
  const { launch } = await scene(t);
  for (const locale of ['en', 'pt-BR']) {
    const error = await failure(launch({ env: { HOME: '/h', OTHER_TOKEN: SECRET, OKIT_LANGUAGE: locale } })(demand, options('claude-code', 'work')));
    const shown = JSON.stringify({ message: error.message, loginCommand: error.loginCommand, account: error.account });
    for (const leaked of ['.credentials.json', 'auth.json', SECRET, 'OTHER_TOKEN']) assert.equal(shown.includes(leaked), false, `${locale}: ${leaked}`);
  }
});

test('the refusal is said in the language of the run: the environment, the saved language, or the option', async (t) => {
  const pt = /A conta "Work" \(work\) do Claude Code não está logada, então nada foi iniciado\. Para entrar, rode: CLAUDE_CONFIG_DIR=.* claude e depois digite \/login\./;
  const fromEnvironment = await scene(t);
  const first = await failure(fromEnvironment.launch({ env: { HOME: '/h', OKIT_LANGUAGE: 'pt-BR' } })(demand, options('claude-code', 'work')));
  assert.match(first.message, pt);
  const saved = await scene(t, { config: { language: 'pt-BR' } });
  assert.match((await failure(saved.launch()(demand, options('claude-code', 'work')))).message, pt);
  const chosen = await scene(t);
  assert.match((await failure(chosen.launch()(demand, options('claude-code', 'work', { locale: 'pt-BR' })))).message, pt);
  const english = await scene(t);
  assert.match((await failure(english.launch()(demand, options('codex', 'work')))).message,
    /^The Codex account "Work" \(work\) is not logged in, so nothing was started\. Log it in with: CODEX_HOME=.* codex login$/);
});

test('the login command is the form of the shell of the platform', () => {
  const folder = 'C:\\Users\\O\u2019Brien\\acc one';
  const doubled = 'C:\\Users\\O\u2019\u2019Brien\\acc one';
  assert.equal(loginCommand('claude-code', { configDir: '/a/b' }, 'linux'), 'CLAUDE_CONFIG_DIR=/a/b claude');
  assert.equal(loginCommand('codex', { configDir: '/a b' }, 'darwin'), "CODEX_HOME='/a b' codex login");
  assert.equal(loginCommand('claude-code', { configDir: folder }, 'win32'), `$env:CLAUDE_CONFIG_DIR='${doubled}'; claude`);
  assert.equal(loginCommand('codex', { configDir: folder }, 'win32'), `$env:CODEX_HOME='${doubled}'; codex login`);
  assert.equal(loginCommand('codex', { configDir: null }, 'linux'), 'codex login', 'the default has no folder of its own');
});

test('a logged-in account launches, found by the marker file of its own folder', async (t) => {
  const { dirs, calls, launch } = await scene(t);
  for (const [client, marker] of [['claude-code', '.credentials.json'], ['codex', 'auth.json']]) {
    await mkdir(dirs[client], { recursive: true });
    await writeFile(join(dirs[client], marker), '');
    const started = await launch()(demand, options(client, 'work'));
    assert.equal(started.mode, 'PROCESS');
  }
  assert.equal(calls.length, 2);
});

test('an account whose login cannot be told launches as before', async (t) => {
  const { calls, launch } = await scene(t);
  await launch({ fs: unreadable })(demand, options('claude-code', 'work', { runId: 'unreadable' }));
  // macOS keeps the Claude Code login in the keychain: the missing marker says nothing there.
  await launch({ fs: absent, platform: 'darwin' })(demand, options('claude-code', 'work', { runId: 'keychain' }));
  // A Codex that keeps its credentials outside the file says so in its own settings.
  const store = { ...absent, async readFile() { return 'cli_auth_credentials_store = "keyring"\n'; } };
  await launch({ fs: store })(demand, options('codex', 'work', { runId: 'keyring' }));
  assert.equal(calls.length, 3);
});

test('a credential in the environment launches even when the marker is missing', async (t) => {
  const { calls, launch } = await scene(t);
  await launch({ env: { HOME: '/h', ANTHROPIC_API_KEY: SECRET } })(demand, options('claude-code', 'work'));
  await launch({ env: { HOME: '/h', CLAUDE_CODE_OAUTH_TOKEN: SECRET } })(demand, options('claude-code', 'work', { runId: 'token' }));
  assert.equal(calls.length, 2);
});

test('with no saved accounts the launch asks nothing of the login and is as it always was', async (t) => {
  const { calls, launch } = await scene(t, { accounts: false });
  const touched = [];
  const watching = { stat: async (...args) => { touched.push(args); throw enoent(); }, readFile: async (...args) => { touched.push(args); throw enoent(); } };
  for (const client of ['claude-code', 'codex']) {
    await launch({ fs: watching })(demand, options(client, undefined));
  }
  assert.equal(calls.length, 2);
  assert.deepEqual(touched, [], 'no marker was looked up');
  // Accounts saved for the other client do not make the login of this one a question either.
  const other = await scene(t, { accounts: false, config: { accounts: { codex: [{ id: 'work', label: 'Work', configDir: '/w' }] } } });
  await other.launch({ fs: watching })(demand, options('claude-code', undefined));
  assert.deepEqual(touched, []);
});

test('the default account of a client with saved accounts is held to the same rule', async (t) => {
  const { root, calls, launch } = await scene(t);
  const error = await failure(launch({ fs: absent })(demand, options('codex', undefined)));
  assert.ok(error instanceof AccountNotLoggedIn);
  assert.equal(error.account, 'default');
  assert.equal(error.loginCommand, 'codex login', 'the default is the folder the client uses with no override');
  assert.equal(calls.length, 0);
  assert.deepEqual(await readdir(root), ['config.json']);
  await launch({ fs: present })(demand, options('codex', undefined, { runId: 'in' }));
  assert.equal(calls.length, 1);
});

// | D124 environment | Must pass | Must refuse |
// | Extra account | its folder variable, the folder of that account | the variable of another account; a shell; an alias |
// | Default with saved accounts | no folder variable of the client | the variable inherited from an extra |
for (const platform of ['linux', 'win32', 'darwin']) {
  test(`${platform}: the child of an account gets its own folder variable and nothing of another account`, async (t) => {
    const { dirs, calls, launch } = await scene(t);
    const inherited = { HOME: '/h', KEEP: 'same', CLAUDE_CONFIG_DIR: '/accounts/other', CODEX_HOME: '/accounts/other' };
    for (const client of ['claude-code', 'codex']) {
      await launch({ env: inherited, fs: present, platform })(demand, options(client, 'work', { runId: `${client}-extra` }));
      const { command, options: given } = calls.at(-1);
      assert.equal(given.env[FOLDER[client]], dirs[client], `${client}: the folder of the account`);
      const other = client === 'codex' ? 'claude-code' : 'codex';
      assert.equal(given.env[FOLDER[other]], '/accounts/other', `${client}: the other client's variable is not touched`);
      assert.equal(Object.values(given.env).includes(dirs[other]), false, `${client}: no folder of the account of another client`);
      assert.deepEqual({ ...given.env, [FOLDER[client]]: undefined }, { ...inherited, [FOLDER[client]]: undefined, OKWORK_NO_DAEMON: '1' });
      assert.equal(command, client === 'codex' ? 'codex' : 'claude', 'the client itself, not an alias');
      assert.equal(given.shell, undefined, 'no shell');
      assert.equal(given.detached, true);
      await launch({ env: inherited, fs: present, platform })(demand, options(client, undefined, { runId: `${client}-default` }));
      assert.equal(Object.hasOwn(calls.at(-1).options.env, FOLDER[client]), false, `${client}: the default never inherits the variable`);
      assert.equal(calls.at(-1).options.shell, undefined);
    }
    assert.equal(inherited.CLAUDE_CONFIG_DIR, '/accounts/other', 'the environment given is not changed');
  });
}

test('an empty HOME breaks nothing: an extra account launches and a default is judged on the folder of the client', async (t) => {
  const { calls, dirs, launch } = await scene(t);
  await mkdir(dirs.codex, { recursive: true });
  await writeFile(join(dirs.codex, 'auth.json'), '');
  const empty = { env: { HOME: '', USERPROFILE: '' } };
  await launch(empty)(demand, options('codex', 'work'));
  assert.equal(calls.length, 1);
  const error = await failure(launch({ ...empty, fs: absent, platform: 'linux' })(demand, options('claude-code', undefined)));
  assert.ok(error instanceof AccountNotLoggedIn, error?.stack);
  assert.equal(calls.length, 1);
  const plain = await scene(t, { accounts: false });
  await plain.launch(empty)(demand, options('claude-code', undefined));
  assert.equal(plain.calls.length, 1);
});

test('the daemon shows the refusal as a plain reason and command, not as a failure of the spawner', async (t) => {
  const { root, dirs, calls, launch } = await scene(t);
  await writeJsonAtomic(paths(root).config, { accounts: { 'claude-code': [{ id: 'work', label: 'Work', configDir: dirs['claude-code'] }] },
    profiles: { 'claude-code': { simple: { model: 'm' }, normal: { model: 'm' }, hard: { model: 'm' } } } });
  await inboxAdd(root, { title: 'first demand', client: 'claude-code' });
  const spawner = launch();
  // The daemon does not choose accounts yet (D121): the account of the pass is the one the spawner is told.
  const spawn = (item, given) => spawner(item, { ...given, account: 'work' });
  const record = await tick(root, { now: () => Date.now(), quota: () => ({ remainingPct: 80 }), idle: () => true, spawn });
  assert.deepEqual(record.spawned, []);
  assert.equal(record.skipped.length, 1);
  assert.match(record.skipped[0].reason, /^The Claude Code account "Work" \(work\) is not logged in, so nothing was started\. Log it in with: CLAUDE_CONFIG_DIR=/);
  assert.doesNotMatch(record.skipped[0].reason, /spawner failed|\n\s+at /);
  assert.equal(calls.length, 0);
});
