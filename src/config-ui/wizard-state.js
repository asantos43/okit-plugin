import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { installConfig, installPaths, homeOf } from '../install/config.js';
import { detect } from '../install/menu.js';
import { activationMessage } from '../install/link.js';
import { discoverRecords } from '../install/place.js';

/** The installation records found at the destination, read-only (what a repair or a model-only run needs one of). */
export async function installedRecords({ root, env, platform, io = {}, options = {} }) {
  const fileSystem = io.fs ?? fs;
  const config = installConfig(io.config, options.destination ? { destination: options.destination } : {});
  const paths = config.dataRoots[platform] ? installPaths(config, { env, platform, home: io.home ?? homeOf(env, platform) })
    : { destination: options.destination ?? config.destination ?? root, bin: root };
  return (await discoverRecords(paths.destination, { fs: fileSystem, config, lenient: true })).records;
}

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
  // What a restarted server finds again: the installation records and the models a finished setup confirmed. Nothing is
  // replayed from before the restart; the wizard builds a new plan from these and asks consent again.
  const installed = {};
  try {
    for (const [client, record] of Object.entries(await installedRecords({ root, env, platform, io, options }))) installed[client] = { version: record.version ?? null };
  } catch { /* unreadable records: shown as not installed, a repair is then a fresh install */ }
  let profiles = {};
  try {
    const saved = JSON.parse(await fileSystem.readFile(join(root, 'config.json'), 'utf8'));
    if (saved?.setup?.done?.profiles && typeof saved.setup.done.profiles === 'object') profiles = saved.setup.done.profiles;
  } catch { /* no configuration yet */ }
  return { detection: clients, requirements, platform, installed, setupDone: profiles,
    activationMessage: activationMessage(config, { env, platform, bin: paths.bin, locale: io.locale ?? 'en' }),
    recovery: [{ command: config.command, args: ['doctor'] },
      { command: config.command, args: ['setup'] }], destination: paths.destination };
}
