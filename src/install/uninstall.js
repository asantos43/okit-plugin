import { join } from 'node:path';
import { register, registrationPlan } from './register.js';
import { applyLink } from './link.js';

export async function uninstall(record, flags, deps) {
  if (flags.purge && !flags.yes) throw new TypeError('--purge requires --yes');
  if (!record) throw new TypeError('No installation record found');
  deps.out(`Uninstall: ${record.path}; ${flags.purge ? 'purge user state/configuration' : 'keep user state/configuration'}`);
  registrationPlan(record, deps, 'uninstall').forEach((item) => deps.out(`command: ${[item.command, ...item.args].join(' ')}`));
  if (deps.dryRun) return 0;
  await deps.stopDaemon(record);
  await register(record, deps, 'uninstall');
  if (record.link) await applyLink(record, deps, null, true);
  // Only directories recorded by this installer are removed.
  for (let item = record; item; item = item.previous) await deps.fs.rm(item.path, { recursive: true, force: true });
  await deps.fs.rm(join(deps.destination, 'install.json'), { force: true });
  if (flags.purge) await deps.fs.rm(deps.root, { recursive: true, force: true });
  return 0;
}
