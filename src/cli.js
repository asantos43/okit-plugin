#!/usr/bin/env node
// The command line: `okit-plugin daemon ...` and `okit-plugin autostart ...`. Every side
// effect is a parameter, so a test drives the whole CLI without starting a
// client, a daemon or a `systemctl`.

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { join, resolve, basename } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const collectorEntry = process.argv[2] === 'statusline-collector';
const { AUTOSTART_KINDS, applyAutostart, autostartPlan, detectAutostart } = collectorEntry
  ? {} : await import('./autostart.js');
const { configCommand } = collectorEntry ? {} : await import('./config.js');
const { run } = collectorEntry ? {} : await import('./core/operations.js');
const { todoRun } = collectorEntry ? {} : await import('./todo/index.js');
const { daemonRun, daemonStatus } = collectorEntry
  ? {} : await import('./daemon.js');
const { limitsStatus } = collectorEntry ? {} : await import('./limits.js');
const { inboxClaim, inboxRelease, inboxProducerTakeover, inboxList, holdText, holdIsStale } = collectorEntry
  ? {} : await import('./inbox.js');
const { orderList } = collectorEntry ? {} : await import('./orders.js');
import { configOf, DEFAULT_CONFIG, localeOf } from './profiles.js';
const { listActors, formatActors } = collectorEntry ? {} : await import('./actors.js');
const { environmentReport, formatEnvironmentReport } = collectorEntry
  ? {} : await import('./env/report.js');
const { CLIENTS, makeSpawner, runCommand } = collectorEntry ? {} : await import('./spawn-process.js');
const { adapterQuotaReader, clientsOf, LABELS, quotaOrigin, setupPendingLine, statusTable } = collectorEntry
  ? {} : await import('./status.js');
import { readJson, writeJsonAtomic } from './state.js';
import { paths, stateRoot } from './store.js';
import { Refusal } from './core/refusal.js';
const { installerCommand, kitLine, recordIgnoredLines } = collectorEntry ? {} : await import('./install/index.js');
const { createPresenter, localizeReason, redactingWriter, resolveLocale } = collectorEntry ? {} : await import('./install/present.js');
const { exitCodeFor, kindOf } = collectorEntry ? {} : await import('./install/exit.js');
const { installConfig, installPaths } = collectorEntry ? {} : await import('./install/config.js');
const { detectKit } = collectorEntry ? {} : await import('./install/kit.js');
const { activationWarning } = collectorEntry ? {} : await import('./install/link.js');
const { readRecords } = collectorEntry ? {} : await import('./install/place.js');
const { runSetup, setupReader, formatUnreadable, isReadableConfig } = collectorEntry
  ? {} : await import('./setup/setup.js');

async function confirmTake(io, out) {
  const input = io.stdin ?? process.stdin;
  if (!input.isTTY) throw new Error('confirmation requires TTY or --yes');
  out('Transfer ownership? [y/N] / Transferir posse? [s/N]');
  if (io.confirm) return io.confirm();
  const reader = createInterface({ input, output: io.output ?? process.stdout });
  try { return /^(y|yes|s|sim)$/i.test((await reader.question('> ')).trim()); }
  finally { reader.close(); }
}

async function showHoldSituation(ctx, item, config) {
  const h = item.hold;
  ctx.out(`Situation / Situação: ${item.id}`);
  ctx.out(`owner / dono: ${holdText(item, config)}`);
  ctx.out(`client / cliente: ${h?.client ?? '-'}; session / sessão: ${h?.session ?? '-'}; worktree: ${h?.worktree ?? '-'}; since / desde: ${h?.takenAt ?? '-'}; stale / obsoleta: ${holdIsStale(h, config)}`);
  if (h?.worktree) {
    try { await stat(h.worktree); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    try {
      const result = await ctx.run({ command: 'git', args: ['status', '--porcelain'], cwd: h.worktree, timeout: config.inbox.gitTimeoutMs });
      if (typeof result.stdout !== 'string' || (result.code ?? result.exitCode ?? 0) !== 0) throw new Error('git status failed');
      ctx.out(`uncommitted changes / mudanças não commitadas: ${result.stdout.trim() ? 'yes / sim' : 'no / não'}`);
    } catch (error) { ctx.out(`worktree status unknown / desconhecido: ${error.message}`); }
  }
}

async function todoCommand(ctx, action, args) {
  if (!['sync', 'check'].includes(action)) return ctx.unknown();
  let project;
  let dryRun = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--dry-run' && action === 'sync') dryRun = true;
    else if (args[i] === '--project' && args[i + 1]) project = args[++i];
    else return ctx.unknown();
  }
  const result = action === 'check'
    ? await run('todo_check', ctx.root, { project })
    : await todoRun(ctx.root, { project, dryRun, check: false });
  for (const report of result.reports) {
    ctx.out(`${report.project}: ${report.enabled ? 'Task list enabled / Lista de tarefas ligada' : 'Task list disabled / Lista de tarefas desligada'}`);
    for (const change of report.changes) ctx.out(dryRun ? change.diff : `Updated / Atualizada: ${change.title} (${change.file}:${change.line})`);
    for (const suggestion of report.suggestions) ctx.out(`${suggestion.message} ${suggestion.item}`);
    if (action === 'check') {
      for (const item of report.demandsWithoutItem) ctx.out(`Work without task / Trabalho sem tarefa: ${item.title}`);
      for (const item of report.itemsWithoutDemand) ctx.out(`Task without work / Tarefa sem trabalho: ${item.text}`);
    }
  }
  return 0;
}

async function inboxCommand(ctx, action, args, io) {
  const config = await readConfig(ctx.root);
  if (action === 'list') {
    const { locale, rest } = await readLocale(args, ctx);
    if (rest.length || !Object.hasOwn(LABELS, locale)) return ctx.unknown();
    for (const item of await inboxList(ctx.root)) ctx.out(`${item.id} ${item.status} ${item.title} — ${holdText(item, config, locale)}`);
    return 0;
  }
  if (!['take', 'release'].includes(action) || !args[0] || args[0].startsWith('--')) return ctx.unknown();
  const owner = { client: 'producer' };
  let takeover = false;
  let yes = false;
  let changed;
  for (let i = 1; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--producer-takeover' && action === 'take') takeover = true;
    else if (flag === '--yes' && action === 'take') yes = true;
    else if (['--client', '--session', ...(action === 'take' ? ['--worktree'] : [])].includes(flag)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) return ctx.unknown();
      owner[flag.slice(2)] = args[++i];
    } else return ctx.unknown();
  }
  if (takeover) {
    const item = (await inboxList(ctx.root)).find((entry) => entry.id === args[0]);
    if (!item) throw new Error(`unknown inbox item ${args[0]}`);
    await showHoldSituation(ctx, item, config);
    if (!yes && !await confirmTake(io, ctx.out)) throw new Error('transfer cancelled / transferência cancelada');
    changed = await inboxProducerTakeover(ctx.root, args[0], owner, item.hold);
  } else if (action === 'take') changed = await inboxClaim(ctx.root, args[0], owner, { allowStale: false });
  else changed = await inboxRelease(ctx.root, args[0], owner);
  if (changed.todoWarning) ctx.err(changed.todoWarning);
  for (const report of changed.todo?.reports ?? []) {
    for (const suggestion of report.suggestions) ctx.out(`${suggestion.message} ${suggestion.item}`);
  }
  ctx.out(`${args[0]}: ${action}`);
  return 0;
}

const STOP_FILE = 'daemon.stop';
const DAEMON_ACTIONS = ['start', 'stop', 'status', 'pause', 'resume', 'run-once'];
const AUTOSTART_ACTIONS = ['install', 'uninstall', 'show'];

const USAGE_LINES = [
  'usage: {command} daemon start|stop|status|pause|resume|run-once',
  '       {command} install [--from <dir>] [--client <c>|all] [--prerelease] [--repo <o/r>] [--dest <dir>] [--no-link] [--autostart] [--dry-run] [--yes] [--statusline|--no-statusline]',
  '       {command} update [--client <c>] [--check] [--rollback] [--dry-run] [--statusline|--no-statusline]',
  '       {command} uninstall [--client <c>] [--purge] [--yes] [--dry-run]',
  '       {command} setup [--defaults] [--again] [--locale en|pt-BR]',
  '       {command} daemon status [--table [--locale en|pt-BR]]',
  '       {command} autostart install|uninstall|show [--kind systemd|cron|launchd|schtasks]',
  '       {command} status [--all] [--client <name>] [--locale en|pt-BR]',
  '       {command} env report [--client <name>] [--locale en|pt-BR]',
  '       {command} actors [--all] [--client <name>] [--json] [--locale en|pt-BR]',
  '       {command} config show',
  '       {command} config get <key>',
  '       {command} config set <key> <value>',
  '       {command} config unset <key>',
  '       {command} quota set <client> <pct> [--window-minutes n]',
  '       {command} quota show [client]',
  '       {command} telemetry status|on|off|rede on|off|export [--since ISO]|check',
  '       {command} trajectory list|show <run>|export <run>|prune|on|off|status',
  '       {command} inbox list [--locale en|pt-BR]',
  '       {command} todo sync [--dry-run] [--project <path>]',
  '       {command} todo check [--project <path>]',
  '       {command} inbox take <id> [--producer-takeover] [--client <c>] [--session <s>] [--worktree <path>] [--yes]',
  '       {command} inbox release <id> [--client <c>] [--session <s>]',
  '       {command} kit [--require] [--locale en|pt-BR]',
  '       {command} smoke [--real] [--keep] [--only <ids>] [--timeout <ms>]',
  '       {command} smoke|client-smoke --client claude-code|codex|opencode [--headless|--demo|--dry-run|--rehearsal]',
  '       {command} smoke-demo [--dry-run] [--client <client>] [--locale en|pt-BR] [--confirm <preview>] [--json]',
  '         [--only <C ids>] [--keep] [--allow-unknown-quota]',
  '         [--max-usd [n]] [--max-turns [n]] [--max-minutes [n]] [--quota-floor [pct]] [--timeout [ms]]',
].map((line) => (line.includes('--locale en|pt-BR') ? `${line} {default}` : line));

/**
 * The commands of the table above, read from it and not written again: one entry per group (`smoke|client-smoke` is
 * two groups), with the actions it names and those that take a value (`config get <key>`). A new line in the table is
 * a new entry here, which is what the generated test of the installer's output runs every command through.
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
    state: (kinds) => `OKWORK_HOME names the state root; --kind defaults to ${kinds} by platform.`,
    language: 'Choose the language once: {command} config set language pt-BR.',
  },
  'pt-BR': {
    head: 'uso:',
    default: (language) => `— padrão: language (${language})`,
    state: (kinds) => `OKWORK_HOME indica a pasta de estado; --kind assume ${kinds} conforme a plataforma.`,
    language: 'Escolha o idioma uma vez: {command} config set language pt-BR.',
  },
};

/** The usage text of the program in one language (`locale` is the one `resolveLocale` chose). */
function usageOf(locale, command) {
  const words = USAGE_TEXT[locale] ?? USAGE_TEXT.en;
  const lines = USAGE_LINES.map((line) => line.replace('{default}', words.default(DEFAULT_CONFIG.language))
    .replace(/^usage:/, words.head)
    // The command lines are aligned under the first one: the heading is shorter in Portuguese.
    .replace(/^ {7}(?=\S)/, ' '.repeat(words.head.length + 1)));
  return [...lines, words.state(AUTOSTART_KINDS?.join(', ') ?? ''), words.language].join('\n').replaceAll('{command}', command);
}


// The runner of a command is the one of `src/spawn-process.js`, shared with the
// probe of the kit, so a command behaves the same in both.
export { runCommand };

/** `--kind systemd`, `--kind=systemd` or nothing; an unknown flag is refused. */
function readKind(args) {
  const rest = [];
  let kind = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--kind') {
      kind = args[index + 1] ?? '';
      index += 1;
    } else if (arg.startsWith('--kind=')) kind = arg.slice('--kind='.length);
    else rest.push(arg);
  }
  return { kind, rest };
}

/** An explicit language overrides the saved language. */
async function readLocale(args, ctx) {
  const rest = [];
  let locale = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--locale') {
      locale = args[index + 1] ?? '';
      index += 1;
    } else if (arg.startsWith('--locale=')) locale = arg.slice('--locale='.length);
    else rest.push(arg);
  }
  const config = locale === null ? ctx.snapshot?.config ?? await readConfig(ctx.root) : undefined;
  return { locale: localeOf(locale, config), rest };
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
  const plan = autostartPlan(kind ?? detectAutostart(ctx.platform), { root: ctx.root, command: ctx.command });

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
 * The refusal of a command that is not the installer's own (`setup`, `kit`) in the one language of the run, as the
 * installer says its refusals; the exit code is the usage one.
 */
function refuse(ctx, locale, reason) {
  const ui = createPresenter({ locale, write: ctx.out });
  ui.failure({ reason, next: ui.text('nextCheck') }).forEach((item) => ctx.err(item));
  return exitCodeFor('usage');
}

/**
 * The entry of `setup` and `kit`, in the installer's order: read the configuration, decide the language with the
 * installer's one function (a valid --locale, then OKIT_LANGUAGE, then the saved language, then English), and only
 * then read the flags. `parse` reads them (`{ found }`, or `{ unknown }` with the reason it refuses a flag);
 * `then` receives what was read. A configuration that cannot be read is told in the language the flags and the
 * environment give, because the saved one cannot be known.
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

/** Flags of `setup` and `kit`: the booleans they know, and `--locale <value>` (its value is read by `resolveLocale`). */
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

async function runSetupCommand(ctx, { stored, locale, found }, io) {
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
    return result.code;
  } finally {
    reader.close();
  }
}

// The number of an argument, or NaN when it is not one: an empty argument is not a number.
const numberOf = (text) => (typeof text === 'string' && text.trim() !== '' ? Number(text) : Number.NaN);

async function quotaCommand(ctx, action, args) {
  // The settings of this root are read first, as they always were.
  const config = await readConfig(ctx.root);
  const invalid = () => {
    ctx.err('Invalid quota arguments / Argumentos de cota inválidos');
    return ctx.unknown();
  };
  try {
    if (action === 'show') {
      if (args.length > 1) return invalid();
      const result = await run('quota_show', ctx.root, { client: args[0] }, { ...ctx, config });
      for (const { client, reading } of result.clients) {
        const origin = ['automatic', 'manual', 'user'].includes(reading.source)
          ? ` — ${quotaOrigin(reading, result.now, LABELS.en)} / ${quotaOrigin(reading, result.now, LABELS['pt-BR'])}` : '';
        ctx.out(`Quota / Cota ${client}: ${JSON.stringify(reading)}${origin}`);
      }
      return 0;
    }
    if (action === 'set') {
      if ((args.length !== 2 && args.length !== 4) || (args.length === 4 && args[2] !== '--window-minutes')) return invalid();
      const result = await run('quota_set', ctx.root, { client: args[0], pct: numberOf(args[1]),
        ...(args.length === 4 ? { windowMinutes: numberOf(args[3]) } : {}) }, { ...ctx, config });
      ctx.snapshot = result.snapshot;
      ctx.out(`Quota recorded / Cota registrada: ${result.client} ${result.pct}%`);
      return 0;
    }
  } catch (error) {
    if (error instanceof Refusal) return invalid();
    throw error;
  }
  return invalid();
}

/**
 * The `statusTable` deps of one command: the settings of this root, the clients
 * they name, the readings through each client's adapter, the standing orders and
 * the cap counts. `okit-plugin status` and `okit-plugin daemon status --table` share it, so the
 * table under the daemon lines is the same table of `okit-plugin status`.
 */
async function tableDeps(ctx, locale) {
  const config = ctx.snapshot?.config ?? await readConfig(ctx.root);
  return {
    config,
    detectClients: ctx.detectClients, snapshot: ctx.snapshot, run: ctx.run,
    plugin: ctx.plugin, versions: ctx.versions, home: ctx.home,
    env: ctx.env,
    clients: clientsOf(config, ctx.clients),
    readQuota: ctx.readQuota ?? adapterQuotaReader({ stateRoot: ctx.root, env: ctx.env, now: ctx.now, config }),
    now: ctx.now,
    orders: ctx.orders ?? await orderList(ctx.root),
    limits: ctx.snapshot ? undefined : await limitsStatus(ctx.root, config),
    locale,
    cache: ctx.quotaCache,
  };
}

/**
 * `okit-plugin status`: the quota table and the capacity line under it. The readings
 * come from each client's adapter, the counts from the runs on disk, and both
 * are the same functions the daemon and the MCP tool use.
 */
function readStatusSelection(args) {
  let all = false;
  let client;
  const rest = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--all') all = true;
    else if (arg === '--client') client = args[++index] ?? '';
    else if (arg.startsWith('--client=')) client = arg.slice('--client='.length);
    else rest.push(arg);
  }
  return { all, client, invalid: rest.length > 0 || (client !== undefined && !CLIENTS.includes(client)) };
}

async function environmentCommand(ctx, args, io) {
  const parsed = await readLocale(args, ctx);
  const locale = parsed.locale;
  const selection = readStatusSelection(parsed.rest);
  if (!Object.hasOwn(LABELS, locale) || parsed.rest.includes('--all')) return ctx.unknown();
  if (selection.client !== undefined && !CLIENTS.includes(selection.client)) {
    ctx.err(formatEnvironmentReport({ unknownClient: true }, locale));
    return exitCodeFor('operational');
  }
  if (selection.invalid || args.at(-1) === '--locale') return ctx.unknown();
  const deps = await tableDeps(ctx, locale);
  const report = await environmentReport({ ...ctx, ...deps, root: ctx.root, client: selection.client,
    command: ctx.command, adapters: io.adapters, detectClients: io.detectClients,
    plugin: io.plugin, versions: io.versions });
  ctx.out(formatEnvironmentReport(report, locale));
  return 0;
}

async function actorsCommand(ctx, args) {
  const { locale, rest } = await readLocale(args, ctx);
  const json = rest.includes('--json');
  const selection = readStatusSelection(rest.filter((arg) => arg !== '--json'));
  if (selection.invalid || (locale !== null && !Object.hasOwn(LABELS, locale))) return ctx.unknown();
  const result = await listActors({ root: ctx.root, ...await tableDeps(ctx, locale), ...selection });
  if (json) ctx.out(formatActors(result, { json: true }));
  else for (const line of formatActors(result).split('\n')) ctx.out(line);
  return 0;
}

/** Flags of `status`: `--all`, `--client <name>` or `--client=<name>`, and `--locale <value>` (read by `resolveLocale`). */
function statusFlags(flags) {
  const found = { all: false };
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === '--locale') {
      if (flags[index + 1] === undefined || flags[index + 1].startsWith('--')) return { unknown: 'Missing value for --locale' };
      index += 1;
    } else if (flag === '--all') found.all = true;
    else if (flag === '--client' || flag.startsWith('--client=')) {
      found.client = flag === '--client' ? flags[++index] ?? '' : flag.slice('--client='.length);
      if (!CLIENTS.includes(found.client)) return { unknown: `Unknown flag: ${flag}` };
    } else return { unknown: `Unknown flag: ${flag}` };
  }
  return { found };
}

/**
 * `okit-plugin status`, in the installer's order (read the configuration, decide the language, then read the flags),
 * so every line it prints, the refusals included, is in the one language of the run.
 */
async function statusCommand(ctx, rawArgs) {
  const args = separateLocale(rawArgs);
  return enter(ctx, args, statusFlags, async ({ locale, found, install: config }) => {
    const selection = { all: found.all, client: found.client };
    const table = await statusTable(ctx.root, { ...await tableDeps(ctx, locale), ...selection });
    for (const line of table.markdown.split('\n')) ctx.out(line);
    ctx.out(table.capacityLine);
    const stored = await readConfig(ctx.root);
    // One line, only while the setup is pending: what is missing and the command
    // that does it. It is gone once the setup was done.
    const pending = setupPendingLine(stored, { locale, command: config.command });
    if (pending) ctx.out(pending);
    const home = ctx.home ?? ctx.env.HOME ?? ctx.env.USERPROFILE ?? homedir();
    const deps = { ...ctx, config, home, locale, ...installPaths(config, { ...ctx, home }) };
    const unreadable = [];
    const records = Object.values(await readRecords(deps.destination, ctx.fs, config, { unreadable }));
    for (const line of recordIgnoredLines(unreadable, locale)) ctx.out(line);
    deps.bin = records.find((record) => record.linkDirectory)?.linkDirectory ?? deps.bin;
    const warning = await activationWarning(deps);
    if (warning) ctx.out(warning);
    // The probe's own `message` is an English sentence for the callers that assert it; the screen gets the localised line.
    ctx.out(kitLine(await detectKit({ ...ctx, config }), config.kit, locale));
    return exitCodeFor('ok');
  });
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
    const paused = await run('daemon', ctx.root, { action }, { ...ctx });
    ctx.out(`paused: ${paused.paused}`);
    return 0;
  }

  if (action === 'status') {
    // `--locale` alone is a refusal: it names a table, so it needs `--table`, and
    // an unknown language is refused the same way `okit-plugin status` refuses it.
    const { locale, rest: withoutLocale } = await readLocale(args, ctx);
    const { table, rest } = readTable(withoutLocale);
    if (rest.length > 0 || (!Object.hasOwn(LABELS, locale) || (!table && args.some((arg) => arg === '--locale' || arg.startsWith('--locale='))))) {
      return ctx.unknown();
    }

    const deps = { ...ctx, table: table ? await tableDeps(ctx, locale) : undefined };
    const status = await run('daemon', ctx.root, { action, table }, deps);
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
    const record = await run('daemon', ctx.root, { action }, { ...ctx });
    report(ctx.out, [
      `opened: ${record.opened.length}`,
      `spawned: ${record.spawned.length}`,
      `skipped: ${record.skipped.length}`,
    ]);
    for (const skip of record.skipped) ctx.out(`skipped ${skip.id}: ${skip.reason}`);
    return 0;
  }

  // The kill switch stops the loop on the next pass, so a switch left by an
  // earlier `okit-plugin daemon stop` would stop this one before it did anything. The
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
 * `okit-plugin smoke`: the runner of `docs/maintainers/SMOKE.md` on a scratch home, which prints
 * its own facts and answers 0, 1 or 2. The process defaults of `main` do not
 * reach it: a smoke run must never start a client or run a `systemctl` on the
 * machine it verifies, so `run` and `spawn` arrive only when a caller injected
 * them, and the runner answers with its own stub otherwise.
 */
async function smokeCommand(ctx, args, io) {
  if (args.some((arg) => arg === '--client' || arg.startsWith('--client='))) {
    const { runClientSmoke } = await import('./smoke/client.js');
    return (await runClientSmoke(args, { ...ctx, ...io })).code;
  }
  const { runSmoke } = await import('./smoke.js');
  const smoke = await runSmoke(args, { ...ctx, run: io.run, spawn: io.spawn });
  // A flag or an `--only` id the runner refuses is a usage error, so the usage
  // text goes with it exactly as it goes with an unknown group.
  return smoke.usage === true ? ctx.unknown() : smoke.code;
}

function installerLifecycle(ctx, io) {
  const plan = (record) => autostartPlan(detectAutostart(ctx.platform), {
    root: ctx.root, home: io.home ?? ctx.env.HOME ?? ctx.env.USERPROFILE,
    node: record.settings.node, script: join(record.path, record.bin), command: ctx.command,
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

/** `--locale=pt-BR` as `--locale pt-BR`: resolveLocale reads the separate form only. */
const separateLocale = (args) => args.flatMap((arg) => (arg.startsWith('--locale=') ? ['--locale', arg.slice('--locale='.length)] : [arg]));

const HELP_FLAGS = ['--help', '-h'];
const HELPED_GROUPS = ['setup', 'install', 'update', 'uninstall', 'kit', 'status'];

/** Whether the line asks for the help text: a help flag where a group or an action would be, or anywhere after an installer's group. */
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
    if (group === 'config') {
      return await configCommand(ctx, action, args, { write: ctx.writeConfig, run });
    }
    if (group === 'trajectory') {
      const { trajectoryCommand } = await import('./trajectory/cli.js');
      return await trajectoryCommand(ctx, action, args);
    }
    if (group === 'telemetry') {
      const { telemetryCommand } = await import('./telemetry/cli.js');
      return await telemetryCommand(ctx, action, args);
    }
    if (group === 'inbox') return await inboxCommand(ctx, action, args, io);
    if (group === 'todo') return await todoCommand(ctx, action, args);
    if (group === 'env' && action === 'report') return await environmentCommand(ctx, args, io);
    if (group === 'quota') return await quotaCommand(ctx, action, args);
    if (group === 'kit') {
      return await enter(ctx, argv.slice(1), flagsParser(['--require']), async ({ stored, locale, found, install: config }) => {
        // `kit` reads the whole configuration (`configOf` is the one reader of every other key): an invalid one is a refusal.
        try { configOf(stored); } catch (error) {
          if (kindOf(error) === 'usage') return refuse(ctx, locale, error.message);
          throw error;
        }
        const result = await run('kit_detect', ctx.root, {}, {
          fs: ctx.fs, platform: ctx.platform, run: ctx.run, env: ctx.env, home: ctx.home, command: ctx.command,
        });
        out(kitLine(result, config.kit, locale));
        return exitCodeFor((found['--require'] || config.kit.require) && result.state !== 'installed' ? 'operational' : 'ok');
      });
    }
    if (['install', 'update', 'uninstall'].includes(group)) {
      const flags = action === undefined ? args : [action, ...args];
      return await installerCommand(group, flags, ctx, {
        ...io, ...installerLifecycle(ctx, io),
      });
    }
    if (group === 'hook' && action === 'post-compact') {
      const { launch } = await import('./launchers.js');
      return await launch(argv, { ...io, root: ctx.root, env: ctx.env, stdout: out });
    }
    if (group === 'hook' && action === 'session-start') {
      const { launch } = await import('./launchers.js');
      return await launch(argv, { ...io, root: ctx.root, env: ctx.env, stdout: out });
    }
    if (group === 'daemon') return await daemonCommand(ctx, action, args);
    if (group === 'autostart') return await autostartCommand(ctx, action, args);
    if (group === 'actors') {
      return await actorsCommand(ctx, action === undefined ? args : [action, ...args]);
    }
    if (group === 'status') {
      // `okit-plugin status` takes no action, so the flag lands where one would be.
      return await statusCommand(ctx, action === undefined ? args : [action, ...args]);
    }
    // `okit-plugin smoke` takes no action either, so its first flag lands where one would be.
    if (group === 'smoke') return await smokeCommand(ctx, action === undefined ? args : [action, ...args], io);
    if (group === 'smoke-demo') {
      const { smokeDemoCommand } = await import('./smoke/demo/entry.js');
      const config = ctx.snapshot?.config ?? await readConfig(ctx.root);
      const flags = action === undefined ? args : [action, ...args];
      const explicit = flags.some((arg) => arg === '--locale' || arg.startsWith('--locale='));
      const { locale } = explicit ? {} : await readLocale(flags, ctx);
      return smokeDemoCommand(explicit ? flags : [...flags, '--locale', locale], { ...ctx, ...io, config, out, err });
    }
    if (group === 'client-smoke') {
      const { runClientSmoke } = await import('./smoke/client.js');
      const flags = action === undefined ? args : [action, ...args];
      return (await runClientSmoke(flags, { ...ctx, ...io, run: io.run, out, err })).code;
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
  // Let module evaluation finish before smoke checks import this CLI again.
  runCli().then((code) => { process.exitCode = code; });
}
