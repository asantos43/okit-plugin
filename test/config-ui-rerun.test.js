import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { wizardFlow } from '../src/config-ui/wizard-flow.js';
import { wizardMain } from '../src/config-ui/wizard-client.js';
import { createInstallJobs } from '../src/config-ui/install-jobs.js';
import { wizardState } from '../src/config-ui/wizard-state.js';
import { labels } from '../src/config-ui/labels.js';
import { buildState } from '../src/config-ui/state.js';
import { main } from '../src/cli.js';
import { fixture } from './helpers/install-fixture.js';
import { wizardDom } from './helpers/wizard-dom.js';

// Must pass / must refuse (D154 rerun flows):
// | case | must pass | must refuse |
// | already installed | Update, Repair, Change models: each is a review first, then consent | a write before consent; a cancelled review that writes |
// | repair | the install run again for a recorded client, twice with one PATH block | a client with no record; destination/link options |
// | models only | no payload command, setup.done untouched | an install or update command; a fabricated setup.done |
// | restart | records and setup.done.profiles found again, nothing replayed | a half-finished write replayed |
// | partial failure | the clients that worked stay, each client says its own state | a promise of all-client rollback |

const boot = (locale = 'en', installed = { codex: { version: '1.0.0' } }) => ({ ...buildState(), locale, catalogs: labels, instance: 'view-one',
  wizard: { clients: ['codex'], options: {}, installed, setupDone: {},
    detection: [{ client: 'codex', installed: true, executable: '/bin/codex', version: '1.0' }],
    requirements: [{ key: 'node', ok: true }], recovery: [], platform: 'linux', activationMessage: 'Open a terminal' } });
const plan = { planId: 'plan-one', plan: { reviewable: true, mutations: [], deferred: [], conflicts: [] } };
const flowFixture = (locale = 'en') => {
  const calls = [];
  const flow = wizardFlow(boot(locale), async (path, method, input) => {
    calls.push({ path, method, input });
    return path === '/api/install/plan' ? { status: 200, value: plan } : { status: 200, value: { ok: true } };
  }, () => {});
  return { flow, calls };
};

test('update, repair and change models each start only a review, with the right operation and no options', async () => {
  for (const locale of ['en', 'pt-BR']) for (const operation of ['update', 'repair', 'models']) {
    const { flow, calls } = flowFixture(locale);
    await flow.rerun(operation);
    assert.equal(flow.state.screen, 'review');
    assert.deepEqual(calls.map((call) => call.path), ['/api/install/plan']);
    assert.deepEqual(calls[0].input, { operation, clients: ['codex'], options: {} });
    // Without consent nothing is applied.
    await flow.apply();
    assert.equal(calls.some((call) => call.path === '/api/install/apply'), false);
  }
});

test('a cancelled review writes nothing and goes back to a plain install', async () => {
  const { flow, calls } = flowFixture();
  await flow.rerun('repair'); flow.consent(true); flow.go('detect');
  assert.equal(flow.state.operation, 'install'); assert.equal(flow.state.consent, false);
  await flow.apply();
  assert.deepEqual(calls.map((call) => call.path), ['/api/install/plan']);
});

test('a rerun is refused when nothing is installed', async () => {
  const data = boot('en', {}); const calls = [];
  const flow = wizardFlow(data, async (path) => { calls.push(path); return { status: 200, value: plan }; }, () => {});
  await flow.rerun('update'); await flow.rerun('models');
  assert.deepEqual(calls, []);
  assert.equal(flow.state.screen, 'detect');
  assert.equal(flow.state.operation, 'install'); assert.equal(flow.state.error, '');
});

test('after the job: update and repair end at the result, models and install go on to the models', async () => {
  for (const [operation, screen] of [['update', 'result'], ['repair', 'result'], ['models', 'models']]) {
    const calls = [];
    const flow = wizardFlow(boot(), async (path) => {
      calls.push(path);
      if (path === '/api/install/plan') return { status: 200, value: plan };
      if (path === '/api/install/apply') return { status: 200, value: { jobId: 'j', state: 'applying', seq: 1, events: [], followups: [] } };
      if (path === '/api/keepalive') return { status: 200, value: { ok: true } };
      return { status: 200, value: { jobId: 'j', state: 'succeeded', seq: 2, events: [], followups: [], result: { clients: [{ client: 'codex', state: 'ok' }] } } };
    }, () => {});
    await flow.rerun(operation); flow.consent(true); await flow.apply(); await flow.poll();
    assert.equal(flow.state.screen, screen, operation);
  }
});

test('DOM: the first screen offers the three reruns only when something is installed, in both languages', async () => {
  for (const locale of ['en', 'pt-BR']) {
    const f = wizardDom(boot(locale)); wizardMain(f.win, wizardFlow, () => ({}), () => {});
    await new Promise(setImmediate);
    const t = labels[locale].wizard;
    const actions = f.nodes.get('wizard-actions').children.map((node) => [node.dataset.wizard, node.textContent]);
    for (const [name, label] of [['rerun:update', t.update], ['rerun:repair', t.repair], ['rerun:models', t.changeModels]]) {
      assert.ok(actions.some(([action, text]) => action === name && text === label), `${locale} ${name}`);
    }
    const none = wizardDom(boot(locale, {})); wizardMain(none.win, wizardFlow, () => ({}), () => {});
    await new Promise(setImmediate);
    assert.equal(none.nodes.get('wizard-actions').children.some((node) => node.dataset.wizard.startsWith('rerun:')), false);
  }
});

test('DOM: the result names setup and the panel as skipped when they did not run, and partial clients stay listed', async () => {
  for (const locale of ['en', 'pt-BR']) {
    const f = wizardDom(boot(locale)); const flow = wizardMain(f.win, wizardFlow, () => ({}), () => {});
    await new Promise(setImmediate);
    flow.state.job = { jobId: 'j', state: 'failed', followups: [], result: { clients: [{ client: 'codex', state: 'ok' }, { client: 'opencode', state: 'failed', reason: 'boom' }] } };
    flow.go('result');
    const body = f.nodes.get('wizard-body').textContent, t = labels[locale].wizard;
    assert.ok(body.includes(`codex: ${t.ok}`)); assert.ok(body.includes(`opencode: ${t.failed} boom`));
    assert.ok(body.includes(t.partial));
    assert.ok(body.includes(`${t.setupStep}: ${t.skipped}`)); assert.ok(body.includes(`${t.panelStep}: ${t.skipped}`));
  }
});

async function installed(t, clients = ['codex'], withoutBin = false) {
  const f = await fixture(t);
  // A command folder that is not on the PATH makes the installer write its one PATH block into the shell profile.
  if (withoutBin) Object.assign(f.io.env, { PATH: join(f.home, 'node-bin'), SHELL: '/bin/bash' });
  for (const client of clients) assert.equal(await main(['install', '--client', client], f.io), 0);
  const jobs = createInstallJobs({ root: f.root, env: f.io.env, platform: 'linux', io: f.io });
  t.after(() => jobs.close());
  return { f, jobs };
}
async function run(jobs, input, key = 'k1') {
  const { planId } = await jobs.plan(input);
  await jobs.apply({ planId, consent: true, idempotencyKey: key });
  for (let i = 0; i < 400 && ['applying', 'waiting'].includes(jobs.snapshot().state); i++) await new Promise((r) => setTimeout(r, 25));
  return jobs.snapshot();
}
const tree = async (folder) => (await fs.readdir(folder, { recursive: true })).sort();

test('repair is the install run again: idempotent, one PATH block, no duplicate registration', async (t) => {
  const { f, jobs } = await installed(t, ['codex'], true);
  const profile = join(f.home, f.io.config.path.shells.bash.login);
  const before = await fs.readFile(profile, 'utf8').catch(() => '');
  const first = await run(jobs, { operation: 'repair', clients: ['codex'], options: {} });
  assert.equal(first.state, 'succeeded', JSON.stringify(first.result));
  const once = await fs.readFile(profile, 'utf8').catch(() => '');
  const second = await run(jobs, { operation: 'repair', clients: ['codex'], options: {} }, 'k2');
  assert.equal(second.state, 'succeeded');
  const twice = await fs.readFile(profile, 'utf8').catch(() => '');
  assert.equal(twice, once);
  assert.equal(twice.split(f.io.config.path.begin).length - 1, 1);
  assert.ok(before.length <= twice.length);
});

test('repair refuses a client with no record and the options that move the install', async (t) => {
  const { jobs } = await installed(t);
  await assert.rejects(jobs.plan({ operation: 'repair', clients: ['opencode'], options: {} }), { status: 409, code: 'not-installed' });
  await assert.rejects(jobs.plan({ operation: 'models', clients: ['opencode'], options: {} }), { status: 409, code: 'not-installed' });
  for (const options of [{ destination: '/x' }, { noLink: true }, { prerelease: true }]) {
    await assert.rejects(jobs.plan({ operation: 'repair', clients: ['codex'], options }), { status: 400 });
  }
  await assert.rejects(jobs.plan({ operation: 'models', clients: ['codex'], options: { noPath: true } }), { status: 400 });
});

test('change models runs no install command, writes no payload and never fabricates setup.done', async (t) => {
  const { f, jobs } = await installed(t);
  const before = [await tree(f.destination), await fs.readFile(join(f.root, 'config.json'), 'utf8')];
  const executed = [];
  const guarded = createInstallJobs({ root: f.root, env: f.io.env, platform: 'linux', io: f.io,
    execute: async (...args) => { executed.push(args[0]); return 0; } });
  t.after(() => guarded.close());
  const snapshot = await run(guarded, { operation: 'models', clients: ['codex'], options: {} });
  assert.equal(snapshot.state, 'succeeded'); assert.deepEqual(executed, []);
  assert.deepEqual(snapshot.result.clients, [{ client: 'codex', state: 'ok' }]);
  assert.deepEqual([await tree(f.destination), await fs.readFile(join(f.root, 'config.json'), 'utf8')], before);
  assert.equal(JSON.parse(before[1]).setup?.done, undefined);
});

test('update goes through the installer command with the update operation', async (t) => {
  const { f } = await installed(t);
  const executed = [];
  const jobs = createInstallJobs({ root: f.root, env: f.io.env, platform: 'linux', io: f.io,
    execute: async (operation) => { executed.push(operation); return 0; } });
  t.after(() => jobs.close());
  const snapshot = await run(jobs, { operation: 'update', clients: ['codex'], options: {} });
  assert.equal(snapshot.state, 'succeeded'); assert.deepEqual(executed, ['update']);
  await assert.rejects(jobs.plan({ operation: 'update', clients: ['codex'], options: { from: 'x' } }), { status: 400 });
});

test('restart: records and the confirmed models are found again, and no write is replayed', async (t) => {
  const { f } = await installed(t);
  const profiles = { codex: { normal: { model: 'm', effort: 'high' } } };
  const config = JSON.parse(await fs.readFile(join(f.root, 'config.json'), 'utf8'));
  config.setup = { done: { at: 'then', profiles } };
  await fs.writeFile(join(f.root, 'config.json'), JSON.stringify(config));
  const snapshot = [await tree(f.destination), await fs.readFile(join(f.root, 'config.json'), 'utf8')];
  const state = await wizardState({ root: f.root, env: f.io.env, platform: 'linux', run: async () => ({ stdout: '' }), options: {},
    io: { fs, home: f.home, config: config.install, detect: async () => '/bin/codex' } });
  assert.deepEqual(Object.keys(state.installed), ['codex']);
  assert.deepEqual(state.setupDone, profiles);
  // A new service starts with no job and no plan: nothing from before the restart runs.
  const jobs = createInstallJobs({ root: f.root, env: f.io.env, platform: 'linux', io: f.io });
  t.after(() => jobs.close());
  assert.equal(jobs.snapshot().state, 'idle');
  assert.deepEqual([await tree(f.destination), await fs.readFile(join(f.root, 'config.json'), 'utf8')], snapshot);
});

test('partial failure: the client that worked stays, the failed one says so, the rest are skipped, no rollback', async (t) => {
  const { f } = await installed(t, ['codex', 'claude-code']);
  const calls = [];
  const jobs = createInstallJobs({ root: f.root, env: f.io.env, platform: 'linux', io: f.io,
    execute: async (_operation, args) => { const client = args[args.indexOf('--client') + 1]; calls.push(client); return client === 'claude-code' ? 1 : 0; } });
  t.after(() => jobs.close());
  const snapshot = await run(jobs, { operation: 'update', clients: ['codex', 'claude-code'], options: {} });
  assert.equal(snapshot.state, 'failed');
  assert.deepEqual(snapshot.result.clients.map((row) => [row.client, row.state]), [['codex', 'ok'], ['claude-code', 'failed']]);
  assert.deepEqual(calls, ['codex', 'claude-code']);
  for (const locale of ['en', 'pt-BR']) assert.doesNotMatch(labels[locale].wizard.partial, /rollback|desfaz/i);
});

test('cleanup: the bootstrap removes its staging folder on an interrupt and survives one while the program runs', () => {
  const source = readFileSync(new URL('../src/install/bootstrap.js', import.meta.url), 'utf8');
  assert.match(source, /process\.on\?\.\('SIGINT', \(\) => \{ fs\.rm\(temporary, \{ recursive: true, force: true \}\)\.finally\(\(\) => process\.exit\(130\)\); \}\)/);
  assert.match(source, /process\.removeAllListeners\?\.\('SIGINT'\); process\.on\?\.\('SIGINT', \(\) => \{\}\);\n\s+const result = spawnSync/);
  assert.match(source, /finally \{ await fs\.rm\(temporary, \{ recursive: true, force: true \}\); \}/);
});
