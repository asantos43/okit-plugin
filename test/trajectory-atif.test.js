import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trajectory, normalize, validate, readable, totals, MAX_DEPTH } from '../src/trajectory/schema.js';
import { save, list, exportTrajectory, show } from '../src/trajectory/index.js';
import { capture } from '../src/trajectory/capture.js';
import { TOOLS } from '../src/mcp/tools.js';
import { samples } from './helpers/trajectory-samples.js';
import { codexFixture } from './helpers/trajectory-samples.js';
import { fuzz, diff, conservation, conservationCases } from '../scripts/check-atif.mjs';
import { redact } from '../src/trajectory/redact.js';
import { settings } from '../src/trajectory/config.js';
import { records } from '../src/trajectory/read.js';
const context = { session_id: 'atif', model: 'example-model' };
// | Review 14 | Must pass | Must refuse / skip |
// | decoding | leading BOM, CRLF, Unicode message text | BOM stripping inside chunks |
// | cost | sub-MiB empty rows in <2s, 8x rows in <12x time | empty-object steps |
test('review 14: JSONL skips empty rows before parsing and parses content rows once', () => {
  const parse = JSON.parse; let calls = 0;
  try {
    JSON.parse = (...args) => { calls++; return parse(...args); };
    assert.deepEqual(records('{}\n[]\n0\nnull\n""\n\n{"content":"x"}\n{"content":"y"}'),
      [{ content: 'x' }, { content: 'y' }]);
    assert.equal(calls, 2);
  } finally { JSON.parse = parse; }
});
for (const [client, reader] of samples) test(`review 14: ${client} cheap JSONL stays within budget`, async t => {
  const root = await rootOf(t);
  const measure = async n => {
    const input = '{}\n'.repeat(n - 1) + '{}', start = performance.now();
    const data = normalize(reader(input, context));
    assert.equal(await save(root, data), true);
    const elapsed = performance.now() - start;
    assert.equal(data.steps.length, 1); return elapsed;
  };
  await measure(3000);
  const small = await measure(30000), large = await measure(240000), full = await measure(349333);
  assert.ok(full < 2000, `${client}: ${full} ms`);
  assert.ok(large < Math.max(small, 1) * 12, `${client}: ${small} / ${large} ms`);
  for (const line of ['{}', '[]', '0', 'null', '""', '', '{ }']) {
    const start = performance.now(), data = reader(Array(30000).fill(line).join('\r\n'), context);
    assert.ok(validate(data)); assert.equal(data.steps.length, 1);
    assert.equal(data.steps[0].message, '');
    assert.ok(performance.now() - start < 2000);
  }
});
// | Review 13 | Must pass | Must refuse / repair |
for (const [client, reader] of samples) test(`review 14: ${client} BOM transcripts preserve messages and file capture`, async t => {
  const root = await rootOf(t), file = join(root, 'transcript.jsonl');
  const rowOf = message => client === 'claude-code' ? { message: { role: 'user', content: message } }
    : client === 'codex' ? { type: 'message', role: 'user', content: message }
      : { info: { role: 'user' }, parts: [{ type: 'text', text: message }] };
  for (const message of ['keep me', 'keep me\u2028', 'keep me\u2029', 'keep me\ud800']) {
    const row = rowOf(message), json = JSON.stringify(row);
    for (const body of [json, JSON.stringify([row], null, 2), `${json}\r\n${json}\r\n`]) {
      for (const prefix of ['\ufeff', '\ufeff\r\n\r\n']) {
        const transcript = prefix + body, data = reader(transcript, context);
        assert.equal(data.steps[0].message, message); assert.ok(validate(data));
        await writeFile(file, transcript);
        assert.equal(await capture(root, { ...context, client }, { file }), true);
        const saved = JSON.parse(await readFile(join(root, 'trajectory', 'okit-plugin-atif.json'), 'utf8'));
        assert.equal(saved.steps[0].message, message); assert.ok(validate(saved));
      }
    }
  }
});
// | conservation | usage moved once; metadata kept | restored usage; discarded receipts |
test('review 13 finding 1: orphan result does not restore folded prompt tokens', () => {
  const input = { steps: [{ source: 'agent', message: 'A', metrics: { prompt_tokens: 10 } },
    { source: 'system', message: 'B', metrics: { prompt_tokens: 2 }, observation: { results: [{ content: 'ok' }] } }] };
  const output = normalize(input);
  assert.equal(output.final_metrics.total_prompt_tokens, 12);
  assert.deepEqual(conservation(input, output), []);
});
test('review 13 finding 2: null usage retains the system metrics receipt', () => {
  const input = { steps: [{ source: 'system', message: 'B', metrics: { prompt_tokens: null,
    completion_tokens: null, cached_tokens: null, cost_usd: null, extra: { receipt: 'keep-me' } } }] };
  const output = normalize(input);
  assert.deepEqual(conservation(input, output), []);
  assert.equal(output.steps[0].extra.metrics.extra.receipt, 'keep-me');
});
test('review 13: conservation oracle covers fixtures and 300 seeded multi-step legacy files', async () => {
  for (const folder of ['atif-diff', 'atif-valid']) {
    const dir = new URL(`./fixtures/${folder}/`, import.meta.url);
    for (const name of (await readdir(dir)).filter(name => name.endsWith('.json') && name !== 'verdicts.json')) {
      const input = JSON.parse(await readFile(new URL(name, dir)));
      assert.deepEqual(conservation(input, normalize(input)), [], `${folder}/${name}`);
    }
  }
  for (const [index, input] of [...conservationCases(300)].entries()) {
    const output = normalize(input); assert.ok(validate(output));
    assert.deepEqual(conservation(input, output), [], `generated case ${index}`);
  }
});
test('review 13: conservation oracle rejects duplicated usage and lost metadata', () => {
  const input = [...conservationCases(1)][0], output = normalize(input);
  const duplicate = structuredClone(output); duplicate.steps[0].metrics.completion_tokens++;
  assert.ok(conservation(input, duplicate).some(reason => reason.includes('completion_tokens changed')));
  const lost = structuredClone(output); delete lost.steps[0].extra;
  assert.ok(conservation(input, lost).some(reason => reason.includes('metadata')));
  const stale = structuredClone(output); stale.final_metrics.total_cached_tokens++;
  assert.ok(conservation(input, stale).some(reason => reason.includes('total_cached_tokens')));
});
// | Review 12 | Must pass | Must refuse / repair |
// | timestamps | bounded ISO dates | long digits, plus runs, line terminators |
// | capture | exact step/usage totals | stale reader totals, duplicate usage |
// | redaction | complete PEM golden; linear incomplete markers | unbounded pattern input |
test('review 12: hostile timestamp text never throws and is repaired quickly', async t => {
  const root = await rootOf(t);
  const stamps = ['\n', '\r', '\u2028'].map(end => '2026-11-04T12:00:00' + '+'.repeat(64000) + end + '!');
  stamps.push('9'.repeat(64000) + '-11-04T12:00:00', '2026-11-04T12:00:00+\n!');
  for (const timestamp of stamps) {
    const data = trajectory(context, [{ message: 'Hello' }]); data.steps[0].timestamp = timestamp;
    let start = performance.now(); assert.equal(validate(data), false);
    assert.ok(performance.now() - start < 1000);
    start = performance.now(); const fixed = normalize(data);
    assert.ok(performance.now() - start < 1000); assert.ok(validate(fixed));
    assert.equal(fixed.steps[0].timestamp, null);
    start = performance.now(); assert.equal(await save(root, data), true);
    assert.ok(performance.now() - start < 1000);
    assert.ok(validate(JSON.parse(await readFile(join(root, 'trajectory', 'okit-plugin-atif.json'), 'utf8'))));
  }
});
for (const [client, , transcript] of samples) test(`review 12: ${client} capture counts added steps and usage once`, async t => {
  const root = await rootOf(t);
  assert.equal(await capture(root, { ...context, client }, { transcript, message: 'Start', outcome: 'Done',
    usage: { prompt_tokens: 2, completion_tokens: 1, cached_tokens: 1, cost_usd: 0.25 } }), true);
  const data = JSON.parse(await readFile(join(root, 'trajectory', 'okit-plugin-atif.json'), 'utf8'));
  assert.ok(validate(data)); assert.equal(data.final_metrics.total_steps, data.steps.length);
  for (const [key, expected] of Object.entries({ prompt_tokens: 14, completion_tokens: 5, cached_tokens: 4, cost_usd: 0.25 })) {
    assert.equal(data.final_metrics[`total_${key}`], expected);
    assert.equal(data.steps.reduce((sum, item) => sum + (item.metrics?.[key] ?? 0), 0), expected);
  }
});
test('review 12: incomplete PEM markers redact and save linearly; complete blocks keep golden output', async t => {
  const root = await rootOf(t), config = await settings(root);
  const begin = '-----BEGIN PRIVATE KEY-----\n';
  const golden = 'before -----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END EC PRIVATE KEY----- after';
  assert.equal(redact(golden, config), `before ${config.redactionMarker} after`);
  redact(begin.repeat(100), config); // Warm up before comparing median timings.
  const measure = n => {
    const text = begin.repeat(n), times = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now(); assert.equal(redact(text, config), text); times.push(performance.now() - start);
    }
    return times.sort((a, b) => a - b)[1];
  };
  const small = measure(8000), large = measure(16000);
  assert.ok(large < 300, `${large} ms`); assert.ok(large < Math.max(small, 1) * 3.5, `${small} / ${large}`);
  const start = performance.now(); await save(root, trajectory(context, [{ message: begin.repeat(16000) }]));
  assert.ok(performance.now() - start < 300);
  assert.ok(validate(JSON.parse(await readFile(join(root, 'trajectory', 'okit-plugin-atif.json'), 'utf8'))));
});
// | Review 11 | Must pass | Must refuse |
// | readers / keys | linear repeats; own JSON keys retained | inherited dispatch; prototype mutation |
const repeatedInputs = [
  ['claude-code', 'results', '{"type":"result","result":"done"}'],
  ['claude-code', 'users', '{"type":"user","message":{"content":"u"}}'],
  ['claude-code', 'tools', '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"same","name":"read","input":{}}]}}\n{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"same","content":"ok"}]}}'],
  ['codex', 'tools', '{"type":"function_call","call_id":"same","name":"read","arguments":"{}"}\n{"type":"function_call_output","call_id":"same","output":"ok"}'],
  ['opencode', 'parts', '{"info":{"role":"assistant"},"parts":[{"type":"tool","callID":"same","tool":"read","state":{"input":{},"status":"completed","output":"ok"}}]}'],
  ['opencode', 'single-message parts', '{"info":{"role":"assistant"},"parts":[{"type":"tool","callID":"same","tool":"read","state":{"input":{},"status":"completed","output":"ok"}}]}'],
];
for (const [client, shape, line] of repeatedInputs) test(`review 11: ${client} repeated ${shape} runs in linear time`, () => {
  const reader = samples.find(([name]) => name === client)[1];
  const inputOf = n => shape === 'single-message parts'
    ? JSON.stringify({ info: { role: 'assistant' }, parts: Array(n).fill(JSON.parse(line).parts[0]) })
    : Array(n).fill(line).join('\n');
  // Count predicate visits too: elapsed ratios can hide quadratic scans under parser overhead.
  const some = Array.prototype.some; let visits = 0;
  try {
    Array.prototype.some = function (predicate, receiver) {
      return some.call(this, (value, index, array) => {
        visits++; return predicate.call(receiver, value, index, array);
      });
    };
    reader(inputOf(3000), context);
  } finally { Array.prototype.some = some; }
  assert.ok(visits < 300000, `${client}/${shape}: ${visits} predicate visits for 3k repeats`);
  const measure = n => {
    const input = inputOf(n); let best = Infinity;
    for (let i = 0; i < 2; i++) {
      const start = performance.now(), data = reader(input, context);
      best = Math.min(best, performance.now() - start);
      assert.equal(data.steps.length, shape === 'single-message parts' ? 1 : n); assert.ok(validate(data));
    }
    return best;
  };
  measure(1000);
  const small = measure(3000), large = measure(24000);
  assert.ok(large < 20 * small + 100, `3k: ${small} ms; 24k: ${large} ms`);
  assert.ok(large < 5000, `24k: ${large} ms`);
});
const prototypeKeys = JSON.parse('{"__proto__":{"payload":"kept"},"constructor":{"payload":"kept"},"prototype":{"payload":"kept"},"toString":{"payload":"kept"},"hasOwnProperty":{"payload":"kept"}}');
test('review 11: raw JSON prototype keys survive normalize and save at every level', async t => {
  const root = await rootOf(t);
  const input = JSON.parse(JSON.stringify({ ...prototypeKeys, session_id: 'atif', extra: { nested: prototypeKeys },
    agent: { name: 'a', version: '1', ...prototypeKeys },
    steps: [{ source: 'agent', message: '', ...prototypeKeys,
      tool_calls: [{ tool_call_id: 'same', function_name: 'read', arguments: prototypeKeys, ...prototypeKeys }],
      observation: { results: [{ source_call_id: 'same', content: 'ok', ...prototypeKeys }] },
      metrics: { prompt_tokens: 1 } },
    { source: 'system', message: '', metrics: { completion_tokens: 1, extra: prototypeKeys } }] }));
  assert.equal(validate(input), false);
  const output = normalize(input); assert.ok(validate(output));
  const check = data => {
    const item = data.steps[0], call = item.tool_calls[0], result = item.observation.results[0];
    for (const value of [data.extra, data.extra.nested, data.agent.extra, item.extra, call.extra, call.arguments, result.extra, item.metrics.extra]) {
      for (const key of Object.keys(prototypeKeys)) {
        assert.ok(Object.hasOwn(value, key), key); assert.deepEqual(value[key], { payload: 'kept' });
      }
      assert.equal(Object.getPrototypeOf(value), Object.prototype);
    }
    assert.equal(({}).payload, undefined);
  };
  check(output); assert.deepEqual(normalize(output), output);
  assert.equal(await save(root, input), true);
  const saved = JSON.parse(await readFile(join(root, 'trajectory', 'okit-plugin-atif.json'), 'utf8'));
  check(saved); assert.ok(validate(saved)); assert.deepEqual(saved, output);
});
// | Review 10 | Must pass | Must refuse |
// | cost / scope | linear user runs, same-step repeated IDs | cross-step result binding |
test('review 10: 20k Codex user lines normalize in linear time', () => {
  const reader = samples.find(([client]) => client === 'codex')[1];
  const line = '{"type":"message","role":"user","text":"u"}';
  const measure = n => {
    const input = Array(n).fill(line).join('\n');
    let best = Infinity;
    for (let i = 0; i < 2; i++) {
      const start = performance.now(), data = reader(input, context);
      best = Math.min(best, performance.now() - start);
      assert.equal(data.steps.length, n); assert.ok(validate(data));
    }
    return best;
  };
  measure(1000);
  // Quadratic work would make 24k about 64x the cost of 3k; linear is about 8x.
  const small = measure(3000), large = measure(24000);
  assert.ok(large < 20 * small + 100, `3k: ${small} ms; 24k: ${large} ms`);
  assert.ok(large < 5000, `24k: ${large} ms`);
});
test('review 10: show and trajectory_show resolve repeated IDs in their own step', async t => {
  const root = await rootOf(t), data = trajectory(context, [{ message: 'Root' }]);
  data.steps = ['read', 'write'].map((name, i) => ({ step_id: i + 1, source: 'agent', message: '',
    tool_calls: [{ tool_call_id: 'same', function_name: name, arguments: {} }],
    ...(i ? { observation: { results: [{ source_call_id: 'same', content: 'written' }] } } : {}) }));
  assert.ok(validate(data)); assert.deepEqual(normalize(data), data); await save(root, data);
  const tool = TOOLS.find(item => item.name === 'trajectory_show');
  for (const output of [await show(root, 'atif'), JSON.parse(await tool.handler({ run: 'atif' }, { root }))]) {
    assert.match(output, /Result \/ Resultado: write: written/);
  }
});
// | Review 9 | Must pass | Must refuse |
// | bounds | nested truncation, bounded JSON, separate safe counters | depth > 100, unsafe summed counters |
test('review 9: save caps nested child messages and result content', async t => {
  const root = await rootOf(t);
  await writeFile(join(root, 'config.json'), JSON.stringify({ trajectory: { enabled: true, maxFileBytes: 1048576 } }));
  for (const placement of ['embedded', 'extra', 'ref', 'wide-child']) {
    const data = trajectory(context, [{ message: 'Root' }]);
    const child = trajectory({ ...context, session_id: 'child' }, [{ message: 'x'.repeat(1100000) }]);
    child.trajectory_id = 'child';
    if (placement === 'wide-child') {
      child.steps = Array.from({ length: 500 }, (_, index) => ({ step_id: index + 1, source: 'agent', message: 'small' }));
      data.subagent_trajectories = [child];
      await writeFile(join(root, 'config.json'), JSON.stringify({ trajectory: { enabled: true, maxFileBytes: 3000 } }));
    }
    else if (placement === 'embedded') data.subagent_trajectories = [child];
    else if (placement === 'extra') data.extra = { child: { extra: { child } } };
    else data.steps[0].observation = { results: [{ subagent_trajectory_ref: [{ trajectory_id: 'child', extra: { child } }] }] };
    assert.equal(await save(root, data), true);
    const raw = await readFile(join(root, 'trajectory', 'okit-plugin-atif.json'));
    assert.ok(raw.length <= (placement === 'wide-child' ? 3000 : 1048576)); assert.ok(validate(JSON.parse(raw)));
    assert.match(raw.toString(), /[Tt]runc|[Ss]horten|[Cc]ort|[Rr]eduz/);
  }
});
test('review 9: depth is refused and normalized without recursive cloning', async t => {
  const root = await rootOf(t), data = trajectory(context, [{ message: 'Root' }]);
  data.extra = {}; let child = data.extra;
  for (let i = 0; i < 3000; i++) { child.child = {}; child = child.child; }
  assert.equal(validate(data), false);
  const safe = normalize(data); assert.ok(validate(safe));
  assert.match(JSON.stringify(safe), /truncated: too deep/);
  assert.equal(await save(root, data), true);
  assert.match(await show(root, 'atif'), /Root/);
  const boundary = trajectory(context, [{ message: 'Boundary' }]); boundary.extra = {};
  let edge = boundary.extra;
  for (let i = 1; i < MAX_DEPTH; i++) { edge.child = {}; edge = edge.child; }
  assert.ok(validate(boundary)); assert.deepEqual(normalize(boundary), boundary);
  edge.child = {}; assert.equal(validate(boundary), false); assert.ok(validate(normalize(boundary)));
});
// | Harbor corpus | Must pass | Must refuse |
test('review 9: overflowing folds preserve both counters and omit unsafe totals', () => {
  for (const key of ['prompt_tokens', 'completion_tokens', 'cached_tokens', 'cost_usd']) {
    const large = key === 'cost_usd' ? Number.MAX_VALUE : Number.MAX_SAFE_INTEGER;
    const output = trajectory(context, [{ message: 'Agent', metrics: { [key]: large } },
      { source: 'system', message: 'Usage', metrics: { [key]: key === 'cost_usd' ? large : 1 } }]);
    assert.equal(output.steps.length, 2);
    assert.equal(output.steps[0].metrics[key], large);
    assert.equal(output.steps[1].metrics[key], key === 'cost_usd' ? large : 1);
    assert.equal(output.final_metrics[`total_${key}`], null);
    assert.ok(validate(output));
  }
});
// | models | all optional fields, nulls, empty collections, multimodal, recursive children | unknown fields, bad content/ref shapes, zero-call metrics |
const fixtureDir = new URL('./fixtures/atif-valid/', import.meta.url);
// | Review 8 | Must pass | Must refuse |
// | integers | safe integer boundaries; finite float fields | unsafe counters, step IDs, counts and token IDs |
// | raw identity skip | unsafe integer literals outside strings | strings, safe integers, fractional/exponent tokens |
test('review 8: unsafe integer fields repair before normalize/save', async t => {
  const root = await rootOf(t), base = trajectory(context, [{ message: 'Safe' }]);
  for (const value of [1e100, 2 ** 53, -(2 ** 53)]) {
    for (const mutate of [data => { data.final_metrics.total_steps = value; },
      data => { data.final_metrics.total_prompt_tokens = value; },
      data => { data.steps[0].step_id = value; }, data => { data.steps[0].llm_call_count = value; },
      ...['prompt_tokens', 'completion_tokens', 'cached_tokens', 'prompt_token_ids', 'completion_token_ids'].map(key =>
        data => { data.steps[0].metrics = { [key]: key.endsWith('_ids') ? [value] : value }; })]) {
      const input = structuredClone(base); mutate(input); assert.equal(validate(input), false);
      const output = normalize(input); assert.ok(validate(output)); await save(root, output);
      const raw = await readFile(join(root, 'trajectory', 'okit-plugin-atif.json'), 'utf8');
      assert.doesNotMatch(raw, /e\+/); assert.ok(validate(JSON.parse(raw)));
    }
  }
  const floats = structuredClone(base);
  Object.assign(floats.steps[0], { reasoning_effort: 1e100, metrics: { cost_usd: 1e100, logprobs: [1e100] } });
  assert.ok(validate(floats)); assert.deepEqual(normalize(floats), floats);
  const boundary = structuredClone(base);
  boundary.steps[0].metrics = { prompt_tokens: Number.MAX_SAFE_INTEGER, prompt_token_ids: [-Number.MAX_SAFE_INTEGER] };
  boundary.steps[0].llm_call_count = Number.MAX_SAFE_INTEGER;
  assert.ok(validate(boundary)); assert.deepEqual(normalize(boundary), boundary);
});
test('review 8: --diff counts raw unsafe integers and keeps rules a/b/c', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'atif-unsafe-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const base = trajectory(context, [{ message: 'Safe' }]), huge = `1${'0'.repeat(100)}`;
  const literals = [huge, `-${huge}`, '9007199254740992', '9007199254740991', '1e100', '1234567890123456.5'];
  const verdicts = {};
  for (const [index, literal] of literals.entries()) {
    const name = `m-${index}.json`, data = { ...base, final_metrics: { total_cost_usd: 0 } };
    await writeFile(join(dir, name), JSON.stringify(data).replace('"total_cost_usd":0', `"total_cost_usd":${literal}`));
    verdicts[name] = { valid: true, strict: true };
  }
  await writeFile(join(dir, 'm-string.json'), JSON.stringify({ ...base, notes: `escaped " ${huge} \\ ${huge}` }));
  verdicts['m-string.json'] = { valid: true, strict: true };
  await writeFile(join(dir, 'm-steps.json'), JSON.stringify({ ...base, final_metrics: { total_steps: 0 } })
    .replace('"total_steps":0', `"total_steps":${huge}`));
  verdicts['m-steps.json'] = { valid: true, strict: true };
  await writeFile(join(dir, 'verdicts.json'), JSON.stringify(verdicts));
  const result = await diff(dir); assert.equal(result.skipped, 4); assert.deepEqual(result.failures, []);
  verdicts['m-0.json'].valid = false;
  await writeFile(join(dir, 'verdicts.json'), JSON.stringify(verdicts));
  assert.ok((await diff(dir)).failures.some(item => item.file === 'm-0.json' && item.reason.startsWith('a:')));
});
// | Review 7 | Must pass | Must refuse |
// | strict scalars | JSON integers, finite numbers, booleans | numeric strings (including >4300 digits), bool words, bools as numbers |
test('review 7: repair lax scalars without accepting coercions', () => {
  const base = { schema_version: 'ATIF-v1.4', agent: { name: 'a', version: '1' },
    steps: [{ step_id: 1, source: 'agent', message: '' }] };
  for (const value of ['1_0', ' +1_0 ', '-1_0', '10.00', true, 10.0]) {
    const data = structuredClone(base); data.steps[0].metrics = { prompt_tokens: value };
    assert.equal(validate(data), typeof value === 'number', String(value)); assert.ok(validate(normalize(data)));
  }
  for (const value of ['1_0', '  +1.5e+3  ', '.5', 'inf', '-Infinity', 'nan', false]) {
    const data = structuredClone(base); data.steps[0].metrics = { cost_usd: value, logprobs: [value] };
    assert.equal(validate(data), false, String(value)); assert.ok(validate(normalize(data)));
  }
  for (const value of ['yes', 'ON', '0', 'off', 1, 0]) {
    const data = structuredClone(base); data.steps[0].is_copied_context = value;
    assert.equal(validate(data), false); assert.ok(validate(normalize(data)));
  }
  for (const value of ['_1', '1_', '1__0', '1e3', '1.5', '9'.repeat(4301)]) {
    const data = structuredClone(base); data.steps[0].metrics = { cached_tokens: value };
    assert.equal(validate(data), false); assert.ok(validate(normalize(data)));
  }
  for (const patch of [{ is_copied_context: ' yes ' }, { model_name: 1 }]) {
    assert.equal(validate({ ...base, steps: [{ ...base.steps[0], ...patch }] }), false);
  }
});
test('review 6 class 2: preserve optional fields and empty dispatch (m-r3-787 and maximal regressions)', async () => {
  const base = JSON.parse(await readFile(new URL('maximal-v1.7.json', fixtureDir)));
  const required = new Set(['schema_version', 'name', 'version', 'steps', 'agent', 'step_id', 'source', 'message',
    'results', 'tool_call_id', 'function_name', 'arguments', 'type', 'media_type', 'path']);
  function* objects(value, path = []) {
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value)) yield [value, path];
    for (const [key, child] of Object.entries(value)) yield* objects(child, [...path, key]);
  }
  for (const [obj, path] of objects(base)) for (const key of Object.keys(obj).filter(key => !required.has(key))) {
    for (const absent of [true, false]) {
      const data = structuredClone(base), target = path.reduce((v, k) => v[k], data);
      if (absent) delete target[key]; else target[key] = null;
      if (validate(data)) assert.deepEqual(normalize(data), data, `${path.join('.')}.${key}`);
    }
  }
  base.final_metrics.total_steps = Number.MAX_SAFE_INTEGER;
  assert.ok(validate(base)); assert.deepEqual(normalize(base), base);
  base.agent.unknown = true;
  const fixed = normalize(base);
  assert.equal(fixed.steps.length, 2); assert.deepEqual(fixed.steps[1], base.steps[1]);
  assert.equal(fixed.final_metrics.total_steps, base.final_metrics.total_steps);
  const moved = { agent: { name: 'a', version: '1' }, final_metrics: { total_steps: 100 }, steps: [
    { step_id: 1, source: 'agent', message: '', tool_calls: [{ tool_call_id: 't', function_name: 'f', arguments: {} }] },
    { step_id: 2, source: 'agent', message: '', observation: { results: [{ source_call_id: 't', content: 'ok' }] } }] };
  const repaired = normalize(moved);
  assert.equal(repaired.steps.length, 1); assert.equal(repaired.final_metrics.total_steps, 99);
});
test('review 6 class 4: reject huge token IDs (m-r3-1856,945; m-r1-533)', () => {
  for (const key of ['prompt_token_ids', 'completion_token_ids']) {
    const data = { agent: { name: 'a', version: '1' }, steps: [{ step_id: 1, source: 'agent', message: '',
      metrics: { [key]: ['1_0', '9'.repeat(4301)] } }] };
    assert.equal(validate(data), false); assert.ok(validate(normalize(data)));
    data.steps[0].metrics[key] = [10, 1e100];
    assert.equal(validate(data), false);
    assert.equal(normalize(data).steps[0].metrics?.[key], undefined);
  }
});
test('review 7: oversized totals and hostile scalar objects repair before saving', async t => {
  const root = await rootOf(t);
  for (const value of ['9'.repeat(4300), '9'.repeat(4301), '9'.repeat(4400), ' +1_000 ']) {
    const input = { ...trajectory(context), final_metrics: { total_steps: value }, steps: [] };
    assert.equal(validate(input), false);
    const output = normalize(input);
    assert.equal(output.final_metrics.total_steps, 1);
    assert.ok(validate(output)); await save(root, output);
  }
  const output = normalize({ session_id: context.session_id, steps: [{ step_id: { toString: 3, valueOf: 0 }, tool_calls: [{ function_name: { toString: 3 } }] },
    { source: 'system', metrics: { cost_usd: Number.MAX_VALUE } },
    { source: 'system', metrics: { cost_usd: Number.MAX_VALUE } }] });
  assert.ok(validate(output)); await save(root, output);
});
test('review 7: every saved-run exception regression repairs and saves', async t => {
  const root = await rootOf(t), source = new URL('./fixtures/atif-diff/', import.meta.url);
  assert.equal(await save(root, normalize(null)), false);
  for (const name of (await readdir(source)).filter(name => name.startsWith('m-s'))) {
    const output = normalize(JSON.parse(await readFile(new URL(name, source))));
    assert.ok(validate(output), name);
    await save(root, { ...output, session_id: context.session_id });
  }
});
test('review 6 class 3: destination-aware images (m-r1-1127,1870; m-r2-1092; m-r3-1043,469,848,910,966)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'atif-images-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'exists.png'), 'image');
  const paths = ['missing.png', 'x'.repeat(8192), join(dir, 'absent.png'), 'https://a/b', 's3://bucket/key',
    'text://', 'odd :// value', 'data:image/png;base64,a', 'exists.png', join(dir, 'exists.png'), ''];
  const parts = paths.map(path => ({ type: 'image', source: { media_type: 'image/png', path } }));
  const input = { schema_version: 'ATIF-v1.4', agent: { name: 'a', version: '1' },
    steps: [{ step_id: 1, source: 'agent', message: parts, observation: { results: [{ content: parts }] } }] };
  assert.deepEqual(normalize(input), input);
  const output = normalize(input, { dir });
  for (const content of [output.steps[0].message, output.steps[0].observation.results[0].content]) {
    for (const [index, path] of paths.entries()) {
      const missing = [0, 1, 2, 7].includes(index);
      assert.deepEqual(content[index], missing ? { type: 'text', text: `[image: ${path}]` } : parts[index]);
    }
  }
  const root = await rootOf(t); input.session_id = 'images';
  await save(root, input);
  const saved = await exportTrajectory(root, 'images');
  assert.deepEqual(saved.steps[0].message[0], { type: 'text', text: '[image: missing.png]' });
  assert.deepEqual(saved.steps[0].message[8], { type: 'text', text: '[image: exists.png]' });
  assert.deepEqual(saved.steps[0].message[9], parts[9]);
});
test('review 5 finding 1: schema_version is a literal string', () => {
  const data = trajectory(context, [{ message: 'Hello' }]);
  for (const schema_version of [['ATIF-v1.7'], {}, 7, null]) {
    const input = { ...data, schema_version };
    assert.equal(validate(input), false);
    assert.equal(normalize(input).schema_version, 'ATIF-v1.4');
  }
});
test('review 5 finding 2: Harbor replaces Z before parsing ISO timestamps', () => {
  const data = trajectory(context, [{ message: 'Hello' }]);
  for (const timestamp of ['2026-11-03Z10:00:00', '2026-W45-2Z10:00:00', '20261103Z100000']) {
    const input = structuredClone(data); input.steps[0].timestamp = timestamp;
    assert.equal(validate(input), false);
    const fixed = normalize(input);
    assert.equal(fixed.steps[0].timestamp, null);
    assert.equal(fixed.steps[0].extra.original_timestamp, timestamp);
  }
});
test('review 5 finding 3: show renders message and result content parts', async t => {
  const root = await rootOf(t), data = trajectory(context, [{ message: 'Hello' }]);
  data.schema_version = 'ATIF-v1.7';
  const parts = [{ type: 'text', text: 'Look here' },
    { type: 'image', source: { media_type: 'image/png', path: 'a.png' } }];
  data.steps[0].message = parts;
  data.steps[0].observation = { results: [{ content: parts }] };
  await save(root, data);
  const shown = await show(root, 'atif');
  assert.equal(shown.split('Look here\n[image: a.png]').length - 1, 2);
  assert.doesNotMatch(shown, /\[object Object\]/);
});
test('review 5 finding 4: show renders subagent path and session references', async t => {
  const root = await rootOf(t), data = trajectory(context, [{ message: 'Hello' }]);
  data.steps[0].observation = { results: [
    { subagent_trajectory_ref: [{ trajectory_path: 'child.json' }] },
    { subagent_trajectory_ref: [{ trajectory_id: 'child', session_id: 'child-session' }] }] };
  await save(root, data);
  const shown = await show(root, 'atif');
  assert.match(shown, /→ child.json/); assert.match(shown, /→ child-session/);
  assert.doesNotMatch(shown, /undefined/);
});
test('review 5 finding 5: usage skips deterministic dispatch steps', () => {
  const data = trajectory(context, [{ message: 'Dispatch', llm_call_count: 0 },
    { source: 'system', metrics: { prompt_tokens: 3 } }]);
  assert.ok(validate(data)); assert.equal(data.final_metrics.total_prompt_tokens, 3);
  assert.equal(data.steps[0].llm_call_count, 0); assert.equal(data.steps[0].metrics, undefined);
});
test('review 5 finding 6: optional usage lists ignore null and odd values', () => {
  for (const key of ['prompt_token_ids', 'completion_token_ids', 'logprobs']) {
    for (const value of [null, undefined, {}, 3, 'bad', [null]]) {
      const data = trajectory(context, [{ message: 'Answer' },
        { source: 'system', metrics: { [key]: value, prompt_tokens: 3 } }]);
      assert.ok(validate(data)); assert.equal(data.final_metrics.total_prompt_tokens, 3);
      assert.equal(data.steps[0].metrics[key], undefined);
    }
  }
});
test('differential repairs root, agent and recursive-list mutations without throwing', () => {
  const base = trajectory(context, [{ message: 'Hello' }]);
  const garbage = [null, [], {}, '', 'Z', -1, 1.5, true];
  for (const value of garbage) {
    const inputs = [value, { ...base, agent: value }, { ...base, steps: value },
      { ...base, session_id: value, trajectory_id: value, continued_trajectory_ref: value },
      { ...base, agent: { ...base.agent, tool_definitions: [value] } },
      { ...base, subagent_trajectories: [value, value] }];
    for (const input of inputs) {
      const output = normalize(input);
      assert.ok(validate(output), JSON.stringify(input));
      if (validate(input)) assert.deepEqual(output, input);
    }
  }
});
// Immutable verdicts recorded by the Director with real Harbor 0.22.0.
// | Corpus | Must pass | Must refuse |
// | differential | all eight literal versions | array versions, bad dates, scalar types, unknown fields, non-agent metrics, bad IDs |
test('seeded differential corpus checks both verdict directions and repairs every input', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'atif-diff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = new URL('./fixtures/atif-diff/', import.meta.url);
  for (const file of (await readdir(source)).filter(name => name.endsWith('.json'))) await writeFile(join(dir, file), await readFile(new URL(file, source)));
  const result = await diff(dir);
  assert.equal(result.files.length, 90); assert.deepEqual(result.failures, []);
  const verdicts = JSON.parse(await readFile(join(dir, 'verdicts.json')));
  verdicts['m-11.json'].valid = false; verdicts['m-8.json'].strict = true;
  await writeFile(join(dir, 'verdicts.json'), JSON.stringify(verdicts));
  const inverted = await diff(dir);
  assert.ok(inverted.failures.some(item => item.file === 'm-11.json' && /^a:.*disagrees/.test(item.reason)));
  assert.ok(inverted.failures.some(item => item.file === 'm-8.json' && /disagrees/.test(item.reason)));
  assert.ok(inverted.failures.some(item => item.file === 'm-8.json' && /changed/.test(item.reason)));
});
const findings = [
  ['metrics.extra request_id on an empty agent', { message: '', metrics: { prompt_tokens: 3, extra: { request_id: 'r' } } }],
  ['observation refs and extra', { observation: { results: [{ subagent_trajectory_ref: [{ trajectory_path: 'child.json' }], extra: { score: 1 } }] } }],
  ['tool-call extra timeout', { tool_calls: [{ tool_call_id: 't', function_name: 'read', arguments: {}, extra: { timeout: 30 } }] }],
  ['float reasoning_effort', { reasoning_effort: 0.5 }],
  ['multimodal result content', { observation: { results: [{ content: [{ type: 'image', source: { media_type: 'image/png', path: 'a.png' } }] }] } }],
  ['copied context and zero llm_call_count', { is_copied_context: true, llm_call_count: 0 }],
  ['token ids and logprobs', { metrics: { prompt_token_ids: [1, 2], completion_token_ids: [3], logprobs: [-0.5] } }],
];
for (const [index, [name, fields]] of findings.entries()) {
  test(`review 4 finding ${index + 1}: preserves ${name}`, async t => {
    const data = trajectory({ ...context, session_id: 'finding' }, [{ message: 'Hello' }]);
    if (index === 0) data.steps.push({ step_id: 2, source: 'agent', timestamp: null, message: '', ...fields });
    else Object.assign(data.steps[0], fields);
    data.final_metrics = totals(data.steps);
    assert.deepEqual(normalize(data), data); assert.ok(validate(data)); assert.ok(readable(data));
    const root = await rootOf(t); await save(root, data);
    assert.deepEqual(await exportTrajectory(root, 'finding'), normalize(data, { dir: join(root, 'trajectory') }));
  });
}
for (const name of await readdir(fixtureDir)) {
  test(`Harbor fixture ${name}: identity, validation, reading and save/reload`, async t => {
    const data = JSON.parse(await readFile(new URL(name, fixtureDir)));
    assert.ok(validate(data)); assert.ok(readable(data)); assert.deepEqual(normalize(data), data);
    if (!data.session_id) data.session_id = 'fixture'; // Storage requires a safe filename.
    const root = await rootOf(t); await save(root, data);
    const saved = JSON.parse(await readFile(join(root, 'trajectory', `okit-plugin-${data.session_id}.json`)));
    assert.deepEqual(saved, data); assert.deepEqual(normalize(saved), saved);
    assert.ok(validate(saved)); assert.ok(readable(saved));
    assert.deepEqual(await exportTrajectory(root, data.session_id), data);
    const tool = TOOLS.find(item => item.name === 'trajectory_show');
    assert.equal(typeof JSON.parse(await tool.handler({ run: data.session_id }, { root })), 'string');
  });
}
test('Harbor models: optional shapes across every accepted version and model validators', () => {
  const fixture = findings[4][1].observation.results[0].content;
  for (let version = 0; version <= 7; version++) {
    const data = { schema_version: `ATIF-v1.${version}`, agent: { name: '', version: '', tool_definitions: [] },
      steps: [{ step_id: 1, source: 'user', message: fixture, model_name: null,
        tool_calls: null, metrics: null, observation: { results: [{}] } }] };
    assert.ok(validate(data)); assert.ok(readable(data)); assert.deepEqual(normalize(data), data);
  }
  const base = trajectory(context, [{ message: 'x' }]);
  assert.equal(validate({ ...base, schema_version: null }), false);
  const coerced = { agent: { name: 'a', version: '1' }, steps: [{ step_id: '1', source: 'agent', message: '',
    is_copied_context: 'yes', llm_call_count: '1', metrics: { prompt_tokens: '-2', cost_usd: '0.5', prompt_token_ids: [true, '2'] } }] };
  assert.equal(validate(coerced), false); assert.ok(validate(normalize(coerced)));
  for (const timestamp of ['2026-11-03', '20261103', '2026-W45-2', '2026W452', '2026-11-03 10:00:00',
    '20261103T100000,1234567+00:60', '2026-11-03T10.5Z']) {
    const data = structuredClone(base); data.steps[0].timestamp = timestamp;
    assert.ok(validate(data), timestamp); assert.deepEqual(normalize(data), data);
  }
  for (const timestamp of ['2026-1103', '202611-03', '2026-11-03T10:0030', '2026-11-03T10+24:00', '2026-W54-1']) {
    const data = structuredClone(base); data.steps[0].timestamp = timestamp; assert.equal(validate(data), false, timestamp);
  }
  for (const fields of [{ llm_call_count: 0, metrics: {} }, { llm_call_count: 0, reasoning_content: '' },
    { is_copied_context: [] }, { observation: { results: [{ subagent_trajectory_ref: [{ session_id: 'alone' }] }] } },
    { message: [{ type: 'text', source: { media_type: 'image/png', path: 'x' } }] }]) {
    const data = structuredClone(base); Object.assign(data.steps[0], fields); assert.equal(validate(data), false);
  }
});
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
      const bad = structuredClone(data); bad.steps.at(-1)[key] = key === 'tool_calls' ? [] : key === 'metrics' ? {} : 'agent-only';
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
  for (const id of [null, 7]) {
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
  assert.equal(filled.final_metrics.total_cached_tokens, undefined);
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
    assert.equal(validate(bad), true, 'extra is arbitrary Harbor metadata');
  }
  for (const failed_results of [[-1], [2], [0.5], [null], 'bad']) {
    const bad = structuredClone(data); bad.steps[0].extra.failed_results = failed_results;
    assert.equal(validate(bad), true, 'extra is arbitrary Harbor metadata');
  }
  const malformed = structuredClone(data); malformed.steps[0].observation.results[0] = null;
  assert.equal(validate(malformed), false);
  assert.equal(readable({ ...data, steps: [null] }), false);
});
test('normalizer repairs odd step shapes and invalid envelopes before save', async t => {
  const base = trajectory(context);
  for (const steps of [null, {}, [null, 5, 'text', []], [{ source: 'odd', timestamp: 5, message: { text: 'json' },
    tool_calls: [null, { tool_call_id: 7, arguments: [] }], observation: { results: [null, { source_call_id: 7, content: 9 }] },
    extra: { failed_calls: [null, 7], failed_results: [99] } }], [{ tool_calls: 'odd', observation: { results: 'odd' } }]]) {
    const normalized = normalize({ ...base, steps });
    assert.ok(validate(normalized)); assert.deepEqual(normalize(normalized), normalized);
  }
  const root = await rootOf(t), bad = { ...base, agent: { ...base.agent, name: 7 } };
  assert.ok(validate(normalize(bad))); assert.equal(await save(root, bad), true);
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
test('reader and normalizer preserve v1.0 through v1.7, new trajectories use v1.4', () => {
  for (let version = 0; version <= 7; version++) {
    const data = trajectory(context, [{ message: 'Hello' }]); data.schema_version = `ATIF-v1.${version}`;
    assert.ok(readable(data)); assert.equal(normalize(data).schema_version, data.schema_version);
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
  for (const text of ['November 3, 2026', '2026-02-30T10:00:00Z', '2026-11-03T24:00:00Z']) {
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
  for (const [key, value] of [['prompt_tokens', 1.5], ['cached_tokens', []], ['completion_tokens', 'bad']]) {
    const bad = structuredClone(data); bad.steps[1].metrics[key] = value; assert.equal(validate(bad), false, key);
  }
  const bad = structuredClone(data); bad.final_metrics.total_prompt_tokens = 6.5; assert.equal(validate(bad), false);
  assert.equal(normalize(bad).final_metrics.total_prompt_tokens, 4);
});
test('finding 3: agent.version is always a string', () => {
  assert.equal(trajectory({ session_id: 'x' }).agent.version, 'unknown');
  const data = trajectory(context);
  for (const [version, expected] of [[null, 'unknown'], [undefined, 'unknown'], ['', ''], [{}, 'unknown'], [7, '7'], ['1.2', '1.2']]) {
    const fixed = normalize({ ...data, agent: { ...data.agent, version } }); assert.equal(fixed.agent.version, expected);
  }
  assert.equal(validate({ ...data, agent: { ...data.agent, version: null } }), false);
});
test('finding 4: unknown fields move into extra where Harbor has one, else disappear', () => {
  const base = trajectory(context, [{ message: 'Hi', tool_calls: [{ tool_call_id: 't', function_name: 'read', arguments: {}, custom: 1 }],
    metrics: { prompt_tokens: 1, custom: 2 }, observation: { custom: 4, results: [{ source_call_id: 't', content: 'ok', custom: 3 }] } }]);
  assert.deepEqual(base.steps[0].tool_calls[0].extra, { custom: 1 });
  assert.deepEqual(Object.keys(base.steps[0].observation), ['results']);
  assert.deepEqual(base.steps[0].observation.results[0].extra, { custom: 3 });
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
  assert.deepEqual(normalize(stale), stale, 'Harbor accepts independently recorded totals');
});
test('finding 6: repaired legacy steps update total_steps; Harbor-valid totals remain literal', async t => {
  const root = await rootOf(t); await mkdir(join(root, 'trajectory'));
  const legacy = trajectory({ ...context, session_id: 'old-two' });
  legacy.steps = [oldSteps[2], { ...oldSteps[0], step_id: 2 }]; legacy.final_metrics = totals(legacy.steps);
  assert.equal(legacy.final_metrics.total_steps, 2);
  await writeFile(join(root, 'trajectory', 'okit-plugin-old-two.json'), JSON.stringify(legacy));
  const exported = await exportTrajectory(root, 'old-two');
  assert.equal(exported.steps.length, 1); assert.equal(exported.final_metrics.total_steps, 1); assert.ok(validate(exported));
  const data = trajectory(context, [{ message: 'A' }, { message: 'B' }]);
  data.final_metrics.total_steps = 9; assert.deepEqual(normalize(data), data);
});
test('duplicate call IDs are renamed only within their step', () => {
  const data = trajectory(context, [{ tool_calls: [{ tool_call_id: 'same', function_name: 'read', arguments: {} }],
    observation: { results: [{ source_call_id: 'same', content: 'First' }] } },
  { tool_calls: [{ tool_call_id: 'same', function_name: 'read', arguments: {} }, { tool_call_id: 'same', function_name: 'read', arguments: {} }],
    extra: { failed_calls: ['same'] }, observation: { results: [{ source_call_id: 'same', content: 'Second' }] } }]);
  const ids = data.steps.flatMap(item => item.tool_calls).map(call => call.tool_call_id);
  assert.equal(new Set(ids).size, 2); assert.equal(data.steps[0].tool_calls[0].tool_call_id, 'same');
  assert.equal(data.steps[1].tool_calls[0].tool_call_id, 'same');
  assert.equal(data.steps[1].observation.results[0].source_call_id, data.steps[1].tool_calls[0].tool_call_id);
  assert.ok(validate(data)); assertLocalResults(data);
});
test('fuzz: the seeded odd trajectories all satisfy validate()', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'atif-fuzz-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const { files, failures } = await fuzz(dir, { n: 100, stressSizes: { length: 2000, depth: 120, width: 150,
    userLines: 200, readerLines: 200, timestampLength: 2000, pemMarkers: 200 } });
  assert.deepEqual(failures, []); assert.equal(files.length, 120);
  for (const file of files) assert.ok(validate(JSON.parse(await readFile(file, 'utf8'))), file);
  const users = JSON.parse(await readFile(files[104], 'utf8'));
  assert.equal(users.steps.length, 200); assert.ok(users.steps.every(item => item.source === 'user'));
  const repeated = JSON.parse(await readFile(files[105], 'utf8'));
  assert.deepEqual(repeated.steps.map(item => item.tool_calls[0].tool_call_id), ['same', 'same']);
  assert.deepEqual(repeated.steps[1].extra.failed_calls, ['same']);
  const proto = JSON.parse(await readFile(files[106], 'utf8')), item = proto.steps[0];
  for (const extra of [proto.extra, proto.agent.extra, item.extra, item.metrics.extra,
    item.tool_calls[0].arguments, item.tool_calls[0].extra, item.observation.results[0].extra]) {
    for (const key of Object.keys(prototypeKeys)) {
      assert.ok(Object.hasOwn(extra, key)); assert.equal(extra[key].payload, 'kept');
    }
  }
  for (const file of files.slice(107, 112)) {
    const data = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(data.steps.length, 200); assert.ok(validate(data));
  }
  const clocks = JSON.parse(await readFile(files[112], 'utf8'));
  assert.ok(clocks.steps.every(item => item.timestamp === null && item.extra.original_timestamp.length > 2000));
  const pem = JSON.parse(await readFile(files[113], 'utf8'));
  assert.equal(pem.steps[0].message, '-----BEGIN PRIVATE KEY-----\n'.repeat(200));
  for (const file of files.slice(114, 117)) {
    const data = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(data.final_metrics.total_steps, data.steps.length);
    assert.equal(data.final_metrics.total_prompt_tokens, 14);
  }
  for (const file of files.slice(117)) {
    const data = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(data.steps.length, 1); assert.equal(data.steps[0].message, '');
  }
  assert.equal(({}).payload, undefined);
});
