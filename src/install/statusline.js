import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { constants } from 'node:fs';
import { clientRoot } from './config.js';
import { quote } from './link.js';
import { saveRecord } from './place.js';
import { presenterOf } from './present.js';
import { collectorArgsValid } from '../quota/statusline-collector.js';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const missing = (error) => { if (error.code !== 'ENOENT') throw error; return null; };
const unreadable = (deps) => presenterOf(deps).text('statuslineError');

// Tokenize only literal words. Anything requiring shell interpretation uses
// the configured wrapper, preserving the original command as one argument.
export function commandWords(command) {
  const words = []; let word = ''; let active = false; let quoted = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if ((!quoted && /[|&;<>$`\n\r()*?{}\[\]~#%!^]/.test(char))
      || (quoted === '"' && /[$`]/.test(char))) return null;
    if (char === '\\' && quoted === '"' && command[i + 1] && !/["\\$`\n]/.test(command[i + 1])) {
      word += char; active = true;
    } else if (char === '\\' && quoted !== "'") { if (++i === command.length) return null; word += command[i]; active = true; }
    else if (char === quoted) quoted = null;
    else if (!quoted && (char === '"' || char === "'")) { quoted = char; active = true; }
    else if (!quoted && /\s/.test(char)) { if (active) words.push(word); word = ''; active = false; }
    else { word += char; active = true; }
  }
  if (quoted) return null;
  if (active) words.push(word);
  return words;
}

// Recognize an invocation, not a mention in arguments to echo or another bar.
export function collectorCommandIndex(command, settings, config = {}) {
  const words = commandWords(command);
  if (!words) return -1;
  const name = (word = '') => word.replaceAll('\\', '/').split('/').at(-1)
    .replace(/\.(exe|cmd|bat|ps1)$/i, '');
  const executables = ['okit-plugin', 'okit', config.command, ...(config.legacyCommands ?? [])]
    .filter(Boolean).map(name);
  // Arguments the collector refuses make it exit before collecting: not a working registration.
  if (words[1] === settings.subcommand && executables.includes(name(words[0]))) {
    return collectorArgsValid(words.slice(2)) ? words.indexOf(settings.subcommand, 1) : -1;
  }
  const script = words[1]?.replaceAll('\\', '/');
  if (name(words[0]) === 'node' && words[2] === settings.subcommand
    && (script === 'src/cli.js' || script?.endsWith('/src/cli.js') || script?.split('/').at(-1) === 'plugin.js')) {
    return collectorArgsValid(words.slice(3)) ? words.indexOf(settings.subcommand, 1) : -1;
  }
  return -1;
}

// The executable the status bar command names. Claude Code runs it through Git Bash on Windows, which cannot run a .cmd
// by bare name: there it is the absolute path of the extensionless shim (forward slashes, as Git Bash writes them).
function collectorExecutable(deps) {
  const { config, bin, platform } = deps;
  return platform === config.windowsPlatform && bin ? join(bin, config.command).replaceAll('\\', '/') : config.command;
}

export async function planStatusline(record, deps) {
  const settings = deps.statuslineConfig;
  const path = record.statusline?.path ?? join(clientRoot(record.client, deps), settings.settingsFile);
  const original = await deps.fs.readFile(path).catch(missing);
  const value = original === null ? {} : JSON.parse(original.toString('utf8'));
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(unreadable(deps));
  const previous = value.statusLine;
  if (previous !== undefined && (!previous || previous.type !== 'command' || typeof previous.command !== 'string')) throw new Error(unreadable(deps));
  const words = commandWords(previous?.command ?? '');
  const collectorIndex = collectorCommandIndex(previous?.command ?? '', settings, deps.config);
  const owned = collectorIndex > 0;
  // A collector at another path is already registered; only update a command
  // whose original settings this installation can restore.
  const executable = collectorExecutable(deps);
  if (owned && (!record.statusline || (collectorIndex === 1 && words[0] === executable))) return null;
  let command;
  if (owned) command = [executable, ...words.slice(collectorIndex)].map(quote).join(' ');
  else {
    const prior = previous?.command ? (words ?? [...settings.shell[deps.platform], previous.command]) : [];
    command = [executable, settings.subcommand, ...(prior.length ? ['--previous', ...prior] : [])].map(quote).join(' ');
  }
  value.statusLine = { ...previous, type: 'command', command };
  return { path, original, previous, bytes: Buffer.from(`${JSON.stringify(value, null, 2)}\n`) };
}

async function writeBytes(path, bytes, fs) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await fs.mkdir(dirname(path), { recursive: true });
  try {
    const stat = await fs.stat(path).catch(missing);
    if (stat) await fs.access(path, constants.W_OK);
    await fs.writeFile(temp, bytes, { flag: 'wx', mode: stat ? stat.mode & 0o777 : 0o600 });
    await fs.rename(temp, path);
  } finally { await fs.rm(temp, { force: true }); }
}

export async function applyStatusline(record, plan, deps) {
  const backup = record.statusline?.backup ?? join(deps.root, deps.statuslineConfig.backupFile);
  const statusline = record.statusline ?? { path: plan.path, backup, existed: plan.original !== null,
    previous: plan.previous };
  if (!record.statusline) await writeBytes(backup, plan.original ?? Buffer.alloc(0), deps.fs);
  try {
    await writeBytes(plan.path, plan.bytes, deps.fs);
    await saveRecord(deps.destination, { ...record, statusline: { ...statusline, hash: hash(plan.bytes) } }, deps);
  } catch (error) {
    if (plan.original === null) await deps.fs.rm(plan.path, { force: true });
    else await writeBytes(plan.path, plan.original, deps.fs).catch(() => {});
    if (!record.statusline) await deps.fs.rm(backup, { force: true });
    throw error;
  }
}

export async function registerStatusline(record, flags, deps) {
  if (!appliesStatusline(record, flags, deps)) return null;
  const ui = presenterOf(deps);
  if (!flags.statusline && !record.statusline && !deps.tty) {
    return { status: 'skipped', detail: ui.text('statuslineHow', { command: `${deps.config.command} install --client ${record.client} --statusline` }) };
  }
  try {
    const plan = await planStatusline(record, deps);
    if (!plan) return { status: 'ok', detail: ui.text('statuslineDone') };
    ui.detail(`${ui.text('statuslineFile')}: ${plan.path}`);
    ui.detail(`${ui.text('statuslineAdd')}: ${deps.config.command} ${deps.statuslineConfig.subcommand}`);
    ui.detail(`${ui.text('statuslineKeep')}: ${plan.previous?.command ?? ui.text('statuslineNone')}`);
    if (deps.dryRun || flags.check) return { status: 'plan', detail: plan.path };
    if (!flags.statusline && !record.statusline) {
      const accepted = await ui.confirm(deps.read, { explain: [ui.text('statuslineExplain'), ui.text('statuslineExplain2', { path: plan.path })],
        question: ui.text('statuslineAsk') });
      if (!accepted) return { status: 'skipped', detail: ui.text('statuslineDeclined') };
    }
    await applyStatusline(record, plan, deps);
    return { status: 'ok', detail: plan.path };
  } catch (error) { throw new Error(unreadable(deps), { cause: error }); }
}

/** Whether the quota step belongs to this run: the client has a status bar and it was not turned off. */
export function appliesStatusline(record, flags, deps) {
  return record.client === deps.statuslineConfig.client && !flags['no-statusline'];
}

export async function undoStatusline(record, deps) {
  if (!record.statusline) return null;
  const saved = record.statusline;
  const ui = presenterOf(deps);
  if (deps.dryRun) return { status: 'plan', detail: saved.path };
  let notes = [];
  try {
    const bytes = await deps.fs.readFile(saved.path).catch(missing);
    if (bytes && hash(bytes) === saved.hash) {
      if (saved.existed) await writeBytes(saved.path, await deps.fs.readFile(saved.backup), deps.fs);
      else await deps.fs.rm(saved.path);
    } else if (bytes) {
      const value = JSON.parse(bytes.toString('utf8'));
      if (collectorCommandIndex(value.statusLine?.command ?? '', deps.statuslineConfig, deps.config) > 0) {
        if (saved.previous === undefined) delete value.statusLine;
        else value.statusLine = saved.previous;
        await writeBytes(saved.path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), deps.fs);
      }
      notes = [ui.text('statuslineKept')];
    }
    await deps.fs.rm(saved.backup, { force: true });
    return { status: 'ok', detail: saved.path, notes };
  } catch (error) { throw new Error(unreadable(deps), { cause: error }); }
}
