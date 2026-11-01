import { UsageError } from './exit.js';
import { join } from 'node:path';
import { saveRecord } from './place.js';
import { register, loadAdapter, registrationPlan } from './register.js';
import { mcpPlan } from './mcp-register.js';
import { applyLink } from './link.js';
import { presenterOf, headerValues, clientLabel, finish, finishLink } from './present.js';

export async function backup(record, deps) {
  const base = join(deps.destination, 'backups', String(deps.now()));
  const folder = deps.backupPerClient ? join(base, record.client) : base;
  const sources = [deps.root, ...(deps.config.backupPaths ?? [])];
  if (deps.clientRoot) sources.push(deps.clientRoot);
  else try {
    const adapter = await (deps.loadAdapter ?? loadAdapter)(record);
    sources.push(adapter.configRoot({ env: deps.env, root: deps.clientRoot }));
  } catch (error) { if (!['ERR_MODULE_NOT_FOUND', 'ENOENT'].includes(error.code)) throw error; }
  await deps.fs.mkdir(folder, { recursive: true });
  for (const [index, source] of [...new Set(sources)].entries()) {
    if (!await deps.fs.stat(source).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; })) continue;
    await deps.fs.cp(source, join(folder, String(index)), { recursive: true, errorOnExist: true,
      filter: (path) => path !== deps.destination && !path.startsWith(`${deps.destination}/`) });
  }
  await deps.fs.writeFile(join(folder, 'sources.json'), JSON.stringify(sources));
  return folder;
}

/** Registers the client, links the command and restarts what ran; returns what each step did. */
export async function activate(record, previous, deps, action = 'update', progress = () => {}) {
  progress('register');
  const registered = await register(record, deps, action);
  progress('link');
  const linked = record.link ? await applyLink(record, deps, previous) : null;
  if (record.autostart) await deps.autostart(record, 'install');
  else if (record.wasRunning || previous?.wasRunning) await deps.startDaemon(record);
  return { registered, linked };
}

export async function rollback(current, deps) {
  if (!current?.previous) throw new UsageError('No previous version retained');
  if (current.previous.client !== current.client) throw new UsageError('Previous version belongs to another client');
  const record = { ...current.previous, link: current.link, linkDirectory: current.linkDirectory,
    autostart: current.autostart, previous: { ...current, previous: null } };
  const ui = presenterOf(deps);
  const next = ui.sequence(['rollback', 'register', ...(record.link ? ['link'] : [])], { client: clientLabel(current.client) });
  ui.header(headerValues(deps, record.version, current.client));
  const detail = `${current.version} -> ${record.version}`;
  // A real run prints each command as it runs it (register); only a dry run shows the plan.
  if (deps.dryRun) registrationPlan(record, deps, 'update').forEach((item) => ui.detail([item.command, ...item.args].join(' ')));
  if (deps.dryRun) mcpPlan(record, deps, 'update')?.steps.forEach((words) => ui.detail(words.join(' ')));
  if (deps.dryRun) {
    next('rollback').plan(detail);
    next('register').plan();
    if (record.link) finishLink(ui, next('link'), null, { dryRun: true, command: deps.config.command, bin: deps.bin });
    return 0;
  }
  deps.stage?.('rollback');
  await deps.stopDaemon(current);
  const done = await activate(record, current, deps, 'update', deps.stage);
  await saveRecord(deps.destination, record, deps);
  next('rollback').ok(detail);
  finish(next('register'), done.registered);
  if (record.link) finishLink(ui, next('link'), done.linked);
  deps.hints?.push(done.linked?.hint ?? null);
  return 0;
}
