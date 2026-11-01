import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { main } from '../src/cli.js';
import { CONFIG_SCHEMA, INSTALL_SCHEMA, MAX_TIMER_MS, installNodes } from '../src/config-schema.js';
import { installConfig } from '../src/install/config.js';
import { exitCodeFor, kindOf } from '../src/install/exit.js';
import { DEFAULT_CONFIG } from '../src/profiles.js';
import { fixture } from './helpers/install-fixture.js';

// Round 17 / I9: every configuration is read through one schema (src/config-schema.js), so a value that is not valid
// is one refusal of usage (exit 2) that names the key and the rule in the language of the run, for every command that
// reads the configuration: never a TypeError, a RangeError or an exit 1. The cases are generated from the schema; a
// key of the defaults that has no node in it fails the first test below, so a new setting cannot skip the fuzz.

const LOCALES = ['en', 'pt-BR'];
const COMMANDS = [
  ['install', '--client', 'claude-code', '--dry-run'], ['update'], ['uninstall'], ['setup', '--defaults'], ['kit'], ['status'], ['config', 'show'],
];
const LEAK = /TypeError|RangeError|undefined|\bat .*\(.*:\d+:\d+\)|node:internal/;
const ENGLISH_RULE = /\b(non-empty|an integer from|a list of|true or false|an object|a name without|text, which may|an HTTP header|environment variable name|an address that)/;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const JSON_ONLY = (value) => JSON.parse(JSON.stringify(value));

/** The values that are not valid for a node of INSTALL_SCHEMA, built from what the node says. */
function invalidValues(node) {
  const values = [];
  const add = (...items) => values.push(...items);
  if (!node.nullable) add(null);
  switch (node.kind) {
    case 'text':
      add(5, true, [], {});
      if (!node.empty) add('', '   ');
      add('a\nb');
      if (node.plain) add('a/b', 'a\\b');
      if (node.pattern && !node.plain) add('no placeholder');
      break;
    case 'integer':
      add(0, -1, 1.5, '5', true, Number.MAX_SAFE_INTEGER + 2);
      if (node.max < Number.MAX_SAFE_INTEGER) add(node.max + 1, 4294967296);
      break;
    case 'boolean': add('true', 1, 0, []); break;
    case 'address': add('ftp://example.invalid', 'not an address', 5, ''); break;
    case 'choice': add('nope', 5, ['marketplace']); break;
    case 'list':
      add('text', {}, 5, [5], [{}]);
      if (!node.head) add([null]);
      if (node.min) add([]);
      break;
    default: add('text', 5, [], true);
  }
  return values;
}

/** The nodes with a value that is not valid only together with another key (the cross rules of a record). */
const CROSS = {
  'path.end': () => DEFAULT_CONFIG.install.path.begin,
  'path.fallbackShell': () => 'no-such-shell',
  // A client folder that is told by one variable needs the parts of its path, and the reverse (the default client has neither).
  'clients.claude-code.xdgEnv': () => 'XDG_CONFIG_HOME',
  'clients.claude-code.xdgParts': () => ['claude'],
};
/** The key a cross rule names when it is not the one that was set. */
const CROSS_AT = { 'clients.claude-code.xdgEnv': 'clients.claude-code.xdgParts', 'clients.claude-code.xdgParts': 'clients.claude-code.xdgEnv' };
const reported = (path, value) => (CROSS[path] && JSON.stringify(CROSS[path]()) === JSON.stringify(value) ? CROSS_AT[path] ?? path : path);

function cases() {
  const found = [];
  for (const { path, node } of installNodes()) {
    for (const value of invalidValues(node)) found.push({ path, value });
    if (CROSS[path]) found.push({ path, value: CROSS[path]() });
  }
  return found;
}

function withValue(path, value) {
  const config = { install: {} };
  let at = config.install;
  const parts = path.split('.');
  for (const part of parts.slice(0, -1)) at = at[part] = {};
  at[parts.at(-1)] = value;
  return config;
}

test('every key of the installer defaults has a node in the schema, and a key without one is found', () => {
  const missing = (defaults, node, path = '') => {
    if (defaults === null || typeof defaults !== 'object' || Array.isArray(defaults)) return [];
    if (node.kind !== 'record') return [];
    return Object.entries(defaults).flatMap(([key, value]) => {
      const child = Object.hasOwn(node.fields, key) ? node.fields[key] : node.open;
      const at = path ? `${path}.${key}` : key;
      return child ? missing(value, child, at) : [at];
    });
  };
  assert.deepEqual(missing(DEFAULT_CONFIG.install, INSTALL_SCHEMA), []);
  const grown = { ...JSON_ONLY(DEFAULT_CONFIG.install), brandNew: 1, kit: { ...DEFAULT_CONFIG.install.kit, another: true } };
  assert.deepEqual(missing(grown, INSTALL_SCHEMA), ['kit.another', 'brandNew']);
  // And the other way: a node whose key is not in the defaults has a default to be read against, or says it is optional.
  const known = new Set(installNodes().map((entry) => entry.path));
  for (const key of Object.keys(DEFAULT_CONFIG.install)) assert.ok(known.has(key), key);
});

test('the defaults and the merge of valid settings pass the schema; an absent key is the default', () => {
  assert.doesNotThrow(() => installConfig());
  assert.doesNotThrow(() => installConfig(null));
  for (const { path } of installNodes()) {
    const config = JSON_ONLY(DEFAULT_CONFIG.install);
    const parts = path.split('.');
    let at = config;
    for (const part of parts.slice(0, -1)) at = at?.[part];
    // A key whose parent is not in the defaults (an optional field of a client that does not have it) is already absent.
    if (!at) continue;
    delete at[parts.at(-1)];
    const value = installConfig(config);
    assert.ok(value, path);
  }
  assert.equal(installConfig({ timeoutMs: MAX_TIMER_MS }).timeoutMs, MAX_TIMER_MS);
});

test('every invalid value of every key is one refusal of usage that names the key, never a TypeError', () => {
  const all = cases();
  assert.ok(all.length > 400, `${all.length} cases`);
  for (const { path, value } of all) {
    let thrown;
    try { installConfig(withValue(path, value).install); } catch (error) { thrown = error; }
    assert.ok(thrown, `${path} = ${JSON.stringify(value)} was accepted`);
    assert.equal(kindOf(thrown), 'usage', `${path} = ${JSON.stringify(value)}: ${thrown.message}`);
    assert.equal(exitCodeFor(kindOf(thrown)), 2);
    assert.match(thrown.message, new RegExp(`^Invalid install\\.${escape(reported(path, value))}: `), JSON.stringify(value));
  }
  for (const value of ['text', 5, [], true]) {
    assert.throws(() => installConfig(value), (error) => kindOf(error) === 'usage' && /^Invalid install: an object$/.test(error.message));
  }
});

test('the MCP settings of the installer are refused when the client could not read them', () => {
  const refused = [
    ['mcp.name', '-okit'], ['mcp.name', '--scope'], ['mcp.name', 'okit plugin'], ['mcp.name', 'okit/other'],
    ['mcp.server', '../outside.js'], ['mcp.server', '/absolute/server.js'], ['mcp.server', 'C:/server.js'],
    ['mcp.server', 'src/../server.js'], ['mcp.server', 'src\\server.js'], ['mcp.server', 'server with space.js'],
    ['clients.claude-code.mcp.scope', 'global'], ['clients.claude-code.mcp.scope', ''],
    ['clients.codex.mcp.scope', 'Project'],
    // A client whose own `mcp` commands take no scope refuses one.
    ['clients.codex.mcp.scope', 'user'],
  ];
  for (const [path, value] of refused) {
    let thrown;
    try { installConfig(withValue(path, value).install); } catch (error) { thrown = error; }
    assert.ok(thrown, `${path} = ${JSON.stringify(value)} was accepted`);
    assert.equal(kindOf(thrown), 'usage', `${path} = ${JSON.stringify(value)}: ${thrown.message}`);
    assert.equal(exitCodeFor(kindOf(thrown)), 2);
    assert.match(thrown.message, new RegExp(`^Invalid install\\.${escape(path)}: `), JSON.stringify(value));
  }
  // A configuration without the MCP keys is still valid: the defaults fill them in.
  assert.doesNotThrow(() => installConfig({}));
  assert.doesNotThrow(() => installConfig({ clients: { 'claude-code': { mcp: { scope: 'local' } } } }));
  assert.doesNotThrow(() => installConfig({ clients: { codex: { mcp: { scope: null } } } }));
  assert.equal(installConfig({ mcp: { name: 'other', server: 'src/mcp/other.js' } }).mcp.name, 'other');
});

test('every invalid value of every key, in every command and language: exit 2, the key and rule in the language, the file intact', async (t) => {
  const f = await fixture(t);
  const file = join(f.root, 'config.json');
  const picked = cases();
  const roots = [...['text', 5, [], true, null].map((value) => ({ path: '', value }))];
  assert.ok(picked.length > 400);
  for (const locale of LOCALES) {
    for (const { path, value } of [...picked, ...roots]) {
      const config = path ? withValue(path, value) : { install: value };
      const body = JSON.stringify({ language: locale, ...config });
      await fs.writeFile(file, body);
      for (const command of COMMANDS) {
        f.clear();
        const label = `${locale} ${command.join(' ')} ${path || 'install'} = ${JSON.stringify(value)}`;
        const code = await main(command, f.io);
        const text = f.output.join('\n');
        if (value === null && path === '') {
          // `install: null` is an absent section: the defaults (a command may still stop for its own reason).
          assert.doesNotMatch(text, /Invalid install|install inválido/, label);
          continue;
        }
        assert.equal(code, 2, `${label}\n${text}`);
        const key = path ? `install.${reported(path, value)}` : 'install';
        assert.match(text, locale === 'pt-BR' ? new RegExp(`${escape(key)} inválido: `) : new RegExp(`Invalid ${escape(key)}: `), label);
        if (locale === 'pt-BR') assert.doesNotMatch(text, /Invalid install/, label);
        else assert.doesNotMatch(text, /inválido/, label);
        if (locale === 'pt-BR') assert.doesNotMatch(text, ENGLISH_RULE, label);
        assert.doesNotMatch(text, LEAK, label);
        assert.equal(await fs.readFile(file, 'utf8'), body, label);
      }
    }
  }
});

function concrete(path) {
  return path.replace('<client>', 'codex').replace('<class>', 'simple').replace('<name>', 'example');
}

/** Text that `config set` must refuse for an entry of CONFIG_SCHEMA, from its type. */
function refusedTexts(entry) {
  switch (entry.type) {
    case 'integer': return ['abc', '1.5', '', ...(entry.minimum >= 0 ? [String(entry.minimum - 1)] : []), String(2 ** 60)];
    case 'number': return ['', 'abc'];
    case 'boolean': return ['yes', '2', ''];
    case 'object': return ['text', '[1]', '{'];
    case 'string': return ['', ...(entry.allowedValues ? ['no-such-value'] : [])];
    case 'profile': return ['text', '5'];
    case 'text': return [];
    default: return null;
  }
}

test('every key of CONFIG_SCHEMA has a type this test knows, and refuses what it must with exit 2 and the file intact', async (t) => {
  const f = await fixture(t);
  const file = join(f.root, 'config.json');
  const untyped = CONFIG_SCHEMA.entries.filter((entry) => refusedTexts(entry) === null).map((entry) => entry.path);
  assert.deepEqual(untyped, [], 'a key of CONFIG_SCHEMA with a type that has no invalid values: add them here');
  let refused = 0;
  for (const locale of LOCALES) {
    for (const entry of CONFIG_SCHEMA.entries) {
      const key = concrete(entry.path);
      for (const text of refusedTexts(entry)) {
        const body = JSON.stringify({ language: locale });
        await fs.writeFile(file, body);
        f.clear();
        const code = await main(['config', 'set', key, text], f.io);
        const output = f.output.join('\n');
        assert.equal(code, 2, `${locale} config set ${key} ${JSON.stringify(text)}\n${output}`);
        assert.match(output, new RegExp(escape(key.split('.').at(-1))), key);
        assert.doesNotMatch(output, LEAK, key);
        assert.equal(await fs.readFile(file, 'utf8'), body, key);
        refused += 1;
      }
    }
  }
  assert.ok(refused > 40, `${refused} refusals`);
  for (const verb of [['get'], ['unset']]) {
    f.clear();
    assert.equal(await main(['config', ...verb, 'no.such.key'], f.io), 2);
  }
});

test('a --from package whose name or version is not text is one refusal of usage, in both languages', async (t) => {
  const f = await fixture(t);
  const source = join(f.home, 'source');
  await fs.mkdir(join(source, 'src'), { recursive: true });
  await fs.writeFile(join(source, 'src/cli.js'), '// fake source\n');
  const cases = [
    { name: 'sample', version: 123 }, { name: 'sample', version: null }, { name: 'sample', version: {} }, { name: 'sample', version: [] },
    { name: 'sample', version: true }, { name: 'sample' }, { name: 'sample', version: '' }, { name: 'sample', version: '../1' },
    { name: 5, version: '1.0.0' }, null, 5, 'text', [],
  ];
  for (const locale of LOCALES) {
    for (const body of cases) {
      await fs.writeFile(join(source, 'package.json'), JSON.stringify(body));
      f.clear();
      const code = await main(['install', '--from', source, '--client', 'claude-code', '--dry-run', '--locale', locale], f.io);
      const text = f.output.join('\n');
      assert.equal(code, 2, `${locale} ${JSON.stringify(body)}\n${text}`);
      assert.doesNotMatch(text, LEAK, JSON.stringify(body));
      assert.match(text, locale === 'pt-BR' ? /--from/ : /Invalid --from package/, JSON.stringify(body));
    }
  }
  await fs.writeFile(join(source, 'package.json'), JSON.stringify({ name: 'sample', version: '1.0.0' }));
  f.clear();
  assert.equal(await main(['install', '--from', source, '--client', 'claude-code', '--dry-run'], f.io), 0, f.output.join('\n'));
});
