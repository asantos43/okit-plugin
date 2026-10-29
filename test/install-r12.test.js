import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { CONFIG_MESSAGES, ConfigError } from '../src/profiles.js';
import { exitCodeFor, kindOf, UsageError, LanguageError, OperationalError } from '../src/install/exit.js';
import { localizeReason } from '../src/install/present.js';
import { fixture } from './helpers/install-fixture.js';

// The proofs of the round 13 (the critic's findings R12-1 to R12-4). R12-4 (the shell prelude) is in
// test/install-scripts.test.js, next to the scripts it runs; the generated matrix of every command is in
// test/install-matrix.test.js.
//
// Must pass / must refuse:
// | finding | must pass | must refuse |
// | R12-1 | no release, a release without the asset, a network error: exit 1 in install and update; the class is the `kind` | a TypeError decides the exit code; a missing release is a usage error (2) |
// | R12-2 | every refusal of the settings has a code, parameters, and one text per language, shown through one function | a message with both languages; English for a pt-BR run |
// | R12-3 | the usage text goes through the door that redacts, whatever raises it | a credential, a query or a fragment of install.command in `--version`, no arguments, an unknown command |

const LANGUAGES = ['en', 'pt-BR'];
// What only Portuguese has (an accent, or a word) and what only English has, in the refusals of the settings.
const PORTUGUESE = /[áàâãéêíóôõúç]|\b(deve|pastas|um só)\b/i;
const ENGLISH = /\b(Refused|Invalid|must be|Choose|Use a|object|non-empty|absolute|boolean|one character|text)\b/;

test('R12-1: the class of an error is its kind, never its type or its text', () => {
  // An error that says nothing is a failure of the work, whatever its type: a TypeError from a bug is not a usage error.
  for (const error of [new Error('x'), new TypeError('x'), new RangeError('x'), Object.assign(new TypeError('x'), { kind: 'weird' }),
    Object.assign(new Error('x'), { kind: 'operational' }), null, undefined, 'text', { message: 'Unknown flag: --x' }]) {
    assert.equal(kindOf(error), 'operational', String(error));
    assert.equal(exitCodeFor(kindOf(error)), 1, String(error));
  }
  // Only a kind that says usage or language is a refusal.
  assert.equal(exitCodeFor(kindOf(new UsageError('x'))), 2);
  assert.equal(exitCodeFor(kindOf(new LanguageError('x'))), 2);
  assert.equal(exitCodeFor(kindOf(Object.assign(new Error('x'), { kind: 'usage' }))), 2);
  assert.equal(exitCodeFor(kindOf(new OperationalError('x'))), 1);
  assert.equal(exitCodeFor(kindOf(new ConfigError('limitsObject'))), 2);
  assert.equal(exitCodeFor(kindOf(new ConfigError('language', { languages: 'en, pt-BR' }))), 2);
});

for (const platform of ['linux', 'darwin', 'win32']) {
  for (const locale of LANGUAGES) {
    for (const command of ['install', 'update']) {
      test(`R12-1: ${command} on ${platform} in ${locale}: no release, a release without the asset and a network error are failures of the work (exit 1)`, async (t) => {
        const scenarios = {
          'no release': (url) => (url.endsWith('/latest') ? new Response('', { status: 404 }) : Response.json([])),
          'no asset': () => Response.json({ tag_name: 'v2.0.0', assets: [] }),
          'network error (a TypeError of fetch)': () => { throw new TypeError('fetch failed'); },
        };
        for (const [scenario, answer] of Object.entries(scenarios)) {
          const f = await fixture(t, platform);
          if (command === 'update') { await main(['install', '--client', 'claude-code', '--locale', locale], f.io); f.clear(); }
          f.io.fetch = async (url) => answer(url);
          const code = await main([command, '--client', 'claude-code', '--locale', locale], f.io);
          assert.equal(code, 1, `${scenario}:\n${f.output.join('\n')}`);
          assert.doesNotMatch(f.output.join('\n'), /usage:|uso:/i, `${scenario}: a failure of the work is not a usage text`);
        }
      });
    }
  }
}

test('R12-2: every refusal of the settings has a code, its parameters and one text per language', () => {
  const codes = Object.keys(CONFIG_MESSAGES);
  assert.ok(codes.length >= 20, 'the catalog is the one place of the refusals');
  for (const code of codes) {
    const entry = CONFIG_MESSAGES[code];
    const params = Object.fromEntries([...entry.en.matchAll(/\{(\w+)\}/g)].map(([, name]) => [name, `<${name}>`]));
    assert.deepEqual([...entry['pt-BR'].matchAll(/\{(\w+)\}/g)].map(([, name]) => name).sort(), Object.keys(params).sort(), `${code}: the same parameters in both languages`);
    const error = new ConfigError(code, params);
    assert.equal(error.reasonCode, code);
    assert.deepEqual(error.params, params);
    assert.equal(error.kind, entry.kind ?? 'usage');
    assert.equal(exitCodeFor(kindOf(error)), 2, code);
    for (const language of LANGUAGES) {
      assert.doesNotMatch(entry[language], / \/ /, `${code}: ${language} says one language only`);
    }
    assert.notEqual(entry.en, entry['pt-BR'], code);
    assert.doesNotMatch(entry.en, PORTUGUESE, `${code}: the English text has Portuguese in it`);
    assert.doesNotMatch(entry['pt-BR'], ENGLISH, `${code}: the Portuguese text has English in it`);
    assert.equal(localizeReason(error.message, 'en'), error.message, `${code}: English is as raised`);
    // The one function that shows it: the Portuguese text, with the parameters in place, and nothing of the English.
    const shown = localizeReason(error.message, 'pt-BR');
    assert.equal(shown, entry['pt-BR'].replace(/\{(\w+)\}/g, (_, name) => params[name]), `${code}: localizeReason gives the pt-BR text`);
    assert.notEqual(shown, error.message, code);
  }
});

const INVALID_SETTINGS = [
  { statuslineRegistration: { settingsFile: '../invalid' } },
  { statuslineRegistration: { shell: { linux: [] } } },
  { install: { kit: { require: 'yes' } } },
  { limits: { global: 0 } },
  { todo: { projects: [] } },
];
test('R12-2: a setting that is not valid is refused in the one language of the run, with exit 2, by every entry point', async (t) => {
  const failures = [];
  for (const changed of INVALID_SETTINGS) {
    for (const locale of LANGUAGES) {
      for (const command of ['install', 'update', 'uninstall', 'kit', 'status']) {
        const f = await fixture(t);
        await fs.writeFile(join(f.root, 'config.json'), JSON.stringify({ install: f.io.config, ...changed, language: locale }));
        const argv = [command, ...(command === 'install' ? ['--client', 'claude-code', '--dry-run'] : [])];
        const code = await main(argv, f.io);
        const text = f.output.join('\n');
        const label = `${argv.join(' ')} in ${locale} with ${JSON.stringify(changed)}`;
        if (code !== 2) failures.push(`${label}: exit ${code}`);
        if (/ \/ /.test(text)) failures.push(`${label}: both languages in one line:\n${text}`);
        if (locale === 'pt-BR' && ENGLISH.test(text)) failures.push(`${label}: English under pt-BR:\n${text}`);
        if (locale === 'pt-BR' && !PORTUGUESE.test(text)) failures.push(`${label}: not Portuguese under pt-BR:\n${text}`);
        if (locale === 'en' && PORTUGUESE.test(text)) failures.push(`${label}: Portuguese under en:\n${text}`);
        if (/\bundefined\b/.test(text)) failures.push(`${label}: undefined in the text:\n${text}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

const SECRET_COMMAND = 'okit-plugin https://audit-user:audit-secret@example.invalid/cli?audit-query=yes#audit-fragment';
test('R12-3: the usage text goes through the door that redacts: --version, no arguments, an unknown command, an unknown action', async (t) => {
  for (const locale of LANGUAGES) {
    for (const argv of [[], ['--version'], ['unknown'], ['daemon', 'nobody'], ['quota', 'show', 'nobody', 'x'], ['--help']]) {
      const f = await fixture(t);
      await fs.writeFile(join(f.root, 'config.json'), JSON.stringify({ install: { ...f.io.config, command: SECRET_COMMAND }, language: locale }));
      const code = await main(argv, f.io);
      const text = f.output.join('\n');
      const label = `${argv.join(' ') || '(no arguments)'} in ${locale}`;
      assert.doesNotMatch(text, /audit-user|audit-secret|audit-query|audit-fragment/, `${label}: a credential, the query or the fragment reached the output`);
      assert.equal(code, argv[0] === '--help' ? 0 : 2, label);
      assert.match(text, locale === 'pt-BR' ? /uso:/ : /usage:/, `${label}: the usage text is still shown, in the language of the run`);
    }
  }
});

test('R12-3: no usage text is written outside the door: ctx.unknown prints through err, and cli.js keeps no list of protected groups', async () => {
  const source = await fs.readFile('src/cli.js', 'utf8');
  const unknown = /unknown\(\) \{([\s\S]*?)\n    \},/.exec(source)?.[1] ?? '';
  assert.match(unknown, /\berr\(usageOf\(/, 'the usage text is written by err, the door');
  assert.doesNotMatch(unknown, /io\.stderr|io\.stdout|process\.std/, 'no raw writer in ctx.unknown');
  assert.doesNotMatch(source, /PROTECTED|REDACTED_GROUPS|SAFE_GROUPS|DOOR_GROUPS/, 'the door is for every command, not for a list of them');
  assert.match(source, /const door = \(write\) => redactingWriter\(write, hidden\)/);
});
