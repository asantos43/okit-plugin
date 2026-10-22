import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';

const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY']);
// Giving a moved-aside lock back can also lose the race against the folder a
// new owner just created at the path, which is worth another few attempts.
const RESTORE_RETRY_CODES = new Set([...RENAME_RETRY_CODES, 'EEXIST', 'ENOTEMPTY']);
const RENAME_MAX_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 10;
const LOCK_POLL_MS = 25;
const LOCK_OWNER_FILE = 'owner.json';

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

// Renaming a stale lock aside is the only race-free takeover: exactly one
// waiter moves the folder and the others get ENOENT and loop. Deleting it in
// place would let a waiter erase the fresh lock of whoever took over first.
async function parkStaleLock(lockDir, seen, startedAt) {
  const parked = `${lockDir}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    await rename(lockDir, parked);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EEXIST') return false;
    throw error;
  }

  const actual = await readLockOwner(parked);
  const sameLock = isSameOwner(seen, actual)
    && await lockStartedAt(parked, actual) === startedAt;
  if (!sameLock || (actual && isProcessAlive(actual.pid))) {
    // We moved a lock that is not the stale one we judged: give it back.
    try {
      await renameWithRetry(parked, lockDir, RESTORE_RETRY_CODES);
    } catch {
      // Someone else took the path; leave the folder alone. Its owner then
      // fails loudly instead of silently running unlocked.
    }
    return false;
  }

  await rm(parked, { recursive: true, force: true });
  return true;
}

// A lock left behind by a crashed process would block everyone forever, so an
// old lock whose owner is dead is moved aside and taken over.
async function removeStaleLock(lockDir, staleMs) {
  const owner = await readLockOwner(lockDir);
  const startedAt = await lockStartedAt(lockDir, owner);
  if (startedAt === null || Date.now() - startedAt <= staleMs) return false;
  if (owner && isProcessAlive(owner.pid)) return false;
  // The verdict above is only evidence about the folder as it was a moment ago.
  // Until the rename in parkStaleLock runs, another taker can already have
  // taken the stale lock, or a new owner can be between its mkdir and the write
  // of its owner file: that folder has no evidence of its own yet, so a verdict
  // read before it existed must never be used to move it aside. Reading the
  // lock again right before renaming keeps the takeover tied to the folder it
  // judged.
  const current = await readLockOwner(lockDir);
  if (!isSameOwner(owner, current)) return false;
  if (await lockStartedAt(lockDir, current) !== startedAt) return false;
  return parkStaleLock(lockDir, owner, startedAt);
}

function describeOwner(owner) {
  return owner ? `pid ${owner.pid} since ${new Date(owner.startedAt).toISOString()}` : 'an unknown process';
}

// mkdir without recursive fails with EEXIST, which is the atomic mutual
// exclusion primitive available on Linux, macOS and Windows. The owner file
// goes in right after, so a folder that disappears in between (a taker that
// judged an older lock stale) costs one more attempt and nothing else: the
// callback has not run yet, and there is no folder of ours left to clean up.
async function tryCreateLock(lockDir) {
  try {
    await mkdir(lockDir);
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }

  const owner = { pid: process.pid, startedAt: Date.now() };
  try {
    await writeFile(join(lockDir, LOCK_OWNER_FILE), `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    await rm(lockDir, { recursive: true, force: true });
    throw new Error(`Cannot write the owner of ${lockDir}: ${error.message}`, { cause: error });
  }
  return true;
}

async function acquireLock(lockDir, timeoutMs, staleMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await tryCreateLock(lockDir)) return;
    if (await removeStaleLock(lockDir, staleMs)) continue;
    if (Date.now() >= deadline) {
      const owner = await readLockOwner(lockDir);
      throw new Error(`Lock ${lockDir} is held by ${describeOwner(owner)} after ${timeoutMs} ms`);
    }
    await sleep(LOCK_POLL_MS);
  }
}

/**
 * Runs `fn` while holding an exclusive lock on `dir`, then releases it.
 */
export async function withLock(dir, fn, { timeoutMs = 5000, staleMs = 30000 } = {}) {
  const lockDir = `${dir}.lock`;
  await acquireLock(lockDir, timeoutMs, staleMs);

  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}