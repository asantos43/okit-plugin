import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSlot, canSpawn, limitsStatus } from '../src/limits.js';
import { environmentSnapshot } from '../src/env/snapshot.js';
import { readiness } from '../src/env/ready.js';
import { quotaSet, quotaShow } from '../src/core/quota.js';
import { loginState } from '../src/accounts-login.js';
import { homeOf } from '../src/install/config.js';
import { main } from '../src/cli.js';
import { TOOLS } from '../src/mcp/tools.js';
import { readJson } from '../src/state.js';
import { makeSpawner } from '../src/spawn-process.js';
import { statusTable } from '../src/status.js';
import { detectClients } from '../src/env/models.js';

const client = 'claude-code';
const accounts = { [client]: [{ id: 'work', label: 'Work', configDir: '/work' }] };
async function temporary(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'd115-fixes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function observation(config = { accounts }) {
  return { config, client, env: { HOME: '/default' }, home: '', platform: 'linux', record: false,
    now: () => 1800000000000, cache: new Map(), plugin: { onPath: true },
    versions: { [client]: { installed: true, version: 'default' } },
    fs: { async stat() { return { isFile: () => true }; },
      async readFile() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } },
    readQuota: async () => ({ remainingPct: 80, source: 'manual' }),
    detectClients: async () => ({ clients: [{ client, installed: true, models: ['m'], source: 'listing' }] }) };
}

// | Corpus | Must pass | Must refuse |
// | Slots | default/work isolation, unchanged default | full cap, invalid id |
// | Catalog | own environment and observation | default catalog reused by extras |
// | Quota | own file, unchanged default | unknown account, compound client |
// | Home | native Windows profile | HOME overriding USERPROFILE |
// | JSON | localized exit 1 | contents or parser text in either stream |
test('slots count and cap each account independently, with unchanged default records', async (t) => {
  const root = await temporary(t);
  const config = { accounts, limits: { global: 3, clients: { [client]: 1 } } };
  assert.deepEqual(await acquireSlot(root, 'personal', { client, config }), { ok: true, runId: 'personal', client });
  assert.equal((await acquireSlot(root, 'work', { client, account: 'work', config })).ok, true);
  const limits = await limitsStatus(root, config);
  assert.deepEqual(limits.byClient, { [client]: 1, [`${client}:work`]: 1 });
  assert.equal(limits.live, 2);
  assert.deepEqual(limits.caps[`${client}:work`], limits.caps[client]);
  for (const account of [undefined, 'default', 'work']) {
    assert.equal((await canSpawn(root, { client, account, config })).reason, 'client limit');
    assert.equal((await acquireSlot(root, `full-${account}`, { client, account, config })).ok, false);
  }
  const personal = await readJson(join(root, 'runs/personal.json'));
  assert.deepEqual(Object.keys(personal), ['runId', 'client', 'status', 'startedAt']);
  assert.equal((await readJson(join(root, 'runs/work.json'))).account, 'work');
  const snapshot = await environmentSnapshot({ ...observation(config), limits });
  assert.deepEqual(snapshot.clients[0].accounts.map((row) => row.slotEvidence.running), [1, 1]);
  const status = await statusTable(root, { snapshot, all: true, demands: [] });
  assert.equal((status.capacityLine.match(/1\/1 \(client\)/g) ?? []).length, 2);
  for (const account of ['', '../work', 'Work', 'work:bad']) {
    await assert.rejects(canSpawn(root, { client, account, config }), /Invalid account id/);
    await assert.rejects(acquireSlot(root, 'bad', { client, account, config }), /Invalid account id/);
  }
  const legacyRoot = await temporary(t);
  await acquireSlot(legacyRoot, 'old', { client });
  assert.deepEqual((await limitsStatus(legacyRoot)).byClient, { [client]: 1 });
  const tool = TOOLS.find((entry) => entry.name === 'limits_status');
  const selected = JSON.parse(await tool.handler({ client, account: 'work' }, { root, config }));
  assert.deepEqual(selected.byClient, { [`${client}:work`]: 1 });
  assert.equal(selected.live, 2);
});

test('models, evidence, installation, version and readiness use the account environment', async () => {
  const config = { accounts, profiles: { [client]: {
    simple: { model: 'm' }, normal: { model: 'm' }, hard: { model: 'm' } } } };
  const calls = [];
  const deps = { ...observation(config), detectClients: async ({ env }) => {
    calls.push(env);
    const extra = env.CLAUDE_CONFIG_DIR === '/work';
    return { clients: [{ client, installed: true, models: extra ? ['m'] : [],
      source: 'listing', reason: extra ? 'work evidence' : 'default evidence', version: extra ? 'work version' : 'default version' }] };
  } };
  const snapshot = await environmentSnapshot(deps);
  const [personal, work] = snapshot.clients[0].accounts;
  assert.deepEqual(personal.models, []);
  assert.deepEqual(work.models, ['m']);
  assert.equal(work.evidence.reason, 'work evidence');
  assert.equal(work.version, 'work version');
  assert.equal(work.configPath, '/work');
  assert.deepEqual(readiness(snapshot).accounts, [{ client, ready: 1, total: 2 }]);
  assert.equal(calls.length, 2);
  calls.length = 0;
  await environmentSnapshot({ ...deps, config: { ...config, accounts: {} } });
  assert.equal(calls.length, 1);
});

test('an extra cannot inherit the installed flag or catalog of the default', async () => {
  const snapshot = await environmentSnapshot({ ...observation(), detectClients: async ({ env }) => ({
    clients: [{ client, installed: env.CLAUDE_CONFIG_DIR ? false : true, source: 'listing', models: ['m'] }],
  }) });
  assert.equal(snapshot.clients[0].accounts[1].installed, false);
  assert.deepEqual(snapshot.clients[0].accounts[1].models, []);
});

test('saved default catalog choices cannot confirm an extra without its own listing', async () => {
  const config = observation().config;
  config.profiles = { [client]: { simple: { model: 'm', effort: 'low' } } };
  config.setup = { done: { profiles: config.profiles } };
  const snapshot = await environmentSnapshot({ ...observation(config), detectClients: async () => ({
    clients: [{ client, installed: true, source: 'catalog', models: ['m'] }],
  }) });
  assert.deepEqual(snapshot.clients[0].accounts[0].models, ['m']);
  assert.deepEqual(snapshot.clients[0].accounts[1].models, []);
  assert.equal(snapshot.clients[0].accounts[1].candidates.some((actor) => actor.canLaunch), false);
});

test('an absent default cannot suppress readiness of an independently installed extra', async () => {
  const config = { accounts, profiles: { [client]: {
    simple: { model: 'm' }, normal: { model: 'm' }, hard: { model: 'm' } } } };
  const snapshot = await environmentSnapshot({ ...observation(config), versions: { [client]: { installed: false } },
    detectClients: async ({ env }) => ({ clients: [{ client, installed: Boolean(env.CLAUDE_CONFIG_DIR),
      source: 'listing', models: ['m'] }] }) });
  assert.equal(snapshot.clients[0].installed, false);
  assert.equal(readiness(snapshot).accounts[0].ready, 1);
  assert.equal(readiness(snapshot).ready, true);
});

test('probe cache distinguishes account configuration environments', async () => {
  const calls = [];
  const snapshot = await environmentSnapshot({ ...observation(), run: async ({ env }) => {
    calls.push(env.CLAUDE_CONFIG_DIR ?? 'default');
    return { stdout: env.CLAUDE_CONFIG_DIR ? 'work-model' : 'default-model' };
  }, detectClients: async ({ env, run }) => {
    const result = await run({ command: 'fake', args: ['models'], env });
    return { clients: [{ client, installed: true, source: 'listing', models: [result.stdout] }] };
  } });
  assert.deepEqual(calls, ['default', '/work']);
  assert.deepEqual(snapshot.clients[0].accounts.map((row) => row.models), [['default-model'], ['work-model']]);
});

test('quota tools use account reading files and refuse unknown accounts or compound client names', async (t) => {
  const root = await temporary(t);
  const deps = { ...observation(), root, readQuota: undefined, quotaCache: new Map() };
  for (const [account, pct, file] of [[undefined, 25, 'claude-code.json'], ['work', 85, 'claude-code.work.json']]) {
    const result = await quotaSet(root, { client, account, pct }, deps);
    assert.equal(result.value.remainingPct, pct);
    assert.equal((await readJson(join(root, 'quota', file))).remainingPct, pct);
    const shown = await quotaShow(root, { client, account }, { ...deps, cache: new Map() });
    assert.equal(shown.clients[0].reading.remainingPct, pct);
  }
  assert.equal((await quotaShow(root, { client }, { ...deps, cache: new Map() })).clients[0].reading.remainingPct, 25);
  for (const action of [quotaSet, quotaShow]) {
    await assert.rejects(action(root, { client, account: 'absent', ...(action === quotaSet ? { pct: 50 } : {}) }, deps), /Unknown account/);
    await assert.rejects(action(root, { client: `${client}:work`, ...(action === quotaSet ? { pct: 50 } : {}) }, deps), /valid client name/);
    await assert.rejects(action(root, { client, account: '../bad', ...(action === quotaSet ? { pct: 50 } : {}) }, deps), /Invalid account id/);
  }
});

test('Windows uses USERPROFILE for login and snapshot paths when HOME differs', async () => {
  const env = { HOME: '/wrong', USERPROFILE: '/profile' };
  const seen = [];
  const disk = { async stat(path) { seen.push(path); return { isFile: () => true }; },
    async readFile() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } };
  assert.equal(homeOf(env, 'win32'), '/profile');
  assert.equal(homeOf(env, 'linux'), '/wrong');
  assert.equal(homeOf({ HOME: '/fallback' }, 'win32'), '/fallback');
  assert.equal(await loginState({ client, env, platform: 'win32', fs: disk }), 'logged-in');
  assert.deepEqual(seen, [join('/profile', '.claude', '.credentials.json')]);
  const snapshot = await environmentSnapshot({ ...observation({}), home: undefined, env, platform: 'win32', fs: disk });
  assert.equal(snapshot.clients[0].configPath, join('/profile', '.claude'));
  assert.equal(snapshot.plugin.statusline.path, join('/profile', '.claude', 'settings.json'));
});

test('account list localizes invalid JSON without exposing contents or parser errors', async (t) => {
  const root = await temporary(t);
  await fs.writeFile(join(root, 'config.json'), 'SECRET_D115');
  const stdout = [], stderr = [];
  const code = await main(['account', 'list', '--locale', 'pt-BR'], {
    root, env: { HOME: root }, stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line),
  });
  assert.equal(code, 1);
  const output = [...stdout, ...stderr].join('\n');
  assert.match(output, /Não foi possível ler os ajustes/);
  assert.doesNotMatch(output, /SECRET_D115|Unexpected|token|valid JSON|Settings could not/);
  await assert.rejects(readJson(join(root, 'config.json')), (error) => {
    assert.doesNotMatch(error.message, /SECRET_D115|Unexpected|token|not valid JSON/);
    return true;
  });
});

test('MCP account schemas and handlers share the account contract', async (t) => {
  const root = await temporary(t);
  for (const name of ['acquire_slot', 'limits_status', 'quota_set', 'quota_show']) {
    const tool = TOOLS.find((entry) => entry.name === name);
    assert.equal(tool.inputSchema.properties.account.pattern, '^[a-z0-9-]{1,32}$');
  }
  const tool = TOOLS.find((entry) => entry.name === 'acquire_slot');
  await tool.handler({ client, account: 'work', runId: 'mcp-work' }, { root, config: { accounts } });
  assert.equal((await readJson(join(root, 'runs/mcp-work.json'))).account, 'work');
});

test('writing process metadata preserves the account of an existing slot', async (t) => {
  const root = await temporary(t);
  await acquireSlot(root, 'reserved', { client, account: 'work' });
  const spawn = makeSpawner({ logDir: join(root, 'runs'), cwd: root,
    spawn: () => ({ pid: 123, on() {}, unref() {} }) });
  await spawn({ title: 'Account metadata' }, { client, runId: 'reserved', profile: { model: 'm' } });
  assert.equal((await readJson(join(root, 'runs/reserved.json'))).account, 'work');
  assert.deepEqual((await limitsStatus(root)).byClient, { [`${client}:work`]: 1 });
});

// | Run files | hand-edited bad account still counted | limits_status throwing on it |
test('a hand-edited run file with an invalid account still counts under its bare client', async (t) => {
  const root = await temporary(t);
  await fs.mkdir(join(root, 'runs'), { recursive: true });
  await fs.writeFile(join(root, 'runs/odd.json'), JSON.stringify({ runId: 'odd', client, account: '../bad', status: 'live', startedAt: Date.now() }));
  const limits = await limitsStatus(root, { accounts });
  assert.equal(limits.live, 1);
  assert.deepEqual(limits.byClient, { [client]: 1 });
});

// | Detection | only the asked client is listed | listing every adapter for each account |
test('detectClients lists only the requested client when one is named', async () => {
  const calls = [];
  const adapter = (name) => ({ CLIENT: name, async listModels() { calls.push(name); return { models: ['m'], source: 'listing' }; } });
  const adapters = [adapter('claude-code'), adapter('codex')];
  const only = await detectClients({ adapters, onlyClient: 'codex' });
  assert.deepEqual(only.clients.map((row) => row.client), ['codex']);
  assert.deepEqual(calls, ['codex']);
  assert.equal((await detectClients({ adapters })).clients.length, 2);
});
