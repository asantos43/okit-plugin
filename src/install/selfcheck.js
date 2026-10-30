import { join } from 'node:path';
import { HOME_ENV, SELFCHECK_ENV, paths } from '../store.js';
import { READING_FILE } from '../quota/statusline-collector.js';
import { readRecord } from './place.js';
import { quote, binInPath, activationWarning, managedProfile } from './link.js';
import { collectorCommandIndex, settingsPath } from './statusline.js';
import { hookScript, isOurHook } from './register.js';
import { clientRoot } from './config.js';
import { presenterOf, clientLabel } from './present.js';

// The check after an install or an update: the installation is only done when it WORKS on this machine. It reads back what
// the installer wrote (the record, the client's settings) and runs it the way the client will, in a temporary state root,
// so the person's own state is never written. Every check is { id, status: 'pass'|'fail'|'skip', shell?, reason, fix };
// the texts are the presenter's (en and pt-BR), so a result is already in the language of the run.

const LABELS = { version: 'selfcheckVersion', command: 'selfcheckCommand', statusline: 'selfcheckStatusline',
  hook: 'selfcheckHook', collector: 'selfcheckCollector', path: 'selfcheckPath' };

const QUOTE = {
  posix: quote,
  powershell: (value) => `'${value.replaceAll("'", "''")}'`,
  none: (value) => value,
};

const okCheck = (id, reason = '', extra = {}) => ({ id, status: 'pass', reason, ...extra });
const badCheck = (id, reason, fix, extra = {}) => ({ id, status: 'fail', reason, fix, ...extra });
// A skip of a feature the install does not use is quiet (shown with --verbose); a skip of a shell is always shown.
const skipCheck = (id, reason, extra = {}) => ({ id, status: 'skip', reason, ...extra });

const windowsOf = (deps) => deps.platform === deps.config.windowsPlatform;
const variable = (deps, name) => (windowsOf(deps)
  ? Object.entries(deps.env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] : deps.env[name]);

/** The environment of the processes of the check: the link directory first on the PATH, and any extra variable. */
function environment(deps, extra = {}) {
  const windows = windowsOf(deps);
  const key = windows ? Object.keys(deps.env).find((name) => name.toLowerCase() === 'path') ?? 'Path' : 'PATH';
  return { ...deps.env, [key]: [deps.bin, deps.env[key]].filter(Boolean).join(windows ? ';' : ':'), ...extra };
}

/** A path as it is compared: slashes, the drive of a Git Bash path, and (on Windows) the case; no trailing slash. */
function normal(path, deps) {
  let value = String(path).replaceAll('\\', '/');
  if (windowsOf(deps)) value = value.replace(/^\/([a-z])\//i, '$1:/').toLowerCase();
  return value.replace(/\/+$/, '');
}

/** The first line the shell printed for the command: the path it resolves to (empty when it printed nothing). */
const firstLine = (stdout) => String(stdout ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';

/** Whether that path is a file of the link directory: the shim is ours, not another program of the same name. */
function inBin(found, deps) {
  const value = normal(found, deps), cut = value.lastIndexOf('/');
  return cut > 0 && value.slice(0, cut) === normal(deps.bin, deps);
}

/** `{NAME}` of a candidate path from the environment; null when a variable is not set. */
function expand(template, deps) {
  let missing = false;
  const value = template.replace(/\{([^}]+)\}/g, (_, name) => {
    const found = variable(deps, name);
    if (!found) missing = true;
    return found ?? '';
  });
  return missing ? null : value;
}

/** Where the shell's executable is: the first candidate that exists, null when none does; no candidates: the name itself. */
async function locate(shell, deps) {
  if (!shell.candidates) return shell.executable;
  for (const template of shell.candidates) {
    const path = expand(template, deps);
    if (path && await deps.fs.access(path).then(() => true, () => false)) return path;
  }
  return null;
}

/** One process through `deps.run`: ok, a missing executable, or a failure with the sentence that says why. */
async function attempt(deps, spec) {
  const { ui } = deps;
  const timeoutMs = deps.config.selfcheck.timeoutMs;
  try {
    const result = await deps.run({ ...spec, timeoutMs });
    if (typeof result?.code === 'number' && result.code !== 0) return { state: 'failed', why: ui.text('selfcheckExit', { code: result.code }), output: result.stderr };
    return { state: 'ok', stdout: result?.stdout };
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing' };
    const timedOut = error?.killed === true || Boolean(error?.signal) || error?.code === 'ETIMEDOUT';
    return { state: 'failed', output: error?.stderr,
      why: timedOut ? ui.text('selfcheckTimeout', { ms: timeoutMs }) : ui.text('selfcheckExit', { code: error?.code ?? '?' }) };
  }
}

const shellsOf = (deps) => deps.config.selfcheck.shells[deps.platform] ?? [];
const shellNamed = (deps, name) => shellsOf(deps).find((shell) => shell.name === name);
const again = (record, deps) => `${deps.config.command} install --client ${record.client}`;

/** 1. The version the record and the installed package say is the one that was asked for. */
async function versionCheck(record, expected, deps) {
  const { ui } = deps;
  const fix = ui.text('selfcheckFixVersion', { again: again(record, deps) });
  const saved = await readRecord(deps.destination, record.client, deps.fs, deps.config).catch(() => null);
  if (!saved) return badCheck('version', ui.text('selfcheckUnreadable', { path: deps.destination }), fix);
  if (saved.version !== expected) return badCheck('version', ui.text('selfcheckVersionRecord', { found: saved.version, expected }), fix);
  const file = join(saved.path, 'package.json');
  const installed = await deps.fs.readFile(file, 'utf8').then((text) => JSON.parse(text).version, () => undefined);
  if (installed === undefined) return badCheck('version', ui.text('selfcheckUnreadable', { path: file }), fix);
  if (installed !== expected) return badCheck('version', ui.text('selfcheckVersionPackage', { found: installed, expected }), fix);
  return okCheck('version', expected);
}

/** 2. A non-interactive launch of each shell of the platform finds the command; a shell that is not installed is skipped. */
async function commandChecks(record, deps) {
  const { ui, config } = deps;
  if (record.link === false) return [skipCheck('command', ui.text('linkOff'), { quiet: true })];
  const results = [];
  let ran = 0;
  for (const shell of shellsOf(deps)) {
    const executable = await locate(shell, deps);
    const missing = () => skipCheck('command', ui.text('selfcheckShellMissing', { shell: shell.name }), { shell: shell.name });
    if (executable === null) { results.push(missing()); continue; }
    const word = QUOTE[shell.quote](config.command);
    const outcome = await attempt(deps, { command: executable, env: environment(deps),
      args: shell.resolve.map((argument) => argument.replaceAll('{command}', word)) });
    if (outcome.state === 'missing') { results.push(missing()); continue; }
    ran += 1;
    const found = firstLine(outcome.stdout);
    if (outcome.state === 'ok' && !inBin(found, deps)) {
      // Found, but not our shim: another program of the same name comes first, so the plugin's command is not what runs.
      results.push(badCheck('command', ui.text('selfcheckElsewhere', { shell: shell.name, command: config.command, found: found || ui.text('selfcheckNothing'), bin: deps.bin }),
        ui.text('selfcheckFixElsewhere', { found: found || ui.text('selfcheckNothing'), bin: deps.bin, shell: shell.name, again: again(record, deps) }), { shell: shell.name }));
      continue;
    }
    results.push(outcome.state === 'ok' ? okCheck('command', ui.text('selfcheckFound'), { shell: shell.name })
      : badCheck('command', ui.text('selfcheckNotFound', { shell: shell.name, command: config.command, why: outcome.why }),
        ui.text('selfcheckFixCommand', { bin: deps.bin, shell: shell.name, again: again(record, deps) }),
        { shell: shell.name, output: outcome.output }));
  }
  if (!ran) {
    results.push(badCheck('command', ui.text('selfcheckNoShell', { shells: shellsOf(deps).map(({ name }) => name).join(', ') }),
      ui.text('selfcheckFixNoShell', { again: again(record, deps) })));
  }
  return results;
}

/** The client's settings file, as JSON; null when there is none. */
async function readSettings(path, deps) {
  try { return JSON.parse(await deps.fs.readFile(path, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

/** The strings the installer wrote, READ BACK from the settings file (never worked out again): the status bar and our hooks. */
async function writtenCommands(record, deps) {
  const bar = settingsPath(record, deps);
  const hookFile = join(deps.clientRoot ?? clientRoot(record.client, deps), deps.statuslineConfig.settingsFile);
  const barSettings = await readSettings(bar, deps);
  const hookSettings = hookFile === bar ? barSettings : await readSettings(hookFile, deps);
  const line = barSettings?.statusLine;
  const statusline = line?.type === 'command' && typeof line.command === 'string' ? line.command : null;
  const script = hookScript(record.path);
  // A hook is run only when it is exactly ours (`isOurHook`); one that merely names our script is told and not run.
  const named = (Array.isArray(hookSettings?.hooks?.SessionStart) ? hookSettings.hooks.SessionStart : [])
    .flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : []))
    .filter((hook) => hook?.type === 'command' && typeof hook.command === 'string' && hook.command.includes(script))
    .map((hook) => hook.command);
  const hooks = named.filter((command) => isOurHook(command, record.path));
  return { bar, hookFile, statusline, present: line !== undefined && line !== null, hooks, altered: named.length - hooks.length };
}

/** 3 and 4. The status bar and hook strings run in the client's shell, with a temporary state root; the bar leaves a reading. */
async function runWritten(record, deps) {
  const { ui, config } = deps;
  const written = await writtenCommands(record, deps);
  const ours = written.statusline !== null
    && collectorCommandIndex(written.statusline, deps.statuslineConfig, config) > 0;
  const out = [];
  const reading = { status: 'skip', reason: ui.text('selfcheckOff'), quiet: true };
  const jobs = [
    ...(ours ? [{ id: 'statusline', text: written.statusline, fix: ui.text('selfcheckFixStatusline', { again: again(record, deps), path: written.bar }), failed: 'selfcheckStatuslineFailed' }] : []),
    ...written.hooks.map((text) => ({ id: 'hook', text, fix: ui.text('selfcheckFixHook', { again: again(record, deps), path: written.hookFile }), failed: 'selfcheckHookFailed' })),
  ];
  if (!ours) {
    out.push(skipCheck('statusline', ui.text(written.present ? 'selfcheckForeign' : 'selfcheckOff'), { quiet: true }));
  }
  if (written.altered) out.push(skipCheck('hook', ui.text('selfcheckHookForeign'), { quiet: false }));
  else if (!written.hooks.length) out.push(skipCheck('hook', ui.text('selfcheckOff'), { quiet: true }));
  if (!jobs.length) return [...out, { id: 'collector', ...reading }];

  const shell = shellNamed(deps, config.selfcheck.runner[deps.platform]);
  const executable = shell?.run ? await locate(shell, deps) : null;
  const name = shell?.name ?? config.selfcheck.runner[deps.platform];
  const folder = executable === null || !shell?.run ? null
    : await deps.fs.mkdtemp(join(deps.temporary, 'selfcheck-'));
  try {
    // The scripts read the same settings as the real ones, but only the keys they need (`install.selfcheck.stateKeys`):
    // everything else (a measurement folder, a quota command, any new setting that runs or writes) never reaches the copy.
    if (folder !== null) {
      const text = await allowed(deps);
      if (text !== null) await deps.fs.writeFile(paths(folder).config, text);
    }
    for (const job of jobs) {
      if (folder === null) { out.push(skipCheck(job.id, ui.text('selfcheckShellMissing', { shell: name }), { shell: name })); continue; }
      const outcome = await attempt(deps, { command: executable, args: [...shell.run, job.text],
        env: environment(deps, { [HOME_ENV]: folder, [SELFCHECK_ENV]: '1' }), input: sampleOf(job.id, folder, deps) });
      if (outcome.state === 'missing') out.push(skipCheck(job.id, ui.text('selfcheckShellMissing', { shell: name }), { shell: name }));
      else if (outcome.state === 'ok') out.push(okCheck(job.id, ui.text('selfcheckRan'), { shell: name }));
      else out.push(badCheck(job.id, ui.text(job.failed, { why: outcome.why }), job.fix, { shell: name, output: outcome.output }));
    }
    const bar = out.find(({ id }) => id === 'statusline');
    if (bar?.status === 'pass') {
      const file = join(paths(folder).quota, READING_FILE);
      const found = await deps.fs.access(file).then(() => true, () => false);
      out.push(found ? okCheck('collector', ui.text('selfcheckCollectorOk'))
        : badCheck('collector', ui.text('selfcheckCollectorMissing'), jobs.find(({ id }) => id === 'statusline').fix));
    } else if (bar) out.push(skipCheck('collector', ui.text('selfcheckCollectorSkipped')));
    else out.push({ id: 'collector', ...reading });
  } finally { if (folder !== null) await deps.fs.rm(folder, { recursive: true, force: true }); }
  return out;
}

/** The configuration of the temporary state root: the allowed keys of the real one, as JSON; null when the real one is not there. */
async function allowed(deps) {
  const saved = await deps.fs.readFile(paths(deps.root).config, 'utf8').catch((error) => { if (error?.code === 'ENOENT') return null; throw error; });
  if (saved === null) return null;
  let value = {};
  try { value = JSON.parse(saved); } catch { value = {}; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) value = {};
  return `${JSON.stringify(Object.fromEntries(deps.config.selfcheck.stateKeys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]])))}\n`;
}

/** What the client sends on standard input: the status bar's rate limits, or the SessionStart event. */
function sampleOf(id, folder, deps) {
  const { sample } = deps.config.selfcheck;
  if (id === 'hook') {
    return JSON.stringify(Object.fromEntries(Object.entries(sample.hookInput).map(([key, value]) => [key, value.replaceAll('{temp}', folder)])));
  }
  const { fields, windows } = deps.collectorConfig;
  const resets = Math.floor((deps.now?.() ?? Date.now()) / 1000) + sample.resetsInSeconds;
  return JSON.stringify({ [fields.rateLimits]: Object.fromEntries(Object.keys(windows)
    .map((key) => [key, { [fields.usedPercentage]: sample.usedPercentage, [fields.resetsAt]: resets }])) });
}

/** 5. The link directory is on this terminal's PATH, or a new terminal is needed (said in the words the install already uses). */
async function pathCheck(record, deps) {
  const { ui, config } = deps;
  if (record.link === false) return skipCheck('path', ui.text('linkOff'), { quiet: true });
  if (binInPath(deps)) return okCheck('path', ui.text('selfcheckOnPath'), { quiet: true });
  const warning = await activationWarning({ ...deps, locale: ui.locale });
  if (windowsOf(deps) || deps.noPath || config.path.enabled === false) return okCheck('path', warning);
  for (const shell of Object.keys(config.path.shells)) {
    if (await managedProfile(deps, shell)) return okCheck('path', warning);
  }
  return badCheck('path', ui.text('selfcheckPathFail', { bin: deps.bin, command: config.command }),
    ui.text('selfcheckFixPath', { line: `export PATH=${quote(deps.bin)}:"$PATH"` }));
}

/** Runs the steps; one that cannot run is a failed check with the installer's retry, never an exception. */
async function guarded(id, deps, record, step) {
  try { return [await step()].flat(); }
  catch (error) {
    return [badCheck(id, deps.ui.text('selfcheckError'), deps.ui.text('selfcheckFixError', { again: again(record, deps) }), { output: error?.message })];
  }
}

/**
 * The checks of one installed client, in order.
 *
 * @param {object} record the installation record (as written)
 * @param {string} expected the version that was asked for or selected
 * @param {object} deps the installer's dependencies (fs, run, env, platform, ui, config, ...)
 * @returns {Promise<object[]>} the results
 */
export async function selfCheck(record, expected, deps) {
  const applies = record.client === deps.statuslineConfig.client;
  const ui = presenterOf(deps);
  deps = { ...deps, ui };
  const results = [
    ...await guarded('version', deps, record, () => versionCheck(record, expected, deps)),
    ...await guarded('command', deps, record, () => commandChecks(record, deps)),
    ...(applies ? await guarded('statusline', deps, record, () => runWritten(record, deps))
      : ['statusline', 'hook', 'collector'].map((id) => skipCheck(id, ui.text('selfcheckNotUsed'), { quiet: true }))),
    ...await guarded('path', deps, record, () => pathCheck(record, deps)),
  ];
  return results;
}

/** Tells the results: one row, then what failed (with its fix), what was skipped, and a PATH note. Returns whether any failed. */
export function reportSelfCheck(ui, results, client, { several = false } = {}) {
  const failed = results.filter(({ status }) => status === 'fail');
  const passed = results.filter(({ status }) => status === 'pass');
  const label = (check) => `${ui.text(LABELS[check.id])}${check.shell ? ` (${check.shell})` : ''}`;
  // A run of several clients tells each row's client, so no line of the run is the same as another.
  const said = (check) => (several && check.reason ? `${client}: ${check.reason}` : check.reason);
  if (failed.length) ui.row(ui.text('selfcheck', { client }), 'failed', ui.text('selfcheckBroken', { failed: failed.length, total: failed.length + passed.length }));
  else ui.row(ui.text('selfcheck', { client }), 'ok', ui.text('selfcheckPassed', { count: passed.length }));
  for (const check of results) {
    if (check.status === 'fail') {
      ui.row(label(check), 'failed', said(check));
      ui.note(ui.text('selfcheckFix', { fix: check.fix }));
      if (check.output) ui.detail(String(check.output).trim().split('\n').slice(-3).join(' | '));
    } else if (check.status === 'skip') {
      if (!check.quiet || ui.verbose) ui.row(label(check), 'skipped', said(check));
    } else if (ui.verbose && !check.noted) ui.row(label(check), 'ok', said(check));
  }
  return failed.length > 0;
}

/** Runs the check of one client and tells it; true when the installation works. */
export async function verifyInstall(record, expected, deps) {
  const results = await selfCheck(record, expected, deps);
  // A new terminal is needed when the link directory is not on this process's PATH but a profile persists it: the run
  // tells it once, at its end, whichever way it ends (the installer reads this list).
  const note = results.find(({ id, status, quiet, reason }) => id === 'path' && status === 'pass' && !quiet && reason);
  // The run says it once, at its end: the row of the check then stays quiet, whatever the verbosity.
  if (note && deps.pathNotes) { deps.pathNotes.push(note.reason); note.noted = true; }
  return !reportSelfCheck(presenterOf(deps), results, clientLabel(record.client), { several: Boolean(deps.backupPerClient) });
}
