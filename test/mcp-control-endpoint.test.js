// Where the local control API listens and who may talk to it: the name of the
// endpoint on each platform, the length it has to fit in, the folder and the
// record that only the owner of the machine can read, and the registry of the
// processes that are still alive.

import assert from 'node:assert/strict';
import * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { after, test } from 'node:test';

import {
  endpointFor,
  fitsPlatform,
  listRecords,
  newToken,
  openControlDir,
  removeRecord,
  tokenMatches,
  writeRecord,
} from '../src/mcp/control-endpoint.js';
import { paths } from '../src/store.js';

const { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } = filesystem;

// The modes of a folder and of a file are a fact of POSIX only.
const POSIX_ONLY = process.platform === 'win32' ? 'the modes are a fact of POSIX' : false;

const roots = [];

async function tempRoot() {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-control-test-'));
  roots.push(dir);
  return dir;
}

after(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

test('the endpoint is a socket file on POSIX and a named pipe on Windows', async () => {
  const root = await tempRoot();
  const control = paths(root).control;

  for (const platform of ['linux', 'darwin']) {
    assert.equal(endpointFor({ root, pid: 4242, platform }), join(control, '4242.sock'));
  }

  const pipe = endpointFor({ root, pid: 4242, platform: 'win32' });
  assert.match(pipe, /^\\\\\.\\pipe\\okit-[0-9a-f]{16}-4242$/);
  // The pipe carries the root it belongs to, so two roots never share one.
  const other = endpointFor({ root: await tempRoot(), pid: 4242, platform: 'win32' });
  assert.notEqual(pipe, other);

  assert.throws(() => endpointFor({ root, pid: 4242, platform: 'sunos' }),
    /control api: platform sunos is not supported/);
});

test('a socket path of 100 bytes fits and one of 101 does not', () => {
  const exact = '/'.repeat(100);
  const long = '/'.repeat(101);
  assert.equal(Buffer.byteLength(exact), 100);
  assert.equal(fitsPlatform(exact, 'linux'), true);
  assert.equal(fitsPlatform(exact, 'darwin'), true);
  assert.equal(fitsPlatform(long, 'linux'), false);
  // A named pipe has no length limit.
  assert.equal(fitsPlatform(long, 'win32'), true);
});

test('the folder and the record are private to the user', { skip: POSIX_ONLY }, async () => {
  const root = await tempRoot();
  const dir = await openControlDir(root, { platform: 'linux' });
  assert.equal(dir, paths(root).control);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);

  const file = await writeRecord(root, {
    pid: 4242,
    endpoint: 'ep-4242',
    token: 'tk-4242',
    startedAt: 1_700_000_000_000,
    version: '0.3.0',
  }, { platform: 'linux' });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    pid: 4242,
    endpoint: 'ep-4242',
    token: 'tk-4242',
    startedAt: 1_700_000_000_000,
    version: '0.3.0',
  });
});

test('a folder left open to the group is closed again', { skip: POSIX_ONLY }, async () => {
  const root = await tempRoot();
  const dir = paths(root).control;
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o777);
  assert.equal((await stat(dir)).mode & 0o777, 0o777);

  await openControlDir(root, { platform: 'linux' });
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
});

test('a folder of another user is refused', { skip: POSIX_ONLY }, async () => {
  const root = await tempRoot();
  const dir = paths(root).control;
  await mkdir(dir, { recursive: true });
  // The owner of the folder is another user, which only the injected `fs`
  // can say on a machine where the test cannot change it.
  const other = {
    ...filesystem,
    stat: async (file) => ({ ...(await filesystem.stat(file)), uid: process.getuid() + 1 }),
  };

  await assert.rejects(() => openControlDir(root, { platform: 'linux', fs: other }), {
    message: `control api: ${dir} is not owned by this user`,
  });
});

test('a record that is corrupted, incomplete or of a dead process is removed', async () => {
  const root = await tempRoot();
  const dir = await openControlDir(root, { platform: 'linux' });

  await writeRecord(root, { pid: 11, endpoint: 'ep-11', token: 'tk-11' }, { platform: 'linux' });
  // A record that cannot be parsed.
  await writeFile(join(dir, '12.json'), '{ not json', 'utf8');
  // A record without the fields the API needs.
  await writeFile(join(dir, '13.json'), JSON.stringify({ pid: 13 }), 'utf8');
  // A record of a process that died, with the socket file that goes with it.
  await writeFile(join(dir, '14.json'), JSON.stringify({ pid: 14, endpoint: 'ep-14', token: 'tk-14' }), 'utf8');
  await writeFile(join(dir, '14.sock'), '', 'utf8');

  const alive = await listRecords(root, { isAlive: (pid) => pid === 11 });
  assert.deepEqual(alive.map((record) => record.pid), [11]);
  assert.equal(alive[0].endpoint, 'ep-11');

  for (const name of ['12.json', '13.json', '14.json', '14.sock']) {
    await assert.rejects(stat(join(dir, name)), { code: 'ENOENT' }, `${name} should be gone`);
  }
  assert.ok((await stat(join(dir, '11.json'))).isFile(), 'the record of the live process stays');
});

test('the token is compared without telling how much of it was right', () => {
  const token = newToken();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.notEqual(token, newToken());

  assert.equal(tokenMatches(token, token), true);
  // The same length with one character changed: only the bytes can tell.
  assert.equal(tokenMatches(token, `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`), false);
  assert.equal(tokenMatches(token, `${token}0`), false);
  assert.equal(tokenMatches(token, token.slice(0, -1)), false);
  assert.equal(tokenMatches(token, ''), false);
  assert.equal(tokenMatches(token, 42), false);
  assert.equal(tokenMatches(token, null), false);
  assert.equal(tokenMatches(null, token), false);
  assert.equal(tokenMatches(token, Buffer.from(token)), false);
});

test('the record goes with the socket file of the same process', async () => {
  const root = await tempRoot();
  const dir = await openControlDir(root, { platform: 'linux' });
  await writeRecord(root, { pid: 21, endpoint: 'ep-21', token: 'tk-21' }, { platform: 'linux' });
  await writeFile(join(dir, '21.sock'), '', 'utf8');

  await removeRecord(root, 21, { platform: 'linux' });
  await assert.rejects(stat(join(dir, '21.json')), { code: 'ENOENT' });
  await assert.rejects(stat(join(dir, '21.sock')), { code: 'ENOENT' });

  // A record that is not there is not a failure.
  await removeRecord(root, 21, { platform: 'linux' });
});

test('on Windows the socket file is left alone', async () => {
  const root = await tempRoot();
  const dir = await openControlDir(root, { platform: 'win32' });
  await writeRecord(root, { pid: 22, endpoint: 'ep-22', token: 'tk-22' }, { platform: 'win32' });
  await writeFile(join(dir, '22.sock'), '', 'utf8');

  await removeRecord(root, 22, { platform: 'win32' });
  await assert.rejects(stat(join(dir, '22.json')), { code: 'ENOENT' });
  assert.ok((await stat(join(dir, '22.sock'))).isFile(), 'the socket file stays on Windows');
});
