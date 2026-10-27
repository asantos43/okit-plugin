import { mkdir, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJsonAtomic, withLock } from '../state.js';
import { settings } from './config.js';
import { redact } from './redact.js';
import { validate } from './schema.js';

const prefix = 'okit-plugin-';
const bytes = value => Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`);
export const safeId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes('..');
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
  if (bytes(data) <= limit) return data;
  const marker = config.truncationMarker;
  for (const item of [...data.steps].reverse()) {
    item.message = marker;
    delete item.reasoning_content;
    item.tool_calls = [];
    item.observation = { results: [] };
    if (bytes(data) <= limit) return data;
  }
  while (data.steps.length > 1 && bytes(data) > limit) data.steps.pop();
  data.final_metrics.total_steps = data.steps.length;
  if (!data.steps.length || bytes(data) > limit) {
    throw new Error('Recording limit is too small / Limite de gravação pequeno demais');
  }
  return data;
}
export async function save(root, data) {
  const config = await settings(root);
  if (config.enabled !== true) return false;
  if (!validate(data) || !safeId(data.session_id)) throw new Error('Invalid saved run / Execução salva inválida');
  const safe = capped(redact(structuredClone(data), config), config);
  if (!validate(safe)) throw new Error('Invalid saved run / Execução salva inválida');
  await mkdir(config.dir, { recursive: true });
  await withLock(join(config.dir, 'okit-plugin-retention'), async () => {
    await writeJsonAtomic(join(config.dir, `${prefix}${data.session_id}.json`), safe);
    await pruneFiles(config);
  });
  return true;
}
