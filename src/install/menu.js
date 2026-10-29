import { UsageError } from './exit.js';
import { delimiter, join } from 'node:path';
import { presenterOf } from './present.js';

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
      if (!found.length) throw new UsageError('No detected clients');
      return found;
    }
    if (!entries.some((item) => item.name === client)) throw new UsageError(`Invalid client ${client}; choose: ${entries.map((item) => item.name).join(', ')}`);
    return client;
  }
  const ui = presenterOf(deps);
  const found = entries.filter((item) => item.detected);
  if (!deps.tty && found.length === 1) return found[0].name;
  ui.explain([ui.text('clientChoose'), ...entries.map((item, index) => `  ${index + 1}. ${item.name}${item.detected ? ` (${ui.text('clientDetected')})` : ''}`)]);
  if (!deps.tty) throw new UsageError(ui.text('clientNoTty'));
  const answer = (await deps.read(ui.text('clientAsk'))).trim();
  if (answer === 'all') return entries.map((item) => item.name);
  const numbers = answer.split(',').map((value) => value.trim());
  if (numbers.some((value) => !/^[1-9][0-9]*$/.test(value) || !entries[Number(value) - 1])) throw new UsageError('Invalid client number');
  const names = [...new Set(numbers.map((value) => entries[Number(value) - 1].name))];
  return names.length === 1 ? names[0] : names;
}
