import { homedir } from 'node:os';
import { homeOf } from '../install/config.js';

import { installPaths } from '../install/config.js';
import { exitCodeFor } from '../install/exit.js';
import { discoverRecords } from '../install/place.js';
import { createPresenter, presentDiagnosis, programLine } from '../cli-present.js';
export { presentDiagnosis } from '../cli-present.js';

import { diagnose } from './diagnose.js';
import { accountsOf } from '../accounts.js';
import { ensureSavedCollectors, collectorState } from '../quota/collector-registration.js';

// The doctor of the command line: it looks at the whole installation and tells what it found. One row per thing it
// looked at, the summary first and repair instructions below the data table.
//
// Diagnosis is read-only. With --fix, repair saved extra accounts' collectors before diagnosis.

/**
 * Runs the doctor and tells what it found.
 *
 * @param {object} ctx the context of the command line (root, env, fs, run, out, now, tmpdir)
 * @param {object} entry the language of the run, the settings of the installer and the flags it was given
 * @param {string} entry.locale the language of the run
 * @param {object} entry.config the settings of the installer
 * @param {boolean} [entry.verbose] whether the quiet rows are told too
 * @param {string} [entry.client] the only client to look at, when one was named
 * @param {object} [entry.readers] optional readers passed to the diagnosis
 * @returns {Promise<number>} the exit code
 */
export async function doctorCommand(ctx, { locale, config, verbose = false, client, readers, fix = false }) {
  const ui = createPresenter({ locale, verbose, write: ctx.out, isTTY: ctx.isTTY, env: ctx.env });
  const home = ctx.home ?? homeOf(ctx.env, ctx.platform) ?? homedir();
  const { destination } = installPaths(config, { ...ctx, home });
  if (fix) {
    const raw = await ctx.fs.readFile(`${ctx.root}/config.json`, 'utf8').then(JSON.parse).catch(() => ({}));
    for (const state of await ensureSavedCollectors({ ...ctx, locale }, raw, client ?? 'claude-code')) {
      ctx.out([state.text, state.detail, state.reason].filter(Boolean).join(': '));
    }
  }
  // The records of the installation, read leniently: a record that cannot be read is a row of the diagnosis, and the
  // other clients are still diagnosed. The records of the installation that is running are found too, when the
  // destination has none (the doctor that runs from inside an installation sees it).
  const { records, invalid, destination: discovered } = await discoverRecords(destination, { fs: ctx.fs, config, lenient: true });
  const result = await diagnose({
    root: ctx.root, config, records: Object.values(records), invalid, ui, destination: discovered,
    command: config.command, platform: ctx.platform, env: ctx.env, home,
    fs: ctx.fs, run: ctx.run, now: ctx.now, client, temporary: ctx.tmpdir, readers,
  });
  // One row for the collector of each saved account (read-only): where it is not registered, the reason names the file.
  if (!client || client === 'claude-code') {
    const raw = await ctx.fs.readFile(`${ctx.root}/config.json`, 'utf8').then(JSON.parse).catch(() => ({}));
    const pt = locale === 'pt-BR';
    const accounts = await Promise.resolve().then(() => accountsOf(raw, 'claude-code')).catch(() => []);
    for (const account of accounts.filter((entry) => !entry.isDefault)) {
      const state = await collectorState({ ...ctx, locale }, raw, account);
      const ok = state.state === 'registered';
      result.rows.push({ id: 'account-collector', client: 'claude-code', account: account.id, accountLabel: account.label,
        label: pt ? 'Coletor da conta' : 'Account collector', // locale:pt-BR
        status: ok ? 'ok' : 'warn',
        detail: [state.text, state.detail].filter(Boolean).join(': '), ...ok ? {} : { fix: state.reason } });
      if (!ok) result.warnings += 1;
    }
  }
  const program = await programLine({ config, platform: ctx.platform, env: ctx.env, fs: ctx.fs }).catch(() => config.command);
  presentDiagnosis(result, { ui, command: config.command, client, clients: Object.keys(records), verbose, out: ctx.out, program, platform: ctx.platform });
  return exitCodeFor(result.failed > 0 ? 'operational' : 'ok');
}
