#!/usr/bin/env node
// The command line of the plugin: the five commands the person runs (`install`, `update`,
// `uninstall`, `setup` and `doctor`) and the entry points the machine starts (the two hooks,
// the status line collector and the daemon loop). Everything else the plugin can do is a tool
// of the MCP server, the assistant's side of the work.
//
// Every side effect is a parameter, so a test drives the whole command line without starting
// a client, a daemon or a `systemctl`.

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const collectorEntry = process.argv[2] === 'statusline-collector';
const { applyAutostart, autostartPlan, detectAutostart } = collectorEntry
  ? {} : await import('./autostart.js');
const { run } = collectorEntry ? {} : await import('./core/operations.js');
const { daemonRun, daemonStatus } = collectorEntry
  ? {} : await import('./daemon.js');
import { DEFAULT_CONFIG } from './profiles.js';
const { CLIENTS, makeSpawner, runCommand } = collectorEntry ? {} : await import('./spawn-process.js');
import { readJson, writeJsonAtomic } from './state.js';
import { paths, stateRoot } from './store.js';
const { installerCommand } = collectorEntry ? {} : await import('./install/index.js');
const { createPresenter, localizeReason, redactingWriter, resolveLocale } = collectorEntry
  ? {} : await import('./install/present.js');
const { exitCodeFor, kindOf } = collectorEntry ? {} : await import('./install/exit.js');
const { installConfig } = collectorEntry ? {} : await import('./install/config.js');
const { setupAutostart } = collectorEntry ? {} : await import('./setup/autostart-step.js');
const { runSetup, setupReader, formatUnreadable, isReadableConfig } = collectorEntry
  ? {} : await import('./setup/setup.js');

const STOP_FILE = 'daemon.stop';
// The actions of the daemon the command line keeps: the loop the autostart unit and the
// installer start, the kill switch the installer's lifecycle writes, and the single pass the
// offline smoke checks run. The state of the daemon (whether it runs, whether it is paused)
// is the MCP tool `daemon`, the assistant's side.
const DAEMON_ACTIONS = ['start', 'stop', 'run-once'];

// The table of the commands the person runs. The internal entry points (the hooks, the
// collector and the daemon) are not in it: the user help lists what a person may type.
const USAGE_LINES = [
  'usage: {command} install [--from <dir>] [--client <c>|all] [--prerelease] [--repo <o/r>] [--dest <dir>] [--no-link] [--autostart] [--dry-run] [--yes] [--statusline|--no-statusline]',
  '       {command} update [--client <c>] [--check] [--rollback] [--dry-run] [--statusline|--no-statusline]',
  '       {command} uninstall [--client <c>] [--purge] [--yes] [--dry-run]',
  '       {command} setup [--defaults] [--again] [--locale en|pt-BR]',
  '       {command} doctor [--client <c>] [--verbose] [--locale en|pt-BR]',
].map((line) => (line.includes('--locale en|pt-BR') ? `${line} {default}` : line));

/**
 * The commands of the table above, read from it and not written again: one entry per group, with the actions it
 * names and those that take a value. A new line in the table is a new entry here, which is what the generated
 * test of the installer's output runs every command through.
 */
export const COMMANDS = (() => {
  const groups = new Map();
  for (const line of USAGE_LINES) {
    const match = /^(?:usage:|\s+)\s*\{command\} (\S+)(.*)$/.exec(line);
    if (!match) continue; // a continuation of the line above
    let rest = match[2].replace('{default}', '');
    const valued = [...rest.matchAll(/(?<![-\w])([a-z][a-z-]*) <[^>]*>/g)].map((found) => found[1]);
    for (let before = ''; before !== rest;) { before = rest; rest = rest.replace(/\[[^[\]]*\]|<[^>]*>/g, ''); }
    const words = rest.trim().split(/[\s|]+/).filter(Boolean);
    const actions = words.slice(0, words.findIndex((word) => word.startsWith('-')) < 0 ? undefined : words.findIndex((word) => word.startsWith('-')));
    for (const group of match[1].split('|')) {
      const entry = groups.get(group) ?? { group, actions: new Set(), valued: new Set() };
      for (const action of actions) entry.actions.add(action);
      for (const action of valued) entry.valued.add(action);
      groups.set(group, entry);
    }
  }
  return [...groups.values()].map((entry) => ({ group: entry.group, actions: [...entry.actions], valued: [...entry.valued] }));
})();

// The text around the command lines, once per language: the help of any command is built from here, after the
// language of the run is resolved, so it never carries both.
const USAGE_TEXT = {
  en: {
    head: 'usage:',
    default: (language) => `— default: language (${language})`,
    state: 'OKWORK_HOME names the state root.',
    language: 'Choose the language once: ask your assistant to call `config_set` with the key language.',
  },
  'pt-BR': {
    head: 'uso:',
    default: (language) => `— padrão: language (${language})`,
    state: 'OKWORK_HOME indica a pasta de estado.',
    language: 'Escolha o idioma uma vez: peça ao seu assistente para chamar `config_set` com a chave language.',
  },
};

/** The usage text of the program in one language (`locale` is the one `resolveLocale` chose). */
function usageOf(locale, command) {
  const words = USAGE_TEXT[locale] ?? USAGE_TEXT.en;
  const lines = USAGE_LINES.map((line) => line.replace('{default}', words.default(DEFAULT_CONFIG.language))
    .replace(/^usage:/, words.head)
    // The command lines are aligned under the first one: the heading is shorter in Portuguese.
    .replace(/^ {7}(?=\S)/, ' '.repeat(words.head.length + 1)));
  return [...lines, words.state, words.language].join('\n').replaceAll('{command}', command);
}


// The runner of a command is the one of `src/spawn-process.js`, shared with the
// probe of the kit, so a command behaves the same in both.
export { runCommand };

/**
 * The refusal of a command that is not the installer's own (`setup`, `doctor`) in the one language of the run, as
 * the installer says its refusals; the exit code is the usage one.
 */
function refuse(ctx, locale, reason) {
  const ui = createPresenter({ locale, write: ctx.out });
  ui.failure({ reason, next: ui.text('nextCheck') }).forEach((item) => ctx.err(item));
  return exitCodeFor('usage');
}

/**
 * The entry of the doctor: the language of the run is decided first (a valid `--locale`, then the environment, then
 * the saved language, then English), then the flags.
 *
 * The configuration is read leniently: a `config.json` that is not JSON, or settings of the installer that the
 * runtime refuses, do not stop the run. The doctor works with the defaults and its row of the configuration says
 * what is wrong, with the fix. A flag that is not known is still a refusal of usage (exit 2), and so is a `--locale`
 * that is not a language: a saved language that is not one is a row of the diagnosis, not a stop (the doctor is the
 * tool that says what is broken in the state of the person).
 *
 * @param {object} ctx the context of the command line
 * @param {string[]} flags the flags of the doctor
 * @returns {Promise<number>} the exit code
 */
async function doctorEntry(ctx, flags) {
  let stored = {};
  try { stored = await readJson(paths(ctx.root).config, {}); } catch { stored = {}; }
  const chosen = resolveLocale({ args: flags, env: ctx.env, saved: stored?.language });
  // The saved language is not a refusal: only a `--locale` that is not a language stops the doctor.
  const asked = resolveLocale({ args: flags, env: ctx.env });
  if (asked.invalid) return refuse(ctx, chosen.locale, 'Choose a language: en, pt-BR.');
  const parsed = doctorFlags(flags);
  if (parsed.unknown !== undefined) return refuse(ctx, chosen.locale, parsed.unknown);
  // The settings of the installer that the runtime refuses are not used: the doctor runs with the defaults and says
  // so in the row of the configuration.
  let config;
  try { config = installConfig(stored?.install); } catch { config = installConfig(); }
  const { doctorCommand } = await import('./doctor/command.js');
  return await doctorCommand(ctx, { locale: chosen.locale, config, verbose: parsed.found.verbose, client: parsed.found.client });
}

/**
 * The entry of `setup`: in the installer's order, read the configuration, decide the language with the installer's
 * one function (a valid --locale, then OKIT_LANGUAGE, then the saved language, then English), and only then read the
 * flags. `parse` reads them (`{ found }`, or `{ unknown }` with the reason it refuses a flag); `then` receives what
 * was read. A configuration that cannot be read is told in the language the flags and the environment give, because
 * the saved one cannot be known.
 */
async function enter(ctx, flags, parse, then) {
  const early = resolveLocale({ args: flags, env: ctx.env }).locale;
  let stored;
  try {
    stored = await readJson(paths(ctx.root).config, {});
  } catch {
    ctx.err(formatUnreadable(early, ctx.command));
    return exitCodeFor('operational');
  }
  const chosen = resolveLocale({ args: flags, env: ctx.env, saved: stored?.language });
  if (chosen.invalid) return refuse(ctx, chosen.locale, 'Choose a language: en, pt-BR.');
  const parsed = parse(flags);
  if (parsed.unknown !== undefined) return refuse(ctx, chosen.locale, parsed.unknown);
  // The installer's settings are read once, through the one schema, before any command works on them: an invalid
  // one is a refusal of usage (exit 2) that names the key and the rule, never a crash.
  const install = installConfig(stored?.install);
  return then({ stored, install, locale: chosen.locale, ...parsed });
}

/** Flags of `setup`: the booleans it knows, and `--locale <value>` (its value is read by `resolveLocale`). */
function flagsParser(known) {
  return (flags) => {
    const found = {};
    for (let index = 0; index < flags.length; index += 1) {
      if (flags[index] === '--locale') {
        if (flags[index + 1] === undefined || flags[index + 1].startsWith('--')) return { unknown: 'Missing value for --locale' };
        index += 1;
      } else if (known.includes(flags[index])) found[flags[index]] = true;
      else return { unknown: `Unknown flag: ${flags[index]}` };
    }
    return { found };
  };
}

async function setupCommand(ctx, flags, io) {
  return enter(ctx, flags, flagsParser(['--defaults', '--again']), (entry) => runSetupCommand(ctx, entry, io));
}

async function runSetupCommand(ctx, { stored, locale, found, install }, io) {
  const defaults = Boolean(found['--defaults']);
  const again = Boolean(found['--again']);
  // A configuration that cannot be read stops the command here: the same
  // simple sentence everywhere, the file untouched and nothing written.
  if (!isReadableConfig(stored)) {
    ctx.err(formatUnreadable(locale, ctx.command));
    return exitCodeFor('operational');
  }
  const reader = io.ask
    ? { ask: io.ask, close: () => {} }
    : setupReader({ stdin: io.stdin, output: io.output });
  try {
    const result = await runSetup({
      root: ctx.root,
      config: stored,
      env: ctx.env,
      run: ctx.run,
      ask: reader.ask,
      defaults,
      adapters: io.setupAdapters ?? io.adapters,
      write: ctx.writeConfig ?? ctx.write,
      locale,
      again,
      command: ctx.command,
    });
    for (const message of result.messages) ctx.out(message);
    if (!defaults && result.code === 0 && !result.cancelled) {
      return await setupAutostart(ctx, { config: install, locale, ask: reader.ask, plan: (record) => installationAutostartPlan(ctx, io, record) });
    }
    return result.code;
  } finally {
    reader.close();
  }
}

/** Flags of `doctor`: `--client <name>` or `--client=<name>`, `--verbose`, and `--locale <value>` (read by `resolveLocale`). */
function doctorFlags(flags) {
  const found = { verbose: false };
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === '--locale') {
      if (flags[index + 1] === undefined || flags[index + 1].startsWith('--')) return { unknown: 'Missing value for --locale' };
      index += 1;
    } else if (flag === '--verbose') found.verbose = true;
    else if (flag === '--client' || flag.startsWith('--client=')) {
      found.client = flag === '--client' ? flags[++index] ?? '' : flag.slice('--client='.length);
      if (!CLIENTS.includes(found.client)) return { unknown: `Unknown flag: ${flag}` };
    } else return { unknown: `Unknown flag: ${flag}` };
  }
  return { found };
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

/** One fact per line, in the order the caller listed them. */
function report(out, facts) {
  for (const fact of facts) out(`${fact}`);
}

/**
 * The daemon of the command line: the loop the autostart unit and the installer start, the kill switch the
 * installer's lifecycle writes, and the single pass the offline smoke checks run.
 */
async function daemonCommand(ctx, action, args) {
  if (!DAEMON_ACTIONS.includes(action) || args.length > 0) return ctx.unknown();

  if (action === 'stop') {
    const file = join(ctx.root, STOP_FILE);
    await writeJsonAtomic(file, { at: new Date(ctx.now()).toISOString() });
    ctx.out(`kill switch: ${file}`);
    return exitCodeFor('ok');
  }

  if (action === 'run-once') {
    const record = await run('daemon', ctx.root, { action }, { ...ctx });
    report(ctx.out, [
      `opened: ${record.opened.length}`,
      `spawned: ${record.spawned.length}`,
      `skipped: ${record.skipped.length}`,
    ]);
    for (const skip of record.skipped) ctx.out(`skipped ${skip.id}: ${skip.reason}`);
    return exitCodeFor('ok');
  }

  // The kill switch stops the loop on the next pass, so a switch left by
  // an earlier stop would stop this one before it did anything. The
  // pause file is left alone: pausing is a decision, not a leftover.
  if (await removeIfPresent(join(ctx.root, STOP_FILE))) ctx.out('cleared kill switch');

  const options = {};
  if (ctx.signal !== undefined) options.signal = ctx.signal;
  if (ctx.sleep !== undefined) options.sleep = ctx.sleep;
  const { passes } = await daemonRun(ctx.root, depsOf(ctx), options);
  ctx.out(`passes: ${passes}`);
  return exitCodeFor('ok');
}

function installationAutostartPlan(ctx, io, record) {
  return autostartPlan(detectAutostart(ctx.platform), {
    root: ctx.root, home: io.home ?? ctx.env.HOME ?? ctx.env.USERPROFILE,
    node: record.settings.node, script: join(record.path, record.bin), command: ctx.command,
  });
}

function installerLifecycle(ctx, io) {
  const autostart = io.autostart ?? ((record, action) => applyAutostart(installationAutostartPlan(ctx, io, record), { run: ctx.run, write: ctx.write, action }));
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

/** `--locale=pt-BR` as `--locale pt-BR`: resolveLocale reads the separate form only. */
const separateLocale = (args) => args.flatMap((arg) => (arg.startsWith('--locale=') ? ['--locale', arg.slice('--locale='.length)] : [arg]));

const HELP_FLAGS = ['--help', '-h'];
// The groups that answer the help flag wherever it comes: the commands of the person.
const HELPED_GROUPS = ['setup', 'install', 'update', 'uninstall', 'doctor'];

/** Whether the line asks for the help text: a help flag where a group or an action would be, or anywhere after a group of the table. */
function wantsHelp([group, action, ...rest]) {
  if (HELP_FLAGS.includes(group) || HELP_FLAGS.includes(action)) return true;
  return HELPED_GROUPS.includes(group) && rest.some((arg) => HELP_FLAGS.includes(arg));
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
  // The client's status bar launches this collector.
  if (argv[0] === 'statusline-collector') {
    const { launch } = await import('./launchers.js');
    return launch(argv, io);
  }
  // Every line of every command prints through one door that redacts (credentials, query and fragment of an
  // address), whoever writes it and whatever the command is, the usage text included. The commands that download
  // also hide the temporary folder; the others hide only a scratch folder the caller names, never the system one,
  // because the configuration folder they report is the user's own.
  const helped = wantsHelp(argv);
  const hidden = ['install', 'update', 'uninstall'].includes(argv[0]) ? [io.tmpdir ?? tmpdir()] : (io.tmpdir ? [io.tmpdir] : []);
  const door = (write) => redactingWriter(write, hidden);
  const out = door(io.stdout ?? ((text) => process.stdout.write(`${text}\n`)));
  const err = door(io.stderr ?? ((text) => process.stderr.write(`${text}\n`)));
  const now = io.now ?? Date.now;
  const ctx = {
    detectClients: io.detectClients, snapshot: io.snapshot,
    plugin: io.plugin, versions: io.versions,
    out,
    err,
    command: io.command ?? DEFAULT_CONFIG.install.command,
    env: io.env ?? process.env,
    home: io.home,
    root: io.root ?? stateRoot(io.env ?? process.env),
    platform: io.platform ?? process.platform,
    fs: io.fs ?? filesystem,
    spawn: io.spawn,
    run: io.run ?? runCommand,
    // The scratch folder of the caller: the doctor runs its own checks there, never in the system one.
    tmpdir: io.tmpdir,
    write: io.write,
    writeConfig: io.writeConfig,
    signal: io.signal,
    sleep: io.sleep,
    now,
    clients: io.clients,
    readQuota: io.readQuota,
    orders: io.orders,
    quotaCache: io.quotaCache,
    // The language of the run: the usage and the refusals of any command are written in it, never in both.
    locale: 'en',
    unknown() {
      err(usageOf(ctx.locale, ctx.command));
      return exitCodeFor('usage');
    },
  };

  const [group, action, ...args] = argv;
  try {
    const stored = await readJson(paths(ctx.root).config, {}).catch(() => null);
    // The name of the command in the messages: the configured one when the settings are valid (a refusal of the
    // settings is raised by the command that uses them, and says so under the default name).
    ctx.command = io.command ?? (() => { try { return installConfig(stored?.install).command; } catch { return DEFAULT_CONFIG.install.command; } })();
    const chosen = resolveLocale({ args: separateLocale(argv), env: ctx.env, saved: ctx.snapshot?.config?.language ?? stored?.language });
    ctx.locale = chosen.locale;
    // The help of any command is built here, after the language is decided and through the door.
    if (helped) {
      if (resolveLocale({ args: separateLocale(argv), env: ctx.env }).invalid) return refuse(ctx, chosen.locale, 'Choose a language: en, pt-BR.');
      out(usageOf(ctx.locale, ctx.command));
      return exitCodeFor('ok');
    }
    if (group === 'setup') {
      const flags = action === undefined ? args : [action, ...args];
      return await setupCommand(ctx, flags, io);
    }
    if (['install', 'update', 'uninstall'].includes(group)) {
      const flags = action === undefined ? args : [action, ...args];
      return await installerCommand(group, flags, ctx, {
        ...io, ...installerLifecycle(ctx, io),
      });
    }
    // The two hooks the client launches: the context of the session and the summary after a compaction.
    if (group === 'hook' && action === 'post-compact') {
      const { launch } = await import('./launchers.js');
      return await launch(argv, { ...io, root: ctx.root, env: ctx.env, stdout: out });
    }
    if (group === 'hook' && action === 'session-start') {
      const { launch } = await import('./launchers.js');
      return await launch(argv, { ...io, root: ctx.root, env: ctx.env, stdout: out });
    }
    // The daemon loop, the kill switch and the single pass: the machine and the installer start them.
    if (group === 'daemon') return await daemonCommand(ctx, action, args);
    if (group === 'doctor') {
      // The doctor takes no action, so its first flag lands where one would be.
      const flags = action === undefined ? args : [action, ...args];
      return await doctorEntry(ctx, separateLocale(flags));
    }
    return ctx.unknown();
  } catch (error) {
    // A configuration that could not be saved says its own simple sentence,
    // without the technical text of the system.
    if (error.plain) {
      err(error.message);
      return exitCodeFor(kindOf(error));
    }
    // The text of a refusal is in the language of the run (one catalog, `localizeReason`); the class of the
    // error, and only that, decides the exit code: usage and language are 2, anything else is operational.
    err(`${ctx.command ?? DEFAULT_CONFIG.install.command}: ${localizeReason(error.message, ctx.locale)}`);
    return exitCodeFor(kindOf(error));
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
    return await main(argv, { signal: controller.signal, ...io, command: io.command ?? (process.argv[1] && !/cli\.js$/.test(process.argv[1]) ? basename(process.argv[1]) : undefined) });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

const entry = fileURLToPath(import.meta.url);
// The command is a symlink to this file on POSIX: `import.meta.url` is the real path, `argv[1]` is the link, so compare real paths.
const invoked = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
if (process.argv[1] !== undefined && invoked(process.argv[1]) === entry) {
  // Let module evaluation finish before the smoke checks import this CLI again.
  runCli().then((code) => { process.exitCode = code; });
}
