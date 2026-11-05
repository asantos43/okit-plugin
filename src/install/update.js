import { UsageError } from './exit.js';
import { basename, join } from 'node:path';
import { saveRecord } from './place.js';
import { header } from './account-scope.js';
import { register, loadAdapter, registrationPlan } from './register.js';
import { mcpPlan, shown } from './mcp-register.js';
import { applyLink } from './link.js';
import { presenterOf, headerValues, clientLabel, finish, finishLink } from './present.js';

// What is never copied from the folder of an account, whatever the name is under: the login of the client.
const CREDENTIALS = /^(\.credentials|auth\.json$|keychain)|token|credential|secret|\.key$|\.pem$/i;

/**
 * The files of an account folder that the plugin itself writes (the settings with the status bar and the hooks, the
 * hooks file, the configuration of Codex, the plugin entry), by name: the backup of an account never holds anything
 * else, so a login (`.credentials.json`, `auth.json`, ...) is never copied.
 */
async function copyPluginFiles(source, target, deps) {
  const names = [deps.statuslineConfig?.settingsFile ?? 'settings.json', 'config.toml', join('hooks', 'hooks.json'), deps.config.pluginsDirectory]
    .filter((name) => name && !CREDENTIALS.test(basename(name)));
  for (const name of names) {
    const from = join(source, name);
    if (!await deps.fs.stat(from).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; })) continue;
    await deps.fs.cp(from, join(target, name), { recursive: true, errorOnExist: true,
      filter: (path) => !CREDENTIALS.test(basename(path)) });
  }
}

export async function backup(record, deps) {
  const base = join(deps.destination, 'backups', String(deps.now()));
  const folder = deps.backupPerClient ? join(base, record.client) : base;
  const sources = [deps.root, ...(deps.config.backupPaths ?? [])];
  // With accounts the folders of the clients are the folders of the accounts: only the plugin's own files are kept.
  const accounts = new Set();
  if (deps.accountScope) accounts.add(deps.clientRoot);
  else if (deps.clientRoot) sources.push(deps.clientRoot);
  else try {
    const adapter = await (deps.loadAdapter ?? loadAdapter)(record);
    sources.push(adapter.configRoot({ env: deps.env, root: deps.clientRoot }));
  } catch (error) { if (!['ERR_MODULE_NOT_FOUND', 'ENOENT'].includes(error.code)) throw error; }
  // An update moves every registered account: the folder of each one is kept too.
  for (const root of deps.accountRoots ?? []) accounts.add(root);
  sources.push(...accounts);
  await deps.fs.mkdir(folder, { recursive: true });
  for (const [index, source] of [...new Set(sources)].entries()) {
    if (!await deps.fs.stat(source).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; })) continue;
    if (accounts.has(source)) { await copyPluginFiles(source, join(folder, String(index)), deps); continue; }
    await deps.fs.cp(source, join(folder, String(index)), { recursive: true, errorOnExist: true,
      filter: (path) => path !== deps.destination && !path.startsWith(`${deps.destination}/`) });
  }
  await deps.fs.writeFile(join(folder, 'sources.json'), JSON.stringify(sources));
  return folder;
}

/**
 * Registers the payload in the folder of every account of the run, one after the other, and tells it as one step: the
 * first account's detail, any account that could not be registered (skipped) as the status, and all the notes.
 *
 * @param {object} record the record of the payload
 * @param {{deps: object, action: string}[]} targets the dependencies of each account and what to do in it
 * @param {object} deps the dependencies of the run
 * @returns {Promise<{status: string, detail: string, notes: string[]}>}
 */
export async function registerAccounts(record, targets, deps) {
  const results = [];
  for (const target of targets) results.push(await register(record, target.deps, target.action));
  const skipped = results.find(({ status }) => status !== 'ok');
  const first = skipped ?? results[0] ?? { status: 'ok', detail: presenterOf(deps).text('registerMarketplace') };
  return { ...first, notes: results.flatMap(({ notes }) => notes ?? []) };
}

/** Registers the client, links the command and restarts what ran; returns what each step did. */
export async function activate(record, previous, deps, action = 'update', progress = () => {}, targets = null) {
  progress('register');
  const registered = targets ? await registerAccounts(record, targets, deps) : await register(record, deps, action);
  progress('link');
  const linked = record.link ? await applyLink(record, deps, previous) : null;
  if (record.autostart) await deps.autostart(record, 'install');
  else if (record.wasRunning || previous?.wasRunning) await deps.startDaemon(record);
  return { registered, linked };
}

export async function rollback(current, deps, targets = null) {
  if (!current?.previous) throw new UsageError('No previous version retained');
  if (current.previous.client !== current.client) throw new UsageError('Previous version belongs to another client');
  // The registrations of the accounts are of the clients' folders, not of a version: the record of the old payload is
  // taken without the ones IT held, and the ones registered NOW stay exactly as they are.
  const { accounts: _held, defaultRegistered: _default, statusline: _bar, ...older } = current.previous;
  const record = { ...older, link: current.link, linkDirectory: current.linkDirectory,
    autostart: current.autostart, previous: { ...current, previous: null },
    ...(current.statusline ? { statusline: current.statusline } : _bar ? { statusline: _bar } : {}),
    ...(current.accounts ? { accounts: current.accounts } : {}),
    ...(current.defaultRegistered === false ? { defaultRegistered: false } : {}) };
  const ui = presenterOf(deps);
  const next = ui.sequence(['rollback', 'register', ...(record.link ? ['link'] : [])], { client: clientLabel(current.client) });
  header(ui, deps, headerValues(deps, record.version, current.client));
  const detail = `${current.version} -> ${record.version}`;
  // A real run prints each command as it runs it (register); only a dry run shows the plan.
  if (deps.dryRun) registrationPlan(record, deps, 'update').forEach((item) => ui.detail([item.command, ...item.args].join(' ')));
  if (deps.dryRun) mcpPlan(record, deps, 'update')?.steps.forEach((words) => ui.detail(shown(words, deps.platform)));
  if (deps.dryRun) {
    next('rollback').plan(detail);
    next('register').plan();
    if (record.link) finishLink(ui, next('link'), null, { dryRun: true, command: deps.config.command, bin: deps.bin });
    return 0;
  }
  deps.stage?.('rollback');
  await deps.stopDaemon(current);
  const done = await activate(record, current, deps, 'update', deps.stage, targets);
  await saveRecord(deps.destination, record, deps);
  next('rollback').ok(detail);
  finish(next('register'), done.registered);
  if (record.link) finishLink(ui, next('link'), done.linked);
  deps.hints?.push(done.linked?.hint ?? null);
  return 0;
}
