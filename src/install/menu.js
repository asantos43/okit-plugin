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
    if (client === 'all') {
      const found = entries.filter((item) => item.detected).map((item) => item.name);
      if (!found.length) throw new TypeError('No detected clients');
      return found;
    }
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
  const answer = (await deps.read('Client numbers (1,3) or all: ')).trim();
  if (answer === 'all') return entries.map((item) => item.name);
  const numbers = answer.split(',').map((value) => value.trim());
  if (numbers.some((value) => !/^[1-9][0-9]*$/.test(value) || !entries[Number(value) - 1])) throw new TypeError('Invalid client number');
  const names = [...new Set(numbers.map((value) => entries[Number(value) - 1].name))];
  return names.length === 1 ? names[0] : names;
}
