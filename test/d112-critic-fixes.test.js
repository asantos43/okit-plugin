import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import { createInstallerView, createPresenter, presentDiagnosis, presentModelChoices, setupResultLines } from '../src/cli-present.js';
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
