import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import { shown } from '../src/install/mcp-register.js';
import { createPresenter, createInstallerView, finishLink, headerValues, pick, redact, redactingWriter, REASONS, TEXTS, localizeReason } from '../src/cli-present.js';
import { EXCLUSIVE_FLAGS, ALLOWED_FLAGS } from '../src/install/index.js';
import { presentDiagnosis } from '../src/doctor/command.js';
import { formatNotSaved, formatUnreadable, runSetup, setupResultLines } from '../src/setup/setup.js';
import { formatOffer, offerSetup } from '../src/setup/offer.js';
import { DEFAULT_CONFIG } from '../src/profiles.js';
import * as moduleAdapter from '../adapters/opencode/index.js';

// Must pass / must refuse:
// | case | must pass | must refuse |
// | install and update, en and pt-BR, linux, macOS and Windows | the same step lines, one language | another order, a repeated line |
// | uninstall | the same shape with its own steps | a summary of next steps |
// | the SHA-256 note, Release/Asset/Destination | once, inside the steps | twice, a block of their own |
// | the temporary folders | never printed | any path under the scratch folder |
// | raw commands | only with --verbose | by default |
// | y and s | both accept, in either language | an answer that is not a yes |
// | foreign command | preserved with a failed link and a repair hint | a successful install |
// | early refusals | explicit or environment language | English mixed into pt-BR |
// | completed step | one result and its first notes | later completions or notes |
// | setup | offered after success | offered after failure, dry-run or --check |
// | an error text | the address without query, fragment or credentials; the temporary folder as <temp> | a token, a password, the scratch folder |
// | a reason raised by src/cli.js and shown by the installer | pt-BR text | English inside a pt-BR run |
// | a --locale that is not a language | one language: valid --locale, else OKIT_LANGUAGE, else English | both languages in one line |

import { commandsOnPath, fixture, SYSTEM, FORMAT } from './helpers/install-fixture.js';

const LABEL = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };
const PLATFORMS = ['linux', 'darwin', 'win32'];
const LOCALES = ['en', 'pt-BR'];

const HINT = (bin) => `$env:Path = '${bin}' + ';' + $env:Path`;

for (const locale of LOCALES) for (const operation of ['install', 'update']) {
  test(`D132 ${operation} heading and Notes indentation in ${locale}`, () => {
    const output = [], pt = locale === 'pt-BR';
    const { ui, finish } = createInstallerView({ operation, command: 'okit-plugin', locale, write: (line) => output.push(line) });
    ui.header({ version: '2.0.0', client: 'Claude Code' });
    ui.note('      First note\n      Continued note');
    finish({ code: 0, client: 'claude-code', before: { 'claude-code': { version: '1.0.0' } },
      after: { 'claude-code': { version: '2.0.0', previous: '/retained', link: true } } });
    const action = operation === 'update' ? (pt ? 'atualização para' : 'update for') : (pt ? 'instalação para' : 'install for'); // locale:pt-BR
    assert.equal(output[0], `okit-plugin 2.0.0 — ${action} Claude Code`);
    if (operation === 'update') assert.doesNotMatch(output[0], /— install for|— instalação para/);
    const start = output.findIndex((line) => line.trim() === (pt ? 'Notas' : 'Notes')); // locale:pt-BR
    const end = output.findIndex((line) => line.trim() === (pt ? 'Próximo' : 'Next')); // locale:pt-BR
    assert.ok(start >= 0 && end > start, output.join('\n'));
    const notes = output.slice(start + 1, end).filter(Boolean);
    assert.ok(notes.every((line) => /^ {2}\S/.test(line)), notes.join('\n'));
    assert.ok(notes.includes('  First note') && notes.includes('  Continued note'));
    assert.ok(notes.some((line) => line.includes(operation === 'update' ? 'update --rollback' : 'doctor --client claude-code')));
  });
}

test('D132 activation ends the flow and names a profile containing the written PATH block', async (t) => {
  const f = await fixture(t);
  f.io.env.SHELL = '/bin/zsh';
  f.io.env.PATH = '';
  assert.equal(await main(['install', '--client', 'claude-code', '--no-panel'], f.io), 0);
  const lines = f.output;
  const run = lines.indexOf('Run this now:');
  assert.ok(run > 0, lines.join('\n'));
  const profile = lines[run + 1].match(/^\. '(.+)'$/)?.[1];
  assert.ok(profile, lines[run + 1]);
  assert.match(await fs.readFile(profile, 'utf8'), /# >>> okit-plugin PATH >>>/);
  assert.equal(lines[run + 2], 'or open a new terminal');
  assert.equal(run + 3, lines.length);
  assert.match(lines[0], /^okit-plugin 1\.0\.0 — install for Claude Code$/);
  const columns = lines.filter((line) => /^ {2}\S.* {2}(?:ok|skipped|-)\s/.test(line))
    .map((line) => / {2}(ok|skipped|-)\s/.exec(line).index + 2);
  assert.ok(columns.length >= 3);
  assert.equal(new Set(columns).size, 1, 'self-check table status columns must align');
});

for (const locale of LOCALES) test(`client matrix has no owner after a partial install: ${locale}`, async (t) => {
  const f = await fixture(t);
  const fetch = f.io.fetch;
  f.io.detect = async () => true;
  f.io.fetch = async (url, options) => {
    if (url.endsWith('/package/codex')) throw new Error('fake package failure');
    return fetch(url, options);
  };
  assert.equal(await main(['install', '--client', 'all', '--locale', locale], f.io), 1);
  const text = f.output.join('\n');
  const matrix = f.output.filter((line) => /^\s*(Claude Code|Codex|OpenCode)\s+(ok|failed|falhou)$/.test(line));
  assert.equal(matrix.length, 3, text);
  assert.ok(matrix.some((line) => new RegExp(`^\\s*Codex\\s+${locale === 'en' ? 'failed' : 'falhou'}$`).test(line)), text);
  assert.doesNotMatch(text, /^(Claude Code|Codex|OpenCode) — (Claude Code|Codex|OpenCode)\s+(ok|failed|falhou)$/m);
  assert.doesNotMatch(text, /^(Claude Code|Codex|OpenCode) — .*Kit \((optional|opcional)\)/m);
  assert.ok(matrix.some((line) => /^\s*OpenCode\s/.test(line)), text);
});

for (const locale of LOCALES) test(`client scope ends before shared PATH notes: ${locale}`, () => {
  const output = [];
  const { ui, finish } = createInstallerView({ operation: 'install', command: 'okit-plugin', locale, write: (line) => output.push(line) });
  ui.beginClients(['claude-code', 'opencode']);
  ui.header({ client: 'Claude Code', version: '1' });
  ui.sequence(['register'], { client: 'Claude Code' })('register').plan();
  ui.row(ui.text('selfcheckPath'), 'info', 'client-path');
  ui.header({ client: 'Opencode', version: '1' });
  ui.sequence(['register'], { client: 'OpenCode' })('register').plan();
  ui.row(ui.text('selfcheckPath'), 'info', 'other-client-path');
  ui.endClients();
  ui.row(ui.text('selfcheckPath'), 'info', 'shared-path');
  finish({ code: 0, client: 'all', dryRun: true });
  const text = output.join('\n'), connect = locale === 'en' ? 'Connect' : 'Conectar';
  const planned = locale === 'en' ? 'planned' : 'planejado';
  assert.match(text, new RegExp(`^1\\. Claude Code — ${connect} Claude Code: ${planned}$`, 'm'));
  assert.match(text, new RegExp(`^2\\. OpenCode — ${connect} OpenCode: ${planned}$`, 'm'));
  assert.doesNotMatch(text, /Opencode|:\s*$/m);
  assert.ok(output.some((line) => line.trimStart().startsWith('Claude Code — ') && line.endsWith(' client-path')), text);
  assert.ok(output.some((line) => line.trimStart().startsWith('OpenCode — ') && line.endsWith(' other-client-path')), text);
  assert.ok(output.some((line) => /^\s/.test(line) && line.endsWith(' shared-path')), text);
  assert.doesNotMatch(text, /^(Claude Code|OpenCode) — .* shared-path$/m);
});

// D112 machine baseline captured from unchanged code before presentation edits.
// | case | must pass | must refuse |
// | --json, all five commands, both locales | byte-identical refusal and exit 2 | a new flag or JSON schema |
test('D112 --json bytes and exits match the pre-change capture', async (t) => {
  for (const locale of LOCALES) for (const command of ['setup', 'doctor', 'install', 'update', 'uninstall']) {
    const f = await fixture(t);
    assert.equal(await main([command, '--json', '--locale', locale], f.io), 2);
    assert.equal(f.output.join('\n') + '\n', locale === 'en'
      ? 'Refused: Unknown flag: --json\n      Next: check the options and try again\n'
      : 'Recusado: Opção desconhecida: --json\n      O que fazer: confira as opções e tente de novo\n');
  }
});

for (const locale of LOCALES) test(`D112 service and settings error goldens: ${locale}`, () => {
  const pt = locale === 'pt-BR', text = (key, values = {}) => Object.entries(values).reduce((value, [key, replacement]) => value.replaceAll(`{${key}}`, replacement), TEXTS[key][locale]);
  assert.equal(text('autostartAsk'), pt
    ? 'Serviço em segundo plano — executa trabalhos em espera enquanto o cliente está fechado. Iniciar com esta máquina? [s/N]:'
    : 'Background service — runs waiting work while your client is closed. Start it with this machine? [y/N]:');
  assert.equal(text('autostartLater', { command: 'okit-plugin' }), pt ? 'Início automático desligado. Para ativar depois: okit-plugin setup' : 'Automatic start is off. To enable it later: okit-plugin setup');
  assert.equal(text('autostartInstalled', { command: 'okit-plugin' }), pt ? 'Início automático ligado. Verifique: okit-plugin doctor' : 'Automatic start is on. Check it: okit-plugin doctor');
  assert.equal(text('autostartFailed', { command: 'okit-plugin', reason: 'EACCES' }), pt
    ? 'Não foi possível configurar o início automático.\nEACCES\nTente de novo após corrigir a causa: okit-plugin setup'
    : 'Automatic start could not be configured.\nEACCES\nTry again after fixing the cause: okit-plugin setup');
  assert.equal(formatUnreadable(locale), pt ? 'Não foi possível ler os ajustes. Confira: MCP config_get {}' : 'Settings could not be read. Inspect them: MCP config_get {}');
  assert.equal(formatNotSaved(locale, '<settings>', 'okit-plugin'), pt
    ? 'Não foi possível salvar as escolhas. Confira a permissão de gravação da pasta de ajustes e rode: okit-plugin setup\n<settings>'
    : 'Choices could not be saved. Check write permission for the settings folder, then run: okit-plugin setup\n<settings>');
  assert.deepEqual(setupResultLines({ changes: [], skipped: [], kept: [{}] }, locale, 'okit-plugin'),
    [pt ? 'As escolhas mais novas foram mantidas. Confira: MCP config_get {}' : 'Newer choices were kept. Check them: MCP config_get {}']);
});

for (const locale of LOCALES) test(`D112 installer absent-client, download, current and shared goldens: ${locale}`, () => {
  const pt = locale === 'pt-BR';
  const render = (operation, observe, result) => {
    const output = [], view = createInstallerView({ operation, command: 'okit-plugin', locale, write: (line) => output.push(line) });
    observe(view.ui); view.finish(result);
    return output;
  };
  const header = (ui) => ui.header({ client: 'Codex', version: '0.3.0' });
  assert.deepEqual(render('install', (ui) => ui.failure({ step: ui.text('get'), reason: 'permission denied' }), { code: 1, client: 'codex' }), pt
    ? ['okit-plugin — Instalação', 'Não foi possível baixar a versão. Nada foi instalado.', 'permissão negada', 'Confira sua conexão e tente: okit-plugin install --client codex']
    : ['okit-plugin — Install', 'The release could not be downloaded. Nothing was installed.', 'permission denied', 'Check your connection, then retry: okit-plugin install --client codex']);
  assert.deepEqual(render('update', (ui) => { header(ui); ui.row(ui.text('upToDate'), 'ok', '0.3.0'); }, { code: 0, client: 'codex' }), pt
    ? ['okit-plugin — Atualização', 'Codex está em dia. Nada mudou.', 'Verifique a instalação: okit-plugin doctor --client codex', '      Em dia                      ok       0.3.0']
    : ['okit-plugin — Update', 'Codex is up to date. Nothing changed.', 'Check the installation: okit-plugin doctor --client codex', '      Up to date                  ok       0.3.0']);
  assert.deepEqual(render('uninstall', header, { code: 0, client: 'codex', after: { 'claude-code': { link: true } } }), pt
    ? ['okit-plugin — Desinstalação', 'Integração do Codex removida. O comando foi mantido para Claude Code.', 'Verifique a instalação restante: okit-plugin doctor --client claude-code']
    : ['okit-plugin — Uninstall', 'Removed Codex integration. The command is kept for Claude Code.', 'Check the remaining installation: okit-plugin doctor --client claude-code']);
  assert.deepEqual(render('install', header, { code: 0, client: 'codex', dryRun: true }), pt
    ? ['okit-plugin — Instalação', '', 'Somente prévia. Nada mudou.', 'Para aplicar: okit-plugin install --client codex']
    : ['okit-plugin — Install', '', 'Preview only. Nothing changed.', 'Apply: okit-plugin install --client codex']);
  const menu = render('install', (ui) => {
    ui.explain([ui.text('clientChoose'), ...['claude-code', 'codex', 'opencode'].map((id, index) => `  ${index + 1}. ${id} (${ui.text('clientDetected')})`)]);
    ui.failure({ reason: ui.text('clientNoTty') });
  }, { code: 2 });
  assert.deepEqual(menu, pt ? ['okit-plugin — Instalação', '', 'Escolha um cliente de programação antes de instalar.',
    '1. Claude Code (encontrado)', '2. Codex (encontrado)', '3. OpenCode (encontrado)', '',
    'Instale para Claude Code: okit-plugin install --client claude-code', 'Instale para Codex: okit-plugin install --client codex', 'Instale para OpenCode: okit-plugin install --client opencode']
    : ['okit-plugin — Install', '', 'Choose a coding client before installing.', '1. Claude Code (found)', '2. Codex (found)', '3. OpenCode (found)', '',
      'Install for Claude Code: okit-plugin install --client claude-code', 'Install for Codex: okit-plugin install --client codex', 'Install for OpenCode: okit-plugin install --client opencode']);
});

for (const locale of LOCALES) test(`D112 invalid answers never accumulate prefixes and fallback appears once: ${locale}`, async (t) => {
  const f = await fixture(t), output = [], questions = [], pt = locale === 'pt-BR';
  let answers = ['bad answer', 'bad answer', '1', '1', '1', 'yes'];
  const result = await runSetup({ root: f.root, env: f.io.env, locale, out: (line) => output.push(line),
    config: { setup: { maxAttempts: 3 } }, adapters: [{ CLIENT: 'codex', listModels: async () => ({ client: 'codex', installed: true, models: ['sol', 'astra'], source: 'listing' }) }],
    ask: async (question) => { questions.push(question); return answers.shift(); } });
  assert.equal(result.code, 0);
  assert.deepEqual(questions.slice(0, 3), Array(3).fill(pt ? 'Escolha um modelo [1]:' : 'Choose a model [1]:'));
  assert.deepEqual(output.filter((line) => /^Choose 1|^Escolha 1/.test(line)), Array(2).fill(pt ? 'Escolha 1 ou 2.' : 'Choose 1 or 2.'));
  assert.ok(!output.join('\n').includes('bad answer'));
  output.length = 0;
  await runSetup({ root: f.root, env: f.io.env, locale, defaults: true, again: true, out: (line) => output.push(line),
    adapters: [{ CLIENT: 'codex', listModels: async () => ({ client: 'codex', installed: true, models: ['sol', 'astra'], source: 'catalog' }) }] });
  assert.equal(output.filter((line) => line === (pt ? 'Lista de modelos indisponível; usando a lista incluída.' : 'Model list unavailable; using the built-in list.')).length, 1);
});

for (const locale of LOCALES) test(`D112 absent update/uninstall preserve exit 2: ${locale}`, async (t) => {
  for (const command of ['update', 'uninstall']) {
    const f = await fixture(t), pt = locale === 'pt-BR';
    // The command and Node are on the PATH, so the commands are named by their short name; no client is guessed.
    const commands = join(f.home, 'commands');
    await fs.mkdir(commands);
    for (const name of ['okit-plugin', 'node']) await fs.writeFile(join(commands, name), '#!/bin/sh\n', { mode: 0o755 });
    f.io.env = { ...f.io.env, PATH: [commands, f.io.env.PATH].join(delimiter) };
    assert.equal(await main([command, '--locale', locale], f.io), 2);
    assert.deepEqual(f.output, pt ? [`okit-plugin — ${command === 'update' ? 'Atualização' : 'Desinstalação'}`,
      `Nenhuma instalação do plugin encontrada. Nada foi ${command === 'update' ? 'atualizado' : 'removido'}.`,
      command === 'update' ? 'Instale primeiro: okit-plugin install' : 'Confira o estado local: okit-plugin doctor']
      : [`okit-plugin — ${command === 'update' ? 'Update' : 'Uninstall'}`, `No plugin installation was found. Nothing was ${command === 'update' ? 'updated' : 'removed'}.`,
        command === 'update' ? 'Install first: okit-plugin install' : 'Check the local state: okit-plugin doctor']);
  }
});

for (const locale of LOCALES) test(`D112 setup first run, ready and cancelled: ${locale}`, async (t) => {
  const f = await fixture(t), pt = locale === 'pt-BR';
  await commandsOnPath(f);
  f.io.setupAdapters = [{ CLIENT: 'codex', listModels: async () => ({ client: 'codex', installed: true, models: ['sol', 'astra'], source: 'listing' }) }];
  let answers = ['1', '1', '2', 'yes'];
  f.io.ask = async (question) => { f.output.push(question); return answers.shift(); };
  assert.equal(await main(['setup', '--locale', locale], f.io), 0);
  const work = pt ? ['Tarefas pequenas', 'Tarefas do dia a dia', 'Tarefas complexas'] : ['Small tasks', 'Everyday tasks', 'Complex tasks'];
  const expected = [pt ? 'okit-plugin — Configuração' : 'okit-plugin — Setup',
    pt ? 'Escolha modelos para Codex; nada é salvo até sua confirmação.' : 'Choose models for Codex; nothing is saved until you confirm.'];
  for (const name of work) expected.push(`\n${name} — Codex`, pt ? '1. sol (recomendado)' : '1. sol (recommended)', '2. astra', '', pt ? 'Escolha um modelo [1]:' : 'Choose a model [1]:');
  expected.push(pt ? '\nEscolhas de modelos' : '\nModel choices', pt ? '| Trabalho | Modelo |' : '| Work | Model |', '| --- | --- |',
    ...work.map((name, index) => `| ${name} | ${index === 2 ? 'astra' : 'sol'} |`),
    pt ? '\nAs escolhas valem para trabalhos futuros. Para alterá-las: okit-plugin setup --again' : '\nThese choices apply to future work. You can change them with: okit-plugin setup --again',
    '', pt ? 'Salvar estas escolhas? [s/N]:' : 'Save these choices? [y/N]:',
    pt ? '3 escolhas de modelos salvas para Codex.' : 'Saved 3 model choices for Codex.',
    pt ? 'Nenhum valor de cota registrado. Peça ao seu assistente para chamar `quota_set` com o cliente "codex" e a porcentagem que resta.'
      : 'No quota value recorded. Ask your assistant to call `quota_set` with the client "codex" and the percentage that is left.',
    pt ? 'Próximo: okit-plugin doctor --client codex' : 'Next: okit-plugin doctor --client codex');
  assert.deepEqual(f.output, expected);
  f.clear();
  assert.equal(await main(['setup', '--locale', locale], f.io), 0);
  assert.deepEqual(f.output, [expected[0],
    pt ? 'Todas as escolhas de modelos já estão salvas. Nada mudou.' : 'All model choices are already saved. Nothing changed.',
    pt ? 'Verifique a instalação: okit-plugin doctor --client codex' : 'Check the installation: okit-plugin doctor --client codex',
    pt ? 'Altere os modelos: okit-plugin setup --again' : 'Change models: okit-plugin setup --again']);
  f.clear(); answers = [undefined];
  assert.equal(await main(['setup', '--again', '--locale', locale], f.io), 0);
  assert.deepEqual(f.output.slice(-2), pt ? ['Cancelado. Nada foi salvo.', 'Tente novamente quando quiser: okit-plugin setup']
    : ['Cancelled. Nothing was saved.', 'Try again when ready: okit-plugin setup']);
});

for (const locale of LOCALES) test(`D112 setup nothing detected: ${locale}`, async (t) => {
  const f = await fixture(t), pt = locale === 'pt-BR';
  await commandsOnPath(f);
  f.io.setupAdapters = [{ CLIENT: 'codex', listModels: async () => ({ client: 'codex', installed: false, models: [], source: 'listing' }) }];
  assert.equal(await main(['setup', '--defaults', '--locale', locale], f.io), 0);
  assert.deepEqual(f.output, pt ? ['okit-plugin — Configuração', 'Nenhum cliente com modelo ativo foi encontrado. Nada foi salvo.',
    'Instale ou ative um modelo no seu cliente de programação e rode: okit-plugin setup', 'Confira os clientes disponíveis: MCP env_report {"locale":"pt-BR"}']
    : ['okit-plugin — Setup', 'No client with an active model was found. Nothing was saved.',
      'Install or enable a model in your coding client, then run: okit-plugin setup', 'Check which clients are available: MCP env_report {"locale":"en"}']);
});

for (const locale of LOCALES) test(`D112 doctor ready and failed goldens: ${locale}`, () => {
  const pt = locale === 'pt-BR', output = [];
  const ui = createPresenter({ locale, write: (line) => output.push(line) });
  const rows = pt ? [['Instalação', 'Pronta para Codex'], ['Modelos', '3 escolhas salvas'], ['Serviço em segundo plano', 'Ativo']]
    : [['Installation', 'Ready for Codex'], ['Models', '3 choices saved'], ['Background service', 'Running']];
  presentDiagnosis({ rows: rows.map(([label, detail]) => ({ label, detail, status: 'ok' })), failed: 0, warnings: 0 },
    { ui, command: 'okit-plugin', client: 'codex', out: (line) => output.push(line) });
  assert.deepEqual(output, [pt ? 'okit-plugin — Verificação da instalação' : 'okit-plugin — Installation check',
    pt ? 'Pronto. As 3 verificações passaram.' : 'Ready. All 3 checks passed.',
    pt ? '| Verificação | Resultado |' : '| Check | Result |', '| --- | --- |', ...rows.map(([label, detail]) => `| ${label} | ${detail} |`),
    pt ? 'Verifique novamente quando precisar: okit-plugin doctor --client codex' : 'Check again when needed: okit-plugin doctor --client codex']);
  output.length = 0;
  const fix = pt ? 'registre o plugin no Codex: okit-plugin install --client codex' : 'register the plugin in Codex: okit-plugin install --client codex';
  presentDiagnosis({ rows: [{ label: pt ? 'Conexão com Codex' : 'Codex connection', detail: pt ? 'Sem registro' : 'Not registered', status: 'failed', fix }], failed: 1, warnings: 0 },
    { ui, command: 'okit-plugin', client: 'codex', out: (line) => output.push(line) });
  assert.deepEqual(output, [pt ? 'okit-plugin — Verificação da instalação' : 'okit-plugin — Installation check',
    pt ? 'Precisa de atenção: 1 verificação falhou; as demais passaram.' : 'Needs attention: 1 failed check; other checks passed.',
    pt ? '| Verificação | Resultado |' : '| Check | Result |', '| --- | --- |', pt ? '| Conexão com Codex | Sem registro |' : '| Codex connection | Not registered |',
    `${pt ? 'Correção' : 'Fix'}: ${fix}`, pt ? 'Depois confira: okit-plugin doctor --client codex' : 'Then check: okit-plugin doctor --client codex']);
});

test('a foreign .cmd fails install with an actionable link error in either language', async (t) => {
  for (const locale of LOCALES) {
    const f = await fixture(t, 'win32');
    await fs.mkdir(f.bin);
    const shortcut = join(f.bin, 'okit-plugin.cmd');
    await fs.writeFile(shortcut, '@echo foreign\r\n');
    for (const argv of [['install', '--client', 'claude-code'], ['update']]) {
      f.clear();
      assert.equal(await main([...argv, '--locale', locale], f.io), 1, f.output.join('\n'));
      assert.equal(await fs.readFile(shortcut, 'utf8'), '@echo foreign\r\n');
      const text = f.output.join('\n');
      assert.doesNotMatch(text, /(?:Command and PATH|Comando e PATH)\s+ok\b/);
      assert.match(text, locale === 'en'
        ? /Failed at Command and PATH: The existing command .* is not the plugin command\. Rename or remove it/
        : /Falhou em Comando e PATH: O comando existente .* não é o comando do plugin\. Renomeie ou remova/);
      assert.match(text, /install\.linkDirectory/);
      assert.doesNotMatch(text, /Done\. Next:|Pronto\. Próximo:/);
    }
  }
});

/** The install of Claude Code as the installer prints it. */
function currentLines(locale) {
  return locale === 'en' ? ['', 'Suggested models — Claude Code', 'Small tasks: haiku', 'Everyday tasks: sonnet', 'Complex tasks: opus', '', 'Confirm the suggestions: okit-plugin setup', '']
    : ['', 'Modelos sugeridos — Claude Code', 'Tarefas pequenas: haiku', 'Tarefas do dia a dia: sonnet', 'Tarefas complexas: opus', '', 'Confirme as sugestões: okit-plugin setup', ''];
}

function legacyInstallLines(locale, platform) {
  const windows = platform === 'win32';
  // the checks that ran: version, the command in each shell found, the written status bar and its reading, the hook (not on Windows), the MCP server and its control API
  const checks = windows ? 7 : 9;
  const asset = `sample-1.0.0-claude-code-${SYSTEM[platform]}-x64.${FORMAT[platform]}`;
  const system = LABEL[platform];
  if (locale === 'en') {
    return [
      `okit-plugin 1.0.0 for Claude Code (${system} x64)`,
      `[1/5] Download and verify  ok  ${asset} (SHA-256 checked)`,
      '  SHA-256 detects altered bytes; it does not authenticate the source.',
      '[2/5] Install files  ok  <data>/1.0.0-claude-code',
      '[3/5] Register in Claude Code  ok  marketplace and plugin',
      '  MCP server registered in Claude Code',
      `[4/5] Command and PATH  ok  okit-plugin  (${windows ? 'added to your user PATH' : 'already on your PATH'})`,
      '[5/5] Quota recording  skipped  off. To turn it on: okit-plugin install --client claude-code --statusline',
      `  Self-check (Claude Code)  ok  ${checks} checks passed`,
      ...(windows ? ['  Command (git-bash)  skipped  git-bash is not installed'] : []),
      '  Optional panel  skipped  Turn on later: okit-plugin install --panel',
      ...currentLines(locale),
      '  Models  -  not set yet. Run: okit-plugin setup',
      '  Kit (optional)  -  not found. Needed only for the orchestration workflow: INSTALL.md#orchestration-kit',
      windows ? `Done. Next: 1. open a new terminal  2. in this terminal instead: ${HINT('<bin>')}  3. restart Claude Code  4. ask your assistant to call \`status\``
        : 'Done. Next: 1. open a new terminal  2. restart Claude Code  3. ask your assistant to call `status`',
    ];
  }
  return [
    `okit-plugin 1.0.0 para Claude Code (${system} x64)`,
    `[1/5] Baixar e verificar  ok  ${asset} (SHA-256 conferido)`,
    '  O SHA-256 detecta bytes alterados; não autentica a origem.',
    '[2/5] Instalar arquivos  ok  <data>/1.0.0-claude-code',
    '[3/5] Registrar no Claude Code  ok  marketplace e plugin',
    '  Servidor MCP registrado no Claude Code',
    `[4/5] Comando e PATH  ok  okit-plugin  (${windows ? 'adicionado ao PATH do seu usuário' : 'já está no seu PATH'})`,
    '[5/5] Registro de cota  pulado  desligado. Para ligar: okit-plugin install --client claude-code --statusline',
    `  Autoverificação (Claude Code)  ok  ${checks} verificações passaram`,
    ...(windows ? ['  Comando (git-bash)  pulado  git-bash não está instalado'] : []),
    '  Painel opcional  pulado  Ative depois: okit-plugin install --panel',
    ...currentLines(locale),
    '  Modelos  -  ainda não definidos. Rode: okit-plugin setup',
    '  Kit (opcional)  -  não encontrado. Só é necessário para o fluxo de orquestração: INSTALL.pt-BR.md#kit-de-orquestração',
    windows ? `Pronto. Próximo: 1. abra um terminal novo  2. neste terminal, rode antes: ${HINT('<bin>')}  3. reinicie o Claude Code  4. peça ao seu assistente para chamar \`status\``
      : 'Pronto. Próximo: 1. abra um terminal novo  2. reinicie o Claude Code  3. peça ao seu assistente para chamar `status`',
  ];
}

/** The update to 2.0.0; the backup line carries a folder, so it is matched, not spelled. */
function legacyUpdateLines(locale, platform) {
  const windows = platform === 'win32';
  // the checks that ran: version, the command in each shell found, the written status bar and its reading, the hook (not on Windows), the MCP server and its control API
  const checks = windows ? 7 : 9;
  const asset = `sample-2.0.0-claude-code-${SYSTEM[platform]}-x64.${FORMAT[platform]}`;
  const system = LABEL[platform];
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (locale === 'en') {
    return [
      `okit-plugin 2.0.0 for Claude Code (${system} x64)`,
      `[1/7] Download and verify  ok  ${asset} (SHA-256 checked)`,
      '  SHA-256 detects altered bytes; it does not authenticate the source.',
      /^\[2\/7\] Back up your files {2}ok( {2}.+)?$/,
      '[3/7] Install files  ok  <data>/2.0.0-claude-code',
      '[4/7] Register in Claude Code  ok  marketplace and plugin',
      '  MCP server of Claude Code replaced by this installation',
      `[5/7] Command and PATH  ok  okit-plugin  (${windows ? 'added to your user PATH' : 'already on your PATH'})`,
      '[6/7] Quota recording  skipped  off. To turn it on: okit-plugin install --client claude-code --statusline',
      '[7/7] Check the install  ok',
      `  Self-check (Claude Code)  ok  ${checks} checks passed`,
      ...(windows ? ['  Command (git-bash)  skipped  git-bash is not installed'] : []),
      ...currentLines(locale),
      '  Models  -  not set yet. Run: okit-plugin setup',
      '  Kit (optional)  -  not found. Needed only for the orchestration workflow: INSTALL.md#orchestration-kit',
      new RegExp(`^Done\\. Next: 1\\. open a new terminal {2}${windows ? `2\\. in this terminal instead: ${escape(HINT('<bin>'))} {2}3\\. restart Claude Code {2}4` : '2\\. restart Claude Code {2}3'}\\. ask your assistant to call \`status\`$`),
    ];
  }
  return [
    `okit-plugin 2.0.0 para Claude Code (${system} x64)`,
    `[1/7] Baixar e verificar  ok  ${asset} (SHA-256 conferido)`,
    '  O SHA-256 detecta bytes alterados; não autentica a origem.',
    /^\[2\/7\] Copiar seus arquivos {2}ok( {2}.+)?$/,
    '[3/7] Instalar arquivos  ok  <data>/2.0.0-claude-code',
    '[4/7] Registrar no Claude Code  ok  marketplace e plugin',
    '  Servidor MCP de Claude Code substituído por esta instalação',
    `[5/7] Comando e PATH  ok  okit-plugin  (${windows ? 'adicionado ao PATH do seu usuário' : 'já está no seu PATH'})`,
    '[6/7] Registro de cota  pulado  desligado. Para ligar: okit-plugin install --client claude-code --statusline',
    '[7/7] Verificar a instalação  ok',
    `  Autoverificação (Claude Code)  ok  ${checks} verificações passaram`,
    ...(windows ? ['  Comando (git-bash)  pulado  git-bash não está instalado'] : []),
    ...currentLines(locale),
    '  Modelos  -  ainda não definidos. Rode: okit-plugin setup',
    '  Kit (opcional)  -  não encontrado. Só é necessário para o fluxo de orquestração: INSTALL.pt-BR.md#kit-de-orquestração',
    new RegExp(`^Pronto\\. Próximo: 1\\. abra um terminal novo {2}${windows ? `2\\. neste terminal, rode antes: ${escape(HINT('<bin>'))} {2}3\\. reinicie o Claude Code {2}4` : '2\\. reinicie o Claude Code {2}3'}\\. peça ao seu assistente para chamar \`status\`$`),
  ];
}

function legacyUninstallLines(locale, platform) {
  const system = LABEL[platform];
  if (locale === 'en') {
    return [
      `okit-plugin 1.0.0 for Claude Code (${system} x64)`,
      '[1/3] Unregister from Claude Code  ok  marketplace and plugin removed',
      '  MCP server removed from Claude Code',
      '[2/3] Remove command and PATH  ok  okit-plugin removed',
      '[3/3] Remove files  ok  <data>/1.0.0-claude-code (your settings are kept)',
    ];
  }
  return [
    `okit-plugin 1.0.0 para Claude Code (${system} x64)`,
    '[1/3] Remover registro do Claude Code  ok  marketplace e plugin removidos',
    '  Servidor MCP removido do Claude Code',
    '[2/3] Remover comando e PATH  ok  okit-plugin removido',
    '[3/3] Remover arquivos  ok  <data>/1.0.0-claude-code (seus ajustes foram mantidos)',
  ];
}

function installLines(locale, platform) {
  const path = platform === 'win32' ? (locale === 'en' ? 'added to your user PATH' : 'adicionado ao PATH do seu usuário')
    : (locale === 'en' ? 'already on your PATH' : 'já está no seu PATH');
  return locale === 'en' ? ['okit-plugin 1.0.0 — install for Claude Code', '',
    '1. Download and verify: complete', '  SHA-256 detects altered bytes; it does not authenticate the source.', '',
    '2. Install files: complete', '', '3. Connect Claude Code: complete', '  MCP server registered in Claude Code', '',
    `4. Command and PATH: complete — okit-plugin  (${path})`,
    '', '5. Quota recording: off. To turn it on: okit-plugin install --client claude-code --statusline', '']
    : ['okit-plugin 1.0.0 — instalação para Claude Code', '',
      '1. Baixar e verificar: concluído', '  O SHA-256 detecta bytes alterados; não autentica a origem.', '',
      '2. Instalar arquivos: concluído', '', '3. Conectar Claude Code: concluído', '  Servidor MCP registrado no Claude Code', '',
      `4. Comando e PATH: concluído — okit-plugin  (${path})`,
      '', '5. Registro de cota: desligado. Para ligar: okit-plugin install --client claude-code --statusline', ''];
}

function updateLines(locale, platform) {
  const path = platform === 'win32' ? (locale === 'en' ? 'added to your user PATH' : 'adicionado ao PATH do seu usuário')
    : (locale === 'en' ? 'already on your PATH' : 'já está no seu PATH');
  return locale === 'en' ? ['okit-plugin 2.0.0 — update for Claude Code', ...currentLines(locale), 'Updated Claude Code from 1.0.0 to 2.0.0.',
    '1. Download and verify: complete', '2. Back up your files: complete — <data>/backups/1700000000000',
    '3. Install files: complete', '4. Connect Claude Code: complete',
    `5. Command and PATH: complete — okit-plugin  (${path})`,
    '6. Quota recording: off. To turn it on: okit-plugin install --client claude-code --statusline', '7. Check the install: complete']
    : ['okit-plugin 2.0.0 — atualização para Claude Code', ...currentLines(locale), 'Claude Code atualizado de 1.0.0 para 2.0.0.',
      '1. Baixar e verificar: concluído', '2. Copiar seus arquivos: concluído — <data>/backups/1700000000000',
      '3. Instalar arquivos: concluído', '4. Conectar Claude Code: concluído',
      `5. Comando e PATH: concluído — okit-plugin  (${path})`,
      '6. Registro de cota: desligado. Para ligar: okit-plugin install --client claude-code --statusline', '7. Verificar a instalação: concluído'];
}

// The uninstall removed the last command link: a new terminal finds no command, so the way to install again names the
// program that is running (the plain command is deleted by then).
function uninstallLines(locale, program) {
  return locale === 'en' ? ['okit-plugin — Uninstall', 'Removed the plugin from Claude Code. Your settings were kept.',
    `Install again when needed: ${program} install --client claude-code`]
    : ['okit-plugin — Desinstalação', 'Plugin removido do Claude Code. Seus ajustes foram mantidos.',
      `Instale novamente quando precisar: ${program} install --client claude-code`];
}

function retainedEvidence(locale, platform, update = false) {
  const pt = locale === 'pt-BR', windows = platform === 'win32', checks = windows ? 7 : 9;
  if (!update) return [
    pt ? `  Autoverificação (Claude Code)  ok  ${checks} verificações passaram` : `  Self-check (Claude Code)  ok  ${checks} checks passed`, '',
    ...(windows ? [pt ? '  Comando (git-bash)  pulado  git-bash não está instalado' : '  Command (git-bash)  skipped  git-bash is not installed', ''] : []),
    pt ? '  Painel opcional  pulado  Ative depois: okit-plugin install --panel' : '  Optional panel  skipped  Turn on later: okit-plugin install --panel', '',
    ...currentLines(locale).slice(1),
    pt ? '  Modelos  -  ainda não definidos. Rode: okit-plugin setup' : '  Models  -  not set yet. Run: okit-plugin setup', '',
    pt ? '  Kit (opcional)  -  não encontrado. Só é necessário para o fluxo de orquestração: INSTALL.pt-BR.md#kit-de-orquestração'
      : '  Kit (optional)  -  not found. Needed only for the orchestration workflow: INSTALL.md#orchestration-kit', '',
    pt ? 'Instalado para Claude Code. Falta confirmar os modelos.' : 'Installed for Claude Code. Model choices still need confirmation.', '',
    pt ? 'Notas' : 'Notes', pt ? '  Verifique a instalação: okit-plugin doctor --client claude-code' : '  Check the installation: okit-plugin doctor --client claude-code', '',
    pt ? 'Próximo' : 'Next', ...(windows ? [pt ? 'Execute agora:' : 'Run this now:', HINT('<bin>'), pt ? 'ou abra um terminal novo' : 'or open a new terminal']
      : [pt ? 'Abra um terminal novo.' : 'Open a new terminal.']),
  ];
  return pt ? [`  Autoverificação (Claude Code)  ok  ${checks} verificações passaram`,
    ...(windows ? ['  Comando (git-bash)  pulado  git-bash não está instalado'] : []),
    ...(!update ? ['  Painel opcional  pulado  Ative depois: okit-plugin install --panel'] : []),
    '  Modelos  -  ainda não definidos. Rode: okit-plugin setup',
    '  Kit (opcional)  -  não encontrado. Só é necessário para o fluxo de orquestração: INSTALL.pt-BR.md#kit-de-orquestração',
    '\nNotas', '  O SHA-256 detecta bytes alterados; não autentica a origem.',
    update ? '  Servidor MCP de Claude Code substituído por esta instalação' : '  Servidor MCP registrado no Claude Code',
    update ? '  Volte à versão guardada: okit-plugin update --rollback' : '  Verifique a instalação: okit-plugin doctor --client claude-code',
    '\nPróximo', ...(windows ? ['Execute agora:', HINT('<bin>'), 'ou abra um terminal novo'] : ['Abra um terminal novo.'])]
    : [`  Self-check (Claude Code)  ok  ${checks} checks passed`,
      ...(windows ? ['  Command (git-bash)  skipped  git-bash is not installed'] : []),
      ...(!update ? ['  Optional panel  skipped  Turn on later: okit-plugin install --panel'] : []),
      '  Models  -  not set yet. Run: okit-plugin setup',
      '  Kit (optional)  -  not found. Needed only for the orchestration workflow: INSTALL.md#orchestration-kit',
      '\nNotes', '  SHA-256 detects altered bytes; it does not authenticate the source.',
      update ? '  MCP server of Claude Code replaced by this installation' : '  MCP server registered in Claude Code',
      update ? '  Return to the retained version: okit-plugin update --rollback' : '  Check the installation: okit-plugin doctor --client claude-code',
      '\nNext', ...(windows ? ['Run this now:', HINT('<bin>'), 'or open a new terminal'] : ['Open a new terminal.'])];
}

function assertLines(actual, expected, context) {
  assert.equal(actual.length, expected.length, `${context}\n${actual.join('\n')}`);
  expected.forEach((want, index) => {
    if (want instanceof RegExp) assert.match(actual[index], want, `${context} line ${index + 1}`);
    else assert.equal(actual[index], want, `${context} line ${index + 1}`);
  });
}

function assertStatusColumns(output) {
  const steps = output.filter((line) => /^\[\d+\/\d+\] /.test(line));
  const columns = steps.map((line) => {
    const match = / {2,}(ok|skipped|pulado)(?= |$)/.exec(line);
    assert.ok(match, `missing status separator: ${line}`);
    return match.index + match[0].length - match[1].length;
  });
  if (steps.length) assert.equal(new Set(columns).size, 1, steps.join('\n'));
}

test('the embedded installer presenter retains its existing rendering contract', async (t) => {
  for (const locale of LOCALES) {
    const f = await fixture(t);
    for (const [command, expected] of [['install', legacyInstallLines], ['update', legacyUpdateLines], ['uninstall', legacyUninstallLines]]) {
      const ui = createPresenter({ locale, write: (line) => f.output.push(line) });
      if (command === 'update') f.setVersion('2.0.0');
      f.clear();
      assert.equal(await main([command, ...(command === 'install' ? ['--client', 'claude-code'] : []), '--locale', locale], { ...f.io, ui }), 0);
      if (command !== 'uninstall') assertLines(f.lines(), expected(locale, 'linux'), command);
      else assertLines(f.lines(), expected(locale, 'linux').map((line) => line.replaceAll('1.0.0', '2.0.0')), command);
    }
  }
});

for (const locale of LOCALES) {
  for (const platform of PLATFORMS) {
    test(`golden: install and uninstall in ${locale} on ${platform}`, async (t) => {
      const f = await fixture(t, platform);
      assert.equal(await main(['install', '--client', 'claude-code', '--locale', locale], f.io), 0, f.output.join('\n'));
      assertStatusColumns(f.output);
      assertLines(f.lines(), [...installLines(locale, platform), ...retainedEvidence(locale, platform)], `install ${locale} ${platform}`);

      f.clear();
      assert.equal(await main(['uninstall', '--locale', locale], f.io), 0, f.output.join('\n'));
      assertStatusColumns(f.output);
      const removed = locale === 'en'
        ? ['1. Unregister from Claude Code: complete — marketplace and plugin removed', '2. Remove command and PATH: complete — okit-plugin removed',
          '3. Remove files: complete — <data>/1.0.0-claude-code (your settings are kept)', '  MCP server removed from Claude Code']
        : ['1. Remover registro do Claude Code: concluído — marketplace e plugin removidos', '2. Remover comando e PATH: concluído — okit-plugin removido',
          '3. Remover arquivos: concluído — <data>/1.0.0-claude-code (seus ajustes foram mantidos)', '  Servidor MCP removido do Claude Code'];
      const program = shown([process.execPath, fileURLToPath(new URL('../src/cli.js', import.meta.url))], platform);
      assertLines(f.lines(), [...uninstallLines(locale, program), ...removed], `uninstall ${locale} ${platform}`);
    });

    test(`golden: update in ${locale} on ${platform}`, async (t) => {
      const f = await fixture(t, platform);
      assert.equal(await main(['install', '--client', 'claude-code', '--locale', locale], f.io), 0, f.output.join('\n'));
      f.clear();
      f.setVersion('2.0.0');
      assert.equal(await main(['update', '--locale', locale], f.io), 0, f.output.join('\n'));
      assertStatusColumns(f.output);
      const expected = updateLines(locale, platform);
      assertLines(f.lines(), [...expected, ...retainedEvidence(locale, platform, true)], `update ${locale} ${platform}`);
    });
  }
}

// A kit whose version command fails is one row of the run: the reason is
// translated with the row, in the language of the run.
const BROKEN_KIT = {
  en: { marker: 'broken (', reason: 'version command failed' },
  'pt-BR': { marker: 'com defeito (', reason: 'o comando de versão falhou' },
};

test('a broken kit is one row of the run, with its reason in the chosen language', async (t) => {
  for (const locale of LOCALES) {
    const f = await fixture(t, 'linux');
    await fs.mkdir(f.bin, { recursive: true });
    const kit = join(f.bin, 'kit');
    await fs.writeFile(kit, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const run = f.io.run;
    // The fake kit fails its version command; the injected run starts no process.
    f.io.run = async (input) => (input?.command === kit ? { code: 1, stdout: '' } : run(input));
    const expected = BROKEN_KIT[locale];
    assert.equal(localizeReason('version command failed', locale), expected.reason, locale);
    for (const argv of [['install', '--client', 'claude-code'], ['update', '--check']]) {
      f.clear();
      if (argv[0] === 'update') {
        f.setVersion('2.0.0');
        assert.equal(await main(['install', '--client', 'claude-code', '--locale', locale], f.io), 0, f.output.join('\n'));
        f.clear();
      }
      assert.equal(await main([...argv, '--locale', locale], f.io), 0, f.output.join('\n'));
      const row = f.lines().find((line) => /Kit \((optional|opcional)\)/.test(line));
      assert.ok(row, `${argv.join(' ')} ${locale}\n${f.output.join('\n')}`);
      assert.ok(row.includes(expected.marker), row);
      assert.ok(row.includes(expected.reason), row);
      if (locale === 'pt-BR') assert.ok(!row.includes('version command failed'), row);
    }
  }
});

test('the line structure is the same on every system', async (t) => {
  const shapes = [];
  for (const platform of PLATFORMS) {
    const f = await fixture(t, platform);
    assert.equal(await main(['install', '--client', 'claude-code'], f.io), 0, f.output.join('\n'));
    // Steps and rows: the label and the status; notes and the closing line: their kind.
    // A shell that is not on the machine is a skipped row of its own; which shells exist is the machine's, not the layout's.
    shapes.push(f.lines().filter((line) => line && !/^  Command \(|^Run this now:|^\$env:Path|^(?:or open|Open) a new terminal/.test(line)).map((line) => (/^(\[\d\/\d\] |  )[^ ]/.test(line) ? line.split('  ').slice(0, 2).join('|') : line.slice(0, 5))).map((line, index) => (index === 0 ? 'header' : line)));
  }
  // Platform-specific activation commands and unavailable shells were checked separately.
  assert.deepEqual(shapes[1], shapes[0]);
  assert.deepEqual(shapes[2], shapes[0]);
  assert.equal(shapes[0].length, shapes[2].length);
});

test('nothing is printed twice: the SHA-256 note, Release, Asset and Destination', async (t) => {
  for (const locale of LOCALES) {
    for (const platform of PLATFORMS) {
      const f = await fixture(t, platform);
      const runs = [['install', '--client', 'claude-code'], ['update']];
      for (const [index, argv] of runs.entries()) {
        f.clear();
        if (index === 1) f.setVersion('2.0.0');
        assert.equal(await main([...argv, '--locale', locale], f.io), 0, f.output.join('\n'));
        const lines = f.lines();
        const context = `${argv[0]} ${locale} ${platform}\n${lines.join('\n')}`;
        assert.equal(new Set(lines.filter(Boolean)).size, lines.filter(Boolean).length, `a line repeats in ${context}`);
        const text = lines.join('\n');
        assert.ok((text.match(/does not authenticate|não autentica/g)?.length ?? 0) <= 1, `the SHA-256 note never repeats in ${context}`);
        assert.doesNotMatch(text, /Release:|Asset:|Destination:|Versão:|Arquivo:|Destino:/, context);
        assert.equal(text.match(/\$env:Path =/g)?.length ?? 0, platform === 'win32' ? 1 : 0, `the hint is in the next-steps list only in ${context}`);
      }
    }
  }
});

test('the temporary extraction folders never appear', async (t) => {
  for (const flags of [[], ['--verbose']]) {
    const f = await fixture(t, 'linux');
    assert.equal(await main(['install', '--client', 'claude-code', ...flags], f.io), 0);
    f.setVersion('2.0.0');
    assert.equal(await main(['update', ...flags], f.io), 0);
    const text = f.output.join('\n');
    assert.ok(!text.includes(f.scratch), text);
    // The fixture home itself is named installer-output-*. Its destination and
    // backup paths are public; inspect only the paths below that known home.
    assert.doesNotMatch(text.replaceAll(f.home, '<home>'), /(?:^|[\\/])(?:installer-|plugin-[A-Za-z0-9]{6}|\.staging-)/m);
  }
});

test('raw commands appear only with --verbose', async (t) => {
  const quiet = await fixture(t, 'linux');
  assert.equal(await main(['install', '--client', 'claude-code'], quiet.io), 0);
  assert.ok(quiet.commands.length > 0, 'the registration commands still run');
  assert.ok(!quiet.output.some((line) => /marketplace add|> /.test(line)), quiet.output.join('\n'));

  const verbose = await fixture(t, 'linux');
  assert.equal(await main(['install', '--client', 'claude-code', '--verbose'], verbose.io), 0);
  assert.ok(verbose.output.some((line) => /^\s+> .*plugin marketplace add/.test(line)), verbose.output.join('\n'));
  // The same steps, plus the details.
  const steps = (lines) => lines.filter((line) => /^\[\d\/\d\] /.test(line));
  assert.deepEqual(steps(verbose.lines()), steps(quiet.lines()));
});

test('refusals select --locale or the environment before parsing flags', async (t) => {
  for (const locale of LOCALES) {
    for (const explicit of [true, false]) {
      const f = await fixture(t);
      f.io.env.OKIT_LANGUAGE = explicit ? (locale === 'en' ? 'pt-BR' : 'en') : locale;
      const args = ['install', '--unknown', ...(explicit ? ['--locale', locale] : [])];
      assert.equal(await main(args, f.io), 2);
      const text = f.output.join('\n');
      assert.match(text, locale === 'en' ? /^Refused: Unknown flag: --unknown\n\s+Next: check the options/ : /^Recusado: Opção desconhecida: --unknown\n\s+O que fazer: confira as opções/);
      assert.doesNotMatch(text, locale === 'en' ? /Recusado:|O que fazer:/ : /Refused:|Next:/);
    }
  }
});

test('incompatible execution-policy flags are refused entirely in the chosen language', async (t) => {
  for (const locale of LOCALES) {
    for (const command of ['install', 'update']) {
      const f = await fixture(t);
      assert.equal(await main([command, '--locale', locale, '--set-execution-policy', '--no-execution-policy'], f.io), 2);
      assert.deepEqual(f.output, locale === 'en' ? [
        'Refused: --set-execution-policy and --no-execution-policy cannot be combined',
        '      Next: check the options and try again',
      ] : [
        'Recusado: --set-execution-policy e --no-execution-policy não podem ser combinadas',
        '      O que fazer: confira as opções e tente de novo',
      ]);
    }
  }
});

test('invalid JSON refusals use the requested or environment language', async (t) => {
  for (const locale of LOCALES) {
    for (const explicit of [true, false]) {
      const f = await fixture(t);
      await fs.writeFile(join(f.root, 'config.json'), '{invalid JSON');
      f.io.env.OKIT_LANGUAGE = explicit ? (locale === 'en' ? 'pt-BR' : 'en') : locale;
      assert.equal(await main(['install', ...(explicit ? ['--locale', locale] : [])], f.io), 1);
      const text = f.output.join('\n');
      assert.match(text, locale === 'en' ? /^Refused:/ : /^Recusado:/);
      assert.match(text, locale === 'en' ? /\n\s+Next: check the options/ : /\n\s+O que fazer: confira as opções/);
      assert.doesNotMatch(text, locale === 'en' ? /Recusado:|O que fazer:|Não foi possível/ : /Refused:|Next:|Could not/);
      assert.doesNotMatch(text, / \/ /, 'the reason must also use a single language');
    }
  }
});

test('one language per run: --locale beats the saved language, which beats English', async (t) => {
  const f = await fixture(t, 'linux');
  await fs.writeFile(join(f.root, 'config.json'), JSON.stringify({ install: f.io.config, language: 'pt-BR' }));
  assert.equal(await main(['install', '--client', 'claude-code'], f.io), 0);
  assert.equal(f.output[0], 'okit-plugin 1.0.0 — instalação para Claude Code');
  assert.ok(!f.output.some((line) => /Download and verify|Next:/.test(line)));
  f.clear();
  assert.equal(await main(['update', '--locale', 'en'], f.io), 0);
  assert.ok(f.output.some((line) => /is up to date/.test(line)), f.output.join('\n'));
  assert.ok(!f.output.some((line) => /Em dia|Pronto/.test(line)));
});

test('errors name the step, the reason and what to do next, in the chosen language', async (t) => {
  for (const [locale, head, next] of [['en', /^The release could not be downloaded\. Nothing was installed\.$/, /^Check your connection, then retry: okit-plugin install --client claude-code$/], ['pt-BR', /^Não foi possível baixar a versão\. Nada foi instalado\.$/, /^Confira sua conexão e tente: okit-plugin install --client claude-code$/]]) {
    const f = await fixture(t, 'linux');
    // The command and Node are on the PATH, so the retry names the command by its short name.
    const commands = join(f.home, 'commands');
    await fs.mkdir(commands);
    for (const name of ['okit-plugin', 'node']) await fs.writeFile(join(commands, name), '#!/bin/sh\n', { mode: 0o755 });
    f.io.env = { ...f.io.env, PATH: [commands, f.io.env.PATH].join(delimiter) };
    // A package that cannot be downloaded; every other request is the fixture's.
    const good = f.io.fetch;
    f.io.fetch = async (url, options) => { if (url.includes('/package/')) throw new Error('boom'); return good(url, options); };
    assert.equal(await main(['install', '--client', 'claude-code', '--locale', locale], f.io), 1);
    assert.ok(f.output.some((line) => head.test(line)), f.output.join('\n'));
    assert.ok(f.output.some((line) => next.test(line)), f.output.join('\n'));
  }
});

test('y and s both mean yes, in either language; an empty answer is the default', () => {
  for (const locale of LOCALES) {
    const lines = [];
    const ui = createPresenter({ locale, write: (line) => lines.push(line) });
    for (const yes of ['y', 'Y', 's', 'S', 'yes', 'sim', ' s ']) assert.equal(ui.answer(yes), true, `${locale} ${yes}`);
    for (const no of ['n', 'N', 'no', 'não', 'x', '1']) assert.equal(ui.answer(no, true), false, `${locale} ${no}`);
    assert.equal(ui.answer(''), false);
    assert.equal(ui.answer('', true), true);
    assert.equal(ui.question('Q?'), locale === 'en' ? 'Q? [y/N] ' : 'Q? [s/N] ');
    assert.equal(ui.question('Q?', true), locale === 'en' ? 'Q? [Y/n] ' : 'Q? [S/n] ');
  }
});

for (const locale of LOCALES) test(`D135 every confirm explanation line has space around it: ${locale}`, async () => {
  const lines = [];
  const { ui } = createInstallerView({ operation: 'install', command: 'okit-plugin', locale, write: (line) => lines.push(line) });
  const explain = [ui.text('panelExplain')];
  await ui.confirm(async (question) => { lines.push(question); return ''; }, { explain, question: ui.text('panelAsk') });
  assert.deepEqual(lines.slice(-4), ['', ...explain, '', ui.question(ui.text('panelAsk'))]);
  await ui.confirm(async (question) => { lines.push(question); return ''; }, {
    explain: [ui.text('modelsExplain')], question: ui.text('modelsAsk'), defaultYes: true,
  });
  assert.deepEqual(lines.slice(-4), ['', ui.text('modelsExplain'), '', ui.question(ui.text('modelsAsk'), true)]);
});

// D140 must pass / must refuse:
// | confirmed | current choices, default-No review, Models ok when kept | pending warning |
// | pending, any selected client | review question | silent return |
// | empty listing | explanation and later command | empty table or save question |
// | every mode and language | one blank between blocks | leading/trailing/double blanks |
for (const locale of LOCALES) for (const mode of ['clean', 'confirmed', 'no-tty', 'empty', 'declined', 'dry-run', 'yes', 'no-panel']) {
  test(`D140 installer blocks and model truth: ${locale} ${mode}`, async (t) => {
    const pt = locale === 'pt-BR', questions = [];
    const f = await fixture(t, 'linux', { tty: mode !== 'no-tty' });
    f.io.setupAdapters = [{ CLIENT: 'claude-code', listModels: async () => ({
      client: 'claude-code', installed: true, models: mode === 'empty' ? [] : ['sonnet'], source: 'listing',
    }) }];
    const answer = async (question) => {
      questions.push(question); f.output.push(question.trimEnd());
      if (/optional panel|painel opcional|Review or change|Revisar ou alterar/.test(question) || mode === 'declined') return 'n';
      return /Save these choices|Salvar estas escolhas|\[\d+\]/.test(question) ? '' : 'y';
    };
    f.io.ask = answer; f.io.read = answer;
    if (mode === 'confirmed') {
      const file = join(f.root, 'config.json'), config = JSON.parse(await fs.readFile(file, 'utf8'));
      config.profiles = { 'claude-code': Object.fromEntries(['simple', 'normal', 'hard'].map((name) => [name, { model: 'sonnet', effort: 'high' }])) };
      config.setup = { done: { profiles: config.profiles } };
      await fs.writeFile(file, JSON.stringify(config));
    }
    const flags = ['dry-run', 'yes', 'no-panel'].includes(mode) ? [`--${mode}`] : [];
    assert.equal(await main(['install', '--client', 'claude-code', '--locale', locale, ...flags], f.io), 0);
    const lines = f.lines(), output = lines.join('\n');
    assert.doesNotMatch(output, /^\n|\n$|\n\n\n/);
    const stepLine = /^\d+\. (Download|Baixar|Install files|Instalar arquivos|Connect|Conectar|Command|Comando|Quota|Registro)/;
    const summaryLine = /^(Installed|Instalado|Preview only|Somente prévia)/;
    const heads = lines.filter((line) => stepLine.test(line) || /^  (Models|Modelos|Kit)/.test(line) || summaryLine.test(line));
    assert.deepEqual(heads.map((line) => /^\d+/.exec(line)?.[0] ?? (/Kit/.test(line) ? 'kit' : /Models|Modelos/.test(line) ? 'models' : 'summary')),
      ['1', '2', '3', '4', '5', ...(mode === 'dry-run' ? [] : ['models']), 'kit', 'summary']);
    for (let i = 1; i < lines.length; i++) {
      if (stepLine.test(lines[i]) || /^  (Models|Modelos|Kit|Optional panel|Painel opcional)/.test(lines[i]) || summaryLine.test(lines[i])) assert.equal(lines[i - 1], '', output);
      if (/\? \[[^\]]+\]/.test(lines[i])) assert.equal(lines[i + 1], '', output);
    }
    const stored = JSON.parse(await fs.readFile(join(f.root, 'config.json'), 'utf8'));
    const pending = ['simple', 'normal', 'hard'].some((name) => !stored.setup?.done?.profiles?.['claude-code']?.[name]);
    if (mode !== 'dry-run') assert.equal(/still need confirmation|Falta confirmar/.test(output), pending, output);
    assert.equal(questions.some((q) => /models now|modelos agora/.test(q)), !['confirmed', 'no-tty', 'dry-run'].includes(mode));
    if (mode === 'confirmed') assert.match(output, pt ? /Modelos\s+ok\s+mantidos/ : /Models\s+ok\s+kept/);
    if (mode === 'empty') {
      assert.match(output, pt ? /\| Tarefas pequenas \| haiku/ : /\| Small tasks \| haiku/);
      assert.match(output, pt ? /Modelos\s+ok/ : /Models\s+ok/);
    }
  });
}

// Round 2 must pass / must refuse:
// | failure reason, with/without final period | one period before the next sentence | doubled period |
// | no choices (listing/catalog/disabled profiles) | Models result + pending summary | any model question |
// | candidates available | normal setup question | silently skipping |
// | reinstall status | initial Up to date block separated from numbered steps | moving or joining it |
for (const locale of ['en', 'pt-BR', 'both']) {
  test(`D140 round 2 failure reason punctuation ${locale}`, () => {
    const reason = locale === 'pt-BR' ? 'Nenhuma resposta válida foi escolhida. Nada foi salvo' : 'No valid answer was chosen. Nothing was saved';
    for (const trailing of ['', '.']) {
      const output = formatOffer('failed', locale, { command: 'okit-plugin', reason: reason + trailing });
      assert.doesNotMatch(output, /\.\./);
      assert.ok(output.includes(`${reason}. ${locale === 'pt-BR' ? 'Rode' : 'Run'} okit-plugin setup`), output);
      assert.equal(output, formatOffer('failed', locale, { command: 'okit-plugin', reason }));
    }
  });
}

for (const client of ['claude-code', 'codex', 'opencode']) for (const locale of LOCALES) {
  for (const mode of ['absent', 'empty', 'disabled', 'available']) test(`D140 round 2 model question needs choices ${client} ${locale} ${mode}`, async (t) => {
    const f = await fixture(t), questions = [], models = [...new Set(Object.values(DEFAULT_CONFIG.profiles[client]).map((profile) => profile.model))];
    f.io.loadAdapter = async () => moduleAdapter;
    f.io.tty = true;
    f.io.ask = async (question) => {
      questions.push(question);
      f.output.push(question.trimEnd());
      return 'n';
    };
    f.io.read = f.io.ask;
    f.io.setupAdapters = [{ CLIENT: client, listModels: async () => ({ client, installed: mode !== 'absent',
      source: client === 'claude-code' && ['absent', 'empty'].includes(mode) ? 'catalog' : 'listing',
      models: ['absent', 'empty'].includes(mode) ? [] : models, hidden: mode === 'empty' ? models : [],
    }) }];
    if (mode === 'disabled') {
      const file = join(f.root, 'config.json'), config = JSON.parse(await fs.readFile(file, 'utf8'));
      config.profiles = { [client]: { simple: null, normal: null, hard: null } };
      await fs.writeFile(file, JSON.stringify(config));
    }
    assert.equal(await main(['install', '--client', client, '--locale', locale, '--no-panel', '--no-statusline'], f.io), 0);
    const output = f.lines().join('\n');
    assert.equal(questions.length, mode === 'available' ? 1 : 0, output);
    if (mode !== 'available') assert.match(output, locale === 'en' ? /Models\s+-\s+No models are available to choose\. Enable a model in your client, then run: okit-plugin setup/ : /Modelos\s+-\s+Nenhum modelo disponível para escolher\. Ative um modelo no cliente e rode: okit-plugin setup/);
    else {
      assert.match(questions[0], /models now|modelos agora/);
      const lines = f.lines(), question = lines.indexOf(questions[0].trimEnd());
      assert.ok(question >= 0, output);
      assert.equal(lines[question + 1], '', output);
      assert.match(lines[question + 2], /^\s*(?:Models\s+skipped|Modelos\s+pulado)\s+/, output);
    }
    assert.match(output, /Model choices still need confirmation|Falta confirmar os modelos/);
    assert.doesNotMatch(output, /\| Work \| Model \||\| Trabalho \| Modelo \||Save these choices|Salvar estas escolhas|\n\n\n/);
  });
}

for (const client of ['claude-code', 'codex', 'opencode']) for (const locale of LOCALES) {
  test(`D140 round 2 reinstall starts with separated status ${client} ${locale}`, async (t) => {
    const f = await fixture(t);
    f.io.loadAdapter = async () => moduleAdapter;
    const args = ['install', '--client', client, '--locale', locale, '--no-panel', '--no-statusline'];
    assert.equal(await main(args, f.io), 0);
    f.clear();
    assert.equal(await main(args, f.io), 0);
    const lines = f.lines(), upToDate = lines.findIndex((line) => /(?:Up to date|Em dia)\s+ok\s+1\.0\.0/.test(line));
    const firstStep = lines.findIndex((line) => /^1\. /.test(line));
    assert.equal(upToDate, 1, 'Up to date is the first status line after the heading');
    assert.equal(firstStep, upToDate + 2, lines.join('\n'));
    assert.equal(lines[firstStep - 1], '');
    assert.doesNotMatch(lines.join('\n'), /^\n|\n$|\n\n\n/);
  });
}

// Round 1 must pass / must refuse:
// | confirmed N, or cancelled review | byte-identical config, kept + true summary | a write or pending warning |
// | first install / unavailable listing | nonempty proposals, default-Yes save | empty table |
// | no TTY | suggested choices + setup, or confirmed choices + setup --again | any question |
// | update, unchanged proposals | one ok row | review question |
// | update, different proposals | default-No review | silently skipping |
test('D140 round 1 disabled profiles never reach an empty save table', async (t) => {
  const f = await fixture(t), output = [], questions = [];
  const result = await runSetup({ root: f.root, clients: ['claude-code'], locale: 'en',
    config: { profiles: { 'claude-code': { simple: null, normal: null, hard: null } } },
    adapters: [{ CLIENT: 'claude-code', listModels: async () => ({ client: 'claude-code', installed: true, models: ['sonnet'], source: 'listing' }) }],
    out: (line) => output.push(line), ask: async (question) => { questions.push(question); return 'y'; } });
  assert.deepEqual(result.changes, []);
  assert.deepEqual(questions, []);
  assert.doesNotMatch(output.join('\n'), /\| Work \| Model \||Save these choices/);
});

for (const client of ['claude-code', 'codex', 'opencode']) for (const locale of LOCALES) {
  for (const mode of ['keep', 'review-cancel', 'first', 'unconfirmed-edit', 'no-tty', 'no-tty-pending', 'update-quiet', 'update-change', 'update-first', 'fallback', 'confirmed-fallback']) {
    test(`D140 round 1 ${client} ${locale} ${mode}`, async (t) => {
      const f = await fixture(t), pt = locale === 'pt-BR', questions = [];
      f.io.loadAdapter = async () => moduleAdapter;
      const defaults = DEFAULT_CONFIG.profiles[client];
      const confirmed = !['first', 'fallback', 'no-tty-pending', 'unconfirmed-edit', 'update-first'].includes(mode);
      const custom = ['review-cancel', 'update-change', 'unconfirmed-edit', 'confirmed-fallback'].includes(mode);
      const saved = Object.fromEntries(Object.entries(defaults).map(([name, profile]) => [name,
        { ...profile, ...(custom ? { model: `saved-${client}` } : {}) }]));
      f.io.setupAdapters = [{ CLIENT: client, listModels: async () => {
        if (/fallback/.test(mode)) throw new Error('listing unavailable');
        return { client, installed: true, source: 'listing', models: [...new Set([
          ...Object.values(defaults).map((profile) => profile.model), ...(custom ? [`saved-${client}`] : []),
        ])] };
      } }];
      if (mode.startsWith('update')) {
        assert.equal(await main(['install', '--client', client, '--no-panel', '--no-statusline'], f.io), 0);
        f.setVersion('2.0.0'); f.clear();
      }
      const file = join(f.root, 'config.json'), config = JSON.parse(await fs.readFile(file, 'utf8'));
      if (confirmed || mode === 'unconfirmed-edit') {
        config.profiles = { [client]: saved };
        config.setup = { done: { profiles: { [client]: mode === 'unconfirmed-edit' ? defaults : saved } } };
      }
      await fs.writeFile(file, JSON.stringify(config, null, 2) + '\n');
      const before = await fs.readFile(file, 'utf8');
      f.io.tty = !mode.startsWith('no-tty');
      const answer = async (question) => {
        questions.push(question); f.output.push(question.trimEnd());
        if (/Review or change|Revisar ou alterar/.test(question)) return mode === 'review-cancel' ? 'y' : '';
        if (/Save these choices|Salvar estas escolhas/.test(question)) return mode === 'review-cancel' ? 'n' : '';
        return '';
      };
      f.io.ask = answer; f.io.read = answer;
      const args = mode.startsWith('update') ? ['update', '--client', client, '--no-statusline'] : ['install', '--client', client, '--no-panel', '--no-statusline'];
      assert.equal(await main([...args, '--locale', locale], f.io), 0, f.output.join('\n'));
      const lines = f.lines(), output = lines.join('\n');
      const review = questions.filter((question) => /Review or change|Revisar ou alterar/.test(question));
      assert.equal(review.length, confirmed && !['no-tty', 'update-quiet'].includes(mode) ? 1 : 0, output);
      if (review.length) assert.equal(review[0], pt ? 'Revisar ou alterar os modelos? [s/N] ' : 'Review or change the models? [y/N] ');
      if (confirmed) {
        assert.equal(await fs.readFile(file, 'utf8'), before, 'review/keep must not write configuration');
        assert.match(output, pt ? /Modelos\s+ok\s+mantidos/ : /Models\s+ok\s+kept/);
        assert.doesNotMatch(output, /still need confirmation|Falta confirmar/);
        if (mode !== 'update-quiet') for (const profile of Object.values(saved)) assert.ok(output.includes(profile.model), output);
      }
      if (mode === 'review-cancel') {
        assert.equal(questions.filter((q) => /\[\d+\]:$/.test(q)).length, 3, 'again must ask all three classes');
        for (const label of pt ? ['Tarefas pequenas', 'Tarefas do dia a dia', 'Tarefas complexas'] : ['Small tasks', 'Everyday tasks', 'Complex tasks']) {
          assert.ok(lines.some((line) => line.includes(`| ${label} | saved-${client}`)), output);
        }
      }
      if (mode.startsWith('no-tty') || mode === 'update-quiet') assert.deepEqual(questions, []);
      if (mode === 'no-tty') {
        assert.match(output, /setup --again/);
        assert.doesNotMatch(output, /Suggested models|Modelos sugeridos|Confirm the suggestions|Confirme as sugestões/);
      }
      if (mode === 'no-tty-pending') {
        assert.match(output, pt ? /Modelos sugeridos — / : /Suggested models — /);
        assert.match(output, pt ? /Confirme as sugestões: okit-plugin setup\n/ : /Confirm the suggestions: okit-plugin setup\n/);
        assert.doesNotMatch(output, /Current models|Modelos atuais|Change later|Altere depois|setup --again/);
      }
      if (['first', 'fallback', 'unconfirmed-edit', 'update-first'].includes(mode)) {
        assert.match(questions.join('\n'), pt ? /Salvar estas escolhas\? \[S\/n\]/ : /Save these choices\? \[Y\/n\]/);
        const after = JSON.parse(await fs.readFile(file, 'utf8'));
        for (const name of ['simple', 'normal', 'hard']) assert.ok(after.setup?.done?.profiles?.[client]?.[name]);
        if (mode === 'unconfirmed-edit') assert.equal(after.setup.done.profiles[client].normal.model, `saved-${client}`);
        assert.doesNotMatch(output, /still need confirmation|Falta confirmar/);
      }
      if (client !== 'claude-code') assert.doesNotMatch(output, /[Oo]ptional panel|[Pp]ainel opcional/);
      assert.doesNotMatch(output, /^\n|\n$|\n\n\n/);
      const flat = output.split('\n');
      for (let i = 0; i < flat.length; i++) {
        if (/\? \[[^\]]+\]/.test(flat[i]) || /\[\d+\]:$/.test(flat[i])) assert.equal(flat[i + 1], '', output);
      }
      if (mode === 'no-tty-pending') assert.match(output, /still need confirmation|Falta confirmar/);
      if (confirmed && mode !== 'update-quiet') {
        const current = flat.findIndex((line) => /^(Current models|Modelos atuais)/.test(line));
        assert.ok(current > 0, output); assert.equal(flat[current - 1], '', output);
        assert.equal(flat.slice(current + 1, current + 4).filter((line) => /: /.test(line)).length, 3);
      }
    });
  }
}

for (const locale of LOCALES) for (const mode of ['confirmed', 'first', 'fallback']) test(`D140 round 1 all clients share one review with separate blocks: ${locale} ${mode}`, async (t) => {
  const f = await fixture(t), clients = ['claude-code', 'codex', 'opencode'], questions = [];
  f.io.loadAdapter = async () => moduleAdapter;
  f.io.setupAdapters = clients.map((client) => ({ CLIENT: client, listModels: async () => {
    if (mode === 'fallback') throw new Error('listing unavailable');
    return { client, installed: true, source: 'listing', models: [...new Set(Object.values(DEFAULT_CONFIG.profiles[client]).map((profile) => profile.model))] };
  } }));
  const file = join(f.root, 'config.json'), config = JSON.parse(await fs.readFile(file, 'utf8'));
  config.profiles = DEFAULT_CONFIG.profiles;
  if (mode === 'confirmed') config.setup = { done: { profiles: DEFAULT_CONFIG.profiles } };
  await fs.writeFile(file, JSON.stringify(config, null, 2) + '\n');
  const before = await fs.readFile(file, 'utf8');
  f.io.tty = true;
  f.io.ask = async (question) => { questions.push(question); f.output.push(question.trimEnd()); return ''; };
  assert.equal(await main(['install', '--client', 'all', '--no-panel', '--no-statusline', '--locale', locale], f.io), 0);
  if (mode === 'confirmed') {
    assert.equal(await fs.readFile(file, 'utf8'), before);
    assert.equal(questions.length, 1);
  } else {
    assert.equal(questions.filter((q) => /models now|modelos agora/.test(q)).length, 1);
    assert.equal(questions.filter((q) => /Save these choices|Salvar estas escolhas/.test(q)).length, 1);
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    for (const client of clients) for (const name of ['simple', 'normal', 'hard']) assert.ok(saved.setup?.done?.profiles?.[client]?.[name]);
  }
  const lines = f.lines();
  const headers = lines.map((line, index) => (mode === 'confirmed' ? /^(Current models|Modelos atuais)/.test(line) : /^(Claude Code|Codex|OpenCode)$/.test(line)) ? index : -1).filter((index) => index >= 0);
  assert.equal(headers.length, 3);
  for (const index of headers) {
    assert.equal(lines[index - 1], '');
    if (mode === 'confirmed') assert.equal(lines[index + 4], '');
  }
  assert.doesNotMatch(lines.join('\n'), /still need confirmation|Falta confirmar|\n\n\n/);
});

test('D140 a confirmation for another client never hides selected pending profiles', async (t) => {
  for (const client of ['claude-code', 'codex', 'opencode']) {
    const f = await fixture(t, 'linux', { tty: true }), questions = [];
    const file = join(f.root, 'config.json'), config = JSON.parse(await fs.readFile(file, 'utf8'));
    config.setup = { done: { profiles: { other: { simple: {}, normal: {}, hard: {} } } } };
    await fs.writeFile(file, JSON.stringify(config));
    const ui = createPresenter({ locale: 'en', write: (line) => f.output.push(line) });
    const result = await offerSetup({ root: f.root, clients: [client], ui, tty: true,
      ask: async (question) => { questions.push(question); return 'n'; } });
    assert.equal(result.pending, true);
    assert.equal(questions.filter((question) => /Choose the models now/.test(question)).length, 1, client);
    assert.match(f.output.join('\n'), /Run when you want: okit-plugin setup/);
  }
});

test('D140 saving one client keeps the summary pending for another selected client', async (t) => {
  const f = await fixture(t), output = [];
  const { ui, finish } = createInstallerView({ operation: 'install', command: 'okit-plugin', locale: 'en', write: (line) => output.push(line) });
  ui.beginClients(['claude-code', 'codex']);
  ui.header({ client: 'Claude Code', version: '1' });
  ui.header({ client: 'Codex', version: '1' });
  await offerSetup({ root: f.root, clients: ['claude-code', 'codex'], ui, tty: true,
    env: f.io.env, ask: async () => 'y', adapters: [
      { CLIENT: 'claude-code', listModels: async () => ({ client: 'claude-code', installed: true, models: ['sonnet'], source: 'listing' }) },
      { CLIENT: 'codex', listModels: async () => ({ client: 'codex', installed: false, models: [], source: 'listing' }) },
    ] });
  finish({ code: 0, client: 'all', after: { 'claude-code': {}, codex: {} } });
  assert.match(output.join('\n'), /Models\s+-\s+sonnet saved/);
  assert.equal(output.filter((line) => /still need confirmation/.test(line)).length, 1);
  assert.ok(output.includes('Installed for Claude Code.'));
  assert.ok(output.includes('Installed for Codex. Model choices still need confirmation.'));
});

test('a prompt is the explanation first and one question last, and y or s are accepted at the models question', async (t) => {
  for (const [locale, answer] of [['en', 'y'], ['en', 's'], ['pt-BR', 'y'], ['pt-BR', 's']]) {
    const questions = [];
    const f = await fixture(t, 'linux', { tty: true, ask: async (question) => { questions.push(question); return answer; } });
    f.io.read = async () => 'n';
    assert.equal(await main(['install', '--client', 'codex', '--locale', locale], f.io), 0, f.output.join('\n'));
    const asked = questions.filter((question) => /agora\? \[S\/n\] $|now\? \[Y\/n\] $/.test(question));
    assert.equal(asked.length, 1, questions.join(' / '));
    assert.ok(!/\n/.test(asked[0]));
    const explain = f.output.findIndex((line) => /Choose models for small|Escolha modelos para tarefas pequenas/.test(line));
    assert.ok(explain > -1, f.output.join('\n'));
    assert.ok(!f.output.some((line) => /Run when you want|Rode quando quiser/.test(line)), `${locale} ${answer}: the question was accepted`);
  }
  const questions = [];
  const f = await fixture(t, 'linux', { tty: true, ask: async (question) => { questions.push(question); return 'n'; } });
  assert.equal(await main(['install', '--client', 'codex'], f.io), 0);
  assert.ok(f.output.some((line) => /Run when you want: okit-plugin setup/.test(line)), f.output.join('\n'));
});

function assertNoSetup(f, questions) {
  assert.deepEqual(questions, [], 'setup must not ask a question');
  assert.ok(!f.output.some((line) => /^\s+(Models|Modelos)\s/.test(line)), f.output.join('\n'));
  assert.doesNotMatch(f.output.join('\n'), /Setup chooses the models|O setup escolhe os modelos/);
}

test('setup is not offered after a failed install (succeeded guard)', async (t) => {
  for (const locale of LOCALES) {
    const questions = [];
    const f = await fixture(t, 'linux', { tty: true, ask: async (q) => { questions.push(q); return 'n'; } });
    const fetch = f.io.fetch;
    f.io.fetch = async (url) => { if (url.includes('/package/')) throw new Error('download failed'); return fetch(url); };
    assert.equal(await main(['install', '--client', 'claude-code', '--locale', locale], f.io), 1);
    assertNoSetup(f, questions);
  }
});

test('setup is not offered during dry-run (dryRun guard)', async (t) => {
  for (const locale of LOCALES) {
    const questions = [];
    const f = await fixture(t, 'linux', { tty: true, ask: async (q) => { questions.push(q); return 'n'; } });
    assert.equal(await main(['install', '--client', 'claude-code', '--dry-run', '--locale', locale], f.io), 0);
    assertNoSetup(f, questions);
    assert.equal(await fs.stat(f.destination).catch(() => null), null);
  }
});

test('setup is not offered by update --check (check guard)', async (t) => {
  for (const locale of LOCALES) {
    const f = await fixture(t);
    assert.equal(await main(['install', '--client', 'claude-code', '--locale', locale], f.io), 0);
    f.clear();
    f.setVersion('2.0.0');
    const questions = [];
    f.io.tty = true;
    f.io.ask = async (q) => { questions.push(q); return 'n'; };
    assert.equal(await main(['update', '--check', '--locale', locale], f.io), 0);
    assertNoSetup(f, questions);
  }
});

test('a finished step ignores every later completion and its notes', () => {
  for (const locale of LOCALES) {
    const lines = [];
    const ui = createPresenter({ locale, write: (line) => lines.push(line) });
    const step = ui.step(1, 1, 'Step');
    assert.equal(step.ended, false);
    step.ok('first result', ['first note']);
    assert.equal(step.ended, true);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /\bok\s+first result$/);
    assert.match(lines[1], /first note$/);
    const ended = [...lines];
    for (const complete of [step.ok, step.skip, step.plan, step.fail]) {
      complete('late result', ['late note']);
      assert.deepEqual(lines, ended, 'nothing may be printed after the step ends');
    }
  }
});

test('the presenter helpers: header, link row and the chosen side of a message', () => {
  const lines = [];
  const ui = createPresenter({ locale: 'pt-BR', write: (line) => lines.push(line) });
  ui.header(headerValues({ config: { entry: 'okit-plugin', architectures: { x64: 'x64' } }, platform: 'win32', arch: 'x64' }, '0.3.0', 'claude-code'));
  assert.deepEqual(lines, ['okit-plugin 0.3.0 para Claude Code (Windows x64)']);
  finishLink(ui, ui.step(4, 5, 'Comando e PATH'), null, {});
  assert.match(lines.at(-1), /^\[4\/5\] Comando e PATH\s+pulado\s+não criado \(--no-link\)$/);
  assert.equal(pick('English / Português', 'en'), 'English');
  assert.equal(pick('English / Português', 'pt-BR'), 'Português');
  assert.equal(pick('plain', 'pt-BR'), 'plain');
});

// Refusals are a class: every reason the installer can raise has pt-BR text.
// Terms that read the same in both languages go here, explicitly (none today).
const SAME_IN_BOTH = [];

async function source(name) {
  return fs.readFile(new URL(`../src/install/${name}`, import.meta.url), 'utf8');
}

test('every REASONS entry matches its whole example and has pt-BR text different from English', () => {
  assert.ok(REASONS.length > 30);
  for (const [pattern, pt, sample] of REASONS) {
    assert.equal(sample.match(pattern)?.[0], sample, `${pattern} must match its whole example`);
    const text = localizeReason(sample, 'pt-BR');
    assert.equal(localizeReason(sample, 'en'), sample);
    if (SAME_IN_BOTH.includes(sample)) continue;
    assert.notEqual(text, sample, `${sample}: no pt-BR text`);
    assert.ok(typeof pt === 'string' && pt !== '', `${sample}: empty pt-BR text`);
    assert.doesNotMatch(text, /\$\d/, `${sample}: unfilled capture`);
  }
});

test('every text of the presenter is written in both languages, by key', () => {
  // The texts that read the same in both languages carry no sentence: they are placeholders.
  const same = ['plain'];
  for (const [key, entry] of Object.entries(TEXTS)) {
    if (typeof entry !== 'object' || !entry.en) continue;
    assert.ok(entry['pt-BR'], `${key}: no pt-BR text`);
    if (!same.includes(key)) assert.notEqual(entry.en, entry['pt-BR'], `${key}: the pt-BR text is the English one`);
  }
  // The text of the MCP step that leaves an entry of a client as it is (the client does not say where it is kept).
  assert.ok(TEXTS.mcpManual?.en, 'mcpManual');
  assert.ok(TEXTS.mcpManual?.['pt-BR'], 'mcpManual');
  assert.notEqual(TEXTS.mcpManual.en, TEXTS.mcpManual['pt-BR'], 'mcpManual');
  // The text of the MCP step that leaves an entry as it is because the display cannot tell it from a foreign one.
  assert.ok(TEXTS.mcpAmbiguous?.en, 'mcpAmbiguous');
  assert.ok(TEXTS.mcpAmbiguous?.['pt-BR'], 'mcpAmbiguous');
  assert.notEqual(TEXTS.mcpAmbiguous.en, TEXTS.mcpAmbiguous['pt-BR'], 'mcpAmbiguous');
});

test('every refusal the installer code can raise is translated into pt-BR', async () => {
  const sites = [];
  for (const name of ['index.js', 'update.js', 'uninstall.js', 'menu.js', 'place.js', 'release.js', 'download.js', 'source.js', 'link.js',
    'extract.js', 'kit.js', 'config.js', 'statusline.js', 'policy.js']) {
    const code = await source(name);
    for (const [, , message] of code.matchAll(/new (?:Type)?Error\(\s*(['`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      // A message that already carries both languages ("EN / PT") needs no entry.
      if (message.includes(' / ')) continue;
      sites.push({ name, reason: message.replace(/\$\{[^}]*\}/g, 'x') });
    }
    // The statusline raises its error from the presenter's own text, never from a literal.
    if (name === 'statusline.js' || name === 'policy.js') {
      for (const [, rest] of code.matchAll(/new (?:Type)?Error\(\s*(?!['`])([^\n]*)/g)) {
        assert.match(rest, /^unreadable\(deps\)/, `${name}: Error not translated: ${rest}`);
      }
    }
  }
  // The installer also presents what src/cli.js raises for it (installerLifecycle: the daemon stop).
  const cli = await fs.readFile(new URL('../src/cli.js', import.meta.url), 'utf8');
  const start = cli.indexOf('function installerLifecycle');
  const lifecycle = cli.slice(start, cli.indexOf('\n}\n', start));
  assert.ok(start > 0 && lifecycle.length > 200, 'installerLifecycle not found in src/cli.js');
  const lifecycleSites = [...lifecycle.matchAll(/new (?:Type)?Error\(\s*(['`])((?:\\.|(?!\1)[^\\])*)\1/g)];
  assert.ok(lifecycleSites.length >= 1, 'no raise site found in installerLifecycle');
  for (const [, , message] of lifecycleSites) sites.push({ name: 'cli.js installerLifecycle', reason: message.replace(/\$\{[^}]*\}/g, 'x') });
  // The states the kit probe reports (kit.js) and the texts of the statusline error (statusline.js).
  for (const reason of ['version command failed', 'invalid version output', 'version command timed out after 5000 ms']) {
    sites.push({ name: 'kit.js', reason });
  }
  assert.notEqual(pick(TEXTS.statuslineError, 'pt-BR'), pick(TEXTS.statuslineError, 'en'));
  // The flag-pair refusals are built from EXCLUSIVE_FLAGS, not written out.
  for (const [first, second] of EXCLUSIVE_FLAGS) sites.push({ name: 'EXCLUSIVE_FLAGS', reason: `--${first} and --${second} cannot be combined` });
  assert.ok(sites.length > 30, `only ${sites.length} raise sites found`);
  for (const { name, reason } of sites) {
    if (SAME_IN_BOTH.includes(reason)) continue;
    assert.notEqual(localizeReason(reason, 'pt-BR'), reason, `${name}: "${reason}" has no pt-BR text`);
  }
});

test('every message in the bootstrap has a pt-BR side that differs from English', async () => {
  const code = await source('bootstrap.js');
  const pairs = [...code.matchAll(/\bt\(\s*(['`])((?:\\.|(?!\1)[^\\])*)\1\s*,\s*(['`])((?:\\.|(?!\3)[^\\])*)\3\s*\)/g)];
  assert.ok(pairs.length >= 10, `only ${pairs.length} bootstrap messages found`);
  for (const [, , en, , pt] of pairs) {
    if (!SAME_IN_BOTH.includes(en)) assert.notEqual(pt, en, `bootstrap: "${en}" has no pt-BR text`);
  }
  // A refusal that skips t() must carry both languages itself, except what a child process printed.
  for (const [, rest] of code.matchAll(/\bfail\((?!t\()([^\n]*)/g)) {
    assert.ok(rest.includes(' / ') || rest.startsWith('result.stderr'), `bootstrap: untranslated refusal fail(${rest}`);
  }
});

test('each pair of incompatible flags is refused in the chosen language', async (t) => {
  const cases = [];
  for (const [first, second] of EXCLUSIVE_FLAGS) {
    for (const command of Object.keys(ALLOWED_FLAGS)) {
      if (ALLOWED_FLAGS[command].includes(first) && ALLOWED_FLAGS[command].includes(second)) cases.push({ command, first, second });
    }
  }
  assert.equal(cases.length, 5, 'check/rollback on update; statusline and execution-policy on install and update');
  for (const { command, first, second } of cases) {
    for (const [locale, head, next] of [
      ['en', `Refused: --${first} and --${second} cannot be combined`, '      Next: check the options and try again'],
      ['pt-BR', `Recusado: --${first} e --${second} não podem ser combinadas`, '      O que fazer: confira as opções e tente de novo'],
    ]) {
      const f = await fixture(t);
      assert.equal(await main([command, `--${first}`, `--${second}`, '--locale', locale], f.io), 2, `${command} ${first} ${second}`);
      assert.deepEqual(f.output, [head, next], `${command} ${first} ${second} ${locale}`);
    }
  }
});

test('redact keeps addresses plain and hides the temporary folder', () => {
  assert.equal(redact('Download returned 403: https://user:pass@host.example/a/b.zip?token=TEST_SECRET#frag'), 'Download returned 403: https://host.example/a/b.zip');
  assert.equal(redact('Release/download request failed: https://host.example/x?sig=1: fetch failed'), 'Release/download request failed: https://host.example/x: fetch failed');
  assert.equal(redact("ENOTDIR: not a directory, mkdtemp '/var/scratch/tmp/installer-abc'", ['/var/scratch/tmp']), "ENOTDIR: not a directory, mkdtemp '<temp>/installer-abc'");
  assert.equal(redact('C:\\Users\\me\\Temp\\installer-abc', ['C:\\Users\\me\\Temp']), '<temp>\\installer-abc');
  assert.equal(redact('no address here'), 'no address here');
});

test('a download refused with a token in the address never prints the token', async (t) => {
  for (const locale of LOCALES) {
    const f = await fixture(t);
    const fetch = f.io.fetch;
    f.io.fetch = async (url, ...rest) => {
      if (url.endsWith('/latest')) {
        const data = await (await fetch(url, ...rest)).json();
        data.assets[0].browser_download_url = 'https://user:PASSWORD_SECRET@fake.invalid/private.zip?token=TEST_SECRET#TEST_FRAGMENT';
        return Response.json(data);
      }
      if (url.includes('TEST_SECRET')) return new Response('', { status: 403 });
      return fetch(url, ...rest);
    };
    assert.equal(await main(['install', '--client', 'claude-code', '--locale', locale], f.io), 1);
    const text = f.output.join('\n');
    assert.doesNotMatch(text, /TEST_SECRET|PASSWORD_SECRET|TEST_FRAGMENT/, `${locale}\n${text}`);
    assert.match(text, /https:\/\/fake\.invalid\/private\.zip/);
    assert.match(text, /403/);
  }
});

test('a temporary folder that cannot be used is shown as <temp>, not by its path', async (t) => {
  for (const locale of LOCALES) {
    const f = await fixture(t);
    f.io.tmpdir = join(f.scratch, 'not-a-folder');
    await fs.writeFile(f.io.tmpdir, 'file');
    assert.equal(await main(['install', '--client', 'claude-code', '--locale', locale], f.io), 1);
    const text = f.output.join('\n');
    assert.ok(text.includes('ENOTDIR'), text);
    assert.ok(text.includes('<temp>'), text);
    assert.ok(!text.includes(f.scratch) && !text.includes(f.io.tmpdir), `${locale}: ${text}`);
  }
});

test('the daemon that does not stop is refused in the chosen language', async (t) => {
  for (const [locale, head] of [['en', 'Failed at Back up your files: Daemon did not stop before timeout; installation retained'],
    ['pt-BR', 'Falhou em Copiar seus arquivos: O daemon não parou a tempo; a instalação foi mantida']]) {
    const f = await fixture(t);
    assert.equal(await main(['install', '--client', 'claude-code', '--locale', locale], f.io), 0);
    f.clear();
    f.setVersion('2.0.0');
    f.io.stopDaemon = async () => { throw new Error('Daemon did not stop before timeout; installation retained'); };
    assert.equal(await main(['update', '--locale', locale], f.io), 1);
    assert.equal(f.output.find((line) => line.startsWith(locale === 'en' ? 'Failed' : 'Falhou')), head);
  }
});

test('a --locale that is not a language is refused in one language', async (t) => {
  for (const [env, locale, head] of [
    ['pt-BR', 'fr', 'Recusado: Escolha um idioma: en, pt-BR.'],
    ['en', 'fr', 'Refused: Choose a language: en, pt-BR.'],
    [undefined, 'fr', 'Refused: Choose a language: en, pt-BR.'],
    ['pt-BR', 'xx', 'Recusado: Escolha um idioma: en, pt-BR.'],
  ]) {
    for (const command of ['install', 'update', 'uninstall']) {
      const f = await fixture(t);
      if (env) f.io.env.OKIT_LANGUAGE = env;
      assert.equal(await main([command, '--locale', locale], f.io), 2);
      assert.equal(f.output[0], head, `${command} ${env} ${locale}`);
      assert.doesNotMatch(f.output.join('\n'), / \/ /);
    }
  }
});

test('--verbose prints each registration command once, in both languages and in a dry run', async (t) => {
  for (const locale of LOCALES) {
    for (const flags of [[], ['--dry-run']]) {
      const f = await fixture(t, 'linux');
      assert.equal(await main(['install', '--client', 'claude-code', '--locale', locale, '--verbose', ...flags], f.io), 0);
      const count = (pattern) => f.output.filter((line) => pattern.test(line)).length;
      assert.equal(count(/> .*plugin marketplace add/), 1, `${locale} ${flags}: ${f.output.join('\n')}`);
      assert.equal(count(/> .*plugin install/), 1, `${locale} ${flags}: ${f.output.join('\n')}`);
    }
  }
});

// The class "no secret reaches the screen": redact is applied by the output door, not module by module.
// Must pass / must refuse:
// | case | must pass | must refuse |
// | an address with credentials, parentheses, query and fragment | host and path only | any part of the userinfo, query or fragment |
// | a secret in any module that prints (download, register, link, policy, kit, setup, update, uninstall), with and without --verbose, en and pt-BR | nothing of it, the scratch folder as <temp> | the secret or the scratch path in stdout or stderr |
// | a saved language that is not one | a refusal in English | both languages in one line |
const URL_SECRET = 'https://user:PASSWORD_SECRET@fake.invalid/a(b).zip?token=TOKEN_SECRET#FRAG_SECRET';
const LEAKS = /PASSWORD_SECRET|TOKEN_SECRET|FRAG_SECRET|user:PASS/;

test('redact keeps only the host and the path of an address, whatever surrounds it', () => {
  const cases = [
    [URL_SECRET, 'https://fake.invalid/a(b).zip'],
    [`GET ${URL_SECRET}.`, 'GET https://fake.invalid/a(b).zip.'],
    [`(${URL_SECRET})`, '(https://fake.invalid/a(b).zip)'],
    [`see [${URL_SECRET}], then`, 'see [https://fake.invalid/a(b).zip], then'],
    ['<https://u:p@h.invalid/x?a=1#b>', '<https://h.invalid/x>'],
    ['"https://u:p@h.invalid/x/(1)/y?token=T"', '"https://h.invalid/x/(1)/y"'],
    ['https://u:pa?ss@h.invalid/x', 'https://h.invalid/x'],
    ['https://h.invalid/@scope/pkg?x=1', 'https://h.invalid/@scope/pkg'],
    ['a https://one.invalid/?t=1 and ftp://u:p@two.invalid/z#f: done', 'a https://one.invalid/ and ftp://two.invalid/z: done'],
    ['failed: ?access_token=ABC123&x=1 now', 'failed: &x=1 now'],
  ];
  for (const [input, expected] of cases) assert.equal(redact(input), expected, input);
  assert.equal(redact(`in ${join(tmpdir(), 'x')} ${URL_SECRET}`, [tmpdir()]), 'in <temp>/x https://fake.invalid/a(b).zip');
  assert.equal(redact(redact(URL_SECRET)), redact(URL_SECRET), 'redacting twice changes nothing more');
});

// The number of times a channel's text was produced: a channel whose arrangement never ran would prove nothing.
const injections = new Map();
const INJECTED = (f) => { injections.set(f, (injections.get(f) ?? 0) + 1); return `${URL_SECRET} at ${join(f.scratch, 'inner')}`; };
const SEEN = /fake\.invalid\/a\(b\)\.zip at <temp>[\\/]inner/;

// Every scenario puts one secret text into one module's output and says where it must show (redacted).
const CHANNELS = [
  { name: 'download request', argv: ['install', '--client', 'claude-code'], fail: true,
    arrange: (f) => { const good = f.io.fetch; f.io.fetch = async (url, o) => { if (url.includes('/package/')) throw new Error(INJECTED(f)); return good(url, o); }; } },
  { name: 'download address', argv: ['install', '--client', 'claude-code'], fail: true, seen: /403: https:\/\/fake\.invalid\/a\(b\)\.zip$/m,
    arrange: (f) => { const good = f.io.fetch; f.io.fetch = async (url, o) => {
      if (url.endsWith('/latest')) { const data = await (await good(url, o)).json(); data.assets[0].browser_download_url = URL_SECRET; return Response.json(data); }
      if (url === URL_SECRET) return new Response('', { status: 403 });
      return good(url, o); }; } },
  { name: 'registration command', argv: ['install', '--client', 'claude-code'], fail: true,
    arrange: (f) => { f.io.run = async () => { throw new Error(INJECTED(f)); }; } },
  { name: 'role adapter', argv: ['install', '--client', 'claude-code'], verbose: true,
    arrange: (f) => { f.io.loadAdapter = async () => { throw new Error(INJECTED(f)); }; } },
  { name: 'smoke output', argv: ['update'], verbose: true, first: true,
    arrange: (f) => { f.io.smoke = async () => ({ code: 0, records: [{ status: 'pass' }], report: INJECTED(f) }); } },
  { name: 'update daemon stop', argv: ['update'], fail: true, first: true,
    arrange: (f) => { f.io.stopDaemon = async () => { throw new Error(INJECTED(f)); }; } },
  { name: 'uninstall daemon stop', argv: ['uninstall'], fail: true, first: true,
    arrange: (f) => { f.io.stopDaemon = async () => { throw new Error(INJECTED(f)); }; } },
  { name: 'file system', argv: ['install', '--client', 'claude-code'], fail: true,
    arrange: (f) => { f.io.fs = { ...f.io.fs, rename: async () => { throw new Error(INJECTED(f)); }, cp: async () => { throw new Error(INJECTED(f)); } }; } },
  { name: 'policy list', argv: ['install', '--client', 'claude-code'], platform: 'win32', verbose: true,
    arrange: (f) => { f.io.policyExecute = async () => { throw new Error(INJECTED(f)); }; } },
  { name: 'policy change', argv: ['install', '--client', 'claude-code', '--set-execution-policy'], platform: 'win32',
    arrange: (f) => { let calls = 0; f.io.policyExecute = async () => { if (calls++ === 0) return { stdout: 'CurrentUser=Restricted\n' }; throw new Error(INJECTED(f)); }; } },
  { name: 'kit hint and overlap', argv: ['install', '--client', 'claude-code'], verbose: true, kit: 'present',
    arrange: (f) => fs.writeFile(join(f.root, 'config.json'), JSON.stringify({ install: { ...f.io.config, kit: { ...f.io.config.kit, hint: INJECTED(f), overlap: INJECTED(f) } } })) },
  { name: 'kit hint when absent', argv: ['install', '--client', 'claude-code'], kit: 'absent',
    arrange: (f) => fs.writeFile(join(f.root, 'config.json'), JSON.stringify({ install: { ...f.io.config, kit: { ...f.io.config.kit, hint: INJECTED(f) } } })) },
  { name: 'kit version command', argv: ['update', '--check'], kit: 'broken',
    arrange: (f) => { const run = f.io.run; f.io.run = async (input) => { if (input?.command === join(f.bin, 'kit')) throw new Error(INJECTED(f)); return run(input); }; } },
  { name: 'setup question', argv: ['install', '--client', 'claude-code'], tty: true,
    arrange: (f) => { f.io.ask = async () => { throw new Error(INJECTED(f)); }; } },
  { name: 'setup adapters', argv: ['install', '--client', 'claude-code'], tty: true, seen: null,
    arrange: (f) => { f.io.setupAdapters = [{ listModels: async () => { throw new Error(INJECTED(f)); } }]; } },
  // The channels the first sweep missed: the other commands, the other steps, and what a child process or an error cause says.
  { name: 'rollback daemon stop', argv: ['update', '--rollback'], fail: true, first: true, second: true,
    arrange: (f) => { f.io.stopDaemon = async () => { throw new Error(INJECTED(f)); }; } },
  { name: 'rollback file system', argv: ['update', '--rollback'], fail: true, first: true, second: true,
    arrange: (f) => { f.io.fs = { ...f.io.fs, rename: async () => { throw new Error(INJECTED(f)); }, cp: async () => { throw new Error(INJECTED(f)); } }; } },
  { name: 'uninstall file system', argv: ['uninstall'], fail: true, first: true,
    arrange: (f) => { f.io.fs = { ...f.io.fs, rm: async () => { throw new Error(INJECTED(f)); } }; } },
  { name: 'uninstall purge', argv: ['uninstall', '--purge', '--yes'], fail: true, first: true,
    arrange: (f) => { f.io.fs = { ...f.io.fs, rm: async () => { throw new Error(INJECTED(f)); } }; } },
  { name: 'update check', argv: ['update', '--check'], fail: true, first: true,
    arrange: (f) => { const good = f.io.fetch; f.io.fetch = async (url, o) => { if (url.endsWith('/latest')) throw new Error(INJECTED(f)); return good(url, o); }; } },
  { name: 'client menu prompt', argv: ['install'], fail: true, tty: true,
    arrange: (f) => { f.io.read = async () => { throw new Error(INJECTED(f)); }; } },
  { name: 'statusline settings', argv: ['install', '--client', 'claude-code', '--statusline'], seen: null,
    arrange: (f) => { const good = f.io.fs.readFile; f.io.fs = { ...f.io.fs, readFile: async (path, ...rest) => {
      if (String(path).endsWith('settings.json')) throw new Error(INJECTED(f));
      return good(path, ...rest); } }; } },
  { name: 'daemon start', argv: ['update'], first: true, seen: null,
    arrange: (f) => { f.io.startDaemon = async () => { throw new Error(INJECTED(f)); }; } },
  { name: 'autostart', argv: ['install', '--client', 'claude-code', '--autostart'], seen: null,
    arrange: (f) => { f.io.autostart = async () => { throw new Error(INJECTED(f)); }; } },
  { name: 'path probe', argv: ['install', '--client', 'claude-code'], platform: 'win32', verbose: true, seen: null,
    arrange: (f) => { f.io.pathExecute = async () => { throw new Error(INJECTED(f)); }; } },
  { name: 'subprocess stderr', argv: ['install', '--client', 'claude-code'], fail: true, seen: null,
    arrange: (f) => { f.io.run = async () => ({ code: 1, exitCode: 1, stdout: INJECTED(f), stderr: INJECTED(f) }); } },
  { name: 'error cause', argv: ['install', '--client', 'claude-code'], fail: true, seen: null,
    arrange: (f) => { f.io.fetch = async () => { throw new Error('connection failed', { cause: new Error(INJECTED(f)) }); }; } },
  { name: 'file system read', argv: ['update'], fail: true, first: true, seen: null,
    arrange: (f) => { const good = f.io.fs.readFile; f.io.fs = { ...f.io.fs, readFile: async (path, ...rest) => {
      if (String(path).includes('install-') || String(path).endsWith('.json') && String(path).includes('data')) throw new Error(INJECTED(f));
      return good(path, ...rest); } }; } },
  // The standalone commands take their language from the environment (they have no --locale).
  { name: 'standalone setup', argv: ['setup', '--defaults'], environment: true, seen: null,
    arrange: (f) => { f.io.setupAdapters = [{ listModels: async () => { throw new Error(INJECTED(f)); } }]; f.io.writeConfig = async () => { throw new Error(INJECTED(f)); }; } },
];

test('no module prints a secret or the scratch folder, with and without --verbose, in both languages', async (t) => {
  const reached = new Set(), triggered = new Set();
  for (const channel of CHANNELS) {
    for (const locale of LOCALES) {
      for (const verbose of channel.environment ? [false] : [false, true]) {
        const f = await fixture(t, channel.platform ?? 'linux', { tty: Boolean(channel.tty), ask: channel.tty ? async () => 'y' : undefined });
        if (channel.kit) {
          await fs.mkdir(f.bin, { recursive: true });
          if (channel.kit !== 'absent') await fs.writeFile(join(f.bin, 'kit'), '#!/bin/sh\necho 1.0.0\n', { mode: 0o755 });
          if (channel.kit === 'present') { const run = f.io.run; f.io.run = async (input) => (input?.command === join(f.bin, 'kit') ? { code: 0, stdout: 'kit 1.0.0\n' } : run(input)); }
          if (channel.kit === 'broken') {
            assert.equal(await main(['install', '--client', 'claude-code', '--locale', locale], f.io), 0, f.output.join('\n'));
            f.clear();
          }
        }
        if (channel.first) {
          assert.equal(await main(['install', '--client', 'claude-code', '--locale', locale], f.io), 0, f.output.join('\n'));
          f.setVersion('2.0.0');
          if (channel.second) assert.equal(await main(['update', '--locale', locale], f.io), 0, f.output.join('\n'));
          f.clear();
        }
        if (channel.tty) f.io.read = async () => 'n';
        await channel.arrange(f);
        if (channel.environment) f.io.env.OKIT_LANGUAGE = locale;
        await main([...channel.argv, ...(channel.environment ? [] : ['--locale', locale]), ...(verbose ? ['--verbose'] : [])], f.io);
        if ((injections.get(f) ?? 0) > 0) triggered.add(channel.name);
        const text = f.output.join('\n');
        const context = `${channel.name} ${locale}${verbose ? ' --verbose' : ''}\n${text}`;
        assert.doesNotMatch(text, LEAKS, context);
        assert.ok(!text.includes(f.scratch), context);
        const expected = channel.seen === undefined ? SEEN : channel.seen;
        if (expected && (verbose || !channel.verbose)) {
          assert.match(text, expected, `the secret text did not reach the output: ${context}`);
          reached.add(channel.name);
        }
      }
    }
  }
  // Each channel really printed its text in at least one run, so the check above is not empty.
  for (const channel of CHANNELS) if (channel.seen !== null) assert.ok(reached.has(channel.name), `${channel.name} never reached the output`);
  // A channel whose text never shows must at least have produced it (its arrangement ran), or it proves nothing.
  assert.deepEqual(CHANNELS.filter((channel) => channel.seen === null && !triggered.has(channel.name)).map((channel) => channel.name), [], 'channels whose text was never produced');
});

test('every way the presenter prints goes through redact, for any writer', () => {
  const lines = [];
  const hide = ['/tmp/scratch-folder'];
  const text = `${URL_SECRET} /tmp/scratch-folder/x`;
  for (const verbose of [false, true]) {
    const ui = createPresenter({ locale: 'en', verbose, write: (line) => lines.push(line), hide });
    ui.header({ package: text, version: '1', client: text, system: text, arch: text });
    ui.step(1, 1, text).ok(text, [text]);
    ui.step(1, 1, text).fail(text);
    ui.row(text, 'info', text);
    ui.note(text); ui.warn(text); ui.detail(text); ui.explain([text]);
    ui.failure({ step: text, reason: text, next: text }).forEach((line) => lines.push(line));
  }
  const writer = [];
  redactingWriter((line) => writer.push(line), hide)(text);
  lines.push(...writer);
  assert.ok(lines.length > 10);
  assert.ok(lines.some((line) => line.includes('fake.invalid/a(b).zip')), 'the lines carry the address');
  for (const line of lines) assert.doesNotMatch(line.replaceAll('<temp>', ''), /SECRET|scratch-folder|user:/, line);
});

test('a saved language that is not one is refused in English only, unless --locale or OKIT_LANGUAGE names the language of the refusal', async (t) => {
  for (const command of ['install', 'update', 'uninstall']) {
    const f = await fixture(t);
    await fs.writeFile(join(f.root, 'config.json'), JSON.stringify({ install: f.io.config, language: 'xx' }));
    assert.equal(await main([command], f.io), 2);
    assert.deepEqual(f.output, ['Refused: Choose a language: en, pt-BR.', '      Next: check the options and try again'], command);
  }
  const g = await fixture(t);
  await fs.writeFile(join(g.root, 'config.json'), JSON.stringify({ install: g.io.config, language: 'xx' }));
  g.io.env.OKIT_LANGUAGE = 'pt-BR';
  assert.equal(await main(['install', '--client', 'claude-code'], g.io), 2);
  assert.deepEqual(g.output, ['Recusado: Escolha um idioma: en, pt-BR.', '      O que fazer: confira as opções e tente de novo']);
  g.clear();
  assert.equal(await main(['install', '--client', 'claude-code', '--locale', 'en'], g.io), 2);
  assert.equal(g.output[0], 'Refused: Choose a language: en, pt-BR.');
});

test('the kit line of --verbose is in the language of the run, from the probe to the overlap rule', async (t) => {
  for (const [locale, expected, foreign] of [
    ['pt-BR', /> kit: instalado \(.*kit; kit 1\.0\.0\)\. Veja docs\/maintainers\/ARCHITECTURE\.md#kit-and-plugin-overlap-d1 para as regras de sobreposição\.$/, /kit: installed|See docs|for overlap rules/],
    ['en', /> kit: installed \(.*kit; kit 1\.0\.0\)\. See docs\/maintainers\/ARCHITECTURE\.md#kit-and-plugin-overlap-d1 for overlap rules\.$/, /instalado|Veja|sobreposição/],
  ]) {
    for (const argv of [['install', '--client', 'claude-code'], ['update']]) {
      const f = await fixture(t);
      await fs.mkdir(f.bin, { recursive: true });
      const kit = join(f.bin, 'kit');
      await fs.writeFile(kit, '#!/bin/sh\necho 1.0.0\n', { mode: 0o755 });
      const run = f.io.run;
      f.io.run = async (input) => (input?.command === kit ? { code: 0, stdout: 'kit 1.0.0\n' } : run(input));
      if (argv[0] === 'update') {
        assert.equal(await main(['install', '--client', 'claude-code', '--locale', locale], f.io), 0, f.output.join('\n'));
        f.setVersion('2.0.0');
        f.clear();
      }
      assert.equal(await main([...argv, '--locale', locale, '--verbose'], f.io), 0, f.output.join('\n'));
      const line = f.output.find((item) => /> kit: /.test(item));
      assert.match(line ?? '', expected, `${argv[0]} ${locale}\n${f.output.join('\n')}`);
      assert.doesNotMatch(line, foreign);
    }
  }
});

// I6: the language of every run, refusals included, comes from one function. Must pass / must refuse:
// | case | must pass | must refuse |
// | every mix of --locale (none, en, pt-BR, invalid), OKIT_LANGUAGE (none, en, pt-BR, invalid) and a saved language (same) | the first valid one in that order, else English; a refusal in that language | a refusal in another language, or in two |
test('the language of a run, a refusal included, is the first valid of --locale, OKIT_LANGUAGE and the saved language', async (t) => {
  const kinds = [undefined, 'en', 'pt-BR', 'fr'];
  const valid = (value) => value === 'en' || value === 'pt-BR';
  let runs = 0;
  for (const flag of kinds) {
    for (const environment of kinds) {
      for (const saved of kinds) {
        const f = await fixture(t);
        await fs.writeFile(join(f.root, 'config.json'), JSON.stringify({ install: f.io.config, ...(saved ? { language: saved } : {}) }));
        if (environment) f.io.env.OKIT_LANGUAGE = environment;
        const expected = [flag, environment, saved].find(valid) ?? 'en';
        const refused = (flag !== undefined && !valid(flag)) || (saved !== undefined && !valid(saved));
        // `uninstall` with nothing installed always refuses, so its first line always shows the language.
        const code = await main(['uninstall', ...(flag ? ['--locale', flag] : [])], f.io);
        const context = `flag ${flag} environment ${environment} saved ${saved}\n${f.output.join('\n')}`;
        assert.equal(code, 2, context);
        assert.equal(f.output[0], expected === 'en'
          ? (refused ? 'Refused: Choose a language: en, pt-BR.' : 'okit-plugin — Uninstall')
          : (refused ? 'Recusado: Escolha um idioma: en, pt-BR.' : 'okit-plugin — Desinstalação'), context);
        assert.doesNotMatch(f.output.join('\n'), / \/ /, context);
        runs += 1;
      }
    }
  }
  assert.equal(runs, 64);
});

// I5: a reason that holds another reason (the cause of a failure, a path of the reason) is translated whole.
test('a reason inside another reason is translated, not left in English in a pt-BR line', () => {
  const inner = 'Download size limit exceeded';
  const outer = `Invalid --from package: ${inner}`;
  const pt = localizeReason(outer, 'pt-BR');
  assert.notEqual(pt, outer);
  assert.doesNotMatch(pt, /Download size limit|Invalid --from/);
  assert.equal(localizeReason(outer, 'en'), outer);
});

// I5: no line of the output has a sentence of the other language. The sentences are the presenter's own (TEXTS, REASONS).
test('no line of the installer output carries a sentence of the other language, in any command', async (t) => {
  const chunks = (text) => String(text).split(/\{\w+\}|\n|\$\d/).map((part) => part.trim()).filter((part) => part.length >= 12 && /\s/.test(part));
  const corpus = {
    en: [...Object.values(TEXTS).flatMap((entry) => (typeof entry === 'object' && entry.en ? [entry.en] : [])), ...REASONS.map(([, , sample]) => sample)],
    'pt-BR': [...Object.values(TEXTS).flatMap((entry) => (typeof entry === 'object' && entry['pt-BR'] ? [entry['pt-BR']] : [])), ...REASONS.map(([, pt]) => pt)],
  };
  const foreign = {};
  for (const [locale, other] of [['en', 'pt-BR'], ['pt-BR', 'en']]) {
    const own = corpus[locale].join('\n');
    foreign[locale] = [...new Set(corpus[other].flatMap(chunks))].filter((chunk) => !own.includes(chunk));
  }
  assert.ok(foreign.en.length > 100 && foreign['pt-BR'].length > 100, 'the vocabulary of each language is read');
  const scenarios = [
    { name: 'install', argv: ['install', '--client', 'claude-code'] },
    { name: 'install verbose dry run', argv: ['install', '--client', 'claude-code', '--dry-run', '--verbose'] },
    { name: 'install on Windows', argv: ['install', '--client', 'claude-code', '--set-execution-policy'], platform: 'win32' },
    { name: 'install, unknown flag', argv: ['install', '--nope'] },
    { name: 'install, missing value', argv: ['install', '--client'] },
    { name: 'install, no terminal for the menu', argv: ['install'] },
    { name: 'install, wrong client', argv: ['install', '--client', 'nope'] },
    { name: 'update, nothing installed', argv: ['update'] },
    { name: 'update', argv: ['update'], first: true },
    { name: 'update check', argv: ['update', '--check'], first: true },
    { name: 'update rollback', argv: ['update', '--rollback'], first: true, second: true },
    { name: 'update, daemon that does not stop', argv: ['update'], first: true,
      arrange: (f) => { f.io.stopDaemon = async () => { throw new Error('Daemon did not stop before timeout; installation retained'); }; } },
    { name: 'update, download that fails', argv: ['update'], first: true,
      arrange: (f) => { const good = f.io.fetch; f.io.fetch = async (url, o) => { if (url.includes('/package/')) throw new Error('boom'); return good(url, o); }; } },
    { name: 'uninstall', argv: ['uninstall'], first: true },
    { name: 'uninstall purge', argv: ['uninstall', '--purge', '--yes'], first: true },
    { name: 'uninstall, purge without yes', argv: ['uninstall', '--purge'], first: true },
    { name: 'uninstall, nothing installed', argv: ['uninstall'] },
    { name: 'invalid language', argv: ['install', '--client', 'claude-code'], saved: 'xx' },
  ];
  for (const scenario of scenarios) {
    for (const locale of LOCALES) {
      const f = await fixture(t, scenario.platform ?? 'linux');
      if (scenario.saved) await fs.writeFile(join(f.root, 'config.json'), JSON.stringify({ install: f.io.config, language: scenario.saved }));
      if (scenario.first) {
        assert.equal(await main(['install', '--client', 'claude-code', '--locale', locale], f.io), 0, f.output.join('\n'));
        f.setVersion('2.0.0');
        if (scenario.second) assert.equal(await main(['update', '--locale', locale], f.io), 0, f.output.join('\n'));
        f.clear();
      }
      await scenario.arrange?.(f);
      if (scenario.environment || scenario.saved) f.io.env.OKIT_LANGUAGE = locale;
      await main([...scenario.argv, ...(scenario.environment || scenario.saved ? [] : ['--locale', locale]), ...(scenario.argv.includes('install') && !scenario.saved ? [] : [])], f.io);
      assert.ok(f.output.length > 0, `${scenario.name} ${locale}: no output`);
      for (const line of f.output.flatMap((item) => item.split('\n'))) {
        for (const chunk of foreign[locale]) assert.ok(!line.includes(chunk), `${scenario.name} ${locale}: a sentence of the other language in "${line}": "${chunk}"`);
      }
    }
  }
});

// Must pass: remaining percent on a TTY. Must refuse: pipe, NO_COLOR, unrelated rows and following limits.
import { test as quotaColorTest } from 'node:test';
import quotaAssert from 'node:assert/strict';
import { quotaPercent, createPresenter as quotaPresenter, presentDiagnosis as quotaDiagnosis } from '../src/cli-present.js';
quotaColorTest('quota CLI colors exact boundaries only on a TTY and preserves piped and NO_COLOR bytes', () => {
  for (const [value, code] of [[100, 32], [50, 32], [49, 33], [20, 33], [19.9, 31], [0, 31]]) {
    const plain = `Weekly quota is ${value}%; it must be above 15%.`;
    quotaAssert.equal(quotaPercent(plain, { isTTY: true, env: {} }), plain.replace(`${value}%`, `\x1b[${code}m${value}%\x1b[0m`));
    quotaAssert.equal(quotaPercent(plain, { isTTY: false, env: {} }), plain);
    quotaAssert.equal(quotaPercent(plain, { isTTY: true, env: { NO_COLOR: '' } }), plain);
  }
  quotaAssert.equal(quotaPercent('unknown', { isTTY: true, env: {} }), 'unknown');
});
quotaColorTest('doctor renders colored account-policy quota percentages and leaves unrelated percentages plain', () => {
  const render = (options) => {
    const lines = [], ui = quotaPresenter({ write() {}, ...options });
    quotaDiagnosis({ failed: 0, warnings: 0, rows: ['account-policy', 'models'].map(id =>
      ({ id, label: id, status: 'ok', detail: 'Session quota is 12%; it must be above 15%.' })) },
      { ui, command: 'okit-plugin', out: line => lines.push(line) });
    return lines.join('\n');
  };
  const plain = render({ isTTY: false, env: {} });
  quotaAssert.equal(render({ isTTY: true, env: { NO_COLOR: '' } }), plain);
  quotaAssert.equal(render({ isTTY: true, env: {} }), plain.replace('12%', '\x1b[31m12%\x1b[0m'));
});
