// The five functions of docs/maintainers/ARCHITECTURE.md section 4, for opencode.
// No CLI discovery at import time, no dependencies, Node >= 20 ESM.
import { randomUUID } from 'node:crypto';
import { roleContext, rolePrompt } from '../../src/roles.js';
import { roleBlock } from '../../src/install/role-block.js';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { installSkillFiles } from '../../src/skills.js';
import { configOf } from '../../src/profiles.js';
import { listModelsOf, makeSpawner } from '../../src/spawn-process.js';
import { readJson } from '../../src/state.js';
import { paths, stateRoot } from '../../src/store.js';
import { readOpencodeSource } from './quota-source.js';

export const CLIENT = 'opencode';

export function deliverRole(opts = {}) {
  if (opts.nativeSupported === false) return { status: 'unsupported', reason: 'opencode native agent configuration unsupported. / Configuração nativa de agente não suportada.' };
  const context = roleContext({ ...opts, client: CLIENT });
  if (context.status !== 'ready') return context;
  return { status: 'ready', context, native: { agent: { description: `okit ${context.role}`,
    mode: context.role === 'Director' ? 'primary' : 'subagent', prompt: rolePrompt({ ...opts, client: CLIENT }),
    ...(opts.actor ? { model: opts.actor.model, variant: opts.actor.effort } : {}) } } };
}

export async function installRole(opts = {}) {
  const delivery = deliverRole(opts);
  if (delivery.status !== 'ready') return delivery;
  // Command frontmatter selects the native agent; the installed plugin supplies its definition.
  return roleBlock(join(configRoot(opts), 'commands', 'okit.md'),
    `${delivery.native.agent.prompt}\nUse the okit-director agent. / Use o agente okit-director.`);
}
export function removeRole(opts = {}) {
  return roleBlock(join(configRoot(opts), 'commands', 'okit.md'), '', { remove: true });
}

/** Native plugin config hook: enrich primary agents without changing their actor. */
export function configureRoles(config, opts = {}) {
  const delivery = deliverRole(opts);
  if (delivery.status !== 'ready') return delivery;
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(config) || (config.agent !== undefined && (!object(config.agent)
    || Object.values(config.agent).some((agent) => !object(agent)
      || (agent.prompt !== undefined && typeof agent.prompt !== 'string'))))
    || (config.command !== undefined && !object(config.command))) {
    return { status: 'unsupported', reason: 'Unsupported opencode config format; preserved. / Formato de configuração opencode não suportado; preservado.' };
  }
  const agent = delivery.native.agent;
  const marker = '<!-- okit role:begin -->';
  config.agent ??= {};
  if (config.agent['okit-director'] && config.agent['okit-director'].prompt !== agent.prompt) {
    return { status: 'unsupported', reason: 'User agent okit-director conflicts; preserved. / Agente okit-director do usuário em conflito; preservado.' };
  }
  for (const name of new Set(['build', 'plan', ...Object.keys(config.agent)])) {
    if (name === 'okit-director') continue;
    const existing = config.agent[name] ?? {};
    if (existing.mode === 'subagent' || existing.prompt?.includes(marker)) continue;
    config.agent[name] = { ...existing, prompt: `${existing.prompt ?? ''}\n${marker}\n${agent.prompt}\n<!-- okit role:end -->` };
  }
  config.agent['okit-director'] ??= agent;
  config.default_agent ??= 'okit-director';
  config.command ??= {};
  config.command.okit ??= { description: 'okit Director', agent: 'okit-director', template: agent.prompt };
  return delivery;
}
const DEFAULT_CONFIG = Object.freeze({
  configParts: ['.config', CLIENT], configEnv: 'OPENCODE_CONFIG_DIR',
  xdgEnv: 'XDG_CONFIG_HOME', skillsDir: 'skills', pluginsDir: 'plugins',
  mode: 'PROCESS', runPrefix: 'oc-',
});
const FEATURES = { models: [], efforts: ['high', 'max', 'minimal'],
  skills: true, hooks: true, mcp: true, desktop: false, windows: false };
const optionalText = (value) => typeof value === 'string' && value.trim() !== '' ? value : null;
function text(value, label) {
  if (optionalText(value) === null) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

/** One safe folder/file segment; never a path outside the installation root. */
function segment(value) {
  const name = text(value, 'name');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || name.includes('..')) {
    throw new TypeError('name must be one folder name');
  }
  return name;
}

/** Explicit root, client override, XDG config home, then the actual OS home. */
export function configRoot({ root, env = process.env } = {}) {
  const override = optionalText(root) ?? optionalText(env?.[DEFAULT_CONFIG.configEnv]);
  if (override !== null) return resolve(override);
  const xdg = optionalText(env?.[DEFAULT_CONFIG.xdgEnv]);
  return xdg === null ? join(homedir(), ...DEFAULT_CONFIG.configParts) : resolve(xdg, CLIENT);
}

/** Fresh capabilities; empty models means discovery is left to the caller.
 * @returns {{models: string[], efforts: string[], skills: boolean, hooks: boolean,
 * mcp: boolean, desktop: boolean, windows: boolean}}
 */
export function capabilities() {
  return { ...FEATURES, models: [...FEATURES.models], efforts: [...FEATURES.efforts] };
}

/** Prefer a configured provider reading, falling back to the manual sample.
 * @param {{stateRoot?: string, env?: object, config?: object, now?: Function}} [opts]
 * @returns {Promise<object>}
 */
export async function readQuota({ stateRoot: root, env, now = Date.now, config } = {}) {
  const automatic = await readOpencodeSource({ config, env, now });
  if (automatic) return automatic;
  const fallback = Object.keys(config?.opencodeQuota?.sources ?? {}).length
    ? { reason: 'The sources provided no recent valid reading; using the manual value when available. / As fontes não forneceram leitura válida recente; usando o valor manual quando disponível.' } : {};
  const stored = await readJson(join(paths(root ?? stateRoot(env)).quota, `${CLIENT}.json`), null);
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  if (!finite(stored?.remainingPct)) return { source: 'user', ...fallback };
  const recorded = Date.parse(stored.recordedAt);
  return { source: 'user', ...fallback, remainingPct: stored.remainingPct,
    ...(Number.isFinite(recorded) ? { recordedAt: stored.recordedAt,
      ageMinutes: Math.max(0, now() - recorded) / 60_000 } : {}),
    ...(finite(stored.windowMinutes) ? { windowMinutes: stored.windowMinutes } : {}) };
}

/** Lists the models this client offers, read-only.
 *
 * The command, its arguments, the deadline and the interpreter of the output
 * come from the configuration (`setup.detect.opencode`); this adapter only
 * reads them. A missing executable, a command that does not answer in time, a
 * command that fails and an output the plugin does not understand are answers
 * with a reason in plain words, never exceptions.
 *
 * @param {{env?: object, run?: Function, config?: object, cwd?: string}} [opts]
 * @returns {Promise<{client: string, installed: boolean|null, models: string[],
 *   hidden: string[], source: 'listing'|'catalog', reason: string}>}
 */
export async function listModels(opts = {}) {
  const settings = configOf(opts.config).setup?.detect?.[CLIENT] ?? {};
  return listModelsOf(CLIENT, { ...opts, settings });
}

/** Start `opencode run` through makeSpawner; the Task bridge is not implemented.
 * @param {{model: string, effort?: string}} actor full provider/model id
 * @param {string} briefing
 * @param {{mode?: 'PROCESS', headless?: boolean, runId?: string, appliesTo?: string,
 * cwd?: string, maxMinutes?: number, spawn?: Function, logDir?: string, env?: object}} [opts]
 * @returns {Promise<{mode: string, runId: string, pid: number|null}>}
 */
export async function spawn(actor, briefing, opts = {}) {
  const model = text(actor?.model, 'actor.model');
  text(briefing, 'briefing');
  if (opts.mode !== undefined && opts.mode !== DEFAULT_CONFIG.mode) throw new TypeError('mode must be PROCESS');
  if (opts.headless !== undefined && opts.headless !== true) throw new TypeError('headless must be true');
  const effort = actor.effort == null ? null : text(actor.effort, 'actor.effort');
  const runId = segment(opts.runId ?? `${DEFAULT_CONFIG.runPrefix}${randomUUID()}`);
  const delivery = deliverRole({ ...opts, actor, briefing });
  if (delivery.status !== 'ready') throw new TypeError(delivery.reason);
  const prompt = delivery.native.agent.prompt;
  const spawner = makeSpawner({ spawn: opts.spawn, logDir: opts.logDir, env: opts.env, cwd: opts.cwd });
  return spawner({ title: prompt, id: opts.demand, appliesTo: opts.appliesTo }, {
    runId, client: CLIENT, profile: { model, effort }, maxMinutes: opts.maxMinutes,
    role: delivery.context.role.toLowerCase(), critic_of: opts.critic_of, step: opts.step,
  });
}

/** Copy a skill without replacing differing files, through the shared copier.
 * @param {string} name one folder segment
 * @param {string} files source folder containing SKILL.md
 * @param {{root?: string, env?: object}} [opts]
 * @returns {Promise<{path: string, written: string[], skipped: object[]}>}
 */
export async function installSkill(name, files, opts = {}) {
  const folder = segment(name);
  const source = text(files, 'files');
  try {
    await readFile(join(source, 'SKILL.md'));
  } catch (error) {
    throw new TypeError(`${source} is not a skill folder: no readable SKILL.md`, { cause: error });
  }
  return installSkillFiles(source, join(configRoot(opts), DEFAULT_CONFIG.skillsDir, folder));
}

/** Install a global JS plugin; never execute it or change opencode.json.
 * @param {string} files path of the JS module (its basename is the plugin name)
 * @param {{root?: string, env?: object}} [opts]
 * @returns {Promise<{path: string, written: boolean, reason?: string}>}
 * @throws {TypeError} for a non-JS module name; differing destinations are kept.
 */
export async function installHooks(files, opts = {}) {
  const source = text(files, 'files');
  const name = segment(basename(source));
  if (!name.endsWith('.js')) throw new TypeError('files must name a .js plugin module');
  const bytes = await readFile(source);
  const directory = join(configRoot(opts), DEFAULT_CONFIG.pluginsDir);
  const path = join(directory, name);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  await writeFile(temporary, bytes, { flag: 'wx' });
  try {
    // Publish complete bytes exclusively: rename would replace a user's file.
    await link(temporary, path);
    return { path, written: true };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const same = (await readFile(path)).equals(bytes);
    return { path, written: false, reason: same ? 'identical' : 'differs' };
  } finally {
    await unlink(temporary);
  }
}

export default { CLIENT, spawn, readQuota, capabilities, installSkill, installHooks, configRoot, listModels,
  deliverRole, installRole, removeRole, configureRoles };
export { readTrajectory } from './trajectory.js';
