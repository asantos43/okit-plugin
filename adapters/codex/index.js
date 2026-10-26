// Codex adapter: docs/ARCHITECTURE.md section 4. No CLI runs at import time.
import { randomBytes } from 'node:crypto';
import { formatRoleContext, roleContext, rolePrompt } from '../../src/roles.js';
import { roleBlock } from '../../src/install/role-block.js';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { installSkillFiles } from '../../src/skills.js';
import { configOf } from '../../src/profiles.js';
import { listModelsOf, makeSpawner } from '../../src/spawn-process.js';
import { readJson } from '../../src/state.js';
import { paths, stateRoot } from '../../src/store.js';
import { readCodexSessionQuota } from './session-quota.js';

export const CLIENT = 'codex';

export function deliverRole(opts = {}) {
  if (opts.nativeSupported === false) return { status: 'unsupported', reason: 'Codex native AGENTS.md/prompt delivery unsupported. / Entrega nativa AGENTS.md/prompt não suportada.' };
  const context = roleContext({ ...opts, client: CLIENT });
  if (context.status !== 'ready') return context;
  return { status: 'ready', context, native: { instructions: formatRoleContext(context),
    prompt: rolePrompt({ ...opts, client: CLIENT }), model: opts.actor?.model, effort: opts.actor?.effort } };
}

export async function installRole(opts = {}) {
  const delivery = deliverRole(opts);
  if (delivery.status !== 'ready') return delivery;
  const override = await readFile(join(configRoot(opts), 'AGENTS.override.md'), 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  });
  if (override.trim()) return { status: 'unsupported', reason: 'AGENTS.override.md shadows AGENTS.md; user instructions preserved. / AGENTS.override.md oculta AGENTS.md; instruções preservadas.' };
  return roleBlock(join(configRoot(opts), 'AGENTS.md'), delivery.native.prompt);
}
export function removeRole(opts = {}) {
  return roleBlock(join(configRoot(opts), 'AGENTS.md'), '', { remove: true });
}

/** Non-empty caller text; never converted into shell syntax. */
function text(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}
const optionalText = (value) => typeof value === 'string' && value.trim() !== '' ? value : null;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** Explicit root, then CODEX_HOME, then the current user's home. */
export function configRoot({ root, env = process.env } = {}) {
  return resolve(optionalText(root) ?? optionalText(env?.CODEX_HOME) ?? join(homedir(), '.codex'));
}

/**
 * Bundled catalog from `codex debug models --bundled` (0.163.0).
 * A fresh table; these are known names, not a promise of account access.
 * hooks=false means this installer lacks a verified schema, not no CLI hooks.
 * @returns {{models: string[], efforts: string[], skills: boolean, hooks: boolean,
 *   mcp: boolean, desktop: boolean, windows: boolean}}
 */
export function capabilities() {
  return {
    models: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna',
      'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
      'gpt-daybreak-blue-latest', 'gpt-daybreak-red-latest', 'gpt-5.5', 'codex-auto-review'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    skills: true, hooks: false, mcp: true, desktop: false, windows: false,
  };
}

/**
 * Uses a fresh session reading when newer than the manual sample. Read-only.
 * @param {{stateRoot?: string, env?: object, config?: object, now?: Function}} [opts]
 */
export async function readQuota({ stateRoot: root, env, now = Date.now, config } = {}) {
  const base = root ?? stateRoot(env);
  const settings = config ?? await readJson(join(base, 'config.json'), {});
  const automatic = await readCodexSessionQuota({ config: settings, env, now });
  const stored = await readJson(join(paths(base).quota, `${CLIENT}.json`), null);
  const recorded = Date.parse(stored?.recordedAt);
  if (automatic && (!finite(stored?.remainingPct) || !Number.isFinite(recorded)
    || Date.parse(automatic.recordedAt) > recorded)) return automatic;
  if (!finite(stored?.remainingPct)) return { source: 'manual' };
  return { source: 'manual', remainingPct: stored.remainingPct,
    ...(Number.isFinite(recorded) ? { recordedAt: stored.recordedAt,
      ageMinutes: Math.max(0, now() - recorded) / 60_000 } : {}),
    ...(finite(stored.windowMinutes) ? { windowMinutes: stored.windowMinutes } : {}) };
}

/**
 * Lists the models this client offers, read-only.
 *
 * The command, its arguments, the deadline and the interpreter of the output
 * come from the configuration (`setup.detect.codex`); this adapter only reads
 * them. A missing executable, a command that does not answer in time, a
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

/**
 * Starts a PROCESS via makeSpawner; NATIVE returns a core delegation descriptor.
 * @param {{model: string, effort?: string, sandbox?: string}} actor
 * @param {string} briefing
 * @param {{mode?: 'NATIVE'|'PROCESS', headless?: boolean, runId?: string,
 *   appliesTo?: string, cwd?: string, maxMinutes?: number, sandbox?: string,
 *   spawn?: Function, logDir?: string, env?: object, root?: string}} [opts]
 * @returns {Promise<{mode: string, runId: string, pid?: number|null, agentCall?: object}>}
 */
export async function spawn(actor, briefing, opts = {}) {
  const model = text(actor?.model, 'actor.model');
  text(briefing, 'briefing');
  const effort = optionalText(actor?.effort);
  if (effort !== null && !capabilities().efforts.includes(effort)) {
    throw new TypeError(`actor.effort must be one of ${capabilities().efforts.join(', ')}`);
  }
  if (opts.headless !== undefined && typeof opts.headless !== 'boolean') {
    throw new TypeError('headless must be a boolean');
  }
  const mode = optionalText(opts.mode) ?? (opts.headless === true ? 'PROCESS' : 'NATIVE');
  if (!['NATIVE', 'PROCESS'].includes(mode)) throw new TypeError('mode must be NATIVE or PROCESS');
  const runId = optionalText(opts.runId) ?? `${CLIENT}-${randomBytes(4).toString('hex')}`;
  const delivery = deliverRole({ ...opts, actor, briefing });
  if (delivery.status !== 'ready') throw new TypeError(delivery.reason);
  const prompt = delivery.native.prompt;
  if (mode === 'NATIVE') {
    return { mode, runId, agentCall: { model, effort, prompt } };
  }
  const spawner = makeSpawner({ spawn: opts.spawn, logDir: opts.logDir, cwd: opts.cwd,
    env: { ...(opts.env ?? process.env), CODEX_HOME: configRoot(opts) } });
  return spawner({ title: prompt, appliesTo: opts.appliesTo }, {
    runId, client: CLIENT, profile: { model, effort, sandbox: opts.sandbox ?? actor.sandbox },
    maxMinutes: opts.maxMinutes,
  });
}

/**
 * Copies a skill into <root>/skills/<name>, preserving differing user files.
 * The chosen plugin root must be registered separately (D-Q2).
 * @param {string} name one folder name
 * @param {string} files source folder with SKILL.md
 * @param {{root?: string, env?: object}} [opts]
 * @returns {Promise<{path: string, written: string[], skipped: object[]}>}
 */
export async function installSkill(name, files, opts = {}) {
  text(name, 'name');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || name.includes('..')) {
    throw new TypeError('name must be one folder name');
  }
  const source = text(files, 'files');
  try { await readFile(join(source, 'SKILL.md'), 'utf8'); }
  catch (error) {
    throw new TypeError(`${source} is not a skill folder: no readable SKILL.md`, { cause: error });
  }
  return installSkillFiles(source, join(configRoot(opts), 'skills', name));
}

/**
 * Refuses installation until the installed client's hook schema is verified.
 * The CLI mentions hook trust, but that is insufficient to safely merge config.
 * @param {object} files requested hook config (never written)
 * @param {{root?: string, env?: object}} [opts]
 * @returns {Promise<never>}
 * @throws {Error} always, without reading or modifying user configuration
 */
export async function installHooks(files, opts = {}) {
  void files;
  void opts;
  throw new Error('Codex hook installation unsupported: installed CLI mentions hooks, but no verified configuration schema is available; user configuration was not changed');
}

export default { CLIENT, spawn, readQuota, capabilities, installSkill, installHooks, configRoot, listModels,
  deliverRole, installRole, removeRole };
