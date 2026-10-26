// The Claude Code adapter: the five functions of `docs/ARCHITECTURE.md`
// section 4 for one client. The core imports this module and never the CLI, so
// every fact about the client lives here and nowhere else.
//
// Zero dependencies, Node >= 20 ESM. Everything that touches the disk takes its
// root as an argument, so tests run against a temporary folder.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

import { installSkillFiles } from '../../src/skills.js';
import { postCompactConfig } from '../../src/hook-post-compact.js';
import { configOf, DEFAULT_CONFIG } from '../../src/profiles.js';
import { listModelsOf, makeSpawner } from '../../src/spawn-process.js';
import { readJson } from '../../src/state.js';
import { paths, stateRoot } from '../../src/store.js';

export const CLIENT = 'claude-code';

// Section 4.1: the model and effort values the Agent tool and the frontmatter
// accept, and every packaging feature this client has.
const MODELS = ['sonnet', 'opus', 'haiku', 'fable'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const CONFIG_DIR = '.claude';
const CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

const MODES = ['NATIVE', 'PROCESS'];

/** A non-empty string, or a `TypeError` that names what was expected. */
function text(value, what) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${what} must be a non-empty string`);
  }
  return value;
}

const textOrNull = (value) => (typeof value === 'string' && value.trim() !== '' ? value : null);

/**
 * A skill folder name is one path segment: nothing that could reach out of
 * `skills/`, and nothing a shell would word-split. A leading dot is refused,
 * so `..` cannot be a name.
 */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function skillName(value) {
  const name = text(value, 'name');
  if (!SKILL_NAME.test(name) || name.includes('..')) {
    throw new TypeError(`name must be one folder name: ${JSON.stringify(name)}`);
  }
  return name;
}

/** A finite number, or null: an absent reading is never turned into a zero. */
function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Key order does not decide equality: two spellings of one JSON are one JSON. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Puts `extra` into `base` without dropping anything the user wrote: the two
 * values of one key become the union of their arrays, nested objects merge key
 * by key, and every other value the user already has wins. So installing hooks
 * twice, or next to hooks the user wrote by hand, never loses a hook.
 */
function mergeInto(base, extra) {
  if (Array.isArray(base) && Array.isArray(extra)) {
    const union = [...base];
    for (const item of extra) if (!union.some((held) => canonical(held) === canonical(item))) union.push(item);
    return union;
  }
  if (isPlainObject(base) && isPlainObject(extra)) {
    const merged = { ...base };
    for (const [key, value] of Object.entries(extra)) {
      merged[key] = key in merged ? mergeInto(merged[key], value) : value;
    }
    return merged;
  }
  return base;
}

/**
 * What Claude Code reads: `opts.root`, else `CLAUDE_CONFIG_DIR`, else
 * `~/.claude`. Every path is built with `node:path`, never by hand.
 */
export function configRoot({ root, env = process.env } = {}) {
  const given = textOrNull(root);
  if (given !== null) return resolve(given);
  const override = textOrNull(env?.[CONFIG_DIR_ENV]);
  return override !== null ? resolve(override) : join(homedir(), CONFIG_DIR);
}

/**
 * What this client can do, in the shape section 4 asks for. A fresh object
 * every call, so a caller cannot edit the values the next call hands out.
 *
 * @returns {{models: string[], efforts: string[], skills: boolean, hooks: boolean,
 *   mcp: boolean, desktop: boolean, windows: boolean}}
 */
export function capabilities() {
  return {
    models: [...MODELS],
    efforts: [...EFFORTS],
    skills: true,
    hooks: true,
    mcp: true,
    desktop: true,
    windows: true,
  };
}

/**
 * Reads the latest automatic status bar sample or the user's manual sample.
 *
 * @param {{stateRoot?: string, env?: object, now?: Function}} [opts]
 * @returns {Promise<object>}
 */
export async function readQuota({ stateRoot: root, env, now = Date.now } = {}) {
  const stored = await readJson(join(paths(root ?? stateRoot(env)).quota, `${CLIENT}.json`), null);
  const remainingPct = number(stored?.remainingPct);
  const windowMinutes = number(stored?.windowMinutes);
  if (remainingPct === null) return { source: 'user' };
  const recorded = Date.parse(stored.recordedAt);
  return { source: stored.source === 'automatic' ? 'automatic' : 'user', remainingPct,
    ...(stored.source === 'automatic' && Array.isArray(stored.windows) ? { windows: stored.windows } : {}),
    ...(windowMinutes === null ? {} : { windowMinutes }),
    ...(Number.isFinite(recorded) ? { recordedAt: stored.recordedAt,
      ageMinutes: Math.max(0, now() - recorded) / 60_000 } : {}) };
}

/**
 * Lists the models this client offers, read-only.
 *
 * The command, its arguments, the deadline and the interpreter of the output
 * come from the configuration (`setup.detect.claude-code`); this adapter only
 * reads them, and the default configuration names no command for this client,
 * so the answer says so and the catalog is used. A missing executable, a
 * command that does not answer in time, a command that fails and an output
 * the plugin does not understand are answers with a reason in plain words,
 * never exceptions.
 *
 * @param {{env?: object, run?: Function, config?: object, cwd?: string}} [opts]
 * @returns {Promise<{client: string, installed: boolean|null, models: string[],
 *   hidden: string[], source: 'listing'|'catalog', reason: string}>}
 */
export async function listModels(opts = {}) {
  const settings = configOf(opts.config).setup?.detect?.[CLIENT] ?? {};
  return listModelsOf(CLIENT, { ...opts, settings });
}

/** The actor profile as the Agent tool takes it: a model, and an effort we know. */
function actorOf(actor) {
  if (!isPlainObject(actor)) throw new TypeError('actor must be an object with model and effort');
  const model = text(actor.model, 'actor.model');
  const effort = textOrNull(actor.effort);
  if (effort !== null && !EFFORTS.includes(effort)) {
    throw new TypeError(`actor.effort must be one of ${EFFORTS.join(', ')}`);
  }
  return { model, effort, permissionMode: textOrNull(actor.permissionMode) };
}

/**
 * `opts.mode` names the mode; `headless` is the shorthand for the daemon, and
 * the mode is `NATIVE` without either, because that is the interactive session
 * (section 12).
 */
function modeOf({ mode, headless } = {}) {
  const given = textOrNull(mode);
  if (given !== null && !MODES.includes(given)) {
    throw new TypeError(`mode must be one of ${MODES.join(', ')}`);
  }
  if (given !== null) return given;
  if (headless !== undefined && typeof headless !== 'boolean') {
    throw new TypeError('headless must be a boolean');
  }
  return headless === true ? 'PROCESS' : 'NATIVE';
}

const RUN_PREFIX = 'cc-';
const newRunId = () => `${RUN_PREFIX}${randomBytes(4).toString('hex')}`;

/**
 * Starts one run of Claude Code, in the mode the caller asks for.
 *
 * `NATIVE` starts no process: the client's own Agent tool makes the call, so
 * the core is not in the loop and what the Director has to pass to that tool is
 * handed back untouched as `agentCall`.
 *
 * `PROCESS` is the daemon path and goes through `makeSpawner` of
 * `src/spawn-process.js`, so the headless command is built in one place and
 * this adapter never repeats the flags.
 *
 * @param {{model: string, effort?: string, permissionMode?: string}} actor
 * @param {string} briefing
 * @param {{mode?: 'NATIVE'|'PROCESS', headless?: boolean, runId?: string,
 *   appliesTo?: string, cwd?: string, maxMinutes?: number, permissionMode?: string,
 *   spawn?: Function, logDir?: string, env?: object}} [opts]
 * @returns {Promise<{mode: string, runId: string, pid?: number|null,
 *   agentCall?: {model: string, effort: string|null, prompt: string}}>}
 * @throws {TypeError} on an empty briefing, an actor with no model, an unknown
 *   effort or mode
 */
export async function spawn(actor, briefing, opts = {}) {
  const profile = actorOf(actor);
  const prompt = text(briefing, 'briefing');
  const mode = modeOf(opts);
  const runId = textOrNull(opts.runId) ?? newRunId();

  if (mode === 'NATIVE') {
    return { mode, runId, agentCall: { model: profile.model, effort: profile.effort, prompt } };
  }

  const spawner = makeSpawner({ spawn: opts.spawn, logDir: opts.logDir, env: opts.env, cwd: opts.cwd });
  const outcome = await spawner(
    { title: prompt, appliesTo: textOrNull(opts.appliesTo) },
    {
      runId,
      client: CLIENT,
      profile: {
        model: profile.model,
        effort: profile.effort,
        permissionMode: opts.permissionMode ?? profile.permissionMode,
      },
      maxMinutes: opts.maxMinutes,
    },
  );
  return { mode: outcome.mode, runId: outcome.runId, pid: outcome.pid ?? null };
}

/**
 * Copies the skill folder `files` to `<root>/skills/<name>/`, where Claude Code
 * reads `skills/<name>/SKILL.md` from (section 4.1). The copy never overwrites
 * a file that already differs: the user's own copy wins and the caller is told
 * which files were kept and why.
 *
 * @param {string} name one folder name, no separator and no `..`
 * @param {string} files path of the skill folder to install
 * @param {{root?: string, env?: object}} [opts]
 * @returns {Promise<{path: string, written: string[], skipped: {path: string, reason: string}[]}>}
 * @throws {TypeError} on a name that is not one folder name, a missing folder or
 *   a folder without `SKILL.md`
 */
export async function installSkill(name, files, opts = {}) {
  const folder = skillName(name);
  const source = text(files, 'files');
  try {
    await readFile(join(source, 'SKILL.md'), 'utf8');
  } catch (error) {
    throw new TypeError(`${source} is not a skill folder: no readable SKILL.md (${error.message})`, { cause: error });
  }
  return installSkillFiles(source, join(configRoot(opts), 'skills', folder));
}

/**
 * Writes or merges `<root>/hooks/hooks.json`, the file section 4.1 names as the
 * hook configuration. Our entries join what is already there and nothing the
 * user wrote is dropped or changed, so a second install over an edited file is
 * a no-op instead of a takeover; `written` says whether the file changed at
 * all.
 *
 * @param {object} files the hook config, as a JSON object
 * @param {{root?: string, env?: object}} [opts]
 * @returns {Promise<{path: string, written: boolean}>}
 * @throws {TypeError} when `files` is not a JSON object, or a hooks file that
 *   exists but is not readable JSON
 */
export async function installHooks(files, opts = {}) {
  if (!isPlainObject(files)) throw new TypeError('files must be the hook config as an object');
  const file = join(configRoot(opts), 'hooks', 'hooks.json');
  // `readJson` refuses a file that is there and is not JSON: an unreadable hook
  // config is reported to the user, never replaced by ours.
  const current = await readJson(file, null);
  if (current !== null && !isPlainObject(current)) {
    throw new TypeError(`${file} is not a hook config: expected a JSON object`);
  }
  const merged = current === null ? files : mergeInto(current, files);
  const written = canonical(current) !== canonical(merged);

  if (written) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  }
  return { path: file, written };
}

/** Builds the compact-only entry; command may name an installed absolute CLI. */
export function postCompactHooks({ config, command = `${DEFAULT_CONFIG.install.command} hook post-compact` } = {}) {
  const settings = postCompactConfig(config);
  return { SessionStart: [{ matcher: 'compact', hooks: [{
    type: 'command', command: text(command, 'command'), timeout: settings.timeoutSec,
  }] }] };
}

/** No general installer exists yet; packaging callers install this explicitly. */
export function installPostCompactHook(opts = {}) {
  return installHooks(postCompactHooks(opts), opts);
}

export default { CLIENT, spawn, readQuota, capabilities, installSkill, installHooks, configRoot,
  listModels, postCompactHooks, installPostCompactHook };
