import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trajectory, normalize, validate, readable, totals } from '../src/trajectory/schema.js';
import { save, list, exportTrajectory } from '../src/trajectory/index.js';
import { capture } from '../src/trajectory/capture.js';
import { TOOLS } from '../src/mcp/tools.js';
import { samples } from './helpers/trajectory-samples.js';
const context = { session_id: 'atif', model: 'example-model' };
// | Corpus | Must pass | Must refuse |
// | writer | agent fields, string messages/results, object arguments, extra, local result IDs | rules 1–6 violations |
// | reader | old and new v1.0–v1.7 | unknown versions |
function assertLocalResults(data) {
  for (const item of data.steps) {
    const ids = new Set((item.tool_calls ?? []).map(call => call.tool_call_id));
    for (const result of item.observation?.results ?? []) {
      assert.ok(result.source_call_id === null || ids.has(result.source_call_id), `step ${item.step_id}`);
    }
  }
}
for (const [client, reader, fixture] of samples) {
  const parsed = () => reader(fixture, context);
  test(`${client}: rule 1 restricts agent fields`, () => {
    const data = parsed(); assert.ok(validate(data));
    const user = { step_id: data.steps.length + 1, timestamp: null, source: 'user', message: 'Hello' };
    data.steps.push(user); data.final_metrics = totals(data.steps);
    for (const key of ['model_name', 'reasoning_effort', 'reasoning_content', 'tool_calls', 'metrics']) {
      const bad = structuredClone(data); bad.steps.at(-1)[key] = key === 'tool_calls' ? [] : null;
      assert.equal(validate(bad), false, key);
    }
    assert.ok(validate(data));
  });
  test(`${client}: rule 2 messages are strings`, () => {
    const data = parsed(); assert.ok(data.steps.every(item => typeof item.message === 'string'));
    data.steps[0].message = null; assert.equal(validate(data), false);
    assert.equal(normalize(data).steps[0].message, '');
  });
  test(`${client}: rule 3 results are strings and failures survive`, () => {
    const data = parsed(), item = data.steps.find(item => item.observation);
    assert.equal(typeof item.observation.results[0].content, 'string');
    item.observation.results[0].content = { output: 'oops', is_error: true };
    assert.equal(validate(data), false);
    const fixed = normalize(data).steps.find(item => item.observation);
    assert.deepEqual(fixed.extra.failed_calls, ['call-1']);
    assert.equal(fixed.observation.results[0].content, '{"output":"oops","is_error":true}');
  });
  test(`${client}: rule 4 arguments are objects`, () => {
    const data = parsed(), item = data.steps.find(item => item.tool_calls);
    assert.deepEqual(item.tool_calls[0].arguments, { path: 'sample.txt' });
    for (const [input, expected] of [['{"x":1}', { x: 1 }], ['plain', { input: 'plain' }],
      ['[]', { input: '[]' }], [null, {}], [7, { input: 7 }]]) {
      item.tool_calls[0].arguments = input; assert.equal(validate(data), false);
      assert.deepEqual(normalize(data).steps.find(item => item.tool_calls).tool_calls[0].arguments, expected);
    }
  });
  test(`${client}: rule 5 custom fields go in extra`, () => {
    const data = parsed(); data.steps[0].custom = 'kept'; assert.equal(validate(data), false);
    const fixed = normalize(data); assert.equal(fixed.steps[0].extra.custom, 'kept'); assert.ok(validate(fixed));
  });
  test(`${client}: rule 6 results belong to the step holding the call`, () => {
    const data = parsed(); assertLocalResults(data);
    const item = data.steps.find(item => item.observation);
    assert.equal(item.observation.results[0].source_call_id, 'call-1');
    assert.ok(item.tool_calls.some(call => call.tool_call_id === 'call-1'));
    if (client !== 'codex') assert.deepEqual(item.extra.failed_calls, ['call-1']);
    assert.deepEqual(normalize(data), data);
    item.observation.results[0].source_call_id = 'missing';
    assert.equal(validate(data), false);
    const fixed = normalize(data); assertLocalResults(fixed);
    assert.equal(fixed.steps.find(item => item.observation).observation.results[0].source_call_id, null);
  });
}
test('later results and failure IDs move together, preserving usage and other extra fields', () => {
  for (const source of ['user', 'agent', 'system']) {
    const data = trajectory(context, [{ source: 'agent', message: 'Call',
      tool_calls: [{ tool_call_id: 'one', function_name: 'read', arguments: {} }], metrics: { prompt_tokens: 3 } },
    { source, message: '', extra: { failed_calls: ['one'], note: 'kept' }, metrics: { completion_tokens: 2 },
      observation: { results: [{ source_call_id: 'one', content: 'Failed' }] } }]);
    assert.equal(data.steps.length, 1); assert.equal(data.final_metrics.total_steps, 1);
    assert.equal(data.final_metrics.total_prompt_tokens, 3);
    assert.equal(data.final_metrics.total_completion_tokens, 2);
    assert.deepEqual(data.steps[0].extra.failed_calls, ['one']);
    assertLocalResults(data); assert.ok(validate(data));
    assert.deepEqual(normalize(data), data);
    const withMessage = normalize({ ...data, steps: [data.steps[0], { step_id: 2, source,
      timestamp: null, message: 'Kept message', extra: { failed_calls: ['one'], note: 'kept' },
      observation: { results: [{ source_call_id: 'one', content: 'More output' }] } }] });
    assert.equal(withMessage.steps[1].source, source);
    assert.equal(withMessage.steps[1].observation, undefined);
    assert.deepEqual(withMessage.steps[1].extra, { note: 'kept' });
    assert.deepEqual(withMessage.steps[0].extra.failed_calls, ['one']);
    assertLocalResults(withMessage); assert.ok(validate(withMessage));
  }
});
test('unmatched results get null IDs and cannot reference future calls', () => {
  const data = trajectory(context, [{ source: 'user', observation: { results: [
    { source_call_id: 'future', content: { is_error: true, output: 'Too early' } },
    { source_call_id: null, content: 'Unknown call' }] } },
  { tool_calls: [{ tool_call_id: 'future', function_name: 'read', arguments: {} }] }]);
  assert.deepEqual(data.steps[0].observation.results.map(result => result.source_call_id), [null, null]);
  assert.deepEqual(data.steps[0].extra.failed_calls, [null]);
  assert.equal(data.steps[0].source, 'agent'); assertLocalResults(data); assert.ok(validate(data));
});
test('non-agent usage folds backwards, preserves totals, and handles usage before agents', () => {
  const data = trajectory(context, [{ source: 'system', metrics: { prompt_tokens: 2 } },
    { message: 'Answer', metrics: { completion_tokens: 3 } },
    { source: 'system', metrics: { prompt_tokens: 5, cost_usd: 0 } },
    { source: 'system', message: 'Finished', metrics: { completion_tokens: 7 } }]);
  assert.deepEqual(data.steps.map(item => item.source), ['agent', 'agent', 'system']);
  assert.equal(data.final_metrics.total_prompt_tokens, 7);
  assert.equal(data.final_metrics.total_completion_tokens, 10);
  assert.equal(data.final_metrics.total_cost_usd, 0);
  assert.deepEqual(data.steps[1].metrics, { completion_tokens: 10, prompt_tokens: 5, cost_usd: 0 });
  assert.ok(validate(data)); assert.deepEqual(normalize(data), data);
});
async function rootOf(t) {
  const root = await mkdtemp(join(tmpdir(), 'atif-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'config.json'), JSON.stringify({ trajectory: { enabled: true } }));
  return root;
}
// Saved legacy steps stay literal so normalization cannot silently update the reader corpus.
const oldSteps = [
  { step_id: 1, timestamp: null, source: 'user', message: null, model_name: null, tool_calls: [],
    observation: { results: [{ source_call_id: 'call-1', content: { output: 'File missing', is_error: true } }] },
    metrics: { prompt_tokens: null, completion_tokens: null, cached_tokens: null, cost_usd: null } },
  { step_id: 1, timestamp: null, source: 'system', message: null, model_name: null, tool_calls: [],
    metrics: { prompt_tokens: 12, completion_tokens: 4, cached_tokens: 3, cost_usd: null } },
  { step_id: 1, timestamp: null, source: 'agent', message: null, model_name: 'example-model',
    tool_calls: [{ tool_call_id: 'call-1', function_name: 'read_file', arguments: null }],
    metrics: { prompt_tokens: null, completion_tokens: null, cached_tokens: null, cost_usd: null } },
];
test('old saved files remain listed and shown by trajectory_show', async t => {
  const root = await rootOf(t); await mkdir(join(root, 'trajectory'));
  for (const [index, steps] of oldSteps.entries()) {
    const data = trajectory({ ...context, session_id: `old-${index}` });
    data.steps = [steps]; data.final_metrics = totals(data.steps);
    assert.ok(readable(data)); assert.equal(validate(data), false);
    await writeFile(join(root, 'trajectory', `okit-plugin-old-${index}.json`), JSON.stringify(data));
    const tool = TOOLS.find(item => item.name === 'trajectory_show');
    const shown = JSON.parse(await tool.handler({ run: `old-${index}` }, { root }));
    assert.match(shown, /not available/);
    if (index === 0) assert.match(shown, /Failed tool/);
    const exported = await exportTrajectory(root, `old-${index}`);
    assert.ok(validate(exported)); assertLocalResults(exported);
  }
  assert.equal((await list(root)).length, 3);
  const legacy = trajectory({ ...context, session_id: 'old-pair' });
  legacy.steps = [oldSteps[2], { ...oldSteps[0], step_id: 2 }]; legacy.final_metrics = totals(legacy.steps);
  await writeFile(join(root, 'trajectory', 'okit-plugin-old-pair.json'), JSON.stringify(legacy));
  const exported = await exportTrajectory(root, 'old-pair');
  assert.equal(exported.steps.length, 1); assertLocalResults(exported);
  assert.deepEqual(exported.steps[0].extra.failed_calls, ['call-1']);
});
test('reader accepts v1.0 through v1.7, writer emits only v1.4', () => {
  for (let version = 0; version <= 7; version++) {
    const data = trajectory(context, [{ message: 'Hello' }]); data.schema_version = `ATIF-v1.${version}`;
    assert.ok(readable(data)); assert.equal(normalize(data).schema_version, 'ATIF-v1.4');
    data.steps = [oldSteps[1]]; data.final_metrics = totals(data.steps); assert.ok(readable(data));
  }
  assert.equal(readable({ ...trajectory(context), schema_version: 'ATIF-v1.8' }), false);
});
test('capture additions and save guard write strict files with unchanged usage', async t => {
  const root = await rootOf(t);
  for (const [client, , fixture] of samples) {
    assert.equal(await capture(root, { ...context, client, session_id: client }, {
      transcript: fixture, message: 'Start', outcome: 'Done', usage: { prompt_tokens: 2 } }), true);
    const data = JSON.parse(await readFile(join(root, 'trajectory', `okit-plugin-${client}.json`)));
    assert.ok(validate(data)); assert.equal(data.final_metrics.total_prompt_tokens, 14);
    data.steps[0].custom = 'saved'; await save(root, data);
    assert.ok(validate(await exportTrajectory(root, client)));
  }
});
