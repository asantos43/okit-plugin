// The smoke runner of `docs/SMOKE.md`: the scratch home rule, the loop with a
// timeout per check and a cap for the run, `--only`, `--keep`, the `smoke` lock
// of the state root and the two artifacts of the result. Every side effect is a
// parameter of `io`, so `test/smoke-runner.test.js` runs all of it on any host
// without a client, a daemon or a `systemctl`.
//
// The order of the tables of `docs/SMOKE.md` is the order of the run: the
// install group, every feature end to end, then uninstall and idempotence. It is
// fixed, so two runs differ only in the run id.

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { arch as osArch, homedir, release as osRelease, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { FEATURE_CHECKS } from './smoke/checks-features.js';
import { INSTALL_CHECKS } from './smoke/checks-install.js';
import { UNINSTALL_CHECKS } from './smoke/checks-uninstall.js';
import { environmentOf, recordOf, runIdOf, writeArtifacts } from './smoke/report.js';
import { withLock } from './state.js';
import { paths, stateRoot } from './store.js';

// The order of the tables of `docs/SMOKE.md`: the install group, every feature
// end to end, then uninstall and idempotence. It is fixed, so two runs differ
// only in the run id. The three tables are read when a run starts and not at the
// top of this file: a check table calls `main()` of `src/cli.js`, which imports
// this runner, so the tables of a half-loaded graph are not ready yet.
function allChecks() {
  return [...INSTALL_CHECKS, ...FEATURE_CHECKS, ...UNINSTALL_CHECKS];
}

// The plugin root of the default mode is this checkout: the folder that holds
// `skills/` and `adapters/` beside the `src/` this file is in. An installed
// plugin is laid out the same way, so `okit smoke` through the installed bin
// verifies that install and not this one.
const PLUGIN_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

// The ceiling `--timeout` raises a slow host to, `60000`, and the cap of the
// whole run: a check that hangs is a `timeout` record, and the run still ends.
const DEFAULT_CHECK_TIMEOUT_MS = 60_000;
const RUN_CAP_MS = 600_000;

// The lock lives under the `locks/` folder of the state root, beside every other
// lock that root takes, so one root has one place its runs are recorded.
const LOCK_NAME = 'smoke';
const SCRATCH_PREFIX = 'okit-smoke-';

// The scratch home of `docs/SMOKE.md`: `<scratch>/home`, `<scratch>/project` and
// `<scratch>/tmp`, and an environment that names them and points HOME inside.
async function scratchScope(base, env) {
  const root = await mkdtemp(join(base, SCRATCH_PREFIX));
  const scope = {
    root,
    home: join(root, 'home'),
    projectRoot: join(root, 'project'),
    tmp: join(root, 'tmp'),
  };
  scope.stateRoot = join(scope.home, '.okwork');
  scope.configRoot = join(scope.home, '.claude');
  for (const folder of [scope.home, scope.projectRoot, scope.tmp]) await mkdir(folder, { recursive: true });

  scope.env = {
    ...env,
    HOME: scope.home,
    USERPROFILE: scope.home,
    OKWORK_HOME: scope.stateRoot,
    CLAUDE_CONFIG_DIR: scope.configRoot,
    XDG_CONFIG_HOME: scope.home,
    TMPDIR: scope.tmp,
    TEMP: scope.tmp,
    TMP: scope.tmp,
  };
  return scope;
}

// Under `--real` the run reads the user's own folders and writes nothing outside
// the state root: `OKWORK_HOME` else the real `~/.okwork`, `CLAUDE_CONFIG_DIR`
// else the real `~/.claude`. There is no scratch folder, so `--keep` has nothing
// to keep and no folder is taken away at the end.
function realScope(io, env) {
  const home = homedir();
  return {
    root: null,
    home,
    projectRoot: io.cwd ?? process.cwd(),
    tmp: io.tmpdir ?? tmpdir(),
    stateRoot: io.root ?? stateRoot(env),
    configRoot: env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'),
    env,
  };
}

// `--timeout 90000`, `--timeout=90000` or nothing. A value that is not a
// positive number is refused rather than guessed, since a run bounded by a guess
// is a run nobody can trust.
function readTimeout(value) {
  const ms = Number(value);
  if (value === undefined || value === null || !Number.isFinite(ms) || ms <= 0) {
    return { error: `--timeout needs a positive number of milliseconds, got ${JSON.stringify(value ?? null)}` };
  }
  return { timeoutMs: Math.floor(ms) };
}

/**
 * The flags of one `okit smoke`: `--real`, `--keep`, `--only <ids>` and
 * `--timeout <ms>`, the last two in both the spaced and the `=` form. Anything
 * else is an unknown flag, which is exit code 2.
 *
 * @returns {{real: boolean, keep: boolean, only: string[], timeoutMs: number, error?: string}}
 */
function readFlags(args) {
  const flags = { real: false, keep: false, only: [], timeoutMs: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--real') flags.real = true;
    else if (arg === '--keep') flags.keep = true;
    else if (arg === '--only' || arg.startsWith('--only=')) {
      const value = arg === '--only' ? args[index + 1] : arg.slice('--only='.length);
      if (arg === '--only') index += 1;
      const ids = typeof value === 'string' ? value.split(',').map((id) => id.trim()).filter((id) => id !== '') : [];
      if (ids.length === 0) return { ...flags, error: `--only needs at least one check id or group, got ${JSON.stringify(value ?? null)}` };
      flags.only.push(...ids.map((id) => id.toUpperCase()));
    } else if (arg === '--timeout' || arg.startsWith('--timeout=')) {
      const value = arg === '--timeout' ? args[index + 1] : arg.slice('--timeout='.length);
      if (arg === '--timeout') index += 1;
      const read = readTimeout(value);
      if (read.error !== undefined) return { ...flags, error: read.error };
      flags.timeoutMs = read.timeoutMs;
    } else return { ...flags, error: `unknown flag ${arg}` };
  }
  return flags;
}

/**
 * The selected checks, in table order. `--only` takes ids and group letters, so
 * `--only I,E7` is the install group plus `E7`; an id that names no check of the
 * run is refused, since silently running nothing is the one answer a smoke run
 * must never give.
 */
function selectChecks(checks, only) {
  if (only.length === 0) return { checks };
  const wanted = new Set(only);
  const picked = checks.filter((check) => wanted.has(check.id.toUpperCase()) || wanted.has(check.group.toUpperCase()));
  const unknown = [...wanted].filter((id) => !picked.some((check) => check.id.toUpperCase() === id || check.group.toUpperCase() === id));
  if (unknown.length > 0) return { error: `unknown check ${unknown.map((id) => JSON.stringify(id)).join(', ')}` };
  return { checks: picked };
}

// The children a run fakes, and the `exit` each one still owes its run file.
// `makeSpawner` marks a run `done` only when its child says it ended, and a
// smoke child never ends on its own: it is answered at the end of the check that
// started it, through the spawner's own bookkeeping, so the cap of the next
// check counts no run of the previous one. Nothing is ever started: the child
// answers the three things the spawner reads of a process — a pid, a `kill` and
// an emitter — which is what keeps `okit smoke` from running `claude`, `codex`
// or `opencode` on the machine it verifies.
function fakeSpawner() {
  const children = [];
  const spawn = () => {
    const handlers = { exit: [], error: [] };
    children.push({ async end() { for (const handler of handlers.exit) await handler(0); } });
    return {
      pid: process.pid,
      kill: () => true,
      unref() {},
      on(event, handler) {
        if (handlers[event] !== undefined) handlers[event].push(handler);
        return this;
      },
    };
  };

  return {
    spawn,
    async end() {
      const owed = children.splice(0, children.length);
      for (const child of owed) await child.end();
    },
  };
}

// The same for the command runner: an `autostart` check must prove the exit
// codes and the reported commands of a plan, and a real `systemctl` or `crontab`
// would change the machine instead of the scratch home.
const fakeRun = async (command, args = []) => ({ command, args, stdout: '', stderr: '' });

const realSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Everything a check reads, and everything a record reports: the scratch scope,
 * the environment, the clock and the injected spawn, run and sleep. `runChecks`
 * is the runner itself, which the two idempotence checks call to run a whole
 * group twice on a root of their own.
 */
function depsOf(io, scope, control) {
  return {
    ...scope,
    // `root` is the plugin the checks read (`src/`, `adapters/`, `skills/`),
    // which is the checkout, not the scratch folder `scope.root` names.
    root: io.pluginRoot ?? PLUGIN_ROOT,
    now: io.now ?? Date.now,
    platform: io.platform ?? process.platform,
    release: io.release ?? osRelease(),
    arch: io.arch ?? osArch(),
    nodeVersion: io.nodeVersion ?? process.version,
    cwd: io.cwd ?? process.cwd(),
    pluginRoot: io.pluginRoot ?? PLUGIN_ROOT,
    pid: io.pid ?? process.pid,
    spawn: io.spawn ?? control.spawn,
    run: io.run ?? fakeRun,
    sleep: io.sleep ?? realSleep,
    signal: control.signal,
    end: control.end,
    runChecks: (checks, other) => runChecks(checks, other, control),
  };
}

// `--timeout <ms>` raises the ceiling of a check and never lowers the one it
// carries: a check that needs 30 s on a slow Windows host keeps its 30 s under a
// smaller flag, and only a check under the flag gets the flag. Without the flag
// every check runs under the timeout its table gives it.
const underCeiling = (check, ceiling) => ({
  ...check,
  timeoutMs: ceiling === null
    ? (check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS)
    : Math.max(check.timeoutMs, ceiling),
});

/**
 * One check under its timeout: a body that resolves is a `pass`, one that throws
 * is a `fail` carrying the error, and one that outlasts the timer is a `timeout`.
 * The timer is always cleared, and a body that rejects after the race is over
 * cannot take the run down with it.
 */
async function runCheck(under, deps, control) {
  const { timeoutMs } = under;
  const startedAt = control.now();
  let expired = false;
  let timer = null;
  const over = new Promise((_, refuse) => {
    timer = setTimeout(() => {
      expired = true;
      refuse(new Error(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  const body = Promise.resolve().then(() => under.run(deps));
  body.catch(() => {});
  // `Ctrl-C` is one more way for the race to end, and the record it leaves is a
  // `timeout`: the check did not finish, and the artifacts say why.
  const halted = control.halted.then(() => {
    throw Object.assign(new Error('interrupted by SIGINT'), { interrupted: true });
  });

  try {
    await Promise.race([body, over, halted]);
    return recordOf(under, { status: 'pass', durationMs: control.now() - startedAt }, deps);
  } catch (error) {
    const status = expired === true || error?.interrupted === true ? 'timeout' : 'fail';
    return recordOf(under, { status, durationMs: control.now() - startedAt, error }, deps);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The selected checks in order, one at a time. A run that is interrupted stops
 * here and keeps what it has; a run that passes the ten minute cap reports the
 * checks it never reached as `timeout`, so the artifacts say why the list ended.
 */
async function runChecks(checks, deps, control) {
  const records = [];
  for (const check of checks) {
    if (control.interrupted) break;
    const ceiling = underCeiling(check, control.timeoutMs).timeoutMs;
    const left = control.deadline - control.now();
    if (left <= 0) {
      records.push(recordOf(underCeiling(check, 0), {
        status: 'timeout',
        durationMs: 0,
        error: new Error(`the run passed its ${RUN_CAP_MS} ms cap before this check`),
      }, deps));
      continue;
    }
    records.push(await runCheck(underCeiling(check, Math.min(ceiling, left)), deps, control));
    // The faked children of this check end with it, so the run files they left
    // read as `done` and the next check starts from the state it expects.
    await control.end();
  }
  return records;
}

// Exit code 2: the run never started. The line on stderr names what was wrong,
// and `usage` tells the CLI to add the usage text to it.
function refusal(err, message, usage = true) {
  err(`okit smoke: ${message}`);
  return { code: 2, usage, records: [], artifacts: null, runId: null };
}

/**
 * The stdout of a run: one fact per line, the shape `report()` of `src/cli.js`
 * prints. The artifact paths come last, and the scratch path only under `--keep`
 * or after a `Ctrl-C`, since a run nobody can open again is a run nobody debugs.
 */
function report(out, runId, records, artifacts, extra) {
  const count = (status) => records.filter((record) => record.status === status).length;
  out('okit smoke');
  out(`run: ${runId}`);
  for (const record of records) out(`${record.status} ${record.id} ${record.name} ${record.durationMs}ms`);
  if (extra.interrupted) out('interrupted: SIGINT');
  out(`passed: ${count('pass')} failed: ${count('fail') + count('timeout')} skipped: ${count('skip')}`);
  out(artifacts.jsonl);
  out(artifacts.log);
  if (extra.keep && extra.scratch !== null) out(`scratch: ${extra.scratch}`);
}

/**
 * Runs one `okit smoke` and answers its exit code, its records and the paths of
 * the two artifacts it wrote.
 *
 * `io` is the shape `main()` of `src/cli.js` already takes (`out`, `err`,
 * `root`, `env`, `spawn`, `run`, `platform`, `now`) plus `tmpdir`, `sleep`,
 * `signals` and `checks`, the last two being the seams a test drives the clock
 * of the process and the content of the tables through.
 *
 * @param {string[]} [argv] the flags of the run
 * @param {object} [io] the parameters above
 * @returns {Promise<{code: number, records: object[], artifacts: object|null, usage?: boolean, runId: string|null}>}
 */
export async function runSmoke(argv = [], io = {}) {
  const out = io.out ?? io.stdout ?? ((text) => process.stdout.write(`${text}\n`));
  const err = io.err ?? io.stderr ?? ((text) => process.stderr.write(`${text}\n`));
  const env = io.env ?? process.env;
  const now = io.now ?? Date.now;

  const flags = readFlags(argv);
  if (flags.error !== undefined) return refusal(err, flags.error);
  // `OKWORK_HOME` in the environment is a state root the user chose. A run that
  // builds a scratch home must not be read as one, so it has to say `--real`.
  if (!flags.real && typeof env.OKWORK_HOME === 'string' && env.OKWORK_HOME.trim() !== '') {
    return refusal(err, 'OKWORK_HOME is set; okit smoke uses a scratch home unless --real is given', false);
  }

  const selection = selectChecks(io.checks ?? allChecks(), flags.only);
  if (selection.error !== undefined) return refusal(err, selection.error);

  const scope = flags.real ? realScope(io, env) : await scratchScope(io.tmpdir ?? tmpdir(), env);
  const startedAt = now();
  const runId = runIdOf(startedAt, io.pid ?? process.pid);

  // The interrupt the run ends on: the handler the runner installs and removes
  // itself, so a test drives it through an emitter and `Ctrl-C` through the
  // process. Both stop the loop, write what is already a record and answer 1.
  let interrupted = false;
  let halt = () => {};
  const halted = new Promise((resolve) => { halt = resolve; });
  const controller = new AbortController();
  const signals = io.signals ?? process;
  const onInterrupt = () => {
    interrupted = true;
    controller.abort();
    halt();
  };
  signals.once('SIGINT', onInterrupt);

  const control = {
    now,
    timeoutMs: flags.timeoutMs,
    deadline: startedAt + RUN_CAP_MS,
    signal: controller.signal,
    halted,
    ...fakeSpawner(),
    get interrupted() { return interrupted; },
  };
  const deps = depsOf(io, scope, control);
  const locks = paths(scope.stateRoot).locks;
  let records = [];

  try {
    // The lock of this state root, so two runs cannot write one set of
    // artifacts over the other or fight over the same scratch home.
    await mkdir(locks, { recursive: true });
    records = await withLock(join(locks, LOCK_NAME), () => runChecks(selection.checks, deps, control));
  } finally {
    signals.off('SIGINT', onInterrupt);
  }

  const header = {
    kind: 'smoke',
    runId,
    startedAt,
    finishedAt: now(),
    real: flags.real,
    only: flags.only,
    interrupted,
    environment: environmentOf(deps),
  };
  const artifacts = await writeArtifacts(scope.stateRoot, runId, header, records, deps);
  const keep = flags.keep || interrupted;
  report(out, runId, records, artifacts, { keep, scratch: scope.root, interrupted });

  if (scope.root !== null && !keep) await rm(scope.root, { recursive: true, force: true });
  const failed = records.some((record) => record.status === 'fail' || record.status === 'timeout');
  return { code: failed || interrupted ? 1 : 0, records, artifacts, runId };
}