import test from 'node:test';
import assert from 'node:assert/strict';
import * as filesystem from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import { createInstallerView, createPresenter, presentDiagnosis, presentModelChoices, programLine, setupResultLines } from '../src/cli-present.js';
import { offerSetup } from '../src/setup/offer.js';
import { shown } from '../src/install/mcp-register.js';
import { fixture } from './helpers/install-fixture.js';

// Each case is the regression of one finding of the independent critic: the outcome is told from the result of each
// client and from the arguments of the run, never from the first error, a global flag or the header count.
const LOCALES = ['en', 'pt-BR'];

const render = (operation, locale, observe, result) => {
  const output = [], view = createInstallerView({ operation, command: 'okit-plugin', locale, write: (line) => output.push(line) });
  observe(view.ui);
  view.finish({ program: 'okit-plugin', platform: 'linux', ...result });
  return output;
};

for (const locale of LOCALES) test(`D112 critic 1: the Apply and retry commands replay the run: ${locale}`, () => {
  const pt = locale === 'pt-BR';
  const preview = render('install', locale, (ui) => ui.header({ client: 'Codex', version: '1' }),
    { code: 0, client: 'codex', dryRun: true, flags: ['--client', 'codex', '--dest', '/tmp/my dest', '--no-link', '--dry-run'] });
  assert.ok(preview.includes(`${pt ? 'Para aplicar' : 'Apply'}: okit-plugin install --client codex --dest '/tmp/my dest' --no-link`), preview.join('\n'));

  const rollback = render('update', locale, (ui) => { ui.header({ client: 'Codex', version: '1' }); ui.failure({ client: 'codex', step: ui.text('files'), reason: 'boom' }); },
    { code: 1, client: 'codex', flags: ['--rollback', '--client', 'codex'] });
  assert.ok(rollback.includes(`${pt ? 'Tente novamente' : 'Try again'}: okit-plugin update --client codex --rollback`), rollback.join('\n'));

  const check = render('update', locale, (ui) => { ui.header({ client: 'Codex', version: '2' }); ui.row(ui.text('newVersion'), 'info', '2'); },
    { code: 0, checkOnly: true, flags: ['--check', '--from', 'a b'], program: "'/opt/node' '/x/cli.js'", before: { codex: { version: '1' } } });
  assert.ok(check.includes(`${pt ? 'Para atualizar' : 'Update'}: '/opt/node' '/x/cli.js' update --from 'a b'`), check.join('\n'));
});

for (const locale of LOCALES) test(`D112 critic 2: nothing changed only when every client is current: ${locale}`, () => {
  const pt = locale === 'pt-BR';
  const output = render('update', locale, (ui) => {
    ui.header({ client: 'Codex', version: '1' });
    ui.row(ui.text('upToDate'), 'ok', '1');
    ui.header({ client: 'Claude Code', version: '2' });
    ui.endClients();
  }, { code: 0, client: 'all', before: { codex: { version: '1' }, 'claude-code': { version: '1' } }, after: { codex: { version: '1' }, 'claude-code': { version: '2' } } });
  const text = output.join('\n');
  assert.ok(output.includes(pt ? 'Codex está em dia.' : 'Codex is up to date.'), text);
  assert.ok(output.includes(pt ? 'Claude Code atualizado de 1 para 2.' : 'Updated Claude Code from 1 to 2.'), text);
  assert.doesNotMatch(text, /Nothing changed|Nada mudou/);
  assert.ok(output.some((line) => line.includes(pt ? 'reinicie Claude Code e rode' : 'restart Claude Code, then run')), text);
  assert.doesNotMatch(text, /reinicie Codex|restart Codex/);
});

for (const locale of LOCALES) test(`D112 critic 3: the cause and the retry of each failed client are told: ${locale}`, () => {
  const pt = locale === 'pt-BR';
  const output = render('install', locale, (ui) => {
    ui.header({ client: 'Codex', version: '1' });
    ui.failure({ client: 'codex', step: ui.text('get'), reason: 'disk is full' });
    ui.header({ client: 'Claude Code', version: '1' });
    ui.failure({ client: 'claude-code', step: ui.text('get'), reason: 'bad archive' });
    ui.endClients();
  }, { code: 1, client: 'all', flags: ['--client', 'all'] });
  const text = output.join('\n');
  const failedAt = pt ? 'Falhou em Baixar e verificar: ' : 'Failed at Download and verify: ';
  assert.ok(output.includes(`${failedAt}disk is full (Codex)`), text);
  assert.ok(output.includes(`${failedAt}bad archive (Claude Code)`), text);
  assert.ok(output.some((line) => line.startsWith(`${pt ? 'Confira sua conexão e tente' : 'Check your connection, then retry'} (Codex): `)), text);
  assert.ok(output.some((line) => line.startsWith(`${pt ? 'Confira sua conexão e tente' : 'Check your connection, then retry'} (Claude Code): `)), text);
  assert.equal(new Set(output).size, output.length, text);
});

for (const locale of LOCALES) test(`D112 critic 4: the install headline counts the clients installed: ${locale}`, () => {
  const pt = locale === 'pt-BR';
  const failures = (steps) => (ui) => {
    for (const [client, label, step] of steps) {
      ui.header({ client: label, version: '1' });
      ui.failure({ client, step: ui.text(step), reason: 'denied here' });
    }
    ui.endClients();
  };
  const partial = render('install', locale, failures([['codex', 'Codex', 'register'], ['claude-code', 'Claude Code', 'get']]), { code: 1, client: 'all' });
  assert.ok(partial.includes(pt ? 'Alguns clientes foram instalados. Outros precisam de atenção.' : 'Some clients were installed. Others need attention.'), partial.join('\n'));
  const none = render('install', locale, failures([['codex', 'Codex', 'get'], ['claude-code', 'Claude Code', 'get']]), { code: 1, client: 'all' });
  assert.ok(none.includes(pt ? 'Nenhum cliente foi instalado.' : 'No client was installed.'), none.join('\n'));
  const installed = render('install', locale, failures([['codex', 'Codex', 'register'], ['claude-code', 'Claude Code', 'register']]), { code: 1, client: 'all' });
  assert.doesNotMatch(installed.join('\n'), /No client was installed|Nenhum cliente foi instalado/);
});

for (const locale of LOCALES) test(`D112 critic 5: the setup result keeps the guidance and names the cause: ${locale}`, () => {
  const pt = locale === 'pt-BR';
  const advice = 'Quota advice: choose a limit.';
  const saved = setupResultLines({ changes: [{ client: 'codex' }], skipped: [], omitted: [], guidance: [advice] }, locale, 'okit-plugin');
  assert.ok(saved.includes(advice), saved.join('\n'));
  const unchanged = setupResultLines({ changes: [], skipped: [{ client: 'codex' }], omitted: [], guidance: [advice] }, locale, 'okit-plugin');
  assert.ok(unchanged.includes(advice), unchanged.join('\n'));
  const unmatched = setupResultLines({ changes: [], skipped: [], omitted: [{ client: 'codex' }], guidance: [advice] }, locale, 'okit-plugin');
  assert.ok(unmatched.includes(advice), unmatched.join('\n'));
  assert.doesNotMatch(unmatched.join('\n'), /No client with an active model|Nenhum cliente com modelo ativo/);
  assert.match(unmatched[0], pt ? /não correspondem/ : /did not match/);
});

for (const locale of LOCALES) test(`D112 critic 6: the model rows carry the client when several are confirmed: ${locale}`, () => {
  const pt = locale === 'pt-BR';
  const rows = (changes) => { const output = []; presentModelChoices({ locale, changes, command: 'okit-plugin', out: (line) => output.push(line) }); return output; };
  const several = rows([{ client: 'codex', class: 'simple', model: 'gpt-a' }, { client: 'claude-code', class: 'simple', model: 'sonnet-b' }]);
  assert.ok(several.includes(`| Codex | ${pt ? 'Tarefas pequenas' : 'Small tasks'} | gpt-a |`), several.join('\n'));
  assert.ok(several.includes(`| Claude Code | ${pt ? 'Tarefas pequenas' : 'Small tasks'} | sonnet-b |`), several.join('\n'));
  const one = rows([{ client: 'codex', class: 'simple', model: 'gpt-a' }]);
  assert.ok(one.includes(`| ${pt ? 'Tarefas pequenas' : 'Small tasks'} | gpt-a |`), one.join('\n'));
});

for (const locale of LOCALES) test(`D112 critic 7: the follow-ups of the doctor use the resolved program: ${locale}`, () => {
  const pt = locale === 'pt-BR';
  const program = "'/opt/my node/node' '/x/cli.js'";
  const ui = createPresenter({ locale, write: () => {} });
  const diagnose = (rows, options = {}) => {
    const output = [];
    presentDiagnosis({ failed: rows.filter((row) => row.status === 'failed').length, warnings: rows.filter((row) => row.status === 'warn').length, rows },
      { ui, command: 'okit-plugin', out: (line) => output.push(line), program, platform: 'linux', ...options });
    return output;
  };
  const failed = diagnose([{ id: 'registration', client: 'codex', label: 'Registration', status: 'failed', detail: 'missing', fix: `${program} install --client codex` }], { client: 'my client' });
  assert.ok(failed.includes(`${pt ? 'Depois confira' : 'Then check'}: ${program} doctor --client 'my client'`), failed.join('\n'));
  const session = diagnose([{ id: 'session', client: 'codex', label: 'Session', status: 'warn', detail: 'none' }], { clients: ['codex'] });
  assert.ok(session.some((line) => line.endsWith(`${program} doctor`)), session.join('\n'));
  const ready = diagnose([{ id: 'files', label: 'Files', status: 'ok', detail: 'fine' }]);
  assert.ok(ready.includes(`${pt ? 'Verifique novamente quando precisar' : 'Check again when needed'}: ${program} doctor`), ready.join('\n'));
});

for (const locale of LOCALES) test(`D112 critic 7: without the command on the PATH the retry names the running program: ${locale}`, async (t) => {
  const f = await fixture(t, 'linux');
  const good = f.io.fetch;
  f.io.fetch = async (url, options) => { if (url.includes('/package/')) throw new Error('boom'); return good(url, options); };
  assert.equal(await main(['install', '--client', 'claude-code', '--locale', locale], f.io), 1);
  const program = shown([process.execPath, fileURLToPath(new URL('../src/cli.js', import.meta.url))], 'linux');
  const retry = `${locale === 'pt-BR' ? 'Confira sua conexão e tente' : 'Check your connection, then retry'}: ${program} install --client claude-code`;
  assert.ok(f.output.includes(retry), f.output.join('\n'));
});

// Round 2: the commands the output prints are built from what the run did, and each of them is executed here.
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
/** The program as the output names it when the command is not on the PATH of the fixture. */
const RUNNING = shown([process.execPath, CLI], 'linux');
/** The arguments of the command a line prints (the words after the program). */
const argsOf = (line) => line.slice(line.indexOf(RUNNING) + RUNNING.length).trim().split(' ');
const lineOf = (output, prefix) => output.find((line) => line.startsWith(prefix));
const failedAt = (locale, key, reason) => {
  const ui = createPresenter({ locale, write: () => {} });
  return ui.text('failedAt', { step: ui.text(key), reason });
};

for (const locale of LOCALES) test(`D112 round 2, 1: a repeated --client previews and applies the client the installer uses: ${locale}`, async (t) => {
  const pt = locale === 'pt-BR';
  const f = await fixture(t, 'linux');
  f.io.env.OKIT_LANGUAGE = locale;
  assert.equal(await main(['install', '--client', 'claude-code', '--client', 'codex', '--dry-run'], f.io), 0, f.output.join('\n'));
  const apply = lineOf(f.output, `${pt ? 'Para aplicar' : 'Apply'}: `);
  assert.equal(apply, `${pt ? 'Para aplicar' : 'Apply'}: ${RUNNING} install --client codex`, f.output.join('\n'));
  assert.ok(f.output.some((line) => line.includes('Codex')) && !f.output.some((line) => line.includes('Claude Code')), f.output.join('\n'));
  f.clear();
  assert.equal(await main(argsOf(apply), f.io), 0, f.output.join('\n'));
  assert.ok(f.output.some((line) => line.startsWith(pt ? 'Instalado para Codex.' : 'Installed for Codex.')), f.output.join('\n'));
  assert.ok(!f.output.some((line) => line.includes('Claude Code')), f.output.join('\n'));
});

for (const locale of LOCALES) test(`D112 round 2, 2: a failure after the client was chosen from the menu keeps its steps and offers no other client: ${locale}`, () => {
  const pt = locale === 'pt-BR';
  const output = render('install', locale, (ui) => {
    ui.explain([ui.text('clientChoose'), ...['claude-code', 'codex', 'opencode'].map((id, index) => `  ${index + 1}. ${id} (${ui.text('clientDetected')})`)]);
    ui.header({ client: 'Codex', version: '1' });
    ui.note('Self-check kept line');
    ui.failure({ client: 'codex', step: ui.text('files'), reason: 'disk is full' });
    ui.endClients();
  }, { code: 1 });
  const text = output.join('\n');
  assert.ok(output.includes(failedAt(locale, 'files', 'disk is full')), text);
  assert.ok(output.some((line) => line.includes('Self-check kept line')), text);
  assert.ok(output.includes(`${pt ? 'Tente novamente' : 'Try again'}: okit-plugin install --client codex`), text);
  assert.doesNotMatch(text, /Install for|Instale para/);
});

for (const locale of LOCALES) test(`D112 round 2, 3: the retry of a failed purge is one command that the installer accepts: ${locale}`, async (t) => {
  const pt = locale === 'pt-BR';
  const f = await fixture(t, 'linux');
  for (const client of ['claude-code', 'codex']) assert.equal(await main(['install', '--client', client], f.io), 0, f.output.join('\n'));
  f.io.env.OKIT_LANGUAGE = locale;
  let broken = true;
  f.io.stopDaemon = async () => { if (broken) throw new Error('stop denied'); return true; };
  f.clear();
  assert.notEqual(await main(['uninstall', '--purge', '--yes'], f.io), 0, f.output.join('\n'));
  const retries = f.output.filter((line) => line.startsWith(pt ? 'Tente novamente' : 'Try again'));
  assert.deepEqual(retries, [`${pt ? 'Tente novamente' : 'Try again'}: ${RUNNING} uninstall --purge --yes`], f.output.join('\n'));
  broken = false;
  f.clear();
  assert.equal(await main(argsOf(retries[0]), f.io), 0, f.output.join('\n'));
  assert.ok(f.output.some((line) => line.startsWith(pt ? 'Plugin removido do' : 'Removed the plugin from')), f.output.join('\n'));
});

for (const locale of LOCALES) test(`D112 round 2, 4: without the command link every follow-up names the running program: ${locale}`, async (t) => {
  const pt = locale === 'pt-BR';
  const f = await fixture(t, 'linux');
  f.io.env.OKIT_LANGUAGE = locale;
  assert.equal(await main(['install', '--client', 'claude-code', '--no-link'], f.io), 0, f.output.join('\n'));
  assert.ok(f.output.includes(`${pt ? 'Próximo' : 'Next'}: ${RUNNING} setup`), f.output.join('\n'));
  const check = lineOf(f.output, `${pt ? 'Verifique a instalação' : 'Check the installation'}: `);
  assert.equal(check, `${pt ? 'Verifique a instalação' : 'Check the installation'}: ${RUNNING} doctor --client claude-code`, f.output.join('\n'));
  f.clear();
  await main(argsOf(check), f.io);
  assert.equal(f.output[0], `okit-plugin — ${pt ? 'Verificação da instalação' : 'Installation check'}`, f.output.join('\n'));
  f.setVersion('2.0.0');
  f.clear();
  assert.equal(await main(['update'], f.io), 0, f.output.join('\n'));
  const restart = pt ? 'Próximo: reinicie Claude Code e rode: ' : 'Next: restart Claude Code, then run: ';
  assert.ok(f.output.includes(`${restart}${RUNNING} doctor --client claude-code`), f.output.join('\n'));
  const rollback = lineOf(f.output, `${pt ? 'Volte à versão guardada' : 'Return to the retained version'}: `);
  assert.equal(rollback, `${pt ? 'Volte à versão guardada' : 'Return to the retained version'}: ${RUNNING} update --rollback`, f.output.join('\n'));
  f.clear();
  assert.equal(await main(argsOf(rollback), f.io), 0, f.output.join('\n'));
});

for (const locale of LOCALES) test(`D112 round 2, 5: without a client in evidence the first install names none: ${locale}`, async (t) => {
  const pt = locale === 'pt-BR';
  const f = await fixture(t, 'linux');
  f.io.env.OKIT_LANGUAGE = locale;
  f.io.detect = async (executable) => executable === 'codex';
  assert.equal(await main(['update'], f.io), 2, f.output.join('\n'));
  const first = lineOf(f.output, `${pt ? 'Instale primeiro' : 'Install first'}: `);
  assert.equal(first, `${pt ? 'Instale primeiro' : 'Install first'}: ${RUNNING} install`, f.output.join('\n'));
  f.clear();
  assert.equal(await main(argsOf(first), f.io), 0, f.output.join('\n'));
  assert.ok(f.output.some((line) => line.startsWith(pt ? 'Instalado para Codex.' : 'Installed for Codex.')), f.output.join('\n'));
  // The doctor names no client either when none is in evidence.
  const ui = createPresenter({ locale, write: () => {} }), output = [];
  presentDiagnosis({ failed: 0, warnings: 1, rows: [{ id: 'session', label: 'Session', status: 'warn', detail: 'none' }] },
    { ui, command: 'okit-plugin', out: (line) => output.push(line), program: 'okit-plugin', platform: 'linux' });
  assert.ok(output.some((line) => line.includes(pt ? 'Abra seu cliente e rode' : 'Open your client, then run')), output.join('\n'));
  assert.doesNotMatch(output.join('\n'), /Codex/);
});

for (const locale of LOCALES) test(`D112 round 2, 6: the setup result names what was saved and, apart, what was kept: ${locale}`, () => {
  const pt = locale === 'pt-BR';
  const saved = { client: 'codex', class: 'simple', model: 'gpt-a' }, kept = { client: 'claude-code', class: 'hard' };
  const keptLine = pt
    ? 'As escolhas mais novas foram mantidas para Claude Code (Tarefas complexas): elas mudaram enquanto você escolhia. Confira: MCP config_get {}'
    : 'Newer choices were kept for Claude Code (Complex tasks): they changed while you were choosing. Check them: MCP config_get {}';
  const both = setupResultLines({ changes: [saved], skipped: [], kept: [kept], omitted: [], guidance: [] }, locale, 'okit-plugin');
  assert.ok(both.includes(pt ? '1 escolhas de modelos salvas: Codex (Tarefas pequenas).' : 'Saved 1 model choices: Codex (Small tasks).'), both.join('\n'));
  assert.ok(both.includes(keptLine), both.join('\n'));
  assert.ok(both.includes(`${pt ? 'Próximo' : 'Next'}: okit-plugin doctor --client codex`), both.join('\n'));
  assert.deepEqual(setupResultLines({ changes: [], skipped: [], kept: [kept], omitted: [], guidance: [] }, locale, 'okit-plugin'), [keptLine]);
});

for (const locale of LOCALES) test(`D112 round 2, 7: all choices are already saved only when nothing was omitted or kept: ${locale}`, () => {
  const pt = locale === 'pt-BR';
  const title = pt ? 'Todas as escolhas de modelos já estão salvas. Nada mudou.' : 'All model choices are already saved. Nothing changed.';
  const skipped = { client: 'codex', class: 'simple', model: 'gpt-a' }, other = { client: 'claude-code', class: 'hard' };
  assert.ok(setupResultLines({ changes: [], skipped: [skipped], kept: [], omitted: [], guidance: [] }, locale, 'okit-plugin').includes(title));
  const mixed = setupResultLines({ changes: [], skipped: [skipped], kept: [], omitted: [other], guidance: [] }, locale, 'okit-plugin');
  assert.ok(!mixed.includes(title), mixed.join('\n'));
  assert.ok(mixed.includes(pt ? 'Já salvas, sem mudança: Codex (Tarefas pequenas).' : 'Already saved, unchanged: Codex (Small tasks).'), mixed.join('\n'));
  assert.ok(mixed.includes(pt
    ? 'Nenhuma escolha de modelo foi salva para Claude Code (Tarefas complexas): os modelos ativos não correspondem às escolhas recomendadas.'
    : 'No model choices were saved for Claude Code (Complex tasks): the active models did not match the recommended choices.'), mixed.join('\n'));
  const withKept = setupResultLines({ changes: [], skipped: [skipped], kept: [other], omitted: [], guidance: [] }, locale, 'okit-plugin');
  assert.ok(!withKept.includes(title), withKept.join('\n'));
});

// Round 3: every command of the output comes from one builder, from the state after the run, and a failure keeps what was done.
const label = (locale, key) => createPresenter({ locale, write: () => {} }).text(key);

for (const locale of LOCALES) test(`D112 round 3, 1: once the last link is gone, installing again names the running program: ${locale}`, async (t) => {
  const pt = locale === 'pt-BR';
  const again = pt ? 'Instale novamente quando precisar' : 'Install again when needed';
  const gone = render('uninstall', locale, (ui) => ui.header({ client: 'Codex', version: '1' }),
    { code: 0, client: 'codex', flags: ['--client', 'codex'], program: 'node /x/cli.js', before: { codex: { client: 'codex', link: true } }, after: {} });
  assert.ok(gone.includes(`${again}: node /x/cli.js install --client codex`), gone.join('\n'));
  const kept = render('uninstall', locale, (ui) => ui.header({ client: 'Codex', version: '1' }),
    { code: 0, client: 'codex', flags: ['--client', 'codex'], program: 'node /x/cli.js', before: { codex: { client: 'codex', link: true } }, after: { opencode: { client: 'opencode', link: true } } });
  assert.ok(kept.includes(`${pt ? 'Verifique a instalação restante' : 'Check the remaining installation'}: okit-plugin doctor --client opencode`), kept.join('\n'));

  const f = await fixture(t, 'linux');
  f.io.env.OKIT_LANGUAGE = locale;
  assert.equal(await main(['install', '--client', 'codex'], f.io), 0, f.output.join('\n'));
  f.clear();
  assert.equal(await main(['uninstall', '--client', 'codex', '--yes'], f.io), 0, f.output.join('\n'));
  const line = lineOf(f.output, `${again}: `);
  assert.equal(line, `${again}: ${RUNNING} install --client codex`, f.output.join('\n'));
  f.clear();
  assert.equal(await main(argsOf(line), f.io), 0, f.output.join('\n'));
  assert.ok(f.output.some((out) => out.startsWith(pt ? 'Instalado para Codex.' : 'Installed for Codex.')), f.output.join('\n'));
});

for (const locale of LOCALES) for (const platform of ['linux', 'win32']) test(`D112 round 3, 2: a command with a space is quoted for the shell of ${platform}: ${locale}`, () => {
  const pt = locale === 'pt-BR';
  const output = [], view = createInstallerView({ operation: 'update', command: 'my plugin', locale, write: (line) => output.push(line) });
  view.ui.header({ client: 'Codex', version: '2' });
  view.ui.note(`Models: not set yet. Run: ${view.ui.command([], { later: true })} setup`);
  const records = (version) => ({ codex: { client: 'codex', version, link: true } });
  view.finish({ code: 0, client: 'codex', flags: ['--client', 'codex'], program: 'node /x/cli.js', platform, before: records('1'), after: records('2') });
  const program = platform === 'win32' ? "& 'my plugin'" : "'my plugin'";
  assert.ok(output.includes(`${pt ? 'Próximo: reinicie Codex e rode: ' : 'Next: restart Codex, then run: '}${program} doctor --client codex`), output.join('\n'));
  assert.ok(output.some((line) => line.includes(`Run: ${program} setup`)), output.join('\n'));
  assert.ok(!output.some((line) => /(^|[^'\w])my plugin (doctor|setup)/.test(line)), output.join('\n'));
});

for (const locale of LOCALES) test(`D112 round 3, 3: a failure keeps the steps already done and the backup folder: ${locale}`, () => {
  const pt = locale === 'pt-BR';
  const done = pt ? 'concluído' : 'complete';
  const update = render('update', locale, (ui) => {
    ui.header({ client: 'Codex', version: '2' });
    const step = ui.sequence(['get', 'backup', 'files']);
    step('get').ok();
    step('backup').ok('/data/backups/17');
    step('files').fail('registry down');
  }, { code: 1, client: 'codex', flags: ['--client', 'codex'] });
  const text = update.join('\n');
  const cause = update.indexOf(failedAt(locale, 'files', 'registry down'));
  const backup = update.indexOf(`2. ${label(locale, 'backup')}: ${done} — /data/backups/17`);
  assert.ok(cause >= 0 && backup > cause, text);
  assert.ok(update.includes(`1. ${label(locale, 'get')}: ${done}`), text);
  assert.ok(!update.some((line) => line.startsWith('3. ')), text);

  // After a client was chosen from the menu the same steps are told.
  const install = render('install', locale, (ui) => {
    ui.explain([ui.text('clientChoose'), ...['claude-code', 'codex'].map((id, index) => `  ${index + 1}. ${id} (${ui.text('clientDetected')})`)]);
    ui.header({ client: 'Codex', version: '2' });
    const step = ui.sequence(['get', 'files']);
    step('get').ok();
    step('files').fail('disk is full');
  }, { code: 1 });
  assert.ok(install.includes(`1. ${label(locale, 'get')}: ${done}`), install.join('\n'));
  assert.ok(install.includes(failedAt(locale, 'files', 'disk is full')), install.join('\n'));
});

for (const locale of LOCALES) test(`D112 round 3, 4: the guides of the notes name the program that runs and are executed: ${locale}`, async (t) => {
  const pt = locale === 'pt-BR';
  // A line raised while the installer works is resolved at once; with the command link it is the plain command.
  for (const [linked, program] of [[false, 'node /x/cli.js'], [true, 'okit-plugin']]) {
    const output = [], view = createInstallerView({ operation: 'install', command: 'okit-plugin', locale, write: (line) => output.push(line),
      launch: { program: 'node /x/cli.js', platform: 'linux', linked } });
    view.ui.explain([`You can redo it later with ${view.ui.command([], { later: true })} setup.`, 'A plain okit-plugin setup stays as written.']);
    assert.ok(output.includes(`You can redo it later with ${program} setup.`), output.join('\n'));
    assert.ok(output.includes('A plain okit-plugin setup stays as written.'), output.join('\n'));
  }
  const f = await fixture(t, 'linux');
  f.io.env.OKIT_LANGUAGE = locale;
  assert.equal(await main(['install', '--client', 'claude-code', '--no-link'], f.io), 0, f.output.join('\n'));
  const text = f.output.join('\n');
  assert.deepEqual(f.output.filter((line) => /(^|[^\w./-])okit-plugin (setup|install|doctor|update|uninstall)\b/.test(line)), [], text);
  const models = f.output.find((line) => line.includes(`${RUNNING} setup`) && !line.startsWith(pt ? 'Próximo' : 'Next'));
  assert.ok(models, text);
  const quota = f.output.find((line) => line.includes(`${RUNNING} install --client claude-code --statusline`));
  assert.ok(quota, text);
  f.clear();
  assert.equal(await main(argsOf(quota), f.io), 0, f.output.join('\n'));
});

for (const locale of LOCALES) test(`D112 round 3, 5: an install into a custom folder says where it is instead of a doctor that looks elsewhere: ${locale}`, async (t) => {
  const pt = locale === 'pt-BR';
  const f = await fixture(t, 'linux');
  f.io.env.OKIT_LANGUAGE = locale;
  const dest = join(f.home, 'custom-dest');
  assert.equal(await main(['install', '--client', 'claude-code', '--no-link', '--dest', dest], f.io), 0, f.output.join('\n'));
  const text = f.output.join('\n');
  assert.ok(!f.output.some((line) => line.startsWith(pt ? 'Verifique a instalação' : 'Check the installation')), text);
  assert.ok(!f.output.some((line) => line.includes(`${RUNNING} doctor`)), text);
  const where = lineOf(f.output, `${pt ? 'Pasta da instalação' : 'Installation folder'}: `);
  assert.ok(where?.includes('custom-dest'), text);
  // The commands that install again carry the folder, so they reach the installation that was made.
  const quota = f.output.find((line) => line.includes('--statusline') && line.includes(RUNNING));
  assert.ok(quota?.includes(`${RUNNING} install --dest ${dest} --client claude-code --statusline`), text);
  f.clear();
  assert.equal(await main(argsOf(quota), f.io), 0, f.output.join('\n'));
});

// Round 4: a command in a text is written as a marker by whoever generates it and only the view swaps the marker for the
// command; a text with no marker (a path, a message) is never touched.
const isProbe = (spec) => (spec.args ?? []).some((argument) => String(argument).endsWith('selfcheck-probe.js'));
/** A fixture whose MCP check of the self-check fails, so an install ends with a Fix line; `heal()` makes it answer again. */
const failingCheck = async (t, locale) => {
  const f = await fixture(t, 'linux');
  f.io.env.OKIT_LANGUAGE = locale;
  const run = f.io.run;
  f.io.run = async (spec) => (isProbe(spec) ? { stdout: JSON.stringify({ mcp: { ok: false, error: { code: 'init-error', why: 'boom' } } }) } : run(spec));
  return { f, heal: () => { f.io.run = run; } };
};

for (const locale of LOCALES) test(`D112 round 4, 1: a path that holds a command name is printed as it is: ${locale}`, () => {
  const done = locale === 'pt-BR' ? 'concluído' : 'complete';
  const path = '/data/my okit-plugin setup/backups/17';
  const steps = (ui) => {
    ui.header({ client: 'Codex', version: '2' });
    const step = ui.sequence(['get', 'backup', 'files']);
    step('get').ok();
    step('backup').ok(path);
    return step;
  };
  const program = 'node /opt/cli.js';
  const failed = render('update', locale, (ui) => { steps(ui)('files').fail('registry down'); ui.note(`Kept at ${path}`); },
    { code: 1, client: 'codex', flags: ['--client', 'codex'], program });
  assert.ok(failed.includes(`2. ${label(locale, 'backup')}: ${done} — ${path}`), failed.join('\n'));
  assert.ok(failed.some((line) => line.includes(`Kept at ${path}`)), failed.join('\n'));
  const records = (version) => ({ codex: { client: 'codex', version, link: false } });
  const passed = render('update', locale, (ui) => { const step = steps(ui); step('files').ok(); ui.note(`Kept at ${path}`); },
    { code: 0, client: 'codex', flags: ['--client', 'codex'], program, before: records('1'), after: records('2') });
  assert.ok(passed.includes(`2. ${label(locale, 'backup')}: ${done} — ${path}`), passed.join('\n'));
  assert.ok(passed.some((line) => line.includes(`Kept at ${path}`)), passed.join('\n'));
  for (const line of [...failed, ...passed]) assert.ok(!line.includes('my node /opt/cli.js'), line);
});

for (const locale of LOCALES) test(`D112 round 4, 2: the Fix of the self-check carries the folder of the install and is executed: ${locale}`, async (t) => {
  const { f, heal } = await failingCheck(t, locale);
  const dest = join(f.home, 'custom-dest');
  assert.equal(await main(['install', '--client', 'claude-code', '--no-link', '--dest', dest], f.io), 1, f.output.join('\n'));
  const fix = f.output.find((line) => line.includes(locale === 'pt-BR' ? 'Correção:' : 'Fix:') && line.includes(RUNNING));
  assert.ok(fix?.includes(`${RUNNING} install --dest ${dest} --client claude-code`), f.output.join('\n'));
  heal();
  f.clear();
  assert.equal(await main(argsOf(fix), f.io), 0, f.output.join('\n'));
});

for (const locale of LOCALES) test(`D112 round 4, 3: the setup accepted for an install into a custom folder offers no doctor: ${locale}`, async (t) => {
  const pt = locale === 'pt-BR';
  const f = await fixture(t, 'linux');
  const adapters = [{ CLIENT: 'codex', listModels: async () => ({ client: 'codex', installed: true, models: ['sol', 'astra'], source: 'listing' }) }];
  const saved = { changes: [{ client: 'codex' }], skipped: [], omitted: [], guidance: [] };
  assert.ok(setupResultLines(saved, locale, 'okit-plugin').some((line) => line.includes('okit-plugin doctor --client codex')));
  assert.ok(!setupResultLines(saved, locale, 'okit-plugin', { doctor: false }).some((line) => line.includes('doctor')));
  assert.ok(!setupResultLines({ ...saved, changes: [], skipped: [{ client: 'codex' }] }, locale, 'okit-plugin', { doctor: false }).some((line) => line.includes('doctor')));

  const output = [], answers = ['y', '1', '1', '2', 'yes'];
  const dest = '/data/custom';
  const view = createInstallerView({ operation: 'install', command: 'okit-plugin', locale, write: (line) => output.push(line),
    launch: { program: RUNNING, platform: 'linux', linked: false, dest } });
  view.ui.header({ client: 'Codex', version: '1' });
  await offerSetup({ root: f.root, command: 'okit-plugin', locale, ui: view.ui, tty: true, ask: async () => answers.shift(),
    run: f.io.run, env: f.io.env, adapters });
  assert.ok(output.includes(pt ? '3 escolhas de modelos salvas para Codex.' : 'Saved 3 model choices for Codex.'), output.join('\n'));
  view.finish({ code: 0, client: 'codex', flags: ['--client', 'codex', '--no-link', '--dest', dest], program: RUNNING, platform: 'linux',
    after: { codex: { client: 'codex', link: false } }, destination: dest });
  assert.ok(output.some((line) => line.startsWith(`${pt ? 'Pasta da instalação' : 'Installation folder'}: ${dest}`)), output.join('\n'));
  assert.ok(!output.some((line) => line.includes('doctor --')), output.join('\n'));
});

for (const locale of LOCALES) test(`D112 round 4, 4: after the last client is removed the install again names a program that still exists: ${locale}`, async (t) => {
  const pt = locale === 'pt-BR';
  const again = pt ? 'Instale novamente quando precisar' : 'Install again when needed';
  const f = await fixture(t, 'linux');
  f.io.env.OKIT_LANGUAGE = locale;
  await filesystem.mkdir(f.bin, { recursive: true });
  await filesystem.symlink(process.execPath, join(f.bin, 'node'));
  assert.equal(await main(['install', '--client', 'codex'], f.io), 0, f.output.join('\n'));
  assert.ok(await filesystem.stat(join(f.bin, 'okit-plugin')).then(() => true, () => false), 'the command is linked before the removal');
  f.clear();
  assert.equal(await main(['uninstall', '--client', 'codex', '--yes'], f.io), 0, f.output.join('\n'));
  assert.ok(await filesystem.stat(join(f.bin, 'okit-plugin')).then(() => false, () => true), 'the command is gone after the removal');
  const line = lineOf(f.output, `${again}: `);
  assert.equal(line, `${again}: ${RUNNING} install --client codex`, f.output.join('\n'));
  f.clear();
  assert.equal(await main(argsOf(line), f.io), 0, f.output.join('\n'));
  assert.ok(f.output.some((out) => out.startsWith(pt ? 'Instalado para Codex.' : 'Installed for Codex.')), f.output.join('\n'));

  // When the running CLI was inside the payload that was deleted nothing runs any more (the bare command went with the link).
  const gone = { ...filesystem, access: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } };
  const survivor = (files) => programLine({ config: f.io.config, platform: 'linux', env: { PATH: '' }, fs: files, afterRemoval: true });
  assert.equal(await survivor(gone), null);
  assert.equal(await survivor(filesystem), RUNNING);
});

for (const locale of LOCALES) test(`D112 round 4, 5: a failure keeps the skipped quota step and its remedy, which is executed: ${locale}`, async (t) => {
  const { f, heal } = await failingCheck(t, locale);
  assert.equal(await main(['install', '--client', 'claude-code', '--no-link'], f.io), 1, f.output.join('\n'));
  const quota = f.output.find((line) => /^\d+\. /.test(line) && line.includes(`${RUNNING} install --client claude-code --statusline`));
  assert.ok(quota?.includes(`. ${label(locale, 'quota')}: `), f.output.join('\n'));
  heal();
  f.clear();
  assert.equal(await main(argsOf(quota), f.io), 0, f.output.join('\n'));
});

// Round 5.
for (const locale of LOCALES) test(`D112 round 5, 1: a text with the control characters of a token is never read as a command: ${locale}`, () => {
  const forged = '/data/\u0001ninstall\u0003/\u0001linstall --client codex\u0003';
  const output = render('install', locale, (ui) => { ui.header({ client: 'Codex', version: '1' }); ui.row('Path', 'info', forged); },
    { code: 0, client: 'codex', flags: ['--client', 'codex'] });
  assert.ok(output.join('\n').includes(forged), output.join('\n'));
});

for (const locale of LOCALES) test(`D112 round 5, 2: when nothing that runs is left the way back is the installer of the release: ${locale}`, () => {
  const pt = locale === 'pt-BR';
  for (const [platform, installer] of [['linux', 'sh install.sh'], ['win32', './install.ps1']]) {
    const output = render('uninstall', locale, (ui) => ui.header({ client: 'Codex', version: '1' }),
      { code: 0, client: 'codex', flags: ['--client', 'codex', '--yes'], program: null, platform, before: { codex: { client: 'codex', link: true } }, after: {} });
    const line = output.find((text) => text.startsWith(`${pt ? 'Instale novamente quando precisar' : 'Install again when needed'}: `));
    assert.equal(line?.split(': ').slice(1).join(': '), `${installer} --client codex`, output.join('\n'));
    assert.doesNotMatch(output.join('\n'), /okit-plugin install|null/);
  }
});

for (const locale of LOCALES) test(`D112 round 5, 3: the standalone setup names the program this terminal can start: ${locale}`, async (t) => {
  const f = await fixture(t, 'linux');
  f.io.env.OKIT_LANGUAGE = locale;
  f.io.env.PATH = '/usr/bin';
  await main(['setup', '--defaults'], f.io);
  const text = f.output.join('\n');
  assert.doesNotMatch(text, /(^|[ `'"])okit-plugin (setup|doctor)/m, text);
});
