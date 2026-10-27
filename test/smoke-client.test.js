import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.js';
import { tick } from '../src/daemon.js';
import { loadConfig, TOOLS, TOOL_NAMES } from '../src/mcp/tools.js';
import { readJson, writeJsonAtomic } from '../src/state.js';
import { invokeClient, runClientSmoke, smokePreflight } from '../src/smoke/client.js';
import { clientEnv } from './helpers/env.js';
import { collectStatusline } from '../src/quota/statusline-collector.js';
import { adapterQuotaReader } from '../src/status.js';

const HELP = '--output-format --include-hook-events --verbose --max-budget-usd --permission-mode --no-session-persistence';

test('demo settings do not change the numeric limits of the C1–C23 runner', async (t) => {
  const f = await fixture(t, { smoke: { demoMaxReworkRounds: 0, demoDemandMaxUsd: null,
    demoRequireQuotaConfirmation: false } });
  const result = await runClientSmoke(['--rehearsal'], f.io);
  assert.equal(result.code, 0);
  assert.equal(f.calls.length, 0);
});

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'okit-client-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plugin = join(root, 'installed-okit');
  await mkdir(join(plugin, 'hooks'), { recursive: true });
  await writeJsonAtomic(join(plugin, 'hooks/hooks.json'), { hooks: {} });
  const profiles = Object.fromEntries(['simple', 'normal', 'hard'].map((effort) =>
    [effort, { model: effort, effort: 'medium', maxTurns: 1 }]));
  await writeJsonAtomic(join(root, 'config.json'), { profiles: { 'claude-code': profiles }, smoke: options.smoke ?? {} });
  await writeJsonAtomic(join(root, 'quota/claude-code.json'), { remainingPct: options.quota ?? 80 });
  const lines = []; const calls = [];
  // The client of the smoke is claude-code, so the environment names it: the
  // markers of the machine that runs the suite never decide what it sees.
  const env = clientEnv('claude-code', { OKWORK_HOME: root, CLAUDE_CONFIG_DIR: join(root, 'real-config') });
  const io = { root, env,
    out: (line) => lines.push(line), err: (line) => lines.push(line),
    run: async ({ args }) => {
      assert.equal(args[0], join(plugin, 'src/cli.js'));
      return tick(root, { spawn: async () => { throw new Error('must never spawn'); } });
    },
    client: async (request) => {
      calls.push(request);
      if (request.args[0] === '--help') return { stdout: HELP };
      if (options.respond) {
        const response = await options.respond(request);
        if (response) return response;
      }
      const init = { type: 'system', subtype: 'init', plugins: [{ name: 'okit', path: plugin }],
        skills: (options.skills ?? ['okit-director', 'okit-executor', 'okit-critic', 'okit-smoke', 'okit-setup'])
          .map((name) => `okit:${name}`),
        mcp_servers: [{ name: 'okit', status: 'connected' }], tools: TOOL_NAMES.map((name) => `mcp__okit__${name}`) };
      const events = [init, { type: 'system', subtype: 'hook_response', path: plugin }];
      for (const operation of [request.operation, request.operation?.then].filter((entry) => entry?.tool)) {
        const tool = TOOLS.find((entry) => entry.name === operation.tool);
        let value; let isError = false;
        try { value = await tool.handler(operation.arguments, { root, env,
          ...(options.realQuota ? { readQuota: adapterQuotaReader({ stateRoot: root, env,
            config: await loadConfig(root) }) } : {}) }); }
        catch (error) { value = JSON.stringify({ error: error.message }); isError = true; }
        const id = `${request.step.id}-${operation.tool}`;
        events.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: `mcp__okit__${operation.tool}` }] } });
        events.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id,
          content: value, is_error: isError }] } });
      }
      events.push({ type: 'result', total_cost_usd: options.cost ?? 0, num_turns: 1,
        result: 'MODEL PROSE MUST NOT BE KEPT' });
      return { events };
    } };
  return { root, plugin, io, calls, lines };
}

test('all checks pass with real tool JSON and disk evidence, using the installed target by default', async (t) => {
  const f = await fixture(t);
  const result = await runClientSmoke([], f.io);
  assert.equal(result.code, 0, JSON.stringify(result.records.filter((entry) => entry.status !== 'pass')));
  assert.equal(result.records.length, 23);
  for (const request of f.calls) {
    assert.deepEqual(request.env, f.io.env);
    assert.ok(!request.args.includes('--plugin-dir'));
    assert.ok(!request.args.includes('--max-turns'));
  }
  const artifact = (await readFile(result.artifacts.jsonl, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(artifact[0].kind, 'smoke-in-client');
  assert.equal(artifact[0].client, 'claude-code');
  assert.equal(artifact.length, result.records.length + 1);
  assert.ok(!JSON.stringify(artifact).includes('MODEL PROSE MUST NOT BE KEPT'));
  assert.match(result.artifacts.log, /logs[/\\]smoke[/\\]smoke-\d{8}T\d{6}Z-\d+\.log$/);
  assert.deepEqual((await readJson(join(f.root, 'inbox.json'))).items, []);
});

// Must pass / must refuse: all four namespaced skills pass C2; actor skills alone fail.
test('C2 fails when the installed session lacks okit-smoke', async (t) => {
  const f = await fixture(t, { skills: ['okit-director', 'okit-executor', 'okit-critic'] });
  const result = await runClientSmoke([], f.io);
  assert.equal(result.code, 1);
  assert.equal(result.records.find(({ id }) => id === 'C2').status, 'fail');
});

// Must pass / must refuse corpus: the classification inputs come from SCENARIO;
// the fake executes core handlers, including at-cap and invalid-move refusals.
test('wrong tool JSON fails even when the model claims success', async (t) => {
  const f = await fixture(t, { respond: async ({ step }) => step.id === 'C6' ? { events: [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Everything passed!' }] } },
  ] } : null });
  const result = await runClientSmoke([], f.io);
  assert.equal(result.code, 1);
  assert.equal(result.records.find((entry) => entry.id === 'C6').status, 'fail');
});

test('quota below floor refuses before any client call and records the header reason', async (t) => {
  const f = await fixture(t, { quota: 5, smoke: { quotaFloorPct: 10 } });
  const result = await runClientSmoke([], f.io);
  assert.equal(result.code, 2);
  assert.deepEqual(result.records, []);
  assert.equal(f.calls.length, 0);
  assert.equal(JSON.parse((await readFile(result.artifacts.jsonl, 'utf8')).trim()).reason, 'quota-below-floor');
  assert.match(await readFile(result.artifacts.log, 'utf8'), /quota-below-floor/);
});

test('unknown quota needs explicit opt-in', async (t) => {
  const f = await fixture(t);
  await rm(join(f.root, 'quota/claude-code.json'));
  assert.equal((await runClientSmoke([], f.io)).code, 2);
  assert.equal(f.calls.length, 0);
  const allowed = await runClientSmoke(['--allow-unknown-quota'], f.io);
  assert.equal(allowed.code, 0);
  assert.ok(f.lines.some((line) => line.includes('explicitly allowed')));
});

// | Must pass | Must refuse |
// | recent automatic Codex/OpenCode reading | absent, stale, invalid or another client's reading |
async function automaticQuotaFixture(t, client, { readingClient = client, ageMinutes = 1,
  percentage = 80, smoke = {} } = {}) {
  const f = await fixture(t, { smoke, realQuota: true });
  await rm(join(f.root, 'quota/claude-code.json'));
  const now = Date.now(), recorded = now - ageMinutes * 60_000;
  f.io.now = () => now;
  delete f.io.env.CLAUDECODE;
  Object.assign(f.io.env, clientEnv(client), { HOME: f.root,
    CODEX_SESSIONS_DIR: join(f.root, 'sessions') });
  const config = await readJson(join(f.root, 'config.json'));
  config.configuredClients = [...new Set([client, readingClient].filter(Boolean))];
  config.profiles[client] = config.profiles['claude-code'];
  if (readingClient === 'claude-code') {
    await collectStatusline({ stateRoot: f.root, now: () => recorded,
      input: JSON.stringify({ rate_limits: { five_hour: {
        used_percentage: 100 - percentage, resets_at: now / 1000 + 3600 } } }) });
  } else if (readingClient === 'opencode') {
    const file = join(f.root, 'provider.json');
    await writeJsonAtomic(file, { version: 1, company: 'example', source: 'test', read_at: recorded / 1000,
      five_hour: { remaining_percent: percentage, reset_at: null }, weekly: null });
    config.opencodeQuota = { sources: { example: { file } } };
  } else if (readingClient === 'codex') {
    await mkdir(f.io.env.CODEX_SESSIONS_DIR);
    await writeFile(join(f.io.env.CODEX_SESSIONS_DIR, 'rollout-test.jsonl'), JSON.stringify({
      timestamp: new Date(recorded).toISOString(), type: 'event_msg', payload: {
        type: 'token_count', rate_limits: { primary: {
          used_percent: 100 - percentage, window_minutes: 300, resets_at: now / 1000 + 3600 } } } }));
  }
  await writeJsonAtomic(join(f.root, 'config.json'), config);
  return f;
}

test('smoke accepts its own automatic collector, including OpenCode and Codex quota', async (t) => {
  for (const client of ['claude-code', 'opencode', 'codex']) {
    const f = await automaticQuotaFixture(t, client);
    const result = await runClientSmoke(['--client', client], f.io);
    assert.equal(result.code, 0, `${client}: ${JSON.stringify(result.records.filter((r) => r.status === 'fail'))}`);
    assert.notEqual(result.reason, 'quota-unknown', client);
    assert.ok(f.calls.length > 0, client);
    const header = JSON.parse((await readFile(result.artifacts.jsonl, 'utf8')).split('\n')[0]);
    assert.equal(header.quota.source, 'automatic', client);
    assert.equal(header.quota.remainingPct, 80, client);
  }
});

test('automatic smoke readings refuse missing, old, invalid and other-client data before calls', async (t) => {
  for (const client of ['codex', 'opencode']) {
    const smoke = { quotaMaxAgeMinutes: 2, quotaExpireMinutes: 4 };
    for (const [name, options] of [
      ['missing', { readingClient: null }], ['old', { ageMinutes: 3 }],
      ['negative percentage', { percentage: -1 }], ['excess percentage', { percentage: 101 }],
      ['other client', { readingClient: client === 'codex' ? 'opencode' : 'codex' }],
    ]) {
      const f = await automaticQuotaFixture(t, client, { ...options, smoke });
      const result = await runClientSmoke(['--client', client], f.io);
      assert.equal(result.code, 2, `${client}/${name}`);
      assert.equal(result.reason, 'quota-unknown', `${client}/${name}`);
      assert.equal(f.calls.length, 0, `${client}/${name}`);
    }
  }
});

test('Codex/OpenCode smoke refuses old automatic readings unless explicitly allowed', async (t) => {
  for (const client of ['codex', 'opencode']) {
    const f = await automaticQuotaFixture(t, client, { ageMinutes: 3,
      smoke: { quotaMaxAgeMinutes: 2, quotaExpireMinutes: 4 } });
    const refused = await runClientSmoke(['--client', client], f.io);
    assert.equal(refused.code, 2, client);
    assert.equal(refused.reason, 'quota-unknown', client);
    assert.equal(f.calls.length, 0, client);

    const allowed = await runClientSmoke(['--client', client, '--allow-unknown-quota'], f.io);
    assert.equal(allowed.code, 0, client);
    assert.ok(f.calls.length > 0, client);
  }
});

test('smoke accepts fresh automatic Codex and OpenCode readings', () => {
  for (const client of ['codex', 'opencode']) {
    const snapshot = { now: 1_000, clients: [{ client, quota: {
      source: 'automatic', remainingPct: 80, ageMinutes: 1,
    } }] };
    assert.equal(smokePreflight(snapshot, client, { quotaMaxAgeMinutes: 30,
      quotaExpireMinutes: 120, quotaFloorPct: 20 }).refusal, null, client);
  }
});

test('preflight refuses absent, expired, invalid and other-client readings', () => {
  const budget = { quotaMaxAgeMinutes: 30, quotaExpireMinutes: 120, quotaFloorPct: 20 };
  const cases = [
    { clients: [{ client: 'codex', quota: null }] },
    { clients: [{ client: 'codex', quota: { source: 'automatic', remainingPct: 80, ageMinutes: 121 } }] },
    { clients: [{ client: 'codex', quota: { source: 'automatic', remainingPct: 101, ageMinutes: 1 } }] },
    { clients: [{ client: 'codex', quota: { remainingPct: 80 }, reading: { expired: true } }] },
    { clients: [{ client: 'codex', quota: { remainingPct: 80 },
      reading: { expiresAt: new Date(1_000).toISOString() } }] },
    { clients: [{ client: 'opencode', quota: { source: 'automatic', remainingPct: 80, ageMinutes: 1 } }] },
  ];
  for (const snapshot of cases) {
    assert.equal(smokePreflight({ now: 1_000, ...snapshot }, 'codex', budget).refusal, 'quota-unknown');
  }
});

test('smoke refuses invalid percentages and ages, including NaN, before calls', async (t) => {
  for (const client of ['codex', 'opencode']) {
    for (const invalid of [
      ...[-1, 101, NaN, Infinity, '80', null].map((remainingPct) => ({ remainingPct })),
      ...[-1, NaN, Infinity, '1'].map((ageMinutes) => ({ ageMinutes })),
    ]) {
      const f = await automaticQuotaFixture(t, client, { smoke: { quotaFloorPct: 0 } });
      const result = await runClientSmoke(['--client', client], { ...f.io,
        readQuota: async () => ({ source: 'user', remainingPct: 80, ageMinutes: 1, ...invalid }) });
      assert.equal(result.reason, 'quota-unknown', `${client}: ${String(Object.values(invalid)[0])}`);
      assert.equal(result.code, 2);
      assert.equal(f.calls.length, 0);
    }
  }
});

test('preflight preserves manual readings and observations without an age', () => {
  const budget = { quotaMaxAgeMinutes: 2, quotaExpireMinutes: 4, quotaFloorPct: 20 };
  for (const client of ['claude-code', 'codex', 'opencode']) {
    for (const source of ['user', 'manual', 'automatic']) {
      for (const ageMinutes of [undefined, null, 0, 4]) {
        const quota = { source, remainingPct: 80, ageMinutes };
        const result = smokePreflight({ clients: [{ client, quota }] }, client, budget);
        assert.equal(result.refusal, null, `${client}/${source}/${ageMinutes}`);
        assert.equal(result.stale, ageMinutes > budget.quotaMaxAgeMinutes);
      }
    }
  }
});

test('smoke reads only its own quota, including unknown, low and expired readings', async (t) => {
  for (const [own, reason] of [[{ source: 'user' }, 'quota-unknown'],
    [{ source: 'automatic', remainingPct: 5 }, 'quota-below-floor'],
    [{ source: 'automatic', remainingPct: 80, ageMinutes: 5 }, 'quota-unknown']]) {
    const f = await fixture(t, { smoke: { quotaExpireMinutes: 4 } });
    const readClients = [];
    const result = await runClientSmoke([], { ...f.io, readQuota: async (client) => {
      readClients.push(client);
      return client === 'claude-code' ? own : { source: 'user', remainingPct: 99 };
    } });
    assert.equal(result.code, 2);
    assert.equal(result.reason, reason);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(readClients, ['claude-code']);
  }
});

test('quota set unblocks smoke and the recorded floor still refuses', async (t) => {
  const f = await fixture(t);
  await rm(join(f.root, 'quota/claude-code.json'));
  assert.equal((await runClientSmoke([], f.io)).reason, 'quota-unknown');
  for (const [pct, code] of [[80, 0], [5, 2]]) {
    assert.equal(await main(['quota', 'set', 'claude-code', String(pct)],
      { ...f.io, stdout: f.io.out }), 0);
    const result = await runClientSmoke([], f.io);
    assert.equal(result.code, code, JSON.stringify(result.records.filter((entry) => entry.status === 'fail')));
    if (code === 2) assert.equal(result.reason, 'quota-below-floor');
  }
});

test('configured quota age warns, expires, and honors explicit opt-in', async (t) => {
  const f = await fixture(t, { smoke: { quotaMaxAgeMinutes: 2, quotaExpireMinutes: 4 } });
  const recorded = Date.now();
  await main(['quota', 'set', 'claude-code', '80'], { ...f.io, now: () => recorded, stdout: f.io.out });
  const io = { ...f.io, now: () => recorded + 3 * 60_000 };
  const warned = await runClientSmoke([], io);
  assert.equal(warned.code, 0, JSON.stringify(warned.records.filter((entry) => entry.status === 'fail')));
  assert.ok(f.lines.some((line) => line.startsWith('quota-stale:')));
  const expired = { ...f.io, now: () => recorded + 5 * 60_000 };
  assert.equal((await runClientSmoke([], expired)).reason, 'quota-unknown');
  assert.equal((await runClientSmoke(['--allow-unknown-quota'], expired)).code, 0);
});

test('check timeout aborts the fake client, fails the check and skips the rest', async (t) => {
  let signal;
  const f = await fixture(t, { smoke: { checkTimeoutMs: 25 }, respond: async (request) => {
    if (request.step.id !== 'C6') return null;
    signal = request.signal;
    return new Promise(() => {});
  } });
  const result = await runClientSmoke(['--only=C6,C7'], f.io);
  assert.equal(result.code, 1);
  assert.equal(result.records.find((entry) => entry.id === 'C6').error, 'timeout');
  assert.ok(signal.aborted);
  assert.equal(result.records.at(-1).status, 'skip');
});

test('each configured ceiling stops before another step and names the first limit', async (t) => {
  for (const limit of ['maxUsd', 'maxTurns', 'maxMinutes']) {
    let time = Date.now();
    const f = await fixture(t, { smoke: { [limit]: { maxUsd: 0.5, maxTurns: 5, maxMinutes: 0.1 }[limit] },
      cost: limit === 'maxUsd' ? 0.25 : 0,
      respond: async ({ step }) => { if (limit === 'maxMinutes' && step.id === 'C6') time += 6001; } });
    const result = await runClientSmoke([], { ...f.io, now: () => time });
    assert.equal(result.code, 0, `${limit}: ${JSON.stringify(result.records)}`);
    assert.equal(result.stopped, `smoke.${limit}`);
    if (limit === 'maxTurns') {
      assert.equal(result.records.filter((entry) => entry.status !== 'skip').length, 5,
        'the runner must execute exactly maxTurns scenario steps');
    }
    if (limit === 'maxUsd') {
      assert.equal(f.calls.filter((request) => request.step).length, 2,
        'two USD 0.25 client calls must exhaust the USD 0.50 ceiling');
    }
    assert.ok(result.records.some((entry) => entry.status === 'skip'));
    assert.match(await readFile(result.artifacts.log, 'utf8'), /PARCIAL/);
    assert.ok(f.lines.some((line) => line === `ceiling: smoke.${limit}`));
  }
});

test('client money exhaustion and permission denial skip with fixed reasons', async (t) => {
  for (const [resultEvent, reason] of [
    [{ terminal_reason: 'budget_exhausted', subtype: 'error_max_budget_usd' }, 'budget-exhausted'],
    [{ permission_denials: [{ tool_name: 'limits_status' }] }, 'permission-denied'],
  ]) {
    const f = await fixture(t, { respond: async ({ step }) => step.id === 'C6'
      ? { events: [{ type: 'result', ...resultEvent }] } : null });
    const result = await runClientSmoke([], f.io);
    assert.equal(result.records.find((entry) => entry.id === 'C6').error, reason);
    assert.equal(result.code, 0);
  }
});

// Must pass / must refuse table, the two lines the runner always prints:
// | case                 | must pass                                                                   | must refuse |
// | a normal run         | 'smoke: start client=claude-code mode=real' and 'smoke: end exit=0 artifacts=<folder>' as the last line | - |
// | an offline dry run   | the same two lines, with mode=dry-run and exit=0                            | - |
// | an unknown quota     | the same two lines, with exit=2                                             | - |
// | an unknown flag      | the end line with exit=2                                                   | - |
function assertRunnerLines(lines, { mode, code, folder }) {
  const start = lines.findIndex((line) => line.startsWith('smoke: start '));
  const end = lines.findIndex((line) => line.startsWith('smoke: end '));
  assert.ok(start >= 0, `the runner must print a start line: ${JSON.stringify(lines)}`);
  assert.ok(end > start, `the runner must print an end line after the start one: ${JSON.stringify(lines)}`);
  assert.equal(lines[start], `smoke: start client=claude-code mode=${mode}`);
  assert.equal(lines[end], `smoke: end exit=${code} artifacts=${folder}`);
  assert.equal(lines.at(-1), lines[end], 'the end line must be the last line of the output');
}

test('the runner always prints its start and end lines', async (t) => {
  const normal = await fixture(t);
  const result = await runClientSmoke([], normal.io);
  assert.equal(result.code, 0);
  assertRunnerLines(normal.lines, { mode: 'real', code: 0, folder: join(normal.root, 'logs', 'smoke') });

  const offline = await fixture(t);
  assert.equal((await runClientSmoke(['--dry-run'], offline.io)).code, 0);
  assertRunnerLines(offline.lines, { mode: 'dry-run', code: 0, folder: join(offline.root, 'logs', 'smoke') });

  const refused = await fixture(t);
  await rm(join(refused.root, 'quota/claude-code.json'));
  assert.equal((await runClientSmoke([], refused.io)).code, 2);
  assertRunnerLines(refused.lines, { mode: 'real', code: 2, folder: join(refused.root, 'logs', 'smoke') });

  const unknown = await fixture(t);
  assert.equal((await runClientSmoke(['--wat'], unknown.io)).code, 2);
  assertRunnerLines(unknown.lines, { mode: 'real', code: 2, folder: join(unknown.root, 'logs', 'smoke') });
});

test('the end line names the folder the artifacts landed in', async (t) => {
  const f = await fixture(t);
  const result = await runClientSmoke([], f.io);
  const folder = join(f.root, 'logs', 'smoke');
  const end = f.lines.find((line) => line.startsWith('smoke: end '));
  assert.ok(end.endsWith(`artifacts=${folder}`));
  assert.equal(dirname(result.artifacts.jsonl), folder);
  assert.equal(dirname(result.artifacts.log), folder);
});

test('rehearsal and dry run walk SCENARIO and expose configured maximum without calling a client', async (t) => {
  const f = await fixture(t, { smoke: { maxUsd: 0.75 } });
  for (const flag of ['--rehearsal', '--dry-run']) {
    const result = await runClientSmoke([flag], { ...f.io, client: () => assert.fail('must not call client'),
      run: () => assert.fail('must not run daemon'), readQuota: () => assert.fail('must not read quota') });
    assert.equal(result.code, 0);
    assert.ok(f.lines.some((line) => line.startsWith('C23 ')));
    assert.ok(f.lines.some((line) => line.includes('maximum USD 0.75')));
  }
});

test('CLI rejects unknown flags, clients, ids and invalid budgets with code 2', async (t) => {
  const f = await fixture(t);
  for (const args of [['--wat'], ['--client', 'codex'], ['--only', 'I1'], ['--max-usd=-1'],
    ['--max-turns=1.5'], ['--timeout=no'], ['--only']]) {
    assert.equal(await main(['client-smoke', ...args], { ...f.io, client: undefined,
      stdout: f.io.out, stderr: f.io.err }), 2);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(await main(['client-smoke', '--help'], { stdout: f.io.out }), 0);
  assert.equal(await main(['client-smoke', '--rehearsal'], { ...f.io, stdout: f.io.out }), 0);
});

test('skipping installation is unproven; missing configuration says incomplete', async (t) => {
  const f = await fixture(t);
  await rm(join(f.plugin, 'hooks/hooks.json'));
  const noHooks = await runClientSmoke([], f.io);
  assert.equal(noHooks.code, 1);
  assert.equal(noHooks.records.find((entry) => entry.id === 'C4').error, 'hook-evidence-unavailable');
  await writeJsonAtomic(join(f.plugin, 'hooks/hooks.json'), {});
  await rm(join(f.root, 'config.json'));
  const missing = await runClientSmoke([], f.io);
  assert.equal(missing.code, 0);
  assert.equal(missing.records.find((entry) => entry.id === 'C14').error, 'config-missing');
  assert.match(await readFile(missing.artifacts.log, 'utf8'), /installation is incomplete/);
});

test('overrides, valueless flags, keep, demo and only use the same runner', async (t) => {
  const f = await fixture(t, { smoke: { maxTurns: 5 } });
  const result = await runClientSmoke(['--max-turns', '--max-usd=0.8', '--keep', '--demo'], f.io);
  assert.equal(result.budget.maxTurns, 5);
  assert.equal(result.budget.maxUsd, 0.8);
  assert.equal(result.code, 0);
  assert.ok(f.lines.some((line) => line.startsWith('C1 ')));
  const only = await runClientSmoke(['--only=C6'], f.io);
  assert.equal(only.records.length, 1);
  assert.equal(only.code, 1); // C1–C5 were not proven.
});

test('the process driver consumes chunked JSON from an injected child and honours cancellation', async () => {
  const seen = [];
  const fakeSpawn = (command, args, { signal }) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    signal?.addEventListener('abort', () => {
      const error = new Error('aborted'); error.name = 'AbortError'; child.emit('error', error);
    }, { once: true });
    queueMicrotask(() => {
      if (signal) return;
      child.stdout.emit('data', '{"type":"result",');
      child.stdout.emit('data', '"total_cost_usd":0}\n');
      child.emit('close', 0);
    });
    return child;
  };
  const response = await invokeClient({ args: [], spawn: fakeSpawn,
    onEvent: (event) => seen.push(event.type) });
  assert.deepEqual(seen, ['result']);
  assert.equal(response.events[0].total_cost_usd, 0);
  const controller = new AbortController();
  const pending = invokeClient({ args: [], spawn: fakeSpawn, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('unsupported client flags refuse before scenario execution', async (t) => {
  const f = await fixture(t);
  const result = await runClientSmoke([], { ...f.io, client: async () => ({ stdout: '--verbose' }) });
  assert.equal(result.code, 2);
  assert.deepEqual(result.records, []);
  assert.equal(result.reason, 'client-refused');
});

test('built-in driver refuses Codex and OpenCode client selections', async (t) => {
  for (const client of ['codex', 'opencode']) {
    const f = await fixture(t);
    const result = await runClientSmoke(['--client', client], { ...f.io, client: undefined });
    assert.equal(result.code, 2, client);
    assert.ok(f.lines.some((line) => line.includes(`Unknown client ${client}`)), client);
    assert.equal(f.calls.length, 0, client);
  }
});

test('injected driver still refuses an unknown client name', async (t) => {
  const f = await fixture(t);
  let called = false;
  const result = await runClientSmoke(['--client', 'nao-existe'], { ...f.io,
    client: async () => { called = true; return { stdout: HELP }; } });
  assert.equal(result.code, 2);
  assert.ok(f.lines.some((line) => line.includes('Unknown client nao-existe')));
  assert.equal(called, false);
});

test('CLI headless passes and failures return 0 and 1 with the injected client', async (t) => {
  const f = await fixture(t);
  assert.equal(await main(['client-smoke', '--headless'], { ...f.io, stdout: f.io.out, stderr: f.io.err }), 0);
  const bad = await fixture(t, { respond: async ({ step }) => step.id === 'C6'
    ? { events: [{ type: 'result', is_error: true, subtype: 'error_during_execution', total_cost_usd: 0 }] } : null });
  assert.equal(await main(['client-smoke'], { ...bad.io, stdout: bad.io.out, stderr: bad.io.err }), 1);
});

test('the daemon preparation refuses foreign pending work and keeps it intact', async (t) => {
  const f = await fixture(t);
  await writeJsonAtomic(join(f.root, 'inbox.json'), { version: 1, seq: 1,
    items: [{ id: 'I000001', title: 'foreign', status: 'pending', body: 'unchanged' }] });
  const result = await runClientSmoke([], f.io);
  assert.equal(result.code, 1);
  assert.equal(result.records.find((entry) => entry.id === 'C5').error, 'client-refused');
  assert.deepEqual((await readJson(join(f.root, 'inbox.json'))).items,
    [{ id: 'I000001', title: 'foreign', status: 'pending', body: 'unchanged' }]);
});

test('denying a prerequisite skips dependent checks instead of blaming the plugin', async (t) => {
  const f = await fixture(t, { respond: async ({ step }) => step.id === 'C7' ? { events: [
    { type: 'result', total_cost_usd: 0, permission_denials: [{ tool_name: 'acquire_slot' }] },
  ] } : null });
  const result = await runClientSmoke([], f.io);
  assert.equal(result.code, 0);
  assert.equal(result.records.find((entry) => entry.id === 'C7').error, 'permission-denied');
  assert.equal(result.records.find((entry) => entry.id === 'C9').error, 'client-refused');
});
