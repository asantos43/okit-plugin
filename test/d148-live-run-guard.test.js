import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { acquireSlot, releaseSlot } from '../src/limits.js';
import { acquireSlotOperation } from '../src/core/limits-operations.js';
import { tick } from '../src/daemon.js';
import { inboxAdd, inboxClaim } from '../src/inbox.js';
import { readJson, writeJsonAtomic } from '../src/state.js';
import { paths } from '../src/store.js';
import { makeSpawner } from '../src/spawn-process.js';

const config = { quotaPoll: { enabled: false }, limits: { global: 500 }, staleMinutes: 30 };
const owner = { client: 'codex', session: 'session-1', worktree: 'tree-1' };
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'd148-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const saved = { HOME: process.env.HOME, OKWORK_HOME: process.env.OKWORK_HOME };
  process.env.HOME = process.env.OKWORK_HOME = root;
  t.after(() => { for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const take = (id, args = {}) => acquireSlot(root, id, { client: 'codex', config, ...args });
  return { root, take };
}

// Must pass: different demand/folder, stale or legacy records, same-owner force.
// Must refuse: same demand, same folder (including symlink), foreign/unknown-owner force.
test('same demand refuses with the first run identity and age', async (t) => {
  const { root, take } = await setup(t);
  await writeJsonAtomic(join(root, 'runs', 'first.json'), { runId: 'first', client: 'codex',
    account: 'work', status: 'live', startedAt: Date.now() - 120_000, demand: 'D148' });
  const result = await take('second', { demand: 'D148' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /first.*codex.*work.*age 2 minutes.*wait.*release.*force/);
  assert.equal(result.conflict.runId, 'first');
  assert.equal(result.conflict.ageMinutes, 2);
});

test('same folder and a symlink refuse; different folders and demands pass', async (t) => {
  const { root, take } = await setup(t);
  const folder = join(root, 'folder');
  await mkdir(folder);
  await symlink(folder, join(root, 'alias'));
  assert.equal((await take('first', { demand: 'A', cwd: folder })).ok, true);
  for (const cwd of [folder, join(root, 'alias')]) {
    assert.equal((await take('second', { demand: 'B', cwd })).ok, false);
  }
  assert.equal((await take('third', { demand: 'C', cwd: join(root, 'missing') })).ok, true);
  assert.equal((await readJson(join(root, 'runs', 'third.json'))).cwd, resolve(root, 'missing'));
});

test('simultaneous reservations admit exactly one, independent of caps', async (t) => {
  const { take } = await setup(t);
  const results = await Promise.all(['one', 'two'].map((id) => take(id, { demand: 'same' })));
  assert.equal(results.filter((entry) => entry.ok).length, 1);
  assert.ok(results.find((entry) => !entry.ok).conflict);
});

test('stale and legacy records never conflict; release preserves metadata', async (t) => {
  const { root, take } = await setup(t);
  await writeJsonAtomic(join(root, 'runs', 'old.json'), { runId: 'old', client: 'codex',
    status: 'live', startedAt: Date.now() - 31 * 60_000, demand: 'A', cwd: root });
  await writeJsonAtomic(join(root, 'runs', 'legacy.json'), { runId: 'legacy', client: 'codex',
    status: 'live', startedAt: Date.now() });
  assert.equal((await take('new', { demand: 'A', cwd: root, owner })).ok, true);
  await releaseSlot(root, 'new');
  const record = await readJson(join(root, 'runs', 'new.json'));
  assert.deepEqual(record.owner, owner);
  assert.equal(record.cwd, root);
  assert.equal(record.demand, 'A');
  assert.equal((await take('again', { demand: 'A', cwd: root })).ok, true);
});

test('force requires every conflicting owner to match and records run ids only', async (t) => {
  const { root, take } = await setup(t);
  await writeJsonAtomic(join(root, 'config.json'), { telemetry: { enabled: true,
    dir: 'telemetry', kitExecutable: 'missing-d148-kit' } });
  await take('first', { demand: 'A', cwd: root, owner });
  for (const other of [undefined, { ...owner, session: 'other' }, { ...owner, client: 'other' }]) {
    assert.equal((await take('foreign', { demand: 'A', owner: other, force: true })).ok, false);
  }
  assert.equal((await take('forced', { demand: 'A', owner, force: true })).ok, true);
  const files = await readdir(join(root, 'telemetry'));
  assert.equal(files.length, 1);
  const event = JSON.parse(await readFile(join(root, 'telemetry', files[0]), 'utf8'));
  const metric = event.resourceMetrics[0].scopeMetrics[0].metrics[0];
  assert.equal(metric.name, 'okit.plugin.run.forced');
  assert.deepEqual(metric.sum.dataPoints[0].attributes, [
    { key: 'runId', value: { stringValue: 'forced' } },
    { key: 'conflictingRunId', value: { stringValue: 'first' } },
  ]);
  await take('ownerless', { demand: 'B' });
  assert.equal((await take('cannot-force', { demand: 'B', owner, force: true })).ok, false);
});

test('200 stale records use one directory read within a 200 ms budget', async (t) => {
  const { root, take } = await setup(t);
  await mkdir(join(root, 'runs'));
  await Promise.all(Array.from({ length: 200 }, (_, i) => writeFile(join(root, 'runs', `${i}.json`),
    JSON.stringify({ runId: `${i}`, client: 'codex', status: 'live', startedAt: 1, demand: 'A', cwd: root }))));
  let reads = 0;
  const original = fsPromises.readdir;
  t.mock.method(fsPromises, 'readdir', async (...args) => {
    if (args[0] === join(root, 'runs')) reads++;
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const start = performance.now();
  assert.equal((await take('fresh', { demand: 'A', cwd: root })).ok, true);
  const elapsed = performance.now() - start;
  assert.equal(reads, 1);
  assert.ok(elapsed < 200, `reservation took ${elapsed.toFixed(1)} ms (budget 200 ms)`);
});

test('MCP validates new fields and refuses command injection arguments', async (t) => {
  const { root } = await setup(t);
  const base = { runId: 'mcp', client: 'codex' };
  for (const extra of [{ demand: 1 }, { cwd: [] }, { force: 'yes' }, { force: null },
    { owner: [] }, { owner: null }, { owner: {} }, { owner: { client: 'codex', session: 2 } },
    { owner: { client: 'codex', worktree: false } }, { command: 'echo bad' }]) {
    await assert.rejects(acquireSlotOperation(root, { ...base, ...extra }, { config }));
  }
  assert.equal((await acquireSlotOperation(root, { ...base, demand: 'A', cwd: root, owner }, { config })).ok, true);
  assert.equal((await acquireSlotOperation(root, { ...base, runId: 'next', demand: 'A' }, { config })).ok, false);
});

test('daemon skips another holder and relinks the same holder with guard metadata', async (t) => {
  const { root } = await setup(t);
  await writeJsonAtomic(join(root, 'config.json'), config);
  const item = await inboxAdd(root, { title: 'guard held demand', client: 'opencode' });
  await inboxClaim(root, item.id, owner);
  let calls = 0;
  const spawn = async () => { calls++; return { runId: 'relinked' }; };
  spawn.resolveCwd = async () => root;
  const deps = { spawn, owner: { ...owner, session: 'other' }, quota: () => ({ remainingPct: 80 }) };
  const refused = await tick(root, deps);
  assert.equal(calls, 0);
  assert.match(refused.skipped[0].reason, /held by another owner/);
  const allowed = await tick(root, { ...deps, owner });
  assert.equal(calls, 1);
  assert.equal(allowed.spawned.length, 1);
  const run = await readJson(join(root, 'runs', 'relinked.json'));
  assert.equal(run.demand, item.id);
  assert.equal(run.cwd, root);
  assert.deepEqual(run.owner, owner);
  const runs = await Promise.all((await readdir(join(root, 'runs')))
    .filter((name) => name.endsWith('.json')).map((name) => readJson(join(root, 'runs', name))));
  assert.equal(runs.filter((entry) => entry.status === 'live').length, 1);
});

test('process spawner exposes its cwd and preserves reserved guard metadata', async (t) => {
  const { root, take } = await setup(t);
  const folder = join(root, 'project');
  await mkdir(folder);
  const spawn = makeSpawner({ logDir: join(root, 'runs'), cwd: folder,
    spawn: () => ({ pid: 123, on() {}, unref() {} }) });
  const demand = { id: 'process-demand', title: 'test spawn' };
  assert.equal(await spawn.resolveCwd(demand), undefined);
  assert.equal(await spawn.resolveCwd({ appliesTo: root }), root);
  await take('process', { demand: demand.id, cwd: folder, owner });
  await spawn(demand, { runId: 'process', client: 'opencode', cwd: folder, config,
    profile: { model: 'test-model', effort: 'low' } });
  const run = await readJson(join(root, 'runs', 'process.json'));
  assert.equal(run.cwd, folder);
  assert.equal(run.demand, demand.id);
  assert.deepEqual(run.owner, owner);
  assert.equal(run.role, 'executor');
});

test('demands without a folder of their own never conflict, and a stale hold does not block', async (t) => {
  const { root } = await setup(t);
  await writeJsonAtomic(join(root, 'config.json'), config);
  const first = await inboxAdd(root, { title: 'no folder one', client: 'opencode' });
  const second = await inboxAdd(root, { title: 'no folder two', client: 'opencode' });
  await inboxClaim(root, second.id, { client: 'someone', session: 'old' });
  const store = await readJson(paths(root).inbox);
  const held = store.items.find((entry) => entry.id === second.id);
  assert.ok(held.hold, 'the claim must leave a hold to age');
  held.hold.takenAt = '2000-01-01T00:00:00.000Z';
  await writeJsonAtomic(paths(root).inbox, store);
  const seen = [];
  const spawn = async (demand, options) => { seen.push([demand.id, options.cwd]); return { runId: options.runId }; };
  spawn.resolveCwd = async () => undefined;
  const result = await tick(root, { spawn, owner, quota: () => ({ remainingPct: 80 }) });
  assert.equal(result.spawned.length, 2, JSON.stringify(result));
  assert.deepEqual(seen.map(([, cwd]) => cwd), seen.map(() => undefined));
  assert.ok(seen.some(([id]) => id === first.id));
});
