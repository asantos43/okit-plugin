import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { acquireSlot, canSpawn, countLive, limitsStatus, releaseSlot } from '../src/limits.js';

const roots = [];

async function root() {
  const dir = await mkdtemp(join(tmpdir(), 'limits-test-'));
  roots.push(dir);
  return dir;
}

async function writeRun(dir, run) {
  await mkdir(join(dir, 'runs'), { recursive: true });
  await writeFile(join(dir, 'runs', `${run.runId}.json`), `${JSON.stringify(run)}\n`, 'utf8');
}

const live = (runId, client, startedAt = Date.now()) => ({ runId, client, status: 'live', startedAt });

after(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

test('countLive counts only live runs and ignores an unknown root', async () => {
  const dir = await root();
  assert.equal(await countLive(dir), 0);
  await writeRun(dir, live('a', 'alpha'));
  await writeRun(dir, live('b', 'beta'));
  await writeRun(dir, { runId: 'c', client: 'alpha', status: 'done', startedAt: Date.now() });
  await writeFile(join(dir, 'runs', 'notes.txt'), 'ignored', 'utf8');
  assert.equal(await countLive(dir), 2);
});

test('a live run older than staleMinutes does not count', async () => {
  const dir = await root();
  const stale = Date.now() - 60 * 60_000;
  await writeRun(dir, live('old', 'alpha', stale));
  assert.equal(await countLive(dir), 0);
  assert.equal(await countLive(dir, { staleMinutes: 120 }), 1);
});

test('canSpawn allows a run under the caps and refuses over them', async () => {
  const dir = await root();
  const config = { limits: { global: 4, perClient: 3 } };
  assert.deepEqual(await canSpawn(dir, { client: 'alpha', config }),
    { ok: true, global: 0, perClient: 0 });

  await writeRun(dir, live('a1', 'alpha'));
  await writeRun(dir, live('a2', 'alpha'));
  await writeRun(dir, live('a3', 'alpha'));
  const perClient = await canSpawn(dir, { client: 'alpha', config });
  assert.equal(perClient.ok, false);
  assert.match(perClient.reason, /per-client/);

  assert.deepEqual(await canSpawn(dir, { client: 'beta', config }),
    { ok: true, global: 3, perClient: 0 });

  await writeRun(dir, live('b1', 'beta'));
  const global = await canSpawn(dir, { client: 'beta', config });
  assert.equal(global.ok, false);
  assert.match(global.reason, /global/);
  assert.equal(global.global, 4);
});
test('acquireSlot writes a live run and releaseSlot frees the slot', async () => {
  const dir = await root();
  const config = { limits: { global: 4, perClient: 3 } };
  const taken = await acquireSlot(dir, 'r1', { client: 'alpha', config });
  assert.deepEqual(taken, { ok: true, runId: 'r1', client: 'alpha' });
  assert.deepEqual((await readdir(join(dir, 'runs'))), ['r1.json']);
  assert.equal(await countLive(dir, config), 1);

  assert.deepEqual(await releaseSlot(dir, 'r1'), { ok: true, runId: 'r1' });
  assert.equal(await countLive(dir, config), 0);
  assert.deepEqual(await releaseSlot(dir, 'ghost'), { ok: false, reason: 'unknown run', runId: 'ghost' });
});

test('acquireSlot refuses the run that would pass the cap', async () => {
  const dir = await root();
  const config = { limits: { global: 4, perClient: 1 } };
  assert.equal((await acquireSlot(dir, 'a', { client: 'alpha', config })).ok, true);
  const refused = await acquireSlot(dir, 'b', { client: 'alpha', config });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'per-client limit');
  assert.equal(await countLive(dir, config), 1);
});

test('twelve parallel acquireSlot calls admit exactly four', async () => {
  const dir = await root();
  const config = { limits: { global: 4, perClient: 3 } };
  const clients = ['alpha', 'alpha', 'alpha', 'beta', 'beta', 'beta', 'gamma', 'gamma', 'gamma', 'delta', 'delta', 'delta'];
  const results = await Promise.all(
    clients.map((client, i) => acquireSlot(dir, `run-${i}`, { client, config })),
  );
  assert.equal(results.filter((r) => r.ok).length, 4);
  assert.equal(await countLive(dir, config), 4);
  const status = await limitsStatus(dir, config);
  assert.equal(status.live, 4);
  assert.deepEqual(status.limits, { global: 4, perClient: 3 });
});
test('waitMs polls until a release frees a slot', async () => {
  const dir = await root();
  const config = { limits: { global: 1, perClient: 1 } };
  assert.equal((await acquireSlot(dir, 'holder', { client: 'alpha', config })).ok, true);

  const started = Date.now();
  const pending = acquireSlot(dir, 'waiter', { client: 'alpha', config, waitMs: 5000 });
  await new Promise((resolve) => {
    setTimeout(resolve, 150);
  });
  await releaseSlot(dir, 'holder');
  const result = await pending;
  assert.deepEqual(result, { ok: true, runId: 'waiter', client: 'alpha' });
  assert.ok(Date.now() - started >= 150);
  assert.equal(await countLive(dir, config), 1);
});

test('waitMs of 0 returns busy without waiting', async () => {
  const dir = await root();
  const config = { limits: { global: 1, perClient: 1 } };
  await acquireSlot(dir, 'holder', { client: 'alpha', config });
  const started = Date.now();
  const refused = await acquireSlot(dir, 'late', { client: 'alpha', config, waitMs: 0 });
  assert.equal(refused.ok, false);
  assert.ok(Date.now() - started < 100);
});

test('limitsStatus reports the caps and the per-client counts', async () => {
  const dir = await root();
  await writeRun(dir, live('a1', 'alpha'));
  await writeRun(dir, live('b1', 'beta'));
  const status = await limitsStatus(dir);
  assert.deepEqual(status.limits, { global: 4, perClient: 3 });
  assert.equal(status.live, 2);
  assert.deepEqual(status.byClient, { alpha: 1, beta: 1 });
});