import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { existsSync, mkdtempSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { main } from '../src/cli.js';
import { CONFIG_SCHEMA, installNodes } from '../src/config-schema.js';
import { installConfig } from '../src/install/config.js';
import { kindOf } from '../src/install/exit.js';
import { latestRelease, request } from '../src/install/release.js';
import { fixture } from './helpers/install-fixture.js';
import {
  COMMAND_BASES, CONFIG_NUMBERS, ENV_DOMAINS, ENV_OTHER, FILE_RULES, FLAG_TABLE, INSTALL_NUMBERS, OUT_OF_SCOPE_FLAGS, POSITIONAL_NUMBERS,
  OWN_VALIDATORS, READ_POINTS, TOP_LEVEL_KEYS, configKeysRead, configReadsOutsideTheInventory, envKeysOfTheScripts, envLiterals, fileReads, flagLiterals, installFlags,
  knownTopLevelKeys, ownValidators, readsIn, staleReadRows, unclassifiedReads,
} from './helpers/input-inventory.js';

// Invariant I9, closed over an inventory (test/helpers/input-inventory.js): every configuration key the code reads, every
// flag, every OKIT_* variable and every file read has a row there, and each row is proved below against the real
// commands: a value outside its domain is a refusal of usage (exit 2) in the language of the run, never a TypeError, a
// RangeError or an exit 1; a file that cannot be read is a failure of the work (exit 1). The scanners fail when the
// source reads an input that no row names, so a new input cannot skip this test.

const LOCALES = ['en', 'pt-BR'];
const COMMANDS = [
  ['install', '--client', 'claude-code', '--dry-run'], ['update'], ['uninstall'], ['setup', '--defaults'], ['kit'], ['status'], ['config', 'show'],
];
const LEAK = /TypeError|RangeError|SyntaxError|undefined|\bat .*\(.*:\d+:\d+\)|node:internal/;
// An English refusal in a pt-BR run, unless it is one half of a two-language line ("en / pt").
const ENGLISH_REFUSAL = /\b(Refused|Unknown flag|Missing value|Invalid|Cannot|Unsupported|must be|Use )\b/;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const parts = (path) => path.split('.');
const without = (text) => text.split('\n').filter((line) => !line.includes(' / '));

function withValue(path, value) {
  const config = {};
  let at = config;
  for (const part of parts(path).slice(0, -1)) at = at[part] = {};
  at[parts(path).at(-1)] = value;
  return config;
}

test('input inventory: no configuration key is read that the inventory does not name', () => {
  assert.deepEqual(configReadsOutsideTheInventory(), []);
  // The scanner is alive: it sees the keys we know are read.
  const seen = new Set(configKeysRead().map((read) => read.key));
  for (const key of ['limitWarnings', 'profiles', 'language', 'lowQuotaPct']) assert.ok(seen.has(key), key);
  // And it finds a new one: the same text with a key that is nowhere.
  const text = 'const lowQuotaPct = config.lowQuotaPct;\nconst x = config?.brandNewSetting;\nconst y = deps.config?.other;';
  const found = [...text.matchAll(/(?<![.\w$/'"`])(config|userConfig|user)\??\.([A-Za-z_]\w*)(?![\w(])/g)].map((match) => match[2]);
  assert.deepEqual(found, ['lowQuotaPct', 'brandNewSetting']);
});

test('input inventory: every top-level key is in the table with a type, and the table has no key the code does not know', () => {
  assert.deepEqual(Object.keys(TOP_LEVEL_KEYS).sort(), [...knownTopLevelKeys()].sort());
  for (const [key, row] of Object.entries(TOP_LEVEL_KEYS)) {
    assert.ok(['object', 'list', 'number', 'choice'].includes(row.type), key);
    assert.ok(row.checkedBy, key);
    if (row.type === 'number' && row.range) assert.ok(row.range[0] < row.range[1], key);
  }
});

const WRONG = {
  object: ['text', 5, true, [], [5]],
  list: ['text', 5, true, {}, [5], [[]], [{}]],
  number: ['text', true, [], {}],
  choice: [5, [], {}, true],
};
test('input inventory: a top-level key of the wrong type is never an exit 1, a TypeError or a mixed-language text, in every command', async (t) => {
  const f = await fixture(t);
  const file = join(f.root, 'config.json');
  let runs = 0;
  for (const [key, row] of Object.entries(TOP_LEVEL_KEYS)) {
    for (const value of WRONG[row.type]) {
      for (const locale of LOCALES) {
        const body = JSON.stringify({ language: locale, ...(key === 'language' ? {} : { install: f.io.config }), [key]: key === 'language' ? value : value });
        for (const command of COMMANDS) {
          await fs.writeFile(file, body);
          f.clear();
          const label = `${locale} ${command[0]} ${key} = ${JSON.stringify(value)}`;
          const code = await main(command, f.io);
          const text = f.output.join('\n');
          runs += 1;
          // The one documented exception: setup reads a wrong shape of `profiles` as an unreadable file.
          const unreadable = command[0] === 'setup' && ['profiles'].includes(key);
          assert.ok(code === 0 || code === 2 || (unreadable && code === 1), `${label}: exit ${code}\n${text}`);
          assert.doesNotMatch(text, LEAK, label);
          // A `language` that is not one is no language: the run is English, so there is nothing to translate.
          if (locale === 'pt-BR' && key !== 'language') assert.deepEqual(without(text).filter((line) => ENGLISH_REFUSAL.test(line)), [], label);
          assert.equal(await fs.readFile(file, 'utf8'), body, label);
        }
      }
    }
  }
  assert.ok(runs > 1500, `${runs} runs`);
});

test('input inventory: limitWarnings that is not a list of text is one refusal naming the key, in every command and language', async (t) => {
  const f = await fixture(t);
  for (const value of [5, 'text', true, {}, [5], [null]]) {
    for (const locale of LOCALES) {
      await fs.writeFile(join(f.root, 'config.json'), JSON.stringify({ language: locale, install: f.io.config, limitWarnings: value }));
      for (const command of COMMANDS.filter((entry) => entry[0] !== 'setup')) {
        f.clear();
        const code = await main(command, f.io);
        const text = f.output.join('\n');
        assert.equal(code, 2, `${locale} ${command[0]} ${JSON.stringify(value)}\n${text}`);
        assert.match(text, locale === 'pt-BR' ? /limitWarnings deve ser uma lista de textos/ : /limitWarnings must be a list of text/);
        assert.doesNotMatch(text, LEAK);
      }
    }
  }
  // The valid forms.
  for (const value of [[], ['a'], null]) {
    await fs.writeFile(join(f.root, 'config.json'), JSON.stringify({ install: f.io.config, limitWarnings: value }));
    f.clear();
    assert.equal(await main(['status'], f.io), 0, JSON.stringify(value));
  }
});

test('input inventory: a number of the installer settings passes at its maximum and minimum, and fails one past each', () => {
  const nodes = installNodes().filter((entry) => entry.node.kind === 'integer').map((entry) => entry.path).sort();
  assert.deepEqual(Object.keys(INSTALL_NUMBERS).sort(), nodes, 'every integer of INSTALL_SCHEMA has its limits in the inventory');
  for (const [path, [min, max]] of Object.entries(INSTALL_NUMBERS)) {
    for (const ok of [min, max]) assert.doesNotThrow(() => installConfig(withValue(path, ok)), `${path} = ${ok}`);
    for (const bad of [min - 1, max + 1]) {
      assert.throws(() => installConfig(withValue(path, bad)), (error) => kindOf(error) === 'usage' && error.message.startsWith(`Invalid install.${path}: `), `${path} = ${bad}`);
    }
  }
});

const concrete = (path) => path.replace('<client>', 'codex').replace('<class>', 'simple');
test('input inventory: a number of `config set` passes at its maximum and minimum, and fails one past each', async (t) => {
  const f = await fixture(t);
  const numbers = CONFIG_SCHEMA.entries.filter((entry) => ['integer', 'number'].includes(entry.type)).map((entry) => entry.path).sort();
  assert.deepEqual(Object.keys(CONFIG_NUMBERS).sort(), numbers, 'every number of CONFIG_SCHEMA has its limits in the inventory');
  const file = join(f.root, 'config.json');
  // Two numbers are bound to each other (codexQuota.tailBytes may not pass maxTailBytes): the other is set first.
  const BOUND = { 'codexQuota.tailBytes': { maxTailBytes: Number.MAX_SAFE_INTEGER }, 'codexQuota.maxTailBytes': { tailBytes: 1 } };
  for (const [path, [type, min, max]] of Object.entries(CONFIG_NUMBERS)) {
    const entry = CONFIG_SCHEMA.entries.find((candidate) => candidate.path === path);
    assert.equal(entry.type, type, path);
    for (const [value, expected] of [[min, 0], [max, 0], [min - 1, 2], [max + 1, 2]]) {
      await fs.writeFile(file, JSON.stringify({ language: 'en', ...(BOUND[path] ? { codexQuota: BOUND[path] } : {}) }));
      f.clear();
      const code = await main(['config', 'set', concrete(path), String(value)], f.io);
      assert.equal(code, expected, `${path} = ${value}\n${f.output.join('\n')}`);
    }
  }
});

test('input inventory: every flag the source parses has a row, and a row names a flag the source parses', () => {
  const table = new Set(FLAG_TABLE.map((row) => row.flag));
  const literals = flagLiterals();
  const unknown = [...literals.keys()].map((flag) => flag.replace(/=$/, '')).filter((flag) => !table.has(flag) && !Object.hasOwn(OUT_OF_SCOPE_FLAGS, flag) && !Object.hasOwn(OUT_OF_SCOPE_FLAGS, `${flag}=`));
  assert.deepEqual(unknown, [], 'a flag that is read and has no row (add it to FLAG_TABLE, or to OUT_OF_SCOPE_FLAGS with the reason)');
  const parsed = new Set([...literals.keys()].map((flag) => flag.replace(/=$/, '')));
  for (const flag of table) assert.ok(parsed.has(flag) || installFlags().has(flag), `${flag} is in the table and nowhere in the source`);
  for (const flag of installFlags()) assert.ok(table.has(flag), `${flag} is parsed by the installer and has no row`);
  for (const row of FLAG_TABLE) for (const command of row.commands) assert.ok(Object.hasOwn(COMMAND_BASES, command), `${row.flag}: ${command}`);
});

function flagCases() {
  const found = [];
  for (const row of FLAG_TABLE) {
    for (const command of row.commands) {
      const base = COMMAND_BASES[command];
      if (row.value === 'none') {
        // A switch takes no value: the `=` form and the same switch with a stray value are not a form of it.
        found.push({ label: `${command} ${row.flag}=1`, argv: [...base, `${row.flag}=1`] });
        continue;
      }
      found.push({ label: `${command} ${row.flag} (no value)`, argv: [...base, row.flag] });
      for (const value of row.invalid) found.push({ label: `${command} ${row.flag} ${JSON.stringify(value)}`, argv: [...base, row.flag, value] });
    }
  }
  for (const command of Object.keys(COMMAND_BASES)) found.push({ label: `${command} --no-such-flag`, argv: [...COMMAND_BASES[command], '--no-such-flag'] });
  for (const { command, invalid } of POSITIONAL_NUMBERS) for (const value of invalid) found.push({ label: `${command.join(' ')} ${JSON.stringify(value)}`, argv: [...command, value] });
  return found;
}

test('input inventory: every invalid value of every flag is exit 2 with a text in the language of the run, never a leak', async (t) => {
  const f = await fixture(t);
  const file = join(f.root, 'config.json');
  // An installation to update and to uninstall: without a record those commands refuse for that reason, whatever the flag.
  assert.equal(await main(['install', '--client', 'claude-code', '--yes'], f.io), 0, f.output.join('\n'));
  const all = flagCases();
  assert.ok(all.length > 150, `${all.length} cases`);
  const failures = [];
  for (const locale of LOCALES) {
    const body = JSON.stringify({ language: locale, install: f.io.config });
    for (const { label, argv } of all) {
      await fs.writeFile(file, body);
      f.clear();
      const code = await main(argv, f.io);
      const text = f.output.join('\n');
      const english = locale === 'pt-BR' ? without(text).filter((line) => ENGLISH_REFUSAL.test(line)) : [];
      if (code !== 2 || LEAK.test(text) || english.length) failures.push(`${locale} ${label}: exit ${code} ${english.join(' | ')} ${text.split('\n')[0]}`);
      assert.equal(await fs.readFile(file, 'utf8'), body, label);
    }
  }
  assert.deepEqual(failures, []);
});

test('input inventory: telemetry export --since that is not a date is a refusal of usage in both languages; a date passes', async (t) => {
  const f = await fixture(t);
  for (const locale of LOCALES) {
    await fs.writeFile(join(f.root, 'config.json'), JSON.stringify({ language: locale, install: f.io.config }));
    f.clear();
    assert.equal(await main(['telemetry', 'export', '--since', 'nope'], f.io), 2);
    assert.match(f.output.join('\n'), locale === 'pt-BR' ? /Use --since com uma data ISO/ : /Use --since with an ISO date/);
  }
  f.clear();
  assert.equal(await main(['telemetry', 'export', '--since', '2026-10-01T00:00:00Z'], f.io), 0, f.output.join('\n'));
});

test('input inventory: --repo takes owner/repository and nothing that walks out of it', async (t) => {
  const f = await fixture(t);
  for (const repo of ['..', '../x', './y', 'a/..', '.']) {
    f.clear();
    assert.equal(await main([...COMMAND_BASES.install, '--repo', repo], f.io), 2, repo);
  }
  f.clear();
  assert.equal(await main([...COMMAND_BASES.install, '--repo', 'example/project'], f.io), 0, f.output.join('\n'));
});

test('input inventory: headers and an address the request cannot use are refused by the schema, and the request does not hide them as a network failure', async (t) => {
  const f = await fixture(t);
  const cases = [
    { headers: { 'X-Test': '\u{1F642}' } }, { headers: { 'X-Test': 'a\nb' } }, { headers: { 'X-Test': 'a\r\nInjected: 1' } },
    { headers: { 'bad name': 'x' } }, { api: 'https://user:password@example.invalid' }, { api: 'https://:secret@example.invalid' },
  ];
  for (const locale of LOCALES) {
    for (const override of cases) {
      await fs.writeFile(join(f.root, 'config.json'), JSON.stringify({ language: locale, install: { ...f.io.config, ...override } }));
      f.clear();
      const code = await main(COMMANDS[0], f.io);
      const text = f.output.join('\n');
      assert.equal(code, 2, `${locale} ${JSON.stringify(override)}\n${text}`);
      assert.doesNotMatch(text, /user:password|:secret@|Injected|\u{1F642}/u, 'a value never shows');
      if (locale === 'pt-BR') assert.doesNotMatch(text, /Invalid|Refused|must be/, text);
    }
  }
  // Past the schema (a configuration built in code): a request that cannot be made from the settings is a refusal of usage,
  // and only a failure of the network is operational.
  const base = installConfig({ repository: 'example/project', api: 'https://fake.invalid' });
  const never = async () => { throw new Error('the network was reached'); };
  await assert.rejects(request('https://fake.invalid/x', { ...base, headers: { 'X-Test': '\u{1F642}' } }, never), (error) => kindOf(error) === 'usage');
  await assert.rejects(latestRelease({ config: { ...base, api: 'not an address' }, release: {}, pkg: {}, repo: 'example/project', client: 'claude-code', system: 'linux', arch: 'x64', fetch: never }), (error) => kindOf(error) === 'usage');
  await assert.rejects(request('https://fake.invalid/x', base, async () => { throw new TypeError('fetch failed'); }), (error) => kindOf(error) === 'operational' && /request failed/.test(error.message));
});

test('input inventory: a client told by an environment variable needs the parts of its folder, and the reverse', async (t) => {
  const f = await fixture(t);
  for (const locale of LOCALES) {
    for (const client of [{ xdgEnv: 'XDG_CONFIG_HOME' }, { xdgParts: ['codex'] }]) {
      const config = { ...f.io.config, clients: { ...f.io.config.clients, codex: { ...f.io.config.clients.codex, ...client } } };
      await fs.writeFile(join(f.root, 'config.json'), JSON.stringify({ language: locale, install: config }));
      f.clear();
      const code = await main(['install', '--client', 'codex', '--dry-run'], { ...f.io, clientRoot: undefined, env: { ...f.io.env, XDG_CONFIG_HOME: join(f.home, 'xdg') } });
      const text = f.output.join('\n');
      assert.equal(code, 2, `${locale} ${JSON.stringify(client)}\n${text}`);
      assert.match(text, locale === 'pt-BR' ? /xdgEnv e xdgParts juntos, ou nenhum dos dois/ : /xdgEnv and xdgParts together, or neither/);
    }
  }
});

test('input inventory: the files that are read follow their rule (unreadable is 1, a wrong type is 2), in both languages', async (t) => {
  const f = await fixture(t);
  const file = join(f.root, 'config.json');
  const unreadable = { 'not JSON': '{bad', empty: '' };
  for (const locale of LOCALES) {
    for (const [name, body] of Object.entries(unreadable)) {
      for (const command of COMMANDS.filter((entry) => entry[0] !== 'config')) {
        await fs.writeFile(file, body);
        f.clear();
        const code = await main([...command, '--locale', locale], f.io);
        assert.equal(code, 1, `${locale} ${command[0]} config.json ${name}\n${f.output.join('\n')}`);
        assert.match(f.output.join('\n'), locale === 'pt-BR' ? /Não foi possível verificar a configuração/ : /Could not check the configuration/);
      }
    }
    // A folder where the file should be.
    await fs.rm(file, { force: true });
    await fs.mkdir(file);
    for (const command of COMMANDS.filter((entry) => entry[0] !== 'config')) {
      f.clear();
      assert.equal(await main([...command, '--locale', locale], f.io), 1, `${locale} ${command[0]} config.json is a folder\n${f.output.join('\n')}`);
    }
    f.clear();
    assert.equal(await main(['config', 'show'], f.io), 1, `config show: config.json is a folder\n${f.output.join('\n')}`);
    await fs.rm(file, { recursive: true });
  }
  // A root that is not an object is an empty configuration (setup alone says the file is unreadable).
  for (const body of ['[]', 'null', '5', '"text"']) {
    await fs.writeFile(file, body);
    for (const command of [COMMANDS[0], ['kit'], ['status'], ['config', 'show']]) {
      f.clear();
      assert.equal(await main(command, f.io), 0, `config.json = ${body}: ${command[0]}\n${f.output.join('\n')}`);
    }
    f.clear();
    assert.equal(await main(['update'], f.io), 2, 'no record: a refusal');
    f.clear();
    assert.equal(await main(['setup', '--defaults'], f.io), 1, `config.json = ${body}: setup`);
  }
  await fs.writeFile(file, JSON.stringify({ install: f.io.config }));
  // The record of an installation: JSON that is not JSON is unreadable (1); the wrong shape is a refusal (2).
  await fs.mkdir(f.destination, { recursive: true });
  for (const locale of LOCALES) {
    for (const [body, expected] of [['{bad', 1], ['[]', 2], ['{"client":5}', 2], ['{"client":"claude-code","path":5}', 2], ['{"client":"claude-code","version":{}}', 2], ['{"client":""}', 2]]) {
      for (const record of ['install.json', 'install.claude-code.json']) {
        await fs.writeFile(join(f.destination, record), body);
        for (const command of [['update'], ['uninstall'], ['status'], COMMANDS[0]]) {
          f.clear();
          const code = await main([...command, '--locale', locale], f.io);
          const text = f.output.join('\n');
          assert.equal(code, expected, `${locale} ${record} ${body} ${command[0]}\n${text}`);
          assert.doesNotMatch(text, LEAK, `${record} ${body}`);
          assert.match(text, locale === 'pt-BR' ? /registro de instalação/i : /installation record/);
        }
        await fs.rm(join(f.destination, record));
      }
    }
  }
  // Every field of the record, also in the record it replaced: a wrong type is a refusal that names the way out.
  const good = { client: 'claude-code', path: f.destination, version: '1.0.0', bin: 'okit-plugin', link: true, linkDirectory: null };
  const wrong = [
    { ...good, linkDirectory: 5 }, { ...good, link: 'yes' }, { ...good, version: 5 }, { ...good, bin: [] }, { ...good, at: {} }, { ...good, sha256: 1 },
    { ...good, statusline: 5 }, { ...good, statusline: { path: 5, backup: 'b', existed: true } }, { ...good, settings: { node: 5 } },
    { ...good, previous: 5 }, { ...good, previous: { version: 5 } }, { ...good, previous: { previous: { linkDirectory: 5 } } },
  ];
  for (const locale of LOCALES) {
    for (const record of wrong) {
      for (const name of ['install.json', 'install.claude-code.json']) {
        await fs.writeFile(join(f.destination, name), JSON.stringify(record));
        for (const command of [['update'], ['uninstall'], ['status'], COMMANDS[0]]) {
          f.clear();
          const code = await main([...command, '--locale', locale], f.io);
          const text = f.output.join('\n');
          assert.equal(code, 2, `${locale} ${name} ${JSON.stringify(record)} ${command[0]}\n${text}`);
          assert.doesNotMatch(text, LEAK);
          assert.match(text, /okit-plugin install/);
          assert.match(text, locale === 'pt-BR' ? /Registro de instalação inválido/ : /Invalid installation record/);
        }
        await fs.rm(join(f.destination, name));
      }
    }
  }
  // The same files of the installer's own state: managed-path.json (the PATH state).
  const stateFile = join(f.destination, f.io.config.path.stateFile);
  for (const locale of LOCALES) {
    for (const [body, expected] of [['{bad', 1], ['[]', 2], ['null', 2], ['{"profiles":5,"windows":null}', 2], ['{"profiles":[],"windows":5}', 2],
      ['{"profiles":[{"path":1,"block":"x"}]}', 2], ['{"profiles":[{"path":"a","block":5}]}', 2], ['{"profiles":[5]}', 2], ['{"profiles":[],"windows":null}', 0]]) {
      await fs.writeFile(stateFile, body);
      const { managePath } = await import('../src/install/link.js');
      let kind = 0;
      await managePath({ fs, bin: join(f.destination, 'bin'), config: f.io.config, env: {}, destination: f.destination, platform: 'linux', noPath: true, locale }, true)
        .catch((error) => { kind = kindOf(error) === 'usage' ? 2 : 1; assert.doesNotMatch(String(error.message), LEAK, `managed-path.json ${body}`); });
      assert.equal(kind, expected, `${locale} managed-path.json ${body}`);
    }
    await fs.rm(stateFile, { force: true });
  }
  // The package of --from: a folder without it, text that is not JSON, or a field of another type is a wrong argument.
  const source = join(f.home, 'external');
  await fs.mkdir(join(source, 'src'), { recursive: true });
  await fs.writeFile(join(source, 'src/cli.js'), '// CLI\n');
  for (const body of ['{bad', '[]', 'null', '{"name":"sample","version":5}']) {
    await fs.writeFile(join(source, 'package.json'), body);
    f.clear();
    assert.equal(await main([...COMMAND_BASES.install, '--from', source], f.io), 2, `package.json ${body}`);
  }
});

test('input inventory: the saved numbers of the telemetry settings follow the schema of `config set`, in every command and language', async (t) => {
  const f = await fixture(t);
  const keys = [['retentionDays', -1], ['retentionDays', 0], ['retentionDays', 1.5], ['maxBytes', -5], ['maxFileBytes', 'big'], ['batchSeconds', 0],
    ['kitTimeoutMs', 0], ['kitTimeoutMs', 2 ** 31], ['rede.timeoutMs', -1], ['rede.timeoutMs', null], ['dir', 5], ['dir', '']];
  for (const locale of LOCALES) {
    for (const [key, value] of keys) {
      await fs.writeFile(join(f.root, 'config.json'), JSON.stringify({ language: locale, telemetry: withValue(key, value) }));
      for (const command of [['telemetry', 'status'], ['telemetry', 'export'], ['telemetry', 'check']]) {
        f.clear();
        const code = await main(command, f.io);
        const text = f.output.join('\n');
        assert.equal(code, 2, `${locale} telemetry.${key}=${JSON.stringify(value)} ${command[1]}\n${text}`);
        assert.doesNotMatch(text, LEAK);
        assert.match(text, new RegExp(`telemetry\\.${escape(key)}`));
      }
    }
  }
  // The same limits as `config set`: one past each is refused, the edge passes.
  await fs.writeFile(join(f.root, 'config.json'), JSON.stringify({ telemetry: { retentionDays: 1, kitTimeoutMs: 1, rede: { timeoutMs: 1 } } }));
  f.clear();
  assert.equal(await main(['telemetry', 'status'], f.io), 0, f.output.join('\n'));
  // The telemetry reader has no validator of its own: the schema is the only one.
  assert.deepEqual(ownValidators().filter((found) => found.file.startsWith('src/telemetry/')), []);
});

test('input inventory: every read of a file in src/ is classified, and every classification matches a read', () => {
  assert.deepEqual(unclassifiedReads(), [], 'a file is read that the inventory does not name: add a row to FILE_RULES (test/helpers/input-inventory.js) and to READ_POINTS');
  assert.deepEqual(staleReadRows(), [], 'a row of READ_POINTS names a read the source no longer has');
  const names = new Set(FILE_RULES.map((rule) => rule.file));
  for (const row of READ_POINTS) {
    assert.ok(Boolean(row.rule) !== Boolean(row.excluded), `${row.file} ${row.arg}: a row has a rule or an exclusion with its reason, not both`);
    if (row.rule) assert.ok(names.has(row.rule), `${row.file}: "${row.rule}" is not a row of FILE_RULES`);
    else assert.ok(row.excluded.length > 20, `${row.file} ${row.arg}: the reason of an exclusion is a sentence`);
  }
  // The scan finds the PATH state by itself: it is not written in the inventory by hand.
  const state = fileReads().filter((found) => found.file === 'src/install/link.js' && found.arg === 'stateFile');
  assert.equal(state.length, 1);
  assert.ok(READ_POINTS.some((row) => row.rule === 'managed-path.json (the PATH state)'));
  // The same scan covers the adapters: the quota file of each client is found by it, and has a rule.
  for (const client of ['claude-code', 'codex', 'opencode']) {
    const quota = fileReads().filter((found) => found.file === `adapters/${client}/index.js` && /\.quota, `\$\{CLIENT\}\.json`\)$/.test(found.arg));
    assert.equal(quota.length, 1, `${client}: the read of quota/${client}.json is found by the scan`);
    assert.ok(READ_POINTS.some((row) => row.rule === 'quota/<client>.json (the manual reading)' && row.file.startsWith('adapters/')));
  }
});

test('input inventory: a new read of a file in src/install/ with no rule is found, and a rule removed from the table is found', () => {
  // Without the row of the PATH state, the scan names the reads of that file (it finds them by itself).
  const rows = READ_POINTS.filter((row) => row.rule !== 'managed-path.json (the PATH state)');
  const without = unclassifiedReads(fileReads(), rows);
  assert.ok(without.length > 0 && without.every((line) => line.startsWith('src/install/link.js:')), without.join('\n'));
  assert.ok(without.some((line) => line.includes('(stateFile)')));
  // A synthetic source with a new reader (any of the calls), and the parse of a read that is the same read.
  const source = [
    "import { readFile } from 'node:fs/promises';",
    "const a = await readFile(join(dir, 'new-state.json'), 'utf8');",
    "const b = JSON.parse(await readFile(other, 'utf8'));",
    "const c = JSON.parse(text);",
    "const d = fs.readFileSync(join(dir, 'x'));",
    "const e = await import(pathToFileURL(join(dir, 'm.js')));",
    "// await readFile(inAComment)",
  ].join('\n');
  const reads = readsIn('src/install/new.js', source);
  assert.deepEqual(reads.map((found) => found.arg), ["join(dir, 'new-state.json')", "other", 'text', "join(dir, 'x')", "pathToFileURL(join(dir, 'm.js'))"]);
  assert.equal(unclassifiedReads(reads).length, reads.length, 'a new file in src/install/ has no row');
});

test('input inventory: only the files named here check a value of the configuration themselves, and the trajectory has no entry in the schema', () => {
  const byFile = {};
  for (const found of ownValidators()) byFile[found.file] = (byFile[found.file] ?? 0) + 1;
  const expected = Object.fromEntries(Object.entries(OWN_VALIDATORS).map(([file, entry]) => [file, entry.count]));
  assert.deepEqual(byFile, expected, 'a check of a configuration value outside the schema: add it to CONFIG_SCHEMA (so `config set` and the reader agree) or name it in OWN_VALIDATORS with its reason');
  // The reason of the trajectory file holds only while `config set` does not take the key.
  assert.equal(CONFIG_SCHEMA.entries.some((entry) => entry.path.startsWith('trajectory.')), false);
  for (const entry of Object.values(OWN_VALIDATORS)) assert.ok(entry.why.length > 20);
});

test('input inventory: every row of the files table names the test that proves it', async () => {
  for (const rule of FILE_RULES) {
    assert.ok([0, 1, 2].includes(rule.unreadable) && [0, 1, 2].includes(rule.wrongType), rule.file);
    assert.ok(rule.proof, `${rule.file}: no proof`);
    const [path, ...fragment] = rule.proof.split('#');
    assert.ok((await fs.readFile(new URL(`../${path}`, import.meta.url), 'utf8')).includes(fragment.join('#')), `${rule.file}: "${rule.proof}" is not in the test`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The variables of the environment: the generated install scripts (the part that runs before any Node code of the
// installer) refuse an OKIT_<KEY> that is not valid with exit 2, in the language of the run, before uname and the network.

test('input inventory: every OKIT_* variable in the source has a row, and the rows are the script settings plus the others', () => {
  const keys = envKeysOfTheScripts().sort();
  assert.deepEqual(Object.keys(ENV_DOMAINS).sort(), keys, 'every setting of the scripts has a domain in the inventory');
  const known = new Set([...keys.map((key) => `OKIT_${key}`), ...Object.keys(ENV_OTHER)]);
  assert.deepEqual([...envLiterals()].filter((name) => !known.has(name)), [], 'an OKIT_ variable that is read and has no row');
});

function script(locale, overrides, { path = process.env.PATH, home, args = ['--client', 'claude-code'] } = {}) {
  const result = spawnSync('/bin/sh', ['install.sh', '--dry-run', '--yes', ...args], {
    encoding: 'utf8', timeout: 20000, input: '',
    env: { PATH: path, HOME: home, OKIT_LANGUAGE: locale, ...overrides },
  });
  return { code: result.status, text: `${result.stdout}${result.stderr}` };
}

test('input inventory: an OKIT_* variable that is not valid is exit 2 in the language of the run, before uname and the network', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'okit-env-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'node'));
  // The script needs `cat` for its own text; `uname` and `curl` are not on this PATH.
  const cat = ['/usr/bin/cat', '/bin/cat'].find((candidate) => existsSync(candidate));
  symlinkSync(cat, join(bin, 'cat'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let runs = 0;
  for (const [key, { domain, invalid }] of Object.entries(ENV_DOMAINS)) {
    // Every spawn costs a shell and a Node: the keys that share a validator (text, one line) are tried with one value.
    for (const [index, value] of (/JSON|number|http|owner/.test(domain) ? invalid : invalid.slice(0, 1)).entries()) {
      for (const locale of index === 0 ? LOCALES : ['en']) {
        // No `uname` on this PATH: a script that asked the system first would stop with exit 1 instead of 2.
        const { code, text } = script(locale, { [`OKIT_${key}`]: value }, { path: bin, home });
        runs += 1;
        const label = `${locale} OKIT_${key}=${JSON.stringify(value)}\n${text}`;
        assert.equal(code, 2, label);
        assert.match(text, locale === 'pt-BR' ? new RegExp(`^Recusado: OKIT_${key} inválida`) : new RegExp(`^Refused: Invalid OKIT_${key}`), label);
        assert.doesNotMatch(text, LEAK, label);
        if (locale === 'pt-BR') assert.doesNotMatch(text, /Refused|Invalid|expected|Next:/, label);
      }
    }
  }
  assert.ok(runs > 30, `${runs} runs`);
  for (const locale of LOCALES) {
    const { code, text } = script(locale, { OKIT_CLIENT: 'no-such-client' }, { home, args: [] });
    assert.equal(code, 2, text);
    assert.match(text, locale === 'pt-BR' ? /Cliente inválido/ : /Invalid client/);
  }
  // A valid value is not refused: the same script goes on to its own work.
  const ok = script('en', { OKIT_MIN_NODE: '18', OKIT_API: 'https://example.invalid/' }, { home });
  assert.doesNotMatch(ok.text, /Invalid OKIT_/);
});

// ---------------------------------------------------------------------------------------------------------------
// R20. The root of config.json in the telemetry commands, and the files that the adapters read.

test('input inventory: a config.json whose root is not an object is an empty configuration for telemetry too, never an exit 1', async (t) => {
  const f = await fixture(t);
  const file = join(f.root, 'config.json');
  for (const body of ['null', '5', '"text"', '[]', '[1]', 'true']) {
    for (const locale of LOCALES) {
      for (const command of [['telemetry', 'status'], ['telemetry', 'check'], ['telemetry', 'export']]) {
        await fs.writeFile(file, body);
        f.clear();
        const code = await main(command, { ...f.io, env: { ...f.io.env, OKIT_LANGUAGE: locale } });
        const text = f.output.join('\n');
        assert.equal(code, 0, `${locale} config.json = ${body}: ${command[1]}\n${text}`);
        assert.doesNotMatch(text, LEAK);
        assert.equal(await fs.readFile(file, 'utf8'), body, 'a read does not change the file');
      }
    }
    // Writing: the root becomes an object that holds the choice.
    for (const [command, check] of [[['telemetry', 'on'], (saved) => saved.telemetry.enabled === true],
      [['telemetry', 'rede', 'on'], (saved) => saved.telemetry.rede.ligado === true], [['telemetry', 'off'], (saved) => saved.telemetry.enabled === false]]) {
      await fs.writeFile(file, body);
      f.clear();
      const code = await main(command, f.io);
      assert.equal(code, 0, `config.json = ${body}: ${command.join(' ')}\n${f.output.join('\n')}`);
      assert.ok(check(JSON.parse(await fs.readFile(file, 'utf8'))), `config.json = ${body}: ${command.join(' ')}`);
    }
  }
});

test('input inventory: the quota file of a client (quota/<client>.json): JSON of another type is no reading (0), a file that is not JSON is unreadable (1)', async (t) => {
  const f = await fixture(t);
  const quota = join(f.root, 'quota');
  await fs.mkdir(quota, { recursive: true });
  const status = async (label, expected) => {
    const io = { ...f.io, quotaCache: new Map() };
    delete io.readQuota;
    f.clear();
    const code = await main(['status', '--locale', 'en'], io);
    const text = f.output.join('\n');
    assert.equal(code, expected, `${label}\n${text}`);
    assert.doesNotMatch(text, LEAK, label);
    return text;
  };
  for (const client of ['claude-code', 'codex', 'opencode']) {
    const file = join(quota, `${client}.json`);
    const row = (text) => text.split('\n').find((line) => line.includes(`| ${client} |`)) ?? '';
    // The file is read: a good value shows (so the cases below are not vacuous).
    await fs.writeFile(file, JSON.stringify({ remainingPct: 73, windowMinutes: 300, source: 'user', recordedAt: new Date(f.io.now()).toISOString() }));
    assert.match(row(await status(`${client} good`, 0)), /73/);
    // Valid JSON of another type: nothing to use, status goes on and says no value is recorded.
    for (const body of ['null', '5', '"x"', '[]', '{"remainingPct":"73"}']) {
      await fs.writeFile(file, body);
      assert.doesNotMatch(row(await status(`${client} ${body}`, 0)), /73/, `${client} ${body}`);
    }
    // A number with a date and a list of the wrong type: the number is used, the rest is ignored.
    await fs.writeFile(file, '{"remainingPct":73,"recordedAt":5,"windows":"x"}');
    await status(`${client} wrong types`, 0);
    // A file that is not JSON, an empty one, a folder where the file should be: it cannot be read (1), as every file.
    for (const body of ['not json', '']) {
      await fs.writeFile(file, body);
      const text = await status(`${client} ${JSON.stringify(body)}`, 1);
      assert.match(text, /Invalid JSON/);
    }
    await fs.rm(file, { force: true });
    await fs.mkdir(file);
    await status(`${client} folder`, 1);
    await fs.rm(file, { recursive: true });
  }
});

test('input inventory: whatever type a field of the quota file holds, status goes on (0) in every client and language, and the odd value is no reading', async (t) => {
  const f = await fixture(t);
  const quota = join(f.root, 'quota');
  await fs.mkdir(quota, { recursive: true });
  const status = async (locale, label) => {
    const io = { ...f.io, quotaCache: new Map() };
    delete io.readQuota;
    f.clear();
    const code = await main(['status', '--locale', locale], io);
    const text = f.output.join('\n');
    assert.equal(code, 0, `${label}\n${text}`);
    assert.doesNotMatch(text, LEAK, label);
    return text;
  };
  // Raw JSON text, so `__proto__` is an own key and 1e999 is read as Infinity.
  const odd = ['{"toString":null}', '{"valueOf":null,"toString":null}', '{"__proto__":{"toString":null}}', '[]', '[{"toString":null}]',
    '{}', 'null', 'true', '1e999', '-1e999', '123456789012345678901234567890', '"x"', '""', '"9999999999999999-01-01"', '0'];
  const fields = [
    (v) => `"recordedAt":${v}`, (v) => `"source":${v}`, (v) => `"windowMinutes":${v}`, (v) => `"windows":${v}`,
    (v) => `"windows":[${v}]`, (v) => `"windows":[{"remainingPct":50,"resetsAt":${v}}]`,
    (v) => `"windows":[{"remainingPct":50,"windowMinutes":${v},"minutes":${v},"resetsInMinutes":${v}}]`,
    (v) => `"remainingPct":${v}`, (v) => `"__proto__":${v}`,
  ];
  for (const client of ['claude-code', 'codex', 'opencode']) {
    const file = join(quota, `${client}.json`);
    for (const field of fields) {
      for (const value of odd) {
        // A fresh value of the field, 73 for the rest, and the automatic source so the windows are read.
        const body = `{"remainingPct":73,"source":"automatic",${field(value)}}`;
        await fs.writeFile(file, body);
        const locale = field(value).startsWith('"recordedAt"') && value.length % 2 ? 'pt-BR' : 'en';
        await status(locale, `${client} ${body}`);
      }
    }
    await fs.rm(file);
  }
  // The case that was found: a recordedAt that is an object with no way to become text, in both languages.
  for (const client of ['claude-code', 'codex', 'opencode']) {
    await fs.writeFile(join(quota, `${client}.json`), '{"remainingPct":73,"recordedAt":{"toString":null}}');
    for (const locale of ['en', 'pt-BR']) {
      const text = await status(locale, `${client} ${locale} recordedAt`);
      assert.match(text.split('\n').find((line) => line.includes(`| ${client} |`)) ?? '', /73/, `${client} ${locale}: the number is still used`);
    }
  }
});

test('input inventory: the readings of the clients\' own sources (Codex sessions, opencode source) never fail status, whatever they hold', async (t) => {
  const f = await fixture(t);
  const sessions = join(f.home, '.codex', 'sessions');
  await fs.mkdir(sessions, { recursive: true });
  const session = join(sessions, 'rollout-1.jsonl');
  const source = join(f.home, 'opencode-source.json');
  await fs.writeFile(join(f.root, 'config.json'), JSON.stringify({ install: f.io.config, opencodeQuota: { sources: { example: { file: source } } } }));
  const status = async (label) => {
    const io = { ...f.io, quotaCache: new Map() };
    delete io.readQuota;
    f.clear();
    const code = await main(['status'], io);
    const text = f.output.join('\n');
    assert.equal(code, 0, `${label}\n${text}`);
    assert.doesNotMatch(text, LEAK, label);
    return text;
  };
  const row = (text, client) => text.split('\n').find((line) => line.includes(`| ${client} |`)) ?? '';
  // Codex: one line per case, the last line of the file is the one that is read.
  const good = JSON.stringify({ timestamp: new Date(f.io.now()).toISOString(), type: 'event_msg',
    payload: { type: 'token_count', rate_limits: { primary: { used_percent: 30, window_minutes: 300, resets_at: f.io.now() / 1000 + 3600 } } } });
  await fs.writeFile(session, `${good}\n`);
  assert.match(row(await status('codex good'), 'codex'), /70/);
  for (const line of ['not json', 'null', '5', '[]', '{"type":"event_msg","payload":5}', '{"timestamp":"x","type":"event_msg","payload":{"type":"token_count"}}']) {
    await fs.writeFile(session, `${line}\n`);
    assert.doesNotMatch(row(await status(`codex ${line}`), 'codex'), /70/, line);
  }
  await fs.rm(session);
  await fs.mkdir(session);
  await status('codex: a folder named as a session');
  // opencode: the file of a source holds the reading; anything else is no reading.
  const reading = { version: 1, company: 'example', source: 'test', read_at: f.io.now() / 1000, five_hour: { remaining_percent: 61, reset_at: null } };
  await fs.writeFile(source, JSON.stringify(reading));
  assert.match(row(await status('opencode good'), 'opencode'), /61/);
  for (const body of ['not json', 'null', '5', '"x"', '[]', '{"version":1}', JSON.stringify({ ...reading, five_hour: 5 }), '']) {
    await fs.writeFile(source, body);
    assert.doesNotMatch(row(await status(`opencode ${body}`), 'opencode'), /61/, body);
  }
});

test('input inventory: the client settings.json that the role step reads: not JSON is a failure of the work, another shape is kept and said', async (t) => {
  const { default: claude } = await import('../adapters/claude-code/index.js');
  const root = await fs.mkdtemp(join(tmpdir(), 'client-settings-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = join(root, 'settings.json');
  await fs.writeFile(file, '{ not json');
  await assert.rejects(() => claude.installRole({ root }), (error) => kindOf(error) === 'operational' && /Invalid JSON/.test(error.message));
  assert.equal(await fs.readFile(file, 'utf8'), '{ not json', 'the file is left as it was');
  for (const body of ['null', '5', '[]', '{"hooks":5}', '{"hooks":{"SessionStart":"x"}}']) {
    await fs.writeFile(file, body);
    assert.equal((await claude.installRole({ root })).status, 'unsupported', body);
    assert.equal(await fs.readFile(file, 'utf8'), body, `${body}: kept`);
  }
});
