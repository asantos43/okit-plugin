import { join, delimiter, dirname, resolve, relative, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { readRecords } from './place.js';

const pkg = createRequire(import.meta.url)('../../package.json');
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
  if (!remove && !(env.PATH || '').split(platform === config.windowsPlatform ? ';' : delimiter).includes(bin)) out(`Add to PATH: ${bin}`);
}
