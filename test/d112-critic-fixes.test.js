import test from 'node:test';
import assert from 'node:assert/strict';
import * as filesystem from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import { createInstallerView, createPresenter, presentDiagnosis, presentModelChoices, programLine, setupResultLines } from '../src/cli-present.js';
import { offerSetup } from '../src/setup/offer.js';
import { shown } from '../src/install/mcp-register.js';
import { commandToken, resolveTokens } from '../src/install/command-token.js';
import { answerCheck, fixture } from './helpers/install-fixture.js';

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
  assert.ok(output.includes(pt ? 'Codex está em dia.' : 'Codex is up to date.'), text); // locale:pt-BR
  assert.ok(output.includes(pt ? 'Claude Code atualizado de 1 para 2.' : 'Updated Claude Code from 1 to 2.'), text);
  assert.doesNotMatch(text, /Nothing changed|Nada mudou/);
  // The client that did not change is never the one told as updated.
  assert.doesNotMatch(text, pt ? /Codex atualizado/ : /Updated Codex/);
  // Only when every client is current the run says that nothing changed.
  const current = render('update', locale, (ui) => {
    ui.header({ client: 'Codex', version: '1' });
    ui.row(ui.text('upToDate'), 'ok', '1');
    ui.header({ client: 'Claude Code', version: '2' });
    ui.row(ui.text('upToDate'), 'ok', '2');
    ui.endClients();
  }, { code: 0, client: 'all', before: { codex: { version: '1' }, 'claude-code': { version: '2' } }, after: { codex: { version: '1' }, 'claude-code': { version: '2' } } });
  const currentText = current.join('\n');
  assert.ok(currentText.includes(pt ? 'Nada mudou' : 'Nothing changed'), currentText);
  assert.ok(currentText.includes(pt ? 'Codex, Claude Code estão em dia' : 'Codex, Claude Code are up to date'), currentText); // locale:pt-BR
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
  const failedAt = pt ? 'Falhou em Baixar e verificar: ' : 'Failed at Download and verify: '; // locale:pt-BR
  assert.ok(output.includes(`${failedAt}disk is full (Codex)`), text);
  assert.ok(output.includes(`${failedAt}bad archive (Claude Code)`), text);
  assert.ok(output.some((line) => line.startsWith(`${pt ? 'Confira sua conexão e tente' : 'Check your connection, then retry'} (Codex): `)), text); // locale:pt-BR
  assert.ok(output.some((line) => line.startsWith(`${pt ? 'Confira sua conexão e tente' : 'Check your connection, then retry'} (Claude Code): `)), text); // locale:pt-BR
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
  assert.ok(partial.includes(pt ? 'Alguns clientes foram instalados. Outros precisam de atenção.' : 'Some clients were installed. Others need attention.'), partial.join('\n')); // locale:pt-BR
  const none = render('install', locale, failures([['codex', 'Codex', 'get'], ['claude-code', 'Claude Code', 'get']]), { code: 1, client: 'all' });
  assert.ok(none.includes(pt ? 'Nenhum cliente foi instalado.' : 'No client was installed.'), none.join('\n')); // locale:pt-BR
  const installed = render('install', locale, failures([['codex', 'Codex', 'register'], ['claude-code', 'Claude Code', 'register']]), { code: 1, client: 'all' });
  assert.doesNotMatch(installed.join('\n'), /No client was installed|Nenhum cliente foi instalado/); // locale:pt-BR
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
  assert.doesNotMatch(unmatched.join('\n'), /No client with an active model|Nenhum cliente com modelo ativo/); // locale:pt-BR
  assert.match(unmatched[0], pt ? /não correspondem/ : /did not match/); // locale:pt-BR
});

for (const locale of LOCALES) test(`D112 critic 6: the model rows carry the client when several are confirmed: ${locale}`, () => {
  const pt = locale === 'pt-BR';
  const rows = (changes) => { const output = []; presentModelChoices({ locale, changes, command: 'okit-plugin', out: (line) => output.push(line) }); return output; };
  const several = rows([{ client: 'codex', class: 'simple', model: 'gpt-a' }, { client: 'claude-code', class: 'simple', model: 'sonnet-b' }]);
  assert.ok(several.includes(`| Codex | ${pt ? 'Tarefas pequenas' : 'Small tasks'} | gpt-a |`), several.join('\n')); // locale:pt-BR
  assert.ok(several.includes(`| Claude Code | ${pt ? 'Tarefas pequenas' : 'Small tasks'} | sonnet-b |`), several.join('\n')); // locale:pt-BR
  const one = rows([{ client: 'codex', class: 'simple', model: 'gpt-a' }]);
  assert.ok(one.includes(`| ${pt ? 'Tarefas pequenas' : 'Small tasks'} | gpt-a |`), one.join('\n')); // locale:pt-BR
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
  assert.ok(failed.includes(`${pt ? 'Depois confira' : 'Then check'}: ${program} doctor --client 'my client'`), failed.join('\n')); // locale:pt-BR
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
  const retry = `${locale === 'pt-BR' ? 'Confira sua conexão e tente' : 'Check your connection, then retry'}: ${program} install --client claude-code`; // locale:pt-BR
  assert.ok(f.output.includes(retry), f.output.join('\n'));
});

// Round 2: the commands the output prints are built from what the run did, and each of them is executed here.
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
/** The program as the output names it when the command is not on the PATH of the fixture. */
const RUNNING = shown([process.execPath, CLI], 'linux');
/** The arguments of the command a line prints (the words after the program). */
const argsOf = (line) => line.slice(line.indexOf(RUNNING) + RUNNING.length).trim().split(' ');
const lineOf = (output, prefix) => output.map((line) => line.trimStart()).find((line) => line.startsWith(prefix));
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
  assert.doesNotMatch(text, /Install for|Instale para/); // locale:pt-BR
});

for (const locale of LOCALES) test(`D112 round 2, 3: the retry of a failed purge is one command that the installer accepts: ${locale}`, async (t) => {
  const pt = locale === 'pt-BR';
  const f = await fixture(t, 'linux');
  for (const client of ['claude-code', 'codex']) assert.equal(await main(['install', '--client', client], f.io), 0, f.output.join('\n'));
  f.io.env.OKIT_LANGUAGE = locale;
  // No Node on the PATH: the retry names the program that runs (and `argsOf` below runs it in this process).
  f.io.env.PATH = f.bin;
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
  // Not ready yet (the models are not confirmed): the row of the table names the setup, by the running program too.
  const setup = f.output.find((line) => line.includes('setup') && line.includes(RUNNING));
  assert.ok(setup?.includes(`${RUNNING} setup`), f.output.join('\n'));
  const check = lineOf(f.output, `${pt ? 'Verifique a instalação' : 'Check the installation'}: `); // locale:pt-BR
  assert.equal(check, `${pt ? 'Verifique a instalação' : 'Check the installation'}: ${RUNNING} doctor --client claude-code`, f.output.join('\n')); // locale:pt-BR
  f.clear();
  await main(argsOf(check), f.io);
  assert.equal(f.output[0], `okit-plugin — ${pt ? 'Verificação da instalação' : 'Installation check'}`, f.output.join('\n')); // locale:pt-BR
  f.setVersion('2.0.0');
  f.clear();
  assert.equal(await main(['update'], f.io), 0, f.output.join('\n'));
  // Every follow-up of the update names the running program too: the setup it still offers and the rollback.
  const again = f.output.find((line) => line.includes('setup') && line.includes(RUNNING));
  assert.ok(again?.includes(`${RUNNING} setup`), f.output.join('\n'));
  const rollback = lineOf(f.output, `${pt ? 'Volte à versão guardada' : 'Return to the retained version'}: `); // locale:pt-BR
  assert.equal(rollback, `${pt ? 'Volte à versão guardada' : 'Return to the retained version'}: ${RUNNING} update --rollback`, f.output.join('\n')); // locale:pt-BR
  // The bare command is never the one to type.
  assert.deepEqual(f.output.filter((line) => /(^|[\s'"])okit-plugin (setup|install|doctor|update|uninstall)\b/.test(line)), [], f.output.join('\n'));
  f.clear();
  assert.equal(await main(argsOf(rollback), f.io), 0, f.output.join('\n'));
});

for (const locale of LOCALES) test(`D112 round 2, 5: without a client in evidence the first install names none: ${locale}`, async (t) => {
  const pt = locale === 'pt-BR';
  const f = await fixture(t, 'linux');
  f.io.env.OKIT_LANGUAGE = locale;
  f.io.detect = async (executable) => executable === 'codex';
  assert.equal(await main(['update'], f.io), 2, f.output.join('\n'));
  const first = lineOf(f.output, `${pt ? 'Instale primeiro' : 'Install first'}: `); // locale:pt-BR
  assert.equal(first, `${pt ? 'Instale primeiro' : 'Install first'}: ${RUNNING} install`, f.output.join('\n')); // locale:pt-BR
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
    ? 'As escolhas mais novas foram mantidas para Claude Code (Tarefas complexas): elas mudaram enquanto você escolhia. Confira: MCP config_get {}' // locale:pt-BR
    : 'Newer choices were kept for Claude Code (Complex tasks): they changed while you were choosing. Check them: MCP config_get {}';
  const both = setupResultLines({ changes: [saved], skipped: [], kept: [kept], omitted: [], guidance: [] }, locale, 'okit-plugin');
  assert.ok(both.includes(pt ? '1 escolhas de modelos salvas: Codex (Tarefas pequenas).' : 'Saved 1 model choices: Codex (Small tasks).'), both.join('\n')); // locale:pt-BR
  assert.ok(both.includes(keptLine), both.join('\n'));
  assert.ok(both.includes(`${pt ? 'Próximo' : 'Next'}: okit-plugin doctor --client codex`), both.join('\n')); // locale:pt-BR
  assert.deepEqual(setupResultLines({ changes: [], skipped: [], kept: [kept], omitted: [], guidance: [] }, locale, 'okit-plugin'), [keptLine]);
});

for (const locale of LOCALES) test(`D112 round 2, 7: all choices are already saved only when nothing was omitted or kept: ${locale}`, () => {
  const pt = locale === 'pt-BR';
  const title = pt ? 'Todas as escolhas de modelos já estão salvas. Nada mudou.' : 'All model choices are already saved. Nothing changed.'; // locale:pt-BR
  const skipped = { client: 'codex', class: 'simple', model: 'gpt-a' }, other = { client: 'claude-code', class: 'hard' };
  assert.ok(setupResultLines({ changes: [], skipped: [skipped], kept: [], omitted: [], guidance: [] }, locale, 'okit-plugin').includes(title));
  const mixed = setupResultLines({ changes: [], skipped: [skipped], kept: [], omitted: [other], guidance: [] }, locale, 'okit-plugin');
  assert.ok(!mixed.includes(title), mixed.join('\n'));
  assert.ok(mixed.includes(pt ? 'Já salvas, sem mudança: Codex (Tarefas pequenas).' : 'Already saved, unchanged: Codex (Small tasks).'), mixed.join('\n')); // locale:pt-BR
  assert.ok(mixed.includes(pt
    ? 'Nenhuma escolha de modelo foi salva para Claude Code (Tarefas complexas): os modelos ativos não correspondem às escolhas recomendadas.' // locale:pt-BR
    : 'No model choices were saved for Claude Code (Complex tasks): the active models did not match the recommended choices.'), mixed.join('\n'));
  const withKept = setupResultLines({ changes: [], skipped: [skipped], kept: [other], omitted: [], guidance: [] }, locale, 'okit-plugin');
  assert.ok(!withKept.includes(title), withKept.join('\n'));
});

// Round 3: every command of the output comes from one builder, from the state after the run, and a failure keeps what was done.
const label = (locale, key) => createPresenter({ locale, write: () => {} }).text(key);

for (const locale of LOCALES) test(`D112 round 3, 1: once the last link is gone, installing again names the running program: ${locale}`, async (t) => {
  const pt = locale === 'pt-BR';
  const again = pt ? 'Instale novamente quando precisar' : 'Install again when needed'; // locale:pt-BR
  const gone = render('uninstall', locale, (ui) => ui.header({ client: 'Codex', version: '1' }),
    { code: 0, client: 'codex', flags: ['--client', 'codex'], program: 'node /x/cli.js', before: { codex: { client: 'codex', link: true } }, after: {} });
  assert.ok(gone.includes(`${again}: node /x/cli.js install --client codex`), gone.join('\n'));
  const kept = render('uninstall', locale, (ui) => ui.header({ client: 'Codex', version: '1' }),
    { code: 0, client: 'codex', flags: ['--client', 'codex'], program: 'node /x/cli.js', before: { codex: { client: 'codex', link: true } }, after: { opencode: { client: 'opencode', link: true } } });
  assert.ok(kept.includes(`${pt ? 'Verifique a instalação restante' : 'Check the remaining installation'}: okit-plugin doctor --client opencode`), kept.join('\n')); // locale:pt-BR

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
  const output = [], view = createInstallerView({ operation: 'install', command: 'my plugin', locale, write: (line) => output.push(line) });
  view.ui.header({ client: 'Codex', version: '2' });
  view.ui.note(`Models: not set yet. Run: ${view.ui.command([], { later: true })} setup`);
  const records = (version) => ({ codex: { client: 'codex', version, link: true } });
  view.finish({ code: 0, client: 'codex', flags: ['--client', 'codex'], program: 'node /x/cli.js', platform, before: records('1'), after: records('2') });
  const program = platform === 'win32' ? "& 'my plugin'" : "'my plugin'";
  // Every command of the output is quoted for the shell of the platform.
  assert.ok(output.some((line) => line.includes(`Run: ${program} setup`)), output.join('\n'));
  assert.ok(output.some((line) => line.includes(`${pt ? 'Verifique a instalação' : 'Check the installation'}: ${program} doctor --client codex`)), output.join('\n')); // locale:pt-BR
  assert.ok(!output.some((line) => /(^|[^'\w])my plugin (doctor|setup)/.test(line)), output.join('\n'));
});

for (const locale of LOCALES) test(`D112 round 3, 3: a failure keeps the steps already done and the backup folder: ${locale}`, () => {
  const pt = locale === 'pt-BR';
  const done = pt ? 'concluído' : 'complete'; // locale:pt-BR
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
  const models = f.output.find((line) => line.includes(`${RUNNING} setup`) && !line.startsWith(pt ? 'Próximo' : 'Next')); // locale:pt-BR
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
  assert.ok(!f.output.some((line) => line.trimStart().startsWith(pt ? 'Verifique a instalação' : 'Check the installation')), text); // locale:pt-BR
  // No doctor is offered at all: the one that would look elsewhere is not named, by the running program or not.
  assert.ok(!f.output.some((line) => /\bdoctor\b\s+--/.test(line)), text);
  const where = lineOf(f.output, `${pt ? 'Pasta da instalação' : 'Installation folder'}: `); // locale:pt-BR
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
  const done = locale === 'pt-BR' ? 'concluído' : 'complete'; // locale:pt-BR
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
  const fix = f.output.find((line) => line.includes(locale === 'pt-BR' ? 'Correção:' : 'Fix:') && line.includes(RUNNING)); // locale:pt-BR
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
  assert.ok(output.includes(pt ? '3 escolhas de modelos salvas para Codex.' : 'Saved 3 model choices for Codex.'), output.join('\n')); // locale:pt-BR
  view.finish({ code: 0, client: 'codex', flags: ['--client', 'codex', '--no-link', '--dest', dest], program: RUNNING, platform: 'linux',
    after: { codex: { client: 'codex', link: false } }, destination: dest });
  assert.ok(output.some((line) => line.trimStart().startsWith(`${pt ? 'Pasta da instalação' : 'Installation folder'}: ${dest}`)), output.join('\n')); // locale:pt-BR
  assert.ok(!output.some((line) => line.includes('doctor --')), output.join('\n'));
});

for (const locale of LOCALES) test(`D112 round 4, 4: after the last client is removed the install again names a program that still exists: ${locale}`, async (t) => {
  const pt = locale === 'pt-BR';
  const again = pt ? 'Instale novamente quando precisar' : 'Install again when needed'; // locale:pt-BR
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
  const survivor = (files) => programLine({ config: f.io.config, platform: 'linux', env: { PATH: '' }, fs: files, remaining: [] });
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
    const line = output.find((text) => text.startsWith(`${pt ? 'Instale novamente quando precisar' : 'Install again when needed'}: `)); // locale:pt-BR
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

// Round 6.
test('D112 round 6, 1: a program path with the control characters and the percent sign survives the token', () => {
  const program = "'/opt/a\u0002b\u0003c%25d/node'";
  const text = `Fix: ${commandToken(['install', '--client', 'codex'], { program })}.`;
  const seen = [];
  const resolved = resolveTokens(text, (words, options) => { seen.push({ words, options }); return `${options.program} ${words.join(' ')}`; });
  assert.deepEqual(seen, [{ words: ['install', '--client', 'codex'], options: { later: false, program } }]);
  assert.equal(resolved, `Fix: ${program} install --client codex.`);
  const word = resolveTokens(commandToken(['a\u0002b', '100%']), (words) => words.join('|'));
  assert.equal(word, 'a\u0002b|100%');
});

for (const locale of LOCALES) test(`D112 round 6, 2: after an uninstall the program is the CLI of an installation that is left: ${locale}`, async (t) => {
  const f = await fixture(t, 'linux');
  const staying = join(f.root, 'claude-payload');
  await filesystem.mkdir(join(staying, 'src'), { recursive: true });
  await filesystem.writeFile(join(staying, 'src/cli.js'), '// cli\n');
  // The running CLI is the one that was just deleted with the payload of the departing client.
  const files = { access: (path) => (path === CLI ? Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' })) : filesystem.access(path)) };
  const ask = (remaining) => programLine({ config: f.io.config, platform: 'linux', env: { PATH: '' }, fs: files, remaining });
  assert.equal(await ask([staying]), shown([process.execPath, join(staying, 'src/cli.js')], 'linux'), locale);
  assert.equal(await ask([join(f.root, 'missing-payload'), staying]), shown([process.execPath, join(staying, 'src/cli.js')], 'linux'));
  assert.equal(await ask([join(f.root, 'missing-payload')]), null);
  assert.equal(await ask([]), null);
});

for (const locale of LOCALES) test(`D112 round 6, 3: setup --defaults names every saved model and its work class: ${locale}`, async (t) => {
  const pt = locale === 'pt-BR';
  const f = await fixture(t, 'linux');
  f.io.env.OKIT_LANGUAGE = locale;
  f.io.adapters = [{ CLIENT: 'claude-code', listModels: async () => ({ client: 'claude-code', installed: true, models: ['haiku', 'sonnet', 'opus'], hidden: [], source: 'listing' }) }];
  f.io.run = answerCheck;
  assert.equal(await main(['setup', '--defaults'], f.io), 0, f.output.join('\n'));
  const text = f.output.join('\n');
  assert.ok(f.output.some((line) => line.includes(pt ? 'Trabalho | Modelo' : 'Work | Model')), text); // locale:pt-BR
  for (const model of ['haiku', 'sonnet', 'opus']) assert.ok(f.output.some((line) => line.startsWith('| ') && line.endsWith(`| ${model} |`)), `${model}\n${text}`);
  for (const work of pt ? ['Tarefas pequenas', 'Tarefas do dia a dia', 'Tarefas complexas'] : ['Small tasks', 'Everyday tasks', 'Complex tasks']) { // locale:pt-BR
    assert.ok(f.output.some((line) => line.startsWith('| ') && line.includes(work)), `${work}\n${text}`);
  }
});

// Round 7.
for (const locale of LOCALES) test(`D112 round 7, 1: a kept link that no new terminal finds does not stand for the command: ${locale}`, () => {
  const pt = locale === 'pt-BR';
  const prefix = `${pt ? 'Verifique a instalação restante' : 'Check the remaining installation'}: `; // locale:pt-BR
  const kept = { codex: { client: 'codex', link: true } };
  const check = (pathReady) => render('uninstall', locale, (ui) => ui.header({ client: 'Claude Code', version: '1' }),
    { code: 0, client: 'claude-code', flags: ['--client', 'claude-code', '--yes'], program: RUNNING,
      before: { ...kept, 'claude-code': { client: 'claude-code', link: true } }, after: kept, pathReady })
    .find((line) => line.startsWith(prefix));
  assert.equal(check(true), `${prefix}okit-plugin doctor --client codex`);
  assert.equal(check(false), `${prefix}${RUNNING} doctor --client codex`);
});

test('D112 round 7, 1b: an install with --no-path names the program that runs, not the bare command', async (t) => {
  const f = await fixture(t, 'linux');
  f.io.env.PATH = '/usr/bin';
  assert.equal(await main(['install', '--client', 'codex', '--no-path'], f.io), 0, f.output.join('\n'));
  const text = f.output.join('\n');
  // The commands the output offers name the program that runs, never the bare command.
  const setup = f.output.find((line) => line.includes('setup') && line.includes(RUNNING));
  assert.ok(setup?.includes(`${RUNNING} setup`), text);
  const check = f.output.find((line) => line.includes('doctor') && line.includes(RUNNING));
  assert.ok(check?.includes(`${RUNNING} doctor --client codex`), text);
  assert.doesNotMatch(text, /(^|[\s'"])okit-plugin (setup|doctor|install|update|uninstall)\b/m);
});

for (const locale of LOCALES) test(`D112 round 7, 2: when no program is left the kept installations are put back by the installer of the release: ${locale}`, () => {
  const pt = locale === 'pt-BR';
  for (const [platform, installer] of [['linux', 'sh install.sh'], ['win32', './install.ps1']]) {
    const output = render('uninstall', locale, (ui) => ui.header({ client: 'Claude Code', version: '1' }),
      { code: 0, client: 'claude-code', flags: ['--client', 'claude-code', '--yes'], program: null, platform,
        before: { codex: { client: 'codex', link: false }, 'claude-code': { client: 'claude-code', link: false } }, after: { codex: { client: 'codex', link: false } } });
    const text = output.join('\n');
    assert.doesNotMatch(text, /doctor|null/, text);
    const line = output.find((entry) => entry.startsWith(`${pt ? 'Instale novamente para restaurar o comando' : 'Install again to restore the command'}: `)); // locale:pt-BR
    assert.equal(line?.split(': ').slice(1).join(': '), `${installer} --client codex`, text);
  }
});

for (const locale of LOCALES) test(`D112 round 7, 3: the copy the release installer unpacks is never the program to type afterwards: ${locale}`, async (t) => {
  const f = await fixture(t, 'linux');
  const unpacked = join(f.root, 'okit-bootstrap-abc123', 'extracted');
  await filesystem.mkdir(unpacked, { recursive: true });
  await filesystem.cp(fileURLToPath(new URL('../src', import.meta.url)), join(unpacked, 'src'), { recursive: true });
  await filesystem.cp(fileURLToPath(new URL('../package.json', import.meta.url)), join(unpacked, 'package.json'));
  const { programLine: fromTemp } = await import(new URL(`file://${join(unpacked, 'src/cli-present.js')}`).href);
  const installed = join(f.root, 'installed');
  await filesystem.mkdir(join(installed, 'src'), { recursive: true });
  await filesystem.writeFile(join(installed, 'src/cli.js'), '// cli\n');
  const ask = (remaining) => fromTemp({ config: f.io.config, platform: 'linux', env: { PATH: '' }, fs: filesystem, remaining });
  assert.equal(await ask([installed]), shown([process.execPath, join(installed, 'src/cli.js')], 'linux'), locale);
  assert.equal(await ask([]), null);
  // Without a run to look back on, the copy that is running is still the program.
  assert.equal(await fromTemp({ config: f.io.config, platform: 'linux', env: { PATH: '' }, fs: filesystem }), shown([process.execPath, join(unpacked, 'src/cli.js')], 'linux'));
});

// Round 8.
const BOOTSTRAP = '/tmp/okit-bootstrap-abc123/extracted';
for (const locale of LOCALES) test(`D112 round 8, 1: a retry of the release installer never carries the flags it hands to the unpacked CLI: ${locale}`, () => {
  const pt = locale === 'pt-BR';
  const internal = ['--from', BOOTSTRAP, '--repo', 'owner/repo', '--asset', 'okit.zip', '--fallback'];
  const tryAgain = (program, platform) => render('install', locale, (ui) => { ui.header({ client: 'Codex', version: '1' }); ui.failure({ client: 'codex', step: ui.text('files'), reason: 'boom' }); },
    { code: 1, client: 'codex', flags: ['--client', 'codex', '--no-link', ...internal], program, platform })
    .find((line) => line.startsWith(`${pt ? 'Tente novamente' : 'Try again'}: `));
  assert.ok(tryAgain(null, 'linux')?.endsWith(': sh install.sh --client codex --no-link'), tryAgain(null, 'linux'));
  assert.ok(tryAgain(null, 'win32')?.endsWith(': ./install.ps1 --client codex --no-link'), tryAgain(null, 'win32'));
  const kept = tryAgain(RUNNING, 'linux');
  assert.ok(kept?.endsWith(`: ${RUNNING} install --client codex --no-link`), kept);
  assert.doesNotMatch(kept, /okit-bootstrap|--repo|--asset|--fallback/);
  // What a person typed is theirs: a folder given to `update --from` stays.
  const update = render('update', locale, (ui) => ui.header({ client: 'Codex', version: '2' }),
    { code: 0, checkOnly: true, flags: ['--check', '--from', 'a b'], program: RUNNING, before: { codex: { version: '1' } } });
  assert.ok(update.some((line) => line.includes("update --from 'a b'")), update.join('\n'));
});

test('D112 round 8, 2: an install with --no-path names the program that runs on every line, also those written during the run', async (t) => {
  const f = await fixture(t, 'linux');
  f.io.env.PATH = '/usr/bin';
  assert.equal(await main(['install', '--client', 'codex', '--no-path'], f.io), 0, f.output.join('\n'));
  const text = f.output.join('\n');
  assert.ok(text.includes(`${RUNNING} setup`), text);
  assert.doesNotMatch(text, /(^|[\s'"])okit-plugin (setup|doctor)/m, text);
});

test('D112 round 8, 3: what update --check tells to type follows the PATH state, not the setting that enables it', async (t) => {
  const f = await fixture(t, 'linux');
  f.io.env.PATH = '/usr/bin';
  assert.equal(await main(['install', '--client', 'codex', '--no-path'], f.io), 0, f.output.join('\n'));
  f.clear();
  await main(['update', '--check', '--client', 'codex'], f.io);
  const text = f.output.join('\n');
  assert.doesNotMatch(text, /(^|[\s'"])okit-plugin (update|doctor|setup)/m, text);
  assert.ok(text.includes(RUNNING), text);
});

test('D112 round 8, 4: the Fix of the self-check, run from the copy the release installer unpacks, never names that copy', async (t) => {
  const { f } = await failingCheck(t, 'en');
  const unpacked = join(f.root, 'okit-bootstrap-abc123', 'extracted');
  await filesystem.mkdir(unpacked, { recursive: true });
  for (const entry of ['src', 'adapters', 'package.json']) {
    await filesystem.cp(fileURLToPath(new URL(`../${entry}`, import.meta.url)), join(unpacked, entry), { recursive: true });
  }
  const { main: fromTemp } = await import(new URL(`file://${join(unpacked, 'src/cli.js')}`).href);
  const dest = join(f.home, 'custom-dest');
  assert.equal(await fromTemp(['install', '--client', 'claude-code', '--no-link', '--dest', dest], f.io), 1, f.output.join('\n'));
  const text = f.output.join('\n');
  assert.doesNotMatch(text, /okit-bootstrap/, text);
  assert.ok(f.output.some((line) => line.includes('Fix:') && line.includes('install')), text);
});

// Round 9.
test('D112 round 9, 1: reachability follows the link folder an installation recorded, not the one the configuration names now', async (t) => {
  const f = await fixture(t, 'linux');
  f.io.env.PATH = '/usr/bin';
  assert.equal(await main(['install', '--client', 'codex', '--no-path'], f.io), 0, f.output.join('\n'));
  // The configuration now points at a folder that is on the PATH; the installation kept its own link folder, which is not.
  const other = join(f.root, 'other-bin');
  await filesystem.mkdir(other, { recursive: true });
  f.io.env.PATH = `/usr/bin:${other}`;
  await filesystem.writeFile(join(f.root, 'config.json'), JSON.stringify({ install: { ...f.io.config, linkDirectory: other } }));
  f.clear();
  await main(['update', '--check', '--client', 'codex'], f.io);
  const text = f.output.join('\n');
  assert.doesNotMatch(text, /(^|[\s'"])okit-plugin (update|doctor|setup)/m, text);
  assert.ok(text.includes(RUNNING), text);
});

// Round 10.
test('D112 round 10, 1: the bare command is not told while no Node is on the PATH to start it', async (t) => {
  const f = await fixture(t, 'linux');
  f.io.env.PATH = '/usr/bin';
  assert.equal(await main(['install', '--client', 'codex'], f.io), 0, f.output.join('\n'));
  // The link folder is on the PATH but nothing named node is: the script of the link cannot start.
  f.io.env.PATH = f.bin;
  f.clear();
  await main(['update', '--check', '--client', 'codex'], f.io);
  const text = f.output.join('\n');
  assert.doesNotMatch(text, /(^|[\s'"])okit-plugin (update|doctor|setup)/m, text);
});

// Round 11.
test('D112 round 11, 1: the bare command is not told when its link is gone, even with its folder and Node on the PATH', async (t) => {
  const f = await fixture(t, 'linux');
  assert.equal(await main(['install', '--client', 'codex'], f.io), 0, f.output.join('\n'));
  f.clear();
  await main(['update', '--check', '--client', 'codex'], f.io);
  assert.match(f.output.join('\n'), /(^|[\s'"])okit-plugin (update|doctor|setup)/m, 'with the link in place the short name is told');
  await filesystem.rm(join(f.bin, 'okit-plugin'), { force: true });
  f.clear();
  await main(['update', '--check', '--client', 'codex'], f.io);
  const text = f.output.join('\n');
  assert.doesNotMatch(text, /(^|[\s'"])okit-plugin (update|doctor|setup)/m, text);
  assert.ok(text.includes(RUNNING), text);
});

// Round 12.
test('D112 round 12, 1: a PATH state whose profile no longer holds the managed block is no proof that the command runs', async (t) => {
  const f = await fixture(t, 'linux');
  // Node is on the PATH of the terminal, the link folder is not: the installer writes the managed block into a profile.
  f.io.env.PATH = join(f.home, 'node-bin');
  f.io.env.SHELL = '/bin/bash';
  assert.equal(await main(['install', '--client', 'codex'], f.io), 0, f.output.join('\n'));
  const state = JSON.parse(await filesystem.readFile(join(f.destination, f.io.config.path.stateFile), 'utf8'));
  assert.ok(state.profiles.length > 0, 'the install wrote the managed block into a profile');
  const tell = async () => { f.clear(); await main(['update', '--check', '--client', 'codex'], f.io); return f.output.join('\n'); };
  assert.match(await tell(), /(^|[\s'"])okit-plugin (update|doctor|setup)/m, 'with the block in the profile the short name is told');
  const expectRunning = async () => {
    const text = await tell();
    assert.doesNotMatch(text, /(^|[\s'"])okit-plugin (update|doctor|setup)/m, text);
    assert.ok(text.includes(RUNNING), text);
  };
  // The markers stay but the statements are commented out.
  const blocks = new Map(state.profiles.map((item) => [item.path, item.block]));
  for (const [path, block] of blocks) await filesystem.writeFile(path, block.split('\n').map((line, index, lines) => (index === 0 || index === lines.length - 1 || !line.trim() ? line : `# ${line}`)).join('\n'));
  await expectRunning();
  for (const [path, block] of blocks) await filesystem.writeFile(path, block);
  assert.match(await tell(), /(^|[\s'"])okit-plugin (update|doctor|setup)/m, 'with the block back the short name is told');
  // The block is intact, but this terminal runs another shell, which never reads that file.
  f.io.env.SHELL = '/bin/zsh';
  await expectRunning();
  f.io.env.SHELL = '/bin/bash';
  assert.match(await tell(), /(^|[\s'"])okit-plugin (update|doctor|setup)/m, 'the shell that reads the file is told the short name');
  for (const item of state.profiles) await filesystem.writeFile(item.path, '# the person removed it\n');
  await expectRunning();
});

for (const [shell, variable] of [['zsh', 'ZDOTDIR'], ['fish', 'XDG_CONFIG_HOME']]) test(`D112 round 15, 1: a recorded block is not proof for a shell the installer does not know or whose startup files are moved (${shell})`, async (t) => {
  const f = await fixture(t, 'linux');
  f.io.env.PATH = join(f.home, 'node-bin');
  f.io.env.SHELL = `/bin/${shell}`;
  assert.equal(await main(['install', '--client', 'codex'], f.io), 0, f.output.join('\n'));
  const tell = async () => { f.clear(); await main(['update', '--check', '--client', 'codex'], f.io); return f.output.join('\n'); };
  const short = /(^|[\s'"])okit-plugin (update|doctor|setup)/m;
  assert.match(await tell(), short, `${shell}: the short name is told while the profile is read`);
  f.io.env[variable] = join(f.home, 'elsewhere');
  const moved = await tell();
  assert.doesNotMatch(moved, short, moved);
  assert.ok(moved.includes(RUNNING), moved);
  delete f.io.env[variable];
  f.io.env.SHELL = '/bin/csh';
  const csh = await tell();
  assert.doesNotMatch(csh, short, csh);
  assert.ok(csh.includes(RUNNING), csh);
});
