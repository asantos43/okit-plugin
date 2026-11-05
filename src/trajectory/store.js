import { mkdir, readdir, rename, stat, rm, open } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJsonAtomic, withLock } from '../state.js';
import { settings } from './config.js';
import { redact } from './redact.js';
import { boundedClone, normalize, readable, validate, totals, ownData } from './schema.js';

const prefix = 'okit-plugin-';
const bytes = value => Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`);
// Pretty JSON size without allocating a serialized step; cache until it changes.
function stepBytes(value) {
  let size = 1;
  const pending = [[value, 0]];
  while (pending.length) {
    const [item, depth] = pending.pop();
    if (item === null || typeof item !== 'object') {
      size += Buffer.byteLength(JSON.stringify(item)); continue;
    }
    const array = Array.isArray(item); let count = 0;
    size += 2;
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      if (item[key] === undefined) {
        if (array) { count++; size += 2 * (depth + 1) + 4; }
        continue;
      }
      count++; size += 2 * (depth + 1);
      if (!array) size += Buffer.byteLength(JSON.stringify(key)) + 2;
      pending.push([item[key], depth + 1]);
    }
    if (count) size += 2 * count + 2 * depth;
  }
  return size;
}
export const safeId = id => typeof id === 'string' && id.length <= 255
  && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes('..');
export async function files(config, { backups = false } = {}) {
  try { return (await readdir(config.dir)).filter(name => name.startsWith(prefix)
    && (name.endsWith('.json') || backups && /\.json\.corrupt-\d+(?:-\d+)?$/.test(name))); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
export async function pruneFiles(config, now = Date.now()) {
  const entries = await Promise.all((await files(config, { backups: true })).map(async name => ({ name, ...await stat(join(config.dir, name)) })));
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  let size = 0, removed = 0, kept = 0;
  for (const entry of entries) {
    if (entry.mtimeMs < now - config.retentionDays * 86400000 || size + entry.size > config.maxBytes
      || entry.name.includes('.json.corrupt-') && entry.size > config.maxFileBytes
      || kept >= (config.maxFiles ?? Infinity)) {
      await rm(join(config.dir, entry.name), { force: true }); removed++;
    } else { size += entry.size; kept++; }
  }
  return { removed };
}
export function capped(data, config) {
  const limit = Math.min(config.maxFileBytes, config.maxBytes);
  let size = bytes(data);
  if (size <= limit) return data;
  rememberClocks(data); // Retain observed clocks only when a cap can remove steps.
  size = bytes(data);
  // Approximate deltas can miss indentation. Bound full-file confirmations per phase.
  let confirmations = 3;
  const fits = () => {
    if (size > limit || confirmations === 0) return false;
    confirmations--;
    size = bytes(data);
    return size <= limit;
  };
  data.final_metrics ??= totals(data.steps);
  const marker = config.truncationMarker;
  const rootSteps = new Set(data.steps);
  let stepSizes = new WeakMap();
  const measured = item => {
    if (!stepSizes.has(item)) stepSizes.set(item, stepBytes(item));
    return stepSizes.get(item);
  };
  // Include embedded children and free-form payloads, without recursive walking.
  const pending = [{ value: data, free: false }], payloads = [], runs = [];
  while (pending.length) {
    const { value, free } = pending.pop();
    if (Array.isArray(value.steps) && validate(value)) runs.push(value);
    for (const [key, child] of Object.entries(value)) {
      const payload = free || ['extra', 'arguments', 'tool_definitions'].includes(key);
      if (child && typeof child === 'object') {
        pending.push({ value: child, free: payload });
        if (['extra', 'arguments', 'tool_definitions'].includes(key)) payloads.push([value, key]);
      } else if (typeof child === 'string' && !(key === 'message' && rootSteps.has(value))
        && (payload || ['message', 'content', 'text', 'reasoning_content', 'notes'].includes(key))) {
        const saved = bytes(child) - bytes(marker);
        if (saved <= 0) continue;
        ownData(value, key, marker); size -= saved;
        if (fits()) return data;
      }
    }
  }
  size = bytes(data);
  if (size <= limit) return data;
  confirmations = 3;
  for (const run of runs.reverse()) {
    run.final_metrics ??= totals(run.steps);
    for (let index = run.steps.length - 1; index >= 0; index--) {
      const item = run.steps[index], before = measured(item);
      item.source = 'system';
      item.message = marker;
      delete item.model_name;
      delete item.reasoning_effort;
      delete item.metrics;
      delete item.reasoning_content;
      delete item.tool_calls;
      delete item.observation;
      if (item.extra) {
        delete item.extra.failed_calls;
        delete item.extra.failed_results;
        let empty = true;
        for (const key in item.extra) if (Object.hasOwn(item.extra, key)) { empty = false; break; }
        if (empty) delete item.extra;
      }
      stepSizes.set(item, stepBytes(item));
      size -= before - measured(item);
      if (fits()) return data;
    }
  }
  size = bytes(data);
  if (size <= limit) return data;
  confirmations = 3;
  for (const [parent, key] of payloads.reverse()) {
    const replacement = key === 'tool_definitions' ? [] : { truncated: marker };
    // Merge clocks are bookkeeping, not free-form payload: never erase proof
    // of a disjoint range, or turn an unknown start into a known one after cap.
    if (key === 'extra') for (const field of ['trajectory_merge_clock', 'trajectory_merge_start']) {
      if (Object.hasOwn(parent[key], field)) ownData(replacement, field, parent[key][field]);
    }
    const saved = bytes(parent[key]) - bytes(replacement);
    if (saved <= 0) continue;
    ownData(parent, key, replacement); size -= saved;
    if (fits()) return data;
  }
  size = bytes(data);
  if (size <= limit) return data;
  // Each removed step is measured once; confirm the file once after all removals.
  // Standalone pretty sizes undercount indentation, so this estimate is conservative.
  stepSizes = new WeakMap(); // Payload replacements may have changed retained extras.
  for (const run of runs) {
    while (run.steps.length > 1 && size > limit) size -= measured(run.steps.pop());
    run.final_metrics.total_steps = run.steps.length;
  }
  if (!data.steps.length || bytes(data) > limit) {
    throw new Error('Recording limit is too small / Limite de gravação pequeno demais');
  }
  return data;
}
// The contract of the merge, in one place:
// - group by [source, timestamp]; reserve exact message/call-ID occurrences
//   before comparing prefixes or cut versions, then use group position;
//   different nonempty call IDs or incompatible messages remain separate;
// - the backbone: the longer sequence of steps wins; equal lengths use the
//   canonical JSON text of the steps, never the order of the saves;
// - ambiguity: without identity, keep both; this can retain duplicates.
//   Clockless replay with the same call ID and similar messages is not
//   guaranteed idempotent because the occurrence identity is ambiguous.
//   Distinct events without a common clock use canonical, not chronological, order.
// - the winner of a position: the whole step with more content (message,
//   reasoning, calls, results, usage, extra), then more bytes, then the
//   canonical text; a step with the cut marker loses to the same step whole;
//   a message that moved leaves no duplicate tail;
// - the numbers: step_id is assigned from 1 after the merge, so it is display
//   order only; intact captures have equal steps and totals in either order;
//   after lossy persistence only disjoint complete clock ranges prove additive
//   totals; overlapping/unknown ranges retain conservative usage lower bounds;
// - the metadata: the latest observed timestamp wins the scalar fields and
//   canonical JSON breaks ties per field, including every agent field; maps
//   union keys recursively and child runs merge by their trajectory ID.
//   The seeded property covers 120 real-save pairs with a 20-second ceiling.
// step_id is output numbering, never identity across captures.
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item) ?? '';
const defaultMarker = '[Content shortened / Conteúdo reduzido]';
function truncated(item, marker = defaultMarker) {
  const pending = [item];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string' && (value.includes(marker) || value.includes(defaultMarker)
      || value.includes('[truncated: too deep]'))) return true;
    if (value && typeof value === 'object') for (const child of Object.values(value)) pending.push(child);
  }
  return false;
}
const stepParts = item => {
  let count = 0;
  if (item?.message) count += 1;
  if (item?.reasoning_content) count += 1;
  count += item?.tool_calls?.length ?? 0;
  count += item?.observation?.results?.length ?? 0;
  for (const key of Object.keys(item?.metrics ?? {})) if (item.metrics[key] != null) count += 1;
  return count + Object.keys(item?.extra ?? {}).length;
};
const stepText = item => canonical({ ...item, step_id: undefined });
// The richer step wins its position: more content parts, then more bytes, then
// the canonical text, so the answer never depends on the order of the saves.
export function richer(left, right, marker = defaultMarker, cuts) {
  const cutLeft = cuts ? cuts.get(left) : truncated(left, marker);
  const cutRight = cuts ? cuts.get(right) : truncated(right, marker);
  if (cutLeft !== cutRight) return !cutLeft;
  const parts = stepParts(left) - stepParts(right);
  if (parts !== 0) return parts > 0;
  const size = Buffer.byteLength(stepText(left)) - Buffer.byteLength(stepText(right));
  if (size !== 0) return size > 0;
  return stepText(left) > stepText(right);
}
const identity = item => canonical([item.source, item.timestamp ?? null]);
const callIds = item => (item.tool_calls ?? []).map(call => call.tool_call_id);
const signature = item => canonical([item.message ?? '', callIds(item)]);
const prefixOf = (a, b) => a.length <= b.length && a.every((id, index) => id === b[index]);
function compatible(left, right, messageCuts) {
  if (left.timestamp != null && right.timestamp != null && left.timestamp !== right.timestamp) return false;
  const a = callIds(left), b = callIds(right);
  if (!prefixOf(a, b) && !prefixOf(b, a)) return false;
  // A shortened reasoning/result/payload does not erase the message identity.
  if (messageCuts.get(left) || messageCuts.get(right)) return true;
  if (left.source !== right.source) return false;
  if (a.length && b.length) return true; // Stable call IDs identify partial call versions.
  const x = left.message ?? '', y = right.message ?? '';
  return typeof x === 'string' && typeof y === 'string'
    ? x.startsWith(y) || y.startsWith(x) : canonical(x) === canonical(y);
}
// Keep the longer sequence as the backbone; ties use content, never save order.
// Match occurrences globally so reordered messages cannot leave a duplicate tail.
export function mergeSteps(existing = [], incoming = [], marker = defaultMarker) {
  let base = existing, other = incoming;
  if (base.length < other.length || base.length === other.length && canonical(base.map(stepText)) < canonical(other.map(stepText))) {
    [base, other] = [other, base];
  }
  const output = [...base], groups = new Map(), queues = new Map(), used = new Set(), unmatched = [];
  const cuts = new Map([...base, ...other].map(item => [item, truncated(item, marker)]));
  const messageCuts = new Map([...base, ...other].map(item => [item, truncated(item.message, marker)]));
  base.forEach((item, index) => {
    const group = identity(item), key = canonical([group, signature(item)]);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(index);
    if (!queues.has(key)) queues.set(key, { indices: [], next: 0 });
    queues.get(key).indices.push(index);
  });
  for (const item of other) {
    const queue = queues.get(canonical([identity(item), signature(item)])), index = queue?.indices[queue.next++];
    if (index === undefined) { unmatched.push(item); continue; }
    used.add(index);
    if (richer(item, output[index], marker, cuts)) output[index] = item;
  }
  return alignUnmatched(output, unmatched, groups, used, cuts, messageCuts, marker);
}
function alignUnmatched(output, unmatched, groups, used, cuts, messageCuts, marker) {
  // Exact matches are reserved first. Bound all remaining candidate visits,
  // including used slots: O(n+m) visits plus input payload processing.
  let budget = 8 * (output.length + unmatched.length);
  const pending = [];
  const match = (item, indices, cutOnly = false) => {
    for (const index of indices) {
      if (--budget < 0) return false;
      const kept = output[index];
      if (used.has(index) || cutOnly && !messageCuts.get(item) && !messageCuts.get(kept)) continue;
      // Charge prefix comparisons by their payload too, not just candidate count.
      const cut = messageCuts.get(item) || messageCuts.get(kept);
      budget -= (cut ? 0 : Math.min(item.message?.length ?? 1, kept.message?.length ?? 1))
        + (item.tool_calls?.length ?? 0) + (kept.tool_calls?.length ?? 0);
      if (budget < 0) return false;
      if (!compatible(item, kept, messageCuts)) continue;
      used.add(index);
      if (richer(item, kept, marker, cuts)) output[index] = item;
      return true;
    }
    return false;
  };
  for (const item of unmatched) if (!match(item, groups.get(identity(item)) ?? [])) pending.push(item);
  const free = output.map((_item, index) => index).filter(index => !used.has(index));
  // Old capped steps can have source=system; only cut versions cross groups.
  for (const item of pending) if (budget < 0 || !match(item, free, true)) output.push(item);
  return output.map((item, index) => ({ ...item, step_id: index + 1 }));
}
const totalKeys = ['total_prompt_tokens', 'total_completion_tokens', 'total_cached_tokens', 'total_cost_usd'];
// A null start means some clock was absent or a legacy cap erased its range.
// Only complete, strictly disjoint clock ranges prove that usage can be added.
function rangeStart(run) {
  if (Object.hasOwn(run?.extra ?? {}, 'trajectory_merge_start')) {
    return Number.isFinite(run.extra.trajectory_merge_start) ? run.extra.trajectory_merge_start : null;
  }
  if (run?.extra?.trajectory_merge_clock != null || !run?.steps?.length) return null;
  let start = Infinity;
  for (const item of run.steps) {
    const time = Date.parse(item.timestamp);
    if (!Number.isFinite(time)) return null;
    start = Math.min(start, time);
  }
  return start;
}
// The totals a file kept outlive the steps the file cap shortened, so the
// merged file never reports less than either file it came from.
function mergedTotals(steps, runs) {
  const computed = totals(steps), result = { total_steps: steps.length };
  const [a, b] = runs.map(rangeStart);
  const disjoint = a != null && b != null && (runTime(runs[0]) < b || runTime(runs[1]) < a);
  const stored = runs.map(run => run?.final_metrics);
  for (const key of totalKeys) {
    const values = [computed[key], ...stored.map(item => item?.[key])].filter(value => typeof value === 'number');
    if (disjoint && stored.every(item => typeof item?.[key] === 'number')) {
      const sum = stored[0][key] + stored[1][key];
      if (!Number.isFinite(sum) || key !== 'total_cost_usd' && !Number.isSafeInteger(sum)) { result[key] = null; continue; }
      values.push(sum);
    }
    result[key] = values.length ? Math.max(...values) : null;
  }
  return result;
}
// Scalar metadata follows observed clocks; ties are canonical per field,
// independently of changes to steps, totals or free-form payloads.
const runTime = run => (run?.steps ?? []).reduce((time, item) => Math.max(time, Date.parse(item.timestamp) || 0),
  Number.isFinite(run?.extra?.trajectory_merge_clock) ? run.extra.trajectory_merge_clock : 0);
function rememberClocks(run) {
  const pending = [run];
  while (pending.length) {
    const item = pending.pop(), time = runTime(item), start = rangeStart(item);
    if (time > 0) ownData(item.extra ??= {}, 'trajectory_merge_clock', time);
    ownData(item.extra ??= {}, 'trajectory_merge_start', start);
    pending.push(...(item.subagent_trajectories ?? []));
  }
}
function unionMap(left, right, preferRight = false) {
  const result = { ...left };
  for (const [key, value] of Object.entries(right ?? {})) {
    const old = Object.hasOwn(result, key) ? result[key] : undefined;
    ownData(result, key, old && value && typeof old === 'object' && typeof value === 'object'
      && !Array.isArray(old) && !Array.isArray(value) ? unionMap(old, value)
        : !preferRight && Object.hasOwn(result, key) && canonical(old) > canonical(value) ? old : value);
  }
  return result;
}
export function mergeRuns(existing, incoming, marker = defaultMarker) {
  if (runTime(existing) > runTime(incoming)) [existing, incoming] = [incoming, existing];
  const newer = runTime(existing) < runTime(incoming);
  const steps = mergeSteps(existing?.steps, incoming?.steps, marker);
  const merged = { ...unionMap(existing, incoming, newer), steps };
  merged.agent = unionMap(existing?.agent, incoming?.agent, newer);
  if (existing?.extra || incoming?.extra) merged.extra = unionMap(existing?.extra, incoming?.extra);
  if (existing?.extra?.trajectory_merge_clock != null || incoming?.extra?.trajectory_merge_clock != null) {
    ownData(merged.extra ??= {}, 'trajectory_merge_clock', Math.max(runTime(existing), runTime(incoming)));
  }
  if (Object.hasOwn(existing?.extra ?? {}, 'trajectory_merge_start')
    || Object.hasOwn(incoming?.extra ?? {}, 'trajectory_merge_start')) {
    const a = rangeStart(existing), b = rangeStart(incoming);
    ownData(merged.extra ??= {}, 'trajectory_merge_start', a == null || b == null ? null : Math.min(a, b));
  }
  const children = new Map();
  for (const child of [...(existing?.subagent_trajectories ?? []), ...(incoming?.subagent_trajectories ?? [])]) {
    if (child?.trajectory_id != null) children.set(child.trajectory_id, children.has(child.trajectory_id)
      ? mergeRuns(children.get(child.trajectory_id), child, marker) : child);
  }
  if (children.size) merged.subagent_trajectories = [...children.values()].sort((a, b) => a.trajectory_id.localeCompare(b.trajectory_id));
  else delete merged.subagent_trajectories;
  merged.final_metrics = { ...unionMap(existing?.final_metrics, incoming?.final_metrics),
    ...mergedTotals(steps, [existing, incoming]) };
  return merged;
}
const corruptSuffix = '.corrupt-';
// The refusal of a lock that did not free up, in plain words.
const busy = 'Recording is busy right now. Try again in a moment. / A gravação está ocupada agora. Tente de novo em instantes.';
const previousDefaults = { stat, readJson, rename, rm, open };
async function quarantine(file, now, io) {
  let backup, reserved = false;
  try {
    for (let suffix = 0; suffix < 1000; suffix++) {
      backup = `${file}${corruptSuffix}${now}${suffix ? `-${suffix}` : ''}`;
      try { const handle = await io.open(backup, 'wx'); reserved = true; await handle.close(); break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    if (!reserved) throw Object.assign(new Error('Cannot quarantine recording: 1000 backup name collisions / Não foi possível isolar a gravação: 1000 colisões'),
      { code: 'EQUARANTINEFULL' });
    await io.rename(file, backup);
  } catch (error) {
    if (error.code === 'EQUARANTINEFULL') throw error;
    // Do not silently overwrite a bad source if moving it failed.
    try {
      if (reserved) await rm(backup, { force: true });
      await io.rm(file, { force: true });
    }
    catch { throw new Error('Cannot replace recording. Try again. / Não foi possível substituir a gravação. Tente de novo.'); }
  }
}
// The contract of the file that is already there:
// - the size of the file is checked against the per-file and the total byte
//   limits before it is read or parsed;
// - an oversized, unreadable or invalid file moves to a unique
//   `<file>.corrupt-<timestamp>` backup, and a counter keeps the name unique;
// - a backup shares the retention of the recordings: the oldest go first, and
//   the age, the total bytes, the per-file bytes and the file count budget
//   apply to both;
// - a backup never shows up in the list of sessions;
// - when the move fails, the bad file is removed or the save refuses in plain
//   words; it is never overwritten silently.
// Stat before reading or parsing, under the same lock as the replacement.
async function readPrevious(file, now, config, injected) {
  const io = { ...previousDefaults, ...injected };
  try {
    if ((await io.stat(file)).size > Math.min(config.maxFileBytes, config.maxBytes)) {
      await quarantine(file, now, io); return null;
    }
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const missing = Symbol('missing');
  let parsed = missing;
  try { parsed = await io.readJson(file, missing); }
  catch { parsed = null; } // a file that is not JSON cannot be merged
  if (parsed === missing) return null;
  if (parsed && readable(parsed)) return parsed;
  await quarantine(file, now, io);
  return null;
}
export async function save(root, data, { lockTimeoutMs = 5000, now = Date.now(), previousIO } = {}) {
  const config = await settings(root);
  if (config.enabled !== true) return false;
  if (!safeId(data?.session_id)) return false;
  const prepared = normalize(redact(boundedClone(data), config), { dir: config.dir });
  if (!validate(prepared)) throw new Error('Invalid saved run / Execução salva inválida');
  await mkdir(config.dir, { recursive: true });
  const file = join(config.dir, `${prefix}${data.session_id}.json`);
  try {
    await withLock(join(config.dir, 'okit-plugin-retention'), async () => {
      const previous = await readPrevious(file, now, config, previousIO);
      const merged = previous ? mergeRuns(previous, prepared, config.truncationMarker) : prepared;
      const safe = capped(previous ? normalize(merged, { dir: config.dir }) : merged, config);
      if (!validate(safe)) throw new Error('Invalid saved run / Execução salva inválida');
      await writeJsonAtomic(file, safe);
      await pruneFiles(config);
    }, { timeoutMs: lockTimeoutMs });
  } catch (error) {
    // The lock waits a bounded time; when that wait runs out the caller is
    // told in plain words instead of waiting for ever.
    if (/is held by .* after \d+ ms/.test(error?.message ?? '')) throw new Error(busy);
    throw error;
  }
  return true;
}
