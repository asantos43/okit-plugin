import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJsonAtomic, withLock } from '../state.js';
import { paths } from '../store.js';
import { settings } from './config.js';
import { files, safeId, pruneFiles } from './store.js';
import { normalize, readable } from './schema.js';
export { save } from './store.js';
export const explanation = 'Saves messages, thoughts when available, tool inputs and results on this computer only. Nothing is sent. Secrets matching your settings are hidden.';
export async function configure(root, enabled) {
  await mkdir(paths(root).locks, { recursive: true });
  return withLock(join(paths(root).locks, 'config'), async () => {
    const config = await readJson(paths(root).config, {});
    config.trajectory = { ...config.trajectory, enabled };
    await writeJsonAtomic(paths(root).config, config);
    return enabled ? explanation : 'Recording turned off';
  });
}
export async function status(root) {
  const config = await settings(root);
  return { enabled: config.enabled === true, where: config.dir, what: explanation };
}
export async function exportTrajectory(root, id) {
  if (!safeId(id)) throw new Error('Choose a saved run');
  const config = await settings(root), file = join(config.dir, `okit-plugin-${id}.json`);
  if ((await stat(file)).size > config.maxFileBytes) throw new Error('Saved run exceeds limit');
  const data = await readJson(file, null);
  if (!readable(data)) throw new Error('Cannot read saved run');
  return normalize(data);
}
export async function list(root) {
  const config = await settings(root), result = [];
  for (const name of (await files(config)).sort()) {
    const id = name.slice('okit-plugin-'.length, -'.json'.length);
    const data = await exportTrajectory(root, id);
    result.push({ session_id: id, model: data.agent.model_name, ...data.agent.extra, steps: data.steps.length });
  }
  return result;
}
export async function prune(root) {
  const config = await settings(root);
  if (!(await files(config, { backups: true })).length) return { removed: 0 };
  return withLock(join(config.dir, 'okit-plugin-retention'), () => pruneFiles(config));
}
function displayContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(part => part.type === 'text'
    ? part.text : `[image: ${part.source.path}]`).join('\n');
  return '';
}
export async function show(root, id) {
  const data = await exportTrajectory(root, id), missing = 'not available';
  const lines = [`${data.agent.extra?.role === 'critic' ? 'Reviewer' : 'Helper'}: ${data.agent.model_name ?? missing}`,
    `Effort: ${data.agent.extra?.effort ?? missing}`,
    `Stopped at step: ${data.steps.at(-1)?.step_id ?? missing}`];
  if (data.agent.extra?.account && data.agent.extra.account !== 'default') lines.push(`Account: ${data.agent.extra.account}`);
  for (const item of data.steps) {
    const calls = new Map((item.tool_calls ?? []).map(call => [call.tool_call_id, call]));
    const failedCalls = new Set(Array.isArray(item.extra?.failed_calls) ? item.extra.failed_calls : []);
    const failedResults = new Set(Array.isArray(item.extra?.failed_results) ? item.extra.failed_results : []);
    lines.push(`${item.step_id}. ${item.source}: ${displayContent(item.message) || missing}`);
    if (item.reasoning_content) lines.push(item.reasoning_content);
    for (const call of item.tool_calls ?? []) lines.push(`Tool: ${call.function_name} ${JSON.stringify(call.arguments)}`);
    for (const [index, result] of (item.observation?.results ?? []).entries()) {
      const call = calls.get(result.source_call_id);
      const failed = (result.source_call_id != null && failedCalls.has(result.source_call_id))
        || failedResults.has(index) || result.content?.is_error;
      const refs = (result.subagent_trajectory_ref ?? []).map(ref => `→ ${ref.trajectory_path ?? ref.session_id ?? ref.trajectory_id}`);
      const output = [displayContent(result.content), ...refs].filter(Boolean).join('\n');
      lines.push(`${failed ? 'Failed tool' : 'Result'}: ${call?.function_name ?? missing}: ${output || missing}`);
    }
    lines.push(`Tokens in: ${item.metrics?.prompt_tokens ?? missing}; out: ${item.metrics?.completion_tokens ?? missing}; cached: ${item.metrics?.cached_tokens ?? missing}`);
  }
  return lines.join('\n');
}
