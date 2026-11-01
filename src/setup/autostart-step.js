import { homedir } from 'node:os';
import { applyAutostart } from '../autostart.js';
import { installPaths } from '../install/config.js';
import { exitCodeFor } from '../install/exit.js';
import { readRecords, saveRecord } from '../install/place.js';
import { fill, pick, TEXTS } from '../install/present.js';

/** The final interactive setup step, attached to the existing installation. */
export async function setupAutostart(ctx, { config, locale, ask, plan }) {
  const text = (key, values = {}) => fill(pick(TEXTS[key], locale), values);
  try {
    const home = ctx.home ?? ctx.env.HOME ?? ctx.env.USERPROFILE ?? homedir();
    const { destination } = installPaths(config, { ...ctx, home });
    const records = Object.values(await readRecords(destination, ctx.fs, config, { unreadable: [] }));
    if (!records.length) return exitCodeFor('ok');
    if (records.every((record) => record.autostart === true)) {
      ctx.out(text('autostartAlready'));
      return exitCodeFor('ok');
    }
    const selected = plan(records[0]);
    ctx.out(text('autostartExplain', { kind: selected.kind }));
    if (selected.path !== null) ctx.out(text('autostartFile', { path: selected.path }));
    let answer;
    try { answer = await ask(text('autostartAsk')); } catch { /* A missing answer declines. */ }
    if (!/^(y|yes|s|sim)$/i.test(String(answer ?? '').trim())) {
      ctx.out(text('autostartLater', { command: ctx.command }));
      return exitCodeFor('ok');
    }
    await applyAutostart(selected, { run: ctx.run, write: ctx.write, action: 'install' });
    await saveRecord(destination, { ...records[0], autostart: true }, { fs: ctx.fs, config });
    ctx.out(text('autostartInstalled', { command: ctx.command }));
    return exitCodeFor('ok');
  } catch (error) {
    ctx.err(text('autostartFailed', { reason: error.message }));
    return exitCodeFor('operational');
  }
}
