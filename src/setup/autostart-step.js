import { homedir } from 'node:os';
import { applyAutostart, autostartExists, autostartPresent } from '../autostart.js';
import { installPaths } from '../install/config.js';
import { exitCodeFor } from '../install/exit.js';
import { discoverRecords, readRecords, saveRecord, snapshotRecords, restoreRecords } from '../install/place.js';
import { fill, pick, TEXTS } from '../install/present.js';

/**
 * Whether the autostart of this machine is working.
 *
 * The record of the installation says what was asked for; the machine says what is there. The check is the one the
 * doctor asks: a service that is corrupt, stale or disabled is not working, and the step below offers itself again so
 * the setup repairs what the doctor found.
 *
 * @param {object} ctx the context of the command line
 * @param {object} selected the plan of the autostart of this machine
 * @returns {Promise<boolean>}
 */
async function alreadyThere(ctx, selected) {
  return autostartPresent(selected, { fs: ctx.fs, run: ctx.run });
}

/**
 * Whether anything of this autostart is on the machine.
 *
 * The rollback asks another question: a service that is there but disabled or stale must not be taken away by a save
 * that failed, so the answer is "is there anything of it here?", not "is it working?".
 *
 * @param {object} ctx the context of the command line
 * @param {object} selected the plan of the autostart of this machine
 * @returns {Promise<boolean>}
 */
async function existedOnMachine(ctx, selected) {
  return autostartExists(selected, { fs: ctx.fs, run: ctx.run });
}

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
    const selected = plan(records[0]);
    if (records.every((record) => record.autostart === true) && await alreadyThere(ctx, selected)) {
      ctx.out(text('autostartAlready'));
      return exitCodeFor('ok');
    }
    // The record has to be writable: the save reads the records with the strict reader, so a record that cannot be
    // read is told now, before the service of the machine is installed (never after it).
    await readRecords(destination, ctx.fs, config);
    ctx.out(text('autostartExplain', { kind: selected.kind }));
    if (selected.path !== null) ctx.out(text('autostartFile', { path: selected.path }));
    let answer;
    try { answer = await ask(text('autostartAsk')); } catch { /* A missing answer declines. */ }
    if (!/^(y|yes|s|sim)$/i.test(String(answer ?? '').trim())) {
      ctx.out(text('autostartLater', { command: ctx.command }));
      return exitCodeFor('ok');
    }
    const snapshot = await snapshotRecords(destination, ctx.fs, config);
    // The service of the machine may already be there: the rollback below must not take it away. The machine says it,
    // not the record: a record that says the autostart is on while the service is gone is a stale record.
    const existed = await existedOnMachine(ctx, selected);
    await applyAutostart(selected, { run: ctx.run, write: ctx.write, action: 'install' });
    try {
      await saveRecord(destination, { ...records[0], autostart: true }, { fs: ctx.fs, config });
    } catch (error) {
      let reason = error.message;
      const unrestored = await restoreRecords(snapshot, ctx.fs);
      if (unrestored.length) reason += `; ${unrestored.join('; ')}`;
      if (existed) {
        // The service was already installed: it is kept, because the records that survive the rollback still say the
        // autostart is on.
        ctx.err(text('autostartFailed', { reason: text('autostartKept', { reason }) }));
        return exitCodeFor('operational');
      }
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
