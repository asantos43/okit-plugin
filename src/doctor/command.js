import { homedir } from 'node:os';

import { installPaths } from '../install/config.js';
import { exitCodeFor } from '../install/exit.js';
import { discoverRecords } from '../install/place.js';
import { clientLabel, createPresenter } from '../install/present.js';

import { diagnose } from './diagnose.js';

// The doctor of the command line: it looks at the whole installation and tells what it found. One row per thing it
// looked at, a `Fix:` line under every row that failed or warned, and one line of summary at the end.
//
// It only reads. The state of the person is the same before and after the run: no file is written, no record is
// removed and nothing is registered. The rows come from the diagnosis (src/doctor/diagnose.js), which is the only
// place that knows what to look at; this file only tells the rows and decides the exit code.
//
// The contract of the run: the doctor never writes to the state of the person (the state root, the records of the
// installation, the settings of the client); the only folder it creates is the temporary one of the check, under the
// temporary folder of the caller, and it is removed when the run ends.

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
export async function doctorCommand(ctx, { locale, config, verbose = false, client, readers }) {
  const ui = createPresenter({ locale, verbose, write: ctx.out });
  const home = ctx.home ?? ctx.env.HOME ?? ctx.env.USERPROFILE ?? homedir();
  const { destination } = installPaths(config, { ...ctx, home });
  // The records of the installation, read leniently: a record that cannot be read is a row of the diagnosis, and the
  // other clients are still diagnosed. The records of the installation that is running are found too, when the
  // destination has none (the doctor that runs from inside an installation sees it).
  const { records, invalid, destination: discovered } = await discoverRecords(destination, { fs: ctx.fs, config, lenient: true });
  ctx.out(ui.text('doctorHeader', { command: config.command }));
  const result = await diagnose({
    root: ctx.root, config, records: Object.values(records), invalid, ui, destination: discovered,
    command: config.command, platform: ctx.platform, env: ctx.env, home,
    fs: ctx.fs, run: ctx.run, now: ctx.now, client, temporary: ctx.tmpdir, readers,
  });
  // The rows that are told: a quiet one is one the person did not ask for (it is told with --verbose).
  const shown = result.rows.filter((row) => !row.quiet || verbose);
  // The rows of a client name it, so two clients are told apart. The labels share one width, so every mark of the run
  // is in the same column.
  const labels = shown.map((row) => (row.client ? `${clientLabel(row.client)}: ${row.label}` : row.label));
  const width = labels.reduce((most, label) => Math.max(most, label.length), 0);
  for (const [index, row] of shown.entries()) {
    ui.row(labels[index].padEnd(width), row.status, row.detail);
    if (row.fix && (row.status === 'failed' || row.status === 'warn')) ui.note(ui.text('selfcheckFix', { fix: row.fix }));
  }
  const { failed, warnings } = result;
  const summary = failed === 0 && warnings === 0
    ? ui.text('doctorSummaryOk', { count: result.rows.length })
    : ui.text('doctorSummary', { failed, warnings });
  ui.row(''.padEnd(width), failed > 0 ? 'failed' : warnings > 0 ? 'warn' : 'ok', summary);
  // A warning never fails the run: only a failed row does.
  return exitCodeFor(failed > 0 ? 'operational' : 'ok');
}
