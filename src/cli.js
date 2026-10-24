#!/usr/bin/env node
// The command line: `okit daemon ...` and `okit autostart ...`. Every side
// effect is a parameter, so a test drives the whole CLI without starting a
// client, a daemon or a `systemctl`.

import { execFile, spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { AUTOSTART_KINDS, applyAutostart, autostartPlan, detectAutostart } from './autostart.js';
import { daemonPause, daemonResume, daemonRun, daemonStatus, tick } from './daemon.js';
import { limitsStatus } from './limits.js';
import { runPostCompact } from './hook-post-compact.js';
import { orderList } from './orders.js';
import { configOf } from './profiles.js';
import { runSmoke } from './smoke.js';
import { runClientSmoke } from './smoke/client.js';
import { makeSpawner } from './spawn-process.js';
import { adapterQuotaReader, clientsOf, LABELS, statusTable } from './status.js';
import { readJson, writeJsonAtomic } from './state.js';
import { paths, stateRoot } from './store.js';
import { installerCommand } from './install/index.js';

const STOP_FILE = 'daemon.stop';
const DAEMON_ACTIONS = ['start', 'stop', 'status', 'pause', 'resume', 'run-once'];
const AUTOSTART_ACTIONS = ['install', 'uninstall', 'show'];

const USAGE = [
  'usage: okit daemon start|stop|status|pause|resume|run-once',
  '       okit install [--from <dir>] [--client <c>|all] [--prerelease] [--repo <o/r>] [--dest <dir>] [--no-link] [--autostart] [--dry-run] [--yes]',
  '       okit update [--client <c>] [--check] [--rollback] [--dry-run]',
  '       okit uninstall [--client <c>] [--purge] [--yes] [--dry-run]',
  '       okit daemon status [--table [--locale en|pt-BR]]',
  '       okit autostart install|uninstall|show [--kind systemd|cron|launchd|schtasks]',
  '       okit status [--locale en|pt-BR]',
  '       okit hook post-compact',
  '       okit smoke [--real] [--keep] [--only <ids>] [--timeout <ms>]',
  '       okit client-smoke [--client claude-code] [--headless|--demo|--dry-run|--rehearsal]',
  '         [--only <C ids>] [--keep] [--allow-unknown-quota]',
  '         [--max-usd [n]] [--max-turns [n]] [--max-minutes [n]] [--quota-floor [pct]] [--timeout [ms]]',
  `OKWORK_HOME names the state root; --kind defaults to ${AUTOSTART_KINDS.join(', ')} by platform.`,
].join('\n');

const execFileAsync = promisify(execFile);

/** Runs one command object: an argument array and no shell, like every spawn. */
async function runCommand({ command, args = [] }) {
  const { stdout, stderr } = await execFileAsync(command, args, { windowsHide: true });
  return { command, args, stdout, stderr };
}

/** `--kind systemd`, `--kind=systemd` or nothing; an unknown flag is refused. */
function readKind(args) {
  const rest = [];
  let kind = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--kind') {
      kind = args[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith('--kind=')) kind = arg.slice('--kind='.length);
    else rest.push(arg);
  }
  return { kind, rest };
}

/** `--locale pt-BR`, `--locale=pt-BR` or nothing, which is `en`. */
function readLocale(args) {
  const rest = [];
  let locale = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--locale') {
      locale = args[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith('--locale=')) locale = arg.slice('--locale='.length);
    else rest.push(arg);
  }
  return { locale, rest };
}

/** `--table` is a switch, not a value: `--table=true` is not a form of it. */
function readTable(args) {
  const rest = [];
  let table = false;
  for (const arg of args) {
    if (arg === '--table') table = true;
    else rest.push(arg);
  }
  return { table, rest };
}

/** One fact per line, in the order the caller listed them. */
function report(out, facts) {
  for (const fact of facts) out(`${fact}`);
}

const dash = (value) => (value === null || value === undefined ? '-' : String(value));

function showPlan(out, plan) {
  report(out, [`kind: ${plan.kind}`, `path: ${dash(plan.path)}`, 'content:']);
  report(out, plan.content.replace(/\n$/, '').split('\n'));
  for (const action of ['install', 'uninstall']) {
    for (const { command, args } of plan[action]) out(`${action}: ${[command, ...args].join(' ')}`);
  }
}

async function autostartCommand(ctx, action, args) {
  const { kind, rest } = readKind(args);
  if (!AUTOSTART_ACTIONS.includes(action) || rest.length > 0
    || (kind !== null && !AUTOSTART_KINDS.includes(kind))) return ctx.unknown();
  const plan = autostartPlan(kind ?? detectAutostart(ctx.platform), { root: ctx.root });

  if (action === 'show') {
    showPlan(ctx.out, plan);
    return 0;
  }
  const result = await applyAutostart(plan, {
    action,
    run: ctx.run,
    write: ctx.write,
  });
  report(ctx.out, [
    `${action}: ${result.ran.length} commands`,
    dash(result.wrote) === '-' ? 'no file written' : `wrote: ${result.wrote}`,
  ]);
  return 0;
}

/** The settings of this root: `config.json` over `DEFAULT_CONFIG`. */
async function readConfig(root) {
  const stored = await readJson(paths(root).config, {});
  return configOf(stored);
}

/**
 * The `statusTable` deps of one command: the settings of this root, the clients
 * they name, the readings through each client's adapter, the standing orders and
 * the cap counts. `okit status` and `okit daemon status --table` share it, so the
 * table under the daemon lines is the same table of `okit status`.
 */
async function tableDeps(ctx, locale) {
  const config = await readConfig(ctx.root);
  return {
    config,
    clients: clientsOf(config, ctx.clients),
    readQuota: ctx.readQuota ?? adapterQuotaReader({ stateRoot: ctx.root, env: ctx.env }),
    now: ctx.now,
    orders: ctx.orders ?? await orderList(ctx.root),
    limits: await limitsStatus(ctx.root, config),
    locale,
    cache: ctx.quotaCache,
  };
}

/**
 * `okit status`: the quota table and the capacity line under it. The readings
 * come from each client's adapter, the counts from the runs on disk, and both
 * are the same functions the daemon and the MCP tool use.
 */
async function statusCommand(ctx, args) {
  const { locale, rest } = readLocale(args);
  if (rest.length > 0 || (locale !== null && !Object.hasOwn(LABELS, locale))) return ctx.unknown();

  const table = await statusTable(ctx.root, await tableDeps(ctx, locale ?? 'en'));
  for (const line of table.markdown.split('\n')) ctx.out(line);
  ctx.out(table.capacityLine);
  return 0;
}

// The daemon half runs with the process spawner, so a headless pass starts the
// clients themselves; an injected spawner replaces it in a test.
function depsOf(ctx) {
  return { spawn: ctx.spawn ?? makeSpawner({ logDir: paths(ctx.root).runs, now: ctx.now }) };
}

/** Removes a file and says whether it was there; `ENOENT` is not an error. */
async function removeIfPresent(file) {
  try {
    await rm(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function describePass(record) {
  if (record === null || record === undefined) return '-';
  return `${record.at} opened ${record.opened.length} spawned ${record.spawned.length} skipped ${record.skipped.length}`;
}

async function daemonCommand(ctx, action, args) {
  if (!DAEMON_ACTIONS.includes(action) || (args.length > 0 && action !== 'status')) {
    return ctx.unknown();
  }

  if (action === 'stop') {
    const file = join(ctx.root, STOP_FILE);
    await writeJsonAtomic(file, { at: new Date(ctx.now()).toISOString() });
    ctx.out(`kill switch: ${file}`);
    return 0;
  }

  if (action === 'pause' || action === 'resume') {
    const paused = action === 'pause' ? await daemonPause(ctx.root) : await daemonResume(ctx.root);
    ctx.out(`paused: ${paused.paused}`);
    return 0;
  }

  if (action === 'status') {
    // `--locale` alone is a refusal: it names a table, so it needs `--table`, and
    // an unknown language is refused the same way `okit status` refuses it.
    const { locale, rest: withoutLocale } = readLocale(args);
    const { table, rest } = readTable(withoutLocale);
    if (rest.length > 0 || (locale !== null && (table === false || !Object.hasOwn(LABELS, locale)))) {
      return ctx.unknown();
    }

    const options = { now: ctx.now() };
    if (table) options.table = await tableDeps(ctx, locale ?? 'en');
    const status = await daemonStatus(ctx.root, options);
    report(ctx.out, [
      `running: ${status.running}`,
      `pid: ${dash(status.pid)}`,
      `started: ${dash(status.startedAt)}`,
      `paused: ${status.paused}`,
      `last pass: ${describePass(status.lastTick)}`,
    ]);
    // The table only exists when it was asked for, so the default output is the
    // one it has always been.
    if (status.table !== undefined) {
      ctx.out('');
      for (const line of status.table.markdown.split('\n')) ctx.out(line);
      ctx.out(status.table.capacityLine);
    }
    return 0;
  }

  if (action === 'run-once') {
    const record = await tick(ctx.root, depsOf(ctx));
    report(ctx.out, [
      `opened: ${record.opened.length}`,
      `spawned: ${record.spawned.length}`,
      `skipped: ${record.skipped.length}`,
    ]);
    for (const skip of record.skipped) ctx.out(`skipped ${skip.id}: ${skip.reason}`);
    return 0;
  }

  // The kill switch stops the loop on the next pass, so a switch left by an
  // earlier `okit daemon stop` would stop this one before it did anything. The
  // pause file is left alone: pausing is a decision, not a leftover.
  if (await removeIfPresent(join(ctx.root, STOP_FILE))) ctx.out('cleared kill switch');

  const options = {};
  if (ctx.signal !== undefined) options.signal = ctx.signal;
  if (ctx.sleep !== undefined) options.sleep = ctx.sleep;
  const { passes } = await daemonRun(ctx.root, depsOf(ctx), options);
  ctx.out(`passes: ${passes}`);
  return 0;
}

/**
 * `okit smoke`: the runner of `docs/SMOKE.md` on a scratch home, which prints
 * its own facts and answers 0, 1 or 2. The process defaults of `main` do not
 * reach it: a smoke run must never start a client or run a `systemctl` on the
 * machine it verifies, so `run` and `spawn` arrive only when a caller injected
 * them, and the runner answers with its own stub otherwise.
 */
async function smokeCommand(ctx, args, io) {
  const smoke = await runSmoke(args, { ...ctx, run: io.run, spawn: io.spawn });
  // A flag or an `--only` id the runner refuses is a usage error, so the usage
  // text goes with it exactly as it goes with an unknown group.
  return smoke.usage === true ? ctx.unknown() : smoke.code;
}

function installerLifecycle(ctx, io) {
  const plan = (record) => autostartPlan(detectAutostart(ctx.platform), {
    root: ctx.root, home: io.home ?? ctx.env.HOME ?? ctx.env.USERPROFILE,
    node: record.settings.node, script: join(record.path, record.bin),
  });
  const autostart = io.autostart ?? ((record, action) => applyAutostart(plan(record), { run: ctx.run, write: ctx.write, action }));
  return {
    autostart,
    stopDaemon: io.stopDaemon ?? (async (record) => {
      const status = await daemonStatus(ctx.root);
      if (record.autostart) await autostart(record, 'uninstall');
      if (!status.running) return false;
      await daemonCommand(ctx, 'stop', []);
      const until = ctx.now() + record.settings.timeoutMs;
      while ((await daemonStatus(ctx.root)).running) {
        if (ctx.now() >= until) throw new Error('Daemon did not stop before timeout; installation retained');
        await (ctx.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(record.settings.daemonPollMs);
      }
      return true;
    }),
    startDaemon: io.startDaemon ?? (async (record) => {
      const child = spawn(record.settings.node, [join(record.path, record.bin), 'daemon', 'start'], {
        detached: true, stdio: 'ignore', env: { ...ctx.env, OKWORK_HOME: ctx.root },
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
    }),
  };
}

/**
 * Runs one `okit` invocation and returns its exit code: 0 for a command that
 * did its work, 2 for an unknown command, flag or argument, 1 when the work
 * itself failed. Output is one plain line per fact.
 *
 * @param {string[]} [argv] arguments without `node` and the script name
 * @param {{stdout?: Function, stderr?: Function, root?: string, env?: object,
 *   spawn?: Function, run?: Function, write?: Function, signal?: AbortSignal,
 *   sleep?: Function, now?: () => number, platform?: string, clients?: string[],
 *   readQuota?: Function, orders?: object[], quotaCache?: Map,
 *   tmpdir?: string, signals?: object, checks?: object[]}} [io]
 * @returns {Promise<number>} exit code
 */
export async function main(argv = [], io = {}) {
  const out = io.stdout ?? ((text) => process.stdout.write(`${text}\n`));
  const err = io.stderr ?? ((text) => process.stderr.write(`${text}\n`));
  const now = io.now ?? Date.now;
  const ctx = {
    out,
    err,
    env: io.env ?? process.env,
    root: io.root ?? stateRoot(io.env ?? process.env),
    platform: io.platform ?? process.platform,
    spawn: io.spawn,
    run: io.run ?? runCommand,
    write: io.write,
    signal: io.signal,
    sleep: io.sleep,
    now,
    clients: io.clients,
    readQuota: io.readQuota,
    orders: io.orders,
    quotaCache: io.quotaCache,
    unknown() {
      err(USAGE);
      return 2;
    },
  };

  const [group, action, ...args] = argv;
  try {
    if (['install', 'update', 'uninstall'].includes(group)) {
      const flags = action === undefined ? args : [action, ...args];
      return await installerCommand(group, flags, ctx, {
        ...io, ...installerLifecycle(ctx, io),
      });
    }
    if (group === 'hook' && action === 'post-compact') {
      return await runPostCompact({ root: ctx.root, stdin: io.stdin, stdout: out });
    }
    if (group === 'daemon') return await daemonCommand(ctx, action, args);
    if (group === 'autostart') return await autostartCommand(ctx, action, args);
    if (group === 'status') {
      // `okit status` takes no action, so the flag lands where one would be.
      return await statusCommand(ctx, action === undefined ? args : [action, ...args]);
    }
    // `okit smoke` takes no action either, so its first flag lands where one would be.
    if (group === 'smoke') return await smokeCommand(ctx, action === undefined ? args : [action, ...args], io);
    if (group === 'client-smoke') {
      const flags = action === undefined ? args : [action, ...args];
      if (flags.length === 1 && ['--help', '-h'].includes(flags[0])) { out(USAGE); return 0; }
      return (await runClientSmoke(flags, { ...ctx, ...io, run: io.run, out, err })).code;
    }
    return ctx.unknown();
  } catch (error) {
    err(`okit: ${error.message}`);
    return 1;
  }
}

/**
 * The `okit` entry point: wires the process signals to an `AbortSignal` the
 * daemon loop leaves on, then runs the command and sets the exit code.
 *
 * @param {string[]} [argv]
 * @param {object} [io] the same parameters `main` takes
 * @returns {Promise<number>} exit code
 */
export async function runCli(argv = process.argv.slice(2), io = {}) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    return await main(argv, { signal: controller.signal, ...io });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

const entry = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === entry) {
  process.exitCode = await runCli();
}
