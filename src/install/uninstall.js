import { readRecords, removeRecord } from './place.js';
import { register, registrationPlan } from './register.js';
import { applyLink } from './link.js';

export async function uninstall(record, flags, deps) {
  if (flags.purge && !flags.yes) throw new TypeError('--purge requires --yes');
  if (!record) throw new TypeError('No installation record found');
  const records = await readRecords(deps.destination, deps.fs, deps.config);
  const remaining = Object.values(records).filter((item) => item.client !== record.client);
  if (flags.purge && remaining.length && !deps.dryRun) throw new TypeError('--purge requires no remaining clients');
  deps.out(`Uninstall: ${record.path}; ${flags.purge ? 'purge user state/configuration' : 'keep user state/configuration'}`);
  registrationPlan(record, deps, 'uninstall').forEach((item) => deps.out(`command: ${[item.command, ...item.args].join(' ')}`));
  if (deps.dryRun) return 0;
  const wasRunning = await deps.stopDaemon(record);
  await register(record, deps, 'uninstall');
  if (remaining.length) {
    const survivor = remaining.find((item) => item.link) ?? remaining[0];
    if (record.link || survivor.link) await applyLink(survivor, deps, record);
    if (record.autostart || survivor.autostart) await deps.autostart(survivor, 'install');
    else if (wasRunning) await deps.startDaemon(survivor);
  } else {
    if (record.link) await applyLink(record, deps, null, true);
    if (record.autostart) await deps.autostart(record, 'uninstall');
  }
  // Only directories recorded by this installer are removed.
  const protectedPaths = new Set();
  for (const other of remaining) for (let item = other; item; item = item.previous) protectedPaths.add(item.path);
  for (let item = record; item; item = item.previous) {
    if (item.client === record.client && !protectedPaths.has(item.path)) await deps.fs.rm(item.path, { recursive: true, force: true });
  }
  await removeRecord(deps.destination, record.client, deps);
  if (flags.purge) await deps.fs.rm(deps.root, { recursive: true, force: true });
  return 0;
}
