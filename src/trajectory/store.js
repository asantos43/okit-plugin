import { mkdir, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJsonAtomic, withLock } from '../state.js';
import { settings } from './config.js';
import { redact } from './redact.js';
import { boundedClone, normalize, validate, totals, ownData } from './schema.js';

const prefix = 'okit-plugin-';
const bytes = value => Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`);
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
    for (const item of [...run.steps].reverse()) {
      const before = bytes(item);
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
        if (!Object.keys(item.extra).length) delete item.extra;
      }
      size -= before - bytes(item);
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
  for (const run of runs) {
    while (run.steps.length > 1 && size > limit) size -= bytes(run.steps.pop());
    run.final_metrics.total_steps = run.steps.length;
  }
  if (!data.steps.length || bytes(data) > limit) {
    throw new Error('Recording limit is too small / Limite de gravação pequeno demais');
  }
  return data;
}
export async function save(root, data) {
  const config = await settings(root);
  if (config.enabled !== true) return false;
  if (!safeId(data?.session_id)) return false;
  const safe = capped(normalize(redact(boundedClone(data), config), { dir: config.dir }), config);
  if (!validate(safe)) throw new Error('Invalid saved run / Execução salva inválida');
  await mkdir(config.dir, { recursive: true });
  await withLock(join(config.dir, 'okit-plugin-retention'), async () => {
    await writeJsonAtomic(join(config.dir, `${prefix}${data.session_id}.json`), safe);
    await pruneFiles(config);
  });
  return true;
}
