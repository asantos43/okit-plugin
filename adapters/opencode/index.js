// The five functions of docs/ARCHITECTURE.md section 4, for opencode.
// No CLI discovery at import time, no dependencies, Node >= 20 ESM.
import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { installSkillFiles } from '../../src/skills.js';
import { configOf } from '../../src/profiles.js';
import { listModelsOf, makeSpawner } from '../../src/spawn-process.js';
import { readJson } from '../../src/state.js';
import { paths, stateRoot } from '../../src/store.js';

export const CLIENT = 'opencode';
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

/** No verified local plan quota: read only the core's user-supplied sample.
 * @param {{stateRoot?: string, env?: object}} [opts]
 * @returns {Promise<{source: 'user', remainingPct?: number, windowMinutes?: number, recordedAt?: string, ageMinutes?: number}>}
 */
export async function readQuota({ stateRoot: root, env, now = Date.now } = {}) {
  const stored = await readJson(join(paths(root ?? stateRoot(env)).quota, `${CLIENT}.json`), null);
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  if (!finite(stored?.remainingPct)) return { source: 'user' };
  const recorded = Date.parse(stored.recordedAt);
  return { source: 'user', remainingPct: stored.remainingPct,
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
  const prompt = text(briefing, 'briefing');
  if (opts.mode !== undefined && opts.mode !== DEFAULT_CONFIG.mode) throw new TypeError('mode must be PROCESS');
  if (opts.headless !== undefined && opts.headless !== true) throw new TypeError('headless must be true');
  const effort = actor.effort == null ? null : text(actor.effort, 'actor.effort');
  const runId = segment(opts.runId ?? `${DEFAULT_CONFIG.runPrefix}${randomUUID()}`);
  const spawner = makeSpawner({ spawn: opts.spawn, logDir: opts.logDir, env: opts.env, cwd: opts.cwd });
  return spawner({ title: prompt, appliesTo: opts.appliesTo }, {
    runId, client: CLIENT, profile: { model, effort }, maxMinutes: opts.maxMinutes,
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

export default { CLIENT, spawn, readQuota, capabilities, installSkill, installHooks, configRoot, listModels };
