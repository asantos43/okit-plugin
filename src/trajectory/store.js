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
export function richer(left, right, marker = defaultMarker) {
  const cutLeft = truncated(left, marker), cutRight = truncated(right, marker);
  if (cutLeft !== cutRight) return !cutLeft;
  const parts = stepParts(left) - stepParts(right);
  if (parts !== 0) return parts > 0;
  const size = Buffer.byteLength(stepText(left)) - Buffer.byteLength(stepText(right));
  if (size !== 0) return size > 0;
  return stepText(left) > stepText(right);
}
const identity = item => item.timestamp != null ? canonical([item.source, item.timestamp])
  : canonical([item.source, item.message, item.message ? null : item.tool_calls?.map(call => call.tool_call_id)]);
// Keep the longer sequence as the backbone; ties use content, never save order.
// Match occurrences globally so reordered messages cannot leave a duplicate tail.
export function mergeSteps(existing = [], incoming = [], marker = defaultMarker) {
  let base = existing, other = incoming;
  if (base.length < other.length || base.length === other.length && canonical(base.map(stepText)) < canonical(other.map(stepText))) {
    [base, other] = [other, base];
  }
  const output = base.map(item => ({ ...item })), queues = new Map(), used = new Set(), unmatched = [];
  base.forEach((item, index) => {
    const key = identity(item);
    if (!queues.has(key)) queues.set(key, { indices: [], next: 0 });
    queues.get(key).indices.push(index);
  });
  for (const item of other) {
    const queue = queues.get(identity(item)), index = queue?.indices[queue.next++];
    if (index === undefined) { unmatched.push(item); continue; }
    used.add(index);
    if (richer(item, output[index], marker)) output[index] = { ...item };
  }
  return alignUnmatched(output, unmatched, used, marker);
}
function alignUnmatched(output, unmatched, used, marker) {
  const free = output.map((_item, index) => index).filter(index => !used.has(index));
  let next = 0;
  for (const item of unmatched) {
    const index = free[next], kept = output[index];
    // Distinct timestamps are distinct events. Without that evidence, align
    // remaining occurrences in sequence; a rewritten transcript replaces slots.
    if (kept === undefined || kept.timestamp != null && item.timestamp != null
      && !truncated(kept, marker) && !truncated(item, marker)) {
      output.push({ ...item }); continue;
    }
    next++;
    if (richer(item, kept, marker)) output[index] = { ...item };
  }
  return output.map((item, index) => ({ ...item, step_id: index + 1 }));
}
const totalKeys = ['total_prompt_tokens', 'total_completion_tokens', 'total_cached_tokens', 'total_cost_usd'];
// The totals a file kept outlive the steps the file cap shortened, so the
// merged file never reports less than either file it came from.
function mergedTotals(steps, stored) {
  const computed = totals(steps), result = { total_steps: steps.length };
  for (const key of totalKeys) {
    const values = [computed[key], ...stored.map(item => item?.[key])].filter(value => typeof value === 'number');
    result[key] = values.length ? Math.max(...values) : null;
  }
  return result;
}
// Latest observed event wins scalar metadata; canonical text breaks ties when
// captures have no clock. Thus incoming means the later snapshot, not lock order.
const runTime = run => (run?.steps ?? []).reduce((time, item) => Math.max(time, Date.parse(item.timestamp) || 0), 0);
function unionMap(left, right) {
  const result = { ...left };
  for (const [key, value] of Object.entries(right ?? {})) {
    const old = result[key];
    ownData(result, key, old && value && typeof old === 'object' && typeof value === 'object'
      && !Array.isArray(old) && !Array.isArray(value) ? unionMap(old, value) : value);
  }
  return result;
}
export function mergeRuns(existing, incoming, marker = defaultMarker) {
  if (runTime(existing) > runTime(incoming) || runTime(existing) === runTime(incoming)
    && canonical(existing) > canonical(incoming)) [existing, incoming] = [incoming, existing];
  const steps = mergeSteps(existing?.steps, incoming?.steps, marker);
  const merged = { ...existing, ...incoming, steps };
  const extra = unionMap(existing?.agent?.extra, incoming?.agent?.extra);
  merged.agent = { ...existing?.agent, ...incoming?.agent };
  if (Object.keys(extra).length) merged.agent.extra = extra;
  if (existing?.extra || incoming?.extra) merged.extra = unionMap(existing?.extra, incoming?.extra);
  const children = new Map();
  for (const child of [...(existing?.subagent_trajectories ?? []), ...(incoming?.subagent_trajectories ?? [])]) {
    if (child?.trajectory_id != null) children.set(child.trajectory_id, children.has(child.trajectory_id)
      ? mergeRuns(children.get(child.trajectory_id), child, marker) : child);
  }
  if (children.size) merged.subagent_trajectories = [...children.values()].sort((a, b) => a.trajectory_id.localeCompare(b.trajectory_id));
  else delete merged.subagent_trajectories;
  merged.final_metrics = { ...existing?.final_metrics, ...incoming?.final_metrics,
    ...mergedTotals(steps, [existing?.final_metrics, incoming?.final_metrics]) };
  if (existing?.final_metrics?.extra || incoming?.final_metrics?.extra) {
    merged.final_metrics.extra = unionMap(existing?.final_metrics?.extra, incoming?.final_metrics?.extra);
  }
  return merged;
}
const corruptSuffix = '.corrupt-';
// The refusal of a lock that did not free up, in plain words.
const busy = 'Recording is busy right now. Try again in a moment. / A gravação está ocupada agora. Tente de novo em instantes.';
const previousDefaults = { stat, readJson, rename, rm, open };
async function quarantine(file, now, io) {
  let backup, reserved = false;
  try {
    for (let suffix = 0; ; suffix++) {
      backup = `${file}${corruptSuffix}${now}${suffix ? `-${suffix}` : ''}`;
      try { const handle = await io.open(backup, 'wx'); reserved = true; await handle.close(); break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    await io.rename(file, backup);
  } catch {
    // Do not silently overwrite a bad source if moving it failed.
    try {
      if (reserved) await rm(backup, { force: true });
      await io.rm(file, { force: true });
    }
    catch { throw new Error('Cannot replace recording. Try again. / Não foi possível substituir a gravação. Tente de novo.'); }
  }
}
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
