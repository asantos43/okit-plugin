import { homedir } from 'node:os';
import { homeOf } from '../install/config.js';

import { installPaths } from '../install/config.js';
import { exitCodeFor } from '../install/exit.js';
import { discoverRecords } from '../install/place.js';
import { createPresenter, presentDiagnosis, programLine } from '../cli-present.js';
export { presentDiagnosis } from '../cli-present.js';

import { diagnose } from './diagnose.js';

// The doctor of the command line: it looks at the whole installation and tells what it found. One row per thing it
// looked at, the summary first and repair instructions below the data table.
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
  const ui = createPresenter({ locale, verbose, write: ctx.out, isTTY: ctx.isTTY, env: ctx.env });
  const home = ctx.home ?? homeOf(ctx.env, ctx.platform) ?? homedir();
  const { destination } = installPaths(config, { ...ctx, home });
  // The records of the installation, read leniently: a record that cannot be read is a row of the diagnosis, and the
  // other clients are still diagnosed. The records of the installation that is running are found too, when the
  // destination has none (the doctor that runs from inside an installation sees it).
  const { records, invalid, destination: discovered } = await discoverRecords(destination, { fs: ctx.fs, config, lenient: true });
  const result = await diagnose({
    root: ctx.root, config, records: Object.values(records), invalid, ui, destination: discovered,
    command: config.command, platform: ctx.platform, env: ctx.env, home,
    fs: ctx.fs, run: ctx.run, now: ctx.now, client, temporary: ctx.tmpdir, readers,
  });
  const program = await programLine({ config, platform: ctx.platform, env: ctx.env, fs: ctx.fs }).catch(() => config.command);
  presentDiagnosis(result, { ui, command: config.command, client, clients: Object.keys(records), verbose, out: ctx.out, program, platform: ctx.platform });
  return exitCodeFor(result.failed > 0 ? 'operational' : 'ok');
}
