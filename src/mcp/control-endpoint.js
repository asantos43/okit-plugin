// Where the local control API listens and who may talk to it: the endpoint of
// one process, the folder that holds its record and the token that opens the
// door. Nothing here opens a socket: the module decides where the API lives
// and keeps the registry of the processes that are listening.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as filesystem from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { paths } from '../store.js';

// The platforms that answer on a socket file; the others answer on a named
// pipe, which has no length limit.
const POSIX_PLATFORMS = new Set(['linux', 'darwin']);
// The longest a socket file may be on POSIX.
export const SOCKET_PATH_LIMIT = 100;
// The mode of the folder and of the record: the owner of the machine only.
const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;
// The name of a record and of the socket file of one process.
const RECORD_SUFFIX = '.json';
const SOCKET_SUFFIX = '.sock';
// The most bytes a record may have: a record is a few lines of JSON.
const MAX_RECORD_BYTES = 65536;

/**
 * Where the control API of one process listens: a socket file inside the
 * control folder on POSIX, a named pipe on Windows.
 *
 * @param {{root: string, pid: number, platform?: string}} options
 * @returns {string} the endpoint of the API
 * @throws when the platform is not one the API knows
 */
export function endpointFor({ root, pid, platform = process.platform }) {
  if (POSIX_PLATFORMS.has(platform)) return join(paths(root).control, `${pid}${SOCKET_SUFFIX}`);
  if (platform === 'win32') {
    // The name of a pipe is a name of the machine, so it carries the root it
    // belongs to: two roots of the same user never share one pipe.
    const digest = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\okit-${digest}-${pid}`;
  }
  throw new Error(`control api: platform ${platform} is not supported`);
}

/**
 * Whether the endpoint fits the platform: a socket file has a length limit
 * and a named pipe has none.
 *
 * @param {string} endpoint the endpoint of the API
 * @param {string} [platform]
 * @returns {boolean}
 */
export function fitsPlatform(endpoint, platform = process.platform) {
  if (!POSIX_PLATFORMS.has(platform)) return true;
  return Buffer.byteLength(endpoint) <= SOCKET_PATH_LIMIT;
}

/**
 * The folder that holds the records of the control API, private to the user
 * who owns it: nobody else may talk to the API.
 *
 * @param {string} root the state root
 * @param {{platform?: string, fs?: object}} [options]
 * @returns {Promise<string>} the folder of the control API
 * @throws when the folder belongs to another user or is not a plain folder
 */
export async function openControlDir(root, { platform = process.platform, fs = filesystem } = {}) {
  const dir = paths(root).control;
  // Windows has no mode of its own, so the folder is only created there.
  if (!POSIX_PLATFORMS.has(platform)) {
    await fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIR });
    return dir;
  }

  await fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIR }).catch((error) => {
    // A path that is there and is not a folder is told by the check below.
    if (error.code !== 'EEXIST' && error.code !== 'ENOENT') throw error;
  });
  const plain = await fs.lstat(dir).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  // A link or a file is not the private folder of the user: what is behind
  // it would be the one that decides.
  if (plain === null || plain.isSymbolicLink() || !plain.isDirectory()) {
    throw new Error(`control api: ${dir} is not a plain folder`);
  }
  const info = await fs.stat(dir);
  if (info.uid !== process.getuid()) {
    // A folder of another user: the mode is tried anyway, and the owner is
    // what decides after it.
    await fs.chmod(dir, PRIVATE_DIR).catch(() => {});
    const after = await fs.stat(dir);
    if (after.uid !== process.getuid()) {
      throw new Error(`control api: ${dir} is not owned by this user`);
    }
    return dir;
  }
  // Ours: the mode of a folder that was just created is whatever the umask
  // left of the one asked for, and the mode of one that already existed is
  // whatever it was, so it is set again here.
  await fs.chmod(dir, PRIVATE_DIR);
  return dir;
}

/**
 * A token for one process: 32 random bytes in hex, so a caller that does not
 * know it cannot guess it.
 *
 * @returns {string} the token
 */
export function newToken() {
  return randomBytes(32).toString('hex');
}

/**
 * Writes the record of one process: the endpoint it listens on, the token
 * that opens it and when it started. The file is private to the user and
 * lands whole, through a temporary file of the same folder.
 *
 * @param {string} root the state root
 * @param {{pid: number, endpoint: string, token: string, startedAt?: number, version?: string}} record
 * @param {{platform?: string, fs?: object}} [options]
 * @returns {Promise<string>} the path of the record
 */
export async function writeRecord(root, record, { platform = process.platform, fs = filesystem } = {}) {
  const dir = await openControlDir(root, { platform, fs });
  const file = join(dir, `${record.pid}${RECORD_SUFFIX}`);
  const temp = join(dir, `.${record.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const payload = {
    pid: record.pid,
    endpoint: record.endpoint,
    token: record.token,
    startedAt: record.startedAt,
    version: record.version,
  };

  try {
    await fs.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: PRIVATE_FILE });
    if (POSIX_PLATFORMS.has(platform)) await fs.chmod(temp, PRIVATE_FILE);
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return file;
}

/**
 * Removes the record of one process and, on POSIX, the socket file that goes
 * with it. A file that is not there is not a failure: the record of a process
 * that died is gone already.
 *
 * @param {string} root the state root
 * @param {number|string} pid the process
 * @param {{platform?: string, fs?: object}} [options]
 * @returns {Promise<void>}
 */
export async function removeRecord(root, pid, { platform = process.platform, fs = filesystem } = {}) {
  const dir = paths(root).control;
  const files = [join(dir, `${pid}${RECORD_SUFFIX}`)];
  if (POSIX_PLATFORMS.has(platform)) files.push(join(dir, `${pid}${SOCKET_SUFFIX}`));
  for (const file of files) {
    // `force` ignores a file that is not there.
    await fs.rm(file, { force: true });
  }
}

/**
 * The records of the processes that are still alive. A record that is
 * corrupted, incomplete or of a process that died is removed, together with
 * the socket file that goes with it.
 *
 * On POSIX the folder of the records is only read when it is a plain folder
 * of this user, and a record is only read when it is a plain file of this
 * user: a link, a fifo or a file that is too big is removed instead of being
 * opened. A record that says another endpoint than the one the process of
 * that pid must have is removed too, so the client never connects to an
 * endpoint a record invented.
 *
 * @param {string} root the state root
 * @param {{isAlive?: (pid: number) => boolean, platform?: string, fs?: object}} [options]
 * @returns {Promise<object[]>} the records of the live processes
 */
export async function listRecords(root, { isAlive = defaultIsAlive, platform = process.platform, fs = filesystem } = {}) {
  const dir = paths(root).control;
  const isPosix = POSIX_PLATFORMS.has(platform);
  if (isPosix) {
    // The folder is looked at before anything is read: a link or a folder of
    // another user is not ours to open, and nothing of it is removed.
    const info = await fs.lstat(dir).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info === null) return [];
    if (info.isSymbolicLink() || !info.isDirectory()
      || info.uid !== process.getuid() || (info.mode & 0o022) !== 0) return [];
  }

  let names;
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const alive = [];
  for (const name of names) {
    if (!name.endsWith(RECORD_SUFFIX)) continue;
    const file = join(dir, name);
    if (isPosix) {
      // The file is looked at before it is opened: a fifo would block the
      // read, and a record of another user is not ours to read.
      const info = await fs.lstat(file).catch(() => null);
      const plain = info !== null
        && info.isFile()
        && info.uid === process.getuid()
        && (info.mode & 0o022) === 0
        && info.size <= MAX_RECORD_BYTES;
      if (!plain) {
        await prune(root, name, { platform, fs });
        continue;
      }
    }
    const record = await readRecord(file, fs);
    if (!isUsable(record, name, root, platform, isPosix) || !isAlive(record.pid)) {
      await prune(root, name, { platform, fs });
      continue;
    }
    if (isPosix) {
      // The endpoint itself must be a socket private to this user.
      const info = await fs.lstat(record.endpoint).catch(() => null);
      if (info === null || !info.isSocket()
        || info.uid !== process.getuid() || (info.mode & 0o022) !== 0) {
        await prune(root, name, { platform, fs });
        continue;
      }
    }
    alive.push(record);
  }
  return alive;
}

/**
 * Whether the token given is the one expected, compared in a way that does
 * not tell how much of it was right.
 *
 * @param {string} expected the token of the record
 * @param {string} given the token of the caller
 * @returns {boolean}
 */
export function tokenMatches(expected, given) {
  if (typeof expected !== 'string' || typeof given !== 'string') return false;
  if (expected.length !== given.length) return false;
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(given, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// The pid of the name of a record, so a record that cannot be read is still
// removed by the name it was found under.
const pidOf = (name) => name.slice(0, -RECORD_SUFFIX.length);

// The pid of the name of a record, when the name holds one.
function pidInName(name) {
  const text = pidOf(name);
  if (!/^\d+$/.test(text)) return null;
  const pid = Number(text);
  return Number.isSafeInteger(pid) ? pid : null;
}

// A record that cannot be used is removed with the name it was found under,
// and a failure of the removal is not a failure of the listing.
async function prune(root, name, { platform, fs }) {
  await removeRecord(root, pidOf(name), { platform, fs }).catch(() => {});
}

// A record that can be used: the pid of its name is the pid it says, and the
// endpoint it carries is the one the process of that pid must have, so the
// client never connects to an endpoint a record invented.
function isUsable(record, name, root, platform, isPosix) {
  if (!isComplete(record)) return false;
  if (isPosix) {
    const pid = pidInName(name);
    if (pid === null || pid !== record.pid) return false;
  }
  return record.endpoint === endpointFor({ root, pid: record.pid, platform });
}

async function readRecord(file, fs) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    // A record that cannot be parsed is a record that cannot be used.
    return null;
  }
}

// A record without an endpoint and a token says nothing about a process, so it
// is not a record at all.
function isComplete(record) {
  return record !== null
    && typeof record === 'object'
    && Number.isInteger(record.pid)
    && typeof record.endpoint === 'string'
    && record.endpoint !== ''
    && typeof record.token === 'string'
    && record.token !== '';
}

// ESRCH means the process is gone; EPERM means it is there but belongs to
// someone else. Any other error is treated as alive, so a live process is
// never taken away by a question nobody could answer.
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}
