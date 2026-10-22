import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';

const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY']);
const RENAME_MAX_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 10;
const LOCK_POLL_MS = 25;
const LOCK_OWNER_FILE = 'owner.json';
const LOCK_CLAIM_PREFIX = `${LOCK_OWNER_FILE}.claim.`;

const NO_PROBE = () => {};

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

// Windows keeps a short-lived handle on a file that was just closed, so a
// single rename can fail with EPERM/EBUSY even when nothing else uses the file.
async function renameWithRetry(from, to, codes = RENAME_RETRY_CODES) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const retryable = codes.has(error.code) && attempt < RENAME_MAX_ATTEMPTS;
      if (!retryable) throw error;
      await sleep(RENAME_BACKOFF_MS);
    }
  }
}

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
async function readLockOwner(lockDir) {
  try {
    const owner = await readJson(join(lockDir, LOCK_OWNER_FILE), null);
    return owner && typeof owner.pid === 'number' ? owner : null;
  } catch {
    return null;
  }
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
// EEXIST for the one that got there first.
async function writeOwnerExclusive(lockDir, owner) {
  const handle = await open(join(lockDir, LOCK_OWNER_FILE), 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function currentOwner() {
  return { pid: process.pid, startedAt: Date.now() };
}

// Claims a folder that nobody owns. It has no owner file, so the only evidence
// left is its age, and the exclusive create is what turns the verdict into the
// claim without a window in between: EEXIST means a taker or a new owner wrote
// its own claim while we were reading the clock.
async function claimFolder(lockDir, staleMs, probe) {
  const startedAt = await lockStartedAt(lockDir, null);
  if (startedAt === null || Date.now() - startedAt <= staleMs) return false;
  await probe('verdict');
  try {
    await writeOwnerExclusive(lockDir, currentOwner());
  } catch (error) {
    if (error.code === 'EEXIST' || error.code === 'ENOENT') return false;
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
async function claimStaleLock(lockDir, staleMs, probe) {
  const owner = await readLockOwner(lockDir);
  if (!owner) return claimFolder(lockDir, staleMs, probe);
  if (isProcessAlive(owner.pid)) return false;
  const startedAt = await lockStartedAt(lockDir, owner);
  if (startedAt === null || Date.now() - startedAt <= staleMs) return false;

  await probe('verdict');
  const claim = join(lockDir, `${LOCK_CLAIM_PREFIX}${process.pid}.${randomBytes(4).toString('hex')}`);
  try {
    await rename(join(lockDir, LOCK_OWNER_FILE), claim);
  } catch (error) {
    // ENOENT: another taker took this claim first, or the folder is a new one
    // whose owner has not written its claim yet. Neither is ours to move.
    if (error.code === 'ENOENT') return false;
    throw error;
  }

  if (!isSameOwner(owner, await readJson(claim, null).catch(() => null))) {
    // Not the claim we judged: put it back, since whoever waits on that folder
    // decides from it, and the owner that wrote it does not read it back.
    await renameWithRetry(claim, join(lockDir, LOCK_OWNER_FILE)).catch(() => {});
    return false;
  }
  await rm(claim, { force: true });

  await probe('claimed');
  try {
    await writeOwnerExclusive(lockDir, currentOwner());
  } catch (error) {
    if (error.code === 'EEXIST' || error.code === 'ENOENT') return false;
    throw error;
  }
  return true;
}

function describeOwner(owner) {
  return owner ? `pid ${owner.pid} since ${new Date(owner.startedAt).toISOString()}` : 'an unknown process';
}

// mkdir without recursive fails with EEXIST, which is the atomic mutual
// exclusion primitive available on Linux, macOS and Windows. The owner file
// goes in right after, exclusively: a folder that a taker claimed in between
// costs one more attempt and nothing else, since the callback has not run yet
// and the folder is not ours to remove.
async function tryCreateLock(lockDir) {
  try {
    await mkdir(lockDir);
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }

  try {
    await writeOwnerExclusive(lockDir, currentOwner());
  } catch (error) {
    if (error.code === 'EEXIST' || error.code === 'ENOENT') return false;
    await rm(lockDir, { recursive: true, force: true });
    throw new Error(`Cannot write the owner of ${lockDir}: ${error.message}`, { cause: error });
  }
  return true;
}

async function acquireLock(lockDir, timeoutMs, staleMs, probe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await tryCreateLock(lockDir)) return;
    if (await claimStaleLock(lockDir, staleMs, probe)) return;
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
 * has to survive instead of waiting for one to show up under load.
 */
export async function withLock(dir, fn, { timeoutMs = 5000, staleMs = 30000, probe = NO_PROBE } = {}) {
  const lockDir = `${dir}.lock`;
  await acquireLock(lockDir, timeoutMs, staleMs, probe);

  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}