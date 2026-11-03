import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as filesystem from 'node:fs/promises';

import { autostartPlan, autostartPresent, detectAutostart } from '../autostart.js';
import { daemonStatus } from '../daemon.js';
import { installConfig, installPaths } from '../install/config.js';
import { mcpPlan, mcpStatus, quotedWord, shown } from '../install/mcp-register.js';
import { clientLabel, localizeReason, controlReason, redact } from '../install/present.js';
import { checkLabel, selfCheck } from '../install/selfcheck.js';
import { extraText } from '../install/texts.js';
import { resolvedRecord } from '../install/where.js';
import { callControl, findServers } from '../mcp/control-client.js';
import { configOf, DEFAULT_CONFIG, LOCALES } from '../profiles.js';
import { isReadableConfig } from '../setup/setup.js';
import { paths } from '../store.js';

// The doctor: it looks at the whole installation and answers a list of rows, one per thing it looked at. Every row is a
// status, a label, a sentence in the language of the run and, when something is wrong, the sentence that says how to fix
// it with the exact command.
//
// It only reads. It never writes a file, never prunes a record of a dead process, never registers anything and never
// removes anything: the reading of the state is the same before and after the run.
//
// Every reader is a seam (`readers`): the real ones are the defaults, and a caller (the command line) may replace one of
// them. The module never reaches for a global: the state root, the settings, the file system, the runner of a process and
// the presenter all come in the input.

const PACKAGE_FILE = fileURLToPath(new URL('../../package.json', import.meta.url));
// The name of the scheduled task of the autostart of Windows.
// How long one call to the control API of a session may take.
const CALL_TIMEOUT_MS = 5000;

/**
 * The readers of the doctor, with their real defaults. Every one of them only reads.
 *
 * @param {{fs: object, run?: Function}} deps
 * @returns {object} the readers
 */
function defaultReaders({ fs, run, timeoutMs }) {
  return {
    nodeVersion: () => process.version,
    readText: (file) => fs.readFile(file, 'utf8'),
    // The records of the dead processes are only left out of the answer: the doctor never removes one.
    servers: (root) => findServers(root, { prune: false }),
    callRead: (root, pid) => callControl({ root, tool: 'inbox_list', arguments: {}, pid, timeoutMs: CALL_TIMEOUT_MS, prune: false }),
    daemon: (root) => daemonStatus(root),
    autostartPresent: (plan) => autostartPresent(plan, { fs, run, timeoutMs }),
    selfCheck: (record, expected, deps) => selfCheck(record, expected, deps),
    mcpEntry: (record, deps) => mcpStatus(record, deps),
  };
}

/** The parts of a version: `v20.11.0` is [20, 11, 0]. */
const partsOf = (value) => String(value ?? '').replace(/^v/i, '').split('.')
  .map((part) => Number.parseInt(part, 10) || 0);

/**
 * The minimum Node version the package asks for: the `>=N` of its `engines.node`; null when it names none (the row is
 * then skipped: the doctor never refuses a version it cannot prove).
 */
function minimumOf(pkg) {
  const asked = pkg?.engines?.node;
  if (typeof asked !== 'string') return null;
  const found = /^>=\s*(\d+(?:\.\d+)*)/.exec(asked.trim());
  return found ? found[1] : null;
}

/** Whether the running Node is at least the minimum the package asks for. */
function atLeast(version, minimum) {
  const here = partsOf(version), wanted = partsOf(minimum);
  for (let index = 0; index < Math.max(here.length, wanted.length); index += 1) {
    const mine = here[index] ?? 0, theirs = wanted[index] ?? 0;
    if (mine !== theirs) return mine > theirs;
  }
  return true;
}

/** A file read through the reader of the doctor: its text, or the fact that it is not there, or the refusal of the disk. */
async function readThrough(readers, file) {
  try { return { text: await readers.readText(file) }; }
  catch (error) {
    if (error?.code === 'ENOENT') return { missing: true };
    return { error };
  }
}

/** The reason of a failure, in plain words. */
const reasonOf = (error) => {
  if (error instanceof Error) return error.message;
  // A thrown value can be anything, one that cannot be turned into text included.
  try { return String(error); } catch { return typeof error; }
};

/**
 * The answer of a reader: its value, or the failure that stopped it.
 *
 * A reader that throws is a row of the diagnosis, never an exception out of it: the doctor is the tool that
 * diagnoses a broken stored state, so a state file it cannot read is what it says, not a crash.
 *
 * @param {Function} reader the reader
 * @param {...unknown} args the arguments of the reader
 * @returns {Promise<{value?: unknown, error?: unknown}>} the answer of the reader, or its failure
 */
async function attempt(reader, ...args) {
  try { return { value: await reader(...args) }; }
  catch (error) { return { error }; }
}

/**
 * The file a failure names, when it names one (the path of the file the reader was reading); the fallback
 * otherwise (the state root, or the file the reader of ours knows).
 *
 * @param {unknown} error the failure of the reader
 * @param {string} fallback the file to name when the failure names none
 * @returns {string}
 */
function pathOf(error, fallback) {
  const carried = error?.path ?? error?.file;
  return typeof carried === 'string' && carried !== '' ? carried : fallback;
}

/**
 * The row of a state file that could not be read: the reason (redacted) and the Fix that names the file when
 * the failure carries one, and the state root when it does not.
 *
 * @param {object} input the id, the label, the failure, the presenter, the command and the state root
 * @returns {object} the row
 */
function unreadableRow({ id, label, error, ui, command, root, path, platform }) {
  return {
    id,
    status: 'failed',
    label,
    detail: ui.text('doctorStateUnreadable', { reason: redact(reasonOf(error)) }),
    fix: ui.text('doctorFixState', { path: quotedWord(pathOf(error, path ?? root), platform), command }),
  };
}

/** Whether a value is a plain object (a list, a number, a text and null are not). */
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Whether the configuration file holds a configuration the plugin can use.
 *
 * The settings of the installer are read first, because their refusal names the key of the setting. Then the whole
 * stored value is read, through the one reader of the runtime (`configOf`): a value the runtime would refuse (a
 * setting of the wrong type, a key that is not known) is a configuration that is not valid, and the row says so, with
 * the reason of the reader.
 *
 * @param {unknown} value the stored configuration
 * @returns {{ok: boolean, reason?: string}}
 */
function configShape(value) {
  if (!isReadableConfig(value)) return { ok: false };
  // The settings of the installer are read first: their refusal names the key of the setting.
  try { installConfig(value?.install); } catch (error) { return { ok: false, reason: error?.message }; }
  // The whole stored value is read, through the one reader of the runtime (`configOf`): a value the runtime would
  // refuse (a setting of the wrong type, a key that is not known) is a configuration that is not valid.
  try { configOf(value); } catch (error) { return { ok: false, reason: error?.message }; }
  return { ok: true };
}

/** The shape of the inbox: a store with its list of items. */
const inboxShape = (value) => ({ ok: plain(value) && Array.isArray(value.items) });

/** The shape of the orders: a store with its list of orders. */
const ordersShape = (value) => ({ ok: plain(value) && Array.isArray(value.orders) });

/**
 * The diagnosis of one installation: the rows of what it looked at, and how many of them failed or warned.
 *
 * The rows come in the order of the run: the Node version, the installation, then one group per client (the registration
 * of the MCP server and the checks of the install self-check), then the state files, the session, the autostart and the
 * daemon.
 *
 * @param {object} input the state root, the settings, the records, the presenter and the readers
 * @returns {Promise<{rows: object[], failed: number, warnings: number}>}
 */
export async function diagnose(input) {
  const settings = input.config ?? installConfig();
  const ui = input.ui;
  const command = input.command ?? settings.command;
  const platform = input.platform ?? process.platform;
  // Every command the doctor advertises is written for the shell of the platform: a command with a space or a quote
  // in it is runnable as it is shown.
  const program = quotedWord(command, platform);
  const env = input.env ?? {};
  const home = input.home ?? env.HOME ?? env.USERPROFILE ?? homedir();
  const root = input.root;
  const records = Array.isArray(input.records) ? input.records : [];
  const fs = input.fs ?? filesystem;
  const now = input.now ?? (() => Date.now());
  // A caller that has no runner of its own gets one that refuses: a reader that cannot run is a row, never a crash.
  const run = input.run ?? (async () => { throw Object.assign(new Error('no runner of processes was given'), { code: 'ENOENT' }); });
  const readers = { ...defaultReaders({ fs, run, timeoutMs: settings.timeoutMs }), ...(input.readers ?? {}) };
  const rows = [];

  // The dependencies of the readers that need them: the settings, the runner of a process and the presenter.
  const deps = { config: settings, run, platform, ui, out: () => {}, now, env, home, fs, root, command };

  // The configuration file is read once: the status bar of the client and its collector are told by it, and the row of
  // the configuration says what it holds.
  const stored = await readThrough(readers, paths(root).config);
  let storedValue;
  if (stored.text !== undefined) {
    try { storedValue = JSON.parse(stored.text); } catch { storedValue = undefined; }
  }
  let statuslineConfig = DEFAULT_CONFIG.statuslineRegistration;
  let collectorConfig = DEFAULT_CONFIG.statuslineCollector;
  if (storedValue !== undefined) {
    try {
      const whole = configOf(storedValue);
      statuslineConfig = whole.statuslineRegistration;
      collectorConfig = whole.statuslineCollector;
    } catch {
      // A configuration that cannot be read keeps the defaults: the row of the configuration says so.
    }
  }

  // 1. The Node version of this run against the minimum the package asks for.
  const node = await attempt(async () => readers.nodeVersion());
  const version = node.value;
  const minimum = minimumOf(await readPackage(readers));
  if (node.error !== undefined) {
    rows.push(unreadableRow({ id: 'node', label: ui.text('doctorNode'), error: node.error, ui, command: program, root, platform }));
  } else if (minimum === null) {
    rows.push({ id: 'node', status: 'skipped', label: ui.text('doctorNode'), detail: ui.text('doctorNodeUnknown') });
  } else if (atLeast(version, minimum)) {
    rows.push({ id: 'node', status: 'ok', label: ui.text('doctorNode'), detail: ui.text('doctorNodeOk', { version, minimum }) });
  } else {
    rows.push({ id: 'node', status: 'failed', label: ui.text('doctorNode'),
      detail: ui.text('doctorNodeOld', { version, minimum }), fix: ui.text('doctorFixNode', { minimum, command: program }) });
  }

  // 2. The installation itself: no record at all is one failed row, and no row of a client follows. A client that was
  // named and has no record is a failed row too: the installation of that client is not there.
  const chosen = input.client ? records.filter((record) => record.client === input.client) : records;
  if (input.client && !chosen.length) {
    rows.push({ id: 'install', status: 'failed', label: ui.text('doctorInstall'),
      detail: ui.text('doctorClientNone', { client: clientLabel(input.client) }),
      fix: ui.text('doctorFixClientInstall', { command: program, client: quotedWord(input.client, platform) }) });
  } else if (!records.length) {
    rows.push({ id: 'install', status: 'failed', label: ui.text('doctorInstall'),
      detail: ui.text('doctorInstallNone'), fix: ui.text('doctorFixInstall', { command: program }) });
  } else {
    // The row tells about the clients the run looked at, not about every record of the machine.
    const versions = [...new Set(chosen.map((record) => record.version).filter(Boolean))].join(', ');
    rows.push({ id: 'install', status: 'ok', label: ui.text('doctorInstall'),
      detail: ui.text('doctorInstallOk', { versions: versions || '?' }) });
  }

  // 3. The records that could not be read: one failed row each, and the other clients are still diagnosed.
  for (const one of input.invalid ?? []) {
    rows.push({ id: 'record', status: 'failed', label: ui.text('doctorRecord'),
      detail: ui.text('doctorRecordUnreadable', { file: quotedWord(one.file, platform) }),
      // A record of no client (a legacy file that is corrupt) is repaired by the install of
      // every client: the fix never names an empty client.
      fix: one.client ? ui.text('doctorFixRecord', { command: program, client: quotedWord(one.client, platform) })
        : ui.text('doctorFixRecordAll', { command: program }) });
  }

  // 4. One group per client: the registration of the MCP server and the checks of the install self-check.
  // The record is resolved first: where the installation is, is read from the record (a custom `--dest` or a moved
  // installation is the record's own folder), never rebuilt out of the settings.
  const selfCheckDeps = selfCheckDependencies({ input, settings, env, home, platform, fs, run, now, ui, records, statuslineConfig, collectorConfig });
  const resolved = chosen.map((record) => resolvedRecord(record, selfCheckDeps.destination));
  for (const record of resolved) {
    rows.push(await registrationRow(record, { deps, readers, settings, platform, command: program, ui, root }));
    rows.push(...await selfCheckRows(record, { readers,
      selfCheckDeps: { ...selfCheckDeps, destination: record.destination }, ui, command: program, root, platform }));
  }

  // 5. The state files: the configuration, the inbox and the orders.
  rows.push(...await stateRows({ readers, root, ui, command: program, stored, language: storedValue?.language, platform }));

  // 6. The session: the server of the state folder, asked one question.
  rows.push(await sessionRow({ readers, root, ui, command: program, platform }));

  // 7. The autostart: the plan of this machine, seen from the first record.
  const autostart = await autostartRow({ readers, records: resolved, root, home, command, program, platform, ui });
  if (autostart) rows.push(autostart);

  // 8. The daemon: it runs, or it should (the autostart is there) and does not.
  rows.push(await daemonRow({ readers, root, ui, command: program, autostart, platform }));

  const failed = rows.filter((row) => row.status === 'failed').length;
  const warnings = rows.filter((row) => row.status === 'warn').length;
  return { rows, failed, warnings };
}

/** The package of this program: its `engines.node` says the minimum Node it runs on. */
async function readPackage(readers) {
  const read = await readThrough(readers, PACKAGE_FILE);
  if (read.text === undefined) return null;
  try { return JSON.parse(read.text); } catch { return null; }
}

/** The dependencies of the install self-check: what it reads, and the temporary folder it works in. */
function selfCheckDependencies({ input, settings, env, home, platform, fs, run, now, ui, records, statuslineConfig, collectorConfig }) {
  // A platform the installer does not know has no folders: the checks that need them fail as rows, the run goes on.
  let locations = { destination: undefined, bin: undefined };
  try { locations = installPaths(settings, { env, platform, home }); } catch { /* the folders stay unknown */ }
  const link = records.find((record) => record.linkDirectory)?.linkDirectory ?? locations.bin;
  return {
    ...input,
    config: settings,
    fs,
    run,
    now,
    ui,
    env,
    home,
    platform,
    destination: locations.destination,
    bin: link,
    temporary: input.temporary ?? tmpdir(),
    statuslineConfig,
    collectorConfig,
    out: () => {},
  };
}

/** The text of each reason an entry of ours can be broken by. */
const BROKEN_TEXTS = Object.freeze({
  disabled: 'doctorRegistrationDisabled',
  'other-executable': 'doctorRegistrationOther',
  'missing-executable': 'doctorRegistrationMissing',
  'missing-server': 'doctorRegistrationServerMissing',
});

/** The row of the registration of the MCP server of one client: read, never written. */
async function registrationRow(record, { deps, readers, settings, platform, command, ui, root }) {
  const label = ui.text('doctorRegistration');
  const client = clientLabel(record.client);
  const entry = await attempt(async () => readers.mcpEntry(record, deps));
  const base = { id: 'registration', client: record.client, label };
  if (entry.error !== undefined) {
    return { ...base, ...unreadableRow({ id: 'registration', label, error: entry.error, ui, command, root, platform }) };
  }
  const state = entry.value;
  if (state?.state === 'registered') {
    return { ...base, status: 'ok', detail: ui.text('doctorRegistrationOk', { client }) };
  }
  if (state?.state === 'absent') {
    return { ...base, status: 'failed', detail: ui.text('doctorRegistrationAbsent', { client }),
      fix: ui.text('doctorFixRegistration', { command, client: quotedWord(record.client, platform) }) };
  }
  if (state?.state === 'foreign') {
    // The entry of that name is not ours: the installer will not replace it, so the person takes it out by hand.
    const plan = mcpPlan(record, deps);
    const remove = plan ? shown(plan.remove, platform) : '';
    return { ...base, status: 'warn', detail: ui.text('doctorRegistrationForeign', { name: settings.mcp?.name ?? 'okit', client }),
      fix: ui.text('doctorFixForeign', { remove }) };
  }
  if (state?.state === 'broken') {
    // The entry is ours, but it cannot work: the client has it off, or it launches another program.
    const key = BROKEN_TEXTS[state.reason] ?? 'doctorRegistrationBroken';
    return { ...base, status: 'failed', detail: ui.text(key, { client, command: state.command ?? '' }),
      fix: ui.text('doctorFixRegistration', { command, client: quotedWord(record.client, platform) }) };
  }
  if (state?.state === 'unreadable') {
    return { ...base, status: 'warn', detail: ui.text('doctorRegistrationUnreadable', { client, reason: state.reason ?? '' }) };
  }
  return { ...base, status: 'skipped', detail: ui.text('doctorRegistrationNone') };
}

/** The rows of the install self-check of one client, in the order it runs them. */
async function selfCheckRows(record, { readers, selfCheckDeps, ui, command, root, platform }) {
  const answer = await attempt(async () => readers.selfCheck(record, record.version, selfCheckDeps));
  if (answer.error !== undefined) {
    // The check itself could not run: one row says so, and the run goes on.
    return [{ client: record.client, ...unreadableRow({ id: 'selfcheck',
      label: ui.text('selfcheck', { client: clientLabel(record.client) }), error: answer.error, ui, command, root, platform }) }];
  }
  const checks = answer.value;
  return (Array.isArray(checks) ? checks : []).map((check) => {
    return {
      id: check.id,
      client: record.client,
      status: check.status === 'pass' ? 'ok' : check.status === 'fail' ? 'failed' : 'skipped',
      label: checkLabel(check, ui),
      detail: check.reason ?? '',
      ...(check.fix ? { fix: check.fix } : {}),
      quiet: check.status === 'skip' && check.quiet === true,
    };
  });
}

/** The rows of the three state files: the configuration, the inbox and the orders. */
async function stateRows({ readers, root, ui, command, stored, language, platform }) {
  const rows = [];
  const files = [
    { id: 'config', label: 'doctorConfig', file: paths(root).config, shape: configShape },
    { id: 'inbox', label: 'doctorInbox', file: paths(root).inbox, shape: inboxShape },
    { id: 'orders', label: 'doctorOrders', file: paths(root).orders, shape: ordersShape },
  ];
  for (const entry of files) {
    const read = entry.id === 'config' ? stored : await readThrough(readers, entry.file);
    const label = ui.text(entry.label);
    if (read.missing) {
      rows.push({ id: entry.id, status: 'ok', label, detail: ui.text('doctorStateAbsent') });
      continue;
    }
    if (read.text === undefined) {
      // The disk refused the file: the reason is said, and the Fix names the file.
      rows.push({ id: entry.id, status: 'failed', label,
        detail: ui.text('doctorStateUnreadable', { reason: redact(reasonOf(read.error)) }),
        fix: ui.text('doctorFixState', { path: quotedWord(entry.file, platform), command }) });
      continue;
    }
    // The saved language that is not a language: the row says so, with the way out (the run of the doctor goes on in
    // the language the flag and the environment decide).
    if (entry.id === 'config' && language !== undefined && !LOCALES.includes(language)) {
      // The value is whatever the file holds (a number, a list, an object): it is shown as JSON, never as String().
      const value = typeof language === 'string' ? language : JSON.stringify(language);
      rows.push({ id: entry.id, status: 'failed', label,
        detail: ui.text('doctorLanguageInvalid', { value: redact(value) }),
        fix: ui.text('doctorFixLanguage', { path: quotedWord(entry.file, platform), command, languages: LOCALES.join(', ') }) });
      continue;
    }
    let value;
    try { value = JSON.parse(read.text); } catch { value = undefined; }
    // The configuration says why it is not valid (the reason of the reader of the runtime); the other two do not.
    const problem = value === undefined ? { ok: false } : entry.shape(value);
    if (!problem.ok) {
      const detail = problem.reason
        ? ui.text('doctorConfigInvalid', { reason: localizeReason(problem.reason, ui.locale) })
        : ui.text('doctorStateBad', { path: quotedWord(entry.file, platform) });
      rows.push({ id: entry.id, status: 'failed', label, detail,
        fix: ui.text('doctorFixState', { path: quotedWord(entry.file, platform), command }) });
      continue;
    }
    rows.push({ id: entry.id, status: 'ok', label, detail: ui.text('doctorStateOk') });
  }
  return rows;
}

/** The row of the session: the server of the state folder, asked one question. */
async function sessionRow({ readers, root, ui, command, platform }) {
  const label = ui.text('doctorSession');
  const listed = await attempt(async () => readers.servers(root));
  if (listed.error !== undefined) {
    return unreadableRow({ id: 'session', label, error: listed.error, ui, command, root, platform });
  }
  const servers = [...(listed.value ?? [])]
    .sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0));
  if (!servers.length) {
    // No server is not a failure: the server starts with a client session.
    return { id: 'session', status: 'warn', label, detail: ui.text('doctorSessionNone') };
  }
  const asked = await attempt(async () => readers.callRead(root, servers[0].pid));
  if (asked.error !== undefined) {
    return unreadableRow({ id: 'session', label, error: asked.error, ui, command, root, platform });
  }
  const answer = asked.value;
  if (answer?.ok) return { id: 'session', status: 'ok', label, detail: ui.text('doctorSessionOk') };
  return { id: 'session', status: 'failed', label, detail: ui.text('doctorSessionFail', { reason: controlReason(ui, answer ?? {}) }),
    fix: ui.text('doctorFixSession', { command }) };
}

/**
 * The row of the autostart: the plan of this machine, for every record of the installation (one service covers them
 * all, and the current command may be the one of any client's retained payload).
 */
async function autostartRow({ readers, records, root, home, command, program, platform, ui }) {
  const first = records[0];
  if (!first) return null;
  // The node of a plan of this machine: the one of the installation, or the node of this process (absolute: a bare
  // `node` would be resolved by the PATH of a shell nobody knows).
  const planOf = (record) => {
    const node = record.settings?.node ?? process.execPath;
    const script = join(record.path ?? '', record.bin ?? '');
    return { node, script, plan: autostartPlan(detectAutostart(platform), { root, home, command, node, script }) };
  };
  const plans = records.map(planOf);
  const { node, script } = plans[0];
  const label = ui.text('doctorAutostart');
  const asked = await attempt(async () => {
    for (const { plan } of plans) if (await readers.autostartPresent(plan)) return true;
    return false;
  });
  if (asked.error !== undefined) {
    return unreadableRow({ id: 'autostart', label, error: asked.error, ui, command: program, root, platform });
  }
  const present = asked.value;
  const recorded = records.some((record) => record.autostart === true);
  if (present && recorded) return { id: 'autostart', status: 'ok', label, detail: ui.text('doctorAutostartOk') };
  if (recorded && !present) {
    // The Fix names the command that starts the daemon, with the node the plan writes: the program is never
    // resolved by the PATH of a shell nobody knows.
    const daemon = script ? shown([node, script, 'daemon', 'start'], platform) : '';
    const fix = daemon ? extraText('doctorFixAutostartDaemon', ui.locale, { daemon, command: program })
      : ui.text('doctorFixAutostart', { command: program });
    return { id: 'autostart', status: 'failed', label, detail: ui.text('doctorAutostartMissing'), fix };
  }
  if (present && !recorded) return { id: 'autostart', status: 'warn', label, detail: ui.text('doctorAutostartExtra') };
  return { id: 'autostart', status: 'warn', label, detail: ui.text('doctorAutostartOptional', { command: program }) };
}

/** The row of the daemon: it runs, or it should (the autostart is there) and does not. */
async function daemonRow({ readers, root, ui, command, autostart, platform }) {
  const label = ui.text('doctorDaemon');
  const asked = await attempt(async () => readers.daemon(root));
  if (asked.error !== undefined) {
    return unreadableRow({ id: 'daemon', label, error: asked.error, ui, command, root, platform });
  }
  const status = asked.value;
  if (status?.running) return { id: 'daemon', status: 'ok', label, detail: ui.text('doctorDaemonOk') };
  if (autostart?.status === 'ok') {
    return { id: 'daemon', status: 'failed', label, detail: ui.text('doctorDaemonDown'),
      fix: ui.text('doctorFixDaemon', { command }) };
  }
  return { id: 'daemon', status: 'warn', label, detail: ui.text('doctorDaemonDown') };
}
