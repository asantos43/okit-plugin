import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { detect } from './menu.js';
import { quote } from './link.js';
import { presenterOf, pick } from './present.js';

/**
 * The command of the SessionStart hook of an installation. The one source of the string: the installer writes it into the
 * client's settings, and the post-install check runs a hook only when what it reads back is EQUAL to this string, byte for
 * byte (`isOurHook`); it never parses a command to decide that it looks like ours.
 */
export const cliScript = (path) => join(path, 'src/cli.js');
export const hookScript = (path) => quote(cliScript(path));
const HOOK_ARGUMENTS = 'hook session-start';
/** The node the registrar writes into the hook: the one source for the writer (`hookCommand`) and for the check. */
export const hookNode = () => process.execPath;
export const hookCommand = (path, node = hookNode()) => `${quote(node)} ${hookScript(path)} ${HOOK_ARGUMENTS}`;

/** Whether a hook string read back from the settings is exactly what the registrar writes: equality, nothing else. */
export const isOurHook = (command, path, node = hookNode()) => typeof command === 'string' && command === hookCommand(path, node);

/**
 * Whether a hook string differs from the registrar's only in the node path (a node that was upgraded or moved): the
 * script and the arguments are ours, one single-quoted word stands where the node goes. Used only to choose the sentence
 * that tells why the hook was not run; a string is never run because of this.
 */
export function isAnotherNode(command, path) {
  const tail = ` ${hookScript(path)} ${HOOK_ARGUMENTS}`;
  if (typeof command !== 'string' || !command.endsWith(tail)) return false;
  const word = command.slice(0, -tail.length);
  return word.length >= 2 && word.startsWith("'") && word.endsWith("'") && !word.slice(1, -1).split("'\\''").join('').includes("'");
}

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
  const ui = presenterOf(deps);
  const commands = registrationPlan(record, deps, action);
  if (action === 'uninstall') await registerRole(record, deps, true);
  if (settings.strategy === 'module' && action === 'uninstall') {
    await removeOwnedModule(record, deps); return { status: 'ok', detail: ui.text('registerModule') };
  }
  if (!await (deps.detect ?? detect)(settings.executable, deps)) {
    const notes = [ui.text('registerMissingNext'), ...commands.map((item) => `  ${[item.command, ...item.args].join(' ')}`)];
    if (settings.strategy === 'module') notes.push(ui.text('registerModuleNext', { path: join(record.path, settings.module) }));
    return { status: 'skipped', detail: ui.text('registerMissing', { executable: settings.executable }), notes };
  }
  for (const command of commands) {
    ui.detail([command.command, ...command.args].join(' '));
    await deps.run(command);
  }
  if (action !== 'uninstall') await registerRole(record, deps);
  if (settings.strategy === 'module') {
    await registerModule(record, deps, settings);
    return { status: 'ok', detail: ui.text('registerModule') };
  }
  const manual = settings.strategy === 'marketplace' && !settings[action] && action !== 'uninstall';
  return { status: 'ok', detail: ui.text(manual ? 'registerMarketplaceManual' : action === 'uninstall' ? 'registerRemoved' : 'registerMarketplace') };
}

async function registerRole(record, deps, remove = false) {
  let adapter;
  try { adapter = await (deps.loadAdapter ?? loadAdapter)(record); }
  catch (error) {
    presenterOf(deps).detail(`${presenterOf(deps).text('roleUnsupported')}: ${error.message}`);
    return;
  }
  const command = hookCommand(record.path);
  const opts = { env: deps.env, root: deps.clientRoot, command,
    nativeSupported: deps.platform !== 'win32' };
  if (record.previous && !remove && adapter.removeRole) {
    await adapter.removeRole({ ...opts, command: hookCommand(record.previous.path) });
  }
  const operation = remove ? adapter.removeRole : adapter.installRole;
  const result = operation ? await operation(opts) : { status: 'unsupported', reason: 'Adapter has no native role delivery / Adaptador sem entrega nativa de papel' };
  const ui = presenterOf(deps);
  if (result.status !== 'ready') ui.detail(`${ui.text('roleUnsupported')}: ${pick(result.reason, ui.locale)}`);
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
    if (result.reason === 'differs') presenterOf(deps).warn(presenterOf(deps).text('keptModule', { path: result.path }));
    for (const item of await deps.fs.readdir(join(record.path, 'skills'), { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const skill = await adapter.installSkill(item.name, join(record.path, 'skills', item.name), opts);
      for (const skipped of skill.skipped ?? []) if (skipped.reason === 'differs') presenterOf(deps).warn(presenterOf(deps).text('keptSkill', { path: skipped.path }));
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
