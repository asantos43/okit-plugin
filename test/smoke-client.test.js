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
import { clientRequest, invokeClient, invokeCodex, invokeOpenCode, runClientSmoke, smokePreflight } from '../src/smoke/client.js';
import { smokeDemo } from '../src/smoke/demo/entry.js';
import { clientEnv } from './helpers/env.js';
import { collectStatusline } from '../src/quota/statusline-collector.js';
import { adapterQuotaReader } from '../src/status.js';
import { configOf } from '../src/profiles.js';

const HELP = '--output-format --include-hook-events --verbose --max-budget-usd --permission-mode --no-session-persistence --json --skip-git-repo-check --sandbox --approve-for-me --ephemeral --format --dir --auto';

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
  await writeJsonAtomic(join(root, 'config.json'), { profiles: { 'claude-code': profiles },
    smoke: options.smoke ?? {}, smokeDrivers: options.smokeDrivers });
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
      if (request.args.includes('--help')) return { stdout: `${HELP} --json --format` };
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
  if (client === 'codex') config.smoke = { ...config.smoke, maxTokens: 100_000 };
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
  if (client === 'codex') {
    const respond = f.io.client;
    f.io.client = async (request) => {
      const response = await respond(request);
      if (request.step && response.events) response.events.at(-1).usage = { input_tokens: 1, output_tokens: 1 };
      return response;
    };
  }
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
  for (const args of [['--wat'], ['--client', 'unknown'], ['--only', 'I1'], ['--max-usd=-1'],
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

// Must pass / must refuse corpus:
// | input | must pass | must refuse |
// | native tool output and terminal event | tool evidence, usage when supplied | model prose as evidence |
// | non-zero exit with a result / without a result | preserve result | missing result |
// | missing executable / abort | - | every client |
// | Codex without money / at text ceiling | continue below ceiling | further calls at ceiling |
// | whole placeholder / literal or unknown placeholder | replace known whole placeholder | replacing literals |
// | result before child termination | resolve even after abort/kill | no result |
// | negative cost / missing text usage with a ceiling | stop new work | another call |
// | Codex with a stray money total | count text normally | money accounting replacing text accounting |
// | known / unknown client preview | known clients, no spawn | unknown names |
const nativeLines = {
  codex: [
    { type: 'thread.started', thread_id: 'example' }, { type: 'turn.started' },
    { type: 'item.started', item: { id: 'tool-1', type: 'mcp_tool_call', server: 'okit', tool: 'limits_status', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'tool-1', type: 'mcp_tool_call', server: 'okit', tool: 'limits_status',
      status: 'completed', result: { content: [{ type: 'text', text: '{"ok":true}' }] }, error: null } },
    { type: 'item.completed', item: { id: 'text-1', type: 'agent_message', text: 'Ready' } },
    { type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 0, output_tokens: 15 } },
  ],
  opencode: [
    { type: 'step_start', part: { type: 'step-start' } },
    { type: 'tool_use', part: { type: 'tool', callID: 'tool-1', tool: 'okit_limits_status',
      state: { status: 'completed', input: {}, output: '{"ok":true}' } } },
    { type: 'step_finish', part: { type: 'step-finish', reason: 'tool-calls', cost: 0.01,
      tokens: { input: 10, output: 5 } } },
    { type: 'text', part: { type: 'text', text: 'Ready' } },
    { type: 'step_finish', part: { type: 'step-finish', reason: 'stop', cost: 0.02,
      tokens: { input: 3, output: 2 } } },
  ],
};

function fakeChild(lines, { exit = 0, killed, error, capture = () => {} } = {}) {
  return (command, args, options) => {
    capture(command, args, options);
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    options.signal?.addEventListener('abort', () => {
      child.emit('error', Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }, { once: true });
    queueMicrotask(() => {
      if (error) { child.emit('error', error); return; }
      const output = lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n');
      child.stdout.emit('data', output.slice(0, 7));
      child.stdout.emit('data', output.slice(7)); // Last line deliberately has no newline.
      child.emit('close', exit, killed);
    });
    return child;
  };
}

test('each driver launches configured argv and streams native evidence', async () => {
  for (const [client, driver, expected] of [
    ['claude-code', invokeClient, ['-p', 'Say ready', '--output-format', 'stream-json', '--include-hook-events', '--verbose',
      '--max-budget-usd', '0.5', '--permission-mode', 'default', '--no-session-persistence']],
    ['codex', invokeCodex, ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--approve-for-me', '--ephemeral', 'Say ready']],
    ['opencode', invokeOpenCode, ['run', '--format', 'json', '--dir', '/scratch', '--auto', 'Say ready']],
  ]) {
    const request = { ...clientRequest(client, {}, { briefing: 'Say ready', maxUsd: 0.5, cwd: '/scratch' }), cwd: '/scratch' };
    const seen = [];
    const result = await driver({ ...request, env: { TEST: 'yes' },
      spawn: fakeChild(nativeLines[client] ?? [{ type: 'result', total_cost_usd: 0 }], {
        capture: (command, args, options) => {
          assert.equal(command, client === 'claude-code' ? 'claude' : client);
          assert.deepEqual(args, expected); assert.deepEqual(options.env, { TEST: 'yes' });
          assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
          if (client !== 'claude-code') assert.equal(options.cwd, '/scratch');
        },
      }), onEvent: (event) => seen.push(event) });
    assert.deepEqual(result.events, seen);
    assert.equal(seen.at(-1).type, 'result');
    if (nativeLines[client]) assert.equal(seen.filter((event) => event.message?.content[0]?.type === 'tool_result').length, 1);
    if (client === 'codex') {
      assert.equal(seen.at(-1).total_cost_usd, undefined);
      assert.deepEqual(seen.at(-1).usage, { input_tokens: 120, cached_input_tokens: 0, output_tokens: 15 });
    }
    if (client === 'opencode') {
      assert.equal(seen.at(-1).total_cost_usd, 0.03);
      assert.deepEqual(seen.at(-1).usage, { input_tokens: 13, output_tokens: 7 });
    }
  }
});

test('drivers reject failed exits, missing programs and aborts', async () => {
  for (const driver of [invokeClient, invokeCodex, invokeOpenCode]) {
    await assert.rejects(driver({ args: [], spawn: fakeChild([], { exit: 1 }) }),
      /The helper stopped before finishing\. \/ O ajudante parou antes de terminar\./);
    await assert.rejects(driver({ args: [], spawn: fakeChild([], {
      error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
    }) }), /Install .* and sign in.*Instale/);
    await assert.rejects(driver({ args: [], spawn: () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } }), /Install/);
    const controller = new AbortController();
    const pending = driver({ args: [], signal: controller.signal, spawn: fakeChild([]) });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  }
});

test('non-zero exits preserve result events, including Claude budget exhaustion', async () => {
  for (const [driver, lines] of [
    [invokeClient, [{ type: 'result', is_error: true, total_cost_usd: 0.5,
      subtype: 'error_max_budget_usd', terminal_reason: 'budget_exhausted' }]],
    [invokeClient, [{ type: 'result', is_error: true, subtype: 'error_during_execution' }]],
    [invokeCodex, nativeLines.codex], [invokeOpenCode, nativeLines.opencode],
  ]) {
    const response = await driver({ args: [], spawn: fakeChild(lines, { exit: 1 }) });
    assert.equal(response.events.at(-1).type, 'result');
    if (driver === invokeClient) assert.deepEqual(response.events, lines);
    const killedAfterResult = await driver({ args: [], spawn: fakeChild(lines, { exit: null, killed: 'SIGTERM' }) });
    assert.equal(killedAfterResult.events.at(-1).type, 'result');
    await assert.rejects(driver({ args: [], spawn: fakeChild([], { exit: 1, killed: 'SIGTERM' }) }),
      /The helper stopped before finishing\. \/ O ajudante parou antes de terminar\./);
  }
});

test('a result event is preserved when the child is aborted or killed afterwards', async () => {
  for (const [driver, lines] of [
    [invokeClient, [{ type: 'result', total_cost_usd: 0 }]],
    [invokeCodex, nativeLines.codex], [invokeOpenCode, nativeLines.opencode],
  ]) {
    const controller = new AbortController();
    const response = await driver({ args: [], signal: controller.signal, spawn: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
        controller.abort(); // A result already arrived before the child's abort error.
        child.emit('error', Object.assign(new Error('aborted'), { name: 'AbortError' }));
        child.emit('close', 0);
      });
      return child;
    } });
    assert.equal(response.events.at(-1).type, 'result');
    assert.ok(controller.signal.aborted);
  }
});

test('the Claude driver attaches partial state and keeps stderr in artifacts only', async (t) => {
  const raw = { type: 'step_finish', part: { reason: 'tool-calls', cost: 0.2,
    tokens: { input: 8, output: 3 } } };
  await assert.rejects(invokeOpenCode({ args: [], spawn: (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stdout.emit('data', JSON.stringify(raw));
      child.stderr.emit('data', 'private child diagnostic');
      child.emit('close', 1);
    });
    return child;
  } }), (error) => {
    assert.equal(error.state.cost, 0.2);
    assert.equal(error.events.length, 0);
    assert.equal(error.stderr, 'private child diagnostic');
    return true;
  });

  const f = await fixture(t);
  const spawn = (command, args, options) => {
    if (args.includes('--help')) return fakeChild([HELP])(command, args, options);
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stderr.emit('data', 'private child diagnostic');
      child.emit('close', 1);
    });
    return child;
  };
  const result = await runClientSmoke(['--only=C6,C11'], { ...f.io, client: undefined, spawn,
    readQuota: async () => ({ source: 'user', remainingPct: 80 }) });
  assert.equal(result.records[0].status, 'fail');
  assert.ok(f.lines.every((line) => !line.includes('private child diagnostic')));
  assert.match(await readFile(result.artifacts.jsonl, 'utf8'), /private child diagnostic/);
});

test('command, help and prompt arguments can be replaced through configuration', () => {
  for (const client of ['claude-code', 'codex', 'opencode']) {
    const config = { smokeDrivers: { [client]: { command: 'custom', helpArgs: ['help'], args: ['{briefing}', '{maxUsd}'] } } };
    assert.deepEqual(clientRequest(client, config, { briefing: 'literal $HOME', maxUsd: 0.2 }).args, ['literal $HOME', '0.2']);
    assert.equal(clientRequest(client, config).command, 'custom');
    assert.deepEqual(clientRequest(client, config, { help: true }).args, ['help']);
  }
  const config = { smokeDrivers: { codex: { args: ['-p', 'apb', '{briefing}', '{unknown}', '--text={briefing}', '{briefing}x'] } } };
  assert.deepEqual(clientRequest('codex', config, { '': 'wrong', p: 'wrong', briefing: 'ready' }).args,
    ['-p', 'apb', 'ready', '{unknown}', '--text={briefing}', '{briefing}x']);
});

test('a real-shaped Claude budget result with non-zero exit becomes a skip', async (t) => {
  const f = await fixture(t);
  const result = await runClientSmoke(['--only=C6,C7'], { ...f.io, client: undefined,
    spawn: (command, args, options) => fakeChild(args.includes('--help') ? [HELP] : [
      { type: 'result', is_error: true, subtype: 'error_max_budget_usd',
        terminal_reason: 'budget_exhausted', total_cost_usd: 0.5 },
    ], { exit: args.includes('--help') ? 0 : 1 })(command, args, options) });
  assert.equal(result.stopped, 'smoke.maxUsd', JSON.stringify({ records: result.records, lines: f.lines }));
  assert.ok(result.records.every((record) => record.status === 'skip' && record.error === 'budget-exhausted'));
});

test('demo previews both clients without spending and retains confirmation protection', async (t) => {
  const f = await fixture(t, { smoke: { maxUsd: 0.75 } });
  for (const client of ['codex', 'opencode']) {
    for (const locale of ['en', 'pt-BR']) {
      const config = await loadConfig(f.root);
      const snapshot = { now: Date.now(), config, inUse: client, clients: [{ client,
        quota: { source: 'automatic', remainingPct: 80, ageMinutes: 1 }, candidates: [], slots: {} }] };
      const deps = { ...f.io, snapshot, spawn: () => assert.fail('preview must not spawn'),
        actor: { run: () => assert.fail('preview must not launch') } };
      const preview = await smokeDemo({ client, locale, dryRun: true }, deps);
      assert.equal(preview.exitCode, 0); assert.equal(preview.plan.client, client);
      assert.equal(preview.plan.limits.maxUsd, 0.75);
      assert.match(preview.text, new RegExp(client));
      if (client === 'codex') {
        assert.doesNotMatch(preview.text, /USD 0\.75/);
        assert.match(preview.text, locale === 'en' ? /no money ceiling is available/ : /não há teto de dinheiro disponível/);
        assert.match(preview.text, locale === 'en' ? /limited by time and the number of steps/ : /limitado pelo tempo e pelo número de passos/);
        assert.match(preview.text, locale === 'en' ? /no ceiling on the amount of text/ : /Não há teto para a quantidade de texto/);
        assert.match(preview.text, locale === 'en' ? /does not report a money total/ : /não informa o custo em dinheiro/);
      } else {
        assert.match(preview.text, /USD 0\.75/);
        assert.match(preview.text, locale === 'en' ? /stops at the money ceiling/ : /param ao atingir o teto em dinheiro/);
        assert.match(preview.text, locale === 'en' ? /Time and the number of steps are also limited/ : /tempo e o número de passos também são limitados/);
      }
      assert.doesNotMatch(preview.text, /reportsCost|input_tokens|output_tokens/);
      assert.doesNotMatch(preview.text, /text units|small units/i);
      const refused = await smokeDemo({ client, locale, confirm: 'outdated' }, deps);
      assert.equal(refused.exitCode, 2); assert.equal(refused.confirmed, false);
      assert.equal(f.calls.length, 0);
      if (client === 'codex') {
        const cappedConfig = { ...config, smoke: { ...config.smoke, maxTokens: 500 } };
        const capped = await smokeDemo({ client, locale, dryRun: true }, { ...deps,
          snapshot: { ...snapshot, config: cappedConfig } });
        assert.equal(capped.exitCode, 0); assert.equal(capped.plan.limits.maxTokens, 500);
        assert.match(capped.text, locale === 'en' ? /500 in the helper's measure of text read and written/ : /500 na medição de texto lido e escrito pelo ajudante/);
        assert.notEqual(capped.planHash, preview.planHash);
      }
    }
  }
});

test('native subprocess tool answers reach the existing checks', async (t) => {
  for (const client of ['codex', 'opencode']) {
    const f = await fixture(t, { smoke: { maxTokens: client === 'codex' ? 1000 : null } });
    const tool = TOOLS.find((entry) => entry.name === 'limits_status');
    const answer = await tool.handler({}, { root: f.root, env: f.io.env });
    const lines = structuredClone(nativeLines[client]);
    if (client === 'codex') lines[3].item.result = { content: [{ type: 'text', text: answer }] };
    else lines[1].part.state.output = answer;
    const calls = [];
    const result = await runClientSmoke(['--client', client, '--only', 'C6'], { ...f.io, client: undefined,
      readQuota: async () => ({ source: 'user', remainingPct: 80 }),
      spawn: (command, args, options) => {
        calls.push([command, args]);
        return fakeChild(args.includes('--help') ? [HELP] : lines)(command, args, options);
      } });
    assert.equal(result.records[0]?.status, 'pass', `${client}: ${JSON.stringify({ records: result.records, lines: f.lines })}`);
    assert.equal(calls[0][0], client);
    assert.deepEqual(calls[0][1], [client === 'codex' ? 'exec' : 'run', '--help']);
    assert.equal(calls.length, 2);
  }
});

test('full Codex and OpenCode scenarios skip unavailable install evidence without paid calls', async (t) => {
  for (const client of ['codex', 'opencode']) {
    const f = await fixture(t, { smoke: { maxTokens: 100_000 } });
    const config = await readJson(join(f.root, 'config.json'));
    config.profiles[client] = config.profiles['claude-code'];
    await writeJsonAtomic(join(f.root, 'config.json'), config);
    await writeJsonAtomic(join(f.root, `quota/${client}.json`), { remainingPct: 80 });
    const env = clientEnv(client, { OKWORK_HOME: f.root });
    const prompts = [];
    const spawn = (command, args, options) => {
      assert.equal(command, client);
      assert.equal(options.cwd, f.root);
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(async () => {
        if (args.includes('--help')) {
          child.stdout.emit('data', HELP);
          child.emit('close', 0); return;
        }
        const prompt = args.at(-1);
        const prefix = 'Call exactly these MCP operations, preserve their arguments. Never judge success or modify other records. ';
        assert.ok(prompt.startsWith(prefix), `${client} unexpected paid prompt: ${prompt}`);
        prompts.push(prompt);
        const operation = JSON.parse(prompt.slice(prefix.length));
        const events = [];
        for (const call of [operation, operation.then].filter((entry) => entry?.tool)) {
          const tool = TOOLS.find((entry) => entry.name === call.tool);
          let value; let isError = false;
          try { value = await tool.handler(call.arguments, { root: f.root, env }); }
          catch (error) { value = { error: error.message }; isError = true; }
          const text = typeof value === 'string' ? value : JSON.stringify(value);
          if (client === 'codex') events.push({ type: 'item.completed', item: { id: `fake-${events.length}`,
            type: 'mcp_tool_call', server: 'okit', tool: call.tool,
            result: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) } } });
          else events.push({ type: 'tool_use', part: { type: 'tool', callID: `fake-${events.length}`,
            tool: `okit_${call.tool}`, state: { status: isError ? 'error' : 'completed',
              ...(isError ? { error: text } : { output: text }) } } });
        }
        events.push(client === 'codex'
          ? { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }
          : { type: 'step_finish', part: { reason: 'stop', cost: 0.01, tokens: { input: 10, output: 5 } } });
        child.stdout.emit('data', events.map((event) => JSON.stringify(event)).join('\n'));
        child.emit('close', 0);
      });
      return child;
    };
    const result = await runClientSmoke(['--client', client], { ...f.io, env, client: undefined, spawn,
      readQuota: async () => ({ source: 'user', remainingPct: 80 }) });
    assert.equal(result.code, 0, `${client}: ${JSON.stringify(result.records.filter((record) => record.status === 'fail'))}`);
    for (const id of ['C1', 'C2', 'C3', 'C4', 'C5', 'C21']) {
      const record = result.records.find((entry) => entry.id === id);
      assert.equal(record.status, 'skip', `${client}/${id}`);
      assert.match(record.error, /does not provide installation details.*não fornece detalhes da instalação/);
    }
    assert.ok(result.records.filter((record) => !['C1', 'C2', 'C3', 'C4', 'C5', 'C21'].includes(record.id))
      .every((record) => record.status === 'pass'), client);
    assert.ok(prompts.length > 0, client);
    assert.ok(prompts.every((prompt) => prompt.startsWith('Call exactly these MCP operations')), client);
  }
});

test('native tool errors and failed turns remain failures', async () => {
  for (const [driver, lines] of [
    [invokeCodex, [{ type: 'item.completed', item: { id: 'bad', type: 'mcp_tool_call', server: 'okit',
      tool: 'inbox_set_status', result: { isError: true, content: [{ type: 'text', text: 'Cannot move' }] } } },
    { type: 'turn.failed', error: { message: 'Failed' } }]],
    [invokeOpenCode, [{ type: 'tool_use', part: { type: 'tool', callID: 'bad', tool: 'okit_inbox_set_status',
      state: { status: 'error', error: 'Cannot move' } } }, { type: 'error', error: { message: 'Failed' } }]],
  ]) {
    const response = await driver({ args: [], spawn: fakeChild(lines) });
    assert.equal(response.events[1].message.content[0].is_error, true);
    assert.equal(response.events.at(-1).is_error, true);
  }
});

test('Codex ignores a late error after a completed turn', async () => {
  const response = await invokeCodex({ args: [], spawn: fakeChild([
    { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2 } },
    { type: 'error', error: { message: 'late retry notice' } },
  ]) });
  assert.equal(response.events.length, 1);
  assert.equal(response.events[0].is_error, undefined);
  assert.deepEqual(response.events[0].usage, { input_tokens: 3, output_tokens: 2 });
});

test('OpenCode rejects invalid step costs and treats zero cost with text use as unknown', async () => {
  for (const [cost, tokens] of [[-0.5, { input: 2, output: 1 }], [0, { input: 2, output: 1 }], [null, undefined]]) {
    const response = await invokeOpenCode({ args: [], spawn: fakeChild([
      { type: 'step_finish', part: { reason: 'stop', cost, ...(tokens ? { tokens } : {}) } },
    ]) });
    assert.equal(response.events.at(-1).total_cost_usd, undefined);
    if (tokens) assert.deepEqual(response.events.at(-1).usage, { input_tokens: 2, output_tokens: 1 });
    assert.equal(response.state.unknownCost, true);
  }
});

test('OpenCode zero money with measured text uses the money ceiling as an unknown cost', async (t) => {
  const f = await fixture(t, { smoke: { maxUsd: 0.5 } });
  let runs = 0;
  const result = await runClientSmoke(['--client', 'opencode', '--only=C6,C11'], { ...f.io,
    client: undefined, readQuota: async () => ({ source: 'user', remainingPct: 80 }),
    spawn: (command, args, options) => {
      if (args.includes('--help')) return fakeChild([HELP])(command, args, options);
      runs += 1;
      return fakeChild([{ type: 'step_finish', part: { reason: 'stop', cost: 0,
        tokens: { input: 10, output: 2 } } }])(command, args, options);
    } });
  assert.equal(runs, 1);
  assert.equal(result.stopped, 'smoke.maxUsd');
  assert.equal(result.spentUsd, 0.5);
  assert.equal(result.records[1].error, 'budget-exhausted');
  assert.match(f.lines.join('\n'), /Spending could not be measured/);
  assert.doesNotMatch(f.lines.join('\n'), /amount of text read and written could not be measured/);
});

test('OpenCode applies the configured text limit in addition to its money limit', async (t) => {
  const f = await fixture(t, { smoke: { maxUsd: 1, maxTokens: 10 }, respond: async () => ({ events: [
    { type: 'result', total_cost_usd: 0.01, usage: { input_tokens: 8, output_tokens: 4 } },
  ] }) });
  const result = await runClientSmoke(['--client', 'opencode', '--only=C6,C11'], { ...f.io,
    readQuota: async () => ({ source: 'user', remainingPct: 80 }) });
  assert.equal(result.stopped, 'smoke.maxTokens');
  assert.equal(result.tokens, 12);
  assert.equal(f.calls.filter((request) => request.step).length, 1);
  assert.equal(result.records[1].error, 'budget-exhausted');
  assert.doesNotMatch(f.lines.join('\n'), /Spending could not be measured|amount of text read and written could not be measured/);
});

test('partial cost and text use survive timed out, failed and result-less client runs', async (t) => {
  for (const client of ['opencode', 'codex']) for (const failure of ['timeout', 'non-zero exit', 'missing stop']) {
    const f = await fixture(t, { smoke: { maxUsd: 0.5, maxTokens: 20, checkTimeoutMs: 12 } });
    let calls = 0;
    const state = client === 'opencode'
      ? { cost: 0.75, tokens: 30, usage: { input_tokens: 20, output_tokens: 10 } }
      : { tokens: 30, usage: { input_tokens: 20, output_tokens: 10 } };
    const response = async (request) => {
      if (request.help) return { stdout: HELP };
      calls += 1;
      if (failure === 'timeout') {
        request.onProgress({ events: [], state });
        return new Promise(() => {});
      }
      if (failure === 'non-zero exit') throw Object.assign(new Error('The helper stopped before finishing.'), {
        events: [], state, stderr: 'private diagnostic from child',
      });
      return { events: [], state }; // No terminal result/stop event was received.
    };
    const result = await runClientSmoke(['--client', client, '--only=C6,C11'], { ...f.io,
      client: response, readQuota: async () => ({ source: 'user', remainingPct: 80 }) });
    assert.equal(result.code, 1, `${client}/${failure}`);
    assert.equal(calls, 1, `${client}/${failure}`);
    assert.equal(result.records[0].status, 'fail', `${client}/${failure}`);
    assert.equal(result.records[1].status, 'skip', `${client}/${failure}`);
    assert.equal(result.records[1].error, 'budget-exhausted', `${client}/${failure}`);
    if (client === 'opencode') assert.equal(result.spentUsd, 0.75, `${client}/${failure}`);
    else assert.equal(result.tokens, 30, `${client}/${failure}`);
    if (failure === 'non-zero exit') {
      assert.ok(f.lines.every((line) => !line.includes('private diagnostic from child')));
      const artifact = (await readFile(result.artifacts.jsonl, 'utf8'));
      assert.match(artifact, /private diagnostic from child/);
    }
  }
});

test('failed client runs with no usable measurement spend the remaining allowance', async (t) => {
  for (const client of ['opencode', 'codex']) {
    for (const failure of ['timeout', 'non-zero exit', 'missing stop']) {
      const f = await fixture(t, { smoke: { maxUsd: 0.5, maxTokens: 20, checkTimeoutMs: 12 } });
      let calls = 0;
      const response = async (request) => {
        if (request.help) return { stdout: HELP };
        calls += 1;
        if (failure === 'timeout') { request.onProgress({ events: [], state: {} }); return new Promise(() => {}); }
        if (failure === 'non-zero exit') throw Object.assign(new Error('The helper stopped before finishing.'), { events: [], state: {} });
        return { events: [], state: {} };
      };
      const result = await runClientSmoke(['--client', client, '--only=C6,C11'], { ...f.io,
        client: response, readQuota: async () => ({ source: 'user', remainingPct: 80 }) });
      assert.equal(calls, 1, `${client}/${failure}`);
      assert.equal(result.records[1].error, 'budget-exhausted', `${client}/${failure}`);
      if (client === 'opencode') assert.equal(result.spentUsd, 0.5, `${client}/${failure}`);
      else assert.equal(result.tokens, 20, `${client}/${failure}`);
    }
  }
});

test('missing money totals stop clients configured to report money', async (t) => {
  for (const client of ['claude-code', 'opencode', 'codex']) {
    const f = await fixture(t, { smoke: { maxTokens: client === 'codex' ? 100 : null },
      smokeDrivers: { [client]: { reportsCost: true } },
      respond: async () => ({ events: [{ type: 'result' }] }) });
    const result = await runClientSmoke(['--client', client, '--only=C6,C7'], { ...f.io,
      readQuota: async () => ({ source: 'user', remainingPct: 80 }) });
    assert.equal(result.stopped, 'smoke.maxUsd');
    assert.equal(f.calls.filter((request) => request.step).length, 1);
    assert.equal(result.records.at(-1).status, 'skip');
    assert.ok(f.lines.some((line) => line.includes('Spending could not be measured')));
  }
});

test('negative money totals are unknown cost and stop further work', async (t) => {
  for (const client of ['claude-code', 'opencode']) {
    const f = await fixture(t, { cost: -0.25 });
    const result = await runClientSmoke(['--client', client, '--only=C6,C11'], { ...f.io,
      readQuota: async () => ({ source: 'user', remainingPct: 80 }) });
    assert.equal(result.records[0].status, 'pass');
    assert.equal(result.stopped, 'smoke.maxUsd');
    assert.equal(f.calls.filter((request) => request.step).length, 1);
    assert.equal(result.records[1].status, 'skip');
    assert.equal(result.records[1].error, 'budget-exhausted');
    assert.ok(f.lines.some((line) => line.includes('Spending could not be measured')));
  }
});

test('Codex continues across replies and stops at cumulative text or step ceilings', async (t) => {
  for (const [maxTokens, maxTurns, calls, stopped] of [
    [1000, 10, 3, null], [150, 10, 2, 'smoke.maxTokens'],
    [200, 10, 2, 'smoke.maxTokens'], [1000, 2, 2, 'smoke.maxTurns'],
  ]) {
    const f = await fixture(t, { smoke: { maxUsd: 0.01, maxTokens, maxTurns } });
    const result = await runClientSmoke(['--client', 'codex', '--only=C6,C11,C12'], { ...f.io,
      readQuota: async () => ({ source: 'user', remainingPct: 80 }), client: async (request) => {
        const response = await f.io.client(request);
        if (response.events) {
          const final = response.events.at(-1);
          delete final.total_cost_usd;
          final.usage = { input_tokens: 60, output_tokens: 40, cached_input_tokens: 40 };
        }
        return response;
      } });
    assert.equal(f.calls.filter((request) => request.step).length, calls);
    assert.equal(result.tokens, calls * 100, 'cached input is already part of input, not counted twice');
    assert.equal(result.stopped, stopped);
    assert.ok(result.records.slice(0, calls).every((record) => record.status === 'pass'));
    if (stopped) assert.equal(result.records.at(-1).error, 'budget-exhausted');
    assert.equal(result.spentUsd, null);
    assert.doesNotMatch(f.lines.join('\n'), /Spending could not be measured|amount of text read and written could not be measured/);
  }
});

test('a Codex text ceiling stops further work when usage is unusable', async (t) => {
  for (const usage of [undefined, {}, { input_tokens: 10 },
    { input_tokens: -1, output_tokens: 10 }, { input_tokens: '10', output_tokens: 10 }]) {
    const f = await fixture(t, { smoke: { maxTokens: 100 },
      respond: async () => ({ events: [{ type: 'result', usage }] }) });
    const result = await runClientSmoke(['--client', 'codex', '--only=C6,C11'], { ...f.io,
      readQuota: async () => ({ source: 'user', remainingPct: 80 }) });
    assert.equal(result.stopped, 'smoke.maxTokens');
    assert.equal(f.calls.filter((request) => request.step).length, 1);
    assert.equal(result.records[1].status, 'skip');
    assert.equal(result.records[1].error, 'budget-exhausted');
    assert.ok(f.lines.some((line) => line.includes('amount of text read and written could not be measured')));
    assert.doesNotMatch(f.lines.join('\n'), /Spending could not be measured/);
  }
});

test('Codex ignores stray money totals and keeps counting text usage', async (t) => {
  const f = await fixture(t, { cost: 999, smoke: { maxUsd: 0.01, maxTokens: 200 } });
  const result = await runClientSmoke(['--client', 'codex', '--only=C6,C11,C12'], { ...f.io,
    readQuota: async () => ({ source: 'user', remainingPct: 80 }), client: async (request) => {
      const response = await f.io.client(request);
      if (response.events) response.events.at(-1).usage = { input_tokens: 60, output_tokens: 40 };
      return response;
    } });
  assert.equal(result.tokens, 200);
  assert.equal(result.stopped, 'smoke.maxTokens');
  assert.equal(f.calls.filter((request) => request.step).length, 2);
  assert.ok(result.records.slice(0, 2).every((record) => record.status === 'pass'));
  assert.equal(result.records[2].status, 'skip');
  assert.equal(result.records[2].error, 'budget-exhausted');
  assert.equal(result.spentUsd, null);
  assert.doesNotMatch(f.lines.join('\n'), /Spending could not be measured|amount of text read and written could not be measured/);
});

test('a text ceiling also guards extra requests within one check', async (t) => {
  const f = await fixture(t, { smoke: { maxTokens: 100 } });
  const result = await runClientSmoke(['--client', 'codex', '--only=C14'], { ...f.io,
    readQuota: async () => ({ source: 'user', remainingPct: 80 }), client: async (request) => {
      const response = await f.io.client(request);
      if (response.events) {
        delete response.events.at(-1).total_cost_usd;
        response.events.at(-1).usage = { input_tokens: 60, output_tokens: 40 };
      }
      return response;
    } });
  assert.equal(f.calls.filter((request) => request.step).length, 1);
  assert.equal(result.stopped, 'smoke.maxTokens');
  assert.equal(result.records.at(-1).error, 'budget-exhausted');
});

test('text allowance accepts null or positive whole numbers and refuses invalid ceilings', () => {
  for (const maxTokens of [null, 1, 500]) {
    assert.equal(configOf({ smoke: { maxTokens } }).smoke.maxTokens, maxTokens);
  }
  for (const maxTokens of [0, -1, 1.5, '100', NaN, Infinity]) {
    assert.throws(() => configOf({ smoke: { maxTokens } }), /positive whole number.*inteiro positivo/);
  }
});

test('smoke helper overrides are validated with a plain bilingual refusal', () => {
  for (const smokeDrivers of [null, [], { unknown: {} }, { codex: null }, { codex: [] },
    { codex: { args: '-p' } }, { opencode: { requiredFlags: [1] } },
    { codex: { reportsCost: 'yes' } }, { codex: { unsupported: true } }]) {
    assert.throws(() => configOf({ smokeDrivers }), /Smoke.*\/.*ajustes|Ajustes.*\/|Escolha um ajudante/);
  }
  assert.deepEqual(configOf({ smokeDrivers: { codex: { args: ['exec', '{briefing}'] } } })
    .smokeDrivers.codex.args, ['exec', '{briefing}']);
});

test('Codex needs a text ceiling for real work and explains the setting in previews', async (t) => {
  const f = await fixture(t);
  const options = { ...f.io, readQuota: async () => ({ source: 'user', remainingPct: 80 }),
    spawn: () => assert.fail('a missing ceiling must be refused before client help') };
  const refused = await runClientSmoke(['--client', 'codex'], options);
  assert.equal(refused.code, 2); assert.equal(refused.reason, 'text allowance required');
  assert.ok(f.lines.some((line) => line.includes('Set "maxTokens" under "smoke" in config.json')));
  assert.ok(f.lines.some((line) => line.includes('Defina "maxTokens" dentro de "smoke" em config.json')));
  const preview = await runClientSmoke(['--client', 'codex', '--dry-run'], options);
  assert.equal(preview.code, 0);
  assert.ok(f.lines.some((line) => line.includes('Before a real Codex run, set "maxTokens"')));
  assert.ok(f.lines.some((line) => line.includes('Antes de executar o Codex, defina "maxTokens"')));
  assert.equal(f.calls.length, 0);
});

test('missing client program refuses before starting any scenario work', async (t) => {
  for (const client of ['codex', 'opencode']) {
    const f = await fixture(t, { smoke: { maxTokens: client === 'codex' ? 1000 : null } });
    const result = await runClientSmoke(['--client', client], { ...f.io, client: undefined,
      readQuota: async () => ({ source: 'user', remainingPct: 80 }),
      spawn: fakeChild([], { error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }) });
    assert.equal(result.code, 2); assert.equal(result.reason, 'client-refused');
    assert.deepEqual(result.records, []);
    assert.ok(f.lines.some((line) => line.includes(`Install ${client} and sign in`)));
    assert.ok(f.lines.some((line) => line.includes(`Instale ${client}`)));
  }
});

test('unsupported client flags refuse before scenario execution', async (t) => {
  const f = await fixture(t);
  const result = await runClientSmoke([], { ...f.io, client: async () => ({ stdout: '--verbose' }) });
  assert.equal(result.code, 2);
  assert.deepEqual(result.records, []);
  assert.equal(result.reason, 'client-refused');
});

test('built-in driver accepts Codex and OpenCode offline selections', async (t) => {
  for (const client of ['codex', 'opencode']) {
    const f = await fixture(t);
    const result = await runClientSmoke(['--client', client, '--dry-run'], { ...f.io, client: undefined,
      spawn: () => assert.fail('offline preview must not spawn') });
    assert.equal(result.code, 0, client);
    assert.ok(!f.lines.some((line) => line.includes('Unknown client')), client);
    assert.equal(f.calls.length, 0, client);
    assert.equal(await main(['smoke', '--client', client, '--dry-run'], { ...f.io,
      client: undefined, spawn: () => assert.fail('must not spawn'), stdout: f.io.out, stderr: f.io.err }), 0);
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
