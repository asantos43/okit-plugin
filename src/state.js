import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';

// Windows refuses a call that lands on a file it has just closed, and antivirus
// refuses one it is reading: EPERM/EBUSY, for as long as that handle lasts, which
// is longer than a flat pause guesses. Every call that has to land waits out a
// pause that grows, and only a real answer (EEXIST, ENOENT) or an unexpected code
// stops the wait and goes back to the caller.
const TRANSIENT_CODES = new Set(['EPERM', 'EBUSY']);
// Emptied but not yet removed: another contender wrote an entry back between
// the unlink and the rmdir, so the folder that answered is not the one this
// holder emptied.
const REPOPULATED_CODE = 'ENOTEMPTY';
const TRANSIENT_MAX_ATTEMPTS = 8;
const TRANSIENT_BACKOFF_MS = 10;
const TRANSIENT_BACKOFF_CAP_MS = 200;
const LOCK_POLL_MS = 25;
const LOCK_OWNER_FILE = 'owner.json';
const LOCK_CLAIM_PREFIX = `${LOCK_OWNER_FILE}.claim.`;

// Two test seams: `probe` drives the interleaving a takeover has to survive, and
// `faults` raises the code Windows would raise for one step of it, which is the
// only way the refusal paths below are reachable on any other platform.
const NO_PROBE = () => {};
const NO_FAULTS = () => null;

const faultError = (step, code) => Object.assign(new Error(`${step} the lock: ${code}`), { code });

async function retryTransient(step, faults, call) {
  for (let attempt = 1; ; attempt += 1) {
    const injected = faults(step, attempt);
    try {
      if (injected !== null) throw faultError(step, injected);
      return await call();
    } catch (error) {
      const retryable = TRANSIENT_CODES.has(error.code) && attempt < TRANSIENT_MAX_ATTEMPTS;
      if (!retryable) throw error;
      await sleep(Math.min(TRANSIENT_BACKOFF_MS * attempt, TRANSIENT_BACKOFF_CAP_MS));
    }
  }
}

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * Reads a JSON file, returning `fallback` when the file does not exist.
 */
export async function readJson(file, fallback) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Cannot read ${file}: ${error.message}`, { cause: error });
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${file}: ${error.message}`, { cause: error });
  }
}

/**
 * Writes the data and flushes it to disk before the file is closed, so the
 * rename below can never expose a half-written file.
 */
async function writeAndSync(file, data) {
  const handle = await open(file, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Windows keeps a short-lived handle on a file that was just closed, so a single
// rename can fail with EPERM/EBUSY even when nothing else uses the file.
const renameWithRetry = (from, to, faults = NO_FAULTS) => retryTransient('rename', faults, () => rename(from, to));

/**
 * Writes JSON atomically: a sibling temporary file is synced and then renamed
 * over the target, which is atomic on every supported platform.
 */
export async function writeJsonAtomic(file, value) {
  const folder = dirname(file);
  const temp = join(folder, `${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  await mkdir(folder, { recursive: true });

  try {
    await writeAndSync(temp, `${JSON.stringify(value, null, 2)}\n`);
    await renameWithRetry(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw new Error(`Cannot write ${file}: ${error.message}`, { cause: error });
  }
}

// ESRCH means the pid is gone; EPERM means it exists but belongs to someone
// else. Any other error is treated as alive to avoid stealing a live lock.
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

// A lock folder whose owner file is unreadable or malformed is reported as
// unknown rather than fatal: the wait loop still ends with a clear timeout.
function parseOwner(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const owner = JSON.parse(raw);
    return owner && typeof owner.pid === 'number' ? owner : null;
  } catch {
    return null;
  }
}

async function readLockOwner(lockDir) {
  return parseOwner(await readFile(join(lockDir, LOCK_OWNER_FILE), 'utf8').catch(() => null));
}

function isSameOwner(a, b) {
  if (!a || !b) return a === b;
  return a.pid === b.pid && a.startedAt === b.startedAt;
}

// A process that died between mkdir and the owner write leaves a lock folder
// with no owner. Its mtime is the only age evidence left and no pid can vouch
// for it, so only the clock decides when it is stale.
async function lockStartedAt(lockDir, owner) {
  if (owner && typeof owner.startedAt === 'number') return owner.startedAt;
  try {
    return (await stat(lockDir)).mtimeMs;
  } catch {
    return null;
  }
}

// Writing the owner file with an exclusive create is what makes a folder a lock
// that exactly one process can own: the file lands whole, or it fails with
// EEXIST for the one that got there first. EEXIST is a real answer and is never
// waited out; a Windows refusal is waited out, because that window is the only
// moment in which the folder has no evidence of who owns it.
async function writeOwnerRaw(lockDir, raw) {
  const handle = await open(join(lockDir, LOCK_OWNER_FILE), 'wx');
  try {
    await handle.writeFile(raw);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function writeOwnerExclusive(lockDir, owner, faults = NO_FAULTS) {
  return retryTransient('owner', faults, () => writeOwnerRaw(lockDir, `${JSON.stringify(owner, null, 2)}\n`));
}

function currentOwner() {
  return { pid: process.pid, startedAt: Date.now() };
}

// Claims a folder that nobody owns. It has no owner file, so the only evidence
// left is its age, and the exclusive create is what turns the verdict into the
// claim without a window in between: EEXIST means a taker or a new owner wrote
// its own claim while we were reading the clock.
async function claimFolder(lockDir, staleMs, probe, faults) {
  const startedAt = await lockStartedAt(lockDir, null);
  if (startedAt === null || Date.now() - startedAt <= staleMs) return false;
  await probe('verdict');
  try {
    await writeOwnerExclusive(lockDir, currentOwner(), faults);
  } catch (error) {
    if (error.code === 'EEXIST' || error.code === 'ENOENT') return false;
    // Nothing is moved out of this folder, so the mtime a waiter reads is still
    // the one this verdict was made on: give the claim up and let the loop judge
    // again instead of ending the run over a refusal that outlived every retry.
    if (TRANSIENT_CODES.has(error.code)) return false;
    throw error;
  }
  return true;
}

// The interleaving that used to let two owners in, with T1 a waiter that has
// just judged the dead owner's claim stale and W the taker that won before it:
//
//   T1  rename(lock -> parked)  // by now W owns the folder, so T1 moves W's
//   T3  mkdir(lock)             // the path is free while T1 still holds it
//   T1  rename(parked -> lock)  // ENOTEMPTY, swallowed as "someone else took it"
//   W   release                 // rm(lock) drops T3's live folder
//   T4  enters                  // now T3 and T4 share the critical section
//
// Moving a folder aside cannot be undone atomically, so the takeover no longer
// moves one: it renames the dead owner's *claim* out of the folder instead.
// That is safe because a claim is evidence for waiters and is never read back by
// the owner that wrote it, and because the folder it leaves behind holds no
// claim and has a fresh mtime, so no other taker can move it while this one
// decides. Only the taker whose rename lands reads back the claim it took, and
// it checks that this is the same dead owner it judged.
async function claimStaleLock(lockDir, staleMs, probe, faults) {
  const owner = await readLockOwner(lockDir);
  if (!owner) return claimFolder(lockDir, staleMs, probe, faults);
  if (isProcessAlive(owner.pid)) return false;
  const startedAt = await lockStartedAt(lockDir, owner);
  if (startedAt === null || Date.now() - startedAt <= staleMs) return false;

  await probe('verdict');
  const claim = join(lockDir, `${LOCK_CLAIM_PREFIX}${process.pid}.${randomBytes(4).toString('hex')}`);
  try {
    await renameWithRetry(join(lockDir, LOCK_OWNER_FILE), claim, faults);
  } catch (error) {
    // ENOENT: another taker took this claim first, or the folder is a new one
    // whose owner has not written its claim yet. Neither is ours to move.
    if (error.code === 'ENOENT') return false;
    // Nothing has been moved out of this folder, so the evidence every waiter
    // reads is still where this verdict found it: give the attempt up and let
    // the loop judge again rather than end the run over a refusal that outlived
    // every retry, the same answer the owner write below gives.
    if (TRANSIENT_CODES.has(error.code)) return false;
    throw error;
  }

  // From here on the folder has no owner file at all, and its mtime was just
  // refreshed by the rename above: `claimFolder` cannot judge it stale before
  // `staleMs`, which is longer than every caller's timeout, so a takeover that
  // leaves it like this locks every other process out for good. Every way out of
  // the window below therefore puts the dead owner's evidence back.
  const raw = await readFile(claim, 'utf8').catch(() => null);
  if (!isSameOwner(owner, parseOwner(raw))) {
    // Not the claim we judged: put it back, since whoever waits on that folder
    // decides from it, and the owner that wrote it does not read it back.
    await restoreClaim(lockDir, claim, raw, faults);
    return false;
  }
  // The claim has served its purpose, so the folder is ours to write into. A
  // folder that cannot drop it is still a folder with an owner file, which is
  // what every waiter reads, so a failed removal is litter, not a lost lock.
  await rm(claim, { force: true }).catch(() => {});

  await probe('claimed');
  try {
    await writeOwnerExclusive(lockDir, currentOwner(), faults);
  } catch (error) {
    await restoreClaim(lockDir, claim, raw, faults);
    if (error.code === 'EEXIST' || error.code === 'ENOENT') return false;
    // The evidence is back, so the folder is claimable again and this process
    // has lost nothing but the attempt: the loop comes back and judges once more.
    if (TRANSIENT_CODES.has(error.code)) return false;
    throw error;
  }
  return true;
}

// Puts a claim where the waiters of that folder read it. The rename is the fast
// path; when Windows still refuses to move the file, its bytes go back through
// the same exclusive create that made it a claim, which loses only to a taker
// that got there first.
async function restoreClaim(lockDir, claim, raw, faults) {
  try {
    await renameWithRetry(claim, join(lockDir, LOCK_OWNER_FILE), faults);
    return;
  } catch {
    // The file will not move; its bytes are still in hand.
  }
  if (raw === null) return;
  try {
    await writeOwnerRaw(lockDir, raw);
  } catch (error) {
    // EEXIST: an owner is there now. ENOENT: the folder is gone. Neither folder
    // is ours to repair, and both are already answerable by a waiter.
    if (error.code !== 'EEXIST' && error.code !== 'ENOENT') throw error;
  }
}

function describeOwner(owner) {
  return owner ? `pid ${owner.pid} since ${new Date(owner.startedAt).toISOString()}` : 'an unknown process';
}

// mkdir without recursive fails with EEXIST, which is the atomic mutual
// exclusion primitive available on Linux, macOS and Windows. The owner file
// goes in right after, exclusively: a folder that a taker claimed in between
// costs one more attempt and nothing else, since the callback has not run yet
// and the folder is not ours to remove.
async function tryCreateLock(lockDir, faults) {
  try {
    await mkdir(lockDir);
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }

  try {
    await writeOwnerExclusive(lockDir, currentOwner(), faults);
  } catch (error) {
    if (error.code === 'EEXIST' || error.code === 'ENOENT') return false;
    await rm(lockDir, { recursive: true, force: true });
    throw new Error(`Cannot write the owner of ${lockDir}: ${error.message}`, { cause: error });
  }
  return true;
}

async function acquireLock(lockDir, timeoutMs, staleMs, probe, faults) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await tryCreateLock(lockDir, faults)) return;
    if (await claimStaleLock(lockDir, staleMs, probe, faults)) return;
    if (Date.now() >= deadline) {
      const owner = await readLockOwner(lockDir);
      throw new Error(`Lock ${lockDir} is held by ${describeOwner(owner)} after ${timeoutMs} ms`);
    }
    await sleep(LOCK_POLL_MS);
  }
}

/**
 * Runs `fn` while holding an exclusive lock on `dir`, then releases it.
 *
 * `probe` is a test seam: while a stale lock is taken over it is awaited with
 * 'verdict' and 'claimed', which lets a test drive the interleaving a takeover
 * has to survive instead of waiting for one to show up under load. `faults` is
 * the same idea for the refusals Windows answers: it is asked for each attempt of
 * a step ('rename', 'owner', 'release') and returns the code to fail with, or
 * null.
 */
export async function withLock(dir, fn, { timeoutMs = 5000, staleMs = 30000, probe = NO_PROBE, faults = NO_FAULTS } = {}) {
  const lockDir = `${dir}.lock`;
  await acquireLock(lockDir, timeoutMs, staleMs, probe, faults);

  try {
    return await fn();
  } finally {
    // The release removes the owner file this holder has just written and
    // closed, which is the one file of the lifecycle that Windows and the
    // antivirus behind it refuse to delete for as long as they hold a handle.
    // It is waited out like every other call, because a refusal here is not only
    // this bump's problem: it leaves the folder behind holding the owner of a
    // process that is now gone and younger than `staleMs`, which is longer than
    // every caller's timeout, so every contender in the queue behind it would
    // report a lock "held by pid N" that nobody can ever take.
    await releaseLock(lockDir, faults);
  }
}

// ENOTEMPTY means the folder answered the unlink but not the rmdir: something
// wrote an entry back between them, so the folder that is left is not the one
// this holder emptied — it is the next owner's, or a taker's claim. Retrying
// would delete that entry, which is the one piece of evidence every waiter of
// that folder reads, so it is reported as released and left alone. ENOENT means
// a contender that got there first already removed it.
async function releaseLock(lockDir, faults) {
  try {
    await retryTransient('release', faults, () => rm(lockDir, { recursive: true, force: true }));
  } catch (error) {
    if (error.code !== REPOPULATED_CODE && error.code !== 'ENOENT') throw error;
  }
}