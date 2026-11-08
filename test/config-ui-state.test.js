import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFIG_SCHEMA } from '../src/config-schema.js';
import { DEFAULT_CONFIG, PROFILE_EFFORTS } from '../src/profiles.js';
import { buildState, describeAccount } from '../src/config-ui/state.js';

test('every schema entry expands over real clients and classes', () => {
  const raw = { profiles: { custom: { simple: { model: 'saved-model', effort: 'low', maxTurns: 3 } } } };
  const state = buildState({ raw });
  const clients = [...Object.keys(DEFAULT_CONFIG.profiles), 'custom'];
  let total = 0;
  for (const entry of CONFIG_SCHEMA.entries) {
    const expected = clients.flatMap((client) => Object.keys(PROFILE_EFFORTS).map((name) =>
      entry.path.replace('<client>', client).replace('<class>', name)));
    const paths = [...new Set(expected)];
    for (const path of paths) assert.equal(state.fields.filter((field) => field.path === path).length, 1, path);
    total += paths.length;
  }
  assert.equal(state.fields.length, total);
  assert.equal(new Set(state.fields.map((field) => field.path)).size, total);
});

test('schema labels use the chosen locale and include defaults', () => {
  const field = (locale) => buildState({ locale }).fields.find((item) => item.path === 'language');
  assert.equal(field('en').constraint, 'one of the listed languages');
  assert.equal(field('pt-BR').constraint, CONFIG_SCHEMA.entries.find((entry) => entry.path === 'language').constraint['pt-BR']);
  assert.equal(field('en').isDefault, true);
  assert.equal(field('en').default, DEFAULT_CONFIG.language);
});

test('secrets are redacted while ordinary values remain visible', () => {
  const raw = { telemetry: { rede: { cabecalhos: { Authorization: 'Bearer hidden-token', Accept: 'application/json' } } },
    profiles: { codex: { simple: { model: 'sk-secret123456', effort: 'low', maxTurns: 7 } } } };
  const serialized = JSON.stringify(buildState({ raw }));
  assert.ok(!serialized.includes('hidden-token'));
  assert.ok(!serialized.includes('sk-secret123456'));
  assert.ok(serialized.includes('application/json'));
  assert.ok(serialized.includes('[Redacted]'));
});

test('failed or missing model listings preserve saved actors with a reason', () => {
  const raw = { profiles: { codex: { simple: { model: 'saved-model', effort: 'low', maxTurns: 7 }, normal: null } } };
  for (const observations of [[], [{ client: 'codex', models: [], source: 'catalog', reason: 'Model list failed.' }]]) {
    const state = buildState({ raw, observations });
    const actor = state.actors.find((item) => item.client === 'codex');
    assert.ok(actor.reason);
    assert.equal(actor.classes[0].model, 'saved-model');
    assert.equal(actor.classes[0].maxTurns, 7);
    assert.deepEqual(actor.classes[0].modelChoices.find((item) => item.model === 'saved-model'), { model: 'saved-model', confirmed: false });
    assert.equal(actor.classes.find((item) => item.class === 'normal').enabled, false);
    assert.ok(actor.classes.some((item) => item.class === 'critic'));
  }
});

test('accounts expose login help and actor eligibility comes from observations', () => {
  const raw = { accounts: { codex: [{ id: 'work', label: 'Work', configDir: '/private/client' }] } };
  const profile = DEFAULT_CONFIG.profiles.codex.simple;
  const state = buildState({ raw, observations: [{ client: 'codex', account: 'work', installed: true,
    source: 'listing', models: [profile.model] }], snapshot: { config: DEFAULT_CONFIG,
    clients: [{ client: 'codex', installed: true, accounts: [{ id: 'work', installed: true,
      candidates: [{ ...profile, canLaunch: true, restrictions: [], sizes: ['S'] }] }] }] } });
  assert.deepEqual(state.accounts.find((item) => item.id === 'work'), { client: 'codex', id: 'work', label: 'Work',
    configDir: '/private/client', login: 'unknown', loginCommand: 'CODEX_HOME=/private/client codex login' });
  const actor = state.actors.find((item) => item.account === 'work');
  assert.equal(actor.classes[0].launchableNow, true);
  assert.equal(actor.classes[0].modelChoices[0].confirmed, true);
  assert.match(state.readiness, /^Ready to launch executors:/);
});

test('account descriptions and page state use the injected Windows platform', async () => {
  const account = { client: 'codex', id: 'work', label: 'Work', configDir: 'C:\\Users\\João\\work' }; // locale:pt-BR Unicode path corpus
  const raw = { accounts: { codex: [account] } };
  const command = "$env:CODEX_HOME='C:\\Users\\João\\work'; codex login"; // locale:pt-BR Unicode path corpus
  const row = await describeAccount(account, raw, { platform: 'win32', env: {}, fs: {
    readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    stat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  } });
  assert.equal(row.loginCommand, command);
  assert.equal(buildState({ raw, platform: 'win32' }).accounts.find(item => item.id === 'work').loginCommand, command);
});

test('page state supplies the normalized server home and platform separator', () => {
  for (const [platform, env, home, pathSeparator] of [
    ['linux', { HOME: '/home/user/../user/' }, '/home/user', '/'],
    ['win32', { HOME: '/ignored', USERPROFILE: 'C:\\Users\\User\\' }, 'C:\\Users\\User', '\\'],
  ]) {
    const state = buildState({ platform, env });
    assert.equal(state.home, home);
    assert.equal(state.pathSeparator, pathSeparator);
  }
});

test('unreadable login state stays unknown and default commands reflect saved accounts', async () => {
  const account = { client: 'codex', id: 'default', label: 'default', configDir: null };
  const config = { accounts: { codex: [] } };
  const calls = [];
  const row = await describeAccount(account, config, { env: { HOME: '/unused' }, platform: 'linux', fs: {
    readFile: async (file) => { calls.push(file); throw Object.assign(new Error('unreadable'), { code: 'EACCES' }); },
    stat: async () => { assert.fail('an unreadable config stops probing'); },
  } });
  assert.equal(row.login, 'unknown');
  assert.deepEqual(calls, ['/unused/.codex/config.toml']);
  assert.equal(row.loginCommand, 'env -u CODEX_HOME codex login');
  assert.equal(buildState().accounts.find(account => account.client === 'codex').loginCommand, 'codex login');
});
