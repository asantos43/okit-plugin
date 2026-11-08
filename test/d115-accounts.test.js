import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { accountsOf, accountKey, accountFiles, accountEnv, accountOfConfigDir, newAccountId,
  validateLabel, withAccountAdded, withAccountRemoved, withAccountRenamed,
  accountSlug, proposedAccountFolder } from '../src/accounts.js';
import { configOf } from '../src/profiles.js';
import { EXTRA_KEYS } from '../src/config-schema.js';
import { paths } from '../src/store.js';
import { writeJsonAtomic } from '../src/state.js';
import { collectStatusline, statuslineCommand, STATUSLINE_FILE, READING_FILE } from '../src/quota/statusline-collector.js';
import { readQuota as claudeQuota } from '../adapters/claude-code/index.js';
import { readQuota as codexQuota } from '../adapters/codex/index.js';
import { adapterQuotaReader } from '../src/env/quota.js';

const now = () => Date.UTC(2026, 10, 4);
// | Corpus | Must pass | Must refuse/propose nothing |
// | slug | spaces, case, accents, symbols, bounded text | blank, symbols only |
test('base slug and folder proposals share the id seed without inventing an empty name', () => {
  for (const [name, expected] of [['Work Account', 'work-account'], ['Trabalho Ação', 'trabalho-acao'], // locale:pt-BR
    [' A/@B! ', 'a-b'], ['', ''], ['☀!?', ''], ['  ', ''],
    ['A'.repeat(40), 'a'.repeat(32)], ['a'.repeat(31) + ' b', 'a'.repeat(31)]]) {
    assert.equal(accountSlug(name), expected);
    assert.equal(newAccountId(name), expected || 'account');
    for (const [client, prefix] of [['claude-code', 'claude'], ['codex', 'codex']]) {
      assert.equal(proposedAccountFolder(client, accountSlug(name), '/home/user/', '/'),
        expected ? `/home/user/.${prefix}-${expected}` : '');
      assert.equal(proposedAccountFolder(client, accountSlug(name), 'C:\\Users\\User', '\\'),
        expected ? `C:\\Users\\User\\.${prefix}-${expected}` : '');
    }
  }
  assert.equal(newAccountId('Work Account', ['work-account']), 'work-account-2');
  assert.equal(proposedAccountFolder('codex', accountSlug('Work Account'), '/home/user', '/'), '/home/user/.codex-work-account');
});
const sample = (used) => Buffer.from(JSON.stringify({ rate_limits: {
  five_hour: { used_percentage: used, resets_at: now() / 1000 + 3600 },
} }));
async function rootFor(t) {
  const root = await mkdtemp(join(tmpdir(), 'd115-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('implicit default, stable ids, immutable changes and default protection', () => {
  const original = { language: 'en' };
  assert.deepEqual(accountsOf(original, 'codex'), [{ client: 'codex', id: 'default', label: 'default',
    configDir: null, isDefault: true, key: 'codex' }]);
  const added = withAccountAdded(original, 'codex', 'Production', '/tmp/production');
  assert.deepEqual(original, { language: 'en' });
  const id = accountsOf(added, 'codex')[1].id;
  assert.equal(id, 'production');
  const renamed = withAccountRenamed(added, 'codex', id, 'New name');
  assert.equal(accountsOf(renamed, 'codex')[1].id, id);
  assert.equal(accountsOf(added, 'codex')[1].label, 'Production');
  const defaults = withAccountRenamed(renamed, 'codex', 'default', 'Personal');
  assert.equal(accountsOf(defaults, 'codex')[0].configDir, null);
  assert.equal(accountsOf(defaults, 'codex')[0].label, 'Personal');
  assert.throws(() => withAccountRemoved(defaults, 'codex', 'default'), /default/);
  assert.throws(() => withAccountRenamed(defaults, 'codex', id, 'Personal'), /unique/);
  assert.equal(accountsOf(withAccountRemoved(defaults, 'codex', id), 'codex').length, 1);
  assert.equal(newAccountId('default'), 'default-2');
  assert.equal(newAccountId('A'.repeat(60), ['a'.repeat(32)]), `${'a'.repeat(30)}-2`);
  assert.match(newAccountId('☀'), /^[a-z0-9-]{1,32}$/);
  assert.equal(newAccountId('Foo', ['foo', 'foo-2']), 'foo-3');
  assert.throws(() => accountsOf({}, 'opencode'), /Unsupported/);
});

// | Corpus             | Must pass                     | Must refuse                       |
// | labels             | text, 40 chars, own rename    | blank, controls, >40, duplicates |
// | saved accounts     | default label, absolute paths | duplicate ids, bad ids, relative |
// | config dir lookup  | normalized POSIX/Windows      | unknown dir becoming an extra    |
test('label validation has localized reasons and client-scoped uniqueness', () => {
  const accounts = [{ client: 'codex', id: 'x', label: 'Work' }];
  for (const label of ['A', 'A'.repeat(40), 'Production']) assert.equal(validateLabel(label).ok, true);
  for (const label of ['', '  ', 'A'.repeat(41), 'a\nb', 'a\0b', 'a\tb', 'a\x7fb', 'a\u0085b']) {
    const result = validateLabel(label);
    assert.equal(result.ok, false);
    assert.ok(result.reason.en && result.reason['pt-BR']);
  }
  assert.equal(validateLabel('Work', { client: 'codex', accounts }).ok, false);
  assert.equal(validateLabel('Work', { client: 'claude-code', accounts }).ok, true);
  assert.equal(validateLabel('Work', { accounts, exceptId: 'x' }).ok, true);
});

test('schema refuses malformed accounts including conflicts with implicit default', () => {
  const extra = { id: 'work', label: 'Work', configDir: '/tmp/work' };
  for (const value of [null, [], { opencode: [] }, { codex: {} }, { codex: [extra, extra] },
    { codex: [{ ...extra, id: '../escape' }] }, { codex: [{ ...extra, configDir: 'relative' }] },
    { codex: [{ ...extra, configDir: '' }] }, { codex: [{ ...extra, label: 'default' }] },
    { codex: [{ id: 'default', label: 'Personal', configDir: '/tmp/forbidden' }] }]) {
    assert.throws(() => configOf({ accounts: value }), /Accounts setting accounts[.\w]* is not valid/);
    assert.ok(EXTRA_KEYS.accounts.validate(value));
  }
  assert.doesNotThrow(() => configOf({ accounts: { codex: [extra, { id: 'default', label: 'Personal' }] } }));
  assert.equal(EXTRA_KEYS.accounts.validate({ codex: [{ ...extra, configDir: 'C:\\Accounts\\Work' }] }), null);
});

test('account files and environments preserve default names and values', () => {
  assert.deepEqual(accountFiles('claude-code'), { reading: READING_FILE, statusline: STATUSLINE_FILE });
  assert.deepEqual(accountFiles('claude-code', 'acc2'), {
    reading: 'claude-code.acc2.json', statusline: 'claude-code-statusline.acc2.json' });
  assert.equal(accountKey('claude-code'), 'claude-code');
  assert.equal(accountKey('codex', 'acc2'), 'codex:acc2');
  assert.throws(() => accountFiles('codex', '../bad'));
  const env = { HOME: '', CODEX_HOME: '/tmp/original' };
  assert.equal(accountEnv('codex', accountsOf({}, 'codex')[0], env), env);
  assert.deepEqual(accountEnv('codex', { id: 'x', configDir: '/tmp/x' }, env), { HOME: '', CODEX_HOME: '/tmp/x' });
  assert.equal(env.CODEX_HOME, '/tmp/original');
  assert.equal(accountEnv('codex', { id: 'x', configDir: '/tmp/x' }, env, 'CUSTOM').CUSTOM, '/tmp/x');
});

test('config directory matching is platform-injected and unknown paths name no account', () => {
  for (const [platform, configDir, matching] of [
    ['win32', 'C:\\Accounts\\Work', 'c:\\ACCOUNTS\\Work\\'],
    ['linux', '/tmp/accounts/work', '/tmp/accounts/./work/'],
    ['darwin', '/tmp/accounts/work', '/tmp/accounts/work/'],
  ]) {
    const config = { accounts: { 'claude-code': [{ id: 'work', label: 'Work', configDir }] } };
    const select = (env) => accountOfConfigDir({ client: 'claude-code', config, env, platform });
    assert.equal(select({ CLAUDE_CONFIG_DIR: matching }).id, 'work');
    // A folder that names no saved account belongs to nobody: the collector writes nothing for it.
    assert.equal(select({ CLAUDE_CONFIG_DIR: '/unknown' }), null);
    assert.equal(select({}).id, 'default');
    if (platform === 'linux') assert.equal(select({ CLAUDE_CONFIG_DIR: matching.toUpperCase() }), null);
    else assert.equal(select({ CLAUDE_CONFIG_DIR: matching.toUpperCase() }).id, 'work');
  }
});

test('legacy config preserves normalized output, default bytes, paths and readings', async (t) => {
  const root = await rootFor(t);
  const config = { language: 'pt-BR', limits: { global: 2 } };
  const before = structuredClone(config);
  const normalized = configOf(config);
  assert.equal(Object.hasOwn(normalized, 'accounts'), false);
  const explicit = configOf({ ...config, accounts: {} });
  delete explicit.accounts;
  assert.deepEqual(explicit, normalized);
  assert.deepEqual(config, before);
  const input = sample(20);
  await collectStatusline({ stateRoot: root, input, now, config, env: { HOME: '', CLAUDE_CONFIG_DIR: '/unknown' } });
  const expected = `${JSON.stringify({ receivedAt: new Date(now()).toISOString(), input: JSON.parse(input) }, null, 2)}\n`;
  assert.equal(await readFile(join(paths(root).quota, STATUSLINE_FILE), 'utf8'), expected);
  assert.deepEqual(await claudeQuota({ stateRoot: root, config, now }),
    await claudeQuota({ stateRoot: root, config: { ...config, accounts: {} }, now, account: 'default' }));
  assert.deepEqual(await codexQuota({ stateRoot: root, config, now, env: { HOME: '', USERPROFILE: '' } }), { source: 'manual' });
});

test('collector command routes Windows config dirs and unknown paths write no file of any account', async (t) => {
  const root = await rootFor(t);
  const config = { accounts: { 'claude-code': [{ id: 'work', label: 'Work', configDir: 'C:\\Accounts\\Work' }] } };
  await writeJsonAtomic(paths(root).config, config);
  await statuslineCommand([], { root, env: { HOME: '', CLAUDE_CONFIG_DIR: 'c:\\ACCOUNTS\\WORK\\' },
    platform: 'win32', now, stdin: Readable.from([sample(30)]), stdout: () => {} });
  await collectStatusline({ stateRoot: root, config, now, input: sample(90), env: { CLAUDE_CONFIG_DIR: 'C:\\Unknown' }, platform: 'win32' });
  // The folder of an account that was removed (or of one that was never saved) writes nothing: the reading of
  // the default is never overwritten with the limits of another account.
  assert.deepEqual((await readdir(paths(root).quota)).sort(), ['claude-code-statusline.work.json']);
  assert.equal((await claudeQuota({ stateRoot: root, now, config, account: 'work' })).remainingPct, 70);
  assert.equal((await claudeQuota({ stateRoot: root, now, config })).remainingPct, undefined);
});

test('Claude manual and automatic readings are isolated per account; removal preserves files', async (t) => {
  const root = await rootFor(t);
  const dir = join(root, 'account');
  const config = withAccountAdded({}, 'claude-code', 'Work', dir);
  await collectStatusline({ stateRoot: root, config, now, input: sample(40), env: { CLAUDE_CONFIG_DIR: dir } });
  for (const [id, remainingPct] of [['default', 15], ['work', 85]]) {
    await writeJsonAtomic(join(paths(root).quota, accountFiles('claude-code', id).reading), {
      remainingPct, recordedAt: new Date(now() + 1000).toISOString(),
    });
  }
  const read = adapterQuotaReader({ stateRoot: root, config, env: { HOME: '' }, now });
  assert.equal((await read('claude-code')).remainingPct, 15);
  assert.equal((await read('claude-code', 'work')).remainingPct, 85);
  const removed = withAccountRemoved(config, 'claude-code', 'work');
  assert.equal(accountsOf(removed, 'claude-code').length, 1);
  assert.ok(await readFile(join(paths(root).quota, accountFiles('claude-code', 'work').reading)));
});

async function sessionAt(directory, used) {
  await mkdir(join(directory, 'sessions'), { recursive: true });
  await writeFile(join(directory, 'sessions', 'rollout-test.jsonl'), `${JSON.stringify({
    timestamp: new Date(now()).toISOString(), type: 'event_msg', payload: {
      type: 'token_count', rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_at: now() / 1000 + 3600 } },
    },
  })}\n`);
}

test('Codex reads requested account sessions and manual files with an empty HOME', async (t) => {
  const root = await rootFor(t);
  const first = join(root, 'first'), second = join(root, 'second'), legacy = join(root, 'legacy');
  const config = withAccountAdded(withAccountAdded({}, 'codex', 'First', first), 'codex', 'Second', second);
  await sessionAt(first, 20);
  await sessionAt(second, 75);
  await sessionAt(legacy, 95);
  const env = { HOME: '', USERPROFILE: '', CODEX_HOME: legacy, CODEX_SESSIONS_DIR: join(legacy, 'sessions') };
  const read = adapterQuotaReader({ stateRoot: root, config, env, now });
  assert.equal((await read('codex', 'first')).remainingPct, 80);
  assert.equal((await read('codex', 'second')).remainingPct, 25);
  assert.equal((await read('codex')).remainingPct, 5);
  await assert.rejects(() => read('codex', 'missing'), /Unknown/);
  for (const [id, remainingPct] of [['default', 12], ['first', 34], ['second', 56]]) {
    await writeJsonAtomic(join(paths(root).quota, accountFiles('codex', id).reading), {
      remainingPct, recordedAt: new Date(now() + 1000).toISOString(),
    });
    assert.equal((await read('codex', id)).remainingPct, remainingPct);
  }
  assert.equal(env.CODEX_HOME, legacy);
});

test('quota reader forwards optional account while preserving old calls', async () => {
  const calls = [];
  const read = adapterQuotaReader({ adapters: { codex: async (options) => { calls.push(options); return {}; } } });
  await read('codex');
  await read('codex', 'work');
  assert.equal(Object.hasOwn(calls[0], 'account'), false);
  assert.equal(calls[1].account, 'work');
});

test('a refused accounts setting is shown in Portuguese and does not take over the other settings\' refusals', async () => {
  const { localizeReason } = await import('../src/install/present.js');
  let error;
  try { configOf({ accounts: { codex: [{ id: 'default', label: 'x', configDir: '/tmp/x' }] } }); } catch (caught) { error = caught; }
  assert.match(localizeReason(error.message, 'pt-BR'), /^A configuração de contas accounts\.codex não é válida: use ids de conta únicos/); // locale:pt-BR
  assert.match(localizeReason('Invalid install.clients.codex.xdgParts: use both or neither.', 'pt-BR'), /^install\.clients\.codex\.xdgParts inválido: /); // locale:pt-BR
});

test('every refusal of the account model is translated into Portuguese', async () => {
  const { localizeReason } = await import('../src/install/present.js');
  const config = { accounts: { codex: [{ id: 'work', label: 'Work', configDir: '/tmp/work' }] } };
  const raises = [
    () => accountKey('opencode'), () => accountKey('codex', 'Bad Id'), () => withAccountAdded({}, 'codex', ' ', '/tmp/x'),
    () => withAccountAdded(config, 'codex', 'Work', '/tmp/x'), () => withAccountAdded({}, 'codex', 'Ok', 'relative'),
    () => withAccountRemoved(config, 'codex', 'default'), () => withAccountRemoved(config, 'codex', 'nope'),
    () => withAccountRenamed(config, 'codex', 'nope', 'Other'),
  ];
  for (const raise of raises) {
    const error = (() => { try { raise(); } catch (caught) { return caught; } return null; })();
    assert.ok(error, 'the call is refused');
    assert.doesNotMatch(error.message, / \/ /, 'one language in the raised text');
    assert.notEqual(localizeReason(error.message, 'pt-BR'), error.message, error.message);
  }
});
