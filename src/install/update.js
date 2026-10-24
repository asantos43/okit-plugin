import { join } from 'node:path';
import { saveRecord } from './place.js';
import { register, loadAdapter, registrationPlan } from './register.js';
import { applyLink } from './link.js';

export async function backup(record, deps) {
  const folder = join(deps.destination, 'backups', String(deps.now()));
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
  deps.out(`Backup: ${folder}`);
  return folder;
}

export async function activate(record, previous, deps, action = 'update') {
  await register(record, deps, action);
  if (record.link) await applyLink(record, deps, previous);
  if (record.autostart) await deps.autostart(record, 'install');
  else if (record.wasRunning || previous?.wasRunning) await deps.startDaemon(record);
}

export async function rollback(current, deps) {
  if (!current?.previous) throw new TypeError('No previous version retained');
  const record = { ...current.previous, previous: { ...current, previous: null } };
  deps.out(`Rollback: ${current.version} -> ${record.version}`);
  registrationPlan(record, deps, 'update').forEach((item) => deps.out(`command: ${[item.command, ...item.args].join(' ')}`));
  if (deps.dryRun) return 0;
  await deps.stopDaemon(current);
  await activate(record, current, deps);
  await saveRecord(deps.destination, record, deps);
  return 0;
}
