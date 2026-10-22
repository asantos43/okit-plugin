#!/usr/bin/env node
// The command line: `okit daemon ...` and `okit autostart ...`. Every side
// effect is a parameter, so a test drives the whole CLI without starting a
// client, a daemon or a `systemctl`.

import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { AUTOSTART_KINDS, applyAutostart, autostartPlan, detectAutostart } from './autostart.js';
import { daemonPause, daemonResume, daemonRun, daemonStatus, tick } from './daemon.js';
import { limitsStatus } from './limits.js';
import { orderList } from './orders.js';
import { DEFAULT_CONFIG } from './profiles.js';
import { makeSpawner } from './spawn-process.js';
import { adapterQuotaReader, clientsOf, LABELS, statusTable } from './status.js';
import { readJson, writeJsonAtomic } from './state.js';
import { paths, stateRoot } from './store.js';

const STOP_FILE = 'daemon.stop';
const DAEMON_ACTIONS = ['start', 'stop', 'status', 'pause', 'resume', 'run-once'];
const AUTOSTART_ACTIONS = ['install', 'uninstall', 'show'];

const USAGE = [
  'usage: okit daemon start|stop|status|pause|resume|run-once',
  '       okit autostart install|uninstall|show [--kind systemd|cron|launchd|schtasks]',
  '       okit status [--locale en|pt-BR]',
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
  return {
    ...DEFAULT_CONFIG,
    ...(stored ?? {}),
    limits: { ...DEFAULT_CONFIG.limits, ...(stored?.limits ?? {}) },
    profiles: { ...(stored?.profiles ?? {}) },
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

  const config = await readConfig(ctx.root);
  const table = await statusTable(ctx.root, {
    config,
    clients: clientsOf(config, ctx.clients),
    readQuota: ctx.readQuota ?? adapterQuotaReader({ stateRoot: ctx.root, env: ctx.env }),
    now: ctx.now,
    orders: ctx.orders ?? await orderList(ctx.root),
    limits: await limitsStatus(ctx.root, config),
    locale: locale ?? 'en',
    cache: ctx.quotaCache,
  });
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
  if (args.length > 0 || !DAEMON_ACTIONS.includes(action)) return ctx.unknown();

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
    const status = await daemonStatus(ctx.root, { now: ctx.now() });
    report(ctx.out, [
      `running: ${status.running}`,
      `pid: ${dash(status.pid)}`,
      `started: ${dash(status.startedAt)}`,
      `paused: ${status.paused}`,
      `last pass: ${describePass(status.lastTick)}`,
    ]);
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
 * Runs one `okit` invocation and returns its exit code: 0 for a command that
 * did its work, 2 for an unknown command, flag or argument, 1 when the work
 * itself failed. Output is one plain line per fact.
 *
 * @param {string[]} [argv] arguments without `node` and the script name
 * @param {{stdout?: Function, stderr?: Function, root?: string, env?: object,
 *   spawn?: Function, run?: Function, write?: Function, signal?: AbortSignal,
 *   sleep?: Function, now?: () => number, platform?: string, clients?: string[],
 *   readQuota?: Function, orders?: object[], quotaCache?: Map}} [io]
 * @returns {Promise<number>} exit code
 */
export async function main(argv = [], io = {}) {
  const out = io.stdout ?? ((text) => process.stdout.write(`${text}\n`));
  const err = io.stderr ?? ((text) => process.stderr.write(`${text}\n`));
  const now = io.now ?? Date.now;
  const ctx = {
    out,
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
    if (group === 'daemon') return await daemonCommand(ctx, action, args);
    if (group === 'autostart') return await autostartCommand(ctx, action, args);
    if (group === 'status') {
      // `okit status` takes no action, so the flag lands where one would be.
      return await statusCommand(ctx, action === undefined ? args : [action, ...args]);
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