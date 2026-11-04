import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSlot, canSpawn, limitsStatus } from '../src/limits.js';
import { environmentSnapshot } from '../src/env/snapshot.js';
import { readiness } from '../src/env/ready.js';
import { quotaSet, quotaShow } from '../src/core/quota.js';
import { loginState, accountWarnings } from '../src/accounts-login.js';
import { homeOf } from '../src/install/config.js';
import { main } from '../src/cli.js';
import { TOOLS } from '../src/mcp/tools.js';
import { readJson } from '../src/state.js';
import { makeSpawner } from '../src/spawn-process.js';
import { statusTable } from '../src/status.js';
import { detectClients } from '../src/env/models.js';
import { accountsProblem, accountOfConfigDir, accountsOf, withAccountAdded, withAccountRenamed } from '../src/accounts.js';
import { roleContext, formatRoleContext } from '../src/roles.js';
import { readinessRows } from '../src/doctor/ready-rows.js';
import { formatEnvironmentReport } from '../src/env/report.js';
import { listActors } from '../src/actors.js';
import { configSet } from '../src/core/config.js';
import { localizeReason, powershellLiteral } from '../src/install/present.js';
import { accountInstructions } from '../src/cli-present.js';
import { quotedWord } from '../src/install/mcp-register.js';
import { collectStatusline, statuslineCommand } from '../src/quota/statusline-collector.js';
import { paths } from '../src/store.js';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import * as codex from '../adapters/codex/index.js';
import * as claude from '../adapters/claude-code/index.js';
import { readCodexSessionQuota } from '../adapters/codex/session-quota.js';
import { trajectory, validate } from '../src/trajectory/schema.js';
import { exportTrajectory, list as trajectoryList, show } from '../src/trajectory/index.js';
import { redact } from '../src/telemetry/catalog.js';
import childProcess from 'node:child_process';
import { daemonOperation } from '../src/core/daemon.js';
import { inboxAdd } from '../src/inbox.js';
import { callTool, respond } from '../src/mcp/server.js';
import { labelsOf } from '../src/env/quota.js';

// | Round 4 | Must pass | Must refuse |
// | Guidance | bare client and stable extra id; unchanged default | display label as client |
// | MCP errors | saved/request language and every account reason | raw English in pt-BR |
test('round 4: MCP localizes unknown and invalid accounts for every account tool', async t => {
  const root = await temporary(t);
  for (const name of ['quota_show', 'quota_set', 'acquire_slot', 'limits_status']) {
    for (const [account, expected] of [['ghost', 'Conta desconhecida.'], ['../bad', 'Id de conta inválido.']]) {
      const args = { client: 'codex', account, ...(name === 'quota_set' ? { pct: 50 } : {}),
        ...(name === 'acquire_slot' ? { runId: 'round4' } : {}) };
      const response = await respond({ jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name, arguments: args } }, { tools: TOOLS, ctx: { root, config: { language: 'pt-BR' } } });
      assert.equal(response.result.isError, true, name);
      assert.equal(response.result.content[0].text, expected, name);
    }
  }
});

test('round 4: every account refusal uses the CLI localizer at the MCP boundary', async t => {
  const root = await temporary(t);
  const reasons = [
    ['Unknown account.', 'Conta desconhecida.'],
    ['Invalid account id.', 'Id de conta inválido.'],
    ['Unsupported account client.', 'Cliente de conta não suportado.'],
    ['Account folder must be absolute on this system.', 'A pasta da conta deve ser absoluta neste sistema.'],
    ['Account folders must be unique within the client.', 'As pastas das contas devem ser únicas no cliente.'],
    ['Account label must be non-empty text of at most 40 characters without controls.', 'O nome da conta deve ser um texto não vazio de até 40 caracteres sem controles.'],
    ['Account labels must be unique within the client.', 'Os nomes das contas devem ser únicos no cliente.'],
    ['Use unique account ids, valid labels and absolute config directories; default has no directory.', 'Utilize ids de conta únicos, nomes válidos e pastas de configuração absolutas; default não tem pasta.'],
    ['The default account cannot be removed.', 'A conta default não pode ser removida.'],
    ['Account configuration must be an object with readable profiles.', 'A configuração de contas deve ser um objeto com perfis legíveis.'],
    ['Cannot update settings (EACCES).', 'Não foi possível atualizar os ajustes (EACCES).'],
    ['Cannot update settings (ENOSPC).', 'Não foi possível atualizar os ajustes (ENOSPC).'],
    ['Settings could not be read. Inspect them: MCP config_get {}', 'Não foi possível ler os ajustes. Confira: MCP config_get {}'],
  ];
  for (const [en, pt] of reasons) {
    const tools = [{ name: 'refusal', handler: async () => { throw new Error(en); } }];
    for (const [config, args, expected] of [
      [{ language: 'pt-BR' }, {}, pt], [{ language: 'en' }, { locale: 'pt-BR' }, pt],
      [{ language: 'pt-BR' }, { locale: 'en' }, en], [{}, {}, en],
    ]) {
      assert.equal((await callTool(tools, { root, config }, 'refusal', args)).text, expected, en);
    }
    assert.equal(localizeReason(en, 'pt-BR'), pt);
    assert.equal((await callTool([{ name: 'refusal', handler: () => { throw new Error(pt); } }],
      { root, config: { language: 'pt-BR' } }, 'refusal', {})).text, pt);
    await fs.writeFile(join(root, 'config.json'), JSON.stringify({ language: 'pt-BR' }));
    assert.equal((await callTool(tools, { root }, 'refusal', {})).text, pt);
  }
});

const client = 'claude-code';
const accounts = { [client]: [{ id: 'work', label: 'Work', configDir: '/work' }] };
const round3Accounts = { accounts: Object.fromEntries(['codex', 'claude-code'].map(name =>
  [name, [{ id: 'work', label: 'Renamed label', configDir: `/accounts/${name}/work` }]])) };
const childStub = () => Object.assign(new EventEmitter(), { pid: 123, unref() {} });
test('round 4: account guidance targets stable ids and can be followed without changing default quota', async t => {
  const root = await temporary(t);
  const config = { accounts: { codex: [{ id: 'work', label: 'Production', configDir: '/work' }] },
    profiles: { codex: { simple: { model: 'm' }, normal: { model: 'm' }, hard: { model: 'm' } } } };
  const deps = { ...observation(config), root, client: 'codex',
    versions: { codex: { installed: true } },
    readQuota: async (_client, account) => account ? null : { remainingPct: 80, source: 'manual' },
    detectClients: async () => ({ clients: [{ client: 'codex', installed: true, models: ['m'], source: 'listing' }] }) };
  const snapshot = await environmentSnapshot(deps);
  const guidance = snapshot.plugin.missing.find(entry => entry.item === 'quota');
  assert.deepEqual(guidance, { item: 'quota', client: 'codex', account: 'work', tool: 'quota_set' });
  for (const entry of [...snapshot.plugin.missing, ...snapshot.plugin.configured].filter(entry => entry?.client)) {
    assert.equal(entry.client, 'codex');
    assert.ok(entry.account === undefined || entry.account === 'work');
  }
  for (const locale of ['en', 'pt-BR']) {
    const target = locale === 'en' ? 'with the client codex and the account work' : 'com o cliente codex e a conta work';
    assert.ok(formatEnvironmentReport(snapshot, locale).includes(target));
    const status = await statusTable(root, { snapshot, locale, all: true, demands: [] });
    const actors = await listActors({ snapshot, locale, all: true });
    for (const text of [status.markdown, actors.markdown]) {
      assert.match(text, /(?:client|cliente) "codex" (?:and the account|e a conta) work/);
      assert.doesNotMatch(text, /(?:client|cliente) "codex: Production/);
    }
    const doctor = readinessRows({ snapshot, ui: { locale }, program: 'okit-plugin' });
    assert.ok(doctor.rows.find(row => row.id === 'quota' && row.account === 'work').fix.includes(target));
    assert.equal(labelsOf(locale).noQuota('codex', 'default'), labelsOf(locale).noQuota('codex'));
    assert.equal(labelsOf(locale).noQuotaAsk('codex', 'default'), labelsOf(locale).noQuotaAsk('codex'));
    assert.match(labelsOf(locale).noQuotaAsk('codex', 'work'), /(?:and the account|e a conta) work/);
  }
  await quotaSet(root, { client: 'codex', pct: 80 }, { config });
  const { tool, item: _item, ...args } = guidance;
  assert.equal((await callTool(TOOLS, { root, config }, tool, { ...args, pct: 55 })).isError, false);
  assert.equal((await readJson(join(root, 'quota/codex.json'))).remainingPct, 80);
  assert.equal((await readJson(join(root, 'quota/codex.work.json'))).remainingPct, 55);
  const noReading = await environmentSnapshot({ ...deps, cache: new Map(), readQuota: async () => null });
  assert.deepEqual(noReading.plugin.missing.filter(entry => entry.item === 'quota'), [
    { item: 'quota', client: 'codex', tool: 'quota_set' }, guidance,
  ]);
  const noModels = await environmentSnapshot({ ...deps, cache: new Map(),
    detectClients: async () => ({ clients: [{ client: 'codex', installed: true, models: [], source: 'listing' }] }) });
  assert.ok(noModels.plugin.missing.some(entry => entry.item === 'models' && entry.account === 'work' && entry.client === 'codex'));
  for (const locale of ['en', 'pt-BR']) {
    const text = (await statusTable(root, { snapshot: noModels, locale, demands: [] })).markdown;
    assert.match(text, /codex \((?:account|conta) work\)/);
    assert.match(formatEnvironmentReport(noModels, locale), /codex \((?:account|conta) work\)/);
  }
  const partial = await environmentSnapshot({ ...deps, cache: new Map(), config: { ...config,
    profiles: { codex: { simple: { model: 'm' }, normal: { model: 'absent' }, hard: { model: 'absent' } } } } });
  assert.ok(partial.plugin.missing.some(entry => entry.item === 'sizes' && entry.account === 'work' && entry.client === 'codex'));
});
test('round 3: daemon process spawning honors the supplied client environment', async t => {
  const root = await temporary(t), calls = [];
  const env = { HOME: root, CODEX_HOME: join(root, 'custom-default') };
  await fs.writeFile(join(root, 'config.json'), JSON.stringify({ profiles: { codex: {
    simple: { model: 'm' }, normal: { model: 'm' }, hard: { model: 'm' },
  } } }));
  t.mock.method(childProcess, 'spawn', (_command, _args, options) => { calls.push(options.env); return childStub(); });
  await inboxAdd(root, { title: 'test', client: 'codex' });
  const result = await daemonOperation(root, { action: 'run-once' }, { env });
  assert.equal(result.spawned.length, 1);
  assert.equal(calls[0].CODEX_HOME, env.CODEX_HOME);
});
test('round 3: Codex default quota follows sessions override, CODEX_HOME, then HOME', async t => {
  const root = await temporary(t), at = Date.now();
  const directories = [join(root, '.codex/sessions'), join(root, 'work/sessions'), join(root, 'explicit')];
  for (const [index, directory] of directories.entries()) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(join(directory, 'rollout-test.jsonl'), JSON.stringify({
      timestamp: new Date(at).toISOString(), type: 'event_msg',
      payload: { type: 'token_count', rate_limits: { primary: {
        used_percent: 10 + index * 20, window_minutes: 300, resets_at: Math.floor(at / 1000) + 3600,
      } } },
    }) + '\n');
  }
  for (const [env, expected] of [
    [{ HOME: root }, 90], [{ HOME: root, CODEX_HOME: join(root, 'work') }, 70],
    [{ HOME: root, CODEX_HOME: join(root, 'work'), CODEX_SESSIONS_DIR: directories[2] }, 50],
  ]) {
    assert.equal((await readCodexSessionQuota({ env, now: () => at })).remainingPct, expected);
    assert.equal((await codex.readQuota({ env, stateRoot: root, now: () => at })).remainingPct, expected);
  }
  const config = { accounts: { codex: [{ id: 'work', label: 'Work', configDir: join(root, 'work') }] } };
  assert.equal((await codex.readQuota({ config, stateRoot: root, account: 'work', now: () => at,
    env: { HOME: root, CODEX_SESSIONS_DIR: directories[2] } })).remainingPct, 70);
});
test('round 3: native adapter captures retain the account id', async t => {
  const root = await temporary(t);
  await fs.writeFile(join(root, 'config.json'), JSON.stringify({ ...round3Accounts, trajectory: { enabled: true } }));
  for (const adapter of [codex, claude]) {
    await adapter.spawn({ model: 'm' }, 'Role: Executor\nhello', { mode: 'NATIVE', runId: adapter.CLIENT,
      stateRoot: root, account: 'work', config: round3Accounts });
    assert.equal((await exportTrajectory(root, adapter.CLIENT)).agent.extra.account, 'work');
  }
});

test('round 3: telemetry preserves stable account ids on execution events, omitting default', () => {
  for (const event of ['profile.choice', 'role.choice', 'demand.status', 'quota.check']) {
    assert.deepEqual(redact(event, { client: 'codex', account: 'work' }), { client: 'codex', account: 'work' });
    for (const account of ['default', '/private/path', 'Display name', {}, 'x'.repeat(33)]) {
      assert.deepEqual(redact(event, { client: 'codex', account }), { client: 'codex' });
    }
  }
});
test('round 3: trajectory keeps only a non-default stable account id and remains Harbor-valid', () => {
  const context = { session_id: 'run', client: 'codex', model: 'm' };
  const steps = [{ message: 'hello' }];
  const original = trajectory(context, steps);
  assert.deepEqual(trajectory({ ...context, account: 'default' }, steps), original);
  const work = trajectory({ ...context, account: 'work', label: 'Renamed', configDir: '/private/path' }, steps);
  assert.equal(work.agent.extra.account, 'work');
  assert.equal(validate(work), true);
  assert.equal(JSON.stringify(work).includes('/private/path'), false);
  assert.equal(JSON.stringify(work).includes('Renamed'), false);
});

test('round 3: reserved account survives process capture, export, list and trajectory_show', async t => {
  const root = await temporary(t);
  await fs.writeFile(join(root, 'config.json'), JSON.stringify({ ...round3Accounts, trajectory: { enabled: true } }));
  await acquireSlot(root, 'captured', { client: 'codex', account: 'work', config: round3Accounts });
  const child = childStub();
  await makeSpawner({ logDir: join(root, 'runs'), cwd: root, env: {}, spawn: () => child })(
    { title: 'hello' }, { client: 'codex', runId: 'captured', profile: { model: 'm' } });
  child.emit('close', 0);
  let saved;
  for (let n = 0; n < 100 && !saved; n++) {
    saved = await exportTrajectory(root, 'captured').catch(() => null);
    if (!saved) await sleep(10);
  }
  assert.equal(saved?.agent.extra.account, 'work');
  assert.equal(validate(saved), true);
  assert.equal((await trajectoryList(root))[0].account, 'work');
  assert.match(await show(root, 'captured'), /Account \/ Conta: work/);
});
test('round 3: adapters forward account selection to process spawning and model listing', async t => {
  const root = await temporary(t);
  for (const adapter of [codex, claude]) {
    const variable = adapter.CLIENT === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
    let received;
    await adapter.spawn({ model: 'm' }, 'Role: Executor\ntest', { mode: 'PROCESS', runId: adapter.CLIENT,
      config: round3Accounts, account: 'work', logDir: join(root, 'runs'), cwd: root, env: {},
      spawn: (_command, _args, options) => { received = options.env; return childStub(); } });
    assert.equal(received[variable], `/accounts/${adapter.CLIENT}/work`);
    await adapter.listModels({ config: round3Accounts, account: 'work', env: {},
      run: async ({ env }) => { received = env; return { code: 0, stdout: '[]' }; } });
    assert.equal(received[variable], `/accounts/${adapter.CLIENT}/work`);
    await assert.rejects(adapter.listModels({ config: round3Accounts, account: 'ghost', env: {} }), /Unknown account/);
  }
});

// | Round 3 | Must pass | Must refuse |
// | Processes | default env unchanged; explicit or reserved account env | unknown account before spawn |
// | History | stable id through capture/export/list/show; Harbor validation | label/path as identity |
// | Sessions | explicit sessions, CODEX_HOME, HOME precedence | cross-account quota |
test('round 3: spawn uses the selected or reserved account environment for both clients', async t => {
  const root = await temporary(t), calls = [];
  await fs.writeFile(join(root, 'config.json'), JSON.stringify(round3Accounts));
  const env = { HOME: root, CODEX_HOME: '/default/codex', CLAUDE_CONFIG_DIR: '/default/claude', KEEP: 'same' };
  const spawn = makeSpawner({ logDir: join(root, 'runs'), cwd: root, env,
    spawn: (_command, _args, options) => { calls.push(options.env); return childStub(); } });
  for (const client of ['codex', 'claude-code']) {
    for (const [index, account] of [undefined, 'default', 'work'].entries()) {
      const runId = `${client}-${index}`;
      await spawn({ title: 'test' }, { client, runId, account, profile: { model: 'm' } });
      const variable = client === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
      assert.deepEqual(calls.at(-1), { ...env, ...(account === 'work'
        ? { [variable]: `/accounts/${client}/work` } : {}), OKWORK_NO_DAEMON: '1' });
      assert.equal((await readJson(join(root, 'runs', `${runId}.json`))).account, account === 'work' ? 'work' : undefined);
    }
    await acquireSlot(root, `${client}-reserved`, { client, account: 'work', config: round3Accounts });
    await spawn({ title: 'reserved' }, { client, runId: `${client}-reserved`, profile: { model: 'm' } });
    assert.equal(calls.at(-1)[client === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'], `/accounts/${client}/work`);
    const count = calls.length;
    await assert.rejects(spawn({ title: 'bad' }, { client, runId: 'bad', account: 'ghost', profile: { model: 'm' } }), /Unknown account/);
    assert.equal(calls.length, count);
  }
});
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
// | Round 2 ids | configured default/work | ghost ids in slots/status/spawn/quota/CLI |
// | Round 2 paths | distinct native absolute folders | lexical duplicates, foreign add paths |
// | Round 2 reports | installed extra with absent default | hiding the extra |
// | Round 2 disk | localized code on add/remove/rename/config_set | OS text or paths |
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
  await fs.writeFile(join(root, 'config.json'), JSON.stringify({ accounts }));
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

test('round 2: every account input refuses a valid but unknown slug', async (t) => {
  const root = await temporary(t);
  const config = { accounts };
  await fs.writeFile(join(root, 'config.json'), JSON.stringify(config));
  for (const account of ['ghost-a', 'ghost-b']) {
    await assert.rejects(acquireSlot(root, account, { client, account, config }), /Unknown account/);
    await assert.rejects(canSpawn(root, { client, account, config }), /Unknown account/);
    await assert.rejects(limitsStatus(root, config, { client, account }), /Unknown account/);
    for (const name of ['acquire_slot', 'limits_status', 'quota_show', 'quota_set']) {
      const args = { client, account, ...(name === 'acquire_slot' ? { runId: account } : {}),
        ...(name === 'quota_set' ? { pct: 50 } : {}) };
      await assert.rejects(TOOLS.find((tool) => tool.name === name).handler(args, { root, config }), /Unknown account/);
    }
    for (const action of ['remove', 'rename']) {
      const output = [];
      assert.equal(await main(['account', action, client, account, ...(action === 'rename' ? ['New'] : [])],
        { root, env: { HOME: root }, stdout() {}, stderr: (line) => output.push(line) }), 2);
      assert.match(output.join('\n'), /Unknown account/);
    }
  }
  assert.deepEqual((await limitsStatus(root, config)).byClient, {});
});

test('round 2: unknown saved run accounts never consume the slots of a saved account (round 8: nor the default\'s)', async (t) => {
  const root = await temporary(t);
  const config = { accounts, limits: { clients: { [client]: 1 } } };
  await fs.mkdir(join(root, 'runs'));
  await fs.writeFile(join(root, 'runs/ghost.json'), JSON.stringify({ client, account: 'ghost-a', status: 'live' }));
  assert.deepEqual((await limitsStatus(root, config)).byClient, { [`${client}:ghost-a`]: 1 });
  assert.equal((await canSpawn(root, { client, config })).ok, true);
  assert.equal((await acquireSlot(root, 'default', { client, config })).ok, true);
  assert.equal((await canSpawn(root, { client, account: 'work', config })).ok, true);
});

test('round 2: add and saved mutations refuse normalized duplicate account folders', () => {
  for (const [platform, directory, aliases] of [
    ['linux', '/tmp/shared', ['/tmp/shared', '/tmp/shared/', '/tmp/a/../shared']],
    ['win32', 'C:\\Accounts\\Work', ['c:\\accounts\\work\\', 'C:\\Accounts\\a\\..\\Work']],
  ]) {
    const config = { accounts: { codex: [{ id: 'one', label: 'One', configDir: directory }] } };
    for (const alias of aliases) {
      assert.throws(() => withAccountAdded(config, 'codex', 'Two', alias, { platform, env: {} }), /folders must be unique/);
      assert.throws(() => withAccountAdded({}, 'codex', 'Two', alias,
        { platform, env: { CODEX_HOME: directory } }), /folders must be unique/);
      assert.throws(() => withAccountAdded({}, 'codex', 'Two', alias,
        { platform, env: {}, defaultDir: directory }), /folders must be unique/);
      assert.throws(() => withAccountRenamed(config, 'codex', 'one', 'Renamed',
        { platform, env: {}, defaultDir: alias }), /folders must be unique/);
      const saved = { codex: [...config.accounts.codex, { id: 'two', label: 'Two', configDir: alias }] };
      assert.ok(accountsProblem(saved, { platform, env: {} }));
      if (platform === process.platform) assert.throws(() => withAccountRenamed({ accounts: saved }, 'codex', 'two', 'Renamed'), /unique/);
    }
    assert.equal(accountsProblem(config.accounts, { platform, env: {} }), null);
    assert.ok(accountsProblem(config.accounts, { platform, env: { CODEX_HOME: directory } }));
  }
});

test('round 2: reading saved accounts does not mistake a collector environment for the default', () => {
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = '/tmp/collector-work';
  try {
    const saved = { codex: [{ id: 'work', label: 'Work', configDir: '/tmp/collector-work' }] };
    assert.equal(accountsProblem(saved), null);
    assert.ok(accountsProblem(saved, { env: process.env, platform: 'linux' }));
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test('round 2: CLI add refuses the known default folder and lexical aliases of extras', async (t) => {
  const root = await temporary(t);
  const directory = join(root, 'shared');
  const config = { accounts: { codex: [{ id: 'one', label: 'One', configDir: directory }] } };
  for (const [saved, folder] of [[{}, join(root, '.codex')], [config, `${directory}/`]]) {
    await fs.writeFile(join(root, 'config.json'), JSON.stringify(saved));
    const output = [];
    assert.equal(await main(['account', 'add', 'codex', 'Two', '--config-dir', folder, '--locale', 'pt-BR'],
      { root, env: { HOME: root }, stdout() {}, stderr: (line) => output.push(line) }), 2);
    assert.match(output.join('\n'), /pastas das contas devem ser únicas/);
    assert.deepEqual(await readJson(join(root, 'config.json')), saved);
  }
});

test('round 2: new folders must be absolute on the host; saved foreign paths remain readable', async (t) => {
  for (const [platform, pass, refuse] of [
    ['linux', '/accounts/work', 'C:\\Accounts\\Work'],
    ['darwin', '/accounts/work', 'C:\\Accounts\\Work'],
    ['win32', 'C:\\Accounts\\Work', 'C:Accounts\\Work'],
  ]) {
    assert.doesNotThrow(() => withAccountAdded({}, 'codex', 'Work', pass, { platform, env: {} }));
    assert.throws(() => withAccountAdded({}, 'codex', 'Work', refuse, { platform, env: {} }), /absolute on this system/);
  }
  assert.equal(accountsProblem({ codex: [{ id: 'work', label: 'Work', configDir: 'C:\\Accounts\\Work' }] },
    { platform: 'linux', env: {} }), null);
  if (process.platform === 'win32') return;
  const root = await temporary(t);
  const output = [];
  const code = await main(['account', 'add', 'codex', 'W', '--config-dir', 'C:\\Accounts\\Work', '--locale', 'pt-BR'],
    { root, env: { HOME: root }, stdout() {}, stderr: (line) => output.push(line) });
  assert.equal(code, 2);
  assert.match(output.join('\n'), /absoluta neste sistema/);
  assert.equal(await readJson(join(root, 'config.json'), null), null);
});

test('round 2: doctor and every account report retain an installed extra when default is absent', async () => {
  const config = { accounts, profiles: { [client]: {
    simple: { model: 'm' }, normal: { model: 'm' }, hard: { model: 'm' } } } };
  const snapshot = await environmentSnapshot({ ...observation(config), versions: { [client]: { installed: false } },
    detectClients: async ({ env }) => ({ clients: [{ client, installed: Boolean(env.CLAUDE_CONFIG_DIR),
      source: 'listing', models: ['m'] }] }) });
  const doctor = readinessRows({ snapshot, ui: { locale: 'en' }, program: 'okit-plugin' });
  assert.equal(doctor.rows.some((row) => row.id === 'clients'), false);
  assert.ok(doctor.rows.some((row) => row.id === 'models' && row.account === 'work'));
  assert.equal(doctor.rows.some((row) => row.account === 'default'), false);
  assert.equal(doctor.ready, true);
  assert.match(formatEnvironmentReport(snapshot), /claude-code: Work \(work\): installed/);
  assert.ok((await listActors({ snapshot })).actors.some((row) => row.cells.some((cell) => String(cell).includes('Work (work)'))));
  const status = await statusTable('', { snapshot, all: true, demands: [] });
  assert.match(status.capacityLine, /Work \(work\)/);
  assert.equal(readiness(snapshot).accounts[0].ready, 1);
});

test('round 2: account add localizes mkdir failures without OS text or paths', async (t) => {
  const root = await temporary(t);
  const blocker = join(root, 'PRIVATE_PATH');
  await fs.writeFile(blocker, 'file');
  const output = [];
  const code = await main(['account', 'add', 'codex', 'Work', '--config-dir', join(blocker, 'work'), '--locale', 'pt-BR'],
    { root, env: { HOME: root }, stdout() {}, stderr: (line) => output.push(line) });
  assert.equal(code, 1);
  assert.match(output.join('\n'), /Não foi possível atualizar os ajustes \(E(?:NOTDIR|EXIST)\)/);
  assert.doesNotMatch(output.join('\n'), /PRIVATE_PATH|mkdir|not a directory|Cannot update/);
  assert.equal(await readJson(join(root, 'config.json'), null), null);
});

test('round 2: all account mutations sanitize write and lock-directory failures', async (t) => {
  for (const failure of ['write', 'wrapped-write', 'locks']) {
    for (const action of ['add', 'remove', 'rename']) {
      const root = await temporary(t);
      await fs.writeFile(join(root, 'config.json'), JSON.stringify({ accounts }));
      const output = [];
      const error = Object.assign(new Error('PRIVATE_PATH: raw filesystem text'), { code: 'EACCES' });
      const io = { root, env: { HOME: root }, stdout() {}, stderr: (line) => output.push(line),
        ...(failure !== 'locks' ? { writeConfig: async () => {
          throw failure === 'write' ? error : new Error('PRIVATE_PATH: wrapped filesystem text', { cause: error });
        } }
          : { fs: { ...fs, mkdir: async () => { throw error; } } }) };
      const args = action === 'add' ? ['New', '--config-dir', join(root, 'new')]
        : ['work', ...(action === 'rename' ? ['Renamed'] : [])];
      assert.equal(await main(['account', action, client, ...args, '--locale', 'pt-BR'], io), 1);
      assert.match(output.join('\n'), /Não foi possível atualizar os ajustes \(EACCES\)/);
      assert.doesNotMatch(output.join('\n'), /PRIVATE_PATH|raw filesystem/);
      assert.deepEqual((await readJson(join(root, 'config.json'))).accounts, accounts);
    }
  }
});

test('round 2: config_set sanitizes writer and lock-directory errors', async (t) => {
  const root = await temporary(t);
  const error = Object.assign(new Error('PRIVATE_PATH: raw filesystem text'), { code: 'ENOSPC' });
  await assert.rejects(configSet(root, { key: 'language', value: 'en' }, { write: async () => { throw error; } }), (failure) => {
    assert.equal(failure.message, 'Cannot update settings (ENOSPC).');
    assert.equal(localizeReason(failure.message, 'pt-BR'), 'Não foi possível atualizar os ajustes (ENOSPC).');
    return true;
  });
  await assert.rejects(configSet(root, { key: 'language', value: 'en' }, { write: async () => {
    throw new Error('PRIVATE_PATH: wrapped filesystem text', { cause: error });
  } }), /Cannot update settings \(ENOSPC\)/);
  const blocked = await temporary(t);
  await fs.writeFile(join(blocked, 'locks'), 'file');
  await assert.rejects(configSet(blocked, { key: 'language', value: 'en' }), /Cannot update settings \(EEXIST\)/);
});

// | Round 5 | Must pass | Must refuse |
// | Rows | pure client and stable account id in every account payload | the display text as the client |
// | Quotes | every PowerShell delimiter doubled | a bare quote inside the string |
// | Collector | an unregistered folder writes nothing | the reading of the default overwritten |
// | Configured | one entry per account, with its id | the same entry twice |

const accountPairs = (rows) => [...new Set(rows.map((row) => `${row.client}/${row.account}`))].sort();

test('round 5: every account row of the JSON payloads names the pure client and the stable account id', async t => {
  const root = await temporary(t);
  const config = { accounts: { 'claude-code': [{ id: 'work', label: 'Producer', configDir: '/work' }] },
    profiles: { 'claude-code': { simple: { model: 'm' }, normal: { model: 'm' }, hard: { model: 'm' } } } };
  const deps = { ...observation(config), root };
  const snapshot = await environmentSnapshot(deps);
  const status = await statusTable(root, { snapshot, all: true, demands: [] });
  assert.deepEqual(accountPairs(status.rows), ['claude-code/default', 'claude-code/work']);
  for (const row of status.rows) {
    assert.match(row.cells[0], /^claude-code: /, 'the table keeps the display text');
    assert.equal(Object.hasOwn(row, 'label'), false, 'the label is not a field of the row');
  }
  const actors = await listActors({ snapshot, all: true });
  assert.deepEqual(accountPairs(actors.actors), ['claude-code/default', 'claude-code/work']);
  assert.deepEqual(accountPairs(snapshot.clients[0].accounts), ['claude-code/default', 'claude-code/work']);
  const doctor = readinessRows({ snapshot, ui: { locale: 'en' }, program: 'okit-plugin' });
  assert.deepEqual(accountPairs(doctor.rows.filter((row) => row.client)), ['claude-code/default', 'claude-code/work']);
  const shown = await quotaShow(root, { client: 'claude-code' }, { ...deps, config, cache: new Map() });
  assert.deepEqual(shown.clients.map((row) => [row.client, row.account]), [['claude-code', 'default']]);
  // The caps are counted under the pure client and the stable id, never under the label.
  await acquireSlot(root, 'row-check', { client, account: 'work', config });
  const limits = await limitsStatus(root, config);
  assert.deepEqual(Object.keys(limits.byClient).sort(), ['claude-code:work']);
  assert.ok(limits.caps['claude-code'] && limits.caps['claude-code:work']);
  const renamedLimits = await limitsStatus(root, { ...config,
    accounts: { 'claude-code': [{ id: 'work', label: 'Renamed', configDir: '/work' }] } });
  assert.deepEqual(Object.keys(renamedLimits.byClient).sort(), Object.keys(limits.byClient).sort());
  const renamed = await environmentSnapshot({ ...deps, cache: new Map(),
    config: { ...config, accounts: { 'claude-code': [{ id: 'work', label: 'Renamed', configDir: '/work' }] } } });
  const renamedStatus = await statusTable(root, { snapshot: renamed, all: true, demands: [] });
  assert.deepEqual(renamedStatus.rows.map((row) => [row.client, row.account]),
    status.rows.map((row) => [row.client, row.account]));
  assert.notDeepEqual(renamedStatus.rows.map((row) => row.cells[0]), status.rows.map((row) => row.cells[0]));
});

test('round 5: a client with one account keeps the JSON it always had', async t => {
  const root = await temporary(t);
  const snapshot = await environmentSnapshot({ ...observation({}), root, cache: new Map() });
  const status = await statusTable(root, { snapshot, all: true, demands: [] });
  assert.deepEqual(status.rows.map((row) => row.client), ['claude-code']);
  assert.equal(Object.hasOwn(status.rows[0], 'account'), false);
  const actors = await listActors({ snapshot, all: true });
  assert.equal(Object.hasOwn(actors.actors[0], 'account'), false);
  assert.equal(Object.hasOwn(actors.actors[0], 'label'), false);
  const shown = await quotaShow(root, { client: 'claude-code' }, { snapshot, config: {}, cache: new Map() });
  assert.equal(Object.hasOwn(shown.clients[0], 'account'), false);
});

test('round 5: every PowerShell quoting doubles every delimiter of a string', async () => {
  const directory = 'C:\\Users\\O’Brien\\acc';
  const doubled = 'C:\\Users\\O’’Brien\\acc';
  assert.equal(powershellLiteral(directory), `'${doubled}'`);
  assert.equal(quotedWord(directory, 'win32'), `'${doubled}'`);
  const instructions = accountInstructions({ client: 'codex', configDir: directory, login: 'logged-out' },
    { locale: 'en', platform: 'win32', command: 'okit-plugin', root: 'C:\\state' });
  assert.ok(instructions.some((line) => line.includes(`$env:CODEX_HOME='${doubled}'`)), instructions.join('\n'));
  for (const quote of ['‘', '’', '‚', '‛']) {
    assert.equal(powershellLiteral(`a${quote}b`), `'a${quote}${quote}b'`);
  }
});

test('round 5: no source file quotes a path for PowerShell by hand', async () => {
  const offenders = [];
  const walk = async (folder) => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.js')) {
        const text = await fs.readFile(path, 'utf8');
        // A string literal that is exactly two ASCII quotes is a hand-made doubling of a quote.
        if (/(['"])''\1/.test(text)) offenders.push(path);
      }
    }
  };
  await walk('src');
  assert.deepEqual(offenders, []);
});

const statuslineInput = (used) => Buffer.from(JSON.stringify({
  rate_limits: { five_hour: { used_percentage: used, resets_at: 1800000000 } },
}));

test('round 5: the collector never writes a folder that names no account into the file of another account', async t => {
  const root = await temporary(t);
  const quota = paths(root).quota;
  const config = { accounts: { 'claude-code': [{ id: 'work', label: 'Work', configDir: '/work' }] } };
  const defaultFile = join(quota, 'claude-code-statusline.json');
  await fs.mkdir(quota, { recursive: true });
  await fs.writeFile(defaultFile, 'the reading of the default');
  await collectStatusline({ stateRoot: root, config, now: () => 1800000000000,
    input: statuslineInput(50), env: { CLAUDE_CONFIG_DIR: '/unknown' } });
  assert.equal(await fs.readFile(defaultFile, 'utf8'), 'the reading of the default');
  assert.equal(await fs.readFile(join(quota, 'claude-code-statusline.work.json'), 'utf8').catch(() => null), null);
  await collectStatusline({ stateRoot: root, config, now: () => 1800000000000,
    input: statuslineInput(50), env: { CLAUDE_CONFIG_DIR: '/work' } });
  assert.match(await fs.readFile(join(quota, 'claude-code-statusline.work.json'), 'utf8'), /rate_limits/);
  await collectStatusline({ stateRoot: root, config, now: () => 1800000000000, input: statuslineInput(50), env: {} });
  assert.match(await fs.readFile(defaultFile, 'utf8'), /rate_limits/);
  assert.equal(accountOfConfigDir({ client: 'codex', config: { accounts: { codex: [{ id: 'work', label: 'Work', configDir: '/work' }] } },
    env: { CODEX_HOME: '/unknown' } }), null);
});

test('round 5: a client that never had accounts keeps the reading of the default it always had', async t => {
  const root = await temporary(t);
  const quota = paths(root).quota;
  await fs.mkdir(quota, { recursive: true });
  await collectStatusline({ stateRoot: root, config: {}, now: () => 1800000000000,
    input: statuslineInput(50), env: { CLAUDE_CONFIG_DIR: '/unknown' } });
  assert.match(await fs.readFile(join(quota, 'claude-code-statusline.json'), 'utf8'), /rate_limits/);
  assert.equal(accountOfConfigDir({ client: 'claude-code', config: {}, env: { CLAUDE_CONFIG_DIR: '/unknown' } }).id, 'default');
});

test('round 5: the configured entries of the environment name the account of each one', async t => {
  const root = await temporary(t);
  const config = { accounts: { 'claude-code': [{ id: 'work', label: 'Producer', configDir: '/work' }] },
    profiles: { 'claude-code': { simple: { model: 'm' }, normal: { model: 'm' }, hard: { model: 'm' } } } };
  const snapshot = await environmentSnapshot({ ...observation(config), root });
  const models = snapshot.plugin.configured.filter((entry) => entry?.item === 'models');
  assert.deepEqual(models.map((entry) => [entry.client, entry.account]),
    [['claude-code', undefined], ['claude-code', 'work']]);
  for (const locale of ['en', 'pt-BR']) {
    const text = formatEnvironmentReport(snapshot, locale);
    const [item, account] = locale === 'pt-BR' ? ['Modelos ativos', 'conta work'] : ['Active models', 'account work'];
    assert.match(text, new RegExp(`${item} \\(claude-code, ${account}\\)`), text);
    assert.equal(text.split(`${item} (claude-code)`).length - 1, 1, 'the default is listed once');
  }
  const single = await environmentSnapshot({ ...observation({ profiles: config.profiles }), root, cache: new Map() });
  assert.deepEqual(single.plugin.configured.filter((entry) => entry?.item === 'models'),
    [{ item: 'models', client: 'claude-code' }]);
});

// | Round 6 | Must pass | Must refuse |
// | Login | the folder of the install options of the person | the folder of the defaults of the installer |
// | Collector | the folder of the default account | a folder that names no account |
// | Codex | the sessions of the folder of the install options | the sessions of the defaults of the installer |

/** The person who configured a folder of their own for the Claude Code client. */
const round6Config = (root) => ({
  install: { clients: { 'claude-code': { rootParts: ['claude-custom'] } } },
  accounts: { 'claude-code': [{ id: 'work', label: 'Work', configDir: join(root, 'work') }] },
  profiles: { 'claude-code': { simple: { model: 'm' }, normal: { model: 'm' }, hard: { model: 'm' } } },
});

/** The world of one snapshot: the real file system of a temporary home, the models of one listing. */
const round6Deps = (config, root) => ({ config, env: { HOME: root }, home: root, platform: 'linux', record: false,
  now: () => 1800000000000, cache: new Map(), plugin: { onPath: true },
  versions: { 'claude-code': { installed: true, version: 'default' } },
  readQuota: async () => ({ remainingPct: 80, source: 'manual' }),
  detectClients: async () => ({ clients: [{ client: 'claude-code', installed: true, models: ['m'], source: 'listing' }] }) });


test('round 6: the login of the default account follows the install options of the person', async (t) => {
  const root = await temporary(t);
  const config = round6Config(root);
  await fs.mkdir(join(root, 'claude-custom'), { recursive: true });
  await fs.writeFile(join(root, 'claude-custom', '.credentials.json'), '{}');
  await fs.writeFile(join(root, 'config.json'), JSON.stringify(config));
  const lines = [];
  const code = await main(['account', 'list', 'claude-code'], { root, env: { HOME: root },
    stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) });
  assert.equal(code, 0);
  const rows = lines.filter((line) => line.startsWith('claude-code')).map((line) => line.split('\t'));
  assert.deepEqual(rows.map((row) => [row[1], row[4]]), [['default', 'logged-in'], ['work', 'logged-out']],
    lines.join('\n'));
  const snapshot = await environmentSnapshot(round6Deps(config, root));
  const [personal, work] = snapshot.clients[0].accounts;
  assert.equal(personal.login, 'logged-in');
  assert.equal(work.login, 'logged-out');
  assert.equal(personal.candidates.some((actor) => actor.restrictions.includes('not-logged-in')), false,
    JSON.stringify(personal.candidates));
  assert.equal(personal.configPath, join(root, 'claude-custom'));
});

test('round 6: the collector writes the reading of the default when the environment names its own folder', async (t) => {
  const root = await temporary(t);
  const quota = paths(root).quota;
  await fs.mkdir(quota, { recursive: true });
  const defaultFile = join(quota, 'claude-code-statusline.json');
  const accounts = { 'claude-code': [{ id: 'work', label: 'Work', configDir: '/work' }] };
  // The folder of the default account: with the defaults of the installer and with the install options of the person.
  for (const [config, folder] of [[{ accounts }, join(root, '.claude')],
    [{ ...round6Config(root), accounts }, join(root, 'claude-custom')]]) {
    await fs.writeFile(defaultFile, 'the reading of the default');
    await collectStatusline({ stateRoot: root, config, env: { HOME: root, CLAUDE_CONFIG_DIR: folder },
      platform: 'linux', home: root, now: () => 1800000000000, input: statuslineInput(50) });
    assert.match(await fs.readFile(defaultFile, 'utf8'), /rate_limits/, folder);
  }
  // A folder that names no account writes nothing: the reading of the default is never overwritten.
  await fs.writeFile(defaultFile, 'the reading of the default');
  await collectStatusline({ stateRoot: root, config: round6Config(root),
    env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'unknown') }, platform: 'linux', home: root,
    now: () => 1800000000000, input: statuslineInput(50) });
  assert.equal(await fs.readFile(defaultFile, 'utf8'), 'the reading of the default');
  assert.equal(await fs.readFile(join(quota, 'claude-code-statusline.work.json'), 'utf8').catch(() => null), null);
});

test('round 6: the Codex sessions of the default account follow the install options of the person', async (t) => {
  const root = await temporary(t), at = Date.now();
  const write = async (directory, used) => {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(join(directory, 'rollout-test.jsonl'), JSON.stringify({
      timestamp: new Date(at).toISOString(), type: 'event_msg',
      payload: { type: 'token_count', rate_limits: { primary: {
        used_percent: used, window_minutes: 300, resets_at: Math.floor(at / 1000) + 3600 } } },
    }) + '\n');
  };
  await write(join(root, 'codex-custom/sessions'), 10);
  await write(join(root, 'elsewhere/sessions'), 50);
  const config = { install: { clients: { codex: { rootParts: ['codex-custom'] } } } };
  const reading = await readCodexSessionQuota({ config, env: { HOME: root }, now: () => at });
  assert.equal(reading?.remainingPct, 90);
  // The folder the person configured wins over the folder of the install options.
  const configured = { ...config, codexQuota: { sessionsDirectory: join(root, 'elsewhere/sessions') } };
  assert.equal((await readCodexSessionQuota({ config: configured, env: { HOME: root }, now: () => at }))?.remainingPct, 50);
});

// | Round 7 | Must pass | Must refuse |
// | Saved accounts, variable names an unregistered folder | the default folder with no override, one warning | the folder of the variable |
// | Variable names the default's own folder or an extra | no warning | a warning |
// | No saved accounts | the variable honored, no warning, row as it was | a warning or another folder |

const round7Warnings = (snapshot) => snapshot.clients[0].accounts?.[0].warnings ?? snapshot.clients[0].warnings ?? [];

test('round 7: saved accounts and a variable naming an unregistered folder keep ONE folder for the default', async (t) => {
  const root = await temporary(t);
  const config = round6Config(root), unknown = join(root, 'unknown');
  await fs.mkdir(join(root, 'claude-custom'), { recursive: true });
  await fs.writeFile(join(root, 'claude-custom', '.credentials.json'), '{}');
  const env = { HOME: root, CLAUDE_CONFIG_DIR: unknown };
  assert.equal(await loginState({ client: 'claude-code', install: config.install, config, env, platform: 'linux', home: root }),
    'logged-in');
  const snapshot = await environmentSnapshot({ ...round6Deps(config, root), env });
  const [personal] = snapshot.clients[0].accounts;
  assert.equal(personal.configPath, join(root, 'claude-custom'));
  assert.equal(personal.login, 'logged-in');
  assert.deepEqual(round7Warnings(snapshot), [{ code: 'config-dir-unregistered', client: 'claude-code', variable: 'CLAUDE_CONFIG_DIR' }]);
  for (const locale of ['en', 'pt-BR']) {
    const doctor = readinessRows({ snapshot, ui: { locale }, program: 'okit-plugin' });
    const row = doctor.rows.find((entry) => entry.id === 'config-dir-unregistered' && entry.account === 'default');
    assert.ok(row, locale);
    assert.match(row.detail, /CLAUDE_CONFIG_DIR/);
    assert.match(row.detail, locale === 'en' ? /Register that folder as an account/ : /Cadastre essa pasta como uma conta/);
    assert.equal(row.detail.includes(unknown), false);
    assert.match(row.detail, locale === 'en' ? /neither the default account's nor a saved account's/ : /não é da conta default nem de uma conta salva/);
    assert.match(formatEnvironmentReport(snapshot, locale), /CLAUDE_CONFIG_DIR/);
  }
});

test('round 7: a variable naming the default folder or a saved extra gives no warning', async (t) => {
  const root = await temporary(t);
  const config = round6Config(root);
  for (const folder of [join(root, 'claude-custom'), join(root, 'work')]) {
    const snapshot = await environmentSnapshot({ ...round6Deps(config, root), env: { HOME: root, CLAUDE_CONFIG_DIR: folder } });
    assert.deepEqual(round7Warnings(snapshot), [], folder);
    assert.equal(readinessRows({ snapshot, ui: { locale: 'en' }, program: 'okit-plugin' })
      .rows.some((row) => row.id === 'config-dir-unregistered'), false, folder);
    assert.equal(snapshot.clients[0].accounts[0].configPath, join(root, 'claude-custom'), folder);
  }
});

test('round 7: with no saved accounts the variable is honored and nothing is reported', async (t) => {
  const root = await temporary(t);
  const config = { install: round6Config(root).install, profiles: round6Config(root).profiles };
  const unknown = join(root, 'unknown'), env = { HOME: root, CLAUDE_CONFIG_DIR: unknown };
  await fs.mkdir(unknown, { recursive: true });
  await fs.writeFile(join(unknown, '.credentials.json'), '{}');
  assert.equal(await loginState({ client: 'claude-code', install: config.install, config, env, platform: 'linux', home: root }),
    'logged-in');
  const snapshot = await environmentSnapshot({ ...round6Deps(config, root), env });
  assert.equal(snapshot.clients[0].configPath, unknown);
  assert.equal('warnings' in snapshot.clients[0], false);
  assert.equal(readinessRows({ snapshot, ui: { locale: 'en' }, program: 'okit-plugin' })
    .rows.some((row) => row.id === 'config-dir-unregistered'), false);
});

test('round 7: renaming the default (which creates the section) with the variable set reports it and keeps one folder', async (t) => {
  const root = await temporary(t);
  const base = { install: round6Config(root).install, profiles: round6Config(root).profiles };
  const renamed = withAccountRenamed(base, 'claude-code', 'default', 'Main', { env: {} });
  const unknown = join(root, 'unknown');
  const snapshot = await environmentSnapshot({ ...round6Deps(renamed, root), env: { HOME: root, CLAUDE_CONFIG_DIR: unknown } });
  assert.equal(snapshot.clients[0].configPath, join(root, 'claude-custom'));
  assert.equal(snapshot.clients[0].accounts, undefined);
  assert.deepEqual(round7Warnings(snapshot).map((warning) => warning.code), ['config-dir-unregistered']);
  const doctor = readinessRows({ snapshot, ui: { locale: 'pt-BR' }, program: 'okit-plugin' });
  assert.ok(doctor.rows.some((row) => row.id === 'config-dir-unregistered' && /CLAUDE_CONFIG_DIR/.test(row.detail)));
  assert.match((await statusTable('', { snapshot, all: true, demands: [] })).capacityLine, /CLAUDE_CONFIG_DIR/);
});

test('round 7: Codex warns by CODEX_HOME and the sessions of the default ignore an unregistered variable', async (t) => {
  const root = await temporary(t), at = Date.now();
  const write = async (directory, used) => {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(join(directory, 'rollout-test.jsonl'), JSON.stringify({
      timestamp: new Date(at).toISOString(), type: 'event_msg',
      payload: { type: 'token_count', rate_limits: { primary: {
        used_percent: used, window_minutes: 300, resets_at: Math.floor(at / 1000) + 3600 } } },
    }) + '\n');
  };
  await write(join(root, '.codex/sessions'), 10);
  await write(join(root, 'unknown/sessions'), 50);
  const env = { HOME: root, CODEX_HOME: join(root, 'unknown') };
  const saved = { accounts: { codex: [{ id: 'spare', label: 'Spare', configDir: join(root, 'spare') }] } };
  assert.equal((await readCodexSessionQuota({ config: saved, env, now: () => at }))?.remainingPct, 90);
  assert.equal((await readCodexSessionQuota({ config: {}, env, now: () => at }))?.remainingPct, 50);
  assert.deepEqual(accountWarnings('codex', env, { config: saved, platform: 'linux', home: root }),
    [{ code: 'config-dir-unregistered', client: 'codex', variable: 'CODEX_HOME' }]);
  assert.deepEqual(accountWarnings('codex', env, { config: {}, platform: 'linux', home: root }), []);
  assert.deepEqual(accountWarnings('codex', { HOME: root, CODEX_HOME: join(root, 'spare') },
    { config: saved, platform: 'linux', home: root }), []);
});

// | Round 8 | Must pass | Must refuse |
// | Collector | settings missing = no accounts; folder variable + unreadable settings = nothing written | the default's file taking another account's reading |
// | Warnings | one per client (the default's row), however many accounts | the same warning N times |
// | Collector received | any account's statusline file | only the default's file |
// | Human login | pt-BR words in `account list`/`add`; --json raw | raw English token in pt-BR |
// | Orphan run | its own key; no slot of a saved account | counted against the default |

const exists = (file) => fs.stat(file).then(() => true, () => false);

test('round 8: an unreadable config.json with the folder variable set writes no reading', async (t) => {
  const input = statuslineInput(50), run = async () => Buffer.from('bar');
  for (const [name, prepare] of [
    ['invalid JSON', (file) => fs.writeFile(file, '{ nope')],
    ['a directory', (file) => fs.mkdir(file)],
  ]) {
    const root = await temporary(t), quota = paths(root).quota;
    await prepare(join(root, 'config.json'));
    const out = [];
    await statuslineCommand(['--previous', 'echo'], { root, stdin: [input], run, stdout: (bytes) => out.push(Buffer.from(bytes)),
      now: () => 1800000000000, env: { CLAUDE_CONFIG_DIR: '/work' } });
    assert.equal(Buffer.concat(out).toString(), 'bar', `${name}: the bar still answers`);
    assert.equal(await exists(join(quota, 'claude-code-statusline.json')), false, `${name}: not in the default's file`);
    assert.equal(await exists(join(quota, 'claude-code-statusline.work.json')), false, name);
    // Without the folder variable the reading is the default's, as it always was.
    await statuslineCommand(['--previous', 'echo'], { root, stdin: [input], run, stdout() {}, now: () => 1800000000000, env: {} });
    assert.equal(await exists(join(quota, 'claude-code-statusline.json')), true, `${name}: no variable`);
  }
  // Only a missing file means "no accounts saved": the folder variable is honored as before.
  const root = await temporary(t);
  await statuslineCommand(['--previous', 'echo'], { root, stdin: [statuslineInput(50)], run, stdout() {},
    now: () => 1800000000000, env: { CLAUDE_CONFIG_DIR: '/work' } });
  assert.equal(await exists(join(paths(root).quota, 'claude-code-statusline.json')), true);
});

test('round 8: collectStatusline given an unreadable config writes nothing for a named folder', async (t) => {
  const root = await temporary(t);
  await collectStatusline({ stateRoot: root, config: {}, unreadable: true, now: () => 1800000000000,
    input: statuslineInput(50), env: { CLAUDE_CONFIG_DIR: '/work' } });
  assert.equal(await exists(paths(root).quota), false);
});

test('round 8: the warnings of the environment show once per client, however many accounts it has', async (t) => {
  const root = await temporary(t);
  const config = { ...round6Config(root), accounts: { 'claude-code': [
    { id: 'work', label: 'Work', configDir: join(root, 'work') }, { id: 'spare', label: 'Spare', configDir: join(root, 'spare') }] } };
  const env = { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'unknown'), ANTHROPIC_API_KEY: 'x' };
  const snapshot = await environmentSnapshot({ ...round6Deps(config, root), env });
  assert.equal(snapshot.clients[0].accounts.length, 3);
  assert.deepEqual(snapshot.clients[0].accounts.map((account) => account.warnings.map(({ code }) => code)),
    [['env-credential-overrides-login', 'config-dir-unregistered'], [], []]);
  for (const locale of ['en', 'pt-BR']) {
    const rows = readinessRows({ snapshot, ui: { locale }, program: 'okit-plugin' }).rows;
    for (const id of ['config-dir-unregistered', 'env-credential-overrides-login']) {
      assert.equal(rows.filter((row) => row.id === id).length, 1, `${locale}: ${id}`);
    }
    const [folder, credential] = locale === 'en' ? ['Register that folder as an account', 'overrides the stored login']
      : ['Cadastre essa pasta como uma conta', 'sobrepõe o login guardado'];
    const { capacityLine } = await statusTable('', { snapshot, all: true, demands: [], locale });
    for (const text of [formatEnvironmentReport(snapshot, locale), capacityLine]) {
      assert.equal(text.split(folder).length - 1, 1, text);
      assert.equal(text.split(credential).length - 1, 1, text);
    }
  }
});

test('round 8: the collector counts as active-with-reading when ANY account of the client has its statusline file', async () => {
  const config = { accounts: { 'claude-code': [{ id: 'work', label: 'Work', configDir: '/work' }, { id: 'spare', label: 'Spare', configDir: '/spare' }] } };
  const settings = JSON.stringify({ statusLine: { type: 'command', command: 'okit-plugin statusline-collector' } });
  const reading = async (present) => {
    const asked = [];
    const stat = async (path) => {
      asked.push(path);
      if (present.some((name) => path.endsWith(name))) return { isFile: () => true };
      throw Object.assign(new Error(), { code: 'ENOENT' });
    };
    const snapshot = await environmentSnapshot({ ...observation(config), root: '/state', cache: new Map(),
      fs: { stat, readFile: async () => settings } });
    return snapshot.plugin.statusline.received;
  };
  assert.equal(await reading(['claude-code-statusline.spare.json']), true);
  assert.equal(await reading(['claude-code-statusline.json']), true);
  assert.equal(await reading([]), false);
});

test('round 8: account list and add speak the login in pt-BR; --json stays raw', async (t) => {
  const root = await temporary(t), folder = join(root, 'work');
  await fs.writeFile(join(root, 'config.json'), JSON.stringify({
    accounts: { 'claude-code': [{ id: 'work', label: 'Work', configDir: folder }] } }));
  const run = async (args) => {
    const lines = [];
    assert.equal(await main(args, { root, env: { HOME: root }, stdout: (line) => lines.push(line), stderr() {} }), 0);
    return lines;
  };
  const human = { en: await run(['account', 'list', 'claude-code']), 'pt-BR': await run(['account', 'list', 'claude-code', '--locale', 'pt-BR']) };
  assert.match(human.en.at(-1), /\tlogged-out$/);
  assert.match(human['pt-BR'].at(-1), /\tdeslogada$/);
  assert.doesNotMatch(human['pt-BR'].join('\n'), /logged-(in|out)|\bunknown\b/);
  assert.equal(JSON.parse((await run(['account', 'list', 'claude-code', '--json', '--locale', 'pt-BR']))[0]).at(-1).login, 'logged-out');
  const added = await run(['account', 'add', 'claude-code', 'Spare', '--config-dir', join(root, 'spare'), '--locale', 'pt-BR']);
  assert.match(added[0], /\tdeslogada$/);
  assert.doesNotMatch(added[0], /logged-out/);
});

test('round 8: a run of an account that is not saved takes no slot of the default or of a saved account', async (t) => {
  const root = await temporary(t);
  const config = { accounts, limits: { clients: { [client]: 1 } } };
  await fs.mkdir(join(root, 'runs'));
  for (const [name, run] of [
    ['gone', { client, account: 'gone', status: 'live' }],
    ['plain', { client, status: 'live' }],
  ]) await fs.writeFile(join(root, `runs/${name}.json`), JSON.stringify({ ...run, runId: name, startedAt: Date.now() }));
  const status = await limitsStatus(root, config);
  assert.equal(status.byClient[client], 1, 'a run with no account is the default\'s');
  assert.equal(status.byClient[`${client}:gone`], 1, 'the removed account keeps its own key');
  assert.equal(status.byClient[`${client}:work`], undefined);
  assert.equal(status.live, 2);
  assert.deepEqual((await limitsStatus(root, config, { client, account: 'work' })).byClient, { [`${client}:work`]: 0 });
  assert.equal((await canSpawn(root, { client, account: 'work', config })).ok, true);
});

// | Round 9 | Must pass | Must refuse |
// | Collector | a config of the shape of a config (accounts absent, {} or a list per client) | a root or accounts that is null, [], text or a number, a client that is not a list |
// | Readiness | a credential variable of the client counts as a login | `not-logged-in` for a run that authenticates through the variable |
// | Role context | every account of a client, by name, with its own quota, slots and actors | the default's quota and slots under the client's name |

test('round 9: a config.json that parses but is not a config writes no reading for a named folder', async (t) => {
  const input = statuslineInput(50), run = async () => Buffer.from('bar');
  const malformed = ['null', '[]', '"text"', '5', '{"accounts":[]}', '{"accounts":null}', '{"accounts":5}',
    '{"accounts":"x"}', '{"accounts":{"claude-code":{}}}', '{"accounts":{"claude-code":5}}',
    '{"accounts":{"claude-code":[5]}}', '{"accounts":{"claude-code":[{"id":"BAD ID"}]}}'];
  for (const text of malformed) {
    const root = await temporary(t), quota = paths(root).quota;
    await fs.writeFile(join(root, 'config.json'), text);
    const out = [];
    await statuslineCommand(['--previous', 'echo'], { root, stdin: [input], run, stdout: (bytes) => out.push(Buffer.from(bytes)),
      now: () => 1800000000000, env: { CLAUDE_CONFIG_DIR: '/work' } });
    assert.equal(Buffer.concat(out).toString(), 'bar', `${text}: the bar still answers`);
    assert.equal(await exists(join(quota, 'claude-code-statusline.json')), false, `${text}: not in the default's file`);
    // Without the folder variable the reading is the default's, as it always was.
    await statuslineCommand(['--previous', 'echo'], { root, stdin: [input], run, stdout() {}, now: () => 1800000000000, env: {} });
    assert.equal(await exists(join(quota, 'claude-code-statusline.json')), true, `${text}: no variable`);
  }
  // A config of the right shape is still honored.
  for (const text of ['{}', '{"accounts":{}}']) {
    const root = await temporary(t);
    await fs.writeFile(join(root, 'config.json'), text);
    await statuslineCommand([], { root, stdin: [input], run, stdout() {}, now: () => 1800000000000, env: { CLAUDE_CONFIG_DIR: '/work' } });
    assert.equal(await exists(join(paths(root).quota, 'claude-code-statusline.json')), true, text);
  }
});

test('round 9: collectStatusline and the account readers never fall back to the default for a config of the wrong shape', async (t) => {
  const root = await temporary(t);
  const wrong = [null, [], 'text', 5, { accounts: [] }, { accounts: null }, { accounts: 5 },
    { accounts: { 'claude-code': {} } }, { accounts: { 'claude-code': [null] } }];
  for (const config of wrong) {
    const label = JSON.stringify(config);
    await collectStatusline({ stateRoot: root, config, now: () => 1800000000000, input: statuslineInput(50),
      env: { CLAUDE_CONFIG_DIR: '/work' } });
    assert.equal(await exists(paths(root).quota), false, label);
    assert.equal(accountOfConfigDir({ client: 'claude-code', config, env: { CLAUDE_CONFIG_DIR: '/work' } }), null, label);
    assert.equal(accountOfConfigDir({ client: 'claude-code', config, env: {} }).id, 'default', label);
    assert.deepEqual(accountsOf(config, 'claude-code').map(({ id }) => id), ['default'], label);
    // The warning of the environment says the folder names no account.
    assert.deepEqual(accountWarnings('claude-code', { CLAUDE_CONFIG_DIR: '/work' }, { config, platform: 'linux', home: '/h' })
      .map(({ code }) => code), ['config-dir-unregistered'], label);
  }
});

test('round 9: a credential variable of the client is a login for readiness (one account and several)', async (t) => {
  const root = await temporary(t);
  const several = round6Config(root);
  for (const variable of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    const control = await environmentSnapshot(round6Deps(several, root));
    for (const account of control.clients[0].accounts) {
      assert.equal(account.login, 'logged-out');
      assert.ok(account.candidates.every((actor) => actor.restrictions.includes('not-logged-in') && !actor.canLaunch), 'without the variable');
    }
    const snapshot = await environmentSnapshot({ ...round6Deps(several, root), env: { HOME: root, [variable]: 'x' } });
    assert.equal(snapshot.clients[0].accounts.length, 2);
    for (const account of snapshot.clients[0].accounts) {
      assert.equal(account.login, 'logged-out', 'the login field keeps the truth of the marker');
      assert.ok(account.candidates.length > 0);
      assert.ok(account.candidates.every((actor) => !actor.restrictions.includes('not-logged-in')), JSON.stringify(account.candidates));
    }
    assert.ok(snapshot.clients[0].accounts[0].warnings.some(({ code }) => code === 'env-credential-overrides-login'));
    assert.equal(readiness(snapshot).gaps.some(({ reason }) => reason === 'not-logged-in'), false);
    assert.deepEqual(readiness(snapshot).accounts, [{ client: 'claude-code', ready: 2, total: 2 }]);
    // One account: never restricted for the login, with or without the variable.
    const lone = await environmentSnapshot({ ...round6Deps({ profiles: several.profiles }, root), env: { HOME: root, [variable]: 'x' } });
    assert.ok(lone.clients[0].candidates.every((actor) => !actor.restrictions.includes('not-logged-in')));
  }
});

test('round 9: the role context lists every account of a client with its own quota, slots and actors', () => {
  const account = (id, label, remainingPct, available, model) => ({ id, label, isDefault: id === 'default',
    actors: [{ model, effort: 'high', restrictions: remainingPct < 10 ? ['low'] : [] }], quota: { remainingPct }, slots: { available } });
  const snapshot = { now: 1, clients: [{ client: 'claude-code', installed: true,
    actors: [{ model: 'm-default', effort: 'high', restrictions: [] }], quota: { remainingPct: 80 }, slots: { available: 2 },
    accounts: [account('default', 'default', 80, 2, 'm-default'), account('work', 'Work', 5, 0, 'm-work')] }] };
  const context = roleContext({ snapshot, items: [], orders: [], limits: {} });
  assert.deepEqual(context.actors.map(({ client, account: id, accountLabel, model }) => [client, id, accountLabel, model]),
    [['claude-code', 'default', 'default', 'm-default'], ['claude-code', 'work', 'Work (work)', 'm-work']]);
  const en = formatRoleContext(context), pt = formatRoleContext(context, 'pt-BR');
  assert.match(en, /claude-code: Work \(work\): m-work \+ high; quota 5%; free slots 0; restrictions: low/);
  assert.match(en, /claude-code: default: m-default \+ high; quota 80%; free slots 2; restrictions: none/);
  assert.match(pt, /claude-code: Work \(work\): m-work \+ high; cota 5%; vagas livres 0; restrições: low/);
  assert.match(pt, /claude-code: default: m-default \+ high; cota 80%; vagas livres 2; restrições: nenhum/);
  // One account: the line it always was.
  const single = roleContext({ snapshot: { now: 1, clients: [{ client: 'codex', actors: [{ model: 'c', effort: 'low', restrictions: [] }],
    quota: { remainingPct: 70 }, slots: { available: 1 } }] }, items: [], orders: [], limits: {} });
  assert.deepEqual(single.actors, [{ client: 'codex', model: 'c', effort: 'low', restrictions: [], quota: { remainingPct: 70 }, slots: { available: 1 } }]);
  assert.match(formatRoleContext(single), /Available actors: codex: c \+ low; quota 70%; free slots 1; restrictions: none/);
});
