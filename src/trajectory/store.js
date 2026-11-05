import { mkdir, readdir, rename, stat, rm } from 'node:fs/promises';
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
export async function files(config) {
  try { return (await readdir(config.dir)).filter(name => name.startsWith(prefix) && name.endsWith('.json')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
export async function pruneFiles(config, now = Date.now()) {
  const entries = await Promise.all((await files(config)).map(async name => ({ name, ...await stat(join(config.dir, name)) })));
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  let size = 0, removed = 0;
  for (const entry of entries) {
    if (entry.mtimeMs < now - config.retentionDays * 86400000 || size + entry.size > config.maxBytes) {
      await rm(join(config.dir, entry.name), { force: true }); removed++;
    } else size += entry.size;
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
// The identity of a step inside one session is its position: every capture
// rebuilds the same steps in the same order, so step_id names the same step
// in every save of that session.
const stepParts = item => {
  let count = 0;
  if (item?.message) count += 1;
  if (item?.reasoning_content) count += 1;
  count += item?.tool_calls?.length ?? 0;
  count += item?.observation?.results?.length ?? 0;
  for (const key of Object.keys(item?.metrics ?? {})) if (item.metrics[key] != null) count += 1;
  return count + Object.keys(item?.extra ?? {}).length;
};
const stepText = item => JSON.stringify(item) ?? '';
// The richer step wins its position: more content parts, then more bytes, then
// the canonical text, so the answer never depends on the order of the saves.
export function richer(left, right) {
  const parts = stepParts(left) - stepParts(right);
  if (parts !== 0) return parts > 0;
  const size = Buffer.byteLength(stepText(left)) - Buffer.byteLength(stepText(right));
  if (size !== 0) return size > 0;
  return stepText(left) > stepText(right);
}
// The union of two runs of the same session: every step of both is kept and
// the richer one wins the position they share.
export function mergeSteps(existing = [], incoming = []) {
  const byId = new Map();
  for (const item of existing) if (Number.isInteger(item?.step_id)) byId.set(item.step_id, item);
  for (const item of incoming) {
    if (!Number.isInteger(item?.step_id)) continue;
    const kept = byId.get(item.step_id);
    if (kept === undefined || richer(item, kept)) byId.set(item.step_id, item);
  }
  return [...byId.values()].sort((a, b) => a.step_id - b.step_id);
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
export function mergeRuns(existing, incoming) {
  const steps = mergeSteps(existing?.steps, incoming?.steps);
  steps.forEach((item, index) => { item.step_id = index + 1; });
  const merged = { ...existing, ...incoming, steps };
  const extra = { ...existing?.agent?.extra, ...incoming?.agent?.extra };
  merged.agent = { ...existing?.agent, ...incoming?.agent };
  if (Object.keys(extra).length) merged.agent.extra = extra;
  const children = new Map();
  for (const child of [...(existing?.subagent_trajectories ?? []), ...(incoming?.subagent_trajectories ?? [])]) {
    if (child?.trajectory_id != null) children.set(child.trajectory_id, child);
  }
  if (children.size) merged.subagent_trajectories = [...children.values()];
  else delete merged.subagent_trajectories;
  merged.final_metrics = { ...existing?.final_metrics, ...incoming?.final_metrics,
    ...mergedTotals(steps, [existing?.final_metrics, incoming?.final_metrics]) };
  return merged;
}
const corruptSuffix = '.corrupt-';
// The refusal of a lock that did not free up, in plain words.
const busy = 'Recording is busy right now. Try again in a moment. / A gravação está ocupada agora. Tente de novo em instantes.';
// The file a session already has: read under the lock. A file that cannot be
// read is not merged: it is renamed aside, so its bytes are kept and the new
// save still goes through.
async function readPrevious(file, now) {
  const missing = Symbol('missing');
  let parsed = missing;
  try { parsed = await readJson(file, missing); }
  catch { parsed = null; } // a file that is not JSON cannot be merged
  if (parsed === missing) return null;
  if (parsed && readable(parsed)) return parsed;
  try { await rename(file, `${file}${corruptSuffix}${now}`); } catch { /* the save still goes through */ }
  return null;
}
export async function save(root, data, { lockTimeoutMs = 5000, now = Date.now() } = {}) {
  const config = await settings(root);
  if (config.enabled !== true) return false;
  if (!safeId(data?.session_id)) return false;
  const prepared = normalize(redact(boundedClone(data), config), { dir: config.dir });
  if (!validate(prepared)) throw new Error('Invalid saved run / Execução salva inválida');
  await mkdir(config.dir, { recursive: true });
  const file = join(config.dir, `${prefix}${data.session_id}.json`);
  try {
    await withLock(join(config.dir, 'okit-plugin-retention'), async () => {
      const previous = await readPrevious(file, now);
      const merged = previous ? mergeRuns(previous, prepared) : prepared;
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
