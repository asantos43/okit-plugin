import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createQuotaPoller, pollStateFile } from '../src/quota/active-poller.js';
import { claudeWindows, codexWindows, CLAUDE_ARGS, USAGE_URL } from '../src/quota/active-sources.js';
import { adapterQuotaReader } from '../src/env/quota.js';
import { configOf, DEFAULT_CONFIG, ConfigError } from '../src/profiles.js';
import { chooseAccount } from '../src/accounts-choose.js';
import { rotationStatus, pollReason } from '../src/quota/rotation.js';
import { requestQuotaRead } from '../src/quota/active-trigger.js';
import { panelState } from '../src/panel-state.js';
import { changeAccount, accountCommand } from '../src/accounts-cli.js';
import { daemonRun } from '../src/daemon.js';
import { viewModel } from '../adapters/claude-code/panel/panel.js';
import { main } from '../src/cli.js';
import { accountChoice } from '../src/limits.js';
import { localizeReason } from '../src/install/present.js';
import { statusTable } from '../src/status.js';

const epoch = Date.parse('2026-11-08T12:00:00Z');
const reset = epoch / 1000 + 3600;
const usage = (used = 44) => ({ five_hour: { utilization: used, resets_at: new Date(reset * 1000).toISOString() },
  seven_day: { utilization: used, resets_at: new Date(reset * 1000).toISOString() } });
const cliUsage = (used = .44) => ({ five_hour: { utilization: used, resetsAt: reset },
  seven_day: { utilization: used, resetsAt: reset } });
const codexUsage = { rateLimits: { primary: { usedPercent: 44, windowDurationMins: 300, resetsAt: reset },
  secondary: { usedPercent: 44, windowDurationMins: 10080, resetsAt: reset } } };
async function world(t, extras = []) {
  const home = await fs.mkdtemp(join(tmpdir(), 'd145-'));
  const root = join(home, 'state');
  await fs.mkdir(root);
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const config = { accounts: { 'claude-code': extras.map((id) => ({ id, label: id, configDir: join(home, id) })) } };
  const ctx = { root, home, config, clock: epoch, env: { HOME: home, PATH: '',
    CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'), OKWORK_HOME: root } };
  ctx.now = () => ctx.clock;
  ctx.save = () => fs.writeFile(join(root, 'config.json'), JSON.stringify(config));
  ctx.credentials = async (id = 'default', expiresAt = epoch + 3600_000) => {
    const folder = id === 'default' ? join(home, '.claude') : join(home, id);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(join(folder, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'RECOGNIZABLE_D145_SECRET', expiresAt } }));
  };
  ctx.json = async (file) => JSON.parse(await fs.readFile(join(root, 'quota', file), 'utf8'));
  ctx.state = (id = 'default') => ctx.json(pollStateFile('claude-code', id));
  ctx.poll = (deps = {}) => createQuotaPoller({ ...ctx, fetch: async () => ({ ok: true, json: async () => usage() }),
    spawn: () => { throw new Error('Unexpected client launch'); }, ...deps });
  await ctx.save();
  return ctx;
}
function fakeClients({ hang = false, delay = 0, output = cliUsage() } = {}) {
  const calls = [];
  let live = 0, peak = 0, cliLive = 0, cliPeak = 0;
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.exitCode = null;
    const call = { command, args, options, signals: [], messages: [] }; calls.push(call);
    live += 1; peak = Math.max(peak, live);
    if (command === 'claude') { cliLive += 1; cliPeak = Math.max(cliPeak, cliLive); }
    let closed = false;
    child.kill = (signal) => {
      call.signals.push(signal);
      if (hang && signal === 'SIGTERM') return true;
      if (!closed) { closed = true; live -= 1; if (command === 'claude') cliLive -= 1;
        child.exitCode = 0; setImmediate(() => child.emit('close', 0)); }
      return true;
    };
    const emit = (message) => setTimeout(() => { if (!closed) child.stdout.write(JSON.stringify(message) + '\n'); }, delay);
    child.stdin.on('data', (chunk) => {
      const message = JSON.parse(chunk); call.messages.push(message);
      if (!hang && message.id === 1) emit({ id: 1, result: {} });
      if (!hang && message.id === 2) emit({ id: 2, result: codexUsage });
    });
    if (!hang && command === 'claude') emit({ type: 'rate_limit_event', rate_limit_info: {
      unifiedWindows: typeof output === 'function' ? output(options) : output } });
    return child;
  };
  return { spawn, calls, stats: () => ({ peak, cliPeak, live }) };
}
// | Corpus | Must pass | Must refuse |
// | usage | percent/ISO and fraction/epoch | missing, null, wrong units, invalid dates |
test('source mappings agree and reject malformed windows', () => {
  assert.deepEqual(claudeWindows(usage()), claudeWindows(cliUsage(), true));
  assert.deepEqual(codexWindows(codexUsage), claudeWindows(usage()));
  for (const data of [{}, { five_hour: null }, usage(101), usage('44')]) {
    assert.throws(() => claudeWindows(data), /Invalid usage/);
  }
  assert.throws(() => claudeWindows({ ...cliUsage(), five_hour: { utilization: null, resetsAt: reset } }, true));
  assert.throws(() => codexWindows({ rateLimits: { primary: { usedPercent: 4, windowDurationMins: 42 } } }));
});

test('each cycle discovers new accounts and drops removed accounts', async (t) => {
  const ctx = await world(t);
  await ctx.credentials();
  const tokens = [];
  const poller = ctx.poll({ fetch: async (_url, options) => {
    tokens.push(options.headers.Authorization); return { ok: true, json: async () => usage() };
  } });
  await poller.cycle(); assert.equal(tokens.length, 1);
  ctx.config.accounts['claude-code'].push({ id: 'extra', label: 'Extra', configDir: join(ctx.home, 'extra') });
  await ctx.credentials('extra'); await ctx.save(); ctx.clock += 60_000;
  await poller.cycle(); assert.equal(tokens.length, 3);
  assert.equal((await ctx.json('claude-code.extra.json')).windows[0].remainingPct, 56);
  ctx.config.accounts['claude-code'] = []; await ctx.save(); ctx.clock += 60_000;
  await poller.cycle(); assert.equal(tokens.length, 4);
  assert.equal((await ctx.state('extra')).at, epoch + 60_000);
});
test('expired tokens are never sent; fallback runs only once per configured interval', async (t) => {
  const ctx = await world(t);
  await ctx.credentials('default', epoch - 1);
  const fake = fakeClients(); let requests = 0;
  const poller = ctx.poll({ spawn: fake.spawn, fetch: async () => { requests += 1; return { ok: true, json: async () => usage() }; } });
  const original = await fs.readFile(join(ctx.home, '.claude', '.credentials.json'), 'utf8');
  await poller.cycle();
  assert.equal(fake.calls.length, 1); assert.equal(requests, 0);
  assert.deepEqual(fake.calls[0].args, CLAUDE_ARGS);
  assert.deepEqual(await fs.readdir(fake.calls[0].options.cwd).catch(() => []), []);
  ctx.clock += 60_000; await poller.cycle();
  assert.equal(fake.calls.length, 1); assert.equal((await ctx.state()).state, 'token-expired');
  ctx.clock += 29 * 60_000; await poller.cycle(); assert.equal(fake.calls.length, 2);
  assert.equal(await fs.readFile(join(ctx.home, '.claude', '.credentials.json'), 'utf8'), original);
  await ctx.credentials(); ctx.clock += 60_000; await poller.cycle();
  assert.equal(requests, 1); assert.equal(fake.calls.length, 2);
  assert.equal((await ctx.state()).state, 'ok');
});

test('logged-out accounts never call either client or endpoint; absent Keychain file uses CLI', async (t) => {
  const ctx = await world(t);
  let requests = 0; const fake = fakeClients();
  await ctx.poll({ spawn: fake.spawn, fetch: () => { requests += 1; } }).cycle();
  assert.equal(fake.calls.length, 0); assert.equal(requests, 0);
  assert.equal((await ctx.state()).state, 'not-logged-in');
  await ctx.poll({ platform: 'darwin', spawn: fake.spawn }).readNow('claude-code');
  assert.equal(fake.calls.length, 1); assert.equal((await ctx.state()).source, 'active-cli');
});
test('one read per account, four reads maximum, and one CLI globally across poller instances', async (t) => {
  const ctx = await world(t, ['one', 'two', 'three', 'four', 'five']);
  for (const id of ['default', 'one', 'two', 'three', 'four', 'five']) await ctx.credentials(id, epoch - 1);
  const fake = fakeClients({ delay: 5 });
  const poller = ctx.poll({ spawn: fake.spawn });
  const first = poller.readNow('claude-code');
  assert.equal(poller.readNow('claude-code'), first);
  await Promise.all([first, poller.cycle(), ctx.poll({ spawn: fake.spawn }).cycle()]);
  assert.equal(fake.stats().cliPeak, 1);
  assert.ok(fake.stats().peak <= 4);
  assert.equal(fake.calls.filter((c) => !c.options.env.CLAUDE_CONFIG_DIR).length, 1);
  assert.equal(fake.calls.length, 6);
});

test('timeouts and stop kill children with TERM then KILL and reap them', async (t) => {
  for (const stop of [false, true]) {
    const ctx = await world(t); await ctx.credentials('default', epoch - 1);
    const fake = fakeClients({ hang: true });
    const poller = ctx.poll({ spawn: fake.spawn, cliTimeoutMs: stop ? 10_000 : 10 });
    const read = poller.readNow('claude-code');
    while (!fake.calls.length) await new Promise((resolve) => setTimeout(resolve, 2));
    if (stop) await poller.stop();
    await read;
    assert.deepEqual(fake.calls[0].signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(fake.stats().live, 0);
    if (!stop) assert.equal((await ctx.state()).reason, 'Usage read timed out.');
  }
});
test('app-server timeout also kills and reaps its child', async (t) => {
  const ctx = await world(t); const fake = fakeClients({ hang: true });
  await ctx.poll({ login: async () => 'logged-in', spawn: fake.spawn, appTimeoutMs: 5 }).readNow('codex');
  assert.deepEqual(fake.calls[0].signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(fake.stats().live, 0);
  assert.equal((await ctx.json(pollStateFile('codex', 'default'))).reason, 'Usage read timed out.');
});
test('backoff doubles through fifteen minutes and resets after success', async (t) => {
  const ctx = await world(t); await ctx.credentials('default', epoch + 86400_000);
  let fails = true, requests = 0;
  const poller = ctx.poll({ fetch: async () => { requests += 1;
    if (fails) return { ok: false, status: 503, json: () => { throw new Error('must not read body'); } };
    return { ok: true, json: async () => usage() };
  } });
  for (const minutes of [1, 2, 4, 8, 15, 15]) {
    await poller.cycle();
    const state = await ctx.state(); assert.equal(state.nextTryAt - ctx.clock, minutes * 60_000);
    const count = requests; await poller.cycle(); assert.equal(requests, count);
    ctx.clock = state.nextTryAt;
  }
  fails = false; await poller.cycle();
  assert.equal((await ctx.state()).failures, 0);
  ctx.clock += 60_000; fails = true; await poller.cycle();
  assert.equal((await ctx.state()).nextTryAt - ctx.clock, 60_000);
});

test('disabled polling does no IO to accounts, fetch or spawn', async (t) => {
  const ctx = await world(t); ctx.config.quotaPoll = { enabled: false }; await ctx.save();
  let reads = 0;
  const fsGuard = { ...fs, readFile: (...args) => { reads += 1;
    assert.equal(args[0], join(ctx.root, 'config.json')); return fs.readFile(...args); } };
  const poller = ctx.poll({ fs: fsGuard, fetch: () => assert.fail('fetch'), spawn: () => assert.fail('spawn') });
  await poller.cycle(); await poller.readNow('claude-code');
  assert.equal(reads, 2); assert.deepEqual(await fs.readdir(ctx.root), ['config.json']);
});
test('credential boundary: fixed HTTPS, no redirects, no token leaks in success or any failure', async (t) => {
  const token = 'RECOGNIZABLE_D145_SECRET';
  const lines = [];
  const restore = ['log', 'warn', 'error'].map((method) => {
    const original = console[method];
    console[method] = (...values) => { lines.push(values.join(' ')); original(...values); };
    return () => { console[method] = original; };
  });
  t.after(() => restore.forEach((undo) => undo()));
  for (const mode of ['success', 'http', 'timeout', 'malformed', 'throw', 'cli']) {
    const ctx = await world(t); await ctx.credentials('default', mode === 'cli' ? epoch - 1 : epoch + 3600_000);
    const original = await fs.readFile(join(ctx.home, '.claude', '.credentials.json'), 'utf8');
    const calls = fakeClients({ output: { five_hour: token } });
    const forbidden = [];
    const guardedFS = { ...fs, readFile: (file, ...args) => {
      if (file.endsWith('auth.json')) { forbidden.push(file); throw new Error('Forbidden credential read'); }
      return fs.readFile(file, ...args);
    } };
    for (const method of ['writeFile', 'rename', 'rm', 'mkdir', 'open']) guardedFS[method] = (...args) => {
      for (const file of method === 'rename' ? args.slice(0, 2) : [args[0]]) {
        if (['.claude', '.codex'].some((dir) => file === join(ctx.home, dir) || file.startsWith(join(ctx.home, dir) + '/'))) {
          forbidden.push(file); throw new Error('Forbidden account write');
        }
      }
      return fs[method](...args);
    };
    const poller = ctx.poll({ fs: guardedFS, spawn: calls.spawn, endpointTimeoutMs: 5,
      fetch: async (url, options) => {
        assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
        assert.equal(USAGE_URL, url); assert.equal(options.method, 'GET');
        assert.equal(options.headers['anthropic-beta'], 'oauth-2025-04-20');
        assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, `Bearer ${token}`);
        if (mode === 'timeout') return new Promise(() => {});
        if (mode === 'throw') throw new Error(token);
        return { ok: mode !== 'http', status: 401, json: async () => mode === 'malformed' ? { body: token } : usage() };
      } });
    await assert.doesNotReject(() => poller.cycle());
    assert.deepEqual(forbidden, []);
    assert.equal(await fs.readFile(join(ctx.home, '.claude', '.credentials.json'), 'utf8'), original);
    const paths = await fs.readdir(ctx.home, { recursive: true });
    for (const file of paths) {
      if (file.endsWith('.credentials.json') || !(await fs.stat(join(ctx.home, file))).isFile()) continue;
      assert.ok(!(await fs.readFile(join(ctx.home, file), 'utf8')).includes(token), file);
    }
    assert.ok(!JSON.stringify(calls.calls).includes(token));
    if (mode === 'http') assert.equal((await ctx.state()).reason, 'Usage request failed (HTTP 401).');
  }
  assert.ok(!lines.join('\n').includes(token));
});
test('active readings preserve windows and never replace a newer passive or stored reading', async (t) => {
  const ctx = await world(t); await ctx.credentials();
  const poller = ctx.poll(); await poller.cycle();
  const reader = adapterQuotaReader({ stateRoot: ctx.root, env: ctx.env, now: ctx.now, config: configOf(ctx.config) });
  assert.equal((await reader('claude-code')).windows.length, 2);
  await fs.writeFile(join(ctx.root, 'quota', 'claude-code-statusline.json'), JSON.stringify({
    receivedAt: new Date(epoch + 1).toISOString(), input: { rate_limits: {
      five_hour: { used_percentage: 10, resets_at: reset }, seven_day: { used_percentage: 15, resets_at: reset } } } }));
  const original = await fs.readFile(join(ctx.root, 'quota', 'claude-code.json'), 'utf8');
  await poller.readNow('claude-code');
  assert.equal(await fs.readFile(join(ctx.root, 'quota', 'claude-code.json'), 'utf8'), original);
  assert.equal((await reader('claude-code')).windows[0].remainingPct, 90);
  const newer = { remainingPct: 99, recordedAt: new Date(epoch + 2).toISOString(), source: 'automatic', windows: [
    { remainingPct: 99, windowMinutes: 300 }, { remainingPct: 98, windowMinutes: 10080 }] };
  await fs.writeFile(join(ctx.root, 'quota', 'claude-code.json'), JSON.stringify(newer));
  await poller.readNow('claude-code');
  assert.deepEqual(await ctx.json('claude-code.json'), newer);
  assert.equal((await reader('claude-code')).remainingPct, 99);
});
test('Codex handshake isolates CODEX_HOME and never opens auth.json', async (t) => {
  const ctx = await world(t);
  ctx.config.accounts.codex = [{ id: 'extra', label: 'Extra', configDir: join(ctx.home, 'codex-extra') }]; await ctx.save();
  const fake = fakeClients();
  const guard = { ...fs, readFile: (file, ...args) => { assert.ok(!file.endsWith('auth.json')); return fs.readFile(file, ...args); } };
  await ctx.poll({ fs: guard, spawn: fake.spawn, login: async () => 'logged-in' }).readNow('codex', 'extra');
  assert.equal(fake.calls[0].options.env.CODEX_HOME, join(ctx.home, 'codex-extra'));
  assert.deepEqual(fake.calls[0].messages.map((m) => m.method), ['initialize', 'initialized', 'account/rateLimits/read']);
  const reader = adapterQuotaReader({ stateRoot: ctx.root, config: ctx.config, env: ctx.env, now: ctx.now });
  assert.deepEqual((await reader('codex', 'extra')).windows, claudeWindows(usage()));
  assert.equal((await ctx.json('codex.extra.json')).source, 'active-app-server');
});

test('quotaPoll configuration defaults and invalid settings', () => {
  assert.deepEqual(configOf({}).quotaPoll, { enabled: true, intervalSec: 60, claudeFallbackMinutes: 30 });
  assert.equal(DEFAULT_CONFIG.accountPolicy.minQuotaPct, 20);
  for (const quotaPoll of [null, [], false, { enabled: 1 }, { intervalSec: 0 }, { claudeFallbackMinutes: -1 }]) {
    assert.throws(() => configOf({ quotaPoll }), (error) => {
      assert.ok(error instanceof ConfigError); assert.match(error.message, /quotaPoll/);
      assert.match(localizeReason(error.message, 'pt-BR'), /quotaPoll.*inválida/); // locale:pt-BR
      return true;
    });
  }
});
const actor = { name: 'normal', model: 'opus', effort: 'high' };
const observation = (id, session, weekly, readAt = epoch) => ({ id, client: 'claude-code', login: 'logged-in',
  actors: [actor], reading: { readAt, recordedAt: new Date(readAt).toISOString(), windows: [
    { remainingPct: session, windowMinutes: 300, resetsAt: new Date(epoch + 3600_000).toISOString() },
    { remainingPct: weekly, windowMinutes: 10080, resetsAt: new Date(epoch + 86400_000).toISOString() }] } });
const choose = (accounts, settings = {}) => chooseAccount({ client: 'claude-code', actorClass: actor, accounts, now: epoch, settings });

test('rotation uses a configurable strict floor in BOTH windows and prefers fresh headroom', () => {
  for (const minimum of [0, 20, 50]) {
    for (const [session, weekly, eligible] of [[minimum, 90, false], [90, minimum, false],
      [minimum + 1, minimum + 1, true], [15, 90, minimum === 0], [90, 15, minimum === 0]]) {
      const result = choose([observation('extra', session, weekly)], { accountPolicy: { minQuotaPct: minimum } });
      assert.equal(Boolean(result.account), eligible, `${minimum}: ${session}/${weekly}`);
    }
  }
  const base = observation('default', 40, 40);
  assert.equal(choose([base, observation('extra', 90, 90)]).account.id, 'extra');
  assert.equal(choose([base, observation('extra', 15, 90)]).account.id, 'default');
  assert.equal(choose([base, observation('extra', 90, 15)]).account.id, 'default');
  assert.equal(choose([observation('extra', 20, 90)]).reason.code, 'session');
});
test('stale readings become unknown, remain eligible last, and respect intervalSec', () => {
  const base = observation('default', 40, 40);
  const extra = observation('extra', 90, 90, epoch - 180_001);
  assert.equal(choose([base, extra]).account.id, 'default');
  assert.equal(choose([extra]).reason.code, 'unknown');
  assert.equal(choose([base, extra], { quotaPoll: { intervalSec: 120 } }).account.id, 'extra');
  const exhausted = observation('extra', 0, 0, epoch - 180_001);
  assert.equal(choose([exhausted]).reason.code, 'unknown');
  extra.reading = null;
  assert.equal(choose([base, extra]).account.id, 'default');
  assert.equal(choose([extra]).reason.code, 'unknown');
  extra.reading = observation('extra', 90, 90, epoch - 180_000).reading;
  assert.equal(choose([base, extra]).account.id, 'extra');
});

test('poll states and rotation reasons reach panel-state in both languages', async (t) => {
  const ctx = await world(t); ctx.config.quotaPoll = { enabled: false }; await ctx.save();
  await fs.mkdir(join(ctx.root, 'quota'), { recursive: true });
  const expected = {
    en: { 'not-logged-in': 'Account is not logged in.', 'token-expired': 'Token unavailable; waiting for fallback.',
      'read-failed': 'Usage read failed.', 'no-reading': 'No reading yet.' },
    'pt-BR': { 'not-logged-in': 'Conta não logada.', 'token-expired': 'Token indisponível; aguardando fallback.', // locale:pt-BR
      'read-failed': 'Falha na leitura de uso.', 'no-reading': 'Nenhuma leitura ainda.' }, // locale:pt-BR
  };
  for (const locale of ['en', 'pt-BR']) {
    for (const state of ['not-logged-in', 'token-expired', 'read-failed', 'no-reading']) {
      await fs.writeFile(join(ctx.root, 'quota', pollStateFile('claude-code', 'default')), JSON.stringify({ state }));
      const result = await panelState({ ...ctx, locale }, 'claude');
      assert.equal(result.accounts[0].quota_state.reason, pollReason({ state }, locale));
      assert.equal(result.accounts[0].quota_state.reason, expected[locale][state]);
      assert.ok(result.accounts[0].quota_state.reason);
      assert.equal(result.accounts[0].rotation.reason, 'login');
    }
    const status = (s, w) => rotationStatus({ reading: observation('a', s, w).reading,
      login: 'logged-in', config: configOf({}), now: epoch, locale });
    assert.equal(status(15, 90).reason, 'session'); assert.equal(status(90, 15).reason, 'weekly');
    assert.notEqual(status(15, 90).text, status(90, 15).text);
  }
});
test('add immediately requests a read without waiting for the client, shared by CLI and web', async (t) => {
  const ctx = await world(t); const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { on() {}, unref() {} };
  };
  const next = await changeAccount({ ...ctx, fs, spawn, platform: 'linux' }, 'add', {
    client: 'claude-code', name: 'Extra', directory: join(ctx.home, 'extra') });
  assert.equal(next.accounts['claude-code'][0].id, 'extra');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(-3), ['claude-code', 'extra', 'force']);
  await requestQuotaRead({ ...ctx, spawn }, 'claude-code', 'extra');
  assert.equal(calls.length, 1, 'request lease prevents repeats');
  ctx.config.quotaPoll = { enabled: false }; await ctx.save();
  await requestQuotaRead({ ...ctx, spawn }, 'claude-code', 'default', { force: true });
  assert.equal(calls.length, 1);
});
test('parallel OAuth reads reach four but never exceed four', async (t) => {
  const ctx = await world(t, ['a', 'b', 'c', 'd', 'e']);
  for (const id of ['default', 'a', 'b', 'c', 'd', 'e']) await ctx.credentials(id);
  let active = 0, peak = 0, reads = 0;
  await ctx.poll({ fetch: async () => {
    active += 1; reads += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10)); active -= 1;
    return { ok: true, json: async () => usage() };
  } }).cycle();
  assert.equal(reads, 6); assert.equal(peak, 4);
});
test('scheduler uses the minute interval plus bounded jitter and cancels on stop', async (t) => {
  const ctx = await world(t); const timers = []; const cancelled = [];
  const poller = ctx.poll({ random: () => .5, schedule: (callback, ms) => {
    timers.push({ callback, ms }); return timers.length;
  }, cancel: (id) => cancelled.push(id) });
  await poller.start(); assert.equal(timers[0].ms, 62_500);
  await poller.stop(); assert.deepEqual(cancelled, [1]);
});
test('panel due-read leases expire after sixty seconds and never wait for client completion', async (t) => {
  const ctx = await world(t); let calls = 0;
  const spawn = () => { calls += 1; return { on() {}, unref() {} }; };
  await requestQuotaRead({ ...ctx, spawn }, 'claude-code');
  await requestQuotaRead({ ...ctx, spawn }, 'claude-code'); assert.equal(calls, 1);
  ctx.clock += 60_000;
  await requestQuotaRead({ ...ctx, spawn }, 'claude-code'); assert.equal(calls, 2);
  ctx.config.quotaPoll = { enabled: false }; await ctx.save();
  ctx.clock += 60_000; await requestQuotaRead({ ...ctx, spawn }, 'claude-code'); assert.equal(calls, 2);
});

test('daemon starts and stops the poller with its own lifecycle', async (t) => {
  const ctx = await world(t); const calls = []; const controller = new AbortController();
  await daemonRun(ctx.root, { env: ctx.env, now: ctx.now, spawn: () => assert.fail('task launch'),
    quota: async () => ({ remainingPct: 100 }), createQuotaPoller: (options) => {
      assert.equal(options.root, ctx.root);
      return { start: async () => calls.push('start'), stop: async () => calls.push('stop') };
    } }, { signal: controller.signal, sleep: async () => { controller.abort(); } });
  assert.equal(calls[0], 'start'); assert.ok(calls.includes('stop'));
});

test('panel renders state explanation and rotation without changing other sections', () => {
  const account = { id: 'default', label: 'Default', quota: { session: null, weekly: null },
    quota_state: { state: 'read-failed', reason: 'Usage read failed.' },
    rotation: { eligible: true, known: false, text: 'No current reading; eligible last.' } };
  const sections = viewModel({ ok: true, state: { accounts: [account], runs: [], readiness: '', warnings: [] } }, epoch);
  assert.ok(sections[1].rows.includes(account.quota_state.reason));
  assert.ok(sections[1].rows.includes(account.rotation.text));
});
test('account list reports eligible, both quota floors and unknown readings in both languages', async (t) => {
  const ctx = await world(t); await ctx.credentials();
  ctx.config.quotaPoll = { enabled: false }; await ctx.save();
  await fs.mkdir(join(ctx.root, 'quota'), { recursive: true });
  for (const locale of ['en', 'pt-BR']) {
    for (const [session, weekly, reason] of [[90, 90, 'eligible'], [20, 90, 'session'], [90, 20, 'weekly']]) {
      await fs.writeFile(join(ctx.root, 'quota', 'claude-code.json'), JSON.stringify({
        ...observation('default', session, weekly).reading, source: 'active-oauth', remainingPct: Math.min(session, weekly) }));
      const lines = [];
      await accountCommand({ ...ctx, fs, locale, out: (line) => lines.push(line) }, 'list', ['claude-code', '--json']);
      const row = JSON.parse(lines[0])[0]; assert.equal(row.rotation.reason, reason);
      assert.equal(row.rotation.eligible, reason === 'eligible'); assert.ok(row.rotation.text);
      const words = locale === 'pt-BR' ? { eligible: 'Elegível', session: 'sessão', weekly: 'semanal' } // locale:pt-BR
        : { eligible: 'Eligible', session: 'Session', weekly: 'Weekly' };
      assert.ok(row.rotation.text.includes(words[reason]));
    }
    await fs.rm(join(ctx.root, 'quota', 'claude-code.json'));
    const lines = [];
    await accountCommand({ ...ctx, fs, locale, out: (line) => lines.push(line) }, 'list', ['claude-code', '--json']);
    assert.equal(JSON.parse(lines[0])[0].rotation.reason, 'no-reading');
  }
});
test('sandbox cycle reaches the CLI panel and accountChoice with independent account quotas', async (t) => {
  const ctx = await world(t, ['extra']);
  for (const id of ['default', 'extra']) await ctx.credentials(id, epoch - 1);
  await fs.mkdir(join(ctx.home, '.codex')); await fs.writeFile(join(ctx.home, '.codex', 'auth.json'), '{}');
  const fake = fakeClients({ output: (options) => cliUsage(options.env.CLAUDE_CONFIG_DIR ? .1 : .6) });
  const poller = ctx.poll({ spawn: fake.spawn }); await poller.cycle();
  const output = [];
  assert.equal(await main(['panel-state', '--json', '--client', 'claude'], { ...ctx,
    stdout: (line) => output.push(line), stderr: (line) => assert.fail(line) }), 0);
  const state = JSON.parse(output[0]);
  assert.deepEqual(state.accounts.map((a) => [a.id, a.quota.session.remaining_pct, a.quota.weekly.remaining_pct]),
    [['default', 40, 40], ['extra', 90, 90]]);
  const config = configOf(ctx.config);
  const selected = await accountChoice({ client: 'claude-code', actorClass: actor, config, runs: [], now: epoch,
    env: ctx.env, actors: async () => [actor], quota: adapterQuotaReader({ stateRoot: ctx.root, config, env: ctx.env, now: ctx.now }) });
  assert.equal(selected.account.id, 'extra');
  assert.equal(fake.calls.filter((c) => c.command === 'claude').length, 2);
  assert.equal(fake.calls.filter((c) => c.command === 'codex').length, 1);
});
test('status exposes each account rotation with localized reasons', async (t) => {
  const ctx = await world(t, ['extra']);
  await ctx.credentials(); await ctx.credentials('extra');
  for (const locale of ['en', 'pt-BR']) {
    const table = await statusTable(ctx.root, { ...ctx, locale, config: configOf(ctx.config), all: true,
      clients: ['claude-code'], demands: [], record: false,
      readQuota: async (_client, id) => observation(id ?? 'default', id ? 15 : 90, 90).reading,
      detectClients: async () => ({ clients: [{ client: 'claude-code', installed: true, source: 'catalog', models: [] }] }),
      plugin: {}, versions: { 'claude-code': { installed: true } },
      run: async () => ({ code: 0, stdout: '' }) });
    assert.deepEqual(table.rows.map((row) => row.rotation.reason), ['eligible', 'session']);
    assert.ok(table.markdown.includes(locale === 'pt-BR' ? 'Elegível para rotação.' : 'Eligible for rotation.')); // locale:pt-BR
    assert.ok(table.markdown.includes(locale === 'pt-BR' ? 'cota da sessão' : 'Session quota')); // locale:pt-BR
  }
});
