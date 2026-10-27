import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJsonAtomic, withLock } from '../state.js';
import { paths } from '../store.js';
import { settings } from './config.js';
import { files, safeId, pruneFiles } from './store.js';
import { validate } from './schema.js';
export { save } from './store.js';
export const explanation = 'Saves messages, thoughts when available, tool inputs and results on this computer only. Nothing is sent. Secrets matching your settings are hidden. / Salva mensagens, raciocínio quando disponível, entradas e resultados de ferramentas somente neste computador. Nada é enviado. Segredos que correspondem aos seus ajustes são ocultados.';
export async function configure(root, enabled) {
  await mkdir(paths(root).locks, { recursive: true });
  return withLock(join(paths(root).locks, 'config'), async () => {
    const config = await readJson(paths(root).config, {});
    config.trajectory = { ...config.trajectory, enabled };
    await writeJsonAtomic(paths(root).config, config);
    return enabled ? explanation : 'Recording turned off / Gravação desligada';
  });
}
export async function status(root) {
  const config = await settings(root);
  return { enabled: config.enabled === true, where: config.dir, what: explanation };
}
export async function exportTrajectory(root, id) {
  if (!safeId(id)) throw new Error('Choose a saved run / Escolha uma execução salva');
  const config = await settings(root), file = join(config.dir, `okit-plugin-${id}.json`);
  if ((await stat(file)).size > config.maxFileBytes) throw new Error('Saved run exceeds limit / Execução salva excede o limite');
  const data = await readJson(file, null);
  if (!validate(data)) throw new Error('Cannot read saved run / Não foi possível ler a execução salva');
  return data;
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
  if (!(await files(config)).length) return { removed: 0 };
  return withLock(join(config.dir, 'okit-plugin-retention'), () => pruneFiles(config));
}
export async function show(root, id) {
  const data = await exportTrajectory(root, id), missing = 'not available / não disponível';
  const lines = [`${data.agent.extra.role === 'critic' ? 'Reviewer / Crítico' : 'Helper / Ajudante'}: ${data.agent.model_name ?? missing}`, 
    `Effort / Esforço: ${data.agent.extra.effort ?? missing}`,
    `Stopped at step / Parou no passo: ${data.steps.at(-1)?.step_id ?? missing}`];
  for (const item of data.steps) {
    lines.push(`${item.step_id}. ${item.source}: ${item.message ?? missing}`);
    if (item.reasoning_content) lines.push(item.reasoning_content);
    for (const call of item.tool_calls ?? []) lines.push(`Tool / Ferramenta: ${call.function_name} ${JSON.stringify(call.arguments)}`);
    for (const result of item.observation?.results ?? []) {
      const call = data.steps.flatMap(step => step.tool_calls ?? []).find(call => call.tool_call_id === result.source_call_id);
      lines.push(`${result.content?.is_error ? 'Failed tool / Ferramenta que falhou' : 'Result / Resultado'}: ${call?.function_name ?? missing}: ${JSON.stringify(result.content)}`);
    }
    lines.push(`Tokens in / entrada: ${item.metrics.prompt_tokens ?? missing}; out / saída: ${item.metrics.completion_tokens ?? missing}; cached / em cache: ${item.metrics.cached_tokens ?? missing}`);
  }
  return lines.join('\n');
}
