// D124: a launch for an account that is not logged in stops before any file or process, and the child of an extra
// account gets its own folder variable on every platform. The login marker is only ever looked up, never read.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import * as claudeAdapter from '../adapters/claude-code/index.js';
import * as codexAdapter from '../adapters/codex/index.js';
import { AccountNotLoggedIn, loginCommand } from '../src/accounts-login.js';
import { tick } from '../src/daemon.js';
import { inboxAdd } from '../src/inbox.js';
import { countLive } from '../src/limits.js';
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
  // The platform is fixed: Claude Code's login cannot be told on darwin (Keychain), so a scenario that expects a
  // refusal must not depend on the machine it runs on. A scenario for another platform says so.
  const launch = (extra = {}) => makeSpawner({ logDir: join(root, 'runs'), cwd: root, spawn, platform: 'linux',
    env: { HOME: root, KEEP: 'same', OTHER_TOKEN: SECRET }, ...extra });
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
    assert.equal(error.loginCommand, loginCommand(client, { configDir: dirs[client] }, 'linux'));
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

// | Login command | Must pass | Must refuse |
// | Extra | sets the variable to its folder | the variable left as the terminal has it |
// | Default, client with saved accounts | removes the variable | keeping a variable inherited from an extra |
// | Default, no saved accounts | the client as it always was | touching the variable |
test('the login command rebuilds the environment of the account that was checked, on every platform', () => {
  const cases = [['claude-code', 'CLAUDE_CONFIG_DIR', 'claude'], ['codex', 'CODEX_HOME', 'codex login']];
  for (const [client, variable, program] of cases) {
    for (const platform of ['linux', 'darwin', 'win32']) {
      const where = `${client} ${platform}`;
      const set = loginCommand(client, { configDir: '/acc' }, platform, { saved: true });
      assert.equal(set, platform === 'win32' ? `$env:${variable}='/acc'; ${program}` : `${variable}=/acc ${program}`, where);
      const removed = loginCommand(client, { configDir: null }, platform, { saved: true });
      assert.equal(removed, platform === 'win32' ? `Remove-Item Env:${variable} -ErrorAction SilentlyContinue; ${program}`
        : `env -u ${variable} ${program}`, where);
      assert.equal(loginCommand(client, { configDir: null }, platform, { saved: false }), program, where);
      assert.equal(loginCommand(client, { configDir: null }, platform), program, where);
    }
  }
});

test('a login command for the default does not keep the folder an extra left in the terminal', async (t) => {
  if (process.platform === 'win32') return t.skip('the probe runs the POSIX form in sh');
  for (const [client, variable, program] of [['claude-code', 'CLAUDE_CONFIG_DIR', 'claude'], ['codex', 'CODEX_HOME', 'codex login']]) {
    const probe = (command) => spawnSync('sh', ['-c', command.replace(program, `printenv ${variable}`)],
      { env: { PATH: process.env.PATH, [variable]: '/inherited-extra' }, encoding: 'utf8' }).stdout;
    // The old command, with the variable inherited, is what the critic's probe showed leaking the extra's folder.
    assert.equal(probe(loginCommand(client, { configDir: null }, 'linux', { saved: false })).trim(), '/inherited-extra');
    assert.equal(probe(loginCommand(client, { configDir: null }, 'linux', { saved: true })), '', `${client}: the default drops it`);
    assert.equal(probe(loginCommand(client, { configDir: '/acc' }, 'linux', { saved: true })).trim(), '/acc', `${client}: an extra names its own`);
  }
});

test('on darwin the Claude Code login is unknown and launches, while Codex is told and refused', async (t) => {
  const { calls, launch } = await scene(t);
  await launch({ platform: 'darwin' })(demand, options('claude-code', 'work'));
  assert.equal(calls.length, 1, 'Claude Code: unknown does not block');
  const error = await failure(launch({ platform: 'darwin' })(demand, options('codex', 'work')));
  assert.ok(error instanceof AccountNotLoggedIn, 'Codex: logged-out refuses');
  assert.equal(calls.length, 1);
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
  assert.equal(error.loginCommand, 'env -u CODEX_HOME codex login', 'the default is the folder the client uses with no override');
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
  await inboxAdd(root, { title: 'first demand', client: 'claude-code', ext: { account: 'work' } });
  const spawner = launch();
  const spawn = spawner;
  const deps = { now: () => Date.now(), quota: () => ({ remainingPct: 80 }), idle: () => true, spawn };
  const record = await tick(root, deps);
  assert.deepEqual(record.spawned, []);
  assert.equal(record.skipped.length, 1);
  // The command is the one `loginCommand` builds for this account and platform: its path and quoting are the host's.
  const login = loginCommand('claude-code', { configDir: dirs['claude-code'] }, 'linux');
  assert.match(record.skipped[0].reason, /^The Claude Code account "Work" \(work\) is not logged in, so nothing was started\. Log it in with: .*CLAUDE_CONFIG_DIR=/);
  assert.ok(record.skipped[0].reason.includes(`Log it in with: ${login}`), record.skipped[0].reason);
  assert.doesNotMatch(record.skipped[0].reason, /spawner failed|\n\s+at /);
  assert.equal(calls.length, 0);
  // The refusal came before the reservation: no run record, no output file, and the slot was never held.
  assert.deepEqual(await readdir(join(root, 'runs')).catch(() => []), [], 'no run record and no output file');
  assert.equal(await countLive(root), 0);
  // The account logs in: the very next pass launches (the refusal cost nothing).
  await mkdir(dirs['claude-code'], { recursive: true });
  await writeFile(join(dirs['claude-code'], '.credentials.json'), '');
  const next = await tick(root, deps);
  assert.equal(next.spawned.length, 1);
  assert.equal(calls.length, 1);
});

// | Window between the preflight and the spawn | Must pass | Must refuse |
// | login vanishes (preflight ok, spawn refuses) | plain reason, no run record, no live slot | a `done` record left behind |
// | any other spawner error | the record stays `done` as before | discarding the record |
async function windowScene(t, error) {
  const { root } = await scene(t);
  await writeJsonAtomic(paths(root).config, { profiles: { 'claude-code': { simple: { model: 'm' }, normal: { model: 'm' }, hard: { model: 'm' } } } });
  await inboxAdd(root, { title: 'first demand', client: 'claude-code' });
  const spawn = Object.assign(async () => { throw error; }, { preflight: async () => {} });
  const deps = { now: () => Date.now(), quota: () => ({ remainingPct: 80 }), idle: () => true, spawn };
  return { root, record: await tick(root, deps) };
}

test('a login that vanishes between the preflight and the spawn leaves no run record and no live slot', async (t) => {
  const account = { id: 'work', label: 'Work', configDir: '/x/work' };
  const error = new AccountNotLoggedIn({ client: 'claude-code', account, platform: 'linux' });
  const { root, record } = await windowScene(t, error);
  assert.deepEqual(record.spawned, []);
  assert.deepEqual(record.skipped.map((entry) => entry.reason), [error.message], 'the plain message, not "the spawner failed"');
  assert.deepEqual(await readdir(join(root, 'runs')).catch(() => []), [], 'the reservation left no file');
  assert.equal(await countLive(root), 0);
});

test('any other spawner error still leaves the run as done', async (t) => {
  const { root, record } = await windowScene(t, Object.assign(new Error('boom'), { code: 'EBOOM' }));
  assert.deepEqual(record.skipped.map((entry) => entry.reason), ['the spawner failed: boom']);
  const files = await readdir(join(root, 'runs'));
  assert.equal(files.length, 1, 'the record of the failed spawn is kept');
  assert.equal(await countLive(root), 0);
});

// | Adapters | Must pass | Must refuse |
// | locale | the option reaches the refusal: pt-BR says pt-BR with no saved language or variable | English by omission |
// | platform/fs | injected through to the check | the machine's platform deciding the test |
test('the adapters forward the language of the run to the refusal of an account that is not logged in', async (t) => {
  const { root, dirs, calls } = await scene(t);
  const config = { accounts: { 'claude-code': [{ id: 'work', label: 'Work', configDir: dirs['claude-code'] }],
    codex: [{ id: 'work', label: 'Work', configDir: dirs.codex }] } };
  const common = { headless: true, spawn: () => { calls.push('spawned'); return child(); }, logDir: join(root, 'runs'), cwd: root,
    account: 'work', config, platform: 'linux', fs: absent, env: { HOME: root } };
  const briefing = 'Role: Executor\nfix the bug';
  for (const [name, adapter, expected] of [
    ['claude-code', claudeAdapter, /^A conta "Work" \(work\) do Claude Code não está logada/],
    ['codex', codexAdapter, /^A conta "Work" \(work\) do Codex não está logada/]]) {
    const error = await failure(adapter.spawn({ model: 'm' }, briefing, { ...common, locale: 'pt-BR', runId: `${name}-pt` }));
    assert.ok(error instanceof AccountNotLoggedIn, `${name}: ${error?.message}`);
    assert.match(error.message, expected);
    const english = await failure(adapter.spawn({ model: 'm' }, briefing, { ...common, runId: `${name}-en` }));
    assert.match(english.message, /is not logged in/, `${name}: English without the option`);
  }
  assert.deepEqual(calls, []);
});

test('the daemon with the real spawner: a named default account is refused before the slot', async (t) => {
  const { root, dirs, calls, launch } = await scene(t);
  await writeJsonAtomic(paths(root).config, { accounts: { codex: [{ id: 'work', label: 'Work', configDir: dirs.codex }] },
    profiles: { codex: { simple: { model: 'm' }, normal: { model: 'm' }, hard: { model: 'm' } } } });
  await inboxAdd(root, { title: 'first demand', client: 'codex', ext: { account: 'default' } });
  const record = await tick(root, { now: () => Date.now(), quota: () => ({ remainingPct: 80 }), idle: () => true, spawn: launch({ fs: absent }) });
  assert.match(record.skipped[0].reason, /Log it in with: env -u CODEX_HOME codex login$/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await readdir(join(root, 'runs')).catch(() => []), []);
  assert.equal(await countLive(root), 0);
});
