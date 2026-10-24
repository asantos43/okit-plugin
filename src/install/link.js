import { join, delimiter, dirname, resolve, relative, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { readRecords } from './place.js';
import { constants } from 'node:fs';
import { basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const missingFile = (error) => { if (error.code !== 'ENOENT') throw error; return null; };

export async function chooseLinkDirectory(deps) {
  if (deps.config.linkDirectory || deps.platform === deps.config.windowsPlatform) return deps.bin;
  for (const parts of deps.config.path.candidates) {
    const candidate = join(deps.home, ...parts);
    if (!(deps.env.PATH ?? '').split(delimiter).includes(candidate)) continue;
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

export async function managePath(deps, remove = false) {
  const { fs, bin, config, env } = deps;
  const settings = config.path;
  const stateFile = join(deps.destination, settings.stateFile);
  const saved = await fs.readFile(stateFile, 'utf8').catch(missingFile);
  const state = saved ? JSON.parse(saved) : { profiles: [], windows: null };
  if (remove) {
    for (const item of state.profiles) {
      const content = await fs.readFile(item.path, 'utf8').catch(missingFile);
      if (content?.includes(item.block)) await fs.writeFile(item.path, content.replace(item.block, ''));
    }
    if (state.windows) await windowsPath(deps, state.windows, true);
    await fs.rm(stateFile, { force: true });
    return;
  }
  const say = (key, value) => deps.out(settings.messages[key].replaceAll('{value}', value));
  const windows = deps.platform === config.windowsPlatform;
  const separator = windows ? ';' : delimiter;
  const present = (env.PATH ?? '').split(separator).some((part) => windows ? part.toLowerCase() === bin.toLowerCase() : part === bin);
  say('link', join(bin, config.command));
  const enabled = settings.enabled && !deps.noPath;
  const changed = [];
  if (enabled && windows) {
    if (!state.windows && await windowsPath(deps, bin)) state.windows = bin;
    if (state.windows) changed.push(settings.messages.user);
  } else if (enabled && !present) {
    const shell = basename(env.SHELL ?? settings.fallbackShell);
    const profiles = settings.shells[shell] ?? settings.shells[settings.fallbackShell];
    const paths = [];
    for (const name of profiles.files) {
      const path = join(deps.home, name);
      if (await fs.stat(path).catch(missingFile)) paths.push(path);
    }
    if (!paths.length) paths.push(join(deps.home, profiles.login));
    for (const path of paths) {
      const content = await fs.readFile(path, 'utf8').catch(missingFile) ?? '';
      const block = profileBlock(settings, bin, shell === 'fish');
      if (!content.includes(block)) {
        if (content.includes(settings.begin)) throw new TypeError(settings.messages.edited.replaceAll('{value}', path));
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
  say(changed.length ? 'changed' : present ? 'existing' : enabled && windows ? 'existing' : 'manual', changed.join(', ') || bin);
  say('restart', '');
  const profile = windows ? null : changed[0] ?? state.profiles[0]?.path;
  if (profile) say('source', quote(profile));
  const newPath = present || !enabled ? env.PATH ?? '' : [bin, env.PATH].filter(Boolean).join(separator);
  let resolved;
  for (const directory of newPath.split(separator)) {
    if (!directory) continue;
    for (const extension of windows ? config.pathExtensions : ['']) {
      const path = join(directory, config.command + extension);
      try { await fs.access(path, windows ? constants.F_OK : constants.X_OK); resolved = path; break; }
      catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error; }
    }
    if (resolved) break;
  }
  say('resolved', resolved ?? settings.messages.missing);
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
  if (/[\r\n"%]/.test(target + config.node)) throw new TypeError('Unsupported shim path');
  return [
    { path: join(bin, `${config.command}.cmd`), content: `@echo off\r\n"${config.node}" "${target}" %*\r\n` },
    { path: join(bin, `${config.command}.ps1`), content: `& '${config.node.replaceAll("'", "''")}' '${target.replaceAll("'", "''")}' @args\n` },
  ];
}

export async function applyLink(record, deps, previous = null, remove = false) {
  const { fs, out, env, bin, config, platform } = deps;
  const plan = linkPlan(record, deps);
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
        if (!ours && /\.(cmd|ps1)$/i.test(item.path)) ours = await pluginExecutable(item.path, deps);
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
  for (const [index, item] of plan.entries()) {
    const info = await fs.lstat(item.path).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (info) {
      if (!info.isSymbolicLink() && !info.isFile()) { out(`Refused foreign link/shim: ${item.path}`); continue; }
      const actual = info.isSymbolicLink() ? await fs.readlink(item.path) : await fs.readFile(item.path, 'utf8');
      const expected = item.target ?? item.content;
      if (actual !== expected && actual !== (old[index]?.target ?? old[index]?.content)
        && !owned.some((items) => actual === (items[index]?.target ?? items[index]?.content))) {
        out(`Refused foreign link/shim: ${item.path}`); continue;
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
  if (deps.pathSetup) await managePath(deps, remove);
  else if (!remove && !(env.PATH || '').split(platform === config.windowsPlatform ? ';' : delimiter).includes(bin)) out(config.path.messages.manual.replaceAll('{value}', bin));
}
