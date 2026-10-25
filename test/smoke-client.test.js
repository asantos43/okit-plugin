import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.js';
import { tick } from '../src/daemon.js';
import { loadConfig, TOOLS, TOOL_NAMES } from '../src/mcp/tools.js';
import { readJson, writeJsonAtomic } from '../src/state.js';
import { invokeClient, runClientSmoke } from '../src/smoke/client.js';
import { clientEnv } from './helpers/env.js';

const HELP = '--output-format --include-hook-events --verbose --max-budget-usd --permission-mode --no-session-persistence';

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
        skills: (options.skills ?? ['okit-director', 'okit-executor', 'okit-critic', 'okit-smoke'])
          .map((name) => `okit:${name}`),
        mcp_servers: [{ name: 'okit', status: 'connected' }], tools: TOOL_NAMES.map((name) => `mcp__okit__${name}`) };
      const events = [init, { type: 'system', subtype: 'hook_response', path: plugin }];
      for (const operation of [request.operation, request.operation?.then].filter((entry) => entry?.tool)) {
        const tool = TOOLS.find((entry) => entry.name === operation.tool);
        let value; let isError = false;
        try { value = await tool.handler(operation.arguments, { root, env }); }
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
    assert.equal(await main(['client-smoke', ...args], { ...f.io, stdout: f.io.out, stderr: f.io.err }), 2);
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
