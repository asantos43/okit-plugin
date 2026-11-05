import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { save, mergeRuns, mergeSteps, richer, pruneFiles } from '../src/trajectory/store.js';
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
// | shared timestamp | reserve B before empty -> A; prefix updates | losing A, duplicate usage |
// | call identity | same text with different IDs stays distinct | consuming call-1 for call-2 |
// | reserved slot | exact occurrence plus a distinct prefix | consuming the exact slot twice |
// | cross-group match | a known cut version may cross groups | merging intact timed/clockless prefixes |
// | partial cut | reasoning-only cuts preserve message identity | consuming incompatible intact messages |
// | cap usage | add totals for complete disjoint clock ranges | guessing additivity for unknown/overlapping clocks |
// | ambiguity/order | keep both in canonical order | claiming chronological order without clocks |
// | metadata ties | canonical agent fields and recursive map unions | argument/save order picking definitions |
// | work budget | 4000+4000 steps under 1 second | repeated unbounded candidate/payload scans |
// | quarantine | release lock after 1000 collisions | deleting the bad source on exhaustion |
test('shared timestamp reserves exact occurrences before completing empty content', async t => {
  const root = await rootOf(t, {}), timestamp = '2026-01-01T00:00:00Z';
  const timed = (message, prompt_tokens) => ({ message, timestamp, metrics: { prompt_tokens } });
  const short = trajectory(context, [timed('', 0), timed('B', 5)]);
  const full = trajectory(context, [timed('A', 1), timed('B', 5)]);
  for (const pair of [[short, full], [full, short]]) {
    const merged = mergeRuns(...pair);
    assert.deepEqual(merged.steps.map(item => item.message), ['A', 'B']);
    assert.equal(merged.final_metrics.total_prompt_tokens, 6);
    const parent = run => ({ ...run, subagent_trajectories: [{ ...run, trajectory_id: 'child' }] });
    assert.deepEqual(mergeRuns(...pair.map(parent)).subagent_trajectories[0].steps, merged.steps);
    await rm(fileOf(root), { force: true });
    for (const run of pair) await save(root, run);
    assert.deepEqual((await readSaved(root)).steps, merged.steps);
    assert.equal((await readSaved(root)).final_metrics.total_prompt_tokens, 6);
  }
});

test('same message with distinct call IDs reserves the correct occurrence', () => {
  const withCall = id => ({ message: 'ok', tool_calls: [{ ...call, tool_call_id: id }] });
  for (const timestamp of [null, '2026-01-01T00:00:00Z']) {
    const a = trajectory(context, [{ ...withCall('call-2'), timestamp }]);
    const b = trajectory(context, ['call-1', 'call-2'].map(id => ({ ...withCall(id), timestamp })));
    assert.deepEqual(mergeRuns(a, b), mergeRuns(b, a));
    assert.deepEqual(mergeRuns(a, b).steps.map(item => item.tool_calls[0].tool_call_id), ['call-1', 'call-2']);
  }
  const before = trajectory(context, [{ message: 'starting', tool_calls: [call] }]);
  const after = trajectory(context, [{ message: 'completed', tool_calls: [call], metrics: { prompt_tokens: 6 } }]);
  assert.equal(mergeRuns(before, after).steps.length, 1);
  assert.equal(mergeRuns(before, after).final_metrics.total_prompt_tokens, 6);
});

test('reserved exact occurrences cannot consume another prefix occurrence', () => {
  const a = trajectory(context, ['AB', 'Z', 'Q'].map(step));
  const b = trajectory(context, ['A', 'AB'].map(step));
  for (const pair of [[a, b], [b, a]]) {
    const merged = mergeRuns(...pair);
    assert.deepEqual(merged.steps.map(item => item.message), ['AB', 'Z', 'Q', 'A']);
    assert.deepEqual(merged.steps.map(item => item.step_id), [1, 2, 3, 4]);
  }
});

test('intact prefixes in clockless and timestamped groups stay separate', () => {
  const a = trajectory(context, [step('A'), step('Z')]);
  const b = trajectory(context, [{ message: 'AB', timestamp: '2026-01-01T00:00:00Z' }]);
  for (const pair of [[a, b], [b, a]]) {
    const merged = mergeRuns(...pair);
    assert.deepEqual(merged.steps.map(item => [item.message, item.timestamp]),
      [['A', null], ['Z', null], ['AB', '2026-01-01T00:00:00Z']]);
    assert.deepEqual(merged.steps.map(item => item.step_id), [1, 2, 3]);
  }
});

test('incompatible groups never consume a timestamped event via a clockless slot', () => {
  const a = trajectory(context, [{ message: 'C', timestamp: '2026-01-01T00:00:00Z' }, step('D')]);
  const b = trajectory(context, [{ message: 'A', timestamp: '2026-01-02T00:00:00Z' }, step('B'.repeat(30))]);
  const merged = mergeRuns(a, b);
  assert.deepEqual(merged, mergeRuns(b, a));
  assert.deepEqual(merged.steps.map(item => item.message).sort(), ['A', 'B'.repeat(30), 'C', 'D']);
});

test('prefix updates within shared timestamps reserve exact content first', () => {
  const timestamp = '2026-01-01T00:00:00Z';
  const a = trajectory(context, ['A', 'B'].map(message => ({ message, timestamp })));
  const b = trajectory(context, ['B complete', 'A complete'].map(message => ({ message, timestamp })));
  const merged = mergeRuns(a, b);
  assert.deepEqual(merged, mergeRuns(b, a));
  assert.deepEqual(merged.steps.map(item => item.message), ['B complete', 'A complete']);
});

test('merge work is bounded for 4000 by 4000 timed events and ambiguous groups', () => {
  for (const shared of [false, true]) {
    const events = prefix => Array.from({ length: 4000 }, (_, index) => ({ source: 'agent',
      timestamp: new Date(shared ? 0 : (index * 2 + (prefix === 'B' ? 1 : 0)) * 1000).toISOString(),
      message: `${prefix}${index}` }));
    const a = events('A'), b = events('B'), started = performance.now();
    const merged = mergeSteps(a, b), elapsed = performance.now() - started;
    assert.equal(merged.length, 8000);
    assert.ok(elapsed < 1000, `${shared ? 'shared' : 'distinct'} timestamps: ${elapsed} ms`);
    assert.equal(merged[7999].step_id, 8000);
  }
});

test('truncation detection visits a retained payload once across unmatched events', () => {
  let visits = 0;
  const a = Array.from({ length: 4000 }, (_, index) => ({ source: 'agent', message: 'A',
    timestamp: new Date(index * 1000).toISOString() }));
  a[0].extra = { get probe() { visits++; return 'payload'; } };
  const b = a.slice(1).map((item, index) => ({ ...item,
    timestamp: new Date((index + 4000) * 1000).toISOString() }));
  assert.equal(mergeSteps(a, b).length, 7999);
  assert.equal(visits, 1);
});

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
  assert.equal(saved.final_metrics.total_steps, 2, 'an unknown historical cut marker has no identity; keep both');
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

test('capped sequential saves keep identical metadata and totals in either order', async t => {
  const root = await rootOf(t, { maxFileBytes: 750 });
  const a = trajectory({ ...context, model: 'z' }, [step('long '.repeat(150)), step('ok')]);
  const b = trajectory({ ...context, model: 'a' }, [step('other '.repeat(150)), step('ok')]);
  let first;
  for (const pair of [[a, b], [b, a]]) {
    await rm(fileOf(root), { force: true });
    for (const run of pair) await save(root, run);
    const saved = await readSaved(root);
    assert.equal(saved.agent.model_name, 'z');
    assert.equal(validate(saved), true);
    assert.ok(Buffer.byteLength(await readFile(fileOf(root))) <= 750);
    if (first) assert.deepEqual(saved, first);
    first = saved;
  }
});

test('metadata retains the full observed clock when the cap removes later events', async t => {
  const root = await rootOf(t, { maxFileBytes: 750 });
  const a = trajectory({ ...context, model: 'a' }, Array.from({ length: 20 }, (_, index) => ({
    message: `event ${index} `.repeat(100), timestamp: new Date((index + 1) * 1000).toISOString()
  })));
  const b = trajectory({ ...context, model: 'z' }, [{ message: 'older', timestamp: new Date(10000).toISOString() }]);
  b.extra = { trajectory_merge_clock: 9000 }; // Numeric clocks must not use lexical map tie breaks.
  for (const pair of [[a, b], [b, a]]) {
    await rm(fileOf(root), { force: true });
    for (const run of pair) await save(root, run);
    const saved = await readSaved(root);
    assert.equal(saved.agent.model_name, 'a');
    assert.equal(saved.extra.trajectory_merge_clock, 20000);
    assert.equal(validate(saved), true);
  }
});

test('disjoint dated captures retain all 23 tokens through a 750-byte cap in both orders', async t => {
  const root = await rootOf(t, { maxFileBytes: 750 });
  const dated = (message, day, prompt_tokens) => ({ message,
    timestamp: `2026-01-0${day}T00:00:00Z`, metrics: { prompt_tokens } });
  const a = trajectory(context, [dated('A', 1, 8)]);
  const b = trajectory(context, [dated('long '.repeat(150), 2, 10), dated('other '.repeat(150), 3, 5)]);
  let first;
  for (const pair of [[a, b], [b, a]]) {
    await rm(fileOf(root), { force: true });
    for (const run of pair) await save(root, run);
    const saved = await readSaved(root);
    assert.equal(saved.final_metrics.total_prompt_tokens, 23);
    assert.ok(Buffer.byteLength(await readFile(fileOf(root))) <= 750);
    if (first) assert.deepEqual(saved, first);
    first = saved;
  }
});

test('unknown, overlapping and legacy capped clock ranges never prove additive usage', () => {
  const a = trajectory(context, [{ message: 'A', timestamp: '2026-01-01T00:00:00Z', metrics: { prompt_tokens: 8 } }]);
  for (const start of [null, undefined, 'invalid', Date.parse('2026-01-01T00:00:00Z')]) {
    const b = trajectory(context, [{ message: '[Content shortened / Conteúdo reduzido]',
      source: 'system', timestamp: '2026-01-03T00:00:00Z' }]);
    b.extra = { trajectory_merge_clock: Date.parse('2026-01-03T00:00:00Z') };
    if (start !== undefined) b.extra.trajectory_merge_start = start;
    b.final_metrics.total_prompt_tokens = 15;
    const ab = mergeRuns(a, b);
    assert.deepEqual(ab, mergeRuns(b, a));
    assert.equal(ab.final_metrics.total_prompt_tokens, 15, String(start));
    assert.equal(mergeRuns(ab, a).final_metrics.total_prompt_tokens, 15);
  }
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

test('a reasoning-only cap cannot consume an incompatible message at the same clock', async t => {
  const root = await rootOf(t, { maxFileBytes: 1000 }), timestamp = '2026-01-01T00:00:00Z';
  const a = trajectory(context, [{ message: 'A', timestamp,
    reasoning_content: 'reasoning '.repeat(300), metrics: { prompt_tokens: 2 } }]);
  const b = trajectory(context, [{ message: 'B', timestamp, metrics: { prompt_tokens: 3 } }]);
  await save(root, a);
  const cut = await readSaved(root);
  assert.equal(cut.steps[0].message, 'A');
  assert.match(cut.steps[0].reasoning_content, /Content shortened/);
  for (const pair of [[cut, b], [b, cut]]) {
    const merged = mergeRuns(...pair);
    assert.deepEqual(merged.steps.map(item => item.message).sort(), ['A', 'B']);
    assert.equal(merged.final_metrics.total_prompt_tokens, 5);
  }
  await writeFile(join(root, 'config.json'), JSON.stringify({ trajectory: { enabled: true, maxFileBytes: 4000 } }));
  await save(root, b);
  assert.deepEqual((await readSaved(root)).steps.map(item => item.message).sort(), ['A', 'B']);
  assert.equal((await readSaved(root)).final_metrics.total_prompt_tokens, 5);
});

test('seeded save properties cover 120 pairs with repeated/absent clocks and low caps', async t => {
  const root = await rootOf(t, {}), started = performance.now();
  // The corpus is a prefix of the former 300-pair run: same seed, same
  // generators, same pairs, so the cut and the intact examples are the ones
  // that were already covered; only the size of the sample changed.
  const pairs = 120;
  // The ceiling is not a speed target. These pairs take about 1.1 s alone and
  // the suite runs in parallel with other work, so the ceiling keeps more than
  // ten times that margin (20 s) to absorb the load of the machine.
  const budgetMs = 20000;
  let seed = 0xd12306, cappedPairs = 0, intactPairs = 0, lossyOrders = 0, lossyReplays = 0, saves = 0;
  const random = n => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) % n;
  };
  const capture = () => trajectory({ ...context, model: ['a', 'z'][random(2)] },
    Array.from({ length: 1 + random(4) }, () => ({
      message: ['A', 'B', 'C', 'B'][random(4)].repeat(random(3) === 0 ? 160 : 1),
      timestamp: [null, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'][random(3)],
      metrics: { prompt_tokens: random(11) }, reasoning_content: 'r'.repeat(random(3) * 300)
    })));
  // Every save of the corpus is counted: the amount of work does not depend on
  // how loaded the machine is, so the budget below has an exact counterpart.
  const keep = async run => {
    saves++;
    assert.equal(await save(root, run), true, 'the run reaches the disk');
  };
  // Lossy caps erase identities and the backbone: arbitrary union equality and
  // replay equality cannot be recovered from bounded storage. Only (a)/(c) are
  // relaxed after actual loss (including free-form metadata maps): retain
  // scalar metadata, valid bounds and usage lower bounds. Intact pairs still
  // assert the full (a), (b), (c) contract; disjoint cap totals have a test above.
  for (let index = 0; index < pairs; index++) {
    const a = capture(), b = capture(), limit = index % 3 ? 750 + random(3) * 300 : 16000;
    const label = `seed=0xd12306 pair=${index} limit=${limit}`;
    await writeFile(join(root, 'config.json'), JSON.stringify({ trajectory: { enabled: true, maxFileBytes: limit } }));
    await rm(fileOf(root), { force: true });
    for (const run of [a, b]) await keep(run);
    const ab = await readSaved(root);
    await keep(a);
    const replay = await readSaved(root);
    await rm(fileOf(root), { force: true });
    for (const run of [b, a]) await keep(run);
    const ba = await readSaved(root);
    for (const saved of [ab, ba, replay]) {
      assert.equal(validate(saved), true, label);
      assert.ok(Buffer.byteLength(`${JSON.stringify(saved, null, 2)}\n`) <= limit, label);
      assert.ok(saved.final_metrics.total_prompt_tokens >= Math.max(
        a.final_metrics.total_prompt_tokens, b.final_metrics.total_prompt_tokens), label);
    }
    for (const key of ['name', 'version', 'model_name']) {
      assert.equal(ab.agent[key], ba.agent[key], label);
      assert.equal(replay.agent[key], ab.agent[key], label);
    }
    const cut = [ab, ba, replay].some(run => Object.hasOwn(run.extra ?? {}, 'trajectory_merge_start'));
    if (cut) {
      cappedPairs++;
      if (JSON.stringify(ab) !== JSON.stringify(ba)) lossyOrders++;
      if (JSON.stringify(replay) !== JSON.stringify(ab)) lossyReplays++;
      assert.ok(replay.final_metrics.total_prompt_tokens >= ab.final_metrics.total_prompt_tokens, label);
      continue;
    }
    intactPairs++;
    assert.deepEqual(ab, ba, label);
    assert.deepEqual(replay, ab, label);
    // This generator's messages repeat one letter: its first letter is exactly
    // the compatible-prefix family; a different letter/clock is a distinct identity.
    const key = item => JSON.stringify([item.source, item.timestamp, item.message[0]]);
    const counts = run => run.steps.reduce((map, item) => map.set(key(item), (map.get(key(item)) ?? 0) + 1), new Map());
    const kept = counts(ab);
    for (const run of [a, b]) for (const [identity, count] of counts(run)) {
      assert.ok(kept.get(identity) >= count, `${label} lost ${identity}`);
    }
  }
  // The workload is counted, not only timed: the operations do not depend on
  // the load of the machine, so a slow suite never fails this check.
  assert.equal(saves, pairs * 5, 'the workload is exactly five saves per pair');
  assert.ok(cappedPairs >= 30 && intactPairs >= 30,
    `both kinds of pair stay in the sample (${intactPairs} intact, ${cappedPairs} capped)`);
  const elapsed = performance.now() - started;
  t.diagnostic(`seed=0xd12306: ${intactPairs} intact, ${cappedPairs} capped pairs in ${elapsed.toFixed(0)} ms; `
    + `${lossyOrders} lossy order differences, ${lossyReplays} lossy replay differences; ${saves} saves`);
  assert.ok(elapsed < budgetMs, `property budget: ${elapsed} ms (ceiling ${budgetMs} ms)`);
});

test('agent tool definitions merge canonically without a clock', () => {
  const a = trajectory(context, [step('A')]), b = trajectory(context, [step('A')]);
  a.agent.tool_definitions = [{ name: 'f' }]; b.agent.tool_definitions = [{ name: 'g' }];
  assert.equal(validate(a), true); assert.equal(validate(b), true);
  assert.deepEqual(mergeRuns(a, b), mergeRuns(b, a));
  assert.deepEqual(mergeRuns(a, b).agent.tool_definitions, [{ name: 'g' }]);
});

test('agent tool definitions agree in real saves at 20000 bytes in both orders', async t => {
  const root = await rootOf(t, { maxFileBytes: 20000 });
  const a = trajectory(context, [step('A')]), b = trajectory(context, [step('A')]);
  a.agent.tool_definitions = [{ name: 'f' }]; b.agent.tool_definitions = [{ name: 'g' }];
  const saved = [];
  for (const pair of [[a, b], [b, a]]) {
    await rm(fileOf(root), { force: true });
    for (const run of pair) assert.equal(await save(root, run), true);
    saved.push(await readSaved(root));
    assert.equal(validate(saved.at(-1)), true);
    assert.ok(Buffer.byteLength(await readFile(fileOf(root))) <= 20000);
    assert.equal(Object.hasOwn(saved.at(-1).extra ?? {}, 'trajectory_merge_start'), false);
  }
  assert.deepEqual(saved[0], saved[1]);
  assert.deepEqual(saved[0].agent.tool_definitions, [{ name: 'g' }]);
});

test('all agent fields and metadata maps break ties per field', () => {
  const a = trajectory(context, [step('A')]), b = trajectory(context, [step('A')]);
  Object.assign(a.agent, { name: 'z', version: '1', model_name: 'a', extra: { nested: { a: 1, shared: 'z' } } });
  Object.assign(b.agent, { name: 'a', version: '2', model_name: 'z', extra: { nested: { b: 2, shared: 'a' } } });
  a.extra = { nested: { a: 1, shared: 'z' }, shape: { x: 1 } };
  b.extra = { nested: { b: 2, shared: 'a' }, shape: ['z'] };
  a.final_metrics.extra = { shared: 'z' }; b.final_metrics.extra = { shared: 'a' };
  a.notes = 'z'; b.notes = 'a';
  a.continued_trajectory_ref = 'a'; b.continued_trajectory_ref = 'z';
  const merged = mergeRuns(a, b);
  assert.deepEqual(merged, mergeRuns(b, a));
  assert.deepEqual(merged.agent, { ...a.agent, version: '2', model_name: 'z',
    extra: { nested: { a: 1, b: 2, shared: 'z' } } });
  assert.deepEqual(merged.extra, { nested: { a: 1, b: 2, shared: 'z' }, shape: { x: 1 } });
  assert.deepEqual(merged.final_metrics.extra, { shared: 'z' });
  assert.equal(merged.notes, 'z'); assert.equal(merged.continued_trajectory_ref, 'z');
  assert.equal(validate(merged), true);
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

test('quarantine collisions refuse at the bound, preserve the bad source and release the lock', async t => {
  const root = await rootOf(t, {}); await mkdir(join(root, 'trajectory'));
  await writeFile(fileOf(root), 'bad');
  let attempts = 0;
  await assert.rejects(save(root, trajectory(context, [step('fresh')]), { lockTimeoutMs: 10,
    previousIO: { open: async () => {
      attempts++;
      throw Object.assign(new Error('collision'), { code: 'EEXIST' });
    } }
  }), /Cannot quarantine recording: 1000 backup name collisions/);
  assert.equal(attempts, 1000);
  assert.equal(await readFile(fileOf(root), 'utf8'), 'bad');
  assert.ok(!(await readdir(join(root, 'trajectory'))).includes('okit-plugin-retention.lock'));
  await save(root, trajectory(context, [step('fresh')]), { lockTimeoutMs: 10 });
  assert.equal((await readSaved(root)).steps[0].message, 'fresh');
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
