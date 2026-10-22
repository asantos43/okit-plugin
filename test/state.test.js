import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, utimes, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { readJson, withLock, writeJsonAtomic } from '../src/state.js';

const wait = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'state-test-'));
}

async function deadPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', '0']);
    child.once('error', reject);
    child.once('exit', () => resolve(child.pid));
  });
}

test('writeJsonAtomic then readJson returns the same value', async () => {
  const dir = await tempDir();
  const file = join(dir, 'nested', 'deep', 'state.json');
  const value = { tasks: [{ id: 1, title: 'write state' }], done: false };

  await writeJsonAtomic(file, value);
  assert.deepEqual(await readJson(file, null), value);

  const raw = await readFile(file, 'utf8');
  assert.equal(raw, `${JSON.stringify(value, null, 2)}\n`);
  await rm(dir, { recursive: true, force: true });
});

test('writeJsonAtomic leaves no temporary file behind', async () => {
  const dir = await tempDir();
  const file = join(dir, 'state.json');

  await writeJsonAtomic(file, { a: 1 });
  await writeJsonAtomic(file, { a: 2 });

  assert.deepEqual(await readdir(dir), ['state.json']);
  await rm(dir, { recursive: true, force: true });
});

test('readJson returns the fallback when the file is missing', async () => {
  const dir = await tempDir();
  const fallback = { tasks: [] };

  assert.deepEqual(await readJson(join(dir, 'absent.json'), fallback), fallback);
  await rm(dir, { recursive: true, force: true });
});

test('readJson names the file when the JSON is invalid', async () => {
  const dir = await tempDir();
  const file = join(dir, 'broken.json');
  await writeFile(file, '{ "a": ', 'utf8');

  await assert.rejects(readJson(file, null), (error) => {
    assert.match(error.message, /Invalid JSON/);
    assert.match(error.message, /broken\.json/);
    assert.ok(error.cause instanceof SyntaxError);
    return true;
  });
  await rm(dir, { recursive: true, force: true });
});

test('withLock returns the value of the callback and removes the lock', async () => {
  const dir = await tempDir();
  const file = join(dir, 'state.json');

  const result = await withLock(file, async () => {
    assert.equal((await readdir(dir)).includes('state.json.lock'), true);
    await writeJsonAtomic(file, { a: 1 });
    return 'done';
  });

  assert.equal(result, 'done');
  assert.deepEqual(await readdir(dir), ['state.json']);
  await rm(dir, { recursive: true, force: true });
});

test('twenty concurrent withLock calls keep the counter exact', async () => {
  const dir = await tempDir();
  const file = join(dir, 'counter.json');
  const calls = 20;
  await writeJsonAtomic(file, { count: 0 });

  await Promise.all(Array.from({ length: calls }, () => bump(file, 1)));

  assert.deepEqual(await readJson(file, null), { count: calls });
  assert.deepEqual(await readdir(dir), ['counter.json']);
  await rm(dir, { recursive: true, force: true });
});

test('withLock takes a stale lock whose owner is dead', async () => {
  const dir = await tempDir();
  const file = join(dir, 'state.json');
  const lockDir = `${file}.lock`;
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ pid: await deadPid(), startedAt: Date.now() - 60_000 }), 'utf8');

  const value = await withLock(file, () => 'taken', { staleMs: 30_000 });

  assert.equal(value, 'taken');
  assert.deepEqual(await readdir(dir), []);
  await rm(dir, { recursive: true, force: true });
});

test('withLock takes an old lock folder that has no owner', async () => {
  const dir = await tempDir();
  const file = join(dir, 'state.json');
  const lockDir = `${file}.lock`;
  await mkdir(lockDir, { recursive: true });
  const old = new Date(Date.now() - 60_000);
  await utimes(lockDir, old, old);

  const value = await withLock(file, () => 'taken', { staleMs: 30_000 });

  assert.equal(value, 'taken');
  assert.deepEqual(await readdir(dir), []);
  await rm(dir, { recursive: true, force: true });
});

test('withLock waits on an ownerless lock folder that is not old yet', async () => {
  const dir = await tempDir();
  const file = join(dir, 'state.json');
  const lockDir = `${file}.lock`;
  await mkdir(lockDir, { recursive: true });

  await assert.rejects(withLock(file, () => 'never', { timeoutMs: 120, staleMs: 30_000 }), /unknown process/);
  assert.deepEqual(await readdir(dir), ['state.json.lock']);
  await rm(dir, { recursive: true, force: true });
});

test('withLock fails with a clear message when the lock stays held', async () => {
  const dir = await tempDir();
  const file = join(dir, 'state.json');
  const lockDir = `${file}.lock`;
  await mkdir(lockDir, { recursive: true });
  const owner = { pid: process.pid, startedAt: Date.now() };
  await writeFile(join(lockDir, 'owner.json'), JSON.stringify(owner), 'utf8');

  await assert.rejects(withLock(file, () => 'never', { timeoutMs: 120 }), (error) => {
    assert.match(error.message, /state\.json\.lock/);
    assert.match(error.message, new RegExp(`pid ${process.pid}`));
    return true;
  });
  assert.deepEqual(await readdir(dir), ['state.json.lock']);
  await rm(dir, { recursive: true, force: true });
});

test('withLock releases the lock when the callback throws', async () => {
  const dir = await tempDir();
  const file = join(dir, 'state.json');

  await assert.rejects(withLock(file, async () => {
    await writeJsonAtomic(file, { a: 1 });
    throw new Error('callback failed');
  }), /callback failed/);

  assert.deepEqual(await readdir(dir), ['state.json']);
  assert.equal(await withLock(file, () => 'free', { timeoutMs: 200 }), 'free');
  await rm(dir, { recursive: true, force: true });
});

async function bump(file, rounds, timeoutMs = 10_000) {
  for (let round = 0; round < rounds; round += 1) {
    await withLock(file, async () => {
      const current = await readJson(file, { count: 0 });
      // The delay widens the window in which a lock-free update would be lost.
      await wait(10);
      await writeJsonAtomic(file, { count: current.count + 1 });
    }, { timeoutMs });
  }
}

const SELF = new URL(import.meta.url).pathname;

// The forked child runs this same file as its main module: it bumps the
// counter and exits before any test below is registered.
if (process.env.STATE_TEST_CHILD) {
  await bump(process.env.STATE_TEST_FILE, Number(process.env.STATE_TEST_ROUNDS));
  process.exit(0);
}

function forkBumper(file, rounds) {
  const child = fork(SELF, [], {
    env: { ...process.env, STATE_TEST_CHILD: '1', STATE_TEST_FILE: file, STATE_TEST_ROUNDS: String(rounds) },
    stdio: 'ignore',
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exited with ${code}`))));
  });
}

test('a forked child and the parent contend on the same lock', async () => {
  const dir = await tempDir();
  const file = join(dir, 'counter.json');
  const rounds = 15;
  await writeJsonAtomic(file, { count: 0 });

  await Promise.all([forkBumper(file, rounds), forkBumper(file, rounds), bump(file, rounds)]);

  assert.deepEqual(await readJson(file, null), { count: rounds * 3 });
  assert.deepEqual(await readdir(dir), ['counter.json']);
  await rm(dir, { recursive: true, force: true });
});

test('eight children race to take one stale lock of a dead pid', async () => {
  const dir = await tempDir();
  const file = join(dir, 'counter.json');
  const lockDir = `${file}.lock`;
  const children = 8;
  // Three rounds keep the race covered without paying for ten sets of forks.
  const rounds = 3;

  for (let round = 0; round < rounds; round += 1) {
    await writeJsonAtomic(file, { count: 0 });
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ pid: await deadPid(), startedAt: Date.now() - 60_000 }), 'utf8');

    // Every child finds the same stale lock, so the takeover race is forced.
    await Promise.all(Array.from({ length: children }, () => forkBumper(file, 1)));

    assert.deepEqual(await readJson(file, null), { count: children });
    assert.deepEqual(await readdir(dir), ['counter.json'], `leftover lock folder in round ${round}`);
  }
  await rm(dir, { recursive: true, force: true });
});

test('a wider takeover race keeps every bump and leaves no folder behind', async () => {
  const dir = await tempDir();
  const file = join(dir, 'counter.json');
  const lockDir = `${file}.lock`;
  const children = 16;
  const rounds = 3;

  // A takeover reads the lock before moving it aside, so the folder of an owner
  // that has just created it and has not written its owner file yet is exactly
  // the one a stale verdict must never touch: it has no evidence of its own.
  // Sixteen children per round keep far more of those verdicts in flight than
  // the eight above, which is what made the theft show up only under load.
  for (let round = 0; round < rounds; round += 1) {
    await writeJsonAtomic(file, { count: 0 });
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ pid: await deadPid(), startedAt: Date.now() - 60_000 }), 'utf8');

    await Promise.all(Array.from({ length: children }, () => forkBumper(file, 1)));

    assert.deepEqual(await readJson(file, null), { count: children }, `lost update in round ${round}`);
    assert.deepEqual(await readdir(dir), ['counter.json'], `leftover lock folder in round ${round}`);
  }
  await rm(dir, { recursive: true, force: true });
});