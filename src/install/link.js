import { OperationalError, UsageError } from './exit.js';
import { PATH_STATE_SCHEMA, problemOf } from '../config-schema.js';
import { binInPath, commandInPath } from '../env/path.js';
import { join, delimiter, dirname, resolve, relative, isAbsolute, extname } from 'node:path';
import { createRequire } from 'node:module';
import { readRecords } from './place.js';
import { presenterOf, pick } from './present.js';
import { constants } from 'node:fs';
import { basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const missingFile = (error) => { if (error.code !== 'ENOENT') throw error; return null; };

/**
 * The extensionless shim for Git Bash (the shell Claude Code runs a status bar command through; it cannot run a .cmd by
 * bare name). POSIX sh, LF only: the paths are the Windows paths of the configuration, converted with cygpath when the
 * shell has it, and single-quoted so no character of a path is ever interpreted.
 *
 * @param {string} node the node executable
 * @param {string} target the command's script
 * @returns {string} the file's content
 */
export const shellShim = (node, target) => [
  '#!/bin/sh', `node=${quote(node)}`, `target=${quote(target)}`,
  'if command -v cygpath >/dev/null 2>&1; then', '  node=$(cygpath -u "$node")', '  target=$(cygpath -u "$target")', 'fi',
  'exec "$node" "$target" "$@"', ''].join('\n');

// Longer than this is not a shim of ours; the read of an unknown file on the PATH stays small.
const SHIM_MAX_BYTES = 4096;
const unquoted = (text) => text.match(/^'((?:[^']|'\\'')*)'$/)?.[1].replaceAll("'\\''", "'");

/** The script a shell shim of ours runs, or null when the content is not exactly what shellShim writes. */
function shimTarget(content) {
  const [, node, target] = content.split('\n');
  const nodePath = node?.startsWith('node=') ? unquoted(node.slice('node='.length)) : undefined;
  const targetPath = target?.startsWith('target=') ? unquoted(target.slice('target='.length)) : undefined;
  return nodePath !== undefined && targetPath !== undefined && content === shellShim(nodePath, targetPath) ? targetPath : null;
}

/**
 * The shell of the current terminal, from the environment only: the basename
 * of the configured variable, or null when the environment names no shell.
 *
 * @param {object} env the environment of the current terminal
 * @param {object} config the install configuration
 * @returns {string|null} the shell name
 */
export function currentShell(env, config) {
  const variable = config.path.shellVariable;
  const value = env?.[variable];
  if (typeof value !== 'string' || !value.trim()) return null;
  return basename(value).toLowerCase();
}

/**
 * The exact command that makes the command resolve in the given shell, or null
 * when the shell is unknown or no profile holds the managed PATH block.
 *
 * @param {object} config the install configuration
 * @param {string|null} shell the shell of the current terminal
 * @param {string|null} profile the profile file that holds the block
 * @param {string} bin the command link directory
 * @returns {string|null} the command to run
 */
export function activationCommand(config, shell, profile, bin) {
  const settings = config.path;
  const template = settings.activate?.[shell];
  if (!template || (template.includes('{file}') && !profile)) return null;
  const literal = shell === settings.windowsShell ? (value) => `'${value.replaceAll("'", "''")}'` : quote;
  return template.replaceAll('{file}', literal(profile ?? '')).replaceAll('{bin}', literal(bin ?? ''));
}

/**
 * The plain sentence with the exact command that makes the command resolve in
 * the current terminal, or the generic sentence when there is no command.
 *
 * @param {object} config the install configuration
 * @param {object} deps
 * @param {object} deps.env the environment of the current terminal
 * @param {string} deps.platform the platform of the current terminal
 * @param {string|null} deps.profile the profile file that holds the block
 * @param {string} deps.bin the command link directory
 * @param {string} [deps.locale] the language of the run (the configuration may carry both: one side is chosen)
 * @returns {string} the sentence for the user, in one language
 */
export function activationMessage(config, { env, platform, profile, bin, locale = 'en' }) {
  const settings = config.path;
  const shell = platform === config.windowsPlatform ? settings.windowsShell : currentShell(env, config);
  const command = activationCommand(config, shell, profile, bin);
  return command
    ? pick(settings.messages.activate, locale).replaceAll('{value}', command)
    : pick(settings.messages.activateTerminal, locale);
}

/**
 * The profile files of a shell that can hold the managed PATH block: the
 * existing ones, or the login profile when the shell has none.
 *
 * @param {object} deps
 * @param {object} deps.fs the filesystem
 * @param {object} deps.config the install configuration
 * @param {string} deps.home the home folder of the current user
 * @param {string|null} shell the shell of the current terminal
 * @returns {Promise<string[]>} the profile files, in order
 */
export async function shellProfiles(deps, shell) {
  const { fs, config, home } = deps;
  const settings = config.path;
  const shells = settings.shells[shell] ?? settings.shells[settings.fallbackShell];
  const paths = [];
  for (const name of shells.files) {
    const path = join(home, name);
    if (await fs.stat(path).catch(missingFile)) paths.push(path);
  }
  if (!paths.length) paths.push(join(home, shells.login));
  return paths;
}

/**
 * The profile file that holds the managed PATH block of the given shell, or
 * null when no profile of that shell holds it.
 *
 * @param {object} deps
 * @param {object} deps.fs the filesystem
 * @param {object} deps.config the install configuration
 * @param {string} deps.home the home folder of the current user
 * @param {string|null} shell the shell of the current terminal
 * @returns {Promise<string|null>} the profile file
 */
export async function managedProfile(deps, shell) {
  const { fs, config } = deps;
  if (!shell) return null;
  for (const path of await shellProfiles(deps, shell)) {
    const content = await fs.readFile(path, 'utf8').catch(missingFile);
    if (content?.includes(config.path.begin)) return path;
  }
  return null;
}

/**
 * Whether the current terminal's PATH contains the installation's bin directory.
 *
 * @param {object} deps
 * @param {object} deps.env the environment of the current terminal
 * @param {object} deps.config the install configuration
 * @param {string} deps.platform the platform of the current terminal
 * @param {string} deps.bin the command link directory
 * @returns {boolean} true when bin is already in PATH
 */
export { binInPath } from '../env/path.js';

/**
 * The warning that tells the user the exact command that makes the command
 * resolve in the current terminal, or null when bin is already in PATH.
 *
 * @param {object} deps
 * @param {object} deps.fs the filesystem
 * @param {object} deps.env the environment of the current terminal
 * @param {object} deps.config the install configuration
 * @param {string} deps.platform the platform of the current terminal
 * @param {string} deps.home the home folder of the current user
 * @param {string} [deps.locale] the language of the run
 * @returns {Promise<string|null>} the sentence for the user, in one language
 */
export async function activationWarning(deps) {
  const { config, env, platform } = deps;
  if (binInPath(deps)) return null;
  const profile = platform === config.windowsPlatform ? null : await managedProfile(deps, currentShell(env, config));
  return activationMessage(config, { env, platform, profile, bin: deps.bin, locale: deps.locale });
}

/**
 * The command that makes the command resolve in the current terminal, or null
 * when bin is already in PATH or this shell has no such command.
 */
export async function activationHint(deps) {
  const { config, env, platform } = deps;
  if (binInPath(deps)) return null;
  const windows = platform === config.windowsPlatform;
  const shell = windows ? config.path.windowsShell : currentShell(env, config);
  const profile = windows ? null : await managedProfile(deps, shell);
  return activationCommand(config, shell, profile, deps.bin);
}

export async function chooseLinkDirectory(deps) {
  if (deps.config.linkDirectory || deps.platform === deps.config.windowsPlatform) return deps.bin;
  for (const parts of deps.config.path.candidates) {
    const candidate = join(deps.home, ...parts);
    if (!binInPath({ ...deps, bin: candidate })) continue;
    try { if (!(await deps.fs.stat(candidate)).isDirectory()) continue; await deps.fs.access(candidate, constants.W_OK); return candidate; }
    catch (error) { if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
  }
  return join(deps.home, ...deps.config.path.candidates[0]);
}

const pkg = createRequire(import.meta.url)('../../package.json');
async function windowsPath(deps, bin, remove = false) {
  const literal = (value) => `'${value.replaceAll("'", "''")}'`;
  const variable = literal(deps.config.path.windowsVariable);
  const code = `$ErrorActionPreference='Stop'; $p=[Environment]::GetEnvironmentVariable(${variable},'User'); `
    + `$parts=if ($p) { @($p -split ';') } else { @() }; $bin=${literal(bin)}; `
    + (remove ? "$next=@($parts | Where-Object { $_ -ine $bin }); "
      : "if ($parts -icontains $bin) { Write-Output 'false'; exit }; $next=@($parts)+$bin; ")
    + `[Environment]::SetEnvironmentVariable(${variable},($next -join ';'),'User'); Write-Output 'true'`;
  const result = await (deps.pathExecute ?? execute)(deps.config.path.windowsExecutable,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { env: deps.env });
  return result.stdout.trim() === 'true';
}

function profileBlock(settings, bin, fish) {
  const quoted = quote(bin);
  const command = fish
    ? `if not contains -- ${quoted} $PATH\n  set -gx PATH ${quoted} $PATH\nend`
    : `case ":\${PATH-}:" in\n  *:${quoted}:*) ;;\n  *) export PATH=${quoted}\${PATH:+":$PATH"} ;;\nesac`;
  return `\n${settings.begin}\n${command}\n${settings.end}\n`;
}

// The state file of the PATH is written here and may have been edited: not JSON is unreadable (exit 1); JSON whose fields
// are not the ones written (PATH_STATE_SCHEMA in src/config-schema.js) is a refusal of usage (exit 2), never a TypeError below.
function pathState(text, file, command) {
  let state;
  try { state = JSON.parse(text); } catch { throw new OperationalError(`Cannot read PATH state: ${file}`); }
  const found = problemOf(PATH_STATE_SCHEMA, state);
  if (found) throw new UsageError(`Invalid PATH state: ${file} (${found.path || 'state'}); remove it and run ${command} install`);
  return state;
}

export async function managePath(deps, remove = false) {
  const { fs, bin, config, env } = deps;
  const settings = config.path;
  const stateFile = join(deps.destination, settings.stateFile);
  const saved = await fs.readFile(stateFile, 'utf8').catch(missingFile);
  const state = saved ? pathState(saved, basename(stateFile), config.command) : { profiles: [], windows: null };
  if (remove) {
    for (const item of state.profiles) {
      const content = await fs.readFile(item.path, 'utf8').catch(missingFile);
      if (content?.includes(item.block)) await fs.writeFile(item.path, content.replace(item.block, ''));
    }
    if (state.windows) await windowsPath(deps, state.windows, true);
    await fs.rm(stateFile, { force: true });
    return;
  }
  const windows = deps.platform === config.windowsPlatform;
  const separator = windows ? ';' : delimiter;
  const present = binInPath(deps);
  const enabled = settings.enabled && !deps.noPath;
  const changed = [];
  if (enabled && windows) {
    if (!state.windows && await windowsPath(deps, bin)) state.windows = bin;
    if (state.windows) changed.push(true);
  } else if (enabled && !present) {
    const shell = currentShell(env, config) ?? settings.fallbackShell;
    const paths = await shellProfiles(deps, shell);
    for (const path of paths) {
      const content = await fs.readFile(path, 'utf8').catch(missingFile) ?? '';
      const block = profileBlock(settings, bin, shell === 'fish');
      if (!content.includes(block)) {
        if (content.includes(settings.begin)) throw new UsageError(pick(settings.messages.edited, presenterOf(deps).locale).replaceAll('{value}', path));
        state.profiles.push({ path, block });
        await fs.mkdir(dirname(path), { recursive: true });
        await fs.mkdir(deps.destination, { recursive: true });
        await fs.writeFile(stateFile, JSON.stringify(state));
        await fs.writeFile(path, content + block);
      }
      changed.push(path);
    }
  }
  if (state.windows) {
    await fs.mkdir(deps.destination, { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify(state));
  }
  const newPath = present || !enabled ? env.PATH ?? '' : [bin, env.PATH].filter(Boolean).join(separator);
  const resolved = await commandInPath({ fs, config, windows, path: newPath, separator });
  const how = changed.length ? 'changed' : present || (enabled && windows) ? 'existing' : 'manual';
  const where = windows && changed.length ? null : changed.join(', ') || bin;
  const ui = presenterOf(deps);
  ui.detail(ui.global(`${ui.text('pathCheck')}: ${resolved ?? ui.text('pathMissing')}`));
  return { how, where, user: windows && changed.length > 0, command: config.command, link: join(bin, config.command),
    resolved, hint: await activationHint(deps) };
}
const inside = (root, path) => { const part = relative(root, path); return part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(part); };

export async function pluginExecutable(path, deps) {
  const { fs, config } = deps;
  const actual = await fs.realpath(path).catch(async (error) => {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    const target = await fs.readlink(path).catch((failure) => {
      if (!['ENOENT', 'ENOTDIR', 'EINVAL'].includes(failure.code)) throw failure;
      return null;
    });
    return target ? resolve(dirname(path), target) : resolve(path);
  });
  const destination = deps.destination ?? config.destination;
  if (destination) {
    for (const record of Object.values(await readRecords(destination, fs, config))) {
      for (let item = record; item; item = item.previous) if (inside(item.path, actual)) return true;
    }
  }
  if (/\.(cmd|ps1)$/i.test(actual)) {
    const content = await fs.readFile(actual, 'utf8');
    const target = content.match(/^@echo off\r?\n"[^"\r\n]+" "([^"\r\n]+)" %\*\r?\n?$/)?.[1]
      ?? content.match(/^& '[^'\r\n]+' '([^'\r\n]+)' @args\r?\n?$/)?.[1];
    if (target && resolve(target) !== actual) return pluginExecutable(target, deps);
  } else if (!extname(actual)) {
    // The extensionless shim of Git Bash: ours when it is exactly what shellShim writes.
    const info = await fs.stat(actual).catch((error) => {
      if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      return null;
    });
    const content = info?.isFile() && info.size <= SHIM_MAX_BYTES ? await fs.readFile(actual, 'utf8') : '';
    const target = shimTarget(content);
    if (target && resolve(target) !== actual) return pluginExecutable(target, deps);
  }
  for (let folder = dirname(actual); dirname(folder) !== folder; folder = dirname(folder)) {
    const metadata = await fs.readFile(join(folder, 'package.json'), 'utf8').catch(() => null);
    if (!metadata) continue;
    try {
      const candidate = JSON.parse(metadata);
      if (candidate.name === pkg.name && Object.values(candidate.bin ?? {}).some((bin) => resolve(folder, bin) === actual)) return true;
    } catch { /* Unrelated or malformed package metadata is not proof of ownership. */ }
  }
  return false;
}

export function linkPlan(record, deps) {
  const { config, bin, platform } = deps;
  const target = join(record.path, record.bin);
  if (platform !== config.windowsPlatform) return [{ path: join(bin, config.command), target }];
  // Quote for each shell; no unquoted interpolated command or arguments.
  if (/[\r\n"%]/.test(target + config.node)) throw new UsageError('Unsupported shim path');
  // The .cmd for PowerShell and cmd.exe (PowerShell finds it too, and a .ps1 would need an execution policy that allows
  // scripts), and the extensionless shim for Git Bash. The order is the index that updates and ownership compare by.
  return [{ path: join(bin, `${config.command}.cmd`), content: `@echo off\r\n"${config.node}" "${target}" %*\r\n` },
    { path: join(bin, config.command), content: shellShim(config.node, target) }];
}

// What an earlier version wrote as the .ps1 shim of a record.
const scriptContent = (record, config) => `& '${config.node.replaceAll("'", "''")}' '${join(record.path, record.bin).replaceAll("'", "''")}' @args\n`;

/** Removes the .ps1 shims this plugin wrote before the Windows command became a .cmd only; a file that is not ours stays. */
async function removeOwnedScripts(record, previous, deps) {
  const { fs, config, bin } = deps;
  if (deps.platform !== config.windowsPlatform) return;
  const known = new Set();
  for (const start of [record, previous, ...Object.values(await readRecords(deps.destination ?? config.destination, fs, config))]) {
    for (let item = start; item; item = item.previous) if (item.path && item.bin) known.add(scriptContent(item, config));
  }
  for (const command of [config.command, ...(config.legacyCommands ?? [])]) {
    const path = join(bin, `${command}.ps1`);
    const info = await fs.lstat(path).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
    if (!info?.isFile()) continue;
    const content = await fs.readFile(path, 'utf8');
    if (known.has(content) || await pluginExecutable(path, deps)) await fs.unlink(path);
  }
}

export async function applyLink(record, deps, previous = null, remove = false) {
  const { fs, env, bin, config, platform } = deps;
  const ui = presenterOf(deps);
  const plan = linkPlan(record, deps);
  await removeOwnedScripts(record, previous, deps);
  for (const command of config.legacyCommands ?? []) {
    if (command === config.command) continue;
    const legacyDeps = { ...deps, config: { ...config, command } };
    for (const item of linkPlan(record, legacyDeps)) {
      const info = await fs.lstat(item.path).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
      if (!info) continue;
      let ours = info.isSymbolicLink() && await pluginExecutable(item.path, deps);
      if (info.isFile()) {
        const content = await fs.readFile(item.path, 'utf8');
        const records = [record, previous, ...Object.values(await readRecords(deps.destination ?? config.destination, fs, config))];
        for (let current of records) for (; current; current = current.previous) {
          if (linkPlan(current, legacyDeps).some((entry) => entry.content === content)) ours = true;
        }
        if (!ours && item.content !== undefined) ours = await pluginExecutable(item.path, deps);
      }
      if (ours) await fs.unlink(item.path);
    }
  }
  const old = previous ? linkPlan(previous, deps) : [];
  const owned = [];
  if (deps.destination) {
    for (const current of Object.values(await readRecords(deps.destination, fs, config))) {
      for (let item = current; item; item = item.previous) owned.push(linkPlan(item, deps));
    }
  }
  let conflict;
  for (const [index, item] of plan.entries()) {
    const info = await fs.lstat(item.path).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (info) {
      if (!info.isSymbolicLink() && !info.isFile()) {
        ui.warn(ui.text('foreignLink', { path: item.path })); conflict = item.path; continue;
      }
      const actual = info.isSymbolicLink() ? await fs.readlink(item.path) : await fs.readFile(item.path, 'utf8');
      const expected = item.target ?? item.content;
      if (actual !== expected && actual !== (old[index]?.target ?? old[index]?.content)
        && !owned.some((items) => actual === (items[index]?.target ?? items[index]?.content))) {
        ui.warn(ui.text('foreignLink', { path: item.path })); conflict = item.path; continue;
      }
      if (!remove && actual === expected) continue;
      await fs.unlink(item.path);
    }
    if (!remove) {
      await fs.mkdir(bin, { recursive: true });
      if (item.target) await fs.symlink(item.target, item.path);
      else await fs.writeFile(item.path, item.content, { flag: 'wx' });
    }
  }
  if (conflict && !remove) return { how: 'conflict', where: conflict, command: config.command };
  if (deps.pathSetup) return await managePath(deps, remove);
  if (!remove && !binInPath(deps)) return { how: 'manual', where: bin, command: config.command, link: join(bin, config.command), hint: null };
  return { how: 'existing', where: bin, command: config.command, link: join(bin, config.command), hint: null };
}
