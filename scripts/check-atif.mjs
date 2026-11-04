import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { samples } from '../test/helpers/trajectory-samples.js';
import { capture } from '../src/trajectory/capture.js';
import { trajectory, normalize, validate } from '../src/trajectory/schema.js';
import { save, exportTrajectory } from '../src/trajectory/index.js';

// Seeded PRNG (mulberry32): the same seed always produces the same odd trajectories.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function generator(seed) {
  const rand = random(seed);
  const chance = p => rand() < p;
  const pick = list => list[Math.floor(rand() * list.length)];
  const many = (max, make) => Array.from({ length: Math.floor(rand() * (max + 1)) }, make);
  const stray = (p = 0.3) => chance(p) ? { custom: pick([1, 'x', { a: [1] }]) } : {};
  const stamps = ['2026-11-03T10:00:00.000Z', '2026-11-03T10:00:00+02:00', '2026-11-03T10:00:00.123456', 'November 3, 2026',
    '2026-11-03', '2026-13-45T00:00:00Z', '2026-02-30T10:00:00Z', '2026-11-03T24:00:00Z', '', ' ', 1762160000000, {}, [], true, null, undefined,
    '2026-11-04T12:00:00' + '+'.repeat(8000) + '\n!', '9'.repeat(8000) + '-11-04', '2026-11-04T12:00:00+\r!'];
  const counts = [0, 7, 12, 1000, 1.5, -3, '7', null, undefined, Infinity, 1e300, true, [], {}];
  const costs = [0, 0.01, 2.5, -0.5, '1', null, undefined, NaN, {}];
  const versions = [undefined, null, 7, 1.5, '', '1.2.3', {}, ['x'], true];
  const huge = 'lorem '.repeat(40000);
  const messages = ['', 'Hello', 'Olá, ação ✓ 日本語', null, undefined, 5, { text: 'json' }, ['a'], true,
    '-----BEGIN PRIVATE KEY-----\n'.repeat(500)];
  const ids = ['a', 'b', 'c', 'call-1', 'call-2-1', null, undefined, '', '  ', 7];
  const args = [{ path: 'a' }, '{"x":1}', 'plain', null, undefined, [], 7, '[]', {}];
  const contents = ['ok', '', null, undefined, 5, { output: 'oops', is_error: true }, { is_error: false }, ['a'], true,
    [{ type: 'image', source: { media_type: 'image/png', path: 'https://example.test/a.png' } }]];
  const extras = [undefined, { note: 'kept' }, { nested: { a: [1, 2] } }, null, 'text', [1], 5, { original_timestamp: 'kept' },
    { failed_calls: ['a'] }, { failed_calls: 'bad' }, { failed_results: [0] }, { failed_results: [99] }, { failed_calls: [null, 7, 'b'] }];
  const call = () => ({ ...(chance(0.9) ? { tool_call_id: pick(ids) } : {}), function_name: pick(['read', 'write', '', 7, null, undefined]),
    arguments: pick(args), ...(chance(0.4) ? { extra: { timeout: 30 } } : {}), ...stray() });
  const result = () => ({ source_call_id: pick(ids), content: pick(contents),
    ...(chance(0.4) ? { subagent_trajectory_ref: [{ trajectory_path: 'child.json' }], extra: { score: 1 } } : {}), ...stray() });
  const metrics = () => chance(0.15) ? pick([null, 'text', [], 5]) : { ...(chance(0.8) ? { prompt_tokens: pick(counts) } : {}),
    ...(chance(0.8) ? { completion_tokens: pick(counts) } : {}), ...(chance(0.6) ? { cached_tokens: pick(counts) } : {}),
    ...(chance(0.6) ? { cost_usd: pick([...costs, 0.5]) } : {}), ...(chance(0.2) ? { extra: pick([{ n: 1 }, 'bad', null]) } : {}),
    ...(chance(0.4) ? { prompt_token_ids: [1, 2], completion_token_ids: [3], logprobs: [-0.5] } : {}), ...stray() };
  const step = () => ({ ...(chance(0.8) ? { source: pick(['agent', 'agent', 'user', 'system', 'odd', null, 7]) } : {}),
    ...(chance(0.8) ? { timestamp: pick(stamps) } : {}), ...(chance(0.9) ? { message: chance(0.03) ? huge : pick(messages) } : {}),
    ...(chance(0.4) ? { tool_calls: chance(0.1) ? pick(['odd', {}, null]) : many(3, call) } : {}),
    ...(chance(0.4) ? { observation: pick([{ results: many(3, result), ...stray(0.2) }, null, 'odd', { results: 'odd' }, {}]) } : {}),
    ...(chance(0.5) ? { metrics: metrics() } : {}), ...(chance(0.2) ? { reasoning_content: pick(['', 'think', 5, null]) } : {}),
    ...(chance(0.3) ? { model_name: pick(['m', 7, null]) } : {}), ...(chance(0.2) ? { reasoning_effort: pick(['high', 0.5, null]) } : {}),
    ...(chance(0.3) ? { extra: pick(extras) } : {}), ...(chance(0.2) ? { step_id: pick([0, 9, 'x', null]) } : {}), ...stray() });
  const final = () => ({ total_steps: pick([0, 3, -1, 'x', null]), total_prompt_tokens: pick(counts),
    total_completion_tokens: pick(counts), total_cached_tokens: pick(counts), total_cost_usd: pick(costs),
    ...(chance(0.2) ? { extra: { n: 1 } } : {}), ...stray() });
  const agentExtra = () => ({ role: pick(['executor', 'critic']), client: pick([null, 'codex']), effort: pick([null, 'high']),
    demand: pick([null, 'D1']), step: pick([null, 3]), critic_of: null, ...stray() });
  const steps = () => many(8, () => chance(0.1) ? pick([null, 5, 'text', []]) : step());
  return { rand, pick, many, step, steps, versions,
    envelope: id => ({ schema_version: pick(['ATIF-v1.4', 'ATIF-v1.0', 'ATIF-v1.7', 'unknown', undefined]), session_id: id,
      agent: { name: 'okit-plugin', ...(chance(0.9) ? { version: pick(versions) } : {}),
        ...(chance(0.8) ? { model_name: pick([null, 'm', 7]) } : {}), extra: agentExtra(), ...stray(),
        ...(chance(0.2) ? { tool_definitions: [{ name: 'x' }] } : {}) },
      steps: chance(0.05) ? pick([null, {}, 'odd']) : steps(),
      ...(chance(0.3) ? { notes: pick(['n', 5, null]) } : {}), ...(chance(0.7) ? { final_metrics: final() } : {}),
      ...(chance(0.3) ? { extra: pick([{ n: 1 }, 'x', null]) } : {}), ...stray() }),
    legacy: id => {
      const steps = many(3, (_, index) => ({ step_id: index + 1, timestamp: pick([null, '2026-11-03T10:00:00.000Z', 'November 3, 2026']),
        source: pick(['user', 'system', 'agent']), message: pick(['Hi', '', null]), model_name: pick([null, 'm']),
        tool_calls: pick([[], [{ tool_call_id: pick(['call-1', 'call-1', null]), function_name: 'read', arguments: pick([null, '{"a":1}', 'plain', { a: 1 }]) }]]),
        ...(chance(0.5) ? { observation: { results: [{ source_call_id: pick(['call-1', 'zzz', null]), content: pick(['ok', { output: 'bad', is_error: true }]) }] } } : {}),
        metrics: { prompt_tokens: pick([null, 10, 1.5]), completion_tokens: pick([null, 4]), cached_tokens: null, cost_usd: pick([null, 0.5]) } }));
      if (!steps.length) steps.push({ step_id: 1, timestamp: null, source: 'agent', message: 'Hi', tool_calls: [],
        metrics: { prompt_tokens: null, completion_tokens: null, cached_tokens: null, cost_usd: null } });
      return { schema_version: `ATIF-v1.${Math.floor(rand() * 8)}`, session_id: id,
        agent: { name: 'okit-plugin', version: pick([null, '0.1.0']), model_name: pick([null, 'm']), extra: agentExtra() }, steps,
        final_metrics: { total_steps: steps.length, total_prompt_tokens: pick([null, 30, 12.5]), total_completion_tokens: null,
          total_cached_tokens: null, total_cost_usd: pick([null, 0.5]), ...stray() }, ...stray() };
    } };
}

const kinds = ['steps', 'raw', 'capped', 'legacy', 'capture', 'valid'];
const counters = ['prompt_tokens', 'completion_tokens', 'cached_tokens', 'cost_usd'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// The only lossy usage repairs: null/invalid counters and invalid token arrays.
const usable = (key, value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
  && (key === 'cost_usd' ? value <= Number.MAX_SAFE_INTEGER : Number.isSafeInteger(value));
export function conservation(input, output) {
  const failures = [], before = Array.isArray(input?.steps) ? input.steps : [], after = output.steps;
  const identity = validate(input);
  for (const key of counters) {
    const sum = steps => steps.reduce((n, step) => usable(key, step?.metrics?.[key])
      ? n + (key === 'cost_usd' ? step.metrics[key] : BigInt(step.metrics[key])) : n, key === 'cost_usd' ? 0 : 0n);
    const a = sum(before), b = sum(after);
    const equal = (x, y) => key === 'cost_usd' ? Math.abs(x - y) <= Number.EPSILON * Math.max(1, Math.abs(x), Math.abs(y)) * (before.length + 1) : x === y;
    if (!equal(a, b)) failures.push(`conservation: ${key} changed`);
    const total = output.final_metrics?.[`total_${key}`], stored = input?.final_metrics?.[`total_${key}`];
    // Strict identity includes independently recorded totals; stored totals can outlive capped steps.
    if (identity || usable(key, stored)) {
      if (total !== stored) failures.push(`conservation: stored total_${key} changed`);
    } else if (output.final_metrics) {
      const present = after.some(step => usable(key, step?.metrics?.[key]));
      const expected = !present || b > Number.MAX_SAFE_INTEGER ? null : Number(b);
      if (expected === null ? total !== null : typeof total !== 'number'
        || !equal(key === 'cost_usd' ? total : BigInt(total), b)) failures.push(`conservation: total_${key} differs from steps`);
    }
  }
  return [...failures, ...metadataConservation(before, after)];
}
function metadataConservation(before, after) {
  const fields = new Set(['step_id', 'timestamp', 'source', 'message', 'extra', 'metrics', 'observation',
    'model_name', 'reasoning_effort', 'reasoning_content', 'tool_calls', 'is_copied_context', 'llm_call_count']);
  const bags = new Map(), failures = [];
  const signature = (key, value) => JSON.stringify([key, value]);
  for (const step of after) {
    const id = JSON.stringify(step.message ?? ''), bag = bags.get(id) ?? new Set(); bags.set(id, bag);
    const pending = [step.extra, step.metrics];
    while (pending.length) {
      const value = pending.pop(); if (!record(value)) continue;
      for (const [key, child] of Object.entries(value)) {
        bag.add(signature(key, child)); if (record(child)) pending.push(child);
      }
    }
  }
  for (const step of before) {
    const message = step?.message ?? '';
    const bag = bags.get(JSON.stringify(message)) ?? bags.get(JSON.stringify(JSON.stringify(message))) ?? new Set();
    const entries = [...Object.entries(record(step?.extra) ? step.extra : {}),
      ...Object.entries(record(step?.metrics) ? step.metrics : {}).filter(([key]) => !counters.includes(key) && key !== 'extra'),
      ...Object.entries(record(step?.metrics?.extra) ? step.metrics.extra : {}),
      ...Object.entries(record(step) ? step : {}).filter(([key]) => !fields.has(key))];
    for (const [key, value] of entries) {
      if (value == null || ['failed_calls', 'failed_results'].includes(key)) continue; // Rebound reference bookkeeping.
      if (['prompt_token_ids', 'completion_token_ids', 'logprobs'].includes(key)
        && (!Array.isArray(value) || !value.every(n => typeof n === 'number' && Number.isFinite(n)
          && (key === 'logprobs' || Number.isSafeInteger(n))))) continue;
      if (!bag.has(signature(key, value))) failures.push(`conservation: metadata ${key} lost from ${step?.message ?? ''}`);
    }
  }
  return failures;
}
export function* conservationCases(n = 300, seed = 114) {
  const rand = random(seed), pick = values => values[Math.floor(rand() * values.length)];
  for (let index = 0; index < n; index++) {
    const steps = Array.from({ length: 4 + Math.floor(rand() * 8) }, (_, i) => ({
      step_id: i + 1, source: i % 3 === 0 ? 'agent' : pick(['system', 'user']), message: `case-${index}-${i}`,
      metrics: { prompt_tokens: pick([null, 2, 10, Number.MAX_SAFE_INTEGER, -1, '2']),
        completion_tokens: pick([null, 0, 4]), cached_tokens: pick([null, 1, 3]), cost_usd: pick([null, 0.25, 0.5]),
        extra: { receipt: `receipt-${i}` }, vendor: { index: i },
        ...(i % 2 ? { prompt_token_ids: [i], logprobs: [-0.5] } : {}) },
      extra: { receipt: `step-${i}`, ...(index % 3 === 0 ? { vendor: `original-${i}` } : {}) }, vendor: `unknown-${i}`,
      ...(i % 3 === 0 ? { tool_calls: [{ tool_call_id: `call-${i}`, function_name: 'read', arguments: '{}' }] } : {}),
      ...(i % 2 ? { observation: { results: [{ content: 'ok', ...(i % 4 === 1 ? { source_call_id: `call-${i - 1}` } : {}) }] } } : {}),
    }));
    if (index % 2) steps.push({ source: 'system', message: '', metrics: { prompt_tokens: 2 } });
    yield { agent: { name: 'legacy', version: null }, steps };
  }
}
export function stress(seed = 114, { length = 1200000, depth = 3000, width = 50000, userLines = 20000, readerLines = 24000,
  timestampLength = 64000, pemMarkers = 16000 } = {}) {
  const rand = random(seed), base = () => ({ agent: { name: 'stress', version: '1' }, steps: [{ source: 'agent', message: 'Root' }] });
  const long = base(), deep = base(), wide = base(), counts = base();
  long.extra = { child: { ...base(), steps: [{ source: 'agent', message: 'x'.repeat(Math.floor(length * (0.92 + rand() * 0.08))) }] } };
  long.steps[0].observation = { results: [{ content: 'y'.repeat(length) }] };
  deep.extra = {}; let child = deep.extra;
  for (let i = 0; i < depth; i++) { child.child = {}; child = child.child; }
  wide.steps = Array.from({ length: width }, () => ({ source: 'agent', message: 'small' }));
  counts.steps = [Number.MAX_SAFE_INTEGER - 1, 1, 1, Number.MAX_SAFE_INTEGER + 1].map((n, i) => ({
    source: i ? 'system' : 'agent', message: 'Usage', metrics: { prompt_tokens: n } }));
  const users = base(), repeated = base();
  users.steps = Array.from({ length: userLines }, () => ({ source: 'user', message: 'u' }));
  repeated.steps = ['read', 'write'].map((name, i) => ({ step_id: i + 1, source: 'agent', message: '',
    tool_calls: [{ tool_call_id: 'same', function_name: name, arguments: {} }],
    observation: { results: [{ source_call_id: 'same', content: name }] },
    ...(i ? { extra: { failed_calls: ['same'] } } : {}) }));
  const keys = '"__proto__":{"payload":"kept"},"constructor":{"payload":"kept"},"prototype":{"payload":"kept"},"toString":{"payload":"kept"},"hasOwnProperty":{"payload":"kept"}';
  const proto = JSON.parse(`{${keys},"extra":{${keys}},"agent":{"name":"stress","version":"1",${keys}},
    "steps":[{"source":"agent","message":"",${keys},"metrics":{"prompt_tokens":1,${keys}},
    "tool_calls":[{"tool_call_id":"same","function_name":"read","arguments":{${keys}},${keys}}],
    "observation":{"results":[{"source_call_id":"same","content":"ok",${keys}}]}}]}`);
  const lines = [
    ['claude-code', '{"type":"result","result":"done"}'],
    ['claude-code', '{"type":"user","message":{"content":"u"}}'],
    ['claude-code', '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"same","name":"read","input":{}}]}}\n{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"same","content":"ok"}]}}'],
    ['codex', '{"type":"function_call","call_id":"same","name":"read","arguments":"{}"}\n{"type":"function_call_output","call_id":"same","output":"ok"}'],
    ['opencode', '{"info":{"role":"assistant"},"parts":[{"type":"tool","callID":"same","tool":"read","state":{"input":{},"status":"completed","output":"ok"}}]}'],
  ].map(([client, line]) => ({ client, transcript: Array(readerLines).fill(line).join('\n') }));
  const timestamps = ['\n', '\r', '\u2028'].map(end => '2026-11-04T12:00:00' + '+'.repeat(timestampLength) + end + '!');
  timestamps.push('9'.repeat(timestampLength) + '-11-04T12:00:00');
  const hostile = { ...base(), steps: timestamps.map(timestamp => ({ source: 'agent', message: 'Clock', timestamp })) };
  const pem = { ...base(), steps: [{ source: 'agent', message: '-----BEGIN PRIVATE KEY-----\n'.repeat(pemMarkers) }] };
  const captures = samples.map(([client, , transcript]) => ({ client, transcript, message: 'Start', outcome: 'Done',
    usage: { prompt_tokens: 2, completion_tokens: 1, cached_tokens: 1, cost_usd: 0.25 } }));
  return [long, deep, counts, wide, users, repeated, proto, ...lines, hostile, pem, ...captures];
}
// (a) soundness, (b) totality, (c) valid output, (d) strict identity.
// Match whole JSON strings/numbers so digits inside strings, fractions and exponents do not count.
function unsafeIntegerLiteral(raw) {
  const tokens = raw.match(/"(?:[^"\\]|\\[\s\S])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) ?? [];
  return tokens.some(token => /^-?\d{16,}$/.test(token) && !Number.isSafeInteger(Number(token)));
}
export async function diff(dir) {
  const verdicts = JSON.parse(await readFile(join(dir, 'verdicts.json'), 'utf8')), failures = [];
  let skipped = 0;
  const files = (await readdir(dir)).filter(name => /^m-.*\.json$/.test(name)).sort();
  await mkdir(join(dir, 'out'), { recursive: true });
  for (const name of files) {
    const fail = reason => failures.push({ file: name, reason });
    try {
      const raw = await readFile(join(dir, name), 'utf8');
      const input = JSON.parse(raw), oracle = verdicts[name], skipIdentity = unsafeIntegerLiteral(raw);
      if (skipIdentity) skipped++;
      if (typeof oracle?.valid !== 'boolean' || typeof oracle?.strict !== 'boolean') fail('a/d: missing Harbor verdict');
      else {
        try {
          if (validate(input) && !oracle.valid) fail(`a: validate disagrees with Harbor: ${oracle.error ?? ''}`);
          if (!skipIdentity && oracle.strict && !validate(input)) fail('d: validate disagrees with strict Harbor');
        } catch (error) { fail(`a: validate threw: ${error.message}`); }
      }
      const pure = normalize(input), output = normalize(input, { dir: join(dir, 'out') });
      for (const reason of conservation(input, pure)) fail(reason);
      await writeFile(join(dir, 'out', name), `${JSON.stringify(output, null, 2)}\n`);
      if (!validate(pure) || !validate(output)) fail('c: normalize output is invalid');
      if (!skipIdentity && oracle?.strict && !isDeepStrictEqual(input, pure)) fail('d: normalize changed strict Harbor input');
    } catch (error) { fail(`b: exception: ${error.message}`); }
  }
  if (!files.length) failures.push({ file: dir, reason: 'b: no m-*.json files' });
  return { files, failures, skipped };
}
// Pushes N odd trajectories through trajectory → normalize → save (old files through exportTrajectory) and writes them to `dir`.
export async function fuzz(dir, { n = 200, seed = 114, stressSizes } = {}) {
  const out = resolve(dir), root = await mkdtemp(join(tmpdir(), 'fuzz-atif-')), staging = join(root, 'legacy');
  const random = generator(seed), files = [], failures = [];
  const maximal = JSON.parse(await readFile(new URL('../test/fixtures/atif-valid/maximal-v1.7.json', import.meta.url)));
  await mkdir(out, { recursive: true }); await mkdir(staging);
  const configure = (extra = {}) => writeFile(join(root, 'config.json'),
    JSON.stringify({ trajectory: { enabled: true, dir: out, maxBytes: 1000000000, ...extra } }));
  try {
    for (const [index, input] of [...conservationCases(n, seed)].entries()) {
      try {
        const output = normalize(input), problems = conservation(input, output);
        if (problems.length) throw new Error(problems.join('; '));
        await writeFile(join(out, `conservation-${seed}-${index}.json`), JSON.stringify(output));
      } catch (error) { failures.push({ index, kind: 'conservation', error: error.message }); }
    }
    for (let index = 0; index < n; index++) {
      const kind = kinds[index % kinds.length], id = `fuzz-${seed}-${index}`, file = join(out, `okit-plugin-${id}.json`);
      try {
        await configure();
        if (kind === 'valid') {
          const input = { ...structuredClone(maximal), session_id: id, schema_version: `ATIF-v1.${Math.floor(index / kinds.length) % 8}` };
          if (!validate(input) || !isDeepStrictEqual(normalize(input), input)) throw new Error('valid input was changed');
          await save(root, input);
          if (!isDeepStrictEqual(JSON.parse(await readFile(file, 'utf8')), input)) throw new Error('save changed valid input');
        } else if (kind === 'steps') {
          await save(root, trajectory({ session_id: id, version: random.pick(random.versions), model: random.pick([undefined, 'm', 7]),
            client: 'codex', effort: 'high', role: random.pick(['executor', 'critic']) }, random.many(8, () => random.step())));
        } else if (kind === 'raw') {
          const input = random.envelope(id), normalized = normalize(input);
          if (validate(input) && !isDeepStrictEqual(normalized, input)) throw new Error('valid raw input was changed');
          await save(root, normalized);
        } else if (kind === 'capped') {
          const data = normalize({ ...random.envelope(id), steps: [{ message: 'filler '.repeat(500), metrics: { prompt_tokens: 5 } }, ...random.steps()] });
          data.final_metrics.total_prompt_tokens = 30;
          for (const item of data.steps) delete item.metrics;
          await configure({ maxFileBytes: 3000 });
          await save(root, data);
          await save(root, JSON.parse(await readFile(file, 'utf8')));
        } else if (kind === 'legacy') {
          await configure({ dir: staging });
          const input = random.legacy(id);
          await writeFile(join(staging, `okit-plugin-${id}.json`), JSON.stringify(input));
          const exported = await exportTrajectory(root, id);
          if (validate(input) && !isDeepStrictEqual(exported, input)) throw new Error('export changed valid legacy input');
          await writeFile(file, `${JSON.stringify(exported, null, 2)}\n`);
        } else {
          const [client, , transcript] = random.pick(samples);
          const ok = await capture(root, { session_id: id, client, model: 'example-model', effort: 'high' }, { transcript,
            message: random.pick(['Read sample.txt', '', null]), outcome: random.pick(['Done', '', null]),
            usage: random.pick([{ cost_usd: 0.01 }, { prompt_tokens: 1.5, cost_usd: -1 }, { prompt_tokens: 2 }, null, 'odd']) });
          if (!ok) throw new Error('capture returned false');
        }
        const data = JSON.parse(await readFile(file, 'utf8'));
        if (!validate(data)) throw new Error('validate() rejects the saved file');
        files.push(file);
      } catch (error) { failures.push({ index, kind, id, error: error.message }); }
    }
    for (const [index, input] of stress(seed, stressSizes).entries()) {
      const id = `stress-${seed}-${index}`, file = join(out, `okit-plugin-${id}.json`);
      try {
        await configure({ maxFileBytes: 1048576 });
        const saved = Object.hasOwn(input, 'transcript')
          ? await capture(root, { session_id: id, client: input.client }, input)
          : index === 4
          ? await capture(root, { session_id: id, client: 'codex' }, { transcript: input.steps
            .map(item => JSON.stringify({ type: 'message', role: item.source, text: item.message })).join('\n') })
          : await save(root, { ...input, session_id: id });
        if (!saved) throw new Error('stress save/capture returned false');
        const raw = await readFile(file);
        if (raw.length > 1048576 || !validate(JSON.parse(raw))) throw new Error('invalid stress output or exceeded cap');
        const data = JSON.parse(raw);
        if (input.usage && (data.final_metrics.total_steps !== data.steps.length
          || data.final_metrics.total_prompt_tokens !== 14)) throw new Error('capture totals differ from steps/usage');
        files.push(file);
      } catch (error) { failures.push({ index, kind: 'stress', id, error: error.message }); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
  return { files, failures };
}

async function samplesTo(dir) {
  await mkdir(dir, { recursive: true });
  const root = await mkdtemp(join(tmpdir(), 'check-atif-'));
  try {
    await writeFile(join(root, 'config.json'), JSON.stringify({ trajectory: { enabled: true, dir } }));
    for (const [client, , transcript] of samples) {
      const context = { session_id: client, client, model: 'example-model', effort: 'high' };
      if (!await capture(root, context, { transcript, message: 'Read sample.txt', outcome: 'Done',
        usage: { cost_usd: 0.01 } })) throw new Error(`Could not save ${client}`);
      console.log(join(dir, `okit-plugin-${client}.json`));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), flag = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const usage = 'Usage: node scripts/check-atif.mjs <folder> | --diff <folder> | --fuzz <folder> [--n 200] [--seed 114]';
  if (args.includes('--diff')) {
    if (!flag('--diff')) throw new Error(usage);
    const { files, failures, skipped } = await diff(resolve(flag('--diff')));
    for (const failure of failures) console.error(`${failure.file}: ${failure.reason}`);
    console.log(`${files.length} compared; ${failures.length} mismatches; ${skipped} skipped (integer beyond 2^53)`);
    process.exitCode = failures.length ? 1 : 0;
  } else if (args.includes('--fuzz')) {
    if (!flag('--fuzz')) throw new Error(usage);
    const { files, failures } = await fuzz(flag('--fuzz'), { n: Number(flag('--n') ?? 200), seed: Number(flag('--seed') ?? 114) });
    for (const file of files) console.log(file);
    for (const failure of failures) console.error(`FAILED ${failure.kind} #${failure.index} (${failure.id}): ${failure.error}`);
    process.exitCode = failures.length ? 1 : 0;
  } else {
    if (!args[0]) throw new Error(usage);
    await samplesTo(resolve(args[0]));
  }
}
