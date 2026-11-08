import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { TOOLS } from '../src/mcp/tools.js';
import { formatEnvironmentReport } from '../src/env/report.js';
import { configuredClientsOf, DEFAULT_CONFIG } from '../src/profiles.js';
import { writeJsonAtomic } from '../src/state.js';
import { configGet, configSet } from '../src/core/config.js';
import { callTool } from './helpers/tools.js';
import { quotaEnv } from './helpers/env.js';
import { initializeDetectedConfig } from '../src/setup/setup.js';
import { fillMissingConfig } from '../src/config.js';
import { CONFIG_SCHEMA, entryAccepts } from '../src/config-schema.js';

// The configuration of a root is read and written through the tool of the server (the assistant's side): the
// command line has no config command of its own any more. The answers are data, not a printed text.

// | Setting corpus | Must pass | Must refuse |
// | panel.autoOpen | booleans | strings, numbers, arrays, objects and null |
test('panel.autoOpen defaults to true and accepts only boolean settings', async t => {
  const root = await tempRoot(t);
  assert.equal(DEFAULT_CONFIG.panel.autoOpen, true);
  const entry = CONFIG_SCHEMA.entries.find(entry => entry.path === 'panel.autoOpen');
  for (const value of [false, true]) {
    assert.equal(entryAccepts(entry, value), true);
    await configSet(root, { key: 'panel.autoOpen', value: String(value) });
    assert.equal(JSON.parse(await readFile(join(root, 'config.json'))).panel.autoOpen, value);
  }
  for (const value of ['false', 0, [], {}, null]) assert.equal(entryAccepts(entry, value), false);
  for (const value of ['"false"', '0', '[]', '{}', 'null'])
    await assert.rejects(configSet(root, { key: 'panel.autoOpen', value }));
});

test('reserved detected keys are ignored without polluting Object.prototype', () => {
  const detected = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
  const target = {};
  assert.equal(fillMissingConfig(target, detected), false);
  assert.deepEqual(target, {});
  assert.equal(Object.prototype.polluted, undefined);
});

async function initializeFromSnapshot(t, { installed = true, source = 'listing', models = ['haiku'],
  proposed = 'haiku', quotaSource = 'manual', remainingPct = 50 } = {}) {
  const root = await tempRoot(t);
  const file = join(root, 'config.json');
  await writeFile(file, '{}');
  const profile = { model: proposed, effort: 'low', maxTurns: 20 };
  const snapshot = { inUse: null, config: { profiles: { codex: { simple: profile } } },
    proposals: { clients: [{ client: 'codex', profiles: { simple: { model: proposed, effort: 'low' } } }] },
    clients: [{ client: 'codex', installed, evidence: { models: source }, models,
      slots: { total: 4 }, reading: { source: quotaSource }, quota: { remainingPct } }] };
  await initializeDetectedConfig({ root, snapshot });
  return JSON.parse(await readFile(file));
}

test('an uninstalled client is not added to profiles or client limits', async (t) => {
  const raw = await initializeFromSnapshot(t, { installed: false });
  assert.equal(raw.profiles, undefined);
  assert.equal(raw.limits, undefined);
});

test('models without a confirmed listing do not produce profile choices', async (t) => {
  const raw = await initializeFromSnapshot(t, { source: 'catalog' });
  assert.equal(raw.profiles, undefined);
  assert.equal(raw.limits, undefined);
});

test('a proposed profile outside the active model list is not saved', async (t) => {
  const raw = await initializeFromSnapshot(t, { models: ['haiku'], proposed: 'opus' });
  assert.equal(raw.profiles, undefined);
  assert.deepEqual(raw.limits, { clients: { codex: 4 } });
});

test('a disabled quota source is not recorded', async (t) => {
  const raw = await initializeFromSnapshot(t, { quotaSource: 'off' });
  assert.equal(raw.setup, undefined);
});

test('detected initialization fills missing fields and preserves explicit choices', async (t) => {
  const root = await tempRoot(t);
  const file = join(root, 'config.json');
  const prior = { limits: { global: 6 }, profiles: { codex: {
    simple: null, normal: { effort: 'high', maxTurns: 9 } } } };
  await writeFile(file, JSON.stringify(prior));
  const options = { root, env: { CODEX_THREAD_ID: 'session' },
    readQuota: async () => ({ source: 'manual', remainingPct: null }),
    adapters: [{ CLIENT: 'codex', listModels: async () => ({ installed: true,
      source: 'listing', models: ['gpt-5-codex'], hidden: [] }) }] };
  assert.equal((await initializeDetectedConfig(options)).written, true);
  const raw = JSON.parse(await readFile(file));
  assert.equal(raw.profiles.codex.simple, null);
  assert.deepEqual(raw.profiles.codex.normal, { model: 'gpt-5-codex', effort: 'high', maxTurns: 9 });
  assert.equal(raw.limits.clients.codex, prior.limits.global);
  assert.deepEqual(raw.setup.detected, { client: 'codex' });
  const bytes = await readFile(file, 'utf8');
  assert.equal((await initializeDetectedConfig(options)).written, false);
  assert.equal(await readFile(file, 'utf8'), bytes);
});

const TMP = fileURLToPath(new URL('../.delegate/tmp/', import.meta.url));

// | Input | Must pass | Must refuse |
// | omitted / saved pt-BR / explicit en | en / pt-BR / en in the tool | system language overriding settings |
// | unknown saved language | plain bilingual explanation | silently using English |
test('the tool of the environment uses the saved language and explicit choices win', async (t) => {
  const root = await tempRoot(t);
  const tool = TOOLS.find(({ name }) => name === 'env_report');
  for (const [language, locale, expected] of [
    [undefined, undefined, 'en'], ['pt-BR', undefined, 'pt-BR'],
    ['pt-BR', 'en', 'en'], ['en', 'pt-BR', 'pt-BR'],
  ]) {
    await writeFile(join(root, 'config.json'), JSON.stringify({ language }));
    const text = formatEnvironmentReport({ unknownClient: true }, expected);
    const reply = JSON.parse(await tool.handler({ client: 'unknown', ...(locale ? { locale } : {}) }, { root }));
    assert.equal(reply.text, text);
  }
});

test('language can be set once, inspected and reset; invalid choices are refused', async (t) => {
  const root = await tempRoot(t);
  for (const value of ['en', 'pt-BR']) {
    await setConfig(root, 'language', value);
    const got = await getConfig(root, 'language');
    assert.equal(got.entries[0].value, value);
  }
  await refusal(setConfig(root, 'language', 'fr'), /Valid values: en, pt-BR/);
  await setConfig(root, 'language');
  for (const language of ['fr', null, 42, '']) {
    await writeFile(join(root, 'config.json'), JSON.stringify({ language }));
    // A language that is not one is a refusal of the language (exit 2), said in English alone when nothing names another.
    await refusal(TOOLS.find(({ name }) => name === 'env_report').handler({}, { root }), /Choose a language: en, pt-BR\./, 'language');
  }
  for (const tool of TOOLS.filter((tool) => tool.inputSchema.properties.locale)) {
    assert.equal(tool.inputSchema.properties.locale.default, 'en', tool.name);
  }
});

async function tempRoot(t, config) {
  await mkdir(TMP, { recursive: true });
  const root = await mkdtemp(join(TMP, 'config-tool-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'sessions'));
  if (config !== undefined) {
    await writeFile(join(root, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }
  return root;
}

/** The table of the settings of a root, or the one entry a key names. */
async function getConfig(root, key) {
  return configGet(root, key === undefined ? {} : { key });
}

/** The change of one entry; without a value the entry is removed. */
async function setConfig(root, key, value) {
  return configSet(root, value === undefined ? { key } : { key, value });
}

/** A refusal of the configuration: the class of the error is the class of the exit code. */
async function refusal(work, expected, kind = 'usage') {
  await assert.rejects(work, (error) => {
    assert.equal(error.kind, kind, error.message);
    if (expected !== undefined) assert.match(error.message, expected);
    return true;
  });
}

// | case | must pass | must refuse |
// | show/get/set | defaults, effective value, previous and new value | - |
// | invalid value | - | exit 1, valid range/list, no write |
// | unknown key/client/class | - | exit 1, valid patterns/list, no write |
// | atomic failure | - | previous file intact, no temporary file |

test('the table of the settings lists the defaults with their origin', async (t) => {
  const root = await tempRoot(t);
  const shown = await getConfig(root);
  const entries = shown.entries.filter((entry) => !entry.path.startsWith('codexQuota.') && !entry.path.startsWith('telemetry.'));
  assert.equal(entries.length, 60);
  assert.deepEqual(entries.filter((entry) => entry.path.startsWith('quotaPoll.')).map(({ path, value }) => [path, value]),
    [['quotaPoll.enabled', true], ['quotaPoll.intervalSec', 60], ['quotaPoll.claudeFallbackMinutes', 30]]);
  assert.deepEqual(entries.filter((entry) => entry.path.startsWith('accountPolicy.'))
    .map(({ path, value, origin }) => ({ path, value, origin })), [
    { path: 'accountPolicy.enforcePace', value: false, origin: 'default' },
    { path: 'accountPolicy.paceMarginPct', value: 15, origin: 'default' },
    { path: 'accountPolicy.minQuotaPct', value: 20, origin: 'default' },
  ]);
  assert.ok(shown.entries.some((entry) => entry.path === 'telemetry.enabled' && entry.value === false && entry.origin === 'default'));
  assert.ok(shown.entries.some((entry) => entry.path === 'codexQuota.tailBytes' && entry.value === 16384 && entry.origin === 'default'));
  assert.ok(entries.every((entry) => entry.origin === 'default'));
  assert.equal(entries[0].path, 'limits.global');
  assert.equal(entries[0].value, 3);
  assert.equal(entries[0].origin, 'default');
  assert.ok(entries.some((entry) => entry.path === 'profiles.claude-code.hard.maxTurns' && entry.value === 80));

  const got = await getConfig(root, 'lowQuotaPct');
  assert.equal(got.entries.length, 1);
  assert.equal(got.entries[0].path, 'lowQuotaPct');
  assert.equal(got.entries[0].value, 15);
  assert.equal(got.entries[0].origin, 'default');
});

test('a set changes one key and preserves the rest', async (t) => {
  const root = await tempRoot(t, {
    limits: { global: 2, clients: { 'claude-code': 3 } },
    lowQuotaPct: 25,
    profiles: { 'claude-code': { simple: { model: 'custom' } } },
    untouched: { keep: true },
  });
  const change = await setConfig(root, 'profiles.claude-code.simple.model', 'new-model');
  assert.equal(change.previous.value, 'custom');
  assert.equal(change.previous.origin, 'user');
  assert.equal(change.after.value, 'new-model');
  assert.equal(change.after.origin, 'user');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')), {
    limits: { global: 2, clients: { 'claude-code': 3 } },
    lowQuotaPct: 25,
    profiles: { 'claude-code': { simple: { model: 'new-model' } } },
    untouched: { keep: true },
  });
});

test('a user value is reported with user origin and unset returns to the default', async (t) => {
  const root = await tempRoot(t);
  await setConfig(root, 'limits.global', '7');
  const got = await getConfig(root, 'limits.global');
  assert.equal(got.entries[0].value, 7);
  assert.equal(got.entries[0].origin, 'user');
  const removed = await setConfig(root, 'limits.global');
  assert.equal(removed.after.value, 3);
  assert.equal(removed.after.origin, 'default');
});

test('setting limits.global removes the legacy alias and keeps other user values', async (t) => {
  const root = await tempRoot(t, {
    limits: { perClient: 2, clients: { 'claude-code': 4 } },
    lowQuotaPct: 25,
    untouched: { keep: true },
  });
  const change = await setConfig(root, 'limits.global', '7');
  assert.deepEqual(change.removedAliases, ['limits.perClient']);
  assert.match(change.removedAliases.map((alias) => `Removed legacy alias "${alias}"`).join('\n'),
    /Removed legacy alias "limits\.perClient"/);
  const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  assert.equal(Object.hasOwn(saved.limits, 'perClient'), false);
  assert.deepEqual(saved, {
    limits: { global: 7, clients: { 'claude-code': 4 } },
    lowQuotaPct: 25,
    untouched: { keep: true },
  });
  const got = await getConfig(root, 'limits.global');
  assert.equal(got.entries[0].value, 7);
  assert.equal(got.entries[0].origin, 'user');
});

test('unsetting limits.global removes its legacy alias and returns to the default', async (t) => {
  const root = await tempRoot(t, { limits: { global: 7, perClient: 2 } });
  const removed = await setConfig(root, 'limits.global');
  assert.equal(removed.after.value, 3);
  assert.deepEqual(removed.removedAliases, ['limits.perClient']);
  const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  assert.equal(Object.hasOwn(saved, 'limits'), false);
  const got = await getConfig(root, 'limits.global');
  assert.equal(got.entries[0].value, 3);
  assert.equal(got.entries[0].origin, 'default');
});

test('unsetting a profile key leaves the file as it was before the set', async (t) => {
  const root = await tempRoot(t, {
    limits: { global: 2, clients: { 'claude-code': 3 } },
    lowQuotaPct: 25,
    profiles: { 'claude-code': { simple: { model: 'custom' } } },
    untouched: { keep: true },
  });
  const file = join(root, 'config.json');
  const before = JSON.parse(await readFile(file, 'utf8'));
  await setConfig(root, 'profiles.codex.simple.model', 'new-model');
  const during = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(during.profiles.codex, { simple: { model: 'new-model' } });
  await setConfig(root, 'profiles.codex.simple.model');
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(after, before);
  assert.equal(Object.hasOwn(after.profiles ?? {}, 'codex'), false);
  assert.deepEqual(after.profiles['claude-code'], { simple: { model: 'custom' } });
});

test('the quota tool reads the same clients before a profile set and after its unset', async (t) => {
  const root = await tempRoot(t, { limits: { global: 2 } });
  const before = await callTool('quota_show', {}, { root, env: quotaEnv(root) });
  await setConfig(root, 'profiles.codex.simple.model', 'gpt-5-codex');
  const during = await callTool('quota_show', {}, { root, env: quotaEnv(root) });
  assert.deepEqual(during.clients.map(({ client }) => client), ['codex']);
  await setConfig(root, 'profiles.codex.simple.model');
  const after = await callTool('quota_show', {}, { root, env: quotaEnv(root) });
  assert.deepEqual(after.clients, before.clients);
});

test('unsetting limits.global with only the legacy alias leaves no empty limits group', async (t) => {
  const root = await tempRoot(t, { limits: { perClient: 2 }, untouched: { keep: true } });
  const removed = await setConfig(root, 'limits.global');
  assert.deepEqual(removed.removedAliases, ['limits.perClient']);
  const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  assert.equal(Object.hasOwn(saved, 'limits'), false);
  assert.deepEqual(saved, { untouched: { keep: true } });
});

test('a value from the legacy alias has user origin in get and show', async (t) => {
  const root = await tempRoot(t, { limits: { perClient: 2 } });
  const got = await getConfig(root, 'limits.global');
  assert.equal(got.entries[0].value, 2);
  assert.equal(got.entries[0].origin, 'user');
  const shown = await getConfig(root);
  const entry = shown.entries.find((one) => one.path === 'limits.global');
  assert.equal(entry.value, 2);
  assert.equal(entry.origin, 'user');
});

test('invalid values are refused without changing the file', async (t) => {
  const root = await tempRoot(t, { limits: { global: 2 } });
  const file = join(root, 'config.json');
  const original = await readFile(file, 'utf8');
  for (const [key, value, expected] of [
    ['limits.global', '0', /integer >= 1/],
    ['limits.global', '1.5', /integer >= 1/],
    ['lowQuotaPct', '101', /number from 0 to 100/],
    ['profiles.claude-code.simple.effort', 'extreme', /low, medium, high/],
  ]) {
    await refusal(setConfig(root, key, value), expected);
    assert.equal(await readFile(file, 'utf8'), original);
  }
});

test('unsafe and non-finite numbers are refused without changing the file', async (t) => {
  const root = await tempRoot(t, { limits: { global: 2 }, lowQuotaPct: 15 });
  const file = join(root, 'config.json');
  const original = await readFile(file, 'utf8');
  const invalid = [
    '9'.repeat(309),
    '9007199254740993',
    '1e999',
    'Infinity',
    'NaN',
  ];
  for (const [key, expected] of [
    ['limits.global', /Expected an integer >= 1/],
    ['lowQuotaPct', /Expected a number from 0 to 100/],
  ]) {
    for (const value of invalid) {
      await refusal(setConfig(root, key, value), expected);
      assert.equal(await readFile(file, 'utf8'), original);
    }
  }
});

test('refused config mutations do not create config.json in a clean root', async (t) => {
  const cases = [
    ['limits.unknown', '1'],
    ['limits.global', '0'],
  ];
  for (const [key, value] of cases) {
    const root = await tempRoot(t);
    await refusal(setConfig(root, key, value));
    await assert.rejects(access(join(root, 'config.json')), { code: 'ENOENT' });
  }
  const root = await tempRoot(t);
  await refusal(setConfig(root, 'limits.unknown'));
  await assert.rejects(access(join(root, 'config.json')), { code: 'ENOENT' });
});

test('refused config mutations preserve the existing file and its mtime', async (t) => {
  const cases = [
    ['limits.unknown', '1'],
    ['limits.global', '0'],
  ];
  const fixedTime = new Date('2000-01-01T00:00:00.000Z');
  for (const [key, value] of cases) {
    const root = await tempRoot(t, { limits: { global: 2 } });
    const file = join(root, 'config.json');
    await utimes(file, fixedTime, fixedTime);
    const original = await readFile(file, 'utf8');
    const before = await stat(file);
    await refusal(setConfig(root, key, value));
    assert.equal(await readFile(file, 'utf8'), original);
    assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  }
});

test('unknown keys, clients and classes are refused with the valid list', async (t) => {
  const root = await tempRoot(t, { limits: { global: 2 } });
  await refusal(getConfig(root, 'limits.unknown'), /Valid key patterns.*limits\.clients\.<client>/s);
  await refusal(getConfig(root, 'limits.clients.nope'), /Valid clients: claude-code, codex, opencode/);
  await refusal(getConfig(root, 'profiles.claude-code.nope.model'), /Valid classes: simple, normal, hard/);
});

test('reserved client and class names are refused without writes or prototype pollution', async (t) => {
  const root = await tempRoot(t, {
    configuredClients: ['__proto__', 'constructor', 'prototype'],
    limits: { global: 2 },
  });
  const file = join(root, 'config.json');
  const original = await readFile(file, 'utf8');
  const fixedTime = new Date('2000-01-01T00:00:00.000Z');
  await utimes(file, fixedTime, fixedTime);
  const before = await stat(file);
  const names = ['constructor', 'prototype', 'simple', 'model'];
  const descriptors = new Map(names.map((name) => (
    [name, Object.getOwnPropertyDescriptor(Object.prototype, name)]
  )));
  const keys = [
    'profiles.__proto__.simple.model',
    'profiles.constructor.simple.model',
    'profiles.prototype.simple.model',
    'profiles.claude-code.__proto__.model',
    'profiles.claude-code.constructor.model',
    'profiles.claude-code.prototype.model',
  ];
  t.after(() => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(Object.prototype, name, descriptor);
      else delete Object.prototype[name];
    }
  });
  for (const key of keys) {
    await refusal(setConfig(root, key, 'unsafe'),
      /Unknown configuration key/s);
    assert.equal(await readFile(file, 'utf8'), original);
    assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  }
  assert.equal(({}).simple, undefined);
  assert.equal(({}).model, undefined);
  assert.equal(Object.prototype.constructor, Object);
  assert.equal(Object.prototype.prototype, undefined);
});

test('a configured client name containing a dot is refused without writing', async (t) => {
  const root = await tempRoot(t, {
    configuredClients: ['codex.foo'],
    limits: { global: 2 },
  });
  const file = join(root, 'config.json');
  const original = await readFile(file, 'utf8');
  const fixedTime = new Date('2000-01-01T00:00:00.000Z');
  await utimes(file, fixedTime, fixedTime);
  const before = await stat(file);
  for (const [key, value] of [
    ['limits.clients.codex.foo', '7'],
    ['profiles.codex.foo.simple.model', 'unsafe'],
  ]) {
    await refusal(setConfig(root, key, value),
      /Unknown configuration key/s);
    assert.equal(await readFile(file, 'utf8'), original);
    assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  }
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(Object.hasOwn(saved.limits.clients ?? {}, 'codex'), false);
});

test('a failed atomic write leaves the previous file intact', async (t) => {
  const root = await tempRoot(t, { limits: { global: 2 } });
  const file = join(root, 'config.json');
  const original = await readFile(file, 'utf8');
  await assert.rejects(configSet(root, { key: 'limits.global', value: '9' }, {
    write: (target, value) => writeJsonAtomic(target, value, {
      retry: { maxAttempts: 1, backoffMs: 1, backoffCapMs: 1 },
      faults: (step) => (step === 'rename' ? 'EPERM' : null),
    }),
  }), /Cannot write/);
  assert.equal(await readFile(file, 'utf8'), original);
  assert.ok((await readdir(root)).every((name) => !name.includes('.tmp')));
});

test('the messages of the configuration name no demand or order id', async (t) => {
  const root = await tempRoot(t);
  const messages = [];
  for (const work of [
    () => getConfig(root),
    () => getConfig(root, 'limits.global'),
    () => setConfig(root, 'limits.global', '4'),
    () => setConfig(root, 'limits.global', '0'),
    () => getConfig(root, 'limits.unknown'),
  ]) {
    try {
      const answer = await work();
      messages.push(JSON.stringify(answer));
    } catch (error) {
      messages.push(error.message);
    }
  }
  assert.ok(messages.every((message) => !/\b[DO]\d+\b/.test(message)));
});

// | case | must pass | must refuse |
// | empty client group | the client is absent, the quota answer is the same in the three states | - |
// | disabled class | the set that follows the unset of the class | the set under the disabled class, exit 1, no write |

test('a client with an empty profile group is absent and the pruning of it changes nothing', async (t) => {
  const root = await tempRoot(t, { profiles: { codex: {} } });
  const file = join(root, 'config.json');
  const states = [];
  const readState = async () => {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    const quota = await callTool('quota_show', {}, { root, env: quotaEnv(root) });
    states.push({ raw, clients: configuredClientsOf(raw), quota });
  };
  await readState();
  await setConfig(root, 'profiles.codex.simple.model', 'x');
  await readState();
  await setConfig(root, 'profiles.codex.simple.model');
  await readState();
  // The client with no class of its own is not configured: an empty group is
  // the absence of a client, before the set and after the unset.
  assert.deepEqual(states[0].clients, []);
  assert.deepEqual(states[2].clients, []);
  assert.deepEqual(states[0].clients, configuredClientsOf({}));
  assert.deepEqual(configuredClientsOf({ profiles: { codex: {} } }), []);
  // The set names a class, so the client is configured while that class is there.
  assert.deepEqual(states[1].clients, ['codex']);
  assert.deepEqual(states[1].quota.clients.map(({ client }) => client), ['codex']);
  assert.deepEqual(states[2].quota.clients, states[0].quota.clients);
  // The file reads as an empty group after the unset.
  assert.deepEqual(states[2].raw, {});
  const empty = await tempRoot(t, {});
  const emptyQuota = await callTool('quota_show', {}, { root: empty, env: quotaEnv(empty) });
  assert.deepEqual(emptyQuota.clients, states[2].quota.clients);
});

test('a disabled profile refuses the set and says how to enable it again', async (t) => {
  const root = await tempRoot(t, { profiles: { codex: { simple: null } } });
  const file = join(root, 'config.json');
  const original = await readFile(file, 'utf8');
  const fixedTime = new Date('2000-01-01T00:00:00.000Z');
  await utimes(file, fixedTime, fixedTime);
  const before = await stat(file);
  await refusal(setConfig(root, 'profiles.codex.simple.model', 'custom'),
    /The profile "profiles\.codex\.simple" is disabled.*config_set` with the key "profiles\.codex\.simple" and no value/s);
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  // The class is enabled again, and the set that follows passes.
  await setConfig(root, 'profiles.codex.simple');
  await setConfig(root, 'profiles.codex.simple.model', 'custom');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved.profiles.codex.simple.model, 'custom');
});

test('a set never crosses an ancestor that is not an object', async (t) => {
  const root = await tempRoot(t, { profiles: { codex: 'not-an-object' } });
  const file = join(root, 'config.json');
  const original = await readFile(file, 'utf8');
  await refusal(setConfig(root, 'profiles.codex.simple.model', 'custom'), /is disabled/s);
  assert.equal(await readFile(file, 'utf8'), original);
});

test('the class key disables a class and unset brings it back', async (t) => {
  const root = await tempRoot(t);
  const file = join(root, 'config.json');
  await refusal(setConfig(root, 'profiles.codex.simple', 'oops'), /literal "null"/s);
  await setConfig(root, 'profiles.codex.simple', 'null');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.profiles.codex.simple, null);
  await refusal(setConfig(root, 'profiles.codex.simple.model', 'custom'));
  await setConfig(root, 'profiles.codex.simple');
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(Object.hasOwn(after.profiles ?? {}, 'codex'), false);
});
