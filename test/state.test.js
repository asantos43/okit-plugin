import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, utimes, writeFile, mkdir } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

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

function liveChild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => resolve(child));
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
  const calls = WIDEST_QUEUE;
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

// The takeover renames the dead owner's claim out of the folder instead of
// moving the folder, so a marker the crashed owner left behind is still inside
// the lock the new owner runs in.
test('a takeover claims the folder of a dead owner in place', async () => {
  const dir = await tempDir();
  const file = join(dir, 'state.json');
  const lockDir = `${file}.lock`;
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ pid: await deadPid(), startedAt: Date.now() - 60_000 }), 'utf8');
  await writeFile(join(lockDir, 'left-behind.txt'), 'crash', 'utf8');

  const inside = await withLock(file, () => readdir(lockDir), { staleMs: 30_000 });

  assert.deepEqual(inside.sort(), ['left-behind.txt', 'owner.json']);
  assert.deepEqual(await readdir(dir), []);
  await rm(dir, { recursive: true, force: true });
});

// The window the takeover has to survive: it holds the dead owner's claim and
// has not written its own yet, so a live owner can claim the folder in between.
// The taker must give way there instead of entering a section it does not own.
test('a takeover yields to an owner that claims the lock while it runs', async () => {
  const dir = await tempDir();
  const file = join(dir, 'state.json');
  const lockDir = `${file}.lock`;
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ pid: await deadPid(), startedAt: Date.now() - 60_000 }), 'utf8');

  const intruder = await liveChild();
  const owner = { pid: intruder.pid, startedAt: Date.now() };
  let entered = 0;

  const attempt = withLock(file, async () => { entered += 1; }, {
    timeoutMs: 150,
    staleMs: 30_000,
    probe: async (step) => {
      if (step !== 'claimed') return;
      await writeFile(join(lockDir, 'owner.json'), `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
    },
  });

  await assert.rejects(attempt, new RegExp(`held by pid ${intruder.pid}`));
  assert.equal(entered, 0);
  assert.deepEqual(await readJson(join(lockDir, 'owner.json'), null), owner);
  assert.deepEqual(await readdir(lockDir), ['owner.json']);
  assert.deepEqual(await readdir(dir), ['state.json.lock']);
  intruder.kill('SIGKILL');
  await rm(dir, { recursive: true, force: true });
});

// Age alone must not make a lock stale: a live pid outranks the clock, or a
// long run would be stolen while its owner is still inside the section.
test('withLock never takes a lock whose live owner is older than staleMs', async () => {
  const dir = await tempDir();
  const file = join(dir, 'state.json');
  const lockDir = `${file}.lock`;
  await mkdir(lockDir, { recursive: true });
  const intruder = await liveChild();
  const owner = { pid: intruder.pid, startedAt: Date.now() - 600_000 };
  await writeFile(join(lockDir, 'owner.json'), JSON.stringify(owner), 'utf8');
  let entered = 0;

  const attempt = withLock(file, async () => { entered += 1; }, { timeoutMs: 150, staleMs: 30_000 });

  await assert.rejects(attempt, new RegExp(`held by pid ${intruder.pid}`));
  assert.equal(entered, 0);
  assert.deepEqual(await readJson(join(lockDir, 'owner.json'), null), owner);
  assert.deepEqual(await readdir(dir), ['state.json.lock']);
  intruder.kill('SIGKILL');
  await rm(dir, { recursive: true, force: true });
});

// The folder has no owner file and is old enough to take over, but another
// owner claims it in the window after the verdict. Losing that claim must read
// as a lock still held, not as an error the caller has to make sense of.
test('a takeover reports the lock as held when another owner claims it at the verdict', async () => {
  const dir = await tempDir();
  const file = join(dir, 'state.json');
  const lockDir = `${file}.lock`;
  await mkdir(lockDir, { recursive: true });
  const old = new Date(Date.now() - 60_000);
  await utimes(lockDir, old, old);

  const intruder = await liveChild();
  const owner = { pid: intruder.pid, startedAt: Date.now() };
  let entered = 0;

  const attempt = withLock(file, async () => { entered += 1; }, {
    timeoutMs: 150,
    staleMs: 30_000,
    probe: async (step) => {
      if (step !== 'verdict') return;
      await writeFile(join(lockDir, 'owner.json'), `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
    },
  });

  await assert.rejects(attempt, new RegExp(`held by pid ${intruder.pid}`));
  assert.equal(entered, 0);
  assert.deepEqual(await readJson(join(lockDir, 'owner.json'), null), owner);
  intruder.kill('SIGKILL');
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

// The window a takeover opens has to close. It has moved the dead owner's
// `owner.json` out of the folder and has not written its own yet, and a folder
// with no owner file is judged by its mtime alone — which the rename just
// refreshed — so nobody can take it before `staleMs`, which is longer than any
// caller's timeout. A Windows refusal that outlives every retry must therefore
// leave the folder the way it was found, with the dead owner's evidence back
// where the next waiter reads it, instead of a lock no one can take.
test('a takeover that cannot write its owner file leaves the lock claimable', async () => {
  const dir = await tempDir();
  const file = join(dir, 'state.json');
  const lockDir = `${file}.lock`;
  const owner = { pid: await deadPid(), startedAt: Date.now() - 60_000 };
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, 'owner.json'), JSON.stringify(owner), 'utf8');

  // Every attempt of the owner write is refused, as antivirus does.
  await assert.rejects(withLock(file, () => 'taken', {
    timeoutMs: 120,
    staleMs: 30_000,
    faults: (step) => (step === 'owner' ? 'EPERM' : null),
  }), new RegExp(`held by pid ${owner.pid} `));

  // The evidence is back, so the folder is a lock with an owner a waiter can
  // read: the dead pid, and its age, instead of "an unknown process".
  assert.deepEqual(await readJson(join(lockDir, 'owner.json'), null), owner);

  const value = await withLock(file, () => 'taken', { staleMs: 30_000 });

  assert.equal(value, 'taken');
  assert.deepEqual(await readdir(dir), []);
  await rm(dir, { recursive: true, force: true });
});

// One refusal is not a verdict, and waiting it out has to happen where the
// takeover is: a refusal that ends the attempt sends the loop back to the clock,
// which then re-judges the whole folder for as long as the handle lasts.
test('a takeover waits out refusals of the owner write in one attempt', async () => {
  const dir = await tempDir();
  const file = join(dir, 'state.json');
  const lockDir = `${file}.lock`;
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ pid: await deadPid(), startedAt: Date.now() - 60_000 }), 'utf8');

  let verdicts = 0;
  let refusals = 0;
  const value = await withLock(file, () => 'taken', {
    staleMs: 30_000,
    probe: async (step) => {
      if (step === 'verdict') verdicts += 1;
    },
    faults: (step) => (step === 'owner' && refusals < 3 ? (refusals += 1, 'EPERM') : null),
  });

  assert.equal(value, 'taken');
  assert.equal(refusals, 3, `the owner write was refused ${refusals} times instead of three`);
  assert.equal(verdicts, 1, `the takeover was judged ${verdicts} times instead of once`);
  await rm(dir, { recursive: true, force: true });
});

// One refusal per attempt `retryTransient` makes is the whole budget: the call
// ends by throwing instead of waiting, which is what Windows does to a rename
// that lands on a file antivirus is still reading.
const EVERY_ATTEMPT_REFUSED = 8;

// The two calls a bump makes around its own work that a busy Windows disk
// refuses for its whole budget: the owner write that takes the lock and the
// release that gives it back.
const REFUSED_STEPS = new Set(['owner', 'release']);

// The widest queue of contenders the tests below put in front of one lock: the
// twenty concurrent bumps of the counter, more than the sixteen children of the
// wider takeover race.
const WIDEST_QUEUE = 20;

// What a contender is given to reach the lock. Every call that waits out a
// refusal spends its budget around the critical section, so the queue drains at
// `queue × budget per bump`: with `owner` and `release` each refused for the
// whole budget, one bump costs ~580 ms and the twenty behind it pay that twenty
// times. Ten seconds cannot hold that, which is how a queue of live contenders
// reports a lock "held by pid N after 10000 ms" while every one of them is
// working and releasing.
const BUMP_WAIT_MS = 30_000;

// Refuses the first `count` attempts of each step in `steps`, counting per step
// so that a second call to the same step starts over, as a new `retryTransient`
// does.
function refusesFor(steps, count) {
  const attempts = new Map();
  return (step) => {
    if (!steps.has(step)) return null;
    const seen = attempts.get(step) ?? 0;
    attempts.set(step, seen + 1);
    return seen < count ? 'EPERM' : null;
  };
}

// A refusal of the rename that moves the dead owner's claim out is the same
// answer as a refusal of the owner write: the attempt gives it up and the loop
// judges the folder again, still inside the budget. Thrown out of `acquireLock`
// instead, one refusal that lasts the whole budget ends the bump with a code no
// caller of `withLock` has an answer for.
test('a takeover is taken over within the budget while its claim rename is refused', async () => {
  const dir = await tempDir();
  const file = join(dir, 'state.json');
  const lockDir = `${file}.lock`;
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ pid: await deadPid(), startedAt: Date.now() - 60_000 }), 'utf8');

  // The first takeover attempt is refused from end to end; the folder is left
  // exactly as it was found, so the next one finds the same dead owner.
  let refused = 0;
  const value = await withLock(file, () => 'taken', {
    timeoutMs: 2000,
    staleMs: 30_000,
    faults: (step) => (step === 'rename' && refused < EVERY_ATTEMPT_REFUSED ? (refused += 1, 'EPERM') : null),
  });

  assert.equal(value, 'taken');
  assert.equal(refused, EVERY_ATTEMPT_REFUSED, `the claim rename was refused ${refused} times`);
  assert.deepEqual(await readdir(dir), []);
  await rm(dir, { recursive: true, force: true });
});

test('a bump whose release is refused still leaves no folder behind', async () => {
  const dir = await tempDir();
  const file = join(dir, 'state.json');
  let refused = 0;

  // The release is the one call of the lifecycle that removes a file the holder
  // has just written and closed: Windows, and antivirus behind it, answer EPERM
  // to that delete for as long as they hold a handle. It ends the bump, and it
  // ends it with the folder still there holding the owner of a process that is
  // now gone and younger than `staleMs`, which no contender can take: the whole
  // queue behind it waits out its own timeout for nothing.
  const value = await withLock(file, () => 'bumped', {
    faults: (step) => (step === 'release' && refused < 3 ? (refused += 1, 'EPERM') : null),
  });

  assert.equal(value, 'bumped');
  assert.equal(refused, 3, `the release was refused ${refused} times instead of three`);
  assert.deepEqual(await readdir(dir), []);
  assert.equal(await withLock(file, () => 'free', { timeoutMs: 500 }), 'free');
  await rm(dir, { recursive: true, force: true });
});

// The holder empties its own folder and only then removes it, and between those
// two steps another contender can write its own owner file back in: the taker
// judged the folder stale before the unlink landed, or the next owner's mkdir
// lost the race and is retrying. ENOTEMPTY is that answer, not a failure of this
// holder, and the entry that answered is the only evidence every waiter of that
// folder reads — deleting it by retrying would take a lock from a live owner.
test('a release that finds the folder refilled leaves the new owner alone', async () => {
  const dir = await tempDir();
  const file = join(dir, 'state.json');
  const lockDir = `${file}.lock`;

  const value = await withLock(file, () => 'bumped', {
    faults: (step) => (step === 'release' ? 'ENOTEMPTY' : null),
  });

  assert.equal(value, 'bumped');
  // Whatever answered the rmdir is still there: it belongs to the contender
  // that wrote it, and this holder never touches it.
  assert.deepEqual(await readdir(dir), ['state.json.lock']);
  await rm(dir, { recursive: true, force: true });
});

// A folder that a contender already removed is not a failure either, and the
// next caller must not see a lock it has to wait out.
test('a release whose folder is already gone still lets the next caller in', async () => {
  const dir = await tempDir();
  const file = join(dir, 'state.json');
  const lockDir = `${file}.lock`;

  // The bump is the last thing that touches the folder, so the contender that
  // got there first removes it there, and the release that follows finds nothing
  // left to remove.
  const value = await withLock(file, async () => {
    await rm(lockDir, { recursive: true, force: true });
    return 'bumped';
  }, {
    faults: (step) => (step === 'release' ? 'ENOENT' : null),
  });

  assert.equal(value, 'bumped');
  assert.deepEqual(await readdir(dir), []);
  assert.equal(await withLock(file, () => 'free', { timeoutMs: 500 }), 'free');
  await rm(dir, { recursive: true, force: true });
});

// A release that fails for any other reason is still a failure: swallowing it
// would report a lock as released that is still held.
test('a release that fails for an unrelated reason still throws', async () => {
  const dir = await tempDir();
  const file = join(dir, 'state.json');

  await assert.rejects(withLock(file, () => 'bumped', {
    faults: (step) => (step === 'release' ? 'EACCES' : null),
  }), /EACCES/);
  await rm(dir, { recursive: true, force: true });
});

// Every call that waits out a Windows refusal spends its whole budget around the
// critical section, so a queue of contenders drains at `queue × budget`, not at
// the speed of the disk. The wait a contender is given has to cover that
// product, or a queue of live contenders reports a lock "held by pid N after
// 10000 ms" while every one of them is working and releasing.
test('the wait a contender is given covers the retry budget of the queue', async () => {
  const dir = await tempDir();
  const file = join(dir, 'state.json');
  await writeJsonAtomic(file, { count: 0 });

  // One refusal short of the budget, so every call is as slow as it can be and
  // still succeeds: what one bump can cost the contenders behind it.
  const startedAt = Date.now();
  await bump(file, 1, BUMP_WAIT_MS, refusesFor(REFUSED_STEPS, EVERY_ATTEMPT_REFUSED - 1));
  const worstBumpMs = Date.now() - startedAt;

  assert.ok(
    BUMP_WAIT_MS >= WIDEST_QUEUE * worstBumpMs,
    `${WIDEST_QUEUE} bumps that each wait out ${worstBumpMs} ms cost ${WIDEST_QUEUE * worstBumpMs} ms of queue, more than the ${BUMP_WAIT_MS} ms a contender is given`,
  );
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

async function bump(file, rounds, timeoutMs = BUMP_WAIT_MS, faults) {
  for (let round = 0; round < rounds; round += 1) {
    await withLock(file, async () => {
      const current = await readJson(file, { count: 0 });
      // The delay widens the window in which a lock-free update would be lost.
      await wait(10);
      await writeJsonAtomic(file, { count: current.count + 1 });
    }, { timeoutMs, faults });
  }
}

// `import.meta.url` is a URL, and the path part of a URL is percent-encoded
// and slash-prefixed: on Windows it reads `/C:/Users/...`, which no process can
// ever be started from, so `fork` fails and every forked child ends as
// "exited with 1" with nothing to explain it. `fileURLToPath` is the only
// spelling that is a real path on every platform.
const SELF = fileURLToPath(import.meta.url);

// The forked child runs this same file as its main module: it bumps the
// counter and exits before any test below is registered.
if (process.env.STATE_TEST_CHILD) {
  // Any mode but the default bumps nothing and fails on purpose, so a test can
  // prove the parent's rejection carries the child's own stderr without waiting
  // for a real crash to be reproducible.
  if (process.env.STATE_TEST_CHILD !== 'bump') {
    process.stderr.write(`state-test child ${process.env.STATE_TEST_CHILD}: the run file cannot be read\n`);
    process.exit(3);
  }
  // A bump that throws leaves the child to die of an unhandled rejection, which
  // prints its own message but not always before the pipes are gone: the parent
  // then knows only the exit code. `writeSync` on fd 2 is the one write that is
  // already out of the process when `exit` runs, so the reason and the stack
  // reach the parent instead of vanishing with the child.
  try {
    await bump(process.env.STATE_TEST_FILE, Number(process.env.STATE_TEST_ROUNDS));
  } catch (error) {
    writeSync(2, `state-test child bump: ${error?.code ?? error?.name} ${error?.message}\n${error?.stack ?? ''}\n`);
    process.exit(1);
  }
  process.exit(0);
}

// The last slice of the child's stderr. A child that dies with its output
// discarded can only say "exited with 1", which is the one message that never
// explains anything: a `fork` that cannot resolve the module, a lock that never
// frees, a syntax error in the very file the child runs. Two kilobytes is the
// whole stack of one failure and nothing more.
const STDERR_TAIL_BYTES = 2048;

function stderrTail(child) {
  const chunks = [];
  child.stderr?.on('data', (chunk) => chunks.push(chunk));
  return () => {
    const seen = Buffer.concat(chunks).subarray(-STDERR_TAIL_BYTES).toString('utf8').trim();
    return seen === '' ? '' : `: ${seen}`;
  };
}

function forkBumper(file, rounds, mode = 'bump') {
  const child = fork(SELF, [], {
    env: { ...process.env, STATE_TEST_CHILD: mode, STATE_TEST_FILE: file, STATE_TEST_ROUNDS: String(rounds) },
    // The child's stderr is a pipe the rejection message reads, never 'ignore'.
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const tail = stderrTail(child);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    // 'close', not 'exit': the pipes are only drained when every stdio stream
    // is done, so on 'exit' the tail of a child that died can still be empty.
    const startedAt = Date.now();
    child.once('close', (code) => {
      const elapsedMs = Date.now() - startedAt;
      if (code === 0) return resolve();
      // How long the child lived is the other half of the diagnosis: a child
      // that died in a millisecond never reached the lock, and one that lived
      // until the parent's own timeout is a lock nobody released.
      reject(new Error(`child exited with ${code} after ${elapsedMs} ms${tail()}`));
    });
  });
}

// A failing child must name its own failure: the rejection carries the tail of
// its stderr, so an unresolvable module or an unreadable run file is visible
// without a second run of the suite. Before, `stdio` was 'ignore' and the only
// message was "child exited with 1".
test('a forked child that fails says why on the rejection', async () => {
  const dir = await tempDir();
  const file = join(dir, 'counter.json');

  await assert.rejects(() => forkBumper(file, 1, 'unreadable'), (error) => {
    assert.match(error.message, /^child exited with 3/);
    assert.match(error.message, /state-test child unreadable: the run file cannot be read/);
    return true;
  });
  await rm(dir, { recursive: true, force: true });
});

test('a forked child whose bump throws says what threw and how long it lived', async () => {
  const dir = await tempDir();
  // A run file that is a folder makes the child's own `readJson` throw, which
  // is the shape of the failure that reached Windows as "exited with 1" and an
  // empty stderr: the words are written with `writeSync` before the exit, so
  // the parent must now receive them plus the time the child lived.
  const folder = join(dir, 'counter.json');
  await mkdir(folder, { recursive: true });

  await assert.rejects(() => forkBumper(folder, 1), (error) => {
    assert.match(error.message, /^child exited with 1 after \d+ ms: state-test child bump: /);
    assert.match(error.message, /Cannot read/);
    return true;
  });
  await rm(dir, { recursive: true, force: true });
});

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