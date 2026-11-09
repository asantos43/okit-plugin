import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { installConfig, installPaths, homeOf } from '../install/config.js';
import { detect } from '../install/menu.js';
import { activationMessage } from '../install/link.js';

/** Read-only first-run observations; no initialization, locks or setup writes. */
export async function wizardState({ root, env, platform, run, options, io = {} }) {
  const fileSystem = io.fs ?? fs;
  const pkg = JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const config = installConfig(io.config, options.destination ? { destination: options.destination } : {});
  const home = io.home ?? homeOf(env, platform);
  const paths = config.dataRoots[platform] ? installPaths(config, { env, platform, home })
    : { destination: options.destination ?? config.destination ?? root, bin: root };
  const clients = await Promise.all(Object.entries(config.clients).map(async ([client, settings]) => {
    const executable = await (io.detect ?? detect)(settings.executable, { fs: fileSystem, env, platform, config });
    let version = null;
    if (executable) {
      try { version = String((await run({ command: executable, args: ['--version'], env,
        timeout: 1500, maxBuffer: 8192 })).stdout ?? '').slice(0, 512).trim(); } catch { /* unknown version */ }
    }
    return { client, executable: executable || null, version, installed: Boolean(executable) };
  }));
  const requirements = [{ key: 'node', ok: Number(process.versions.node.split('.')[0]) >= Number(pkg.engines.node.match(/\d+/)[0]),
    actual: process.versions.node, required: pkg.engines.node, remedyKey: 'installNode' },
  { key: 'platform', ok: Boolean(config.systems[platform] && config.architectures[io.arch ?? process.arch]),
    actual: `${platform}/${io.arch ?? process.arch}`, remedyKey: 'supportedPlatform' }];
  for (const path of [root, paths.destination]) {
    let parent = path;
    while (!await fileSystem.stat(parent).catch(() => null) && dirname(parent) !== parent) parent = dirname(parent);
    let ok = true;
    try { await fileSystem.access(parent, constants.W_OK); } catch { ok = false; }
    requirements.push({ key: 'permissions', ok, path: parent, remedyKey: 'writePermission' });
  }
  requirements.push({ key: 'tools', ok: true, remedyKey: 'localTools', actual: 'Node.js' });
  return { detection: clients, requirements, platform,
    activationMessage: activationMessage(config, { env, platform, bin: paths.bin, locale: io.locale ?? 'en' }),
    recovery: [{ command: config.command, args: ['doctor'] },
      { command: config.command, args: ['setup'] }], destination: paths.destination };
}
