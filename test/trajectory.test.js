import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readdir, readFile, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { readTrajectory as claude } from '../adapters/claude-code/index.js';
import { readTrajectory as codex } from '../adapters/codex/index.js';
import { readTrajectory as opencode } from '../adapters/opencode/index.js';
import { trajectory, validate, SCHEMA_VERSION } from '../src/trajectory/schema.js';
import { configure, status, list, show, exportTrajectory, prune, save } from '../src/trajectory/index.js';
import { capture } from '../src/trajectory/capture.js';
import { settings } from '../src/trajectory/config.js';
import { DEFAULT_CONFIG } from '../src/profiles.js';
import { makeSpawner } from '../src/spawn-process.js';
import { main } from '../src/cli.js';
import { TOOLS } from '../src/mcp/tools.js';
import { attempt } from '../src/smoke/demo/attempt.js';
import { ledger } from '../src/smoke/demo/budget.js';
const context = { session_id: 'attempt-1', model: 'example-model', effort: 'high', role: 'executor', demand: 'example', step: 1 };
async function rootOf(t, config) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-trajectory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (config) await writeFile(join(root, 'config.json'), JSON.stringify({ trajectory: { enabled: true, ...config } }));
  return root;
}
const instant = '2026-10-27T10:00:00.000Z';
const claudeFixture = [
  { type: 'assistant', timestamp: instant, effort: 'high', message: { role: 'assistant', model: 'example-model',
    content: [{ type: 'text', text: 'Read the file' }, { type: 'thinking', thinking: 'Check first' },
      { type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'sample.txt' } }],
    usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 3 } } },
  { type: 'user', timestamp: instant, message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'call-1', content: 'File missing', is_error: true }] } },
];
const codexFixture = [
  { type: 'turn_context', payload: { model: 'example-model', effort: 'high' } },
  { type: 'response_item', timestamp: instant, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Read the file' }] } },
  { type: 'response_item', timestamp: instant, payload: { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"sample.txt"}' } },
  { type: 'response_item', timestamp: instant, payload: { type: 'function_call_output', call_id: 'call-1', output: 'File missing' } },
  { type: 'event_msg', timestamp: instant, payload: { type: 'token_count', info: {
    last_token_usage: { input_tokens: 12, output_tokens: 4, cached_input_tokens: 3 } } } },
];
const opencodeFixture = { messages: [{ info: { role: 'assistant', modelID: 'example-model', variant: 'high',
  time: { created: Date.parse(instant) }, tokens: { input: 12, output: 4, cache: { read: 3 } } },
parts: [{ type: 'text', text: 'Read the file' }, { type: 'tool', tool: 'read_file', callID: 'call-1',
  state: { input: { path: 'sample.txt' }, status: 'error', error: 'File missing' } }] }] };
for (const [client, reader, fixture] of [['claude-code', claude, claudeFixture],
  ['codex', codex, codexFixture.map(row => JSON.stringify(row)).join('\n')], ['opencode', opencode, opencodeFixture]]) {
  test(`${client} keeps available model, effort, role, steps, tool calls, observations and tokens`, () => {
    const data = reader(fixture, { ...context, model: null, effort: null, role: 'critic', critic_of: 'executor-1' });
    assert.equal(validate(data), true);
    assert.equal(data.schema_version, SCHEMA_VERSION);
    assert.equal(data.agent.model_name, 'example-model');
    assert.equal(data.agent.extra.effort, 'high');
    assert.equal(data.agent.extra.role, 'critic');
    assert.equal(data.agent.extra.critic_of, 'executor-1');
    assert.equal(data.agent.extra.client, client);
    assert.equal(data.steps[0].timestamp, instant);
    assert.match(data.steps[0].message, /Read the file/);
    const calls = data.steps.flatMap(item => item.tool_calls ?? []);
    assert.equal(calls[0].tool_call_id, 'call-1');
    assert.equal(calls[0].function_name, 'read_file');
    assert.match(JSON.stringify(calls[0].arguments), /sample.txt/);
    assert.equal(data.steps.flatMap(item => item.observation?.results ?? [])[0].source_call_id, 'call-1');
    assert.equal(data.final_metrics.total_prompt_tokens, 12);
    assert.equal(data.final_metrics.total_completion_tokens, 4);
    assert.equal(data.final_metrics.total_cached_tokens, 3);
    assert.equal(data.final_metrics.total_cost_usd, null);
    assert.equal(reader([], { session_id: 'empty' }).agent.extra.effort, null);
  });
}
test('off by default and switched off write no content or directory', async t => {
  const root = await rootOf(t);
  assert.equal((await status(root)).enabled, false);
  assert.equal(await save(root, claude(claudeFixture, context)), false);
  assert.equal(await capture(root, { ...context, client: 'codex' }, { message: 'private' }), false);
  assert.deepEqual(await readdir(root), []);
  assert.match(await configure(root, true), /on this computer only/);
  await configure(root, false);
  assert.equal(await save(root, claude(claudeFixture, context)), false);
  assert.deepEqual(await readdir(root), ['config.json', 'locks']);
});
// | Corpus | Must pass | Must refuse |
// | content | prose, normal paths, tool names | key=value, tokens, bearer, private keys |
// | schema | versioned records, null unknowns | wrong version, missing role, bad metrics |
// | saved run | one local name | parent paths, missing/invalid records |
test('redacts secrets in messages, thoughts, tool inputs and results; keeps ordinary content', async t => {
  const root = await rootOf(t, {});
  const secret = 'sk-privateExample123';
  const data = claude(claudeFixture, context);
  data.steps[0].message = `Safe prose ${secret} Bearer bearerValue123 password=hiddenPass`;
  data.steps[0].reasoning_content = '-----BEGIN PRIVATE KEY-----\nprivateMaterial\n-----END PRIVATE KEY-----';
  data.steps[0].tool_calls[0].arguments = { api_key: 'hiddenKey', path: 'sample.txt' };
  data.steps[1].observation.results[0].content = { token: 'hiddenToken', text: 'File missing' };
  assert.equal(await save(root, data), true);
  const output = JSON.stringify(await exportTrajectory(root, context.session_id));
  assert.doesNotMatch(output, /privateExample|bearerValue|hiddenPass|privateMaterial|hiddenKey|hiddenToken/);
  assert.match(output, /Hidden/); assert.match(output, /Safe prose/); assert.match(output, /sample.txt/);
  assert.match(output, /File missing/);
  assert.equal(data.steps[0].tool_calls[0].arguments.api_key, 'hiddenKey');
});
test('custom redaction patterns and marker are used', async t => {
  const root = await rootOf(t, { redactionPatterns: ['CONFIDENTIAL\\d+'], redactionMarker: '(removed)' });
  await save(root, trajectory(context, [{ message: 'CONFIDENTIAL123 visible' }]));
  assert.equal((await exportTrajectory(root, context.session_id)).steps[0].message, '(removed) visible');
});
test('size cap keeps valid JSON below the limit and a configured visible marker', async t => {
  const root = await rootOf(t, { maxFileBytes: 1700, truncationMarker: '[shortened here]' });
  const data = claude(claudeFixture, context);
  data.steps[0].message = 'large '.repeat(10000);
  assert.equal(await save(root, data), true);
  const file = await readFile(join(root, 'trajectory', 'okit-plugin-attempt-1.json'));
  assert.ok(file.length <= 1700);
  assert.match(file.toString(), /\[shortened here\]/);
  assert.equal(validate(JSON.parse(file)), true);
  assert.equal(JSON.parse(file).agent.extra.effort, 'high');
});
test('file capture marks only transcripts larger than the read limit', async t => {
  const maxFileBytes = 4096, truncationMarker = '[input shortened]';
  const root = await rootOf(t, { maxFileBytes, truncationMarker });
  const transcript = JSON.stringify({ type: 'response_item', timestamp: instant,
    payload: { type: 'message', role: 'assistant', content: [{ text: 'Small message' }] } });
  for (const [session_id, padding, shortened] of [['small', '', false], ['large', ' '.repeat(maxFileBytes), true]]) {
    const file = join(root, `${session_id}.jsonl`);
    await writeFile(file, transcript + padding);
    assert.equal(await capture(root, { ...context, client: 'codex', session_id }, { file }), true);
    const data = await exportTrajectory(root, session_id);
    assert.equal(data.steps[0].message, 'Small message');
    assert.equal(data.steps.some(item => item.message === truncationMarker), shortened);
    if (shortened) assert.equal(data.steps.at(-1).message, truncationMarker);
    else assert.equal(data.steps.length, 1);
  }
});
test('file capture never includes messages beyond maxFileBytes bytes', async t => {
  const maxFileBytes = 4096, root = await rootOf(t, { maxFileBytes });
  const message = text => JSON.stringify({ type: 'response_item', timestamp: instant,
    payload: { type: 'message', role: 'assistant', content: [{ text }] } });
  const first = Buffer.from(`${message('Read within the limit ✓')}\n`);
  const file = join(root, 'bounded-input.jsonl');
  // Padding moves a complete, short second record beyond the byte boundary.
  // Both messages would fit in the saved file, so the output cap cannot hide an overread.
  await writeFile(file, Buffer.concat([first, Buffer.alloc(maxFileBytes - first.length, ' '),
    Buffer.from(`\n${message('MESSAGE_BEYOND_READ_LIMIT')}\n`)]));
  assert.equal(await capture(root, { ...context, client: 'codex' }, { file }), true);
  const data = await exportTrajectory(root, context.session_id);
  assert.equal(data.steps[0].message, 'Read within the limit ✓');
  assert.doesNotMatch(JSON.stringify(data), /MESSAGE_BEYOND_READ_LIMIT/);
  assert.ok(Buffer.byteLength(JSON.stringify(data, null, 2)) < maxFileBytes);
});
test('retention prunes expired records while preserving fresh ones independently of size', async t => {
  const root = await rootOf(t, { retentionDays: 1 });
  await save(root, claude(claudeFixture, context));
  await utimes(join(root, 'trajectory', 'okit-plugin-attempt-1.json'), new Date(0), new Date(0));
  await save(root, claude(claudeFixture, { ...context, session_id: 'fresh' }));
  assert.deepEqual((await list(root)).map(item => item.session_id), ['fresh']);
  await utimes(join(root, 'trajectory', 'okit-plugin-fresh.json'), new Date(0), new Date(0));
  assert.deepEqual(await prune(root), { removed: 1 });
});
test('total storage cap removes older runs', async t => {
  const root = await rootOf(t, { maxBytes: 2300 });
  await save(root, trajectory(context, [{ message: 'first' }]));
  await utimes(join(root, 'trajectory', 'okit-plugin-attempt-1.json'), new Date(Date.now() - 1000), new Date(Date.now() - 1000));
  await save(root, trajectory({ ...context, session_id: 'second' }, [{ message: 'second' }]));
  await save(root, trajectory({ ...context, session_id: 'third' }, [{ message: 'third' }]));
  const names = await readdir(join(root, 'trajectory'));
  const buffers = await Promise.all(names.filter(name => name.endsWith('.json')).map(name => readFile(join(root, 'trajectory', name))));
  assert.ok(buffers.reduce((sum, buffer) => sum + buffer.length, 0) <= 2300);
  assert.ok(!names.includes('okit-plugin-attempt-1.json'));
});
test('show and export through CLI and MCP retain step details and explain failed tools', async t => {
  const root = await rootOf(t, {});
  await save(root, claude(claudeFixture, context));
  const summary = await show(root, 'attempt-1');
  assert.match(summary, /Stopped at step \/ Parou no passo: 2/);
  assert.match(summary, /Failed tool \/ Ferramenta que falhou: read_file/);
  assert.match(summary, /Tokens in \/ entrada: 12/);
  for (const action of ['list', 'show', 'export', 'status', 'prune', 'off', 'on']) {
    const output = [], errors = [];
    const code = await main(['trajectory', action, ...(['show', 'export'].includes(action) ? ['attempt-1'] : [])],
      { root, stdout: text => output.push(text), stderr: text => errors.push(text) });
    assert.equal(code, 0, errors.join('\n'));
    if (action === 'show') assert.equal(output.join(''), summary);
    if (action === 'export') assert.deepEqual(JSON.parse(output.join('')), await exportTrajectory(root, 'attempt-1'));
    if (action === 'on') assert.match(output.join(''), /somente neste computador/);
  }
  const tool = TOOLS.find(item => item.name === 'trajectory_show');
  assert.equal(JSON.parse(await tool.handler({ run: 'attempt-1' }, { root })), summary);
  await assert.rejects(exportTrajectory(root, '../config'));
  await assert.rejects(exportTrajectory(root, 'absent'));
});
test('schema accepts null unknowns and refuses invalid version, roles and token values', () => {
  const valid = trajectory({ session_id: 'empty' });
  assert.equal(validate(valid), true);
  for (const mutate of [data => { data.schema_version = 'unknown'; },
    data => { delete data.agent.extra.role; }, data => { delete data.agent.extra.effort; },
    data => { data.steps[0].metrics.prompt_tokens = -1; }]) {
    const data = claude(claudeFixture, context); mutate(data); assert.equal(validate(data), false);
  }
});
test('save refuses unsafe session names before creating any recording file', async t => {
  const root = await rootOf(t, {});
  const before = await readdir(root, { recursive: true });
  for (const session_id of ['../fora', 'a/b', '..']) {
    const data = claude(claudeFixture, { ...context, session_id });
    assert.equal(validate(data), true, 'the session name must be rejected by save');
    await assert.rejects(save(root, data), /^Error: Invalid saved run \/ Execução salva inválida$/);
    assert.deepEqual(await readdir(root, { recursive: true }), before);
  }
});
test('validate and save refuse out-of-order and repeated step numbers', async t => {
  const root = await rootOf(t, {});
  for (const numbers of [[2, 1], [1, 1], [1, 3]]) {
    const data = claude(claudeFixture, context);
    data.steps.forEach((item, index) => { item.step_id = numbers[index]; });
    assert.equal(validate(data), false);
    await assert.rejects(save(root, data), /^Error: Invalid saved run \/ Execução salva inválida$/);
  }
  assert.deepEqual(await readdir(root), ['config.json']);
});
test('a critic must carry the critic_of key even when the reference is unknown', async t => {
  const root = await rootOf(t, {});
  const data = claude(claudeFixture, { ...context, role: 'critic' });
  assert.equal(data.agent.extra.critic_of, null);
  assert.equal(validate(data), true);
  delete data.agent.extra.critic_of;
  assert.equal(validate(data), false);
  await assert.rejects(save(root, data), /^Error: Invalid saved run \/ Execução salva inválida$/);
  assert.deepEqual(await readdir(root), ['config.json']);
});
test('Codex command results distinguish failure from success by exit code', () => {
  for (const [exit_code, failed] of [[1, true], [0, false]]) {
    const data = codex([{ type: 'item.completed', timestamp: instant, item: {
      type: 'command_execution', id: 'command-1', command: 'read sample.txt',
      aggregated_output: 'Command output', exit_code } }], context);
    assert.equal(validate(data), true);
    assert.deepEqual(data.steps[0].observation.results, [{ source_call_id: 'command-1',
      content: { output: 'Command output', is_error: failed } }]);
  }
});
test('export and show refuse oversized saved files even when their JSON is valid', async t => {
  const maxFileBytes = 4096, root = await rootOf(t, { maxFileBytes });
  const data = claude(claudeFixture, context);
  assert.equal(await save(root, data), true);
  assert.deepEqual(await exportTrajectory(root, context.session_id), data);
  const file = join(root, 'trajectory', `okit-plugin-${context.session_id}.json`);
  const oversized = `${await readFile(file, 'utf8')}${' '.repeat(maxFileBytes)}`;
  assert.ok(Buffer.byteLength(oversized) > maxFileBytes);
  assert.equal(validate(JSON.parse(oversized)), true, 'only the byte limit must refuse this file');
  await writeFile(file, oversized);
  for (const reader of [exportTrajectory, show]) {
    await assert.rejects(reader(root, context.session_id),
      /^Error: Saved run exceeds limit \/ Execução salva excede o limite$/);
  }
});
test('recording limits accept positive values and refuse zero with a bilingual error', async t => {
  for (const key of ['maxBytes', 'maxFileBytes', 'retentionDays']) {
    const validRoot = await rootOf(t, { [key]: 1 });
    assert.equal((await settings(validRoot))[key], 1);
    const invalidRoot = await rootOf(t, { [key]: 0 });
    await assert.rejects(settings(invalidRoot), /^Error: Invalid recording settings \/ Ajustes de gravação inválidos$/);
    assert.deepEqual(await readdir(invalidRoot), ['config.json']);
  }
});
test('process close records the transcript and links the critic to its executor attempt', async t => {
  const root = await rootOf(t, {}), child = new EventEmitter();
  child.pid = 123; child.unref = () => {};
  const spawner = makeSpawner({ logDir: join(root, 'runs'), spawn: () => child });
  await spawner({ id: 'example', title: 'Review the result' }, { runId: 'critic-1', client: 'codex',
    role: 'critic', critic_of: 'executor-1', profile: { model: 'example-model', effort: 'high' } });
  await writeFile(join(root, 'runs', 'critic-1.out'), codexFixture.map(row => JSON.stringify(row)).join('\n'));
  child.emit('close', 1);
  let data;
  for (let tries = 0; tries < 100; tries++) {
    try { data = await exportTrajectory(root, 'critic-1'); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.equal(data?.agent.extra.critic_of, 'executor-1');
  assert.equal(data.agent.extra.role, 'critic');
  assert.equal(data.final_metrics.total_prompt_tokens, 12);
  assert.match(data.steps.at(-1).message, /Código de saída: 1/);
});
test('smoke attempts save both roles and link the reviewed executor', async t => {
  const root = await rootOf(t, {}), client = 'codex';
  const limits = { ...DEFAULT_CONFIG.smoke, maxTurns: 10, demoDemandMaxUsd: 1 };
  const response = { status: 'completed', summary: 'Done', artifacts: [], usage: { costUsd: 0, turns: 1 } };
  const ctx = { options: { root, snapshot: { now: 1000, clients: [{ client, quota: { remainingPct: 80, ageMinutes: 0 } }] },
    actor: { run: async () => response }, critic: { review: async () => ({ ...response, verdict: 'approved' }) } },
  scratch: { root, state: root, env: {} }, result: { limits }, config: DEFAULT_CONFIG, budget: ledger(limits),
  controller: new AbortController(), clock: () => 1000, say: () => {}, client, locale: 'en', startedAt: 1000,
  scenario: { demands: [] } };
  const row = { key: 'practice', title: 'Practice', attempts: [], slots: [], costUsd: 0 };
  const demand = { key: 'practice', body: { en: 'Do the practice' }, files: [], dependsOn: [], acceptance: [] };
  const actor = { model: 'example-model', effort: 'high' };
  await attempt(ctx, row, demand, 'Executor', actor, {}, 0, []);
  await attempt(ctx, row, demand, 'Critic', actor, {}, 0, [], null, { execution: response, checks: [] });
  const critic = await exportTrajectory(root, row.attempts[1].runId);
  assert.equal(critic.agent.extra.critic_of, row.attempts[0].runId);
  assert.equal(critic.agent.extra.role, 'critic');
  assert.equal((await list(root)).length, 2);
});
