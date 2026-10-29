import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';

export function binInPath({ snapshot, env, config, platform, bin }) {
  if (typeof snapshot?.plugin?.onPath === 'boolean') return snapshot.plugin.onPath;
  const windows = platform === config.windowsPlatform;
  const path = windows ? Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] : env.PATH;
  const normalize = (value) => {
    const directory = windows ? value.replaceAll('\\', '/') : value;
    const normalized = directory.replace(/\/+$/, '') || '/';
    return windows ? normalized.toLowerCase() : normalized;
  };
  return (path ?? '').split(windows ? ';' : delimiter).some((part) => part && normalize(part) === normalize(bin));
}


export async function commandInPath({ fs, config, windows, path, separator }) {
  let resolved;
  for (const directory of path.split(separator)) {
    if (!directory) continue;
    // On Windows a file with no extension (the shim of Git Bash) is not a command of cmd.exe or PowerShell.
    for (const extension of windows ? config.pathExtensions.filter(Boolean) : ['']) {
      const path = join(directory, config.command + extension);
      try { await fs.access(path, windows ? constants.F_OK : constants.X_OK); resolved = path; break; }
      catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error; }
    }
    if (resolved) break;
  }
  return resolved;
}
