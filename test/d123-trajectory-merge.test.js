import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { save, mergeRuns, richer, pruneFiles } from '../src/trajectory/store.js';
import { readTrajectory } from '../adapters/opencode/trajectory.js';
import { prune } from '../src/trajectory/index.js';
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

test('OpenCode empty messages becoming content preserve A and B in both save orders', async t => {
  const root = await rootOf(t, {});
  const row = text => ({ info: { role: 'assistant' }, parts: [{ type: 'text', text }] });
  const short = readTrajectory([row(''), row('B')], context);
  const full = readTrajectory([row('A'), row('B')], context);
  for (const pair of [[short, full], [full, short]]) {
    await rm(fileOf(root), { force: true });
    await Promise.all(pair.map(run => save(root, run)));
    const saved = await readSaved(root);
    assert.deepEqual(saved.steps.map(item => item.message), ['A', 'B']);
    assert.deepEqual(saved.steps.map(item => item.step_id), [1, 2]);
    assert.equal(validate(saved), true);
  }
});

// | Corpus | Must pass | Must refuse |
// | existing file | a longer run, a richer step | a corrupt file, a busy lock |
// | identity | empty -> A before B, rewritten/repeated messages | positional IDs as identity |
// | merged file | complete content, equal steps/totals in either order | markers winning real content |
// | retention | unique backups inside age/byte/file budgets | unbounded backups, silent failed rename |
// | previous file | stat before bounded JSON read | reading oversized content |
test('rewritten transcripts align messages without a stale duplicate tail', () => {
  const a = trajectory(context, ['A', 'B', 'C'].map(step));
  const b = trajectory(context, ['C', 'A', 'B'].map(step));
  const forward = mergeRuns(a, b), reverse = mergeRuns(b, a);
  assert.deepEqual(forward, reverse);
  assert.equal(forward.steps.length, 3);
  assert.deepEqual([...new Set(forward.steps.map(item => item.message))].sort(), ['A', 'B', 'C']);
  assert.deepEqual(forward.steps.map(item => item.step_id), [1, 2, 3]);
  assert.deepEqual(a.steps.map(item => item.message), ['A', 'B', 'C']);
});

test('timestamp identity survives changed content and position', () => {
  const a = trajectory(context, [{ message: 'A', timestamp: '2026-01-01T00:00:00Z' }]);
  const b = trajectory(context, [{ message: 'new', timestamp: '2026-01-01T00:00:01Z' },
    { message: 'A completed', timestamp: '2026-01-01T00:00:00Z' }]);
  assert.deepEqual(mergeRuns(a, b), mergeRuns(b, a));
  assert.deepEqual(mergeRuns(a, b).steps.map(item => item.message), ['new', 'A completed']);
});

test('repeated messages keep occurrence count and timestamped distinct events survive', () => {
  const a = trajectory(context, ['A', 'A', 'B'].map(step));
  const b = trajectory(context, ['A', 'B'].map(step));
  assert.deepEqual(mergeRuns(a, b).steps.map(item => item.message), ['A', 'A', 'B']);
  const timed = message => trajectory(context, [{ message, timestamp: `2026-01-0${message === 'A' ? 1 : 2}T00:00:00Z` }]);
  assert.equal(mergeRuns(timed('A'), timed('B')).steps.length, 2);
  assert.deepEqual(mergeRuns(timed('A'), timed('B')), mergeRuns(timed('B'), timed('A')));
});

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
  const rich = trajectory(context, [{ message: 'one', tool_calls: [call], metrics: { prompt_tokens: 30 } }]);
  const longer = trajectory(context, [step('one'), { message: 'two', metrics: { completion_tokens: 10 } }]);
  let first;
  for (const pair of [[rich, longer], [longer, rich]]) {
    await rm(fileOf(root), { force: true });
    await Promise.all(pair.map(run => save(root, run)));
    const current = await readSaved(root);
    if (first) assert.deepEqual(current, first);
    first = current;
  }
  const saved = await readSaved(root);
  assert.equal(saved.steps.length, 2, 'the last writer alone would leave one step or a shorter run');
  assert.deepEqual(saved.steps.map(item => item.message), ['one', 'two']);
  assert.equal(saved.steps[0].tool_calls.length, 1, 'the richer step wins whichever save came last');
  assert.equal(saved.final_metrics.total_prompt_tokens, 30);
  assert.equal(saved.final_metrics.total_completion_tokens, 10);
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

test('raising the cap from 750 to 4000 restores long text and ok', async t => {
  const root = await rootOf(t, { maxFileBytes: 750 });
  const data = trajectory(context, [step('long '.repeat(150)), step('ok')]);
  await save(root, data);
  assert.ok((await readSaved(root)).steps.some(item => item.message.includes('Content shortened')));
  await writeFile(join(root, 'config.json'), JSON.stringify({ trajectory: { enabled: true, maxFileBytes: 4000 } }));
  await save(root, data);
  assert.deepEqual((await readSaved(root)).steps, data.steps);
  assert.equal(richer({ message: '[truncated: too deep]' }, { message: 'ok' }), false);
  assert.equal(richer({ message: 'long', extra: { nested: '[custom cut]' } }, { message: 'ok' }, '[custom cut]'), false);
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

test('metadata and child runs merge deterministically with map unions', () => {
  const a = trajectory(context, [step('A')]), b = trajectory(context, [step('B')]);
  a.agent.extra.left = true; b.agent.extra.right = true;
  a.extra = { a: 1, shared: 'a' }; b.extra = { b: 2, shared: 'b' };
  a.final_metrics.extra = { a: 1 }; b.final_metrics.extra = { b: 2 };
  a.agent.model_name = 'a'; b.agent.model_name = 'b';
  a.subagent_trajectories = [{ ...trajectory(context, [step('child')]), trajectory_id: 'child' }];
  b.subagent_trajectories = [{ ...trajectory(context, [step('child'), step('next')]), trajectory_id: 'child' }];
  const merged = mergeRuns(a, b);
  assert.deepEqual(merged, mergeRuns(b, a));
  assert.equal(merged.agent.extra.left, true); assert.equal(merged.agent.extra.right, true);
  assert.deepEqual(merged.final_metrics.extra, { a: 1, b: 2 });
  assert.equal(merged.subagent_trajectories[0].steps.length, 2);
  assert.equal(validate(merged), true);
  a.steps[0].timestamp = '2026-01-02T00:00:00Z';
  b.steps[0].timestamp = '2026-01-01T00:00:00Z';
  assert.equal(mergeRuns(a, b).agent.model_name, 'a', 'newer observed event wins scalars');
  assert.deepEqual(mergeRuns(a, b), mergeRuns(b, a));
});

test('backups share byte, age and file count retention, oldest first', async t => {
  const root = await rootOf(t, {}), dir = join(root, 'trajectory');
  await mkdir(dir);
  const config = { dir, maxBytes: 1000, maxFileBytes: 4000, retentionDays: 30 };
  for (const suffix of ['1', '2']) await writeFile(`${fileOf(root)}.corrupt-${suffix}`, 'x'.repeat(2001));
  await save(root, trajectory(context, [step('fresh')]));
  assert.equal((await pruneFiles(config)).removed, 2);
  assert.deepEqual(await readdir(dir), ['okit-plugin-session-1.json']);
  for (const suffix of ['1', '2']) await writeFile(`${fileOf(root)}.corrupt-${suffix}`, 'bad');
  const newer = `${fileOf(root)}.corrupt-2`, recent = new Date();
  await utimes(`${fileOf(root)}.corrupt-1`, new Date(1000), new Date(1000));
  await utimes(newer, recent, new Date(recent.getTime() + 1000));
  assert.equal((await pruneFiles({ ...config, maxFiles: 1 })).removed, 2);
  assert.deepEqual(await readdir(dir), ['okit-plugin-session-1.json.corrupt-2']);
  assert.equal((await pruneFiles(config, Date.now() + 31 * 86400000)).removed, 1);
  await writeFile(`${fileOf(root)}.corrupt-3`, 'x'.repeat(2001));
  await writeFile(join(root, 'config.json'), JSON.stringify({ trajectory: { enabled: true, maxBytes: 1000 } }));
  assert.equal((await prune(root)).removed, 1, 'public prune also works when only backups remain');
});

test('backups use exclusive names even with the same clock', async t => {
  const root = await rootOf(t, {}); await mkdir(join(root, 'trajectory'));
  for (const text of ['bad one', 'bad two']) {
    await writeFile(fileOf(root), text);
    await save(root, trajectory(context, [step('fresh')]), { now: 42 });
  }
  assert.equal(await readFile(`${fileOf(root)}.corrupt-42`, 'utf8'), 'bad one');
  assert.equal(await readFile(`${fileOf(root)}.corrupt-42-1`, 'utf8'), 'bad two');
});

test('failed backup rename removes the bad source or refuses plainly', async t => {
  const root = await rootOf(t, {}); await mkdir(join(root, 'trajectory'));
  const denied = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  await writeFile(fileOf(root), 'bad');
  await save(root, trajectory(context, [step('fresh')]), { previousIO: { rename: denied } });
  assert.equal((await readSaved(root)).steps[0].message, 'fresh');
  await writeFile(fileOf(root), 'bad again');
  await assert.rejects(save(root, trajectory(context, [step('fresh')]), {
    previousIO: { rename: denied, rm: denied }
  }), /Cannot replace recording/);
  assert.equal(await readFile(fileOf(root), 'utf8'), 'bad again');
});

test('oversized previous file is separated without invoking the JSON reader', async t => {
  const root = await rootOf(t, { maxFileBytes: 1000 });
  await mkdir(join(root, 'trajectory'));
  await writeFile(fileOf(root), 'x'.repeat(10001));
  let reads = 0, stats = 0;
  await save(root, trajectory(context, [step('fresh')]), { previousIO: {
    stat: async file => { stats++; return stat(file); },
    readJson: async () => { reads++; throw new Error('must not read'); }
  } });
  assert.equal(stats, 1); assert.equal(reads, 0);
  assert.equal((await readSaved(root)).steps[0].message, 'fresh');
  assert.deepEqual(await readdir(join(root, 'trajectory')), ['okit-plugin-session-1.json']);
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
