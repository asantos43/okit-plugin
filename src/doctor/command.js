import { homedir } from 'node:os';

import { installPaths } from '../install/config.js';
import { exitCodeFor } from '../install/exit.js';
import { discoverRecords } from '../install/place.js';
import { clientLabel, createPresenter } from '../install/present.js';

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
  const ui = createPresenter({ locale, verbose, write: ctx.out });
  const home = ctx.home ?? ctx.env.HOME ?? ctx.env.USERPROFILE ?? homedir();
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
  presentDiagnosis(result, { ui, command: config.command, client, verbose, out: ctx.out });
  return exitCodeFor(result.failed > 0 ? 'operational' : 'ok');
}

export function presentDiagnosis(result, { ui, command, client, verbose = false, out }) {
  const pt = ui.locale === 'pt-BR';
  out(`${command} — ${pt ? 'Verificação da instalação' : 'Installation check'}`);
  const { failed, warnings } = result;
  if (!failed && !warnings) out(pt
    ? `Pronto. ${result.rows.length === 1 ? 'A verificação passou' : `As ${result.rows.length} verificações passaram`}.`
    : `Ready. ${result.rows.length === 1 ? 'The check passed' : `All ${result.rows.length} checks passed`}.`);
  else {
    const failures = pt ? `${failed} ${failed === 1 ? 'verificação falhou' : 'verificações falharam'}` : `${failed} failed ${failed === 1 ? 'check' : 'checks'}`;
    const alerts = pt ? `${warnings} ${warnings === 1 ? 'aviso' : 'avisos'}` : `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`;
    out(`${pt ? 'Precisa de atenção' : 'Needs attention'}: ${failed ? failures : alerts}${failed && warnings ? `; ${alerts}` : ''}; ${pt ? 'as demais passaram' : 'other checks passed'}.`);
  }
  const shown = result.rows.filter((row) => !row.quiet || verbose);
  // The rows of a client name it, so two clients are told apart. The labels share one width, so every mark of the run
  // is in the same column.
  const labels = shown.map((row) => row.id === 'registration'
    ? (pt ? `Conexão com ${clientLabel(row.client)}` : `${clientLabel(row.client)} connection`)
    : (row.client ? `${clientLabel(row.client)}: ${row.label}` : row.label));
  out(pt ? '| Verificação | Resultado |' : '| Check | Result |');
  out('| --- | --- |');
  const cell = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
  for (const [index, row] of shown.entries()) {
    out(`| ${cell(labels[index])} | ${cell(row.detail)} |`);
  }
  const check = `${command} doctor${client ? ` --client ${client}` : ''}`;
  const fixes = [...new Set(shown.filter((row) => ['failed', 'warn'].includes(row.status) && row.fix).map((row) => row.fix))];
  for (const fix of fixes) {
    out(`${pt ? 'Correção' : 'Fix'}: ${fix}`);
    // One verification command is enough when several checks need repair.
  }
  if (fixes.length) out(`${pt ? 'Depois confira' : 'Then check'}: ${check}`);
  if (shown.some((row) => row.id === 'session' && row.status === 'warn' && !row.fix)) out(pt
    ? `Nenhuma sessão de cliente aberta. Abra ${clientLabel(client ?? 'codex')} e rode: ${check}`
    : `No client session is open. Open ${clientLabel(client ?? 'codex')}, then run: ${check}`);
  if (labels.some((label) => /MCP/.test(label)) || shown.some((row) => /MCP/.test(`${row.detail} ${row.fix ?? ''}`))) out(pt
    ? 'MCP é a conexão usada pelo assistente para chamar ferramentas do plugin.'
    : 'MCP is the connection your assistant uses to call plugin tools.');
  if (!fixes.length) out(`${pt ? 'Verifique novamente quando precisar' : 'Check again when needed'}: ${check}`);
}
