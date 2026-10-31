import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { COMMANDS, main } from '../src/cli.js';
import { fixture } from './helpers/install-fixture.js';

// The output of every command of the program, GENERATED from the command table of src/cli.js (`COMMANDS`, read from
// `USAGE_LINES`): a command that enters the table enters this matrix, with nobody writing a list. Each command (a
// group, and each action it names) is run with --help and with an unknown flag, and the program is run with no
// arguments, with --version and with an unknown command, under every source of the language:
//
//   nothing, --locale en|pt-BR, OKIT_LANGUAGE en|pt-BR, a saved language en|pt-BR, a saved language that is not one,
//   and the combinations (the order is flag, then environment, then saved, then English).
//
// The properties, asked of the whole output of each run and not of the call site that wrote it:
//   P1 no line mixes the languages, and the run speaks only the language the sources resolve to;
//   P2 no secret reaches the output: the user, the password, the query and the fragment of an address kept in
//      `install.command`, nor the scratch folder of the run;
//   P3 the exit code is of the class the policy says: help is 0; an unknown flag, command or language, or no
//      arguments, is 2; a language that is not one is 2 whatever the command; a value that is data (`config get <key>`)
//      may be refused as operational (1) but never succeeds;
//   P4 the language is used: the text under en and the text under pt-BR are different, and the exit code does not
//      change with the language.
// A command that cannot be run or cannot be asked about its language is named in EXEMPT, with its reason; a command of
// the table that is neither run nor named there fails the test.

const LANGUAGES = ['en', 'pt-BR'];
const valid = (value) => LANGUAGES.includes(value);
// What each exemption skips: `protocol` is a machine protocol (P1, P3 and P4 do not apply), `bilingual` is a
// subsystem whose sentences are bilingual by design (P1 and P4 do not apply), `skip` is not run at all. P2 holds
// for everything that is run.
//
// `hook` and `statusline-collector` are not in the table any more: they are the entry points the client launches
// (src/launchers.js), internal by design, so the user help does not list them and the matrix does not run them.
// The reason they were exempt is still the reason they are internal: a machine protocol with no text of its own to
// ask in a language, whose exit code is zero whatever the flags and whose output belongs to the client.
const EXEMPT = {
  config: { bilingual: true, why: 'the configuration commands keep their own sentences, written in both languages (src/config.js), outside the installer; the refusals of the installer about the same settings are single-language (R12-2)' },
  quota: { bilingual: true, why: 'the quota table and its refusals are the quota subsystem own, bilingual by design' },
  telemetry: { bilingual: true, why: 'the telemetry status and refusals are the subsystem own, bilingual by design' },
  trajectory: { bilingual: true, why: 'the recordings status and refusals are the subsystem own, bilingual by design' },
};

const SECRET_COMMAND = 'okit-plugin https://matrix-user:matrix-pass@example.invalid/cli?matrix-query=1#matrix-fragment';
const SECRETS = /matrix-user|matrix-pass|matrix-query|matrix-fragment/;

// Words only one language has; the table lines and the usage text have their own (the heading, the default, the notes).
const ENGLISH = /\b(Refused|Failed at|Done\.|Next:|Dry run|Unknown flag|Choose a language|Choose the language once|Could not|Invalid|Unknown|Missing|usage:|default:|names the state root|No client with)/;
const PORTUGUESE = /(Recusado|Falhou em|Pronto\.|Próximo|Simulação|Opção desconhecida|Escolha (um|o) idioma|Não foi possível|Inválid|desconhecid|Falta o|\buso:|padrão:|indica a pasta de estado|Nenhum cliente)/;
const speaks = (text) => [...(ENGLISH.test(text) ? ['en'] : []), ...(PORTUGUESE.test(text) ? ['pt-BR'] : [])];

const SOURCES = [
  { name: 'nothing' },
  { name: '--locale en', flag: 'en' },
  { name: '--locale pt-BR', flag: 'pt-BR' },
  { name: 'OKIT_LANGUAGE=en', env: 'en' },
  { name: 'OKIT_LANGUAGE=pt-BR', env: 'pt-BR' },
  { name: 'saved en', saved: 'en' },
  { name: 'saved pt-BR', saved: 'pt-BR' },
  { name: 'saved en, OKIT_LANGUAGE=pt-BR', saved: 'en', env: 'pt-BR' },
  { name: 'saved pt-BR, OKIT_LANGUAGE=en', saved: 'pt-BR', env: 'en' },
  { name: 'saved pt-BR, OKIT_LANGUAGE=pt-BR, --locale en', saved: 'pt-BR', env: 'pt-BR', flag: 'en' },
  { name: 'saved xx', saved: 'xx' },
  { name: 'saved xx, --locale pt-BR', saved: 'xx', flag: 'pt-BR' },
];

/** The language the sources resolve to, and whether a saved language that is not one was left standing. */
function resolved(source) {
  if (valid(source.flag)) return { language: source.flag };
  if (valid(source.env)) return { language: source.env };
  if (source.saved === undefined) return { language: 'en' };
  return valid(source.saved) ? { language: source.saved } : { language: 'en', invalid: true };
}

// The commands: each group and each action of the table, with the suffix that makes the run harmless (a help request
// or a flag that is not one), and the runs that need no command of the table.
const SUFFIXES = [['--help'], ['--unknown']];
const commandCases = COMMANDS.flatMap((entry) => [[entry.group], ...entry.actions.map((action) => [entry.group, action])]
  .flatMap((words) => SUFFIXES.map((suffix) => ({ group: entry.group, words, suffix, argv: [...words, ...suffix], valued: entry.valued.includes(words[1]) }))));
const GENERAL = [
  { name: 'no arguments', argv: [], expect: 'usage' },
  { name: '--version', argv: ['--version'], expect: 'usage' },
  { name: 'unknown command', argv: ['frobnicate'], expect: 'usage' },
  { name: 'unknown flag', argv: ['--unknown'], expect: 'usage' },
  { name: '--help', argv: ['--help'], expect: 'help' },
  { name: '-h', argv: ['-h'], expect: 'help' },
];
const generalCases = GENERAL.map((entry) => ({ group: undefined, general: entry, argv: entry.argv }));

const results = new Map(); // `${argv}\n${locale flag?}\n${source}` -> { code, text }, for the checks across sources
const exercised = new Set();

async function runOne(f, source, argv) {
  f.clear();
  const stdin = Object.assign(Readable.from(['{}']), { isTTY: false });
  const env = { ...f.io.env, ...(source.env ? { OKIT_LANGUAGE: source.env } : {}) };
  const withFlag = [...argv, ...(source.flag ? ['--locale', source.flag] : [])];
  const code = await main(withFlag, { ...f.io, env, stdin, setupAdapters: [], confirm: async () => false });
  return { code, text: f.output.join('\n') };
}

for (const source of SOURCES) {
  test(`matrix: every command under ${source.name}: P1 one language, P2 no secret, P3 exit class`, async (t) => {
    const f = await fixture(t);
    const config = JSON.stringify({ install: { ...f.io.config, command: SECRET_COMMAND }, ...(source.saved === undefined ? {} : { language: source.saved }) });
    await fs.writeFile(join(f.root, 'config.json'), config);
    const { language, invalid } = resolved(source);
    const failures = [];
    for (const entry of [...commandCases, ...generalCases]) {
      const label = `${[...entry.argv, ...(source.flag ? ['--locale', source.flag] : [])].join(' ') || '(no arguments)'}`;
      const exempt = entry.group ? EXEMPT[entry.group] : undefined;
      if (exempt?.skip) continue;
      let outcome;
      try { outcome = await runOne(f, source, entry.argv); }
      catch (error) { failures.push(`${label}: cannot be run (${error.message}); name its group in EXEMPT with the reason`); continue; }
      const { code, text } = outcome;
      if (entry.group) exercised.add(entry.group);
      results.set(`${entry.argv}\n${source.flag ? 'flag' : 'plain'}\n${source.name}`, { ...outcome, group: entry.group, language, invalid, exempt, general: entry.general });
      if (!text.trim() && !exempt?.protocol) failures.push(`${label}: no output (code ${code})`);
      if (SECRETS.test(text)) failures.push(`${label}: P2 a secret of install.command reached the output:\n${text}`);
      if (text.includes(f.scratch)) failures.push(`${label}: P2 the scratch folder reached the output`);
      if (exempt?.protocol) continue;
      // P3
      const help = entry.general ? entry.general.expect === 'help' : entry.suffix[0] === '--help';
      // A language that is not one is refused (2) by every command that has a language, but the help does not read the
      // saved language, and the subsystems that are bilingual by design have none.
      const classes = entry.general ? (entry.general.expect === 'help' ? [0] : [2])
        : entry.suffix[0] === '--help' ? (entry.valued ? [0, 1, 2] : [0, 2])
          : invalid && !exempt?.bilingual ? [2] : (entry.valued || exempt?.bilingual ? [1, 2] : [2]);
      if (!classes.includes(code)) failures.push(`${label}: P3 exit ${code}, the policy says ${classes.join(' or ')}`);
      if (code === 0 && !help) failures.push(`${label}: P3 succeeded on a flag, a command or a language that is not one`);
      // P1
      if (exempt?.bilingual) continue;
      for (const line of text.split('\n')) {
        if (speaks(line).length > 1 || /\S \/ \S/.test(line)) failures.push(`${label}: P1 a line with both languages: ${line}`);
      }
      const said = speaks(text);
      if (!(said.length === 0 || (said.length === 1 && said[0] === language))) failures.push(`${label}: P1 expected ${language}, the run speaks ${said.join('+')}:\n${text}`);
    }
    assert.deepEqual(failures, []);
  });
}

test('matrix: P4 the language is used (en and pt-BR differ) and does not change the exit class', () => {
  const failures = [];
  const byRun = new Map();
  for (const [key, outcome] of results) {
    if (outcome.exempt?.protocol || outcome.exempt?.bilingual || outcome.invalid) continue;
    const [argv, shape] = key.split('\n');
    const id = `${argv}\n${shape}`;
    if (!byRun.has(id)) byRun.set(id, { en: [], 'pt-BR': [] });
    byRun.get(id)[outcome.language].push(outcome);
  }
  for (const [id, languages] of byRun) {
    const [argv, shape] = id.split('\n');
    const label = `${argv.replaceAll(',', ' ') || '(no arguments)'} [${shape}]`;
    for (const english of languages.en) for (const portuguese of languages['pt-BR']) {
      if (english.text === portuguese.text) failures.push(`${label}: P4 the same text under en and pt-BR:\n${english.text}`);
      if (english.code !== portuguese.code) failures.push(`${label}: P4 exit ${english.code} under en and ${portuguese.code} under pt-BR`);
    }
  }
  assert.ok(byRun.size > 100, 'the matrix ran the commands');
  assert.deepEqual(failures, []);
});

test('matrix: every command of the table is run or named in EXEMPT with its reason, and EXEMPT names only commands that exist', () => {
  const groups = COMMANDS.map((entry) => entry.group);
  for (const group of groups) assert.ok(exercised.has(group) || EXEMPT[group], `${group}: not run by the matrix; name it in EXEMPT with the reason`);
  for (const [group, entry] of Object.entries(EXEMPT)) {
    assert.ok(groups.includes(group), `EXEMPT names ${group}, which is not in the command table`);
    assert.ok(entry.why.length > 30, `${group}: say why`);
  }
  assert.ok(Object.keys(EXEMPT).length <= 6, 'the exempt list is short; do not grow it to make a failure go away');
  // The table is read from the usage text: the groups the program has are in it.
  for (const group of ['install', 'update', 'uninstall', 'setup', 'kit', 'status', 'daemon', 'config']) assert.ok(groups.includes(group), group);
});

// P3 for every kind of setting that is not valid: one class, usage (2), by the one policy (src/install/exit.js). The
// table is every class the setup refuses: a limit, a project of the to-do, a client or a class outside the schema
// (`C9`, `../bad`, a name of the prototype chain, a class that does not exist). `everywhere` says the configuration
// parser itself refuses it, so install, update and uninstall give the same class; the others are refused by the setup
// (a name outside the schema is a setting it would write). A configuration that cannot be read at all is a failure of
// the work (1) in install and in setup alike. One language, whatever the sources.
const INVALID_SETTINGS = [
  { name: 'limits.global 0', config: { limits: { global: 0 } }, everywhere: true },
  { name: 'todo.projects not absolute', config: { todo: { projects: { relative: { enabled: true } } } }, everywhere: true },
  { name: 'todo.projects settings not an object', config: { todo: { projects: { '/abs': 'x' } } }, everywhere: true },
  { name: 'profiles.codex.C9 (a client name outside the schema)', config: { profiles: { codex: { C9: { model: 'x', effort: 'low' } } } } },
  { name: 'profiles with a client named with a space', config: { profiles: { 'bad client': { simple: { model: 'x', effort: 'low' } } } } },
  { name: 'profiles with ../bad', config: { profiles: { '../bad': { simple: { model: 'x', effort: 'low' } } } } },
  { name: 'profiles with __proto__ as a class', raw: '{"profiles":{"claude-code":{"__proto__":{"model":"haiku","effort":"low"}}}}' },
  { name: 'profiles with a class that does not exist', config: { profiles: { 'claude-code': { imaginary: { model: 'haiku', effort: 'low' } } } } },
];
// A model or an effort of a profile that is not one, with a client that offers models (the setup reaches the check).
const INVALID_PROFILE_VALUES = [
  { name: 'profile with an effort that is not one', config: { profiles: { 'claude-code': { simple: { model: 'haiku', effort: 'wrong' } } } } },
  { name: 'profile with an empty effort', config: { profiles: { 'claude-code': { simple: { model: 'haiku', effort: '' } } } } },
  { name: 'profile with a numeric effort', config: { profiles: { 'claude-code': { simple: { model: 'haiku', effort: 3 } } } } },
];
for (const locale of LANGUAGES) {
  for (const invalid of INVALID_PROFILE_VALUES) {
    for (const command of [['setup', '--defaults'], ['setup']]) {
      test(`matrix: P3 ${command.join(' ')} with a ${invalid.name} is usage (2) in ${locale}`, async (t) => {
        const f = await fixture(t);
        f.io.setupAdapters = [{ CLIENT: 'claude-code', async listModels() { return { client: 'claude-code', installed: true, models: ['haiku', 'sonnet', 'opus'], hidden: [], source: 'listing' }; } }];
        const body = JSON.stringify({ install: f.io.config, ...invalid.config, language: locale });
        await fs.writeFile(join(f.root, 'config.json'), body);
        const code = await main(command, { ...f.io, stdin: Object.assign(Readable.from([]), { isTTY: false }) });
        const said = f.output.join('\n');
        assert.equal(code, 2, said);
        assert.ok(said.trim() && speaks(said).every((one) => one === locale), said);
        assert.equal(await fs.readFile(join(f.root, 'config.json'), 'utf8'), body, 'nothing was written');
      });
    }
  }
}

for (const locale of LANGUAGES) {
  for (const invalid of INVALID_SETTINGS) {
    const setups = [['setup', '--defaults'], ['setup']];
    const others = invalid.everywhere ? [['install', '--client', 'claude-code'], ['install', '--client', 'claude-code', '--dry-run'], ['update'], ['uninstall']] : [];
    for (const command of [...others, ...setups]) {
      test(`matrix: P3 ${command.join(' ')} with ${invalid.name} is usage (2) in ${locale}`, async (t) => {
        const f = await fixture(t);
        f.io.setupAdapters = [];
        const text = invalid.raw ?? JSON.stringify({ install: f.io.config, ...invalid.config, language: locale });
        const body = invalid.raw ? text.replace('{', `{"language":"${locale}",`) : text;
        await fs.writeFile(join(f.root, 'config.json'), body);
        const code = await main(command, { ...f.io, stdin: Object.assign(Readable.from([]), { isTTY: false }) });
        const said = f.output.join('\n');
        assert.equal(code, 2, said);
        assert.ok(said.trim() && speaks(said).every((one) => one === locale), said);
        assert.equal(await fs.readFile(join(f.root, 'config.json'), 'utf8'), body, 'nothing was written');
      });
    }
  }
  // The answers of the person at the terminal run out of valid ones (setup.maxAttempts): input the command does not
  // accept, usage (2) in the model phase and in the confirmation phase, with the real stdin reader of the setup.
  for (const phase of ['model', 'confirmation']) {
    test(`matrix: P3 setup whose ${phase} answers are all invalid is usage (2), in ${locale}, and saves nothing`, async (t) => {
      const f = await fixture(t);
      const models = phase === 'model' ? ['other/model'] : ['haiku', 'sonnet', 'opus'];
      f.io.setupAdapters = [{ CLIENT: 'claude-code', async listModels() { return { client: 'claude-code', installed: true, models, hidden: [], source: 'listing' }; } }];
      f.io.stdin = Readable.from(['INVALID_MODEL_OR_ANSWER\nINVALID_MODEL_OR_ANSWER\n']);
      f.io.output = new Writable({ write(_chunk, _encoding, done) { done(); } });
      const body = JSON.stringify({ install: f.io.config, language: locale, setup: { maxAttempts: 2 } });
      await fs.writeFile(join(f.root, 'config.json'), body);
      const code = await main(['setup'], f.io);
      const said = f.output.join('\n');
      assert.equal(code, 2, said);
      assert.ok(said.trim() && speaks(said).every((one) => one === locale), said);
      assert.equal(await fs.readFile(join(f.root, 'config.json'), 'utf8'), body, 'nothing was saved');
    });
  }
  for (const command of [['install', '--client', 'claude-code'], ['setup', '--defaults']]) {
    test(`matrix: P3 ${command[0]} with a configuration that is not JSON is a failure of the work (1) in ${locale}`, async (t) => {
      const f = await fixture(t);
      f.io.setupAdapters = [];
      await fs.writeFile(join(f.root, 'config.json'), '{broken');
      const code = await main([...command, '--locale', locale], f.io);
      assert.equal(code, 1, f.output.join('\n'));
    });
  }
}

// The errors of the release: no published release, or a release without the asset of the platform, are failures of the
// work (exit 1) in every language and on every platform, and say so in one language.
for (const platform of ['linux', 'darwin', 'win32']) {
  for (const locale of LANGUAGES) {
    for (const scenario of ['no release (404 and an empty list)', 'release without the asset']) {
      for (const command of ['install', 'update']) {
        test(`matrix: ${command} with ${scenario} on ${platform} in ${locale} is a failure of the work (exit 1)`, async (t) => {
          const f = await fixture(t, platform);
          if (command === 'update') { await main(['install', '--client', 'claude-code', '--locale', locale], f.io); f.clear(); }
          const empty = scenario.startsWith('no release');
          f.io.fetch = async (url) => (empty ? (url.endsWith('/latest') ? new Response('', { status: 404 }) : Response.json([])) : Response.json({ tag_name: 'v2.0.0', assets: [] }));
          const code = await main([command, '--client', 'claude-code', '--locale', locale], f.io);
          const text = f.output.join('\n');
          assert.equal(code, 1, text);
          assert.deepEqual(speaks(text), [locale], text);
          assert.doesNotMatch(text, /TypeError|undefined|\bat \S+:\d+/, 'a message, never an exception');
          assert.doesNotMatch(text, /usage:|uso:/i, 'a failure of the work is not a usage text');
        });
      }
    }
  }
}
