import { delimiter, join } from 'node:path';

export async function detect(executable, { fs, env, config, platform }) {
  for (const directory of (env.PATH || '').split(platform === config.windowsPlatform ? ';' : delimiter)) {
    if (!directory) continue;
    for (const suffix of platform === config.windowsPlatform ? config.pathExtensions : ['']) {
      try {
        const path = join(directory, executable + suffix);
        const info = await fs.stat(path);
        if (info.isFile() && (platform === config.windowsPlatform || (info.mode & 0o111))) return path;
      } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    }
  }
  return null;
}

export async function chooseClient(client, deps) {
  const entries = await Promise.all(Object.entries(deps.config.clients).map(async ([name, settings]) => ({
    name, detected: Boolean(await (deps.detect ?? detect)(settings.executable, deps)),
  })));
  if (client) {
    if (!entries.some((item) => item.name === client)) throw new TypeError(`Invalid client ${client}; choose: ${entries.map((item) => item.name).join(', ')}`);
    return client;
  }
  entries.forEach((item, index) => deps.out(`${index + 1}. ${item.name}${item.detected ? ' (detected)' : ''}`));
  const found = entries.filter((item) => item.detected);
  if (!deps.tty) {
    if (found.length !== 1) throw new TypeError('Without TTY select --client from the list');
    deps.out(`Selected the only detected client: ${found[0].name}`);
    return found[0].name;
  }
  const answer = await deps.read('Client number: ');
  if (!/^[1-9][0-9]*$/.test(answer) || !entries[Number(answer) - 1]) throw new TypeError('Invalid client number');
  return entries[Number(answer) - 1].name;
}
