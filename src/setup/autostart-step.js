import { homedir } from 'node:os';
import { applyAutostart } from '../autostart.js';
import { installPaths } from '../install/config.js';
import { exitCodeFor } from '../install/exit.js';
import { discoverRecords, readRecords, saveRecord, snapshotRecords, restoreRecords } from '../install/place.js';
import { fill, pick, TEXTS } from '../install/present.js';

/** The final interactive setup step, attached to the existing installation. */
export async function setupAutostart(ctx, { config, locale, ask, plan }) {
  const text = (key, values = {}) => fill(pick(TEXTS[key], locale), values);
  try {
    const home = ctx.home ?? ctx.env.HOME ?? ctx.env.USERPROFILE ?? homedir();
    const { destination: configuredDestination } = installPaths(config, { ...ctx, home });
    const discovered = await discoverRecords(configuredDestination, { fs: ctx.fs, config });
    const { destination } = discovered;
    const records = Object.values(discovered.records);
    if (!records.length) return exitCodeFor('ok');
    if (records.every((record) => record.autostart === true)) {
      ctx.out(text('autostartAlready'));
      return exitCodeFor('ok');
    }
    // The record has to be writable: the save reads the records with the strict reader, so a record that cannot be
    // read is told now, before the service of the machine is installed (never after it).
    await readRecords(destination, ctx.fs, config);
    const selected = plan(records[0]);
    ctx.out(text('autostartExplain', { kind: selected.kind }));
    if (selected.path !== null) ctx.out(text('autostartFile', { path: selected.path }));
    let answer;
    try { answer = await ask(text('autostartAsk')); } catch { /* A missing answer declines. */ }
    if (!/^(y|yes|s|sim)$/i.test(String(answer ?? '').trim())) {
      ctx.out(text('autostartLater', { command: ctx.command }));
      return exitCodeFor('ok');
    }
    const snapshot = await snapshotRecords(destination, ctx.fs, config);
    await applyAutostart(selected, { run: ctx.run, write: ctx.write, action: 'install' });
    try {
      await saveRecord(destination, { ...records[0], autostart: true }, { fs: ctx.fs, config });
    } catch (error) {
      let reason = error.message;
      const unrestored = await restoreRecords(snapshot, ctx.fs);
      if (unrestored.length) reason += `; ${unrestored.join('; ')}`;
      // The service is installed and the record is not: the service is taken back, so the machine is as it was.
      await applyAutostart(selected, { run: ctx.run, write: ctx.write, action: 'uninstall' }).catch(() => {});
      ctx.err(text('autostartFailed', { reason: text('autostartRolledBack', { reason }) }));
      return exitCodeFor('operational');
    }
    ctx.out(text('autostartInstalled', { command: ctx.command }));
    return exitCodeFor('ok');
  } catch (error) {
    ctx.err(text('autostartFailed', { reason: error.message }));
    return exitCodeFor('operational');
  }
}
