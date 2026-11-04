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
import { codexFixture } from './helpers/trajectory-samples.js';
import { fuzz } from '../scripts/check-atif.mjs';
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
test('case 6: later results move while extra.note and usage survive', () => {
  for (const source of ['user', 'agent', 'system']) {
    const data = trajectory(context, [{ source: 'agent', message: 'Call',
      tool_calls: [{ tool_call_id: 'one', function_name: 'read', arguments: {} }], metrics: { prompt_tokens: 3 } },
    { source, message: '', extra: { failed_calls: ['one'], note: 'kept' }, metrics: { completion_tokens: 2 },
      observation: { results: [{ source_call_id: 'one', content: 'Failed' }] } }]);
    assert.equal(data.steps.length, 2); assert.equal(data.final_metrics.total_steps, 2);
    assert.equal(data.steps[1].source, 'agent');
    assert.equal(data.steps[1].message, '');
    assert.deepEqual(data.steps[1].extra, { note: 'kept' });
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
  assert.equal(data.steps[0].extra.failed_calls, undefined);
  assert.deepEqual(data.steps[0].extra.failed_results, [0]);
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
test('case 1: empty capture writes one valid system step', async t => {
  const root = await rootOf(t);
  assert.equal(await capture(root, { ...context, client: 'codex' }, { transcript: [] }), true);
  const data = await exportTrajectory(root, context.session_id);
  assert.deepEqual(data.steps, [{ step_id: 1, timestamp: null, source: 'system', message: '' }]);
  assert.ok(validate(data));
  assert.equal(validate({ ...data, steps: [], final_metrics: totals([]) }), false);
});
test('case 2: Codex missing call IDs become unique strings without binding null results', () => {
  const [, codex] = samples.find(([client]) => client === 'codex');
  const fixture = structuredClone(codexFixture);
  delete fixture.find(row => row.payload?.type === 'function_call').payload.call_id;
  fixture.find(row => row.payload?.type === 'function_call_output').payload.call_id = null;
  const data = codex(fixture, context);
  const callStep = data.steps.find(item => item.tool_calls);
  assert.equal(callStep.tool_calls[0].tool_call_id, `call-${callStep.step_id}-1`);
  assert.equal(data.steps.find(item => item.observation).observation.results[0].source_call_id, null);
  const collision = normalize({ ...data, steps: [...data.steps, { source: 'agent', timestamp: null, message: '',
    tool_calls: [{ tool_call_id: null, function_name: 'read', arguments: {} },
      { tool_call_id: `call-${data.steps.length + 1}-1`, function_name: 'read', arguments: {} }] }] });
  const ids = collision.steps.flatMap(item => item.tool_calls ?? []).map(call => call.tool_call_id);
  assert.equal(new Set(ids).size, ids.length); assert.ok(validate(collision));
  for (const id of [null, '', 7]) {
    const bad = structuredClone(data); bad.steps.find(item => item.tool_calls).tool_calls[0].tool_call_id = id;
    assert.equal(validate(bad), false);
  }
});
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
test('case 3: legacy capped export preserves stored totals of 30 with retained usage of 10', async t => {
  const root = await rootOf(t); await mkdir(join(root, 'trajectory'));
  const data = { ...trajectory(context), steps: [{ step_id: 1, timestamp: null, source: 'agent', message: 'Kept',
    model_name: null, tool_calls: [], metrics: { prompt_tokens: 10, completion_tokens: null, cached_tokens: null, cost_usd: null } }],
  final_metrics: { total_steps: 1, total_prompt_tokens: 30, total_completion_tokens: null, total_cached_tokens: null, total_cost_usd: 0.5 } };
  await writeFile(join(root, 'trajectory', 'okit-plugin-atif.json'), JSON.stringify(data));
  const exported = await exportTrajectory(root, 'atif');
  assert.deepEqual(exported.final_metrics, data.final_metrics);
  assert.equal(exported.steps[0].metrics.prompt_tokens, 10); assert.ok(validate(exported));
  delete data.final_metrics.total_cached_tokens;
  await writeFile(join(root, 'trajectory', 'okit-plugin-atif.json'), JSON.stringify(data));
  const filled = await exportTrajectory(root, 'atif');
  assert.equal(filled.final_metrics.total_cached_tokens, null);
  assert.equal(filled.final_metrics.total_prompt_tokens, 30);
});
test('case 4: capped failed tools leave no dangling failure IDs', async t => {
  const root = await rootOf(t);
  await writeFile(join(root, 'config.json'), JSON.stringify({ trajectory: { enabled: true, maxFileBytes: 1600 } }));
  const data = trajectory(context, [{ message: 'Large '.repeat(4000),
    tool_calls: [{ tool_call_id: 'failed', function_name: 'read', arguments: {} }],
    observation: { results: [{ source_call_id: 'failed', content: { output: 'Oops', is_error: true } }] } }]);
  assert.equal(await save(root, data), true);
  const saved = JSON.parse(await readFile(join(root, 'trajectory', 'okit-plugin-atif.json')));
  assert.ok(validate(saved)); assert.equal(saved.steps[0].extra?.failed_calls, undefined);
  assert.equal(saved.steps[0].extra?.failed_results, undefined);
});
test('case 5: orphan failure indices distinguish failed and successful null results in trajectory_show', async t => {
  const root = await rootOf(t);
  const data = trajectory(context, [{ observation: { results: [
    { source_call_id: null, content: { output: 'Failed orphan', is_error: true } },
    { source_call_id: null, content: { output: 'Successful orphan', is_error: false } }] } }]);
  assert.equal(data.steps[0].extra.failed_calls, undefined);
  assert.deepEqual(data.steps[0].extra.failed_results, [0]);
  assert.ok(validate(data)); assert.deepEqual(normalize(data), data);
  await save(root, data);
  const tool = TOOLS.find(item => item.name === 'trajectory_show');
  const shown = JSON.parse(await tool.handler({ run: 'atif' }, { root }));
  const outputs = shown.split('\n').filter(line => /orphan/.test(line));
  assert.match(outputs[0], /^Failed tool/); assert.match(outputs[1], /^Result/);
  for (const failed_calls of [[null], ['missing'], [7], 'bad']) {
    const bad = structuredClone(data); bad.steps[0].extra.failed_calls = failed_calls;
    assert.equal(validate(bad), false);
  }
  for (const failed_results of [[-1], [2], [0.5], [null], 'bad']) {
    const bad = structuredClone(data); bad.steps[0].extra.failed_results = failed_results;
    assert.equal(validate(bad), false);
  }
  const malformed = structuredClone(data); malformed.steps[0].observation.results[0] = null;
  assert.equal(validate(malformed), false);
  assert.equal(readable({ ...data, steps: [null] }), false);
});
test('normalizer repairs odd step shapes or refuses an invalid envelope before save', async t => {
  const base = trajectory(context);
  for (const steps of [null, {}, [null, 5, 'text', []], [{ source: 'odd', timestamp: 5, message: { text: 'json' },
    tool_calls: [null, { tool_call_id: 7, arguments: [] }], observation: { results: [null, { source_call_id: 7, content: 9 }] },
    extra: { failed_calls: [null, 7], failed_results: [99] } }], [{ tool_calls: 'odd', observation: { results: 'odd' } }]]) {
    const normalized = normalize({ ...base, steps });
    assert.ok(validate(normalized)); assert.deepEqual(normalize(normalized), normalized);
  }
  const root = await rootOf(t), bad = { ...base, agent: { ...base.agent, name: 7 } };
  assert.throws(() => normalize(bad)); await assert.rejects(save(root, bad));
});
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
// Review 3: the whole Harbor schema, not only Steps. Each test fails on the previous commit.
test('finding 1: non-ISO timestamps become null and keep their text in extra', async t => {
  const root = await rootOf(t);
  for (const text of ['November 3, 2026', '2026-11-03', '2026-02-30T10:00:00Z', '2026-11-03T24:00:00Z']) {
    const data = trajectory(context, [{ message: 'Hello', timestamp: text }]);
    assert.equal(data.steps[0].timestamp, null); assert.equal(data.steps[0].extra.original_timestamp, text);
    assert.ok(validate(data)); assert.deepEqual(normalize(data), data);
    const bad = structuredClone(data); bad.steps[0].timestamp = text; assert.equal(validate(bad), false);
    await save(root, data); assert.equal((await exportTrajectory(root, 'atif')).steps[0].timestamp, null);
  }
  for (const text of ['2026-11-03T10:00:00.000Z', '2026-11-03T10:00:00+02:00']) {
    const data = trajectory(context, [{ message: 'Hello', timestamp: text }]);
    assert.equal(data.steps[0].timestamp, text); assert.equal(data.steps[0].extra, undefined);
  }
});
test('finding 2: token counters must be non-negative integers, cost may be fractional', () => {
  const data = trajectory(context, [{ message: 'A', metrics: { prompt_tokens: 1.5, completion_tokens: -2, cached_tokens: '3', cost_usd: 0.25 } },
    { message: 'B', metrics: { prompt_tokens: 4, completion_tokens: 2 ** 60 } }]);
  assert.deepEqual(data.steps[0].metrics, { cost_usd: 0.25 }); assert.deepEqual(data.steps[1].metrics, { prompt_tokens: 4 });
  assert.equal(data.final_metrics.total_prompt_tokens, 4); assert.equal(data.final_metrics.total_cost_usd, 0.25);
  assert.equal(data.final_metrics.total_completion_tokens, null); assert.ok(validate(data));
  for (const [key, value] of [['prompt_tokens', 1.5], ['cached_tokens', -1], ['completion_tokens', '2']]) {
    const bad = structuredClone(data); bad.steps[1].metrics[key] = value; assert.equal(validate(bad), false, key);
  }
  const bad = structuredClone(data); bad.final_metrics.total_prompt_tokens = 6.5; assert.equal(validate(bad), false);
  assert.equal(normalize(bad).final_metrics.total_prompt_tokens, 4);
});
test('finding 3: agent.version is always a string', () => {
  assert.equal(trajectory({ session_id: 'x' }).agent.version, 'unknown');
  const data = trajectory(context);
  for (const [version, expected] of [[null, 'unknown'], [undefined, 'unknown'], ['', 'unknown'], [{}, 'unknown'], [7, '7'], ['1.2', '1.2']]) {
    const fixed = normalize({ ...data, agent: { ...data.agent, version } }); assert.equal(fixed.agent.version, expected);
  }
  assert.equal(validate({ ...data, agent: { ...data.agent, version: null } }), false);
});
test('finding 4: unknown fields move into extra where Harbor has one, else disappear', () => {
  const base = trajectory(context, [{ message: 'Hi', tool_calls: [{ tool_call_id: 't', function_name: 'read', arguments: {}, custom: 1 }],
    metrics: { prompt_tokens: 1, custom: 2 }, observation: { custom: 4, results: [{ source_call_id: 't', content: 'ok', custom: 3 }] } }]);
  assert.deepEqual(Object.keys(base.steps[0].tool_calls[0]).sort(), ['arguments', 'function_name', 'tool_call_id']);
  assert.deepEqual(Object.keys(base.steps[0].observation), ['results']);
  assert.deepEqual(Object.keys(base.steps[0].observation.results[0]).sort(), ['content', 'source_call_id']);
  assert.deepEqual(base.steps[0].metrics, { prompt_tokens: 1, extra: { custom: 2 } });
  const messy = { ...base, custom: 'top', agent: { ...base.agent, custom: 'agent' }, final_metrics: { ...base.final_metrics, custom: 'final' } };
  assert.equal(validate(messy), false);
  const fixed = normalize(messy);
  assert.equal(fixed.extra.custom, 'top'); assert.equal(fixed.agent.extra.custom, 'agent');
  assert.equal(fixed.final_metrics.extra.custom, 'final'); assert.equal(fixed.agent.extra.role, 'executor');
  assert.ok(validate(fixed)); assert.deepEqual(normalize(fixed), fixed);
  const cases = [data => { data.steps[0].tool_calls[0].custom = 1; }, data => { data.steps[0].observation.custom = 1; },
    data => { data.steps[0].observation.results[0].custom = 1; }, data => { data.steps[0].metrics.custom = 1; }];
  for (const mutate of cases) { const bad = structuredClone(base); mutate(bad); assert.equal(validate(bad), false); }
});
test('finding 5: totals stored in a capped file survive normalize and save', async t => {
  const root = await rootOf(t), data = trajectory(context, [{ message: 'Kept' }]);
  data.final_metrics.total_prompt_tokens = 30; data.final_metrics.total_cost_usd = 0.5;
  const fixed = normalize(data);
  assert.equal(fixed.final_metrics.total_prompt_tokens, 30); assert.equal(fixed.final_metrics.total_cost_usd, 0.5);
  assert.equal(fixed.final_metrics.total_completion_tokens, null);
  await save(root, data); await save(root, JSON.parse(await readFile(join(root, 'trajectory', 'okit-plugin-atif.json'))));
  const saved = JSON.parse(await readFile(join(root, 'trajectory', 'okit-plugin-atif.json')));
  assert.equal(saved.final_metrics.total_prompt_tokens, 30);
  const stale = trajectory(context, [{ message: 'Used', metrics: { prompt_tokens: 5 } }]);
  stale.final_metrics.total_prompt_tokens = 2;
  assert.equal(normalize(stale).final_metrics.total_prompt_tokens, 5);
});
test('finding 6: total_steps always equals the number of steps', async t => {
  const root = await rootOf(t); await mkdir(join(root, 'trajectory'));
  const legacy = trajectory({ ...context, session_id: 'old-two' });
  legacy.steps = [oldSteps[2], { ...oldSteps[0], step_id: 2 }]; legacy.final_metrics = totals(legacy.steps);
  assert.equal(legacy.final_metrics.total_steps, 2);
  await writeFile(join(root, 'trajectory', 'okit-plugin-old-two.json'), JSON.stringify(legacy));
  const exported = await exportTrajectory(root, 'old-two');
  assert.equal(exported.steps.length, 1); assert.equal(exported.final_metrics.total_steps, 1); assert.ok(validate(exported));
  const data = trajectory(context, [{ message: 'A' }, { message: 'B' }]);
  data.final_metrics.total_steps = 9; assert.equal(normalize(data).final_metrics.total_steps, 2);
});
test('duplicate call IDs are renamed with their results', () => {
  const data = trajectory(context, [{ tool_calls: [{ tool_call_id: 'same', function_name: 'read', arguments: {} }],
    observation: { results: [{ source_call_id: 'same', content: 'First' }] } },
  { tool_calls: [{ tool_call_id: 'same', function_name: 'read', arguments: {} }, { tool_call_id: 'same', function_name: 'read', arguments: {} }],
    extra: { failed_calls: ['same'] }, observation: { results: [{ source_call_id: 'same', content: 'Second' }] } }]);
  const ids = data.steps.flatMap(item => item.tool_calls).map(call => call.tool_call_id);
  assert.equal(new Set(ids).size, 3); assert.equal(data.steps[0].tool_calls[0].tool_call_id, 'same');
  assert.equal(data.steps[1].observation.results[0].source_call_id, data.steps[1].tool_calls[0].tool_call_id);
  assert.ok(validate(data)); assertLocalResults(data);
});
test('fuzz: the seeded odd trajectories all satisfy validate()', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'atif-fuzz-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const { files, failures } = await fuzz(dir, { n: 100 });
  assert.deepEqual(failures, []); assert.equal(files.length, 100);
  for (const file of files) assert.ok(validate(JSON.parse(await readFile(file, 'utf8'))), file);
});
