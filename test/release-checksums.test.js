import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { defaultManifestName, manifestFileName, verifyManifest, writeManifest } from '../src/release/checksums.js';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts', 'checksums.js');

const roots = [];

async function folder() {
  const dir = await mkdtemp(join(tmpdir(), 'checksums-test-'));
  roots.push(dir);
  return dir;
}

const digest = (data) => createHash('sha256').update(data).digest('hex');

async function run(args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [script, ...args]);
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '' };
  }
}

after(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

test('the manifest name comes from the package metadata', () => {
  assert.equal(manifestFileName({ name: 'Okit Plugin', version: '1.2.3' }), 'okit-plugin-1.2.3-checksums.sha256');
  assert.equal(manifestFileName({ name: 'okit-plugin', version: '0.1.0-rc.1' }), 'okit-plugin-0.1.0-rc.1-checksums.sha256');
});

test('the manifest carries the digest of each file and never its own', async () => {
  const dir = await folder();
  await writeFile(join(dir, 'payload.tar.gz'), 'payload', 'utf8');
  await writeFile(join(dir, 'notes.md'), 'notes', 'utf8');
  const out = join(dir, 'manifest.sha256');

  const result = await writeManifest({ dir, out });
  const raw = await readFile(out, 'utf8');

  assert.deepEqual(result.files, ['notes.md', 'payload.tar.gz']);
  assert.equal(raw, `${digest('notes')}  notes.md\n${digest('payload')}  payload.tar.gz\n`);
  assert.ok(!raw.includes('manifest.sha256'));
});

test('the order is stable and two generations write the same bytes', async () => {
  const dir = await folder();
  for (const name of ['c.txt', 'a.txt', 'b.txt']) await writeFile(join(dir, name), name, 'utf8');
  const out = join(dir, 'manifest.sha256');

  await writeManifest({ dir, out });
  const first = await readFile(out, 'utf8');
  await writeManifest({ dir, out });
  const second = await readFile(out, 'utf8');

  assert.equal(first, second);
  assert.deepEqual(first.split('\n').filter(Boolean).map((line) => line.slice(66)), ['a.txt', 'b.txt', 'c.txt']);
});

test('an intact folder verifies', async () => {
  const dir = await folder();
  await writeFile(join(dir, 'a.txt'), 'alpha', 'utf8');
  await writeFile(join(dir, 'b.txt'), 'beta', 'utf8');
  const out = join(dir, 'manifest.sha256');
  await writeManifest({ dir, out });

  const result = await verifyManifest(out, { dir });
  assert.deepEqual(result, { ok: true, checked: 2, problems: [] });
});

test('a modified file is refused', async () => {
  const dir = await folder();
  await writeFile(join(dir, 'a.txt'), 'alpha', 'utf8');
  const out = join(dir, 'manifest.sha256');
  await writeManifest({ dir, out });
  await writeFile(join(dir, 'a.txt'), 'alphb', 'utf8');

  const result = await verifyManifest(out, { dir });
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [{ file: 'a.txt', reason: 'modified' }]);
});

test('a missing file is refused', async () => {
  const dir = await folder();
  await writeFile(join(dir, 'a.txt'), 'alpha', 'utf8');
  const out = join(dir, 'manifest.sha256');
  await writeManifest({ dir, out });
  await rm(join(dir, 'a.txt'));

  const result = await verifyManifest(out, { dir });
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [{ file: 'a.txt', reason: 'missing' }]);
});

test('a file the manifest does not list is refused', async () => {
  const dir = await folder();
  await writeFile(join(dir, 'a.txt'), 'alpha', 'utf8');
  const out = join(dir, 'manifest.sha256');
  await writeManifest({ dir, out });
  await writeFile(join(dir, 'extra.txt'), 'extra', 'utf8');

  const result = await verifyManifest(out, { dir });
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [{ file: 'extra.txt', reason: 'unlisted' }]);
});

test('a malformed line is refused', async () => {
  const dir = await folder();
  const out = join(dir, 'manifest.sha256');
  await writeFile(out, 'not a digest line\n', 'utf8');

  const result = await verifyManifest(out, { dir });
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [{ file: 'not a digest line', reason: 'malformed-line' }]);
});

test('an unsafe path is refused', async () => {
  const dir = await folder();
  const out = join(dir, 'manifest.sha256');
  await writeFile(out, `${digest('alpha')}  ../escape.txt\n`, 'utf8');

  const result = await verifyManifest(out, { dir });
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [{ file: '../escape.txt', reason: 'unsafe-path' }]);
});

test('write refuses an unsafe file name', async () => {
  const dir = await folder();
  const out = join(dir, 'manifest.sha256');
  await assert.rejects(() => writeManifest({ dir, files: ['../escape.txt'], out }), /unsafe/i);
});

test('write never lists the manifest itself', async () => {
  const dir = await folder();
  await writeFile(join(dir, 'a.txt'), 'alpha', 'utf8');
  const out = join(dir, 'manifest.sha256');

  const result = await writeManifest({ dir, files: ['a.txt', 'manifest.sha256'], out });
  assert.deepEqual(result.files, ['a.txt']);
  assert.ok(!(await readFile(out, 'utf8')).includes('manifest.sha256'));
});

test('the script writes, verifies and refuses a changed byte', async () => {
  const dir = await folder();
  await writeFile(join(dir, 'a.txt'), 'alpha', 'utf8');
  const out = join(dir, 'manifest.sha256');

  assert.equal((await run(['write', '--dir', dir, '--out', out])).code, 0);
  assert.equal((await run(['verify', '--manifest', out, '--dir', dir])).code, 0);

  await writeFile(join(dir, 'a.txt'), 'alphb', 'utf8');
  assert.equal((await run(['verify', '--manifest', out, '--dir', dir])).code, 1);
});

test('the script finds the manifest named after the package metadata', async () => {
  const dir = await folder();
  await writeFile(join(dir, 'a.txt'), 'alpha', 'utf8');
  const out = join(dir, await defaultManifestName());

  assert.equal((await run(['write', '--dir', dir])).code, 0);
  assert.equal((await run(['verify', '--dir', dir])).code, 0);
});

test('the script refuses a usage error with exit code 2', async () => {
  assert.equal((await run(['verify'])).code, 2);
  assert.equal((await run(['nonsense'])).code, 2);
  assert.equal((await run(['write', '--unknown'])).code, 2);
});
