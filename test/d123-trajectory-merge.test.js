import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { save } from '../src/trajectory/store.js';
import { trajectory, validate } from '../src/trajectory/schema.js';
import { withLock } from '../src/state.js';

const context = { session_id: 'session-1', model: 'example-model', effort: 'high', role: 'executor', demand: 'example', step: 1 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A scratch root and an empty home: nothing of the test touches the real one.
async function rootOf(t, config) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-d123-'));
  const home = await mkdtemp(join(tmpdir(), 'plugin-d123-home-'));
  const before = process.env.HOME;
  process.env.HOME = home;
  t.after(async () => {
    if (before === undefined) delete process.env.HOME; else process.env.HOME = before;
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });
  await writeFile(join(root, 'config.json'), JSON.stringify({ trajectory: { enabled: true, ...config } }));
  return root;
}

const fileOf = (root, session_id = 'session-1') => join(root, 'trajectory', `okit-plugin-${session_id}.json`);
const readSaved = async root => JSON.parse(await readFile(fileOf(root), 'utf8'));
const step = message => ({ message });
const call = { tool_call_id: 'call-1', function_name: 'read_file', arguments: { path: 'sample.txt' } };
const result = { source_call_id: 'call-1', content: 'File missing' };

// | Corpus | Must pass | Must refuse |
// | existing file | a longer run, a richer step | a corrupt file, a busy lock |
// | merged file | every step of both runs | a file over the configured limit |
test('a smaller save after a larger one keeps the larger', async t => {
  const root = await rootOf(t, {});
  const larger = trajectory(context, [step('first'), step('second'), step('third')]);
  const smaller = trajectory(context, [step('first'), step('second')]);
  assert.equal(await save(root, larger), true);
  assert.equal(await save(root, smaller), true);
  const saved = await readSaved(root);
  assert.equal(saved.steps.length, 3, 'the step the smaller save did not carry stays on disk');
  assert.deepEqual(saved.steps.map(item => item.message), ['first', 'second', 'third']);
  assert.equal(validate(saved), true);
});

test('the richer version of a step wins its position', async t => {
  const root = await rootOf(t, {});
  const plain = trajectory(context, [step('short')]);
  const rich = trajectory(context, [{ message: 'short', tool_calls: [call], observation: { results: [result] } }]);
  assert.equal(await save(root, plain), true);
  assert.equal(await save(root, rich), true);
  const saved = await readSaved(root);
  assert.equal(saved.steps.length, 1);
  assert.equal(saved.steps[0].tool_calls.length, 1);
  assert.equal(saved.steps[0].observation.results[0].content, 'File missing');
});

test('two concurrent saves of one session end with the union', async t => {
  const root = await rootOf(t, {});
  const rich = trajectory(context, [{ message: 'one', tool_calls: [call] }]);
  const longer = trajectory(context, [step('one'), step('two')]);
  await Promise.all([save(root, rich), save(root, longer)]);
  const saved = await readSaved(root);
  assert.equal(saved.steps.length, 2, 'the last writer alone would leave one step or a shorter run');
  assert.deepEqual(saved.steps.map(item => item.message), ['one', 'two']);
  assert.equal(saved.steps[0].tool_calls.length, 1, 'the richer step wins whichever save came last');
});

test('a corrupt existing file is moved aside and the save goes through', async t => {
  const root = await rootOf(t, {});
  await mkdir(join(root, 'trajectory'), { recursive: true });
  await writeFile(fileOf(root), '{ this is not json');
  assert.equal(await save(root, trajectory(context, [step('fresh')]), { now: 1700000000000 }), true);
  const names = await readdir(join(root, 'trajectory'));
  assert.ok(names.includes('okit-plugin-session-1.json.corrupt-1700000000000'), 'the corrupt file is kept aside');
  assert.equal(await readFile(join(root, 'trajectory', 'okit-plugin-session-1.json.corrupt-1700000000000'), 'utf8'),
    '{ this is not json');
  const saved = await readSaved(root);
  assert.equal(validate(saved), true);
  assert.equal(saved.steps[0].message, 'fresh');
});

test('a file that is valid JSON outside the schema is moved aside too', async t => {
  const root = await rootOf(t, {});
  await mkdir(join(root, 'trajectory'), { recursive: true });
  for (const [index, payload] of ['{"foo":1}', '[]'].entries()) {
    const session_id = `session-${index + 2}`;
    await writeFile(fileOf(root, session_id), payload);
    const data = trajectory({ ...context, session_id }, [step('fresh')]);
    assert.equal(await save(root, data, { now: 1700000000001 }), true);
    const names = await readdir(join(root, 'trajectory'));
    assert.ok(names.includes(`okit-plugin-${session_id}.json.corrupt-1700000000001`),
      `the file of ${payload} is kept aside and not merged`);
    const saved = JSON.parse(await readFile(fileOf(root, session_id), 'utf8'));
    assert.equal(validate(saved), true);
    assert.equal(saved.steps[0].message, 'fresh');
    assert.doesNotMatch(JSON.stringify(saved), /foo/, 'the content of the file aside is not merged');
  }
});

test('the merged file stays inside the configured limits', async t => {
  const root = await rootOf(t, { maxFileBytes: 1500, truncationMarker: '[shortened here]' });
  const large = trajectory(context, [step('first'), step('second '.repeat(400)), step('third')]);
  assert.equal(await save(root, large), true);
  assert.equal(await save(root, trajectory(context, [step('first'), step('second')])), true);
  const raw = await readFile(fileOf(root), 'utf8');
  assert.ok(Buffer.byteLength(raw) <= 1500, 'the merged file is capped like any other');
  const saved = JSON.parse(raw);
  assert.equal(validate(saved), true);
  assert.equal(saved.steps.length, 3);
  assert.ok(saved.steps.some(item => item.message === '[shortened here]'), 'the long step shows the marker');
});

test('the merged file never reports less usage than either file', async t => {
  const root = await rootOf(t, {});
  await mkdir(join(root, 'trajectory'), { recursive: true });
  // A file whose steps were shortened by the cap keeps the totals it had.
  const capped = {
    schema_version: 'ATIF-v1.4', session_id: 'session-1',
    agent: { name: 'okit-plugin', version: '1.0.0', extra: { role: 'executor' } },
    steps: [{ step_id: 1, timestamp: null, source: 'system', message: '[shortened here]' }],
    final_metrics: { total_steps: 1, total_prompt_tokens: 500, total_completion_tokens: 40,
      total_cached_tokens: 0, total_cost_usd: null }
  };
  await writeFile(fileOf(root), JSON.stringify(capped, null, 2));
  const data = trajectory(context, [{ message: 'fresh', tool_calls: [call], metrics: { prompt_tokens: 10 } }]);
  assert.equal(await save(root, data), true);
  const saved = await readSaved(root);
  assert.equal(saved.final_metrics.total_prompt_tokens, 500, 'the totals of the file on disk outlive the merge');
  assert.equal(saved.final_metrics.total_completion_tokens, 40);
  assert.equal(saved.final_metrics.total_steps, 1);
});

test('saving the same run twice does not duplicate it', async t => {
  const root = await rootOf(t, {});
  const data = trajectory(context, [step('one'), step('two')]);
  assert.equal(await save(root, data), true);
  const first = await readFile(fileOf(root), 'utf8');
  assert.equal(await save(root, data), true);
  const second = await readFile(fileOf(root), 'utf8');
  assert.equal(second, first, 'the same run twice leaves the same file');
  assert.equal(JSON.parse(second).steps.length, 2);
});

test('a lock that does not free up ends in a plain refusal', async t => {
  const root = await rootOf(t, {});
  const lock = join(root, 'trajectory', 'okit-plugin-retention');
  await mkdir(join(root, 'trajectory'), { recursive: true });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const running = withLock(lock, () => held);
  for (let tries = 0; tries < 100; tries++) {
    try { await stat(`${lock}.lock`); break; } catch { await sleep(5); }
  }
  const started = Date.now();
  await assert.rejects(save(root, trajectory(context, [step('one')]), { lockTimeoutMs: 60 }),
    /Recording is busy right now/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `the refusal waits only for the limit given (${elapsed} ms)`);
  release();
  await running;
  assert.equal(await readdir(join(root, 'trajectory')).then(names => names.includes('okit-plugin-session-1.json')), false);
});
