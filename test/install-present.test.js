import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { createPresenter, finishLink, headerValues, pick, redact, redactingWriter, REASONS, TEXTS, localizeReason } from '../src/install/present.js';
import { EXCLUSIVE_FLAGS, ALLOWED_FLAGS } from '../src/install/index.js';

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

import { fixture, SYSTEM, FORMAT } from './helpers/install-fixture.js';

const LABEL = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };
const PLATFORMS = ['linux', 'darwin', 'win32'];
const LOCALES = ['en', 'pt-BR'];

const HINT = (bin) => `$env:Path = '${bin}' + ';' + $env:Path`;

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
        ? /Command and PATH\s+failed\s+The existing command .* is not the plugin command\. Rename or remove it/
        : /Comando e PATH\s+falhou\s+O comando existente .* não é o comando do plugin\. Renomeie ou remova/);
      assert.match(text, /install\.linkDirectory/);
      assert.doesNotMatch(text, /Done\. Next:|Pronto\. Próximo:/);
    }
  }
});

/** The install of Claude Code as the installer prints it. */
function installLines(locale, platform) {
  const windows = platform === 'win32';
  // the checks that ran: version, the command in each shell found, the written status bar and its reading, the hook (not on Windows)
  const checks = windows ? 4 : 6;
  const asset = `sample-1.0.0-claude-code-${SYSTEM[platform]}-x64.${FORMAT[platform]}`;
  const system = LABEL[platform];
  if (locale === 'en') {
    return [
      `okit-plugin 1.0.0 for Claude Code (${system} x64)`,
      `[1/5] Download and verify  ok  ${asset} (SHA-256 checked)`,
      '  SHA-256 detects altered bytes; it does not authenticate the source.',
      '[2/5] Install files  ok  <data>/1.0.0-claude-code',
      '[3/5] Register in Claude Code  ok  marketplace and plugin',
      `[4/5] Command and PATH  ok  okit-plugin  (${windows ? 'added to your user PATH' : 'already on your PATH'})`,
      '[5/5] Quota recording  skipped  off. To turn it on: okit-plugin install --client claude-code --statusline',
      `  Self-check (Claude Code)  ok  ${checks} checks passed`,
      ...(windows ? ['  Command (git-bash)  skipped  git-bash is not installed'] : []),
      '  Models  -  not set yet. Run: okit-plugin setup',
      '  Kit (optional)  -  not found. Needed only for the orchestration workflow: INSTALL.md#orchestration-kit',
      windows ? `Done. Next: 1. open a new terminal  2. in this terminal instead: ${HINT('<bin>')}  3. restart Claude Code  4. run: okit-plugin status`
        : 'Done. Next: 1. open a new terminal  2. restart Claude Code  3. run: okit-plugin status',
    ];
  }
  return [
    `okit-plugin 1.0.0 para Claude Code (${system} x64)`,
    `[1/5] Baixar e verificar  ok  ${asset} (SHA-256 conferido)`,
    '  O SHA-256 detecta bytes alterados; não autentica a origem.',
    '[2/5] Instalar arquivos  ok  <data>/1.0.0-claude-code',
    '[3/5] Registrar no Claude Code  ok  marketplace e plugin',
    `[4/5] Comando e PATH  ok  okit-plugin  (${windows ? 'adicionado ao PATH do seu usuário' : 'já está no seu PATH'})`,
    '[5/5] Registro de cota  pulado  desligado. Para ligar: okit-plugin install --client claude-code --statusline',
    `  Autoverificação (Claude Code)  ok  ${checks} verificações passaram`,
    ...(windows ? ['  Comando (git-bash)  pulado  git-bash não está instalado'] : []),
    '  Modelos  -  ainda não definidos. Rode: okit-plugin setup',
    '  Kit (opcional)  -  não encontrado. Só é necessário para o fluxo de orquestração: INSTALL.pt-BR.md#kit-de-orquestração',
    windows ? `Pronto. Próximo: 1. abra um terminal novo  2. neste terminal, rode antes: ${HINT('<bin>')}  3. reinicie o Claude Code  4. rode: okit-plugin status`
      : 'Pronto. Próximo: 1. abra um terminal novo  2. reinicie o Claude Code  3. rode: okit-plugin status',
  ];
}

/** The update to 2.0.0; the backup line carries a folder, so it is matched, not spelled. */
function updateLines(locale, platform) {
  const windows = platform === 'win32';
  // the checks that ran: version, the command in each shell found, the written status bar and its reading, the hook (not on Windows)
  const checks = windows ? 4 : 6;
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
      `[5/7] Command and PATH  ok  okit-plugin  (${windows ? 'added to your user PATH' : 'already on your PATH'})`,
      '[6/7] Quota recording  skipped  off. To turn it on: okit-plugin install --client claude-code --statusline',
      '[7/7] Check the install  ok',
      `  Self-check (Claude Code)  ok  ${checks} checks passed`,
      ...(windows ? ['  Command (git-bash)  skipped  git-bash is not installed'] : []),
      '  Models  -  not set yet. Run: okit-plugin setup',
      '  Kit (optional)  -  not found. Needed only for the orchestration workflow: INSTALL.md#orchestration-kit',
      new RegExp(`^Done\\. Next: 1\\. open a new terminal {2}${windows ? `2\\. in this terminal instead: ${escape(HINT('<bin>'))} {2}3\\. restart Claude Code {2}4` : '2\\. restart Claude Code {2}3'}\\. run: okit-plugin status$`),
    ];
  }
  return [
    `okit-plugin 2.0.0 para Claude Code (${system} x64)`,
    `[1/7] Baixar e verificar  ok  ${asset} (SHA-256 conferido)`,
    '  O SHA-256 detecta bytes alterados; não autentica a origem.',
    /^\[2\/7\] Copiar seus arquivos {2}ok( {2}.+)?$/,
    '[3/7] Instalar arquivos  ok  <data>/2.0.0-claude-code',
    '[4/7] Registrar no Claude Code  ok  marketplace e plugin',
    `[5/7] Comando e PATH  ok  okit-plugin  (${windows ? 'adicionado ao PATH do seu usuário' : 'já está no seu PATH'})`,
    '[6/7] Registro de cota  pulado  desligado. Para ligar: okit-plugin install --client claude-code --statusline',
    '[7/7] Verificar a instalação  ok',
    `  Autoverificação (Claude Code)  ok  ${checks} verificações passaram`,
    ...(windows ? ['  Comando (git-bash)  pulado  git-bash não está instalado'] : []),
    '  Modelos  -  ainda não definidos. Rode: okit-plugin setup',
    '  Kit (opcional)  -  não encontrado. Só é necessário para o fluxo de orquestração: INSTALL.pt-BR.md#kit-de-orquestração',
    new RegExp(`^Pronto\\. Próximo: 1\\. abra um terminal novo {2}${windows ? `2\\. neste terminal, rode antes: ${escape(HINT('<bin>'))} {2}3\\. reinicie o Claude Code {2}4` : '2\\. reinicie o Claude Code {2}3'}\\. rode: okit-plugin status$`),
  ];
}

function uninstallLines(locale, platform) {
  const system = LABEL[platform];
  if (locale === 'en') {
    return [
      `okit-plugin 1.0.0 for Claude Code (${system} x64)`,
      '[1/3] Unregister from Claude Code  ok  marketplace and plugin removed',
      '[2/3] Remove command and PATH  ok  okit-plugin removed',
      '[3/3] Remove files  ok  <data>/1.0.0-claude-code (your settings are kept)',
    ];
  }
  return [
    `okit-plugin 1.0.0 para Claude Code (${system} x64)`,
    '[1/3] Remover registro do Claude Code  ok  marketplace e plugin removidos',
    '[2/3] Remover comando e PATH  ok  okit-plugin removido',
    '[3/3] Remover arquivos  ok  <data>/1.0.0-claude-code (seus ajustes foram mantidos)',
  ];
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
  assert.equal(new Set(columns).size, 1, steps.join('\n'));
}

for (const locale of LOCALES) {
  for (const platform of PLATFORMS) {
    test(`golden: install and uninstall in ${locale} on ${platform}`, async (t) => {
      const f = await fixture(t, platform);
      assert.equal(await main(['install', '--client', 'claude-code', '--locale', locale], f.io), 0, f.output.join('\n'));
      assertStatusColumns(f.output);
      assertLines(f.lines(), installLines(locale, platform), `install ${locale} ${platform}`);

      f.clear();
      assert.equal(await main(['uninstall', '--locale', locale], f.io), 0, f.output.join('\n'));
      assertStatusColumns(f.output);
      assertLines(f.lines(), uninstallLines(locale, platform), `uninstall ${locale} ${platform}`);
    });

    test(`golden: update in ${locale} on ${platform}`, async (t) => {
      const f = await fixture(t, platform);
      assert.equal(await main(['install', '--client', 'claude-code', '--locale', locale], f.io), 0, f.output.join('\n'));
      f.clear();
      f.setVersion('2.0.0');
      assert.equal(await main(['update', '--locale', locale], f.io), 0, f.output.join('\n'));
      assertStatusColumns(f.output);
      assertLines(f.lines(), updateLines(locale, platform), `update ${locale} ${platform}`);
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
    shapes.push(f.lines().filter((line) => !/^  Command \(/.test(line)).map((line) => (/^(\[\d\/\d\] |  )[^ ]/.test(line) ? line.split('  ').slice(0, 2).join('|') : line.slice(0, 5))).map((line, index) => (index === 0 ? 'header' : line)));
  }
  // Windows adds the PATH hint to the closing line only; the lines before it are the same.
  assert.deepEqual(shapes[1].slice(0, -1).slice(1), shapes[0].slice(0, -1).slice(1));
  assert.deepEqual(shapes[2].slice(0, -1).slice(1), shapes[0].slice(0, -1).slice(1));
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
        assert.equal(new Set(lines).size, lines.length, `a line repeats in ${context}`);
        const text = lines.join('\n');
        assert.equal(text.match(/does not authenticate|não autentica/g)?.length, 1, `the SHA-256 note appears once in ${context}`);
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
  assert.match(f.output[0], / para Claude Code /);
  assert.ok(!f.output.some((line) => /Download and verify|Next:/.test(line)));
  f.clear();
  assert.equal(await main(['update', '--locale', 'en'], f.io), 0);
  assert.ok(f.output.some((line) => /Up to date/.test(line)), f.output.join('\n'));
  assert.ok(!f.output.some((line) => /Em dia|Pronto/.test(line)));
});

test('errors name the step, the reason and what to do next, in the chosen language', async (t) => {
  for (const [locale, head, next] of [['en', /^Failed at Download and verify: /, /Next: fix the cause/], ['pt-BR', /^Falhou em Baixar e verificar: /, /O que fazer: corrija a causa/]]) {
    const f = await fixture(t, 'linux');
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

test('a prompt is the explanation first and one question last, and y or s are accepted at the models question', async (t) => {
  for (const [locale, answer] of [['en', 'y'], ['en', 's'], ['pt-BR', 'y'], ['pt-BR', 's']]) {
    const questions = [];
    const f = await fixture(t, 'linux', { tty: true, ask: async (question) => { questions.push(question); return answer; } });
    f.io.read = async () => 'n';
    assert.equal(await main(['install', '--client', 'codex', '--locale', locale], f.io), 0, f.output.join('\n'));
    const asked = questions.filter((question) => /agora\? \[S\/n\] $|now\? \[Y\/n\] $/.test(question));
    assert.equal(asked.length, 1, questions.join(' / '));
    assert.ok(!/\n/.test(asked[0]));
    const explain = f.output.findIndex((line) => /Setup chooses the models|O setup escolhe os modelos/.test(line));
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
    arrange: (f) => { delete f.io.smoke; f.io.run = async () => ({ code: 0, stdout: INJECTED(f), stderr: INJECTED(f) }); } },
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
  { name: 'standalone kit', argv: ['kit'], environment: true, kit: 'absent',
    arrange: (f) => fs.writeFile(join(f.root, 'config.json'), JSON.stringify({ install: { ...f.io.config, kit: { ...f.io.config.kit, hint: INJECTED(f) } } })) },
  { name: 'standalone kit broken', argv: ['kit'], environment: true, kit: 'broken-now', seen: null,
    arrange: (f) => { const run = f.io.run; f.io.run = async (input) => { if (input?.command === join(f.bin, 'kit')) throw new Error(INJECTED(f)); return run(input); }; } },
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
          ? `Refused: ${refused ? 'Choose a language: en, pt-BR.' : 'No installation record found'}`
          : `Recusado: ${refused ? 'Escolha um idioma: en, pt-BR.' : 'Nenhuma instalação encontrada'}`, context);
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
    { name: 'standalone kit', argv: ['kit'], environment: true },
    { name: 'standalone kit, invalid saved language', argv: ['kit'], environment: true, saved: 'xx' },
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
