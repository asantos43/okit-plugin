import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseAccount, accountReasonText, ACCOUNT_REASON_TEXTS } from '../src/accounts-choose.js';
import { configOf } from '../src/profiles.js';
import { CONFIG_SCHEMA, entryAccepts } from '../src/config-schema.js';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn as realSpawn } from 'node:child_process';
import { tick } from '../src/daemon.js';
import { inboxAdd } from '../src/inbox.js';
import { makeSpawner } from '../src/spawn-process.js';
import { readJson, writeJsonAtomic } from '../src/state.js';
import { accountChoice, readRunRecords } from '../src/limits.js';
import { environmentSnapshot } from '../src/env/snapshot.js';
import { listActors } from '../src/actors.js';
import { readinessRows } from '../src/doctor/ready-rows.js';

const now = Date.UTC(2026, 10, 5);
const week = 10080 * 60_000;
const actorClass = { name: 'hard', model: 'opus', effort: 'high' };
const window = (remainingPct, windowMinutes, left = week / 2) => ({ remainingPct, windowMinutes,
  resetsAt: new Date(now + left).toISOString() });
const account = (id = 'default', weekly = 80, session = 90) => ({ client: 'claude-code', id,
  login: 'logged-in', actors: [{ model: 'opus', effort: 'high' }],
  reading: { windows: [window(session, 300), window(weekly, 10080)] } });
const choose = (accounts, extra = {}) => chooseAccount({ client: 'claude-code', actorClass, accounts, now, ...extra });
const freeze = (value) => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

test('real daemon launches the roomiest saved account, then another at its cap; logged-out never launches', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'd121-wiring-'));
  const children = [], launched = [], checked = [];
  t.after(async () => {
    for (const child of children) { child.removeAllListeners('close'); child.kill(); }
    for (let attempt = 0; attempt < 100; attempt++) {
      const runs = await readRunRecords(root);
      if (runs.every((run) => run.endedAt)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await rm(root, { recursive: true, force: true });
  });
  const accounts = ['a', 'b', 'out'].map((id) => ({ id, label: id, configDir: join(root, id) }));
  for (const entry of accounts) {
    await mkdir(join(entry.configDir, 'sessions'), { recursive: true });
    if (entry.id !== 'out') await writeFile(join(entry.configDir, 'auth.json'), '');
    await writeFile(join(entry.configDir, 'sessions', 'rollout-quota.jsonl'), JSON.stringify({
      timestamp: new Date(now).toISOString(), type: 'event_msg', payload: { type: 'token_count', rate_limits: {
        primary: { used_percent: 10, window_minutes: 300, resets_at: (now + week / 2) / 1000 },
        secondary: { used_percent: entry.id === 'a' ? 20 : 5, window_minutes: 10080, resets_at: (now + week / 2) / 1000 },
      } },
    }) + '\n');
  }
  await writeJsonAtomic(join(root, 'config.json'), { accounts: { codex: accounts }, limits: { global: 1 },
    profiles: { codex: { normal: { model: 'm', effort: 'high' } } },
    setup: { done: { profiles: { codex: { normal: { model: 'm', effort: 'high' } } } } },
    telemetry: { enabled: true, dir: 'telemetry', kitExecutable: 'd121-no-kit' } });
  const spawn = makeSpawner({ logDir: join(root, 'runs'), cwd: root, env: { HOME: root },
    spawn(_command, _args, options) {
      launched.push(options.env.CODEX_HOME);
      const child = realSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], options);
      children.push(child);
      return child;
    } });
  await spawn({ title: 'boundary probe' }, { client: 'codex', account: 'a', runId: 'probe', profile: { model: 'm', effort: 'high' } });
  assert.ok(children[0].pid > 0, 'real subprocess started before policy assertions');
  await writeJsonAtomic(join(root, 'runs', 'probe.json'), { runId: 'probe', status: 'done', client: 'codex', account: 'a' });
  launched.length = 0;
  const preflight = spawn.preflight;
  spawn.preflight = async (item, options) => { checked.push({ ...options }); return preflight(item, options); };
  const deps = { spawn, now: () => now, env: { HOME: root },
    run: async () => ({ stdout: JSON.stringify([{ slug: 'm', visibility: 'list' }]), code: 0 }) };
  for (let index = 0; index < 3; index++) {
    await inboxAdd(root, { title: `demand ${index}`, client: 'codex', effort: 'normal' });
    await tick(root, deps);
  }
  assert.deepEqual(launched, [accounts[1].configDir, accounts[0].configDir]);
  assert.deepEqual(checked.map((options) => options.account), ['b', 'a']);
  assert.ok(checked.every((options) => options.accountReason === 'chosen'));
  const runs = (await readRunRecords(root)).filter((run) => run.runId !== 'probe');
  assert.deepEqual(runs.map((run) => [run.chosenAccount, run.accountReason]).sort(), [['a', 'chosen'], ['b', 'chosen']]);
  const events = await Promise.all((await readdir(join(root, 'telemetry'))).map((file) => readJson(join(root, 'telemetry', file))));
  const choices = events.flatMap((event) => event.resourceMetrics[0].scopeMetrics[0].metrics)
    .filter((metric) => metric.name === 'okit.plugin.quota.check').map((metric) => Object.fromEntries(
      metric.sum.dataPoints[0].attributes.map(({ key, value }) => [key, value.stringValue]))).filter((event) => event.reason === 'chosen');
  assert.deepEqual(choices.map((event) => event.account), ['b', 'a']);
  assert.ok(children.every((child) => child.pid > 0), 'crosses the real subprocess boundary');
});

async function policyScene(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'd121-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const accounts = ['a', 'b'].map((id) => ({ id, label: id, configDir: join(root, id) }));
  for (const entry of accounts) { await mkdir(entry.configDir); await writeFile(join(entry.configDir, 'auth.json'), ''); }
  const config = { accounts: { codex: accounts },
    profiles: { codex: Object.fromEntries(['simple', 'normal', 'hard'].map((name) => [name, { model: 'm', effort: 'high' }])) }, ...extra };
  await writeJsonAtomic(join(root, 'config.json'), config);
  const launches = [], checked = [];
  const spawn = Object.assign(async (_item, options) => { launches.push({ ...options }); return { runId: options.runId }; },
    { preflight: async (_item, options) => { checked.push({ ...options }); } });
  const deps = { spawn, env: { HOME: root }, now: () => now, actors: async () => [{ model: 'm', effort: 'high' }],
    quota: async (_client, id) => account(id, id === 'b' ? 60 : 90).reading };
  return { root, config, deps, launches, checked };
}

// | Launch evidence | Must pass | Must refuse |
// | no saved accounts | configured profiles | requiring listing/setup for policy |
// | catalog without this client's setup | configured profiles on every account | — |
// | catalog + setup | matching client confirmation on extras | changed model/effort |
// | listing with or without setup | model listed by that account | account omits the model |
test('daemon and doctor share account availability before and after client setup', async (t) => {
  const cases = [
    { client: 'codex', setup: 'none', listed: 'none', saved: false, expected: 'default' },
    { client: 'claude-code', setup: 'none', expected: 'a' },
    { client: 'claude-code', setup: 'other-client', expected: 'a' },
    { client: 'claude-code', setup: 'matching', expected: 'a' },
    { client: 'claude-code', setup: 'changed-model', expected: null },
    { client: 'claude-code', setup: 'changed-effort', expected: null },
    { client: 'codex', setup: 'none', listed: 'none', expected: null },
    { client: 'codex', setup: 'none', listed: 'default', expected: 'default' },
    { client: 'codex', setup: 'none', listed: 'all', expected: 'a' },
    { client: 'codex', setup: 'matching', listed: 'all', expected: 'a' },
  ];
  for (const { client, setup, listed, saved = true, expected } of cases) await t.test(`${client}/${setup}/${listed ?? 'catalog'}/${saved}`, async (t) => {
    const { root, deps, launches } = await policyScene(t);
    const pair = { model: client === 'codex' ? 'm' : 'opus', effort: 'high' };
    const profiles = { [client]: Object.fromEntries(['simple', 'normal', 'hard'].map((name) => [name,
      { ...pair, effort: client === 'codex' ? configOf({}).profiles.codex[name].effort : pair.effort }])) };
    const config = { accounts: { [client]: [{ id: 'default', label: 'default' },
      { id: 'a', label: 'extra', configDir: join(root, 'a') }] }, profiles };
    if (!saved) delete config.accounts;
    if (setup !== 'none') config.setup = { done: { profiles: setup === 'other-client'
      ? { codex: { normal: { model: 'other', effort: 'high' } } } : structuredClone(profiles) } };
    if (setup.startsWith('changed-')) for (const saved of Object.values(config.setup.done.profiles[client])) {
      saved[setup === 'changed-model' ? 'model' : 'effort'] = setup === 'changed-model' ? 'other' : 'low';
    }
    await writeJsonAtomic(join(root, 'config.json'), config);
    delete deps.actors;
    deps.env.ANTHROPIC_API_KEY = 'test-key';
    await mkdir(join(root, '.codex'));
    await writeFile(join(root, '.codex', 'auth.json'), '');
    deps.run = async ({ args, env }) => ({ code: 0, stdout: args.includes('--version') ? '1.0.0'
      : JSON.stringify(listed === 'all' || listed === 'default' && env.CODEX_HOME !== join(root, 'a')
        ? [{ slug: 'm', visibility: 'list' }] : []) });
    deps.quota = async (_client, id) => account(id, id === 'a' ? 90 : 40).reading;
    const snapshot = await environmentSnapshot({ root, config, ...deps, client, record: false,
      readQuota: deps.quota, plugin: {}, versions: { [client]: { installed: true } } });
    const choices = snapshot.accountChoices.filter((choice) => choice.client === client);
    assert.equal(choices.length, 3);
    assert.ok(choices.every((choice) => choice.account === expected), JSON.stringify(choices));
    if (client === 'claude-code') for (const row of snapshot.clients[0].accounts) {
      assert.equal(row.models.includes('opus'), expected === 'a');
      assert.equal(row.actors.some((actor) => actor.model === 'opus'), expected === 'a');
    }
    for (const locale of ['en', 'pt-BR']) {
      const actors = await listActors({ snapshot, client, locale });
      assert.deepEqual(actors.accountChoices, choices);
      const doctor = readinessRows({ snapshot, ui: { locale }, program: 'okit-plugin' });
      assert.equal(doctor.rows.filter((row) => row.id === 'account-policy').length, 3);
      assert.ok(choices.every((choice) => doctor.rows.some((row) => row.id === 'account-policy'
        && row.detail.includes(accountReasonText(choice.reason, locale)))));
    }
    for (const choice of choices) {
      await inboxAdd(root, { title: 'same choice', client, effort: choice.actorClass });
      const result = await tick(root, deps);
      assert.equal(result.spawned.length, expected === null ? 0 : 1, JSON.stringify(result.skipped));
      assert.equal(launches.at(-1)?.account ?? null, choice.account);
      assert.equal(choice.reason.code, expected === null ? 'actor' : launches.at(-1).accountReason);
    }
  });
});

test('setup confirmation refuses changed catalog pairs and extras missing a listed model', async (t) => {
  for (const source of ['catalog', 'listing']) {
    const { root, config, deps, launches } = await policyScene(t);
    await mkdir(join(root, '.codex'));
    await writeFile(join(root, '.codex', 'auth.json'), '');
    if (source === 'catalog') {
      config.setup = { done: { profiles: { codex: { normal: { model: 'other', effort: 'high' } } } } };
      deps.run = async () => ({ code: 1, stdout: '' });
    } else {
      config.setup = { done: { profiles: config.profiles } };
      deps.run = async ({ env }) => ({ code: 0,
        stdout: JSON.stringify(['a', 'b'].some((id) => env.CODEX_HOME === join(root, id))
          ? [] : [{ slug: 'm', visibility: 'list' }]) });
    }
    await writeJsonAtomic(join(root, 'config.json'), config);
    delete deps.actors;
    deps.quota = async (_client, id) => account(id, id ? 90 : 40).reading;
    await inboxAdd(root, { title: 'confirmed work', client: 'codex', effort: 'normal' });
    const result = await tick(root, deps);
    assert.equal(result.spawned.length, source === 'catalog' ? 0 : 1, JSON.stringify(result.skipped));
    assert.deepEqual(launches.map((options) => options.account), source === 'catalog' ? [] : ['default']);
    if (source === 'catalog') assert.match(result.skipped[0].reason, /does not offer this model and effort/);
  }
});

test('daemon reviews receive the executor account and preflight uses the launch decision', async (t) => {
  for (const role of ['critic', 'verifier', undefined]) {
    const { root, deps, launches, checked } = await policyScene(t);
    await writeJsonAtomic(join(root, 'runs', 'executor.json'), {
      runId: 'executor', demand: 'D1', role: 'executor', client: 'codex', account: 'a', status: 'done', startedAt: now - 100,
    });
    const demand = await inboxAdd(root, { title: 'review', client: 'codex', effort: 'normal',
      ext: { ...role ? { role, executorAccount: 'a' } : {}, critic_of: 'D1' } });
    const result = await tick(root, deps);
    assert.equal(result.spawned.length, 1);
    assert.equal(launches[0].executorAccount, 'a');
    assert.equal(launches[0].account, 'b', 'eligible review account differs from executor even with less quota');
    assert.equal(checked[0].account, launches[0].account);
    assert.equal(checked[0].accountReason, launches[0].accountReason);
    assert.equal(launches[0].role, role ?? 'critic');
    assert.equal(checked[0].role, launches[0].role);
    const store = await readJson(join(root, 'inbox.json'));
    assert.equal(store.items.find((item) => item.id === demand.id).ext.executorAccount, role ? 'a' : undefined);
  }
});

test('an inferred critic role reaches the process run record', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'd121-role-'));
  let child;
  t.after(async () => {
    if (child?.exitCode === null) {
      child.ref();
      const closed = new Promise((resolve) => child.once('close', resolve));
      child.kill();
      await closed;
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await readRunRecords(root)).every((run) => run.endedAt)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await rm(root, { recursive: true, force: true });
  });
  await writeJsonAtomic(join(root, 'config.json'), { profiles: { codex: { normal: { model: 'm', effort: 'high' } } } });
  const spawn = makeSpawner({ logDir: join(root, 'runs'), cwd: root, env: { HOME: root },
    spawn(_command, _args, options) {
      child = realSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], options);
      return child;
    } });
  await inboxAdd(root, { title: 'inferred review', client: 'codex', effort: 'normal', ext: { critic_of: 'D1' } });
  const result = await tick(root, { spawn, env: { HOME: root }, now: () => now });
  assert.equal(result.spawned.length, 1, JSON.stringify(result.skipped));
  const run = await readJson(join(root, 'runs', `${result.spawned[0].runId}.json`));
  assert.equal(run.role, 'critic');
});

test('relinking a daemon slot preserves the chosen account and reason', async (t) => {
  const { root, deps } = await policyScene(t);
  deps.spawn = async () => ({ runId: 'relinked' });
  await inboxAdd(root, { title: 'relink', client: 'codex', effort: 'normal' });
  const result = await tick(root, deps);
  assert.equal(result.spawned[0].runId, 'relinked');
  const run = await readJson(join(root, 'runs', 'relinked.json'));
  assert.equal(run.account, 'a');
  assert.equal(run.chosenAccount, 'a');
  assert.equal(run.accountReason, 'chosen');
});

test('daemon quota telemetry separates the client from each cached account', async (t) => {
  const { root, deps } = await policyScene(t, {
    telemetry: { enabled: true, dir: 'telemetry', kitExecutable: 'd121-no-kit' },
  });
  await inboxAdd(root, { title: 'telemetry', client: 'codex', effort: 'normal' });
  await tick(root, deps);
  const files = await readdir(join(root, 'telemetry'));
  const events = await Promise.all(files.map((file) => readJson(join(root, 'telemetry', file))));
  const readings = events.flatMap((event) => event.resourceMetrics[0].scopeMetrics[0].metrics)
    .filter((metric) => metric.name === 'okit.plugin.quota.check').map((metric) => Object.fromEntries(
      metric.sum.dataPoints[0].attributes.map(({ key, value }) => [key, value.stringValue])))
    .filter((event) => !event.reason);
  assert.deepEqual(readings.map((event) => [event.client, event.account]).sort(),
    [['codex', undefined], ['codex', 'a'], ['codex', 'b']].sort());
});

test('enforced pace defers before any run, waits for the instant, and leaves named accounts and continuations fixed', async (t) => {
  const { root, deps, launches, checked } = await policyScene(t, { language: 'pt-BR', accountPolicy: { enforcePace: true } });
  deps.quota = async () => account('a', 20).reading;
  const demand = await inboxAdd(root, { title: 'hard work', client: 'codex', effort: 'hard' });
  const first = await tick(root, deps);
  assert.match(first.skipped[0].reason, /trabalho difícil deve esperar/);
  assert.equal(launches.length, 0);
  assert.equal(checked.length, 0);
  assert.deepEqual(await readRunRecords(root), []);
  const store = await readJson(join(root, 'inbox.json'));
  const waiting = store.items.find((item) => item.id === demand.id);
  assert.equal(waiting.ext.wait_until, now + week * .15);
  await tick(root, deps);
  assert.equal(launches.length, 0);
  for (const ext of [{ account: 'b' }, { resumeSession: { account: 'a' } }]) {
    await inboxAdd(root, { title: 'fixed', client: 'codex', effort: 'hard', ext });
    await tick(root, deps);
  }
  assert.deepEqual(launches.map((options) => options.account), ['b', 'a']);
  deps.now = () => waiting.ext.wait_until;
  await tick(root, deps);
  assert.equal(launches.length, 3);
});

test('doctor and actors expose the current policy choice and its reason in both languages', async (t) => {
  const { root, config, deps } = await policyScene(t);
  const snapshot = await environmentSnapshot({ root, config, env: deps.env, now: deps.now, client: 'codex',
    readQuota: deps.quota, plugin: {}, versions: { codex: { installed: true } },
    detectClients: async () => ({ clients: [{ client: 'codex', installed: true, source: 'listing', models: ['m'] }] }) });
  const choice = snapshot.accountChoices.find((choice) => choice.actorClass === 'normal');
  assert.equal(choice.account, 'a');
  assert.equal(choice.reason.code, 'chosen');
  for (const locale of ['en', 'pt-BR']) {
    const actors = await listActors({ snapshot, locale });
    assert.deepEqual(actors.accountChoices, snapshot.accountChoices);
    assert.ok(actors.markdown.includes(accountReasonText(choice.reason, locale)));
    const doctor = readinessRows({ snapshot, ui: { locale }, program: 'okit-plugin' });
    assert.ok(doctor.rows.some((row) => row.id === 'account-policy' && row.account === 'a'
      && row.detail.includes(accountReasonText(choice.reason, locale))));
    assert.doesNotMatch(doctor.rows.filter((row) => row.id === 'account-policy').map((row) => row.detail).join(' '), /--|okit-plugin|\bkit\b/);
  }
});

// | Snapshot corpus | Must pass | Must refuse |
// | absent, implicit or saved default | optional note | account choices in actors/doctor |
// | installed, implicit or saved default | account choices | dropping the default |
test('absent clients have no policy choices, with or without a saved default', async () => {
  for (const installed of [false, true]) for (const saved of [false, true]) {
    const snapshot = await environmentSnapshot({ client: 'codex', env: {}, now: () => now,
      config: { profiles: { codex: { simple: null, normal: { model: 'm', effort: 'medium' }, hard: null } },
        ...saved ? { accounts: { codex: [{ id: 'default', label: 'default' }] } } : {} },
      plugin: {}, versions: { codex: { installed } }, readQuota: async () => ({ source: 'off' }),
      fs: { readFile: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } },
      detectClients: async () => ({ clients: [{ client: 'codex', installed, source: 'listing', models: ['m'] }] }) });
    assert.equal(snapshot.accountChoices.length, installed ? 1 : 0);
    for (const locale of ['en', 'pt-BR']) {
      const actors = await listActors({ snapshot, client: 'codex', locale });
      const doctor = readinessRows({ snapshot, ui: { locale }, program: 'okit-plugin' });
      assert.equal(doctor.rows.filter((row) => row.id === 'account-policy').length, installed ? 1 : 0);
      if (!installed) assert.deepEqual(actors.notes, [locale === 'en'
        ? 'codex: not installed (optional).' : 'codex: não instalado (opcional).']);
    }
  }
});

test('one account passes without changing inputs or reading credentials', () => {
  const accounts = freeze([account()]);
  const result = choose(accounts);
  assert.equal(result.account, accounts[0]);
  assert.equal(result.reason.code, 'chosen');
  assert.equal(result.reason.weeklyHeadroom, 30);
  assert.deepEqual(choose(accounts), result);
});

// | Filter corpus | Must pass | Must refuse |
// | login | logged-in, unknown, absent | logged-out |
// | actor | exact model + effort | missing model or effort |
// | windows | unknown, above floor | session/weekly at or below floor |
// | slots | done/stale/other account | live at cap, unknown start time |
test('each filter refuses independently and urgency never bypasses filters', () => {
  const cases = [
    [{ ...account(), login: 'logged-out' }, {}, 'login'],
    [{ ...account(), actors: [] }, {}, 'actor'],
    [{ ...account(), actors: [{ model: 'opus', effort: 'low' }] }, {}, 'actor'],
    [account('default', 80, 10), { settings: { accountPolicy: { minQuotaPct: 10 } } }, 'session'],
    [account('default', 0), {}, 'weekly'],
    [account(), { settings: { limits: { global: 1 } }, runs: [
      { client: 'claude-code', status: 'live' },
    ] }, 'busy'],
  ];
  for (const [entry, extra, code] of cases) {
    const result = choose([entry], { ...extra, actorClass: { ...actorClass, urgent: true } });
    assert.deepEqual(result.wait_until, null);
    assert.equal(result.reason.code, code);
    assert.equal(result.account, undefined);
  }
});

test('unknown or absent login passes, ranks last and still obeys other filters and session pinning', () => {
  for (const login of ['unknown', undefined]) {
    const uncertain = { ...account('a'), login };
    if (login === undefined) delete uncertain.login;
    const known = account('z', 60, 60);
    const result = choose([uncertain]);
    assert.equal(result.account, uncertain);
    assert.equal(result.reason.code, 'unknown');
    assert.equal(choose([uncertain, known]).account, known);
    assert.equal(choose([known, uncertain]).account, known);
    assert.equal(choose([known, uncertain], { resumeSession: { account: 'a' } }).account, uncertain);
    uncertain.reading.windows[1].remainingPct = 0;
    assert.equal(choose([uncertain]).reason.code, 'weekly');
  }
});

test('weekly headroom uses own percentages and time to reset, then session, load, recency and id', () => {
  const a = account('a', 70);
  const b = account('b', 90);
  assert.equal(choose([a, b]).account.id, 'b');
  b.reading.windows[1].resetsAt = new Date(now + week).toISOString();
  assert.equal(choose([b, a]).account.id, 'a');
  assert.equal(choose([account('b'), account('a')]).account.id, 'a');
  assert.equal(choose([account('a', 80, 40), account('b')]).account.id, 'b');
  const runs = [{ client: 'claude-code', account: 'a', status: 'live', startedAt: now }];
  assert.equal(choose([account('a'), account('b')], { runs }).account.id, 'b');
  runs[0].status = 'done';
  assert.equal(choose([account('a'), account('b')], { runs }).account.id, 'b');
});

test('final id tie-break is independent of input order when all scores are equal', () => {
  const a = account('a'), z = account('z');
  assert.equal(choose([a, z]).account, a);
  assert.equal(choose([z, a]).account, a);
  a.login = 'logged-out';
  z.actors = [];
  assert.equal(choose([z, a]).reason.code, 'login');
});

test('unknown windows rank last but do not bar; known exhausted window still bars', () => {
  const unknown = { ...account('a'), reading: null };
  assert.equal(choose([unknown, account('z', 20, 20)]).account.id, 'z');
  assert.equal(choose([unknown]).reason.code, 'unknown');
  unknown.reading = { windows: [window(0, 300)] };
  assert.equal(choose([unknown]).reason.code, 'session');
  unknown.reading = { remainingPct: 80 };
  assert.equal(choose([unknown]).account.id, 'a');
});

test('continuations pin their account even when another has more quota', () => {
  const accounts = [account('a', 20), account('b')];
  assert.equal(choose(accounts, { resumeSession: { account: 'a' } }).account.id, 'a');
  accounts[0].reading.windows[1].remainingPct = 0;
  assert.equal(choose(accounts, { resumeSession: { account: 'a' } }).reason.code, 'weekly');
  assert.equal(choose(accounts, { resumeSession: { account: 'removed' } }).reason.code, 'session-account');
  assert.equal(choose(accounts, { resumeSession: {} }).reason.code, 'session-account');
});

test('critic and verifier prefer another eligible account; preference cannot override pin or filters', () => {
  for (const role of ['critic', 'verifier']) {
    const actor = { ...actorClass, role, executorAccount: 'a' };
    const accounts = [account('a'), account('b', 30)];
    assert.equal(choose(accounts, { actorClass: actor }).account.id, 'b');
    assert.equal(choose(accounts, { actorClass: actor, resumeSession: { account: 'a' } }).account.id, 'a');
    accounts[1].login = 'logged-out';
    assert.equal(choose(accounts, { actorClass: actor }).account.id, 'a');
  }
});

test('pacing defaults to advice; enforced hard work waits until the margin catches up', () => {
  const accounts = [account('default', 20)];
  assert.equal(choose(accounts).reason.code, 'ahead');
  assert.equal(choose(accounts).account, accounts[0]);
  const settings = { accountPolicy: { enforcePace: true } };
  const deferred = choose(accounts, { settings });
  assert.equal(deferred.reason.code, 'deferred');
  assert.equal(deferred.wait_until, now + week * 0.15);
  assert.ok(deferred.wait_until <= now + week / 2);
  assert.ok(choose(accounts, { settings, now: deferred.wait_until }).account);
  for (const name of ['simple', 'normal']) assert.ok(choose(accounts, {
    settings, actorClass: { ...actorClass, name },
  }).account);
  assert.ok(choose(accounts, { settings, actorClass: { ...actorClass, urgent: true } }).account);
  assert.ok(choose([account('default', 35)], { settings }).account);
  assert.ok(choose(accounts, { settings: { accountPolicy: { enforcePace: true, paceMarginPct: 30 } } }).account);
});

test('run accounting follows live status, stale timeout and legacy default account', () => {
  const runs = [{ client: 'claude-code', status: 'live', startedAt: now - 31 * 60_000 },
    { client: 'codex', status: 'live' }, { client: 'claude-code', account: 'other', status: 'live' }];
  assert.ok(choose([account()], { runs, settings: { limits: { global: 1 } } }).account);
  runs[0].startedAt = now;
  assert.equal(choose([account()], { runs, settings: { limits: { global: 1 } } }).reason.code, 'busy');
  assert.equal(choose([{ ...account(), parallelLimit: 1 }], { runs }).reason.code, 'busy');
});

test('recency rejects non-finite values; equal windows use the tightest quota; negatives are exhausted', () => {
  for (const lastLaunchedAt of [NaN, Infinity, 'yesterday', {}]) {
    assert.equal(choose([{ ...account('a'), lastLaunchedAt }, account('b')]).account.id, 'a');
  }
  for (const minutes of [300, 10080]) {
    const entry = account();
    entry.reading.windows.push(window(-1, minutes));
    assert.equal(choose([entry]).reason.code, minutes === 300 ? 'session' : 'weekly');
    entry.reading.windows.reverse();
    assert.equal(choose([entry]).reason.code, minutes === 300 ? 'session' : 'weekly');
  }
  assert.equal(choose([account('a', 20)], { resumeSession: { account: 'a' },
    settings: { accountPolicy: { enforcePace: true } } }).reason.code, 'ahead');
  assert.throws(() => configOf({ accountPolicy: { minQuotaPct: -1 } }), /accountPolicy.minQuotaPct.*0–100/);
  assert.throws(() => configOf({ accountPolicy: { enforcePace: 1 } }), /accountPolicy.enforcePace.*true \| false/);
});

test('assembling and choosing 20 accounts reuses 500 pre-read run records within 20 ms', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'd121-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'runs'));
  await Promise.all(Array.from({ length: 500 }, (_, index) => writeJsonAtomic(join(root, 'runs', `${index}.json`), {
    client: 'codex', account: `a-${index % 20}`, status: 'done', startedAt: index,
  })));
  const runs = await readRunRecords(root);
  assert.equal(runs.length, 500);
  const config = configOf({ accounts: { codex: Array.from({ length: 19 }, (_, index) => ({
    id: `a-${index}`, label: `Account ${index}`, configDir: join(root, `a-${index}`),
  })) } });
  const input = { client: 'codex', config, runs, now, actorClass: 'normal',
    actors: async () => Object.values(config.profiles.codex),
    quota: async () => account().reading, fs: { stat: async () => ({ isFile: () => true }),
      readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } } };
  const start = performance.now();
  assert.ok((await accountChoice(input)).account);
  const elapsed = performance.now() - start;
  t.diagnostic(`20 accounts + 500 runs: ${elapsed.toFixed(2)} ms (records reused)`);
  assert.ok(elapsed < 20, `assembly + chooseAccount took ${elapsed} ms`);
});

const golden = [
  ['chosen', 'Account selected by available weekly quota.', 'Conta escolhida pela cota semanal disponível.'],
  ['unknown', 'Account selected with unknown login or quota information.', 'Conta escolhida com informação de login ou cota desconhecida.'],
  ['login', 'The account is not logged in.', 'A conta não está logada.'],
  ['actor', 'The account does not offer this model and effort.', 'A conta não oferece este modelo e esforço.'],
  ['session', 'Session quota is 10%; it must be above 10%.', 'A cota da sessão é 10%; deve estar acima de 10%.'],
  ['weekly', 'Weekly quota is 10%; it must be above 10%.', 'A cota semanal é 10%; deve estar acima de 10%.'],
  ['busy', 'The account has 2 running; the limit is 2.', 'A conta tem 2 em execução; o limite é 2.'],
  ['unavailable', 'No account is available.', 'Nenhuma conta está disponível.'],
  ['session-account', 'The account holding this session is unavailable.', 'A conta que contém esta sessão está indisponível.'],
  ['ahead', 'Weekly use is ahead of pace by more than 15 points; launch allowed.',
    'O uso semanal está mais de 15 pontos à frente do ritmo; início permitido.'],
  ['deferred', 'Weekly use is ahead of pace by more than 15 points; hard work must wait.',
    'O uso semanal está mais de 15 pontos à frente do ritmo; trabalho difícil deve esperar.'],
];
test('golden account reasons in English and Brazilian Portuguese', () => {
  assert.deepEqual(golden.map(([code]) => code).sort(), Object.keys(ACCOUNT_REASON_TEXTS.en).sort());
  for (const [code, en, pt] of golden) {
    const reason = { code, remaining: 10, minimum: 10, running: 2, limit: 2, margin: 15 };
    assert.equal(accountReasonText(reason, 'en'), en);
    assert.equal(accountReasonText(reason, 'pt-BR'), pt);
    assert.equal(accountReasonText(reason, 'unknown'), en);
  }
});

test('settings defaults, partial merge, schema limits and profile lookup', () => {
  assert.deepEqual(configOf({}).accountPolicy, { minQuotaPct: 0, paceMarginPct: 15, enforcePace: false });
  assert.equal(configOf({ accountPolicy: { enforcePace: true } }).accountPolicy.paceMarginPct, 15);
  for (const accountPolicy of [null, [], false, { minQuotaPct: -1 }, { paceMarginPct: 101 },
    { enforcePace: 'yes' }, { paceMarginPct: NaN }]) assert.throws(() => configOf({ accountPolicy }));
  for (const key of ['minQuotaPct', 'paceMarginPct']) {
    const entry = CONFIG_SCHEMA.entries.find((e) => e.path === `accountPolicy.${key}`);
    assert.ok(entryAccepts(entry, 15));
    assert.equal(entryAccepts(entry, -1), false);
    assert.equal(entryAccepts(entry, 101), false);
  }
  assert.ok(choose([account()], { actorClass: 'hard', settings: configOf({}) }).account);
  assert.equal(choose([account()], { actorClass: 'absent' }).reason.code, 'actor');
  assert.equal(choose([]).reason.code, 'unavailable');
  assert.throws(() => choose([account()], { now: undefined }), /timestamp/);
});
