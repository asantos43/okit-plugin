import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createInstallJobs, acquireInstallLock } from '../src/config-ui/install-jobs.js';
import { startConfigServer } from '../src/config-ui/server.js';

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const preview = async (_operation, args) => ({ reviewable: true, fingerprints: [], mutations: [],
  clients: [{ client: args.at(-1) }], events: [{ stage: 'sequence', params: { keys: ['files', 'register'] } }] });
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'okit-jobs-'));
  const env = { HOME: root, CLAUDE_CONFIG_DIR: root, CODEX_HOME: root };
  const jobs = createInstallJobs({ root, env, buildPlan: preview, compare: async () => ({ matches: true }), ...options });
  t.after(async () => { await jobs.close(); await rm(root, { recursive: true, force: true }); });
  return { root, env, jobs };
}
const requestPlan = { operation: 'install', clients: ['codex'], options: {} };
const apply = (planId, idempotencyKey = 'one') => ({ planId, consent: true, idempotencyKey });
const status = (code) => (error) => error.status === code;

// | Must pass | Must refuse before lock/execute/write |
// | consent: true | false, string "true", absent consent |
test('N2 consent must be literal true before any service lock or write', async (t) => {
  const calls = { lock: 0, execute: 0, write: 0 };
  const { jobs } = await fixture(t, {
    lock: async () => { calls.lock++; return async () => {}; },
    io: { write: () => { calls.write++; } },
    execute: async (_op, _args, _ctx, io) => { calls.execute++; io.write(); return 0; },
  });
  const { planId } = await jobs.plan(requestPlan);
  for (const consent of [{ consent: false }, { consent: 'true' }, {}]) {
    await assert.rejects(async () => jobs.apply({ planId, idempotencyKey: 'unapproved', ...consent }),
      { kind: 'usage', status: 400, code: 'Invalid install request.', message: 'Invalid install request.' });
    assert.deepEqual(calls, { lock: 0, execute: 0, write: 0 });
    assert.equal(jobs.snapshot().state, 'idle');
  }
});
test('N2 HTTP refuses missing or non-literal consent before any lock or write', async (t) => {
  const transport = memoryTransport(), calls = { lock: 0, execute: 0, write: 0 };
  const s = await serverFixture(t, { createServer: transport.createServer, install: {
    buildPlan: preview, compare: async () => ({ matches: true }),
    lock: async () => { calls.lock++; return async () => {}; },
    io: { write: () => { calls.write++; } },
    execute: async (_op, _args, _ctx, io) => { calls.execute++; io.write(); return 0; },
  } });
  const p = await transport.request(s, '/api/install/plan');
  assert.equal(p.status, 200);
  for (const consent of [{ consent: false }, { consent: 'true' }, {}]) {
    const response = await transport.request(s, '/api/install/apply', {
      input: { planId: p.body.planId, idempotencyKey: 'unapproved', ...consent },
    });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { reason: 'Invalid install request.', code: 'Invalid install request.' });
    assert.deepEqual(calls, { lock: 0, execute: 0, write: 0 });
  }
});
test('real HTTP consent refusal precedes every install lock and write', async (t) => {
  const calls = { lock: 0, execute: 0, write: 0 };
  const s = await serverFixture(t, { install: {
    buildPlan: preview, compare: async () => ({ matches: true }),
    lock: async () => { calls.lock++; return async () => {}; },
    io: { write: () => { calls.write++; } },
    execute: async (_op, _args, _ctx, io) => { calls.execute++; io.write(); return 0; },
  } });
  const p = await httpRequest(s, '/api/install/plan');
  assert.equal(p.status, 200);
  for (const consent of [{ consent: false }, { consent: 'true' }, {}]) {
    const response = await httpRequest(s, '/api/install/apply', {
      input: { planId: p.body.planId, idempotencyKey: 'unapproved', ...consent },
    });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { reason: 'Invalid install request.', code: 'Invalid install request.' });
    assert.deepEqual(calls, { lock: 0, execute: 0, write: 0 });
  }
});
// | Must pass | Must refuse even when the process lock always succeeds |
// | A new key after completion, up to maxJobs | A second key while waiting, keys past maxJobs |
test('N4 in-process exclusion and maxJobs do not depend on the process lock', async (t) => {
  const abandoned = deferred(), released = [deferred(), deferred()];
  t.after(() => abandoned.resolve(false));
  let locks = 0, executions = 0, writes = 0;
  const { jobs } = await fixture(t, { maxJobs: 2,
    lock: async () => { const index = locks++; return async () => released[index]?.resolve(); },
    io: { write: () => { writes++; } },
    execute: async (_op, _args, _ctx, io) => {
      executions++;
      if (executions === 1) {
        const answer = await Promise.race([io.question({ type: 'boolean', message: 'Write?',
          preview: { path: 'managed' } }), abandoned.promise]);
        if (!answer) return 0;
      }
      io.write(); return 0;
    },
  });
  const { planId } = await jobs.plan(requestPlan);
  const first = await jobs.apply(apply(planId, 'first'));
  assert.equal(jobs.snapshot().state, 'waiting');
  const busy = { kind: 'usage', status: 409,
    code: 'Install session is busy; poll or reopen after completion.',
    message: 'Install session is busy; poll or reopen after completion.' };
  await assert.rejects(async () => jobs.apply(apply(planId, 'second')), busy);
  assert.deepEqual({ locks, executions, writes }, { locks: 1, executions: 1, writes: 0 });
  jobs.answer({ jobId: first.jobId, questionId: jobs.snapshot().question.questionId, answer: true });
  await released[0].promise;
  assert.equal(jobs.snapshot().state, 'succeeded');
  const third = await jobs.apply(apply(planId, 'third'));
  await released[1].promise;
  assert.notEqual(third.jobId, first.jobId);
  assert.equal(jobs.snapshot().state, 'succeeded');
  assert.deepEqual({ locks, executions, writes }, { locks: 2, executions: 2, writes: 2 });
  await assert.rejects(async () => jobs.apply(apply(planId, 'past-bound')), busy);
  assert.deepEqual({ locks, executions, writes }, { locks: 2, executions: 2, writes: 2 });
});
// | Must pass | Must refuse before buildPlan |
// | Known typed options | Unknown own keys (even false), nested/raw inputs and unsafe paths |
test('N9 plan schema rejects the corpus before invoking buildPlan', async (t) => {
  let builds = 0;
  const { jobs } = await fixture(t, { buildPlan: async (...args) => { builds++; return preview(...args); } });
  const cases = [];
  for (const key of ['shell', 'exec', '--from', '__proto__', 'command']) {
    // false passes the boolean-value check if the option-name allowlist is removed.
    cases.push([`unknown option ${key}`, { ...requestPlan, options: Object.fromEntries([[key, false]]) }]);
    cases.push([`unknown top-level ${key}`, Object.fromEntries([...Object.entries(requestPlan), [key, false]])]);
  }
  for (const options of [null, [], [false], { from: { path: 'source' } }, { from: [] }]) {
    cases.push(['nested or non-object options', { ...requestPlan, options }]);
  }
  for (const key of ['noPath', 'noLink', 'noStatusline', 'prerelease']) {
    for (const value of ['true', 1, null, {}, []]) {
      cases.push([`non-boolean ${key}`, { ...requestPlan, options: { [key]: value } }]);
    }
  }
  for (const from of ['--source', 'source\nfolder', 'source\0folder', '', '   ']) {
    cases.push(['unsafe from', { ...requestPlan, options: { from } }]);
  }
  for (const operation of ['uninstall', 'rm']) cases.push([`operation ${operation}`, { ...requestPlan, operation }]);
  for (const [label, input] of cases) {
    await assert.rejects(jobs.plan(input), { kind: 'usage', status: 400,
      code: 'Invalid install request.', message: 'Invalid install request.' }, label);
    assert.equal(builds, 0, `${label} must not call buildPlan`);
  }
  await jobs.plan({ ...requestPlan, options: { from: 'source', noPath: true, noLink: false } });
  assert.equal(builds, 1, 'valid options reach the injected builder');
});

// | Must pass | Must refuse |
// | Typed options and explicit consent | Commands, bodies, unknown keys, bad clients/types |
test('plan schemas refuse executable inputs and polling never invokes writes', async (t) => {
  let writes = 0;
  const { jobs } = await fixture(t, { execute: async () => { writes++; } });
  for (const value of [null, {}, { ...requestPlan, command: 'rm' }, { ...requestPlan, clients: ['evil'] },
    { ...requestPlan, options: { shell: 'sh' } }, { ...requestPlan, options: { noPath: 'yes' } },
    { ...requestPlan, options: { from: '--yes' } }]) await assert.rejects(jobs.plan(value), status(400));
  await jobs.plan(requestPlan);
  for (let n = 0; n < 5; n++) assert.equal(jobs.snapshot().state, 'idle');
  assert.equal(writes, 0);
});
test('same concurrent key shares one job and one write; competing key refuses', async (t) => {
  const entered = deferred(), finish = deferred(); let writes = 0;
  const { jobs } = await fixture(t, { io: { write: () => { writes++; } },
    execute: async (_op, _args, _ctx, io) => { entered.resolve(); await finish.promise; io.write(); return 0; } });
  const { planId } = await jobs.plan(requestPlan);
  const [first, second] = await Promise.all([jobs.apply(apply(planId)), jobs.apply(apply(planId))]);
  assert.equal(first.jobId, second.jobId); await entered.promise;
  await assert.rejects(jobs.apply(apply(planId, 'two')), status(409));
  finish.resolve(); await jobs.close();
  assert.equal(writes, 1);
});
test('stale, expired and incomplete plans refuse before writes and release locks', async (t) => {
  let matches = false, time = 0, writes = 0;
  const { root, jobs } = await fixture(t, { now: () => time, planTtlMs: 10,
    compare: async () => ({ matches }), execute: async () => { writes++; return 0; } });
  const { planId } = await jobs.plan(requestPlan);
  await assert.rejects(jobs.apply(apply(planId)), (e) => e.status === 409 && e.code === 'stale-plan');
  const release = await acquireInstallLock(root); await release();
  matches = true; time = 11;
  await assert.rejects(jobs.apply(apply(planId)), status(409));
  assert.equal(writes, 0);
  const other = await fixture(t, { buildPlan: async (...args) => ({ ...await preview(...args), reviewable: false }) });
  const plan = await other.jobs.plan(requestPlan);
  await assert.rejects(other.jobs.apply(apply(plan.planId)), status(409));
});
// Must pass: the lock creating its own state folder (so the folder and its parent change) on a clean install.
// Must refuse: any other fingerprint that changed once the lock is held.
test('the lock creating its own folder does not make a clean first apply stale', async (t) => {
  for (const [extra, ok] of [[[], true], [['/somewhere/else'], false]]) {
    let locked = false, writes = 0;
    const { root, jobs } = await fixture(t, {
      lock: async () => { locked = true; return async () => {}; },
      compare: async () => locked ? { matches: false, changed: [resolve(root), dirname(resolve(root)), ...extra] } : { matches: true },
      execute: async () => { writes++; return 0; } });
    const { planId } = await jobs.plan(requestPlan);
    if (ok) { await jobs.apply(apply(planId)); await jobs.close(); assert.equal(writes, 1); }
    else { await assert.rejects(jobs.apply(apply(planId)), (e) => e.status === 409 && e.code === 'stale-plan'); assert.equal(writes, 0); }
  }
});
test('cancel finishes an in-flight atomic step and prevents the next step', async (t) => {
  const entered = deferred(), finish = deferred(); const writes = [];
  const { jobs } = await fixture(t, { execute: async (_op, _args, _ctx, io) => {
    io.checkpoint('files'); entered.resolve(); await finish.promise; writes.push('files');
    io.checkpoint('register'); writes.push('register'); return 0;
  } });
  await jobs.apply(apply((await jobs.plan(requestPlan)).planId)); await entered.promise;
  assert.equal(jobs.cancel().cancelRequested, true); finish.resolve(); await jobs.close();
  assert.deepEqual(writes, ['files']); assert.equal(jobs.snapshot().state, 'cancelled');
  assert.ok(jobs.snapshot().completed.includes('codex:files'));
  assert.ok(jobs.snapshot().remaining.includes('codex:register'));
});
test('typed questions carry previews and reject duplicate or stale answers', async (t) => {
  const asked = deferred(), continued = deferred(); let answers = 0;
  const { jobs } = await fixture(t, { execute: async (_op, _args, _ctx, io) => {
    const waiting = io.question({ message: 'Write?', preview: { path: 'managed' } });
    asked.resolve(); if (await waiting) answers++; continued.resolve(); return 0;
  } });
  const started = await jobs.apply(apply((await jobs.plan(requestPlan)).planId)); await asked.promise;
  const { question } = jobs.snapshot(); assert.equal(question.type, 'boolean'); assert.ok(question.preview);
  const input = { jobId: started.jobId, questionId: question.questionId, answer: true };
  assert.throws(() => jobs.answer({ ...input, answer: 'yes' }), status(400));
  assert.throws(() => jobs.answer({ ...input, questionId: 'old' }), status(409));
  jobs.answer(input); assert.throws(() => jobs.answer(input), status(409));
  await continued.promise; await jobs.close(); assert.equal(answers, 1);
});
test('bounded cursor snapshots redact token in every event, output and failure', async (t) => {
  const token = 'private-session-token'; const finished = deferred();
  const { jobs } = await fixture(t, { token, maxEvents: 3, execute: async (_op, _args, ctx, io) => {
    assert.equal(JSON.stringify(_args).includes(token), false);
    for (let i = 0; i < 10; i++) io.ui.row('stage', 'ok', `http://localhost/?token=${token} x-okit-token: ${token}`);
    ctx.out(token); ctx.err({ 'x-okit-token': token, [token]: token }); finished.resolve(); throw new Error(token);
  } });
  await jobs.apply(apply((await jobs.plan(requestPlan)).planId)); await finished.promise; await jobs.close();
  const snapshot = jobs.snapshot(1); assert.equal(snapshot.events.length, 3); assert.equal(snapshot.fullSnapshot, true);
  assert.equal(JSON.stringify(snapshot).includes(token), false);
  assert.deepEqual(snapshot.events.map((e) => e.seq), [12, 13, 14]);
  assert.equal(jobs.snapshot(13).events.length, 1);
  assert.equal(snapshot.events.at(-1).messageKey, 'install-result');
});
test('cross-process lock refuses live and malformed holders and takes over a dead pid', async (t) => {
  const { root } = await fixture(t);
  const file = join(root, 'install-job.lock');
  await writeFile(file, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  await assert.rejects(acquireInstallLock(root), status(409));
  await writeFile(file, 'null');
  await assert.rejects(acquireInstallLock(root), status(409));
  await writeFile(file, JSON.stringify({ pid: 2147483647, startedAt: 1 }));
  await mkdir(`${file}.reclaim`);
  await writeFile(join(`${file}.reclaim`, '2147483647-1-dead-reaper'), '');
  const release = await acquireInstallLock(root);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).pid, process.pid);
  await assert.rejects(acquireInstallLock(root), status(409)); await release();
});
test('plan storage has a bounded count and TTL', async (t) => {
  let now = 0;
  const { jobs } = await fixture(t, { maxPlans: 1, planTtlMs: 10, now: () => now });
  await jobs.plan(requestPlan); await assert.rejects(jobs.plan(requestPlan), status(409));
  now = 11; assert.ok((await jobs.plan(requestPlan)).planId);
});
test('another service for the same root refuses while the first holds the lock', async (t) => {
  const entered = deferred(), finish = deferred(); let competingWrites = 0;
  const { root, env, jobs } = await fixture(t, { execute: async () => { entered.resolve(); await finish.promise; return 0; } });
  const other = createInstallJobs({ root, env, buildPlan: preview, compare: async () => ({ matches: true }),
    execute: async () => { competingWrites++; return 0; } });
  t.after(() => other.close());
  const a = await jobs.plan(requestPlan), b = await other.plan(requestPlan);
  await jobs.apply(apply(a.planId)); await entered.promise;
  await assert.rejects(other.apply(apply(b.planId)), status(409));
  assert.equal(competingWrites, 0);
  finish.resolve(); await jobs.close();
  assert.ok((await other.apply(apply(b.planId))).jobId); await other.close();
  assert.equal(competingWrites, 1);
});
test('closing while waiting cancels a question and releases ownership', async (t) => {
  const asked = deferred(); let writes = 0;
  const { jobs, root } = await fixture(t, { execute: async (_op, _args, _ctx, io) => {
    const reply = io.question({ type: 'boolean', message: 'Write?', preview: { path: 'managed' } });
    asked.resolve(); if (await reply) writes++; return 0;
  } });
  await jobs.apply(apply((await jobs.plan(requestPlan)).planId)); await asked.promise;
  await jobs.close(); assert.equal(writes, 0); assert.equal(jobs.snapshot().state, 'cancelled');
  assert.equal(jobs.snapshot().question, null);
  const release = await acquireInstallLock(root); await release();
});
async function serverFixture(t, options = {}) {
  const f = await fixture(t);
  const server = await startConfigServer({ root: f.root, env: f.env, signals: new EventEmitter(),
    install: { buildPlan: preview, compare: async () => ({ matches: true }), execute: async () => 0, ...options.install },
    ...options });
  t.after(() => server.close());
  return { ...f, ...server };
}
function httpRequest(s, route, { method = 'POST', input = requestPlan, headers = {}, raw } = {}) {
  return new Promise((resolve, reject) => {
    const bytes = raw ?? JSON.stringify(input);
    const request = http.request({ host: '127.0.0.1', port: s.port, path: route, method,
      headers: { host: `127.0.0.1:${s.port}`, origin: `http://127.0.0.1:${s.port}`,
        'x-okit-token': s.token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(bytes), ...headers } },
    (response) => {
      let text = ''; response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(text) }));
    });
    request.on('error', reject); request.end(bytes);
  });
}
// | Must pass | Must refuse |
// | Loopback Host, Origin, header token | Foreign/rebinding Host, foreign/null Origin, query token |
test('install HTTP authorization, method, size and typed schemas', async (t) => {
  const s = await serverFixture(t);
  const route = '/api/install/plan';
  for (const headers of [{ host: 'evil.test' }, { host: `127.0.0.1.evil.test:${s.port}` },
    { origin: 'http://evil.test' }, { origin: 'null' }, { 'x-okit-token': '' }, { 'x-okit-token': 'wrong' }]) {
    assert.equal((await httpRequest(s, route, { headers })).status, 403);
  }
  assert.equal((await httpRequest(s, `${route}?token=${s.token}`, { headers: { 'x-okit-token': '' } })).status, 403);
  assert.equal((await httpRequest(s, route, { method: 'GET' })).status, 405);
  assert.equal((await httpRequest(s, route, { raw: 'x'.repeat(65537) })).status, 413);
  assert.equal((await httpRequest(s, route, { raw: '{' })).status, 400);
  assert.equal((await httpRequest(s, route, { input: { ...requestPlan, shell: 'sh' } })).status, 400);
  const plan = await httpRequest(s, route); assert.equal(plan.status, 200);
  assert.equal(plan.headers['cache-control'], 'no-store'); assert.ok(plan.headers['content-security-policy']);
  const poll = await httpRequest(s, '/api/install/job?after=0', { method: 'GET' });
  assert.equal(poll.body.state, 'idle');
  assert.equal((await httpRequest(s, '/api/install/job?after=-1', { method: 'GET' })).status, 400);
});
test('idle expiry safely cancels an active atomic step before server shutdown', async (t) => {
  const entered = deferred(), finish = deferred(); let writes = 0;
  const s = await serverFixture(t, { idleMs: 50, install: { buildPlan: preview,
    compare: async () => ({ matches: true }), execute: async (_op, _args, _ctx, io) => {
      io.checkpoint('files'); entered.resolve(); await finish.promise; writes++;
      io.checkpoint('register'); writes++; return 0;
    } } });
  const p = await httpRequest(s, '/api/install/plan');
  await httpRequest(s, '/api/install/apply', { input: apply(p.body.planId) }); await entered.promise;
  const detached = await httpRequest(s, '/api/close', { input: { grace: true } });
  assert.equal(detached.body.detached, true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(writes, 0); finish.resolve(); await s.closed; assert.equal(writes, 1);
});

function memoryTransport() {
  let handle;
  const server = new EventEmitter();
  Object.assign(server, { listen(_port, _host, ready) { ready(); }, address: () => ({ port: 32123 }),
    close(done) { done(); }, closeAllConnections() {}, unref() {} });
  return { createServer(callback) { handle = callback; return server; },
    async request(s, path, { method = 'POST', input = requestPlan, headers = {}, raw } = {}) {
      const req = Readable.from([Buffer.from(raw ?? JSON.stringify(input))]);
      Object.assign(req, { method, url: path, headers: { host: `127.0.0.1:${s.port}`,
        origin: `http://127.0.0.1:${s.port}`, 'x-okit-token': s.token, 'content-type': 'application/json', ...headers } });
      return new Promise((resolve) => {
        const res = new EventEmitter(); res.setHeader = () => {};
        res.writeHead = (status, values) => { res.status = status; res.headers = values; };
        res.end = (bytes) => { resolve({ status: res.status, headers: res.headers, body: JSON.parse(bytes) }); res.emit('finish'); };
        handle(req, res);
      });
    } };
}
test('authorization corpus and mutation proofs run without socket permissions', async (t) => {
  const transport = memoryTransport(); let writes = 0;
  const s = await serverFixture(t, { createServer: transport.createServer, install: {
    buildPlan: preview, compare: async () => ({ matches: false }), execute: async () => { writes++; return 0; } } });
  const request = (path, options) => transport.request(s, path, options);
  for (const headers of [{ host: 'evil.test' }, { host: `localhost.evil:${s.port}` }, { origin: 'null' },
    { origin: '' }, { origin: undefined }, { origin: 'http://evil.test' }, { 'x-okit-token': undefined },
    { 'x-okit-token': '' }, { 'x-okit-token': 'wrong' }]) {
    assert.equal((await request('/api/install/plan', { headers })).status, 403);
  }
  assert.equal((await request('/api/install/plan', { method: 'GET' })).status, 405);
  assert.equal((await request(`/api/install/job?token=${s.token}`, { method: 'GET',
    headers: { 'x-okit-token': undefined } })).status, 403);
  for (const path of ['plan', 'apply', 'answer', 'cancel']) {
    assert.equal((await request(`/api/install/${path}`, { method: 'GET' })).status, 405);
  }
  assert.equal((await request('/api/install/plan', { raw: 'x'.repeat(65537) })).status, 413);
  assert.equal((await request('/api/install/plan', { input: { command: 'sh' } })).status, 400);
  const p = await request('/api/install/plan'); assert.equal(p.status, 200);
  assert.equal((await request('/api/install/apply', { input: apply(p.body.planId) })).status, 409);
  assert.equal((await request('/api/install/job?after=0', { method: 'GET' })).body.state, 'idle');
  assert.equal(writes, 0);
});
test('authenticated polling renews activity and idle expiry cancels safely without sockets', async (t) => {
  const transport = memoryTransport(), entered = deferred(), finish = deferred(); let writes = 0;
  const s = await serverFixture(t, { createServer: transport.createServer, idleMs: 100, install: {
    buildPlan: preview, compare: async () => ({ matches: true }), execute: async (_op, _args, _ctx, io) => {
      io.checkpoint('files'); entered.resolve(); await finish.promise; writes++; io.checkpoint('register'); writes++; return 0;
    } } });
  const request = (path, options) => transport.request(s, path, options);
  const p = await request('/api/install/plan');
  await request('/api/install/apply', { input: apply(p.body.planId) }); await entered.promise;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal((await request('/api/install/job', { method: 'GET' })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal((await request('/api/install/job', { method: 'GET' })).status, 200);
  assert.equal((await request('/api/close', { input: { grace: true } })).body.detached, true);
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(writes, 0); finish.resolve(); await s.closed; assert.equal(writes, 1);
  const release = await acquireInstallLock(s.root); await release();
});
test('HTTP apply, poll and answer preserve idempotency and expose typed errors', async (t) => {
  const transport = memoryTransport(), asked = deferred(); let writes = 0;
  const s = await serverFixture(t, { createServer: transport.createServer, install: {
    buildPlan: preview, compare: async () => ({ matches: true }), io: { write: () => { writes++; } },
    execute: async (_op, _args, _ctx, io) => {
      const reply = io.question({ type: 'boolean', message: 'Write?', preview: { path: 'managed' } });
      asked.resolve(); if (await reply) io.write(); return 0;
    } } });
  const request = (path, input) => transport.request(s, path, { input });
  const p = await request('/api/install/plan', requestPlan);
  const first = await request('/api/install/apply', apply(p.body.planId)); await asked.promise;
  const again = await request('/api/install/apply', apply(p.body.planId));
  assert.equal(first.body.jobId, again.body.jobId);
  const poll = await transport.request(s, '/api/install/job', { method: 'GET' });
  const answer = { jobId: first.body.jobId, questionId: poll.body.question.questionId, answer: true };
  assert.equal((await request('/api/install/answer', answer)).status, 200);
  const duplicate = await request('/api/install/answer', answer);
  assert.equal(duplicate.status, 409); assert.ok(duplicate.body.code);
  await s.close(); assert.equal(writes, 1);
});
test('SIGINT waits for the atomic step and releases the cross-process lock', async (t) => {
  const transport = memoryTransport(), signals = new EventEmitter(), entered = deferred(), finish = deferred();
  let writes = 0;
  const s = await serverFixture(t, { createServer: transport.createServer, signals, install: {
    buildPlan: preview, compare: async () => ({ matches: true }), execute: async (_op, _args, _ctx, io) => {
      io.checkpoint('files'); entered.resolve(); await finish.promise; writes++;
      io.checkpoint('register'); writes++; return 0;
    } } });
  const p = await transport.request(s, '/api/install/plan');
  await transport.request(s, '/api/install/apply', { input: apply(p.body.planId) }); await entered.promise;
  signals.emit('SIGINT'); signals.emit('SIGINT');
  assert.equal(signals.listenerCount('SIGINT'), 1);
  assert.equal(writes, 0); finish.resolve(); await s.closed;
  assert.equal(writes, 1); assert.equal(signals.listenerCount('SIGINT'), 0);
  const release = await acquireInstallLock(s.root); await release();
});
