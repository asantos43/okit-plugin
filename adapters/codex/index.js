// Codex adapter: docs/ARCHITECTURE.md section 4. No CLI runs at import time.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { installSkillFiles } from '../../src/skills.js';
import { makeSpawner } from '../../src/spawn-process.js';
import { readJson } from '../../src/state.js';
import { paths, stateRoot } from '../../src/store.js';

export const CLIENT = 'codex';

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
 * Reads only the core's user-supplied quota sample, never client credentials.
 * No verified local quota file or offline quota command was found.
 * @param {{stateRoot?: string, env?: object}} [opts]
 * @returns {Promise<{source: 'user', remainingPct?: number, windowMinutes?: number}>}
 */
export async function readQuota({ stateRoot: root, env } = {}) {
  const stored = await readJson(join(paths(root ?? stateRoot(env)).quota, `${CLIENT}.json`), null);
  if (!finite(stored?.remainingPct)) return { source: 'user' };
  return { source: 'user', remainingPct: stored.remainingPct,
    ...(finite(stored.windowMinutes) ? { windowMinutes: stored.windowMinutes } : {}) };
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
  const prompt = text(briefing, 'briefing');
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

export default { CLIENT, spawn, readQuota, capabilities, installSkill, installHooks, configRoot };
