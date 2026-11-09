import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/install-fixture.js';
import { createInstallJobs } from '../src/config-ui/install-jobs.js';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { configMtime, configSetMany } from '../src/core/config.js';
import { installerCommand } from '../src/install/index.js';
import { pathProposal } from '../src/install/link.js';
import { startConfigServer } from '../src/config-ui/server.js';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { localizeReason } from '../src/install/present.js';

// Prerequisite safety corpus for the first-run presenter:
// | Must pass | Must refuse |
// | Real core plan + separate followups + declared observations | Conflicts, failed preview, unknown core effects |
// | Reviewed followup + literal consent + current mtime | Stale job/key/preview, unknown model without confirmation |
test('real first-run core is reviewable while setup and MCP observation remain declared', async (t) => {
  const f = await fixture(t);
  let writes = 0, released = 0;
  const jobs = createInstallJobs({ root: f.root, env: f.io.env, platform: f.io.platform,
    io: f.io, run: f.io.run, compare: async () => ({ matches: true }),
    lock: async () => async () => { released++; },
    execute: async (_operation, args, _ctx, io) => {
      assert.equal(io.deferFollowups, true);
      assert.ok(args.includes('--no-panel'));
      assert.ok(args.includes('--no-execution-policy'));
      writes++; return 0;
    } });
  t.after(() => jobs.close());
  const { planId, plan } = await jobs.plan({ operation: 'install', clients: ['codex'], options: {} });
  assert.equal(plan.exitCode, 0);
  assert.ok(plan.deferred.some((item) => item.kind === 'setup' && item.followup === true));
  assert.ok(plan.deferred.some((item) => item.kind === 'mcp-ownership' && item.resolvedAtApply
    && item.command && Array.isArray(item.args) && item.decision.foreign === 'preserve'));
  assert.equal(plan.reviewable, true);
  await jobs.apply({ planId, consent: true, idempotencyKey: 'first-run' });
  await jobs.close();
  assert.equal(writes, 1);
  assert.equal(released, 1);
});

test('follow-ups need a typed service contract before a screen can request them', async () => {
  let builds = 0, writes = 0;
  const jobs = createInstallJobs({
    buildPlan: async () => { builds++; },
    execute: async () => { writes++; },
  });
  try {
    for (const operation of ['setup', 'models', 'panel']) {
      await assert.rejects(jobs.plan({ operation, clients: ['claude-code'], options: {} }),
        { status: 400, code: 'Invalid install request.' });
    }
    for (const options of [{ panel: true }, { models: [] }, { effort: 'high' }]) {
      await assert.rejects(jobs.plan({ operation: 'install', clients: ['claude-code'], options }),
        { status: 400, code: 'Invalid install request.' });
    }
    assert.equal(builds, 0);
    assert.equal(writes, 0);
  } finally { await jobs.close(); }
});

const waitFor = async (condition) => {
  for (let count = 0; count < 1000; count++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('job did not reach its safe boundary');
};
async function world(t, overrides = {}) {
  const f = await fixture(t);
  const io = { ...f.io, detectClients: async () => ({ clients: [{ client: 'codex',
    source: 'listing', installed: true, models: ['known'] }] }), ...overrides.io };
  const jobs = createInstallJobs({ root: f.root, env: f.io.env, platform: 'linux', io, run: io.run,
    buildPlan: async (_op, args) => ({ reviewable: true, clients: [{ client: args.at(-1) }],
      fingerprints: [], mutations: [], events: [] }), compare: async () => ({ matches: true }),
    lock: async () => async () => {}, execute: async () => 0, ...overrides, io });
  t.after(() => jobs.close());
  const start = async (clients = ['codex']) => {
    const { planId } = await jobs.plan({ operation: 'install', clients, options: {} });
    const result = await jobs.apply({ planId, consent: true, idempotencyKey: planId });
    await waitFor(() => !jobs.active());
    return result.jobId;
  };
  const setup = async (jobId, extra = {}) => jobs['followup-plan']({ jobId, kind: 'setup', client: 'codex',
    profiles: [{ class: 'normal', model: 'known', effort: 'high' }],
    expectedMtime: await configMtime(f.root), ...extra });
  const apply = (jobId, followupId, extra = {}) => jobs.followup({ jobId, followupId, kind: 'setup',
    consent: true, idempotencyKey: followupId, ...extra });
  return { ...f, jobs, start, setup, apply };
}

test('setup has own consent, strict schema, current job and explicit unknown-model confirmation', async (t) => {
  const f = await world(t), jobId = await f.start();
  const profiles = [{ class: 'normal', model: 'unknown', effort: 'high' }];
  await assert.rejects(f.setup(jobId, { profiles }), (error) => {
    assert.equal(error.status, 422);
    assert.match(localizeReason(error.message, 'pt-BR'), /confirme esta alteração explicitamente/); // locale:pt-BR
    return true;
  });
  for (const extra of [{ profiles: [] }, { profiles: [{ ...profiles[0], shell: 'sh' }] },
    { profiles: [{ ...profiles[0], confirm: 'true' }] }, { command: 'sh' }, { expectedMtime: 'bad' }]) {
    await assert.rejects(f.setup(jobId, extra), { status: 400 });
  }
  await assert.rejects(f.setup('old-job'), { status: 409 });
  const plan = await f.setup(jobId, { profiles: [{ ...profiles[0], confirm: true }] });
  assert.equal(plan.preview.changes[0].value, 'unknown');
  for (const extra of [{ consent: false }, { consent: 'true' }, { consent: undefined }, { shell: 'sh' }]) {
    assert.throws(() => f.apply(jobId, plan.followupId, extra), { status: 400 });
  }
  assert.throws(() => f.apply('old-job', plan.followupId), { status: 409 });
  assert.throws(() => f.apply(jobId, 'old-preview'), { status: 409 });
  assert.equal(f.jobs.snapshot().followups.length, 0);
});

test('reviewed setup saves exactly once through the locked mtime writer and preserves setup.done', async (t) => {
  let saves = 0, receivedMtime;
  const f = await world(t, { io: { saveSetup: async (root, changes, options) => {
    saves++; receivedMtime = options.expectedMtime; return configSetMany(root, changes, options);
  } } });
  const jobId = await f.start(), before = JSON.parse(await fs.readFile(join(f.root, 'config.json')));
  const plan = await f.setup(jobId);
  const [one, two] = await Promise.all([f.apply(jobId, plan.followupId), f.apply(jobId, plan.followupId)]);
  assert.equal(one.followupId, two.followupId);
  await waitFor(() => !f.jobs.active());
  const after = JSON.parse(await fs.readFile(join(f.root, 'config.json')));
  assert.equal(saves, 1);
  assert.equal(receivedMtime, plan.preview.expectedMtime);
  assert.equal(after.profiles.codex.normal.model, 'known');
  assert.deepEqual(after.setup?.done, before.setup?.done);
  assert.equal(f.jobs.snapshot().followups[0].state, 'succeeded');
  await f.apply(jobId, plan.followupId);
  assert.equal(saves, 1);
  assert.throws(() => f.apply(jobId, plan.followupId, { idempotencyKey: 'another' }), { status: 409 });
  const newer = await f.setup(jobId);
  assert.throws(() => f.apply(jobId, newer.followupId, { idempotencyKey: plan.followupId }), { status: 409 });
});

test('mtime drift refuses setup before write; concurrent followup refuses and cancellation finishes atomic save', async (t) => {
  let saves = 0, finish;
  const held = new Promise((resolve) => { finish = resolve; });
  const f = await world(t, { io: { saveSetup: async (root, changes, options) => {
    saves++; await held; return configSetMany(root, changes, options);
  } } });
  t.after(finish);
  const jobId = await f.start(), stale = await f.setup(jobId);
  const file = join(f.root, 'config.json');
  await fs.utimes(file, new Date(), new Date(stale.preview.expectedMtime + 5000));
  await assert.rejects(f.apply(jobId, stale.followupId), { status: 409 });
  assert.equal(saves, 0);
  const first = await f.setup(jobId), second = await f.setup(jobId);
  await f.apply(jobId, first.followupId);
  await waitFor(() => saves === 1);
  assert.throws(() => f.apply(jobId, second.followupId), { status: 409 });
  f.jobs.cancel();
  assert.equal(f.jobs.snapshot().followups[0].cancelRequested, true);
  finish(); await waitFor(() => !f.jobs.active());
  const result = f.jobs.snapshot();
  assert.equal(result.followups[0].state, 'cancelled');
  assert.deepEqual(result.followups[0].completed, ['setup-save']);
  assert.equal(result.result.clients[0].state, 'ok');
  assert.equal(JSON.parse(await fs.readFile(file)).profiles.codex.normal.model, 'known');
});

test('second client failure preserves first success and skips the remaining client', async (t) => {
  const attempted = [];
  const f = await world(t, { execute: async (_operation, args) => {
    attempted.push(args[args.indexOf('--client') + 1]); return attempted.length === 2 ? 1 : 0;
  } });
  await f.start(['codex', 'claude-code', 'opencode']);
  assert.deepEqual(attempted, ['codex', 'claude-code']);
  assert.deepEqual(f.jobs.snapshot().result.clients, [
    { client: 'codex', state: 'ok' }, { client: 'claude-code', state: 'failed' },
    { client: 'opencode', state: 'skipped' },
  ]);
  await assert.rejects(f.jobs['followup-plan']({ jobId: f.jobs.snapshot().jobId, kind: 'panel',
    client: 'claude-code' }), { status: 409 });
});

test('undeclared core observations, ownership conflicts and failed preview remain non-reviewable', async (t) => {
  for (const change of [ { conflicts: [{ kind: 'foreign-command' }] }, { exitCode: 2 },
    { deferred: [{ kind: 'unknown-core-effect', requiresObservation: true }] } ]) {
    const f = await fixture(t);
    const { buildInstallPlan } = await import('../src/install/plan.js');
    const plan = await buildInstallPlan('install', ['--client', 'codex', ...(change.exitCode ? ['--unknown'] : [])],
      { root: f.root, env: f.io.env, platform: 'linux', now: f.io.now, out() {} },
      { ...f.io, detect: (_command, deps) => {
        if (change.conflicts) deps.previewPlan.conflicts.push(...change.conflicts);
        if (change.deferred) deps.previewPlan.deferred.push(...change.deferred);
        return !change.exitCode;
      } });
    assert.equal(plan.reviewable, false);
    if (change.exitCode) assert.notEqual(plan.exitCode, 0);
    const jobs = createInstallJobs({ root: f.root, buildPlan: async () => plan,
      compare: async () => ({ matches: true }), lock: async () => async () => {},
      execute: () => assert.fail('incomplete core must never execute') });
    const approved = await jobs.plan({ operation: 'install', clients: ['codex'] });
    await assert.rejects(jobs.apply({ planId: approved.planId, consent: true, idempotencyKey: 'incomplete' }),
      { status: 409, code: 'Install preview is incomplete; review again.' });
    await jobs.close();
  }
});

test('Windows PATH preview declares its exact observation and append rule', async (t) => {
  const f = await fixture(t, 'win32');
  const [change] = await pathProposal({ config: f.io.config, bin: f.bin, fs, platform: 'win32' });
  assert.equal(change.resolvedAtApply, true);
  assert.equal(change.before, null);
  assert.equal(change.after, null);
  assert.equal(change.decision.bin, f.bin);
  assert.equal(change.decision.containsBinCaseInsensitive, 'unchanged');
  assert.match(change.args.at(-1), /GetEnvironmentVariable/);
});

test('panel requires Claude registration success and runs the reviewed native panelCommand once', async (t) => {
  let installs = 0;
  const f = await world(t, { io: { run: async ({ args }) => {
    if (args[1] === 'install') installs++;
    return { stdout: args[1] === 'list' ? '[]' : '' };
  } } });
  const jobId = await f.start(['claude-code', 'codex']);
  await assert.rejects(f.jobs['followup-plan']({ jobId, kind: 'panel', client: 'codex' }), { status: 400 });
  await assert.rejects(f.jobs['followup-plan']({ jobId, kind: 'panel', client: 'claude-code' }), { status: 409 });
  const ctx = { root: f.root, env: f.io.env, platform: 'linux', now: f.io.now, out() {}, run: f.io.run };
  assert.equal(await installerCommand('install', ['--client', 'claude-code', '--no-statusline', '--no-panel'],
    ctx, { ...f.io, deferFollowups: true }), 0);
  const recordFile = join(f.destination, 'install.claude-code.json');
  const record = JSON.parse(await fs.readFile(recordFile));
  const folder = join(record.path, 'adapters/claude-code/panel/.claude-plugin');
  await fs.mkdir(folder, { recursive: true }); await fs.writeFile(join(folder, 'plugin.json'), '{}');
  const plan = await f.jobs['followup-plan']({ jobId, kind: 'panel', client: 'claude-code' });
  assert.equal(plan.preview.scope, 'user');
  assert.deepEqual(plan.preview.args, ['plugin', 'install', 'okit-plugin-panel@okit-plugin', '--scope', 'user']);
  await f.apply(jobId, plan.followupId, { kind: 'panel' });
  await waitFor(() => !f.jobs.active());
  assert.equal(f.jobs.snapshot().followups[0].state, 'succeeded');
  assert.equal(installs, 1);
  assert.equal(JSON.parse(await fs.readFile(recordFile)).panel.identity, 'okit-plugin-panel@okit-plugin');
  await f.apply(jobId, plan.followupId, { kind: 'panel' }); assert.equal(installs, 1);
});

test('followup responses redact the token in preview, save results and failure reasons', async (t) => {
  const token = 'private-session-value';
  let fail = false;
  const f = await world(t, { token, io: { saveSetup: async () => {
    if (fail) throw new Error(`x-okit-token: ${token}`);
    return { changes: [{ after: token }], url: `http://127.0.0.1/?token=${token}` };
  } } });
  const jobId = await f.start();
  for (const failure of [false, true]) {
    fail = failure;
    const plan = await f.setup(jobId, { profiles: [{ class: 'normal', model: token, effort: 'high', confirm: true }] });
    assert.equal(JSON.stringify(plan).includes(token), false);
    const result = await f.apply(jobId, plan.followupId);
    assert.equal(JSON.stringify(result).includes(token), false);
    await waitFor(() => !f.jobs.active());
    assert.equal(JSON.stringify(f.jobs.snapshot()).includes(token), false);
    assert.equal(f.jobs.snapshot().followups.at(-1).state, failure ? 'failed' : 'succeeded');
  }
});

test('expired previews and previous job ids cannot reuse followup keys', async (t) => {
  let time = 0;
  const f = await world(t, { now: () => time, planTtlMs: 10 });
  const jobId = await f.start(), expired = await f.setup(jobId);
  time = 11;
  assert.throws(() => f.apply(jobId, expired.followupId), { status: 409 });
  const plan = await f.setup(jobId);
  await f.apply(jobId, plan.followupId); await waitFor(() => !f.jobs.active());
  await f.start();
  assert.throws(() => f.apply(jobId, plan.followupId), { status: 409 });
});

test('Windows policy followup previews CurrentUser and respects group policy', async (t) => {
  for (const group of [false, true]) {
    let sets = 0;
    const f = await world(t, { platform: 'win32', io: { policyExecute: async (_command, args) => {
      if (args.at(-1).startsWith('Set-')) { sets++; return { stdout: '' }; }
      return { stdout: `MachinePolicy=${group ? 'AllSigned' : 'Undefined'}\nCurrentUser=Restricted\n` };
    } } });
    const jobId = await f.start();
    const plan = await f.jobs['followup-plan']({ jobId, kind: 'policy', client: 'codex' });
    assert.equal(plan.preview.scope, 'CurrentUser');
    assert.equal(plan.preview.skipped, group);
    await f.apply(jobId, plan.followupId, { kind: 'policy' });
    await waitFor(() => !f.jobs.active());
    assert.equal(sets, group ? 0 : 1);
    assert.equal(f.jobs.snapshot().followups[0].state, 'succeeded');
  }
});

test('cancel while acquiring followup ownership prevents its first write', async (t) => {
  let locks = 0, releaseLock, saves = 0;
  const held = new Promise((resolve) => { releaseLock = resolve; });
  const f = await world(t, { lock: async () => {
    if (++locks === 2) await held;
    return async () => {};
  }, io: { saveSetup: async () => { saves++; return {}; } } });
  t.after(releaseLock);
  const jobId = await f.start(), plan = await f.setup(jobId);
  const pending = f.apply(jobId, plan.followupId);
  f.jobs.cancel(); releaseLock();
  await assert.rejects(pending, { status: 409, code: 'Install cancelled at a safe boundary.' });
  assert.equal(saves, 0);
});

function memoryTransport() {
  let handle;
  const server = new EventEmitter();
  Object.assign(server, { listen(_port, host, ready) { assert.equal(host, '127.0.0.1'); ready(); },
    address: () => ({ port: 32123 }), close(done) { done(); }, closeAllConnections() {}, unref() {} });
  return { createServer(callback) { handle = callback; return server; },
    request(session, path, { input = {}, method = 'POST', headers = {}, raw } = {}) {
      const request = Readable.from([Buffer.from(raw ?? JSON.stringify(input))]);
      Object.assign(request, { method, url: path, headers: { host: `127.0.0.1:${session.port}`,
        origin: `http://127.0.0.1:${session.port}`, 'x-okit-token': session.token,
        'content-type': 'application/json', ...headers } });
      return new Promise((resolve) => {
        const response = new EventEmitter(); response.setHeader = () => {};
        response.writeHead = (status, headers) => {
          response.status = status;
          response.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
        };
        response.end = (bytes) => { resolve({ status: response.status, body: JSON.parse(bytes), headers: response.headers }); response.emit('finish'); };
        handle(request, response);
      });
    } };
}

test('followup HTTP routes share authorization, method, JSON limits and redaction without sockets', async (t) => {
  const f = await fixture(t), transport = memoryTransport();
  const session = await startConfigServer({ root: f.root, env: f.io.env, signals: new EventEmitter(),
    createServer: transport.createServer, install: { io: { detectClients: async () => ({ clients: [] }) },
      buildPlan: async () => ({ reviewable: true, clients: [{ client: 'codex' }], events: [] }),
      execute: async () => 0, compare: async () => ({ matches: true }), lock: async () => async () => {} } });
  t.after(() => session.close());
  const request = (path, options) => transport.request(session, `/api/install/${path}`, options);
  for (const route of ['followup-plan', 'followup']) {
    for (const headers of [{ host: 'foreign.test' }, { origin: 'null' }, { origin: undefined },
      { origin: 'http://foreign.test' }, { 'x-okit-token': undefined }, { 'x-okit-token': 'bad' }]) {
      assert.equal((await request(route, { headers })).status, 403);
    }
    assert.equal((await request(`${route}?token=${session.token}`, { headers: { 'x-okit-token': undefined } })).status, 403);
    assert.equal((await request(route, { method: 'GET' })).status, 405);
    assert.equal((await request(route, { raw: '{' })).status, 400);
    assert.equal((await request(route, { raw: 'x'.repeat(65537) })).status, 413);
    const refusal = await request(route, { input: { command: session.token } });
    assert.equal(refusal.status, 400);
    assert.equal(JSON.stringify(refusal).includes(session.token), false);
    assert.equal(refusal.headers['cache-control'], 'no-store');
  }
  const core = await request('plan', { input: { operation: 'install', clients: ['codex'] } });
  const job = await request('apply', { input: { planId: core.body.planId, consent: true, idempotencyKey: 'core' } });
  await new Promise(setImmediate);
  const plan = await request('followup-plan', { input: { jobId: job.body.jobId, kind: 'setup', client: 'codex',
    expectedMtime: await configMtime(f.root), profiles: [{ class: 'normal', model: 'new', effort: 'high', confirm: true }] } });
  assert.equal(plan.status, 200);
  assert.ok(plan.body.preview.changes.length);
  const input = { jobId: job.body.jobId, kind: 'setup', followupId: plan.body.followupId, idempotencyKey: 'setup' };
  assert.equal((await request('followup', { input })).status, 400);
  assert.equal((await request('followup', { input: { ...input, consent: true } })).status, 200);
  let poll;
  for (let n = 0; n < 100; n++) {
    poll = await request('job?after=0', { method: 'GET' });
    if (poll.body.followups[0]?.state === 'succeeded') break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(poll.body.followups[0].state, 'succeeded');
  assert.deepEqual(poll.body.result.clients, [{ client: 'codex', state: 'ok' }]);
  assert.equal(JSON.stringify(poll).includes(session.token), false);
});
