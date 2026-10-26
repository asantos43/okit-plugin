import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { detect } from './menu.js';
import { quote } from './link.js';

export function registrationPlan(record, deps, action = 'install') {
  const settings = deps.config.clients[record.client];
  const identity = `${deps.config.entry}@${deps.config.marketplace}`;
  if (settings.strategy !== 'marketplace') return [];
  if (action === 'uninstall') return [
    ...(settings.install ? [{ command: settings.executable, args: ['plugin', 'uninstall', identity] }] : []),
    { command: settings.executable, args: ['plugin', 'marketplace', 'remove', deps.config.marketplace] },
  ];
  return [
    ...(action === 'update' ? [{ command: settings.executable, args: ['plugin', 'marketplace', 'remove', deps.config.marketplace] }] : []),
    { command: settings.executable, args: ['plugin', 'marketplace', 'add', record.path] },
    ...(settings[action] ? [{ command: settings.executable, args: ['plugin', action, identity] }] : []),
  ];
}

export async function loadAdapter(record) {
  return import(pathToFileURL(join(record.path, 'adapters', record.client, 'index.js')).href);
}

export async function register(record, deps, action = 'install') {
  const settings = deps.config.clients[record.client];
  const commands = registrationPlan(record, deps, action);
  if (action === 'uninstall') await registerRole(record, deps, true);
  if (settings.strategy === 'module' && action === 'uninstall') {
    await removeOwnedModule(record, deps); return;
  }
  if (!await (deps.detect ?? detect)(settings.executable, deps)) {
    deps.out(`Missing executable ${settings.executable}; registration skipped. Install it and run:`);
    commands.forEach((item) => deps.out([item.command, ...item.args].join(' ')));
    if (settings.strategy === 'module') deps.out(`Install the module ${join(record.path, settings.module)} and skills through the adapter.`);
    return;
  }
  for (const command of commands) await deps.run(command);
  if (action !== 'uninstall') await registerRole(record, deps);
  if (settings.strategy === 'marketplace' && !settings[action] && action !== 'uninstall') deps.out('Open /plugins to install or update the registered plugin.');
  if (settings.strategy !== 'module') return;
  await registerModule(record, deps, settings);
}

async function registerRole(record, deps, remove = false) {
  let adapter;
  try { adapter = await (deps.loadAdapter ?? loadAdapter)(record); }
  catch (error) {
    deps.out(`Role delivery unsupported / Entrega de papel não suportada: ${error.message}`);
    return;
  }
  const command = `${quote(process.execPath)} ${quote(join(record.path, 'src/cli.js'))} hook session-start`;
  const opts = { env: deps.env, root: deps.clientRoot, command,
    nativeSupported: deps.platform !== 'win32' };
  if (record.previous && !remove && adapter.removeRole) {
    await adapter.removeRole({ ...opts, command: `${quote(process.execPath)} ${quote(join(record.previous.path, 'src/cli.js'))} hook session-start` });
  }
  const operation = remove ? adapter.removeRole : adapter.installRole;
  const result = operation ? await operation(opts) : { status: 'unsupported', reason: 'Adapter has no native role delivery / Adaptador sem entrega nativa de papel' };
  if (result.status !== 'ready') deps.out(`Role delivery / Entrega de papel: ${result.reason}`);
}

async function registerModule(record, deps, settings) {
  const adapter = await (deps.loadAdapter ?? loadAdapter)(record);
  const opts = { env: deps.env, root: deps.clientRoot };
  if (record.previous) await removeOwnedModule(record.previous, deps);
  const folder = await deps.fs.mkdtemp(join(deps.temporary, 'plugin-'));
  try {
    const wrapper = join(folder, `${deps.config.entry}.js`);
    const content = `export { default } from ${JSON.stringify(pathToFileURL(join(record.path, settings.module)).href)};\n`;
    await deps.fs.writeFile(wrapper, content);
    const result = await adapter.installHooks(wrapper, opts);
    if (result.reason === 'differs') deps.out(`Preserved edited module: ${result.path}`);
    for (const item of await deps.fs.readdir(join(record.path, 'skills'), { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const skill = await adapter.installSkill(item.name, join(record.path, 'skills', item.name), opts);
      for (const skipped of skill.skipped ?? []) if (skipped.reason === 'differs') deps.out(`Preserved edited skill: ${skipped.path}`);
    }
  } finally { await deps.fs.rm(folder, { recursive: true, force: true }); }
}

async function removeOwnedModule(record, deps) {
  const adapter = await (deps.loadAdapter ?? loadAdapter)(record);
  const path = join(adapter.configRoot({ env: deps.env, root: deps.clientRoot }), deps.config.pluginsDirectory, `${deps.config.entry}.js`);
  const settings = deps.config.clients[record.client];
  const content = `export { default } from ${JSON.stringify(pathToFileURL(join(record.path, settings.module)).href)};\n`;
  const actual = await deps.fs.readFile(path, 'utf8').catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
  if (actual === content) await deps.fs.unlink(path);
}
