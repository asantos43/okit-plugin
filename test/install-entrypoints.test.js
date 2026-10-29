import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { main } from '../src/cli.js';
import * as present from '../src/install/present.js';
import { embeddedPresenter, scriptDefaults } from '../src/release/install-scripts.js';
import { fixture } from './helpers/install-fixture.js';

// The invariants of the installer, asked of every ENTRY POINT and not of one call site. An entry point is a way in:
// install, update, uninstall, setup, kit, and the bootstrap script the release carries. A language source is a way
// to say which language: --locale, OKIT_LANGUAGE, the saved language, an invalid saved language, nothing.
//
// Must pass / must refuse:
// | case | must pass | must refuse |
// | every entry point x every language source | one language in the whole output; the refusal of an unknown flag in the resolved language | a line (or a run) with both languages; English for a saved pt-BR |
// | a saved language that is not one | exit 2 in every entry point, in the language the rest gives | exit 1, a bilingual line |
// | two or more clients | a message that belongs to the run (SHA-256 note, PATH check) once, with and without --verbose, en and pt-BR | the same line twice |
// | a dry run | the same numbered steps and labels as the real run (install, update, same-version update, uninstall, bootstrap) | a step more or less, another number |
// | the six facts of the critic's reproduction (I4 to I9) | each one a named test below | -- |

const LOCALES = ['en', 'pt-BR'];
// Words only one language has: the text of a run is in one language when it carries the markers of just that one.
const ENGLISH = /\b(Refused|Failed at|Done\.|Next:|Dry run|Unknown flag|Choose a language|Download and verify|Install files|Register in|Quota recording|Command and PATH|No client with|Could not)\b/;
const PORTUGUESE = /(Recusado|Falhou em|Pronto\.|Próximo|Simulação|Opção desconhecida|Escolha um idioma|Baixar e verificar|Instalar arquivos|Registrar no|Registro de cota|Comando e PATH|Nenhum cliente|Não foi possível)/;
const SOURCES = [
  { name: 'nothing', expected: 'en' },
  { name: '--locale en', args: ['--locale', 'en'], expected: 'en' },
  { name: '--locale pt-BR', args: ['--locale', 'pt-BR'], expected: 'pt-BR' },
  { name: 'OKIT_LANGUAGE=pt-BR', env: 'pt-BR', expected: 'pt-BR' },
  { name: 'saved pt-BR', saved: 'pt-BR', expected: 'pt-BR' },
  { name: 'saved en, OKIT_LANGUAGE=pt-BR', saved: 'en', env: 'pt-BR', expected: 'pt-BR' },
  { name: 'saved pt-BR, --locale en', saved: 'pt-BR', args: ['--locale', 'en'], expected: 'en' },
  { name: 'saved xx', saved: 'xx', invalid: true, expected: 'en' },
  { name: 'saved xx, --locale pt-BR', saved: 'xx', args: ['--locale', 'pt-BR'], invalid: true, expected: 'pt-BR' },
];
// Each entry point: how to run it with a good command and with an unknown flag, and what it needs before.
const ENTRY_POINTS = [
  { name: 'install', good: ['install', '--client', 'claude-code'], prepare: async () => {} },
  { name: 'update', good: ['update'], prepare: async (f) => { await main(['install', '--client', 'claude-code', '--locale', 'en'], f.io); } },
  { name: 'uninstall', good: ['uninstall'], prepare: async (f) => { await main(['install', '--client', 'claude-code', '--locale', 'en'], f.io); } },
  { name: 'setup', good: ['setup', '--defaults'], prepare: async () => {} },
  { name: 'kit', good: ['kit'], prepare: async () => {} },
];

/** The language(s) a text speaks: `['en']`, `['pt-BR']`, both, or none. */
const speaks = (text) => [...(ENGLISH.test(text) ? ['en'] : []), ...(PORTUGUESE.test(text) ? ['pt-BR'] : [])];

/** A fixture ready for one entry point and one language source; returns it with the extra arguments to give. */
async function ready(t, entry, source) {
  const f = await fixture(t);
  await entry.prepare(f);
  f.clear();
  const config = { install: f.io.config, ...(source.saved === undefined ? {} : { language: source.saved }) };
  await fs.writeFile(join(f.root, 'config.json'), JSON.stringify(config));
  f.io.env = { ...f.io.env, ...(source.env ? { OKIT_LANGUAGE: source.env } : {}) };
  f.io.setupAdapters = [];
  return f;
}

for (const entry of ENTRY_POINTS) {
  for (const source of SOURCES) {
    test(`${entry.name} with ${source.name}: one language, the refusal of a flag in the resolved language, exit 2 for an invalid saved language`, async (t) => {
      // An unknown flag is refused (exit 2) in the language the run resolved to, before any work.
      const refused = await ready(t, entry, source);
      const code = await main([...entry.good, '--unknown', ...(source.args ?? [])], refused.io);
      assert.equal(code, 2, refused.output.join('\n'));
      const text = refused.output.join('\n');
      assert.deepEqual(speaks(text), [source.expected], `the refusal is in ${source.expected} only:\n${text}`);
      for (const line of refused.output) assert.ok(speaks(line).length <= 1, `a line with both languages: ${line}`);
      // The resolved language also decides an invalid one: the refusal names the language, never the flag.
      if (source.invalid) assert.match(text, source.expected === 'en' ? /Choose a language/ : /Escolha um idioma/);
      else assert.match(text, source.expected === 'en' ? /Unknown flag: --unknown/ : /Opção desconhecida: --unknown/);

      // A good command: an invalid saved language is exit 2; every other source gives one language and not exit 2.
      const run = await ready(t, entry, source);
      const goodCode = await main([...entry.good, ...(source.args ?? [])], run.io);
      const said = run.output.join('\n');
      if (source.invalid) assert.equal(goodCode, 2, said);
      else assert.notEqual(goodCode, 2, said);
      assert.ok(speaks(said).length <= 1, `both languages in one run:\n${said}`);
      if (!source.invalid && speaks(said).length) assert.deepEqual(speaks(said), [source.expected], said);
      for (const line of run.output) assert.ok(speaks(line).length <= 1, `a line with both languages: ${line}`);
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The bootstrap script: it knows --locale and OKIT_LANGUAGE (the configuration is not its to read), and speaks one.

// `release` is the document the download hands back (a list when there is none), `status` what the HTTP call says.
async function bootstrapRun(t, argv, { env = {}, platform = 'win32', release: given, status = '200', state } = {}) {
  const f = await fixture(t, platform);
  const lines = [];
  const release = given ?? { tag_name: 'v1.0.0', assets: [{ name: f.name('claude-code') }, { name: 'sample-1.0.0-checksums.sha256' }] };
  // The configuration the installed command left (the bootstrap reads the saved language from it).
  if (state !== undefined) await fs.writeFile(join(f.home, '.okwork', 'config.json'), JSON.stringify(state)).catch(async () => {
    await fs.mkdir(join(f.home, '.okwork'), { recursive: true });
    await fs.writeFile(join(f.home, '.okwork', 'config.json'), JSON.stringify(state));
  });
  const runtime = { env, versions: { node: '22' }, platform, arch: 'x64', execPath: 'node', argv: ['node', ...argv, '--dest', f.destination] };
  const modules = {
    'node:fs/promises': { ...fs, readFile: (path, ...rest) => (path.endsWith('release.json') ? Promise.resolve(JSON.stringify(release)) : fs.readFile(path, ...rest)) },
    'node:path': await import('node:path'),
    'node:os': { homedir: () => f.home, tmpdir: () => f.scratch },
    'node:child_process': { spawnSync: (command, args) => ({ status: 0, stdout: command === 'uname' ? (args[0] === '-s' ? 'Linux' : 'x86_64') : status }) },
  };
  const source = await fs.readFile('src/install/bootstrap.js', 'utf8');
  const load = new Function('imports', 'process', 'console', `${source.replaceAll('await import(', 'await imports(')}\nreturn bootstrap;`);
  let error = null;
  try { await load(async (name) => modules[name], runtime, { log: (line) => lines.push(line) })(scriptDefaults({ ...f.io.pkg, engines: { node: '>=20' } }, f.io.config), present); }
  catch (caught) { error = caught; }
  return { f, lines, error };
}

for (const source of [SOURCES[0], SOURCES[1], SOURCES[2], SOURCES[3]]) {
  test(`bootstrap with ${source.name}: the dry run and the refusal of a flag speak one language`, async (t) => {
    const env = source.env ? { OKIT_LANGUAGE: source.env } : {};
    const dry = await bootstrapRun(t, ['install', '--client', 'claude-code', '--dry-run', ...(source.args ?? [])], { env });
    assert.equal(dry.error, null);
    assert.deepEqual(speaks(dry.lines.join('\n')), [source.expected], dry.lines.join('\n'));
    for (const line of dry.lines) assert.ok(speaks(line).length <= 1, line);
    const refused = await bootstrapRun(t, ['install', '--unknown', ...(source.args ?? [])], { env });
    assert.equal(refused.error?.code, 2);
    assert.deepEqual(speaks(refused.error.message), [source.expected], refused.error.message);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// A message of the run (not of one client) is said once, however many clients the run installs or updates.

function repeated(lines) {
  return lines.filter((line, index, all) => line.trim() && all.indexOf(line) !== index);
}

for (const locale of LOCALES) {
  for (const verbose of [false, true]) {
    for (const command of ['install', 'update']) {
      test(`${command} for two clients (${locale}${verbose ? ', --verbose' : ''}): no line of the run is repeated`, async (t) => {
        const f = await fixture(t);
        f.io.detect = async (executable) => ['claude', 'codex'].includes(executable);
        const flags = ['--locale', locale, ...(verbose ? ['--verbose'] : [])];
        if (command === 'update') {
          assert.equal(await main(['install', '--client', 'all', ...flags], f.io), 0, f.output.join('\n'));
          f.setVersion('2.0.0');
          f.clear();
        }
        const code = await main(command === 'install' ? ['install', '--client', 'all', ...flags] : ['update', ...flags], f.io);
        assert.equal(code, 0, f.output.join('\n'));
        assert.deepEqual(repeated(f.output), [], f.output.join('\n'));
        // The note is still said, once: the SHA-256 note belongs to the downloads of the run.
        assert.equal(f.output.filter((line) => /SHA-256/.test(line) && !/\[\d+\/\d+\]/.test(line)).length, 1, f.output.join('\n'));
        if (verbose) assert.equal(f.output.filter((line) => /PATH check|Verificação do PATH/.test(line)).length, 1, f.output.join('\n'));
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A dry run shows the plan of the real run: the same numbered steps with the same labels.

/** `1/5 Download and verify`, for every step line, whatever its status or detail. */
const stepsOf = (lines) => lines.map((line) => /^\[(\d+\/\d+)\] (.*?)\s{2,}\S/.exec(line)).filter(Boolean).map((match) => `${match[1]} ${match[2]}`);

for (const locale of LOCALES) {
  for (const platform of ['linux', 'win32']) {
    test(`install: the dry run has the steps of the real run (${locale}, ${platform})`, async (t) => {
      const f = await fixture(t, platform);
      const argv = ['install', '--client', 'claude-code', '--locale', locale];
      assert.equal(await main([...argv, '--dry-run'], f.io), 0, f.output.join('\n'));
      const dry = stepsOf(f.output);
      f.clear();
      assert.equal(await main(argv, f.io), 0, f.output.join('\n'));
      assert.deepEqual(dry, stepsOf(f.output));
      assert.ok(dry.length >= 4);
    });

    test(`update to a new version: the dry run has the steps of the real run (${locale}, ${platform})`, async (t) => {
      const f = await fixture(t, platform);
      assert.equal(await main(['install', '--client', 'claude-code', '--locale', locale], f.io), 0, f.output.join('\n'));
      f.setVersion('2.0.0');
      f.clear();
      assert.equal(await main(['update', '--locale', locale, '--dry-run'], f.io), 0, f.output.join('\n'));
      const dry = stepsOf(f.output);
      f.clear();
      assert.equal(await main(['update', '--locale', locale], f.io), 0, f.output.join('\n'));
      assert.deepEqual(dry, stepsOf(f.output));
    });

    test(`update of the same version: the dry run has the steps of the real run, the command link included (${locale}, ${platform})`, async (t) => {
      const f = await fixture(t, platform);
      assert.equal(await main(['install', '--client', 'claude-code', '--locale', locale], f.io), 0, f.output.join('\n'));
      f.clear();
      assert.equal(await main(['update', '--locale', locale, '--dry-run'], f.io), 0, f.output.join('\n'));
      const dry = stepsOf(f.output);
      f.clear();
      assert.equal(await main(['update', '--locale', locale], f.io), 0, f.output.join('\n'));
      assert.deepEqual(dry, stepsOf(f.output));
      assert.ok(dry.some((step) => /Command and PATH|Comando e PATH/.test(step)), dry.join('\n'));
    });

    test(`uninstall: the dry run has the steps of the real run (${locale}, ${platform})`, async (t) => {
      const f = await fixture(t, platform);
      assert.equal(await main(['install', '--client', 'claude-code', '--locale', locale], f.io), 0, f.output.join('\n'));
      f.clear();
      assert.equal(await main(['uninstall', '--locale', locale, '--dry-run'], f.io), 0, f.output.join('\n'));
      const dry = stepsOf(f.output);
      f.clear();
      assert.equal(await main(['uninstall', '--locale', locale], f.io), 0, f.output.join('\n'));
      assert.deepEqual(dry, stepsOf(f.output));
      assert.ok(dry.length >= 2);
    });

    test(`bootstrap: the dry run has the steps of the real install (${locale}, ${platform})`, async (t) => {
      const { f, lines, error } = await bootstrapRun(t, ['install', '--client', 'claude-code', '--dry-run', '--locale', locale], { platform });
      assert.equal(error, null);
      const dry = stepsOf(lines);
      f.clear();
      assert.equal(await main(['install', '--client', 'claude-code', '--locale', locale], f.io), 0, f.output.join('\n'));
      assert.deepEqual(dry, stepsOf(f.output));
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The six facts the critic reproduced (I4 to I9), one named test each.

test('I4: the notes of the run are said once in install --client all, in both languages and with --verbose', async (t) => {
  for (const locale of LOCALES) {
    for (const verbose of [false, true]) {
      const f = await fixture(t);
      f.io.detect = async (executable) => ['claude', 'codex'].includes(executable);
      assert.equal(await main(['install', '--client', 'all', '--locale', locale, ...(verbose ? ['--verbose'] : [])], f.io), 0);
      assert.deepEqual(repeated(f.output), []);
    }
  }
});

test('I5: the standalone setup does not mix languages, whatever OKIT_LANGUAGE and the saved language say', async (t) => {
  for (const language of ['en', 'pt-BR']) {
    const f = await fixture(t);
    f.io.env.OKIT_LANGUAGE = 'pt-BR';
    f.io.setupAdapters = [];
    await fs.writeFile(join(f.root, 'config.json'), JSON.stringify({ install: f.io.config, language }));
    assert.equal(await main(['setup', '--defaults'], f.io), 0, f.output.join('\n'));
    assert.deepEqual(speaks(f.output.join('\n')), ['pt-BR']);
    assert.ok(!f.output.join('\n').includes(' / '), f.output.join('\n'));
  }
});

test('I6: install, update and uninstall refuse an unknown flag in the saved language', async (t) => {
  for (const command of ['install', 'update', 'uninstall']) {
    const f = await fixture(t);
    await fs.writeFile(join(f.root, 'config.json'), JSON.stringify({ install: f.io.config, language: 'pt-BR' }));
    assert.equal(await main([command, '--unknown'], f.io), 2);
    assert.match(f.output[0], /^Recusado:/);
  }
});

test('I7: the dry run of the bootstrap and of a same-version update show the steps of the real run', async (t) => {
  const { f, lines } = await bootstrapRun(t, ['install', '--client', 'claude-code', '--dry-run', '--locale', 'en']);
  const dry = stepsOf(lines);
  f.clear();
  await main(['install', '--client', 'claude-code', '--locale', 'en'], f.io);
  assert.equal(dry.length, stepsOf(f.output).length);
  f.clear();
  await main(['update', '--locale', 'en', '--dry-run'], f.io);
  const sameVersion = stepsOf(f.output);
  f.clear();
  await main(['update', '--locale', 'en'], f.io);
  assert.equal(sameVersion.length, stepsOf(f.output).length);
});

test('I8: the presenter embedded in the scripts has no effect of its own and still resolves the language', async () => {
  const reject = new Proxy({}, { get: (_, key) => { throw Error(`unexpected global access: ${String(key)}`); } });
  const embedded = new Function('console', 'process', `${await embeddedPresenter('.')};return present;`)(reject, reject);
  assert.equal(embedded.resolveLocale({ env: { OKIT_LANGUAGE: 'pt-BR' } }).locale, 'pt-BR');
  assert.deepEqual(embedded.planSteps({ quota: true }), present.planSteps({ quota: true }));
});

test('I9: a saved language that is not one is exit 2 in the standalone setup', async (t) => {
  const f = await fixture(t);
  f.io.env.OKIT_LANGUAGE = 'pt-BR';
  await fs.writeFile(join(f.root, 'config.json'), JSON.stringify({ install: f.io.config, language: 'xx' }));
  assert.equal(await main(['setup', '--defaults'], f.io), 2, f.output.join('\n'));
});

// ---------------------------------------------------------------------------------------------------------------
// Round 12: help, status, the wrapper and the exit codes, asked of every language source, not of one example.

const HELP_LINES = [['--help'], ['-h'], ['setup', '--help'], ['install', '--help'], ['update', '-h'], ['uninstall', '--help'],
  ['kit', '--help'], ['status', '--help'], ['daemon', '--help'], ['config', '--help']];
// What only one language's usage text says: its head, the default of --locale, the state-root line and the advice.
const USAGE_WORDS = {
  en: { has: [/^usage: /m, /— default: language/, /OKWORK_HOME names the state root/, /Choose the language once/], not: /\buso:|padrão|OKWORK_HOME indica|Escolha o idioma/ },
  'pt-BR': { has: [/^uso: /m, /— padrão: language/, /OKWORK_HOME indica a pasta de estado/, /Escolha o idioma uma vez/], not: /\busage:|— default:|OKWORK_HOME names|Choose the language once| \/ Escolha/ },
};
const noEntry = { prepare: async () => {} };

for (const source of SOURCES) {
  test(`help of every command with ${source.name}: built after the language is resolved, in that language only`, async (t) => {
    for (const line of HELP_LINES) {
      const f = await ready(t, noEntry, source);
      const code = await main([...line, ...(source.args ?? [])], f.io);
      const text = f.output.join('\n');
      assert.equal(code, 0, `${line.join(' ')}:\n${text}`);
      for (const pattern of USAGE_WORDS[source.expected].has) assert.match(text, pattern, `${line.join(' ')} is not in ${source.expected}:\n${text}`);
      assert.doesNotMatch(text, USAGE_WORDS[source.expected].not, `${line.join(' ')} mixes languages:\n${text}`);
    }
  });
}

test('help with a --locale that is not a language is refused in one language, exit 2', async (t) => {
  for (const [env, expected] of [[undefined, 'en'], ['pt-BR', 'pt-BR']]) {
    const f = await ready(t, noEntry, { saved: undefined, env });
    assert.equal(await main(['setup', '--help', '--locale', 'xx'], f.io), 2, f.output.join('\n'));
    assert.deepEqual(speaks(f.output.join('\n')), [expected], f.output.join('\n'));
  }
});

/** The facts `status` prints that only one language prints, with the one it must not print. */
const STATUS_WORDS = {
  en: { has: [/Open a new terminal and the command will work there/, /kit: absent/, /Setup is not done/], not: /Abra um terminal|kit: ausente|O setup ainda|Nenhum valor|Assinatura/ },
  'pt-BR': { has: [/Abra um terminal novo e o comando funcionará lá/, /kit: ausente/, /O setup ainda não foi feito/], not: /Open a new terminal|kit: absent|Setup is not done|No quota value|Subscription/ },
};

for (const source of SOURCES) {
  test(`status with ${source.name}: one language in every line, the activation hint and the kit line included`, async (t) => {
    const f = await ready(t, noEntry, source);
    f.io.env = { ...f.io.env, PATH: '' };
    const code = await main(['status', ...(source.args ?? [])], f.io);
    const text = f.output.join('\n');
    if (source.invalid) {
      assert.equal(code, 2, text);
      assert.deepEqual(speaks(text), [source.expected], text);
      return;
    }
    assert.equal(code, 0, text);
    for (const pattern of STATUS_WORDS[source.expected].has) assert.match(text, pattern, `status is not in ${source.expected}:\n${text}`);
    assert.doesNotMatch(text, STATUS_WORDS[source.expected].not, `status mixes languages:\n${text}`);
    for (const line of f.output) assert.ok(!/ \/ (Abra|Para usar|Open|To use)/.test(line), `a bilingual line: ${line}`);
  });
}

test('status refuses an unknown flag and an unknown client in the language of the run', async (t) => {
  for (const source of [SOURCES[0], SOURCES[2], SOURCES[4]]) {
    for (const flags of [['--unknown'], ['--client', 'nobody'], ['--client']]) {
      const f = await ready(t, noEntry, source);
      assert.equal(await main(['status', ...flags, ...(source.args ?? [])], f.io), 2, f.output.join('\n'));
      assert.deepEqual(speaks(f.output.join('\n')), [source.expected], f.output.join('\n'));
    }
  }
});

const SECRET_HINT = 'https://audit-user:audit-secret@example.invalid/install?audit-query=yes#audit-fragment';

for (const command of ['status', 'kit']) {
  for (const locale of LOCALES) {
    test(`${command} (${locale}): a kit hint with credentials, a query and a fragment is shown without them`, async (t) => {
      const f = await fixture(t);
      f.io.env = { ...f.io.env, PATH: '' };
      const install = { ...f.io.config, kit: { ...f.io.config.kit, hint: SECRET_HINT } };
      await fs.writeFile(join(f.root, 'config.json'), JSON.stringify({ install, language: locale }));
      await main([command], f.io);
      const text = f.output.join('\n');
      assert.match(text, /example\.invalid\/install/, text);
      assert.doesNotMatch(text, /audit-secret|audit-user|audit-query|audit-fragment/, text);
    });
  }
}

test('status and kit with a bilingual kit hint show the half of the language of the run, redacted', async (t) => {
  for (const locale of LOCALES) {
    const f = await fixture(t);
    const install = { ...f.io.config, kit: { ...f.io.config.kit, hint: 'Read https://a:b@one.invalid/x?q=1#f / Leia https://a:b@two.invalid/y?q=2#g' } };
    await fs.writeFile(join(f.root, 'config.json'), JSON.stringify({ install, language: locale }));
    await main(['status'], f.io);
    const text = f.output.join('\n');
    assert.match(text, locale === 'en' ? /one\.invalid\/x/ : /two\.invalid\/y/, text);
    assert.doesNotMatch(text, locale === 'en' ? /two\.invalid|Leia/ : /one\.invalid|Read https/, text);
    assert.doesNotMatch(text, /a:b@|q=[12]|#[fg]\b/, text);
  }
});

// The wrapper: `sh install.sh <action> <flags>`, on a machine with Node and no network. It decides the language
// before it analyses a flag, so its refusals speak the language of the run too.
function wrapper(args, { state, env = {} } = {}) {
  const home = spawnSync('mktemp', ['-d', join(tmpdir(), 'okit-wrapper-XXXXXX')], { encoding: 'utf8' }).stdout.trim();
  const root = join(home, 'state');
  return fs.mkdir(root).then(async () => {
    if (state !== undefined) await fs.writeFile(join(root, 'config.json'), JSON.stringify(state));
    const run = spawnSync('sh', [new URL('../install.sh', import.meta.url).pathname, ...args], {
      encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, OKWORK_HOME: root, ...env }, timeout: 20000 });
    await fs.rm(home, { recursive: true, force: true });
    return { code: run.status, text: `${run.stdout}${run.stderr}` };
  });
}

test('F4: the wrapper (install.sh) refuses a flag in the saved language, in the language of the run, with exit 2', async () => {
  const cases = [
    { name: 'saved pt-BR', state: { language: 'pt-BR' }, args: ['update', '--unknown'], head: /^Recusado: Opção desconhecida: --unknown\n/ },
    { name: 'saved pt-BR, install', state: { language: 'pt-BR' }, args: ['install', '--client'], head: /^Recusado: Falta o valor de --client\n/ },
    { name: 'nothing saved', args: ['update', '--unknown'], head: /^Refused: Unknown flag: --unknown\n/ },
    { name: 'saved en, OKIT_LANGUAGE=pt-BR', state: { language: 'en' }, env: { OKIT_LANGUAGE: 'pt-BR' }, args: ['update', '--unknown'], head: /^Recusado: / },
    { name: 'saved pt-BR, --locale en', state: { language: 'pt-BR' }, args: ['update', '--unknown', '--locale', 'en'], head: /^Refused: Unknown flag: --unknown\n/ },
    { name: 'saved language that is not one', state: { language: 'xx' }, args: ['update', '--unknown'], head: /^Refused: Choose a language: en, pt-BR\.\n/ },
    { name: 'saved xx, --locale pt-BR', state: { language: 'xx' }, args: ['update', '--unknown', '--locale', 'pt-BR'], head: /^Recusado: Escolha um idioma: en, pt-BR\.\n/ },
  ];
  for (const item of cases) {
    const result = await wrapper(item.args, item);
    assert.equal(result.code, 2, `${item.name}: ${result.text}`);
    assert.match(result.text, item.head, item.name);
  }
});

// A failure of the work (not of the arguments) is exit 1 in the bootstrap, as in the installed command.
const NO_RELEASES = { release: [], status: '404' };
const MISSING_ASSET = { release: { tag_name: 'v1.0.0', assets: [] }, status: '200' };

test('F5: a release that cannot be had is exit 1 (operational) in the bootstrap, a refusal of the arguments is exit 2, a dry run is 0', async (t) => {
  const base = ['install', '--client', 'claude-code', '--dry-run'];
  for (const [name, options] of [['no published releases (404 and an empty list)', NO_RELEASES], ['a missing asset', MISSING_ASSET]]) {
    for (const locale of LOCALES) {
      const { error } = await bootstrapRun(t, [...base, '--locale', locale], options);
      assert.equal(error?.code, 1, `${name} (${locale}): ${error?.message}`);
    }
  }
  const apiError = await bootstrapRun(t, base, { platform: 'linux', status: '500' });
  assert.equal(apiError.error?.code, 1, apiError.error?.message);
  const usage = await bootstrapRun(t, ['install', '--unknown']);
  assert.equal(usage.error?.code, 2);
  const language = await bootstrapRun(t, [...base, '--locale', 'xx']);
  assert.equal(language.error?.code, 2);
  const dry = await bootstrapRun(t, base);
  assert.equal(dry.error, null);
});

test('F5: the installed command and the script agree: exit 0 for success and dry run, 1 for the work that failed, 2 for the arguments', async (t) => {
  const f = await fixture(t);
  assert.equal(await main(['install', '--client', 'claude-code', '--dry-run'], f.io), 0, f.output.join('\n'));
  assert.equal(await main(['install', '--client', 'claude-code'], f.io), 0, f.output.join('\n'));
  assert.equal(await main(['install', '--unknown'], f.io), 2);
  assert.equal(await main(['kit', '--require'], { ...f.io, env: { ...f.io.env, PATH: '' } }), 1);
  const down = await fixture(t);
  down.io.fetch = async () => { throw new Error('network is down'); };
  assert.equal(await main(['install', '--client', 'claude-code'], down.io), 1, down.output.join('\n'));
});
