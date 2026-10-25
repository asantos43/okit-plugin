import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { main } from '../src/cli.js';
import { configuredClientsOf } from '../src/profiles.js';
import { writeJsonAtomic } from '../src/state.js';

const TMP = fileURLToPath(new URL('../.delegate/tmp/', import.meta.url));

async function tempRoot(t, config) {
  await mkdir(TMP, { recursive: true });
  const root = await mkdtemp(join(TMP, 'config-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (config !== undefined) {
    await writeFile(join(root, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }
  return root;
}

async function cli(argv, io = {}) {
  const out = [];
  const err = [];
  const code = await main(argv, {
    root: io.root,
    env: {},
    ...io,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return { code, out, err };
}

// | case | must pass | must refuse |
// | show/get/set | defaults, effective value, previous and new value | - |
// | invalid value | - | exit 1, valid range/list, no write |
// | unknown key/client/class | - | exit 1, valid patterns/list, no write |
// | atomic failure | - | previous file intact, no temporary file |

test('config show and get list defaults with their origin and effect', async (t) => {
  const root = await tempRoot(t);
  const shown = await cli(['config', 'show'], { root });
  assert.equal(shown.code, 0, shown.err.join('\n'));
  assert.equal(shown.out.length, 43);
  assert.ok(shown.out.every((line) => line.includes('[default]')));
  assert.match(shown.out[0], /^limits\.global = 3 \[default\] — .* \/ .*$/);
  assert.match(shown.out.join('\n'), /profiles\.claude-code\.hard\.maxTurns = 80 \[default\]/);

  const got = await cli(['config', 'get', 'lowQuotaPct'], { root });
  assert.equal(got.code, 0, got.err.join('\n'));
  assert.match(got.out[0], /^lowQuotaPct = 15 \[default\] — /);
});

test('config set changes one key, prints both values and preserves the rest', async (t) => {
  const root = await tempRoot(t, {
    limits: { global: 2, clients: { 'claude-code': 3 } },
    lowQuotaPct: 25,
    profiles: { 'claude-code': { simple: { model: 'custom' } } },
    untouched: { keep: true },
  });
  const set = await cli(['config', 'set', 'profiles.claude-code.simple.model', 'new-model'], { root });
  assert.equal(set.code, 0, set.err.join('\n'));
  assert.match(set.out[0], /before \/ antes = "custom" \[user\]/);
  assert.match(set.out[0], /after \/ depois = "new-model" \[user\]/);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')), {
    limits: { global: 2, clients: { 'claude-code': 3 } },
    lowQuotaPct: 25,
    profiles: { 'claude-code': { simple: { model: 'new-model' } } },
    untouched: { keep: true },
  });
});

test('a user value is reported with user origin and unset returns to the default', async (t) => {
  const root = await tempRoot(t);
  const set = await cli(['config', 'set', 'limits.global', '7'], { root });
  assert.equal(set.code, 0, set.err.join('\n'));
  const got = await cli(['config', 'get', 'limits.global'], { root });
  assert.match(got.out[0], /^limits\.global = 7 \[user\] — /);
  const unset = await cli(['config', 'unset', 'limits.global'], { root });
  assert.equal(unset.code, 0, unset.err.join('\n'));
  assert.match(unset.out[0], /after \/ depois = 3 \[default\]/);
});

test('setting limits.global removes the legacy alias and keeps other user values', async (t) => {
  const root = await tempRoot(t, {
    limits: { perClient: 2, clients: { 'claude-code': 4 } },
    lowQuotaPct: 25,
    untouched: { keep: true },
  });
  const set = await cli(['config', 'set', 'limits.global', '7'], { root });
  assert.equal(set.code, 0, set.err.join('\n'));
  const message = set.out.join('\n');
  assert.match(message, /Removed legacy alias "limits\.perClient"; it is the old name for "limits\.global"\./);
  assert.match(message, /O apelido legado "limits\.perClient" foi removido/);
  assert.ok(!/\b[DO]\d+\b/.test(message));
  const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  assert.equal(Object.hasOwn(saved.limits, 'perClient'), false);
  assert.deepEqual(saved, {
    limits: { global: 7, clients: { 'claude-code': 4 } },
    lowQuotaPct: 25,
    untouched: { keep: true },
  });
  const got = await cli(['config', 'get', 'limits.global'], { root });
  assert.equal(got.code, 0, got.err.join('\n'));
  assert.match(got.out[0], /^limits\.global = 7 \[user\] — /);
});

test('unsetting limits.global removes its legacy alias and returns to the default', async (t) => {
  const root = await tempRoot(t, { limits: { global: 7, perClient: 2 } });
  const unset = await cli(['config', 'unset', 'limits.global'], { root });
  assert.equal(unset.code, 0, unset.err.join('\n'));
  assert.match(unset.out.join('\n'), /after \/ depois = 3 \[default\]/);
  assert.match(unset.out.join('\n'), /Removed legacy alias "limits\.perClient"/);
  assert.match(unset.out.join('\n'), /O apelido legado "limits\.perClient" foi removido/);
  const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  assert.equal(Object.hasOwn(saved, 'limits'), false);
  const got = await cli(['config', 'get', 'limits.global'], { root });
  assert.equal(got.code, 0, got.err.join('\n'));
  assert.match(got.out[0], /^limits\.global = 3 \[default\]/);
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
  const set = await cli(['config', 'set', 'profiles.codex.simple.model', 'new-model'], { root });
  assert.equal(set.code, 0, set.err.join('\n'));
  const during = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(during.profiles.codex, { simple: { model: 'new-model' } });
  const unset = await cli(['config', 'unset', 'profiles.codex.simple.model'], { root });
  assert.equal(unset.code, 0, unset.err.join('\n'));
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(after, before);
  assert.equal(Object.hasOwn(after.profiles ?? {}, 'codex'), false);
  assert.deepEqual(after.profiles['claude-code'], { simple: { model: 'custom' } });
});

test('the quota command reads the same clients before a profile set and after its unset', async (t) => {
  const root = await tempRoot(t, { limits: { global: 2 } });
  const before = await cli(['quota', 'show', 'claude-code'], { root });
  assert.equal(before.code, 0, before.err.join('\n'));
  const set = await cli(['config', 'set', 'profiles.codex.simple.model', 'gpt-5-codex'], { root });
  assert.equal(set.code, 0, set.err.join('\n'));
  const during = await cli(['quota', 'show', 'claude-code'], { root });
  assert.equal(during.code, 2);
  const unset = await cli(['config', 'unset', 'profiles.codex.simple.model'], { root });
  assert.equal(unset.code, 0, unset.err.join('\n'));
  const after = await cli(['quota', 'show', 'claude-code'], { root });
  assert.equal(after.code, before.code, after.err.join('\n'));
  assert.deepEqual(after.out, before.out);
});

test('unsetting limits.global with only the legacy alias leaves no empty limits group', async (t) => {
  const root = await tempRoot(t, { limits: { perClient: 2 }, untouched: { keep: true } });
  const unset = await cli(['config', 'unset', 'limits.global'], { root });
  assert.equal(unset.code, 0, unset.err.join('\n'));
  assert.match(unset.out.join('\n'), /Removed legacy alias "limits\.perClient"/);
  assert.match(unset.out.join('\n'), /O apelido legado "limits\.perClient" foi removido/);
  const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  assert.equal(Object.hasOwn(saved, 'limits'), false);
  assert.deepEqual(saved, { untouched: { keep: true } });
});

test('a value from the legacy alias has user origin in get and show', async (t) => {
  const root = await tempRoot(t, { limits: { perClient: 2 } });
  const got = await cli(['config', 'get', 'limits.global'], { root });
  assert.equal(got.code, 0, got.err.join('\n'));
  assert.match(got.out[0], /^limits\.global = 2 \[user\] — /);
  const shown = await cli(['config', 'show'], { root });
  assert.equal(shown.code, 0, shown.err.join('\n'));
  assert.match(shown.out[0], /^limits\.global = 2 \[user\] — /);
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
    const refused = await cli(['config', 'set', key, value], { root });
    assert.equal(refused.code, 1, `${key}=${value}`);
    assert.match(refused.err.join('\n'), expected);
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
      const refused = await cli(['config', 'set', key, value], { root });
      assert.equal(refused.code, 1, `${key}=${value}`);
      assert.match(refused.err.join('\n'), expected);
      assert.match(refused.err.join('\n'), /Valor inválido/);
      assert.equal(await readFile(file, 'utf8'), original);
    }
  }
});

test('refused config mutations do not create config.json in a clean root', async (t) => {
  const cases = [
    ['config', 'set', 'limits.unknown', '1'],
    ['config', 'set', 'limits.global', '0'],
    ['config', 'unset', 'limits.unknown'],
  ];
  for (const args of cases) {
    const root = await tempRoot(t);
    const refused = await cli(args, { root });
    assert.equal(refused.code, 1, args.join(' '));
    await assert.rejects(access(join(root, 'config.json')), { code: 'ENOENT' });
  }
});

test('refused config mutations preserve the existing file and its mtime', async (t) => {
  const cases = [
    ['config', 'set', 'limits.unknown', '1'],
    ['config', 'set', 'limits.global', '0'],
    ['config', 'unset', 'limits.unknown'],
  ];
  const fixedTime = new Date('2000-01-01T00:00:00.000Z');
  for (const args of cases) {
    const root = await tempRoot(t, { limits: { global: 2 } });
    const file = join(root, 'config.json');
    await utimes(file, fixedTime, fixedTime);
    const original = await readFile(file, 'utf8');
    const before = await stat(file);
    const refused = await cli(args, { root });
    assert.equal(refused.code, 1, args.join(' '));
    assert.equal(await readFile(file, 'utf8'), original);
    assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  }
});

test('unknown keys, clients and classes are refused with the valid list', async (t) => {
  const root = await tempRoot(t, { limits: { global: 2 } });
  const unknownKey = await cli(['config', 'get', 'limits.unknown'], { root });
  assert.equal(unknownKey.code, 1);
  assert.match(unknownKey.err.join('\n'), /Valid key patterns/);
  assert.match(unknownKey.err.join('\n'), /limits\.clients\.<client>/);

  const unknownClient = await cli(['config', 'get', 'limits.clients.nope'], { root });
  assert.equal(unknownClient.code, 1);
  assert.match(unknownClient.err.join('\n'), /Valid clients: claude-code, codex, opencode/);

  const unknownClass = await cli(['config', 'get', 'profiles.claude-code.nope.model'], { root });
  assert.equal(unknownClass.code, 1);
  assert.match(unknownClass.err.join('\n'), /Valid classes: simple, normal, hard/);
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
    const refused = await cli(['config', 'set', key, 'unsafe'], { root });
    assert.equal(refused.code, 1, key);
    assert.match(refused.err.join('\n'), /Unknown configuration key/);
    assert.match(refused.err.join('\n'), /Chave de configuração desconhecida/);
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
    const refused = await cli(['config', 'set', key, value], { root });
    assert.equal(refused.code, 1, key);
    assert.match(refused.err.join('\n'), /Unknown configuration key/);
    assert.match(refused.err.join('\n'), /Chave de configuração desconhecida/);
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
  const failed = await cli(['config', 'set', 'limits.global', '9'], {
    root,
    writeConfig: (target, value) => writeJsonAtomic(target, value, {
      retry: { maxAttempts: 1, backoffMs: 1, backoffCapMs: 1 },
      faults: (step) => (step === 'rename' ? 'EPERM' : null),
    }),
  });
  assert.equal(failed.code, 1);
  assert.match(failed.err.join('\n'), /Cannot write/);
  assert.equal(await readFile(file, 'utf8'), original);
  assert.ok((await readdir(root)).every((name) => !name.includes('.tmp')));
});

test('config help cites the group and messages contain no demand or order id', async (t) => {
  const root = await tempRoot(t);
  const help = await cli(['config', '--help'], { root });
  assert.equal(help.code, 0);
  assert.match(help.out.join('\n'), /okit-plugin config show/);
  const globalHelp = await cli(['--help'], { root });
  assert.equal(globalHelp.code, 0);
  assert.match(globalHelp.out.join('\n'), /okit-plugin config set <key> <value>/);

  const messages = [];
  for (const args of [
    ['config', 'show'], ['config', 'get', 'limits.global'],
    ['config', 'set', 'limits.global', '4'], ['config', 'set', 'limits.global', '0'],
    ['config', 'get', 'limits.unknown'],
  ]) {
    const result = await cli(args, { root });
    messages.push(...result.out, ...result.err);
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
    const quota = await cli(['quota', 'show', 'codex'], { root });
    states.push({ raw, clients: configuredClientsOf(raw), quota });
  };
  await readState();
  const set = await cli(['config', 'set', 'profiles.codex.simple.model', 'x'], { root });
  assert.equal(set.code, 0, set.err.join('\n'));
  await readState();
  const unset = await cli(['config', 'unset', 'profiles.codex.simple.model'], { root });
  assert.equal(unset.code, 0, unset.err.join('\n'));
  await readState();
  // The client with no class of its own is not configured: an empty group is
  // the absence of a client, before the set and after the unset.
  assert.deepEqual(states[0].clients, []);
  assert.deepEqual(states[2].clients, []);
  assert.deepEqual(states[0].clients, configuredClientsOf({}));
  assert.deepEqual(configuredClientsOf({ profiles: { codex: {} } }), []);
  // The set names a class, so the client is configured while that class is there.
  assert.deepEqual(states[1].clients, ['codex']);
  // The quota command answers the same in the three states.
  for (const state of states) assert.equal(state.quota.code, 0, state.quota.err.join('\n'));
  assert.deepEqual(states[1].quota.out, states[0].quota.out);
  assert.deepEqual(states[2].quota.out, states[0].quota.out);
  // The file reads as an empty group after the unset.
  assert.deepEqual(states[2].raw, {});
  const empty = await tempRoot(t, {});
  const emptyQuota = await cli(['quota', 'show', 'codex'], { root: empty });
  assert.deepEqual(emptyQuota.out, states[2].quota.out);
});

test('a disabled profile refuses the set and says how to enable it again', async (t) => {
  const root = await tempRoot(t, { profiles: { codex: { simple: null } } });
  const file = join(root, 'config.json');
  const original = await readFile(file, 'utf8');
  const fixedTime = new Date('2000-01-01T00:00:00.000Z');
  await utimes(file, fixedTime, fixedTime);
  const before = await stat(file);
  const refused = await cli(['config', 'set', 'profiles.codex.simple.model', 'custom'], { root });
  assert.equal(refused.code, 1);
  const message = refused.err.join('\n');
  assert.match(message, /The profile "profiles\.codex\.simple" is disabled/);
  assert.match(message, /config unset profiles\.codex\.simple/);
  assert.match(message, /O perfil "profiles\.codex\.simple" está desligado/);
  assert.ok(!/\b[DO]\d+\b/.test(message));
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  // The class is enabled again, and the set that follows passes.
  const unset = await cli(['config', 'unset', 'profiles.codex.simple'], { root });
  assert.equal(unset.code, 0, unset.err.join('\n'));
  const set = await cli(['config', 'set', 'profiles.codex.simple.model', 'custom'], { root });
  assert.equal(set.code, 0, set.err.join('\n'));
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved.profiles.codex.simple.model, 'custom');
});

test('a set never crosses an ancestor that is not an object', async (t) => {
  const root = await tempRoot(t, { profiles: { codex: 'not-an-object' } });
  const file = join(root, 'config.json');
  const original = await readFile(file, 'utf8');
  const refused = await cli(['config', 'set', 'profiles.codex.simple.model', 'custom'], { root });
  assert.equal(refused.code, 1);
  assert.match(refused.err.join('\n'), /is disabled/);
  assert.match(refused.err.join('\n'), /está desligado/);
  assert.equal(await readFile(file, 'utf8'), original);
});

test('the class key disables a class and unset brings it back', async (t) => {
  const root = await tempRoot(t);
  const file = join(root, 'config.json');
  const invalid = await cli(['config', 'set', 'profiles.codex.simple', 'oops'], { root });
  assert.equal(invalid.code, 1);
  assert.match(invalid.err.join('\n'), /literal "null"/);
  assert.match(invalid.err.join('\n'), /Valor inválido/);
  const disabled = await cli(['config', 'set', 'profiles.codex.simple', 'null'], { root });
  assert.equal(disabled.code, 0, disabled.err.join('\n'));
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.profiles.codex.simple, null);
  const refused = await cli(['config', 'set', 'profiles.codex.simple.model', 'custom'], { root });
  assert.equal(refused.code, 1);
  const enabled = await cli(['config', 'unset', 'profiles.codex.simple'], { root });
  assert.equal(enabled.code, 0, enabled.err.join('\n'));
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(Object.hasOwn(after.profiles ?? {}, 'codex'), false);
});
