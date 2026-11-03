import { join } from 'node:path';
import { HOME_ENV, SELFCHECK_ENV, paths } from '../store.js';
import { STATUSLINE_FILE } from '../quota/statusline-collector.js';
import { readRecordsLenient } from './place.js';
import { quote, binInPath, activationWarning, managedProfile, currentShell } from './link.js';
import { collectorCommandIndex, collectorExecutable, commandWords, settingsPath } from './statusline.js';
import { collectorArgsValid } from '../quota/statusline-collector.js';
import { cliScript, hookScript, hookNode, isAnotherNode, isOurHook } from './register.js';
import { mcpPlan, quotedWord, shown } from './mcp-register.js';
import { clientRoot } from './config.js';
import { presenterOf, clientLabel, redact, controlReason } from './present.js';
import { extraText } from './texts.js';
import { installationOf, missingFile, programWords } from './where.js';

// The check after an install or an update: the installation is only done when it WORKS on this machine. It reads back what
// the installer wrote (the record, the client's settings) and runs it the way the client will, in a temporary state root,
// so the person's own state is never written. Every check is { id, status: 'pass'|'fail'|'skip', shell?, reason, fix };
// the texts are the presenter's (en and pt-BR), so a result is already in the language of the run.

export const LABELS = { version: 'selfcheckVersion', command: 'selfcheckCommand', statusline: 'selfcheckStatusline',
  hook: 'selfcheckHook', collector: 'selfcheckCollector', mcp: 'selfcheckMcp', api: 'selfcheckApi', path: 'selfcheckPath' };

// The labels of the checks the presenter does not have yet (src/install/texts.js): the payload of the installation.
const EXTRA_LABELS = { payload: 'selfcheckPayload' };

/**
 * The label of a check, in the language of the run.
 *
 * @param {object} check the result of a check
 * @param {object} ui the presenter of the run
 * @returns {string} the label
 */
export function checkLabel(check, ui) {
  const extra = EXTRA_LABELS[check.id];
  if (extra) return extraText(extra, ui.locale);
  const key = LABELS[check.id];
  return key ? ui.text(key) : String(check.id);
}

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

/**
 * A path as it is compared; no trailing slash. On Windows: slashes, the drive of a Git Bash path and the case. On POSIX a
 * backslash is an ordinary character of a name, so it stays as it is and two different names never compare equal.
 */
function normal(path, deps) {
  let value = String(path);
  if (windowsOf(deps)) value = value.replaceAll('\\', '/').replace(/^\/([a-z])\//i, '$1:/').toLowerCase();
  return value.replace(/\/+$/, '');
}

/** The environment of a login launch: the link folder is taken OFF the PATH, so only a startup file of the shell can add it. */
function loginEnvironment(deps) {
  const key = Object.keys(deps.env).find((name) => name === 'PATH') ?? 'PATH';
  const kept = String(deps.env[key] ?? '').split(':').filter((folder) => folder && normal(folder, deps) !== normal(deps.bin, deps));
  return { ...deps.env, [key]: kept.join(':') };
}

/** The lines the shell printed for the command, trimmed and without the empty ones. */
const printedLines = (stdout) => String(stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

/** The first line the shell printed for the command: the path it resolves to (empty when it printed nothing). */
const firstLine = (stdout) => printedLines(stdout)[0] ?? '';

/** Whether that path is a file of the link directory: the shim is ours, not another program of the same name. */
function inBin(found, deps) {
  const value = normal(found, deps), cut = value.lastIndexOf('/');
  return cut > 0 && value.slice(0, cut) === normal(deps.bin, deps);
}

/** Whether that path names the command: the file name (after the last `/`) is the command itself (the shim's name). */
function namesCommand(found, deps) {
  const value = normal(found, deps);
  return value.slice(value.lastIndexOf('/') + 1) === deps.config.command;
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
// The command the person runs again, written for the shell of the platform: every word a shell would read
// differently is quoted, so a command or a client with a space in it is runnable as it is shown.
const again = async (record, deps) => shown([
  ...await programWords({ config: deps.config, platform: deps.platform, env: deps.env, fs: deps.fs }),
  'install', '--client', record.client,
], deps.platform);
// A path, written for the shell of the platform (the same quoting of the commands).
const asPath = (value, deps) => (value === undefined || value === null || value === '' ? '' : quotedWord(String(value), deps.platform));

/**
 * The budget of the probe of the MCP server: the time the configuration asks for, never more than the time of the
 * check minus the margin the server takes to go.
 *
 * The budget is clamped here and not refused by the schema: a configuration saved before the probe had a budget of its
 * own keeps working (the budget it asks for is shortened, not the installation refused).
 *
 * @param {object} config the settings of the installer
 * @returns {number} the budget of the probe, in milliseconds
 */
export function probeBudget(config) {
  const selfcheck = config?.selfcheck ?? {};
  const asked = Number(selfcheck.probeMs);
  const limit = Number(selfcheck.timeoutMs) - 2500;
  return Math.max(1, Math.min(Number.isFinite(asked) ? asked : 1, limit));
}

// Preserve the self-check exports for callers of the shared payload checks.
export { PROBE_FILE, requiredFiles, missingFile } from './where.js';

/** 1. The payload of the installation is whole: every file it lists is there. */
async function payloadCheck(record, deps) {
  const { ui } = deps;
  const missing = await missingFile(record, deps.config, deps.fs);
  if (missing === null) return okCheck('payload', extraText('selfcheckPayloadWhole', ui.locale));
  return badCheck('payload', extraText('selfcheckPayloadMissing', ui.locale, { file: asPath(missing, deps) }),
    ui.text('selfcheckFixVersion', { again: await again(record, deps) }));
}

/** 2. The version the record and the installed package say is the one that was asked for. */
async function versionCheck(record, expected, deps) {
  const { ui } = deps;
  const fix = ui.text('selfcheckFixVersion', { again: await again(record, deps) });
  // The records are read leniently: a record of another client that cannot be read is not this client's failure.
  const read = await readRecordsLenient(deps.destination, deps.fs, deps.config).catch(() => ({ records: {} }));
  const saved = read.records[record.client] ?? null;
  if (!saved) return badCheck('version', ui.text('selfcheckUnreadable', { path: asPath(deps.destination, deps) }), fix);
  if (saved.version !== expected) return badCheck('version', ui.text('selfcheckVersionRecord', { found: saved.version, expected }), fix);
  // The folder of the installation: the one the record names, or the one the installer places it in. A record of an
  // old shape names none, and the installation is still there.
  const where = installationOf(saved, deps.destination);
  if (!where) return badCheck('version', ui.text('selfcheckUnreadable', { path: asPath(deps.destination, deps) }), fix);
  const file = join(where, 'package.json');
  const installed = await deps.fs.readFile(file, 'utf8').then((text) => JSON.parse(text).version, () => undefined);
  if (installed === undefined) return badCheck('version', ui.text('selfcheckUnreadable', { path: asPath(file, deps) }), fix);
  if (installed !== expected) return badCheck('version', ui.text('selfcheckVersionPackage', { found: installed, expected }), fix);
  return okCheck('version', expected);
}

// Bash reads at login the first of these files that exists (and only that one): the file the fix names must be the one
// bash really reads, or the person would edit a file that is never read again.
const BASH_LOGIN_FILES = ['.bash_profile', '.bash_login', '.profile'];

// The POSIX shells that read `.profile` at login like `sh` does: when `$SHELL` names one of them, the `sh` entry of the
// check is the shell of the person. A shell outside this list (csh, nu, xonsh) reads no `.profile`, so it is not launched.
const POSIX_PROFILE_SHELLS = ['dash', 'ash', 'ksh', 'mksh', 'pdksh', 'busybox'];

/**
 * The file a shell reads at login: bash reads the first of its own that exists (the configured one when none does); zsh
 * reads `$ZDOTDIR/.zprofile` and fish reads `$XDG_CONFIG_HOME/fish/config.fish` when those variables are set (that is
 * where those shells look, not under the HOME); the others read the file the installer writes (their configured login
 * profile).
 *
 * @param {object} shell the shell of the check
 * @param {object} deps the installer's dependencies (fs, config, home)
 * @returns {Promise<string>} the path of the file
 */
async function loginFile(shell, deps) {
  const shells = deps.config.path.shells;
  const settings = shells[shell.name] ?? shells[deps.config.path.fallbackShell];
  if (shell.name === 'bash') {
    for (const name of BASH_LOGIN_FILES) {
      const path = join(deps.home, name);
      if (await deps.fs.access(path).then(() => true, () => false)) return path;
    }
  }
  const zdotdir = shell.name === 'zsh' ? variable(deps, 'ZDOTDIR') : null;
  if (zdotdir) return join(zdotdir, '.zprofile');
  const xdg = shell.name === 'fish' ? variable(deps, 'XDG_CONFIG_HOME') : null;
  if (xdg) return join(xdg, 'fish', 'config.fish');
  return join(deps.home, settings.login);
}

/** The login profile of a shell and the line the installer writes in it (its own PATH block holds the same words). */
async function loginProfile(shell, deps) {
  const bin = quote(deps.bin);
  return { file: await loginFile(shell, deps),
    line: shell.name === 'fish' ? `set -gx PATH ${bin} $PATH` : `export PATH=${bin}\${PATH:+":$PATH"}` };
}

/** Whether the file a shell reads at login holds the installer's PATH block (it is the line that file may be missing). */
async function loginHasBlock(file, deps) {
  const content = await deps.fs.readFile(file, 'utf8').catch(() => null);
  return Boolean(content?.includes(deps.config.path.begin));
}

/**
 * The launch the next terminal makes: the shell of the person's own terminal, as a login shell, resolving only the bare
 * command (never text of the person). Resolution shells read the person's own startup files BY DESIGN (the same as the
 * non-login launch below reads what applies to every start): a profile that exits early, fails or skips the PATH block is
 * exactly what this finds. Only that shell is launched (a profile that never received the block, or lost it, must not pass
 * in silence; another installed shell is not the one the next terminal starts, so its profile says nothing about this
 * install). A shell that reads `.profile` at login like `sh` does (dash, ash, ksh, mksh, pdksh, busybox) is the shell of the
 * person, and the `sh` entry is it; a shell outside that list (csh, nu, xonsh) reads no `.profile`, so it is not launched.
 * Any line the launch prints may be the resolution: a greeting printed before it, or a message printed after it (a trap on
 * EXIT), does not hide it. Only a line that names the command is the resolution; a line that names another program (of the
 * link folder or not) is not, and when no printed line names the command, the launch found nothing at all.
 * Returns `undefined` when there is nothing to prove, `true` when the command is found in the link folder, else the failed
 * check.
 */
async function loginCheck(record, shell, executable, deps) {
  const { ui, config } = deps;
  if (!shell.login || windowsOf(deps) || deps.noPath || config.path.enabled === false) return undefined;
  const own = currentShell(deps.env, config) ?? config.path.fallbackShell;
  // A shell that reads `.profile` at login like `sh` does (dash, ash, ksh) is the shell of the person, and the `sh`
  // entry is it: the entry reads the very file that shell reads.
  const posix = POSIX_PROFILE_SHELLS.includes(own);
  if (shell.name !== own && !(posix && shell.name === 'sh')) return undefined;
  // The link folder was already on the PATH of this terminal (the real one, before the login launch takes it off): the
  // PATH that works may come from another source, so a login launch would prove nothing about the profile.
  if (binInPath(deps)) return undefined;
  const outcome = await attempt(deps, { command: executable, env: loginEnvironment(deps),
    args: shell.login.map((argument) => argument.replaceAll('{command}', QUOTE[shell.quote](config.command))) });
  if (outcome.state === 'missing') return undefined;
  // Any line the launch printed may be the resolution, but only a line that names the command is one: a startup file that
  // prints another program (of the link folder or elsewhere) is not the command. When none of them is a file of the link
  // folder, the launch found no command.
  const printed = outcome.state === 'ok' ? printedLines(outcome.stdout) : [];
  const answers = printed.filter((line) => namesCommand(line, deps));
  if (answers.some((line) => inBin(line, deps))) return true;
  // The row names the last line that names the command (a program of the same name elsewhere is what it found); when no
  // printed line names the command, the launch found nothing (a greeting or any other line it printed is not the answer).
  const found = answers.at(-1) ?? '';
  const why = outcome.state === 'failed' ? outcome.why
    : found ? ui.text('selfcheckLoginOther', { found, bin: deps.bin }) : ui.text('selfcheckNothing');
  const { file, line } = await loginProfile(shell, deps);
  const tail = String(outcome.output ?? '').trim().split('\n').slice(-3).join('\n').slice(-400);
  // A file that reads at login and holds the block stops before it: the line goes before whatever stops it (a `return`), the
  // error of a command that fails (for example under `set -e`) is to be fixed and any `exit` of that file is to go (an `exit`
  // ends the login shell itself). A file without the block needs the line itself: the one the installer writes, or the
  // installer's own.
  const fix = await loginHasBlock(file, deps) ? ui.text('selfcheckFixLogin', { file: asPath(file, deps), line, again: await again(record, deps) })
    : ui.text('selfcheckFixLoginMissing', { file: asPath(file, deps), shell: shell.name, line, again: await again(record, deps) });
  return badCheck('command', ui.text('selfcheckLoginFail', { shell: shell.name, command: config.command, why }),
    fix, { shell: shell.name, output: tail });
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
      results.push(badCheck('command', ui.text('selfcheckElsewhere', { shell: shell.name, command: config.command, found: found || ui.text('selfcheckNothing'), bin: asPath(deps.bin, deps) }),
        ui.text('selfcheckFixElsewhere', { found: found || ui.text('selfcheckNothing'), bin: asPath(deps.bin, deps), shell: shell.name, again: await again(record, deps) }), { shell: shell.name }));
      continue;
    }
    if (outcome.state === 'ok') {
      // Found without a profile; the next terminal reads one, so the login launch must find it too.
      const login = await loginCheck(record, shell, executable, deps);
      if (login?.status === 'fail') { results.push(login); continue; }
      results.push(okCheck('command', ui.text(login === true ? 'selfcheckFoundLogin' : 'selfcheckFound'), { shell: shell.name }));
      continue;
    }
    results.push(badCheck('command', ui.text('selfcheckNotFound', { shell: shell.name, command: config.command, why: outcome.why }),
        ui.text('selfcheckFixCommand', { bin: asPath(deps.bin, deps), shell: shell.name, again: await again(record, deps) }),
        { shell: shell.name, output: outcome.output }));
  }
  if (!ran) {
    results.push(badCheck('command', ui.text('selfcheckNoShell', { shells: shellsOf(deps).map(({ name }) => name).join(', ') }),
      ui.text('selfcheckFixNoShell', { again: await again(record, deps) })));
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
  const script = cliScript(record.path), quoted = hookScript(record.path);
  // A hook is run only when it is EQUAL to what the registrar writes (`isOurHook`); one that names our script, however
  // quoted (single, double, none), is told and not run. `anotherNode`: the ones that differ only in the node path.
  const node = hookNode();
  const named = (Array.isArray(hookSettings?.hooks?.SessionStart) ? hookSettings.hooks.SessionStart : [])
    .flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : []))
    .filter((hook) => hook?.type === 'command' && typeof hook.command === 'string' && (hook.command.includes(script) || hook.command.includes(quoted)))
    .map((hook) => hook.command);
  const hooks = named.filter((command) => isOurHook(command, record.path, node));
  const altered = named.filter((command) => !isOurHook(command, record.path, node));
  return { bar, hookFile, statusline, present: line !== undefined && line !== null, hooks, altered: altered.length,
    anotherNode: altered.length > 0 && altered.every((command) => isAnotherNode(command, record.path)) };
}

/**
 * Whether a status bar string read back from the settings is EXACTLY what the installer's writer (`planStatusline`) produces
 * for this installation: its words, each quoted by `quote`, joined by one space (`words.map(quote).join(' ')`), the first
 * the collector's executable (`collectorExecutable`), then the subcommand, then nothing or `--previous` and its words. Anything
 * the writer would not have written (a double-quoted word, an unquoted one, a character the shell and `commandWords` read
 * differently, another interpreter) is not run. The shim (its bare name, or the absolute path Windows writes) is attested only by a shim of ours: the record must
 * say a link was made (with `--no-link` nothing of ours is in the link folder, and a file of that name there is not ours),
 * and the name must also resolve into the link folder (`inBin`). Returns `true`, `false`, or `'unlinked'` (no link).
 */
async function isOurBar(command, deps, runner, record) {
  if (command === null) return false;
  const words = commandWords(command);
  if (!words || words.map(quote).join(' ') !== command) return false;
  if (words[0] !== collectorExecutable(deps) || words[1] !== deps.statuslineConfig.subcommand) return false;
  const rest = words.slice(2);
  if ((rest.length && rest[0] !== '--previous') || !collectorArgsValid(rest)) return false;
  if (record.link === false) return 'unlinked';
  if (/[\\/]/.test(words[0])) return inBin(words[0], deps);
  // A bare name: the first thing the runner's shell finds for it, with the link folder in front, must be in that folder.
  if (!runner) return false;
  const outcome = await attempt(deps, { command: runner.executable, env: environment(deps),
    args: runner.shell.resolve.map((argument) => argument.replaceAll('{command}', QUOTE[runner.shell.quote](words[0]))) });
  return outcome.state === 'ok' && inBin(firstLine(outcome.stdout), deps);
}

/** 3 and 4. The status bar and hook strings run in the client's shell, with a temporary state root; the bar leaves a reading. */
async function runWritten(record, deps) {
  const { ui, config } = deps;
  const written = await writtenCommands(record, deps);
  const shell = shellNamed(deps, config.selfcheck.runner[deps.platform]);
  const executable = shell?.run ? await locate(shell, deps) : null;
  const verdict = written.statusline !== null
    && await isOurBar(written.statusline, deps, executable === null ? null : { shell, executable }, record);
  const ours = verdict === true;
  const out = [];
  const reading = { status: 'skip', reason: ui.text('selfcheckOff'), quiet: true };
  const repair = await again(record, deps);
  const jobs = [
    ...(ours ? [{ id: 'statusline', text: written.statusline, fix: ui.text('selfcheckFixStatusline', { again: repair, path: asPath(written.bar, deps) }), failed: 'selfcheckStatuslineFailed' }] : []),
    ...written.hooks.map((text) => ({ id: 'hook', text, fix: ui.text('selfcheckFixHook', { again: repair, path: asPath(written.hookFile, deps) }), failed: 'selfcheckHookFailed' })),
  ];
  if (verdict === 'unlinked') out.push(skipCheck('statusline', ui.text('selfcheckUnlinked'), { quiet: false }));
  else if (!ours) {
    // A bar that is called like ours but is not this installation's is told; one that is plainly the person's own stays quiet.
    const alike = written.statusline !== null && collectorCommandIndex(written.statusline, deps.statuslineConfig, config) > 0;
    out.push(skipCheck('statusline', ui.text(written.present ? 'selfcheckForeign' : 'selfcheckOff'), { quiet: !alike }));
  }
  if (written.altered) out.push(skipCheck('hook', ui.text(written.anotherNode ? 'selfcheckHookNode' : 'selfcheckHookForeign'), { quiet: false }));
  else if (!written.hooks.length) out.push(skipCheck('hook', ui.text('selfcheckOff'), { quiet: true }));
  if (!jobs.length) return [...out, { id: 'collector', ...reading }];

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
      const file = join(paths(folder).quota, STATUSLINE_FILE);
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

/**
 * The answer of the probe: the last line it printed, as JSON; null when it printed nothing or something else.
 *
 * @param {string} stdout what the probe printed
 * @returns {object|null}
 */
function readProbe(stdout) {
  const lines = printedLines(stdout);
  const last = lines.at(-1);
  if (last === undefined) return null;
  try {
    const value = JSON.parse(last);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// The code of a failure of the probe, and the text of the language of the run that says it. The probe never carries an
// English sentence into a row: it carries a code and its data, and the text is here.
const PROBE_TEXTS = Object.freeze({
  'start-failed': 'selfcheckProbeStart',
  stopped: 'selfcheckProbeStopped',
  timeout: 'selfcheckProbeTimeout',
  'init-error': 'selfcheckProbeInit',
  'list-error': 'selfcheckProbeList',
  'no-tools': 'selfcheckProbeNoTools',
  'bad-frame': 'selfcheckProbeBadFrame',
  'long-line': 'selfcheckProbeLongLine',
  'no-control-api': 'selfcheckProbeNoControl',
  'control-error': 'selfcheckProbeControl',
});

/**
 * What a failure of the probe says, in the language of the run.
 *
 * A failure with a code is the text of that code, with the data of the failure (the time of the budget, the name of
 * the frame that was wrong, the words of the server). A failure with no code (an answer of an older probe) is the
 * generic text of the check, with the words of the failure as raw detail. The tail of the error stream of the server
 * follows only in verbose mode, with temporary paths redacted and a localized label.
 *
 * @param {object} ui the presenter of the run
 * @param {unknown} error what the probe said
 * @param {{stderr?: string, folder: string, hide: string[]}} options temporary folders and server stderr
 * @returns {string} the sentence of the row
 */
function probeReason(ui, error, { stderr = '', folder, hide = [] } = {}) {
  const temporary = [folder, ...hide];
  let sentence;
  if (error === null || error === undefined || error === '') sentence = ui.text('selfcheckError');
  else if (typeof error === 'string') sentence = `${ui.text('selfcheckError')}: ${redact(error, temporary)}`;
  else {
    const key = PROBE_TEXTS[String(error.code ?? '')];
    sentence = key
      ? ui.text(key, { ms: error.ms, why: error.code === 'control-error'
        ? controlReason(ui, { code: error.cause, error: redact(error.why, temporary) })
        : redact(error.why, temporary), limit: error.limit })
      : `${ui.text('selfcheckError')}: ${redact(error.code ?? error.why ?? 'unknown', temporary)}`;
  }
  const tail = ui.verbose ? redact(String(stderr ?? '').trim(), temporary) : '';
  return tail === '' ? sentence : `${sentence} (${ui.text('selfcheckProbeStderr', { tail: tail.slice(-400) })})`;
}

/**
 * 5. The MCP server of this installation starts and answers, and its own control API answers one tool call.
 *
 * The server is started by the probe (`src/mcp/selfcheck-probe.js`), a program of this installation, under a temporary
 * state root: the person's own state is never touched. The probe answers one line of JSON and the installer reads it;
 * what it says is in the row, in the language of the run.
 *
 * @param {object} record the installation record
 * @param {object} deps the installer's dependencies
 * @returns {Promise<object[]>} the two results, `mcp` and `api`
 */
async function mcpChecks(record, deps) {
  const { ui, config } = deps;
  const fix = ui.text('selfcheckFixMcp', { command: await again(record, deps) });
  // A client with no MCP server of ours has nothing of ours to ask.
  if (!mcpPlan(record, deps)) {
    return [skipCheck('mcp', ui.text('selfcheckNotUsed'), { quiet: true }),
      skipCheck('api', ui.text('selfcheckNotUsed'), { quiet: true })];
  }
  const folder = await deps.fs.mkdtemp(join(deps.temporary, 'selfcheck-'));
  try {
    const outcome = await attempt(deps, { command: config.node,
      args: [join(record.path, 'src/mcp/selfcheck-probe.js'), join(record.path, config.mcp.server),
        String(probeBudget(config))],
      env: environment(deps, { [HOME_ENV]: folder, [SELFCHECK_ENV]: '1' }) });
    // A node that is not on the machine is a failure, not a skip: the client uses our MCP server, and it cannot work
    // without the node the installation is configured to run.
    if (outcome.state === 'missing') {
      const why = ui.text('selfcheckNodeMissing', { node: asPath(config.node, deps) });
      return [badCheck('mcp', why, ui.text('selfcheckFixNodeMissing', { node: asPath(config.node, deps), command: await again(record, deps) })),
        badCheck('api', why, ui.text('selfcheckFixNodeMissing', { node: asPath(config.node, deps), command: await again(record, deps) }))];
    }
    if (outcome.state !== 'ok') {
      const why = outcome.why;
      return [badCheck('mcp', ui.text('selfcheckMcpNoAnswer', { why }), fix, { output: outcome.output }),
        badCheck('api', ui.text('selfcheckMcpNoAnswer', { why }), fix, { output: outcome.output })];
    }
    const answer = readProbe(outcome.stdout);
    const mcp = answer?.mcp;
    if (answer === null || mcp === null || typeof mcp !== 'object') {
      // The probe printed nothing we can read: the check itself could not run.
      const why = ui.text('selfcheckError');
      return [badCheck('mcp', ui.text('selfcheckMcpNoAnswer', { why }), fix),
        badCheck('api', ui.text('selfcheckMcpNoAnswer', { why }), fix)];
    }
    if (mcp.ok !== true) {
      // There is no server to ask, so the API is not checked.
      const why = probeReason(ui, mcp.error, { stderr: answer.stderr, folder, hide: [deps.temporary] });
      return [badCheck('mcp', ui.text('selfcheckMcpNoAnswer', { why }), fix),
        skipCheck('api', ui.text('selfcheckApiSkipped'))];
    }
    const api = answer.api;
    if (api === null || typeof api !== 'object' || api.ok !== true) {
      const why = probeReason(ui, api?.error, { stderr: answer.stderr, folder, hide: [deps.temporary] });
      return [okCheck('mcp', ui.text('selfcheckMcpOk', { count: Number(mcp.tools ?? 0) })),
        badCheck('api', ui.text('selfcheckApiFailed', { why }), fix)];
    }
    return [okCheck('mcp', ui.text('selfcheckMcpOk', { count: Number(mcp.tools ?? 0) })),
      okCheck('api', ui.text('selfcheckApiOk'))];
  } finally { await deps.fs.rm(folder, { recursive: true, force: true }); }
}

/** 6. The link directory is on this terminal's PATH, or a new terminal is needed (said in the words the install already uses). */
async function pathCheck(record, deps) {
  const { ui, config } = deps;
  if (record.link === false) return skipCheck('path', ui.text('linkOff'), { quiet: true });
  if (binInPath(deps)) return okCheck('path', ui.text('selfcheckOnPath'), { quiet: true });
  const warning = await activationWarning({ ...deps, locale: ui.locale });
  if (windowsOf(deps) || deps.noPath || config.path.enabled === false) return okCheck('path', warning);
  for (const shell of Object.keys(config.path.shells)) {
    if (await managedProfile(deps, shell)) return okCheck('path', warning);
  }
  return badCheck('path', ui.text('selfcheckPathFail', { bin: asPath(deps.bin, deps), command: config.command }),
    ui.text('selfcheckFixPath', { line: `export PATH=${quote(deps.bin)}:"$PATH"` }));
}

/** Runs the steps; one that cannot run is a failed check with the installer's retry, never an exception. */
async function guarded(id, deps, record, step) {
  try { return [await step()].flat(); }
  catch (error) {
    return [badCheck(id, deps.ui.text('selfcheckError'), deps.ui.text('selfcheckFixError', { again: await again(record, deps) }), { output: error?.message })];
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
    ...await guarded('payload', deps, record, () => payloadCheck(record, deps)),
    ...await guarded('version', deps, record, () => versionCheck(record, expected, deps)),
    ...await guarded('command', deps, record, () => commandChecks(record, deps)),
    ...(applies ? await guarded('statusline', deps, record, () => runWritten(record, deps))
      : ['statusline', 'hook', 'collector'].map((id) => skipCheck(id, ui.text('selfcheckNotUsed'), { quiet: true }))),
    ...await guarded('mcp', deps, record, () => mcpChecks(record, deps)),
    ...await guarded('path', deps, record, () => pathCheck(record, deps)),
  ];
  return results;
}

/** Tells the results: one row, then what failed (with its fix), what was skipped, and a PATH note. Returns whether any failed. */
export function reportSelfCheck(ui, results, client, { several = false } = {}) {
  const failed = results.filter(({ status }) => status === 'fail');
  const passed = results.filter(({ status }) => status === 'pass');
  const label = (check) => `${checkLabel(check, ui)}${check.shell ? ` (${check.shell})` : ''}`;
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
