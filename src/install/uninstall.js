import { UsageError } from './exit.js';
import { resolvedRecord } from './where.js';
import { readRecords, removeRecord, saveRecord } from './place.js';
import { register, registrationPlan } from './register.js';
import { mcpPlan, shown } from './mcp-register.js';
import { applyLink } from './link.js';
import { statuslineOf, undoStatusline } from './statusline.js';
import { header, markUnregistered } from './account-scope.js';
import { presenterOf, headerValues, clientLabel, finish } from './present.js';

export async function uninstall(record, flags, deps) {
  if (flags.purge && !flags.yes) throw new UsageError('--purge requires --yes');
  if (!record) throw new UsageError('No installation record found');
  const records = await readRecords(deps.destination, deps.fs, deps.config);
  const remaining = Object.values(records).filter((item) => item.client !== record.client)
    .map((item) => resolvedRecord(item, deps.destination));
  if (flags.purge && remaining.length && !deps.dryRun) throw new UsageError('--purge requires no remaining clients');
  // The account being removed, and the registrations that stay: while any stays, the payload and the record stay too.
  const scope = deps.accountScope;
  // Every registration of the record counts, also that of an account that is no longer saved.
  const others = scope ? (deps.registeredIds ?? []).filter((id) => id !== scope.id) : [];
  if (flags.purge && others.length && !deps.dryRun) throw new UsageError('--purge requires no remaining accounts');
  const ui = presenterOf(deps);
  const bar = statuslineOf(record, deps);
  const next = ui.sequence(others.length ? [...(bar ? ['quotaUndo'] : []), 'unregister', 'remove']
    : [...(bar ? ['quotaUndo'] : []), 'unregister', ...(record.link ? ['unlink'] : []), 'remove'],
  { client: clientLabel(record.client) });
  header(ui, deps, headerValues(deps, record.version, record.client));
  // A real run prints each command as it runs it (register); only a dry run shows the plan.
  if (deps.dryRun) {
    registrationPlan(record, deps, 'uninstall').forEach((item) => ui.detail([item.command, ...item.args].join(' ')));
    mcpPlan(record, deps, 'uninstall')?.steps.forEach((words) => ui.detail(shown(words, deps.platform)));
  }
  deps.stage?.('quotaUndo');
  const quota = await undoStatusline(record, deps);
  if (quota) finish(next('quotaUndo'), quota);
  if (others.length) {
    const kept = ui.text('accountsKept', { path: record.path, accounts: others.join(', ') });
    if (deps.dryRun) { next('unregister').plan(); next('remove').plan(kept); return 0; }
    deps.stage?.('unregister');
    finish(next('unregister'), await register(record, deps, 'uninstall'));
    // Only this account's registration goes out of the record; the payload, the link and the other accounts stay.
    markUnregistered(record, scope);
    if (scope.isDefault) delete record.statusline;
    await saveRecord(deps.destination, record, deps);
    next('remove').ok(kept);
    return 0;
  }
  const removed = ui.text(flags.purge ? 'removePurge' : 'removeKeep', { path: record.path });
  if (deps.dryRun) {
    next('unregister').plan();
    if (record.link) next('unlink').plan();
    next('remove').plan(removed);
    return 0;
  }
  deps.stage?.('stop');
  const wasRunning = await deps.stopDaemon(record);
  deps.stage?.('unregister');
  finish(next('unregister'), await register(record, deps, 'uninstall'));
  deps.stage?.('unlink');
  if (remaining.length) {
    const survivor = remaining.find((item) => item.link) ?? remaining[0];
    if (record.link || survivor.link) await applyLink(survivor, deps, record);
    if (record.link) next('unlink').ok(ui.text('unlinkShared', { command: deps.config.command }));
    if (record.autostart || survivor.autostart) {
      // The service moves to a survivor whose payload can run it. When none can, it stays removed (the stop above took
      // the departing record's service away): it is not left pointing at the payload that is being deleted, and the
      // doctor reports the survivors' autostart with its Fix.
      for (const candidate of [survivor, ...remaining.filter((item) => item !== survivor)]) {
        try { await deps.autostart(candidate, 'install'); break; }
        catch (error) { if (!error?.noPlan) throw error; }
      }
    } else if (wasRunning) await deps.startDaemon(survivor);
  } else {
    if (record.link) await applyLink(record, deps, null, true);
    if (record.link) next('unlink').ok(ui.text('unlinkDone', { command: deps.config.command }));
    if (record.autostart) await deps.autostart(record, 'uninstall');
  }
  deps.stage?.('remove');
  // Only directories recorded by this installer are removed.
  const protectedPaths = new Set();
  for (const other of remaining) for (let item = other; item; item = item.previous) protectedPaths.add(item.path);
  for (let item = record; item; item = item.previous) {
    if (item.client === record.client && !protectedPaths.has(item.path)) await deps.fs.rm(item.path, { recursive: true, force: true });
  }
  await removeRecord(deps.destination, record.client, deps);
  if (flags.purge) await deps.fs.rm(deps.root, { recursive: true, force: true });
  next('remove').ok(removed);
  return 0;
}
