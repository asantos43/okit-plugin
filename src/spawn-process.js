// PROCESS spawn mode: the daemon starts the client's own headless CLI as a
// child process. The command is a pure value and is started without a shell,
// so nothing in the briefing is ever read as shell syntax.

import child_process from 'node:child_process';
import { mkdir, open, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';

import { readJson, writeJsonAtomic } from './state.js';
import { paths, stateRoot } from './store.js';

export const CLIENTS = ['claude-code', 'codex', 'opencode'];

// The flags below were read from each client's own help on 2026-10-22; see
// `docs/ARCHITECTURE.md` section 12.
const CLAUDE_COMMAND = 'claude';
const CODEX_COMMAND = 'codex';
const OPENCODE_COMMAND = 'opencode';

const DEFAULT_PERMISSION_MODE = 'acceptEdits';
const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
const SANDBOXES = ['workspace-write', 'read-only', 'danger-full-access'];
const DEFAULT_SANDBOX = 'workspace-write';

// A run started by the daemon must not start a daemon of its own.
const NO_DAEMON_ENV = 'OKWORK_NO_DAEMON';

/** A non-empty string, or a `TypeError` that names what was expected. */
function text(value, what) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${what} must be a non-empty string`);
  }
  return value;
}

const textOrNull = (value) => (typeof value === 'string' && value.trim() !== '' ? value : null);

function oneOf(value, allowed, what) {
  if (value === undefined || value === null) return null;
  if (!allowed.includes(value)) {
    throw new TypeError(`${what} must be one of ${allowed.join(', ')}`);
  }
  return value;
}

// `claude -p <briefing> --model <m> --effort <level> --output-format json
//  --permission-mode <mode> --add-dir <dir>`. There is no `--max-turns` in
// `claude --help` (checked 2026-10-22), so `maxTurns` is not passed on the
// command line at all: the briefing is the only bound, plus `maxMinutes`.
function claudeCode({ briefing, model, effort, cwd, permissionMode }) {
  const mode = permissionMode ?? DEFAULT_PERMISSION_MODE;
  oneOf(mode, PERMISSION_MODES, 'permissionMode');
  const args = ['-p', briefing, '--model', model];
  if (effort !== null) args.push('--effort', effort);
  args.push('--output-format', 'json', '--permission-mode', mode);
  if (cwd !== null) args.push('--add-dir', cwd);
  return { command: CLAUDE_COMMAND, args };
}

// `codex exec --cd <dir> --model <m> --sandbox <s> --json
//  --skip-git-repo-check -c model_reasoning_effort=<level> <briefing>`.
// `--skip-git-repo-check` because a worktree of the maintainer's choice is not
// always a git repository, and a run must not refuse to start over that.
function codex({ briefing, model, effort, cwd, sandbox }) {
  const mode = sandbox ?? DEFAULT_SANDBOX;
  oneOf(mode, SANDBOXES, 'sandbox');
  const args = ['exec'];
  if (cwd !== null) args.push('--cd', cwd);
  args.push('--model', model, '--sandbox', mode, '--json', '--skip-git-repo-check');
  if (effort !== null) args.push('-c', `model_reasoning_effort=${effort}`);
  args.push(briefing);
  return { command: CODEX_COMMAND, args };
}

// `opencode run --dir <dir> --model <provider/model> --variant <effort>
//  --format json <briefing>`; the model is the full `provider/model` id the
// profile carries, and the effort is a provider variant.
function opencode({ briefing, model, effort, cwd }) {
  const args = ['run'];
  if (cwd !== null) args.push('--dir', cwd);
  args.push('--model', model);
  if (effort !== null) args.push('--variant', effort);
  args.push('--format', 'json', briefing);
  return { command: OPENCODE_COMMAND, args };
}

const BUILDERS = {
  'claude-code': claudeCode,
  codex,
  opencode,
};

/**
 * Builds the headless command of one client. Pure: it touches no process, no
 * clock and no file, so the exact flags of every client can be asserted.
 *
 * The briefing is the last positional argument and never part of a shell
 * string, which is why `spawn` takes an argument array.
 *
 * @param {'claude-code'|'codex'|'opencode'} client
 * @param {{briefing: string, profile?: {model: string, effort?: string},
 *   cwd?: string|null, permissionMode?: string, sandbox?: string}} options
 * @returns {{command: string, args: string[], env: Record<string, string>}}
 * @throws {TypeError} on an unknown client, an empty briefing or a bad option
 */
export function buildCommand(client, options = {}) {
  const build = typeof client === 'string' ? BUILDERS[client] : undefined;
  if (build === undefined) {
    throw new TypeError(`Unknown client ${JSON.stringify(client)}: expected ${CLIENTS.join(', ')}`);
  }

  const profile = options.profile;
  const effort = textOrNull(profile?.effort);
  const built = build({
    briefing: text(options.briefing, 'briefing'),
    model: text(profile?.model, 'profile.model'),
    effort,
    cwd: textOrNull(options.cwd),
    permissionMode: options.permissionMode ?? DEFAULT_PERMISSION_MODE,
    sandbox: options.sandbox,
  });
  return { ...built, env: { [NO_DAEMON_ENV]: '1' } };
}

// `appliesTo` names projects, not folders, so it is only used as a working
// directory when it happens to be a single absolute path that exists. Anything
// else — a project name, several projects, `global` — leaves the run in the
// directory the daemon itself was started from.
async function demandCwd(appliesTo, fallback) {
  const candidates = Array.isArray(appliesTo) ? appliesTo : [appliesTo];
  if (candidates.length !== 1) return fallback;
  const only = textOrNull(candidates[0]);
  if (only === null || !isAbsolute(only)) return fallback;
  try {
    return (await stat(only)).isDirectory() ? only : fallback;
  } catch {
    return fallback;
  }
}

/** The text the client is asked for: the title, then the body when there is one. */
function briefingOf(demand) {
  return [textOrNull(demand?.title), textOrNull(demand?.body)].filter(Boolean).join('\n\n');
}

const minutes = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);

// A run file that cannot be written on the first try is a run that never ends:
// Windows answers EPERM/EBUSY while it holds a handle on the file the record
// reads and the one the rename lands on, and a refusal that outlives every retry
// is reported and then forgotten, so the run stays `live` for good. The end of a
// run is retried instead, and the pause grows, so a refusal that is only a moment
// long costs the run nothing.
const TRANSIENT_CODES = new Set(['EPERM', 'EBUSY']);
export const RUN_FILE_ATTEMPTS = 8;
export const RUN_FILE_BACKOFF_MS = 10;
const STEP_RETRY_BUDGET_MS = RUN_FILE_BACKOFF_MS * RUN_FILE_ATTEMPTS * (RUN_FILE_ATTEMPTS - 1) / 2;
// read + outer write waits + each atomic writer's rename waits. The atomic
// writer in state.js uses the same eight-attempt, linear-backoff policy.
export const RUN_FILE_RETRY_BUDGET_MS = STEP_RETRY_BUDGET_MS * (RUN_FILE_ATTEMPTS + 2);

// Test seam: `transient(step, attempt)` returns the code Windows would answer for
// that attempt of the run file, or null. It is what makes the retry testable on
// any platform.
const NO_TRANSIENT = () => null;

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

async function attemptRunFile(step, transient, call) {
  for (let attempt = 1; ; attempt += 1) {
    const injected = transient(step, attempt);
    try {
      if (injected !== null) throw Object.assign(new Error(`${step} the run file: ${injected}`), { code: injected });
      return await call(attempt);
    } catch (error) {
      // state.js preserves the filesystem error as cause when an atomic
      // rename exhausts its retries; the wrapper itself has no code.
      const code = error.code ?? error.cause?.code;
      const retryable = TRANSIENT_CODES.has(code) && attempt < RUN_FILE_ATTEMPTS;
      if (!retryable) throw error;
      await sleep(RUN_FILE_BACKOFF_MS * attempt);
    }
  }
}

const runFile = (runs, runId) => join(runs, `${runId}.json`);

/**
 * A `PROCESS` spawner for the daemon core. It starts nothing the client can
 * fail at: `child_process.spawn` with an argument array and no shell, detached,
 * with both output streams going to `runs/<runId>.out`.
 *
 * `runs/<runId>.json` is the run file the cap already reads, so it is written
 * with `status: live` and numeric instants; on exit it gains `endedAt` and
 * `exitCode`, and a client that never started gains `status: failed` with the
 * `error` that stopped it. A `maxMinutes` timer sends the default `SIGTERM`
 * through `child.kill()`; the spawner never kills a run on its own.
 *
 * @param {{spawn?: Function, now?: () => number, logDir?: string,
 *   env?: object, cwd?: string, transient?: Function, faults?: Function}} [options]
 * @returns {(demand: object, opts: object) => Promise<{runId: string, pid: number|null, mode: string}>}
 */
export function makeSpawner({ spawn = child_process.spawn, now = Date.now, logDir, env = process.env, cwd, transient = NO_TRANSIENT, faults = NO_TRANSIENT } = {}) {
  const runs = logDir ?? paths(stateRoot()).runs;
  const fallbackCwd = cwd ?? process.cwd();

  return async function spawnDemand(demand, options = {}) {
    const runId = text(options.runId, 'runId');
    const dir = await demandCwd(demand?.appliesTo, fallbackCwd);
    const built = buildCommand(options.client, {
      briefing: briefingOf(demand),
      profile: options.profile,
      cwd: dir,
      permissionMode: options.profile?.permissionMode,
      sandbox: options.profile?.sandbox,
    });

    await mkdir(runs, { recursive: true });
    const out = await open(join(runs, `${runId}.out`), 'a');
    const child = spawn(built.command, built.args, {
      cwd: dir,
      env: { ...env, ...built.env },
      detached: true,
      stdio: ['ignore', out.fd, out.fd],
    });
    await out.close();

    const file = runFile(runs, runId);
    const startedAt = now();
    // A run file that cannot be written, read back or found again is one line
    // on stderr that names the file, never a mystery: the daemon's own error
    // handling is not the only reader, and on Windows the file can be
    // momentarily unreadable (EPERM/EBUSY) with no other trace of it.
    const reportRunFile = (error) => {
      process.stderr.write(`okit: run file ${file}: ${error.message}\n`);
    };

    try {
      await writeJsonAtomic(file, {
        runId, client: options.client, pid: child.pid ?? null, mode: 'PROCESS', status: 'live', startedAt,
      });
    } catch (error) {
      reportRunFile(error);
      throw error;
    }

    // A client that is not installed makes `spawn` emit `'error'`, and an
    // emitter with no listener throws: without this the daemon would die on the
    // first demand nobody can run. The clock stops with the process, whichever
    // way it ends, and a run file that cannot be written after that is a line on
    // stderr, never an exception the daemon dies of.
    let timer = null;
    const stopTimer = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const record = (patch) => {
      stopTimer();
      attemptRunFile('read', transient, () => readJson(file, null))
        .then((run) => {
          // A missing run file is a read that failed in the only way `readJson`
          // does not raise: the record below would carry the patch alone and
          // lose the client, the pid and the start of the run.
          if (run === null) reportRunFile(new Error('it was gone when the run ended'));
          return attemptRunFile('write', transient, (attempt) => {
            // Model state.js's exhausted rename at its public boundary, with
            // the original filesystem code preserved in cause (not code).
            const code = faults('rename', attempt);
            if (code !== null) {
              const cause = Object.assign(new Error(`rename: ${code}`), { code });
              throw new Error(`Cannot write ${file}: ${cause.message}`, { cause });
            }
            return writeJsonAtomic(file, { ...(run ?? {}), endedAt: now(), ...patch });
          });
        })
        .catch(reportRunFile);
    };

    child.on?.('error', (error) => record({ status: 'failed', error: error.message, exitCode: null }));
    child.on?.('exit', (code) => record({ status: 'done', exitCode: code ?? null }));

    const limit = minutes(options.maxMinutes);
    if (limit !== null) {
      timer = setTimeout(() => child.kill(), limit * 60_000);
      timer.unref?.();
    }
    // The run outlives the pass that started it, so nothing here may keep the
    // daemon's own event loop alive.
    child.unref?.();

    return { runId, pid: child.pid ?? null, mode: 'PROCESS' };
  };
}
