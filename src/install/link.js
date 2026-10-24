import { join, delimiter } from 'node:path';
import { readRecords } from './place.js';

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
