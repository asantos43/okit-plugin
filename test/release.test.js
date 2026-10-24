// The release build: the names, the archives, the refusals and the script.
// The tests read the archives back with a reader of their own, so what the
// writers claim is checked against the bytes on the disk.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { gunzipSync, inflateRawSync } from 'node:zlib';

import { buildRelease, sourceDate } from '../src/release/build.js';
import { tarGz, zip } from '../src/release/archive.js';
import { packageName, planPairs, releaseConfig, renderName } from '../src/release/config.js';
import { instructionsText, isExcluded, marketplaceFile, pluginManifest, repositoryOwner } from '../src/release/payload.js';
import { readArgs, main } from '../scripts/build-release.js';

const REPO = resolve(import.meta.dirname, '..');
const EPOCH = '1700000000';

/** The moment of the commit of the synthetic repositories, in seconds. */
const COMMIT_DATE = '2020-05-06T07:08:09Z';
const COMMIT_EPOCH = Date.parse(COMMIT_DATE) / 1000;

const git = promisify(execFile);
const temps = [];

after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

/** A folder under the system temporary folder, removed when the tests end. */
async function temp(prefix) {
  const dir = await mkdtemp(join(tmpdir(), `okit-release-${prefix}-`));
  temps.push(dir);
  return dir;
}

const STUB_ADAPTER = `export function postCompactHooks({ command } = {}) {
  return { SessionStart: [{ matcher: 'compact', hooks: [{ type: 'command', command, timeout: 5 }] }] };
}
`;

/**
 * A minimal copy of the repository: the files the build reads, the adapter of
 * one client, and the material that must never reach a payload. The folders of
 * the other clients are absent, so a pair of those clients is refused.
 */
async function miniRepo(prefix = 'repo') {
  const root = await temp(prefix);
  await mkdir(join(root, 'src', 'mcp'), { recursive: true });
  await mkdir(join(root, 'skills', 'demo'), { recursive: true });
  await mkdir(join(root, 'adapters', 'claude-code'), { recursive: true });
  await mkdir(join(root, 'test'), { recursive: true });
  await mkdir(join(root, '.git'), { recursive: true });

  await writeFile(join(root, 'package.json'), `${JSON.stringify({
    name: 'demo-pkg',
    version: '9.9.9',
    license: 'MIT',
    type: 'module',
    bin: { demo: 'src/cli.js' },
    engines: { node: '>=20' },
    repository: { type: 'git', url: 'https://github.com/acme/demo-pkg' },
  }, null, 2)}\n`, 'utf8');
  await writeFile(join(root, 'LICENSE'), 'MIT\n', 'utf8');
  await writeFile(join(root, 'src', 'cli.js'), '#!/usr/bin/env node\nconsole.log("demo");\n', 'utf8');
  await writeFile(join(root, 'src', 'notes.txt'), 'first\nsecond\n', 'utf8');
  await writeFile(join(root, 'src', 'mcp', 'server.js'), 'export const server = true;\n', 'utf8');
  await writeFile(join(root, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\n', 'utf8');
  await writeFile(join(root, 'adapters', 'claude-code', 'index.js'), STUB_ADAPTER, 'utf8');
  await writeFile(join(root, 'test', 'never.test.js'), 'export const never = true;\n', 'utf8');
  await writeFile(join(root, '.git', 'config'), '[core]\n', 'utf8');
  return root;
}

/** Every file under a folder, relative to it, with the paths of the system. */
async function tree(dir, base = dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await tree(full, base));
    else found.push(full.slice(base.length + 1).split(sep).join('/'));
  }
  return found.sort();
}

/**
 * A copy of the repository that is a git repository with one commit of a
 * known date, so the date the build falls back to is a known one.
 */
async function gitRepo(prefix = 'git') {
  const root = await miniRepo(prefix);
  // The copy of the repository holds a `.git` folder as a plain file, to prove
  // that it never reaches a payload; a real repository needs its own.
  await rm(join(root, '.git'), { recursive: true, force: true });
  const env = { ...process.env };
  // The variables of the environment of the test would point git somewhere
  // else, and the commit would not be the one of this root.
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  Object.assign(env, {
    GIT_AUTHOR_NAME: 'okit',
    GIT_AUTHOR_EMAIL: 'okit@example.test',
    GIT_COMMITTER_NAME: 'okit',
    GIT_COMMITTER_EMAIL: 'okit@example.test',
    GIT_AUTHOR_DATE: COMMIT_DATE,
    GIT_COMMITTER_DATE: COMMIT_DATE,
  });
  await git('git', ['init', '--quiet'], { cwd: root, env });
  await git('git', ['add', '-A'], { cwd: root, env });
  await git('git', ['commit', '--quiet', '-m', 'first'], { cwd: root, env });
  // The commit of this root is the one of a known date, so a test can name it.
  const { stdout } = await git('git', ['log', '-1', '--format=%ct'], { cwd: root, env });
  assert.equal(Number.parseInt(stdout.trim(), 10), COMMIT_EPOCH, 'the commit is the one of the known date');
  return root;
}

/**
 * The date of the commit of a root, as `git log -1 --format=%ct` reports it.
 *
 * @param {string} root the root of the repository
 * @returns {Promise<number>} the seconds since the epoch, or 0 when there is
 *   no commit to read
 */
async function commitDateOf(root) {
  try {
    const { stdout } = await git('git', ['log', '-1', '--format=%ct'], { cwd: root });
    const seconds = Number.parseInt(stdout.trim(), 10);
    return Number.isInteger(seconds) && seconds >= 0 ? seconds : 0;
  } catch {
    return 0;
  }
}

/**
 * The entries of a tarball, read from the bytes: the path, the mode and the
 * content of every file.
 *
 * @param {Buffer} data the bytes of the archive
 * @returns {object[]} the entries
 */
function readTar(data) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const mode = Number.parseInt(header.subarray(100, 108).toString('ascii').replace(/\0.*$/, '').trim(), 8);
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8);
    const mtime = Number.parseInt(header.subarray(136, 148).toString('ascii').replace(/\0.*$/, '').trim(), 8);
    const type = header.subarray(156, 157).toString('ascii');
    offset += 512;
    if (type === '0' || type === '\0') {
      const body = data.subarray(offset, offset + size);
      entries.push({ path: prefix === '' ? name : `${prefix}/${name}`, mode, mtime, data: body });
      offset += Math.ceil(size / 512) * 512;
    }
  }
  return entries;
}

/**
 * The entries of a zip file, read from the bytes: the path, the mode and the
 * content of every file.
 *
 * @param {Buffer} data the bytes of the archive
 * @returns {object[]} the entries
 */
function readZip(data) {
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'the zip has no end-of-directory record');
  const count = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(data.readUInt32LE(offset), 0x02014b50, 'the central directory is wrong');
    const method = data.readUInt16LE(offset + 10);
    const compressed = data.readUInt32LE(offset + 20);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const external = data.readUInt32LE(offset + 38);
    const local = data.readUInt32LE(offset + 42);
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localName = data.readUInt16LE(local + 26);
    const localExtra = data.readUInt16LE(local + 28);
    const start = local + 30 + localName + localExtra;
    const body = data.subarray(start, start + compressed);
    entries.push({
      path: name,
      mode: (external >>> 16) & 0o7777,
      // The DOS time and date of the local header, which is the moment the
      // entry was written.
      dosTime: data.readUInt16LE(local + 10),
      dosDate: data.readUInt16LE(local + 12),
      data: method === 0 ? body : inflateRawSync(body),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * The moment a DOS time and date hold, in UTC. The format has no year before
 * 1980, so the year of a moment before it is the first one the format can
 * hold.
 *
 * @param {number} dosTime the DOS time field
 * @param {number} dosDate the DOS date field
 * @returns {number} the seconds since the epoch
 */
function fromDos(dosTime, dosDate) {
  const year = ((dosDate >> 9) & 0x7f) + 1980;
  const month = ((dosDate >> 5) & 0x0f) - 1;
  const day = dosDate & 0x1f;
  const hours = (dosTime >> 11) & 0x1f;
  const minutes = (dosTime >> 5) & 0x3f;
  const seconds = (dosTime & 0x1f) * 2;
  return Date.UTC(year, month, day, hours, minutes, seconds) / 1000;
}

/** The gunzipped bytes of a tarball. */
function untarSync(bytes) {
  return gunzipSync(bytes);
}

// | case                            | must pass                        | must refuse                   |
// | :-                              | :-                              | :-                            |
// | the name of the artifact        | from package.json               | a name with a scope           |
// | the pairs of a run              | one per client, system, arch    | an unknown client or system   |
// | the tarball                     | the paths, the modes, the bytes | a path too long for the format|
// | the zip                         | the same, deflated              | -                             |
// | two builds of one source        | the same bytes                  | -                             |
// | the payload of a client         | the client files, no exclusions | a client with no adapter      |

test('the name of the artifact comes from package.json', () => {
  assert.equal(packageName('okit-plugin'), 'okit-plugin');
  assert.equal(packageName('@scope/name'), 'scope-name');
  assert.equal(packageName('My Package'), 'my-package');
  assert.equal(renderName({
    template: '{package}-{version}-{client}-{system}-{arch}.{ext}',
    values: { package: 'okit-plugin', version: '1.2.3', client: 'claude-code', system: 'linux', arch: 'x64', ext: 'tar.gz' },
  }), 'okit-plugin-1.2.3-claude-code-linux-x64.tar.gz');
});

test('a name that holds a scope still produces a safe file name', () => {
  assert.equal(packageName('@acme/okit'), 'acme-okit');
  assert.equal(packageName(''), 'package');
});

test('the configuration of the user replaces the defaults key by key', () => {
  const config = releaseConfig({ outputDir: 'out', formats: { windows: 'tar.gz' } });
  assert.equal(config.outputDir, 'out');
  assert.equal(config.formats.windows, 'tar.gz');
  assert.equal(config.formats.linux, 'tar.gz', 'the other formats stay');
  assert.equal(config.clients.length, 3);
});

test('the pairs of a run are one per client, system and architecture', () => {
  const config = releaseConfig({});
  const { pairs, refusals } = planPairs({ config });
  assert.equal(refusals.length, 0);
  assert.equal(pairs.length, config.clients.length * config.systems.length * config.architectures.length);
  assert.ok(pairs.some((pair) => pair.client === 'claude-code' && pair.system === 'linux'));
  assert.ok(pairs.every((pair) => pair.format === config.formats[pair.system]));
});

test('a pair that the configuration does not know is refused with the reason', () => {
  const config = releaseConfig({});
  assert.match(planPairs({ config, client: 'nope' }).refusals[0].reason, /unknown client "nope"/);
  assert.match(planPairs({ config, system: 'nope' }).refusals[0].reason, /unknown system "nope"/);
  assert.match(planPairs({ config, arch: 'nope' }).refusals[0].reason, /unknown architecture "nope"/);
});

test('a system without a format is refused, not guessed', () => {
  const config = releaseConfig({ systems: ['linux', 'bsd'] });
  const { pairs, refusals } = planPairs({ config, client: 'claude-code', system: 'bsd' });
  assert.equal(pairs.length, 0);
  assert.match(refusals[0].reason, /no archive format for system "bsd"/);
});

test('the tarball holds the paths, the modes and the bytes it was given', () => {
  const entries = [
    { path: 'src/cli.js', data: Buffer.from('run\n'), mode: '0755' },
    { path: 'a/b.txt', data: Buffer.from('text\n'), mode: '0644' },
  ];
  const read = readTar(untarSync(tarGz(entries, { mtime: 1700000000 })));
  assert.deepEqual(read.map((entry) => entry.path), ['a/b.txt', 'src/cli.js']);
  assert.equal(read.find((entry) => entry.path === 'src/cli.js').mode, 0o755);
  assert.equal(read.find((entry) => entry.path === 'a/b.txt').mode, 0o644);
  assert.equal(read.find((entry) => entry.path === 'a/b.txt').data.toString('utf8'), 'text\n');
});

test('the zip holds the same entries, deflated', () => {
  const entries = [
    { path: 'src/cli.js', data: Buffer.from('run\n'), mode: '0755' },
    { path: 'a/b.txt', data: Buffer.from('text\n'), mode: '0644' },
  ];
  const read = readZip(zip(entries, { mtime: 1700000000 }));
  assert.deepEqual(read.map((entry) => entry.path), ['a/b.txt', 'src/cli.js']);
  assert.equal(read.find((entry) => entry.path === 'src/cli.js').mode, 0o755);
  assert.equal(read.find((entry) => entry.path === 'a/b.txt').data.toString('utf8'), 'text\n');
});

test('two archives of the same entries have the same bytes', () => {
  const entries = [{ path: 'a.txt', data: Buffer.from('same\n'), mode: '0644' }];
  assert.ok(tarGz(entries, { mtime: 1700000000 }).equals(tarGz(entries, { mtime: 1700000000 })));
  assert.ok(zip(entries, { mtime: 1700000000 }).equals(zip(entries, { mtime: 1700000000 })));
});

test('the order of the entries does not change the bytes', () => {
  const one = [{ path: 'a.txt', data: Buffer.from('a\n'), mode: '0644' }];
  const other = [{ path: 'b.txt', data: Buffer.from('b\n'), mode: '0644' }];
  assert.ok(tarGz([...one, ...other], { mtime: 1700000000 }).equals(tarGz([...other, ...one], { mtime: 1700000000 })));
  assert.ok(zip([...one, ...other], { mtime: 1700000000 }).equals(zip([...other, ...one], { mtime: 1700000000 })));
});

test('a path the tar format cannot hold is refused, not truncated', () => {
  const long = `${'a'.repeat(120)}/${'b'.repeat(120)}`;
  assert.throws(() => tarGz([{ path: long, data: Buffer.from('x'), mode: '0644' }]), /too long/);
});

test('a mode that is not a number is refused', () => {
  assert.throws(() => tarGz([{ path: 'a', data: Buffer.from('x'), mode: 'zzz' }]), /octal/);
});

test('the manifest of the plugin holds the fields the client reads', () => {
  const manifest = pluginManifest({
    packageJson: {
      name: 'demo-pkg',
      version: '1.0.0',
      description: 'demo',
      license: 'MIT',
      repository: { type: 'git', url: 'https://github.com/acme/demo-pkg' },
    },
    clientFiles: {
      hooks: 'hooks/hooks.json',
      mcp: { server: 'src/mcp/server.js', command: 'node', root: '${CLAUDE_PLUGIN_ROOT}' },
    },
    name: 'demo-pkg',
  });

  assert.equal(manifest.name, 'demo-pkg');
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.repository, 'https://github.com/acme/demo-pkg');
  assert.equal(manifest.hooks, './hooks/hooks.json');
  assert.deepEqual(manifest.mcpServers['demo-pkg'], {
    command: 'node',
    args: ['${CLAUDE_PLUGIN_ROOT}/src/mcp/server.js'],
  });
});

test('the marketplace of the package points at the package itself', () => {
  const file = marketplaceFile({
    packageJson: { description: 'demo' },
    marketplace: { name: 'demo-market', owner: { name: 'acme', url: 'https://github.com/acme' } },
    name: 'demo-pkg',
    system: 'linux',
  });

  assert.equal(file.name, 'demo-market');
  assert.deepEqual(file.owner, { name: 'acme', url: 'https://github.com/acme' });
  assert.equal(file.plugins[0].name, 'demo-pkg');
  assert.equal(file.plugins[0].source, './');
  assert.match(file.plugins[0].description, /linux/);
});

test('the owner of the repository is read from its URL', () => {
  assert.deepEqual(repositoryOwner('https://github.com/acme/demo-pkg', 'fallback'),
    { name: 'acme', url: 'https://github.com/acme' });
  assert.deepEqual(repositoryOwner('not a url', 'fallback'), { name: 'fallback', url: 'not a url' });
});

test('the excluded patterns keep what they name out of the payload', () => {
  const excludes = ['.git', 'node_modules', 'src/release', '*.log', '*.tmp'];

  assert.equal(isExcluded('node_modules/x.js', excludes), true);
  assert.equal(isExcluded('src/node_modules/x.js', excludes), true);
  assert.equal(isExcluded('src/release/config.js', excludes), true);
  assert.equal(isExcluded('a/b/run.log', excludes), true);
  assert.equal(isExcluded('a/b/x.tmp', excludes), true);
  assert.equal(isExcluded('src/notes.log', excludes), true);

  assert.equal(isExcluded('src/notes.txt', excludes), false);
  assert.equal(isExcluded('src/release.js', excludes), false, 'the name is not the path');
  assert.equal(isExcluded('a/b/log', excludes), false);
});

test('the instructions of the installation are filled with the values of the pair', () => {
  const text = instructionsText({
    instructions: { title: 'Install {name}', steps: ['Node {engines}.', 'Install {name}@{marketplace}.'] },
    values: { name: 'demo-pkg', version: '1.0.0', engines: '>=20', marketplace: 'demo-market' },
  });

  assert.match(text, /^# Install demo-pkg$/m);
  assert.match(text, /- Node >=20\./);
  assert.match(text, /- Install demo-pkg@demo-market\./);
});

test('the build writes one archive per pair, named from package.json', async () => {
  const root = await miniRepo();
  const out = await temp('out');
  const result = await buildRelease({
    root,
    out,
    client: 'claude-code',
    system: 'linux',
    env: { SOURCE_DATE_EPOCH: EPOCH },
  });

  assert.equal(result.built.length, 1);
  assert.equal(result.built[0].file, 'demo-pkg-9.9.9-claude-code-linux-x64.tar.gz');
  assert.deepEqual(await tree(out), ['demo-pkg-9.9.9-claude-code-linux-x64.tar.gz']);
});

test('the build writes nothing outside the output folder', async () => {
  const root = await miniRepo();
  const out = await temp('out');
  const before = await tree(root);
  await buildRelease({
    root,
    out,
    client: 'claude-code',
    system: 'linux',
    env: { SOURCE_DATE_EPOCH: EPOCH },
  });
  assert.deepEqual(await tree(root), before, 'the repository is untouched');
});

test('the payload of a client holds its files and none of the excluded ones', async () => {
  const root = await miniRepo();
  const out = await temp('out');
  await buildRelease({
    root,
    out,
    client: 'claude-code',
    system: 'linux',
    env: { SOURCE_DATE_EPOCH: EPOCH },
  });
  const bytes = await readFile(join(out, 'demo-pkg-9.9.9-claude-code-linux-x64.tar.gz'));
  const entries = readTar(untarSync(bytes));
  const paths = entries.map((entry) => entry.path);

  assert.ok(paths.includes('.claude-plugin/plugin.json'), 'the manifest is there');
  assert.ok(paths.includes('hooks/hooks.json'), 'the hooks are there');
  assert.ok(paths.includes('package.json'), 'the metadata is there');
  assert.ok(paths.includes('LICENSE'), 'the licence is there');
  assert.ok(paths.includes('src/cli.js'), 'the source is there');
  assert.ok(paths.includes('skills/demo/SKILL.md'), 'the skills are there');
  assert.ok(paths.includes('adapters/claude-code/index.js'), 'the adapter of the client is there');
  assert.ok(paths.includes('INSTALL.md'), 'the instructions are there');

  assert.ok(!paths.some((path) => path.startsWith('test/')), 'the tests are not there');
  assert.ok(!paths.some((path) => path.startsWith('.git/')), 'the repository is not there');
  assert.ok(!paths.some((path) => path.includes('codex')), 'another adapter is not there');
});

test('a file the patterns name never enters the payload', async () => {
  const root = await miniRepo();
  await writeFile(join(root, 'src', 'run.log'), 'noise\n', 'utf8');
  await writeFile(join(root, 'src', 'keep.txt'), 'kept\n', 'utf8');
  const out = await temp('out');
  await buildRelease({
    root,
    out,
    client: 'claude-code',
    system: 'linux',
    env: { SOURCE_DATE_EPOCH: EPOCH },
  });
  const bytes = await readFile(join(out, 'demo-pkg-9.9.9-claude-code-linux-x64.tar.gz'));
  const paths = readTar(untarSync(bytes)).map((entry) => entry.path);

  assert.ok(paths.includes('src/keep.txt'));
  assert.ok(!paths.includes('src/run.log'));
});

test('the manifest of the plugin is built from package.json', async () => {
  const root = await miniRepo();
  const out = await temp('out');
  await buildRelease({
    root,
    out,
    client: 'claude-code',
    system: 'linux',
    env: { SOURCE_DATE_EPOCH: EPOCH },
  });
  const bytes = await readFile(join(out, 'demo-pkg-9.9.9-claude-code-linux-x64.tar.gz'));
  const entries = readTar(untarSync(bytes));
  const manifest = JSON.parse(entries.find((entry) => entry.path === '.claude-plugin/plugin.json').data.toString('utf8'));

  assert.equal(manifest.name, 'demo-pkg');
  assert.equal(manifest.version, '9.9.9');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.repository, 'https://github.com/acme/demo-pkg');
  assert.equal(manifest.mcpServers['demo-pkg'].args[0], '${CLAUDE_PLUGIN_ROOT}/src/mcp/server.js');
  assert.equal(manifest.hooks, './hooks/hooks.json');
});

test('the hooks of the payload are the ones of the adapter', async () => {
  const root = await miniRepo();
  const out = await temp('out');
  await buildRelease({
    root,
    out,
    client: 'claude-code',
    system: 'linux',
    env: { SOURCE_DATE_EPOCH: EPOCH },
  });
  const bytes = await readFile(join(out, 'demo-pkg-9.9.9-claude-code-linux-x64.tar.gz'));
  const entries = readTar(untarSync(bytes));
  const hooks = JSON.parse(entries.find((entry) => entry.path === 'hooks/hooks.json').data.toString('utf8'));

  assert.equal(hooks.hooks.SessionStart[0].matcher, 'compact');
  assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /post-compact/);
});

test('the command of the package is the only executable one', async () => {
  const root = await miniRepo();
  const out = await temp('out');
  await buildRelease({
    root,
    out,
    client: 'claude-code',
    system: 'linux',
    env: { SOURCE_DATE_EPOCH: EPOCH },
  });
  const bytes = await readFile(join(out, 'demo-pkg-9.9.9-claude-code-linux-x64.tar.gz'));
  const entries = readTar(untarSync(bytes));

  assert.equal(entries.find((entry) => entry.path === 'src/cli.js').mode, 0o755);
  assert.equal(entries.find((entry) => entry.path === 'src/notes.txt').mode, 0o644);
  assert.equal(entries.find((entry) => entry.path === 'package.json').mode, 0o644);
});

test('the lines of the payload end with LF', async () => {
  const root = await miniRepo();
  await writeFile(join(root, 'src', 'notes.txt'), 'first\r\nsecond\n', 'utf8');
  const out = await temp('out');
  await buildRelease({
    root,
    out,
    client: 'claude-code',
    system: 'linux',
    env: { SOURCE_DATE_EPOCH: EPOCH },
  });
  const bytes = await readFile(join(out, 'demo-pkg-9.9.9-claude-code-linux-x64.tar.gz'));
  const entries = readTar(untarSync(bytes));

  assert.equal(entries.find((entry) => entry.path === 'src/notes.txt').data.toString('utf8'), 'first\nsecond\n');
  for (const entry of entries) {
    assert.ok(!entry.data.toString('utf8').includes('\r'), `${entry.path} has no CR`);
  }
});

test('two builds of the same source have the same bytes', async () => {
  const root = await miniRepo();
  const first = await temp('first');
  const second = await temp('second');
  const options = { root, client: 'claude-code', system: 'linux', env: { SOURCE_DATE_EPOCH: EPOCH } };
  await buildRelease({ ...options, out: first });
  await buildRelease({ ...options, out: second });

  const one = await readFile(join(first, 'demo-pkg-9.9.9-claude-code-linux-x64.tar.gz'));
  const other = await readFile(join(second, 'demo-pkg-9.9.9-claude-code-linux-x64.tar.gz'));
  assert.ok(one.equals(other), 'the two builds are the same bytes');
});

test('a client with no adapter is refused with the reason, and no package is written', async () => {
  const root = await miniRepo();
  const out = await temp('out');
  const result = await buildRelease({
    root,
    out,
    client: 'codex',
    system: 'linux',
    env: { SOURCE_DATE_EPOCH: EPOCH },
  });

  assert.equal(result.built.length, 0);
  assert.equal(result.refused.length, 1);
  assert.match(result.refused[0].reason, /not implemented/);
  assert.deepEqual(await tree(out), [], 'nothing was written');
});

test('an unknown client or system is refused, not guessed', async () => {
  const root = await miniRepo();
  const out = await temp('out');
  const result = await buildRelease({
    root,
    out,
    client: 'nope',
    env: { SOURCE_DATE_EPOCH: EPOCH },
  });
  assert.equal(result.built.length, 0);
  assert.match(result.refused[0].reason, /unknown client/);
  assert.deepEqual(await tree(out), []);
});

test('the build of a dry run writes nothing and names what it would write', async () => {
  const root = await miniRepo();
  const out = await temp('out');
  const result = await buildRelease({
    root,
    out,
    client: 'claude-code',
    system: 'linux',
    dryRun: true,
    env: { SOURCE_DATE_EPOCH: EPOCH },
  });

  assert.equal(result.built[0].file, 'demo-pkg-9.9.9-claude-code-linux-x64.tar.gz');
  assert.deepEqual(await tree(out), [], 'nothing was written');
});

test('the arguments of the script are read as they are written', () => {
  assert.deepEqual(readArgs([]), { out: null, pair: null, arch: null, dryRun: false, error: null });
  assert.equal(readArgs(['--dry-run']).dryRun, true);
  assert.equal(readArgs(['--out', '/tmp/x']).out, '/tmp/x');
  assert.equal(readArgs(['--pair', 'claude-code:linux']).pair, 'claude-code:linux');
  assert.equal(readArgs(['--arch', 'x64']).arch, 'x64');
  assert.match(readArgs(['--nope']).error, /unknown argument/);
  assert.match(readArgs(['--pair', 'claude-code']).error, /client.*system/);
});

test('the date of the entries is SOURCE_DATE_EPOCH when it is set', async () => {
  const root = await gitRepo('date');
  // 86400 is a moment no commit of the repository holds, so the value can
  // only come from the environment.
  assert.equal(await sourceDate({ root, env: { SOURCE_DATE_EPOCH: '86400' } }), 86400);
  assert.equal(await sourceDate({ root, env: { SOURCE_DATE_EPOCH: '0' } }), 0);
});

test('without a usable SOURCE_DATE_EPOCH the date of the entries is the date of the commit', async () => {
  const root = await gitRepo('date');
  // The commit of this root is the one of a known date (the copy asserts it),
  // and the date the build falls back to is the one git reports for it.
  const committed = await commitDateOf(root);
  for (const env of [{}, { SOURCE_DATE_EPOCH: '' }, { SOURCE_DATE_EPOCH: 'abc' }, { SOURCE_DATE_EPOCH: '-1' }]) {
    assert.equal(
      await sourceDate({ root, env }),
      committed,
      `the date of the commit is used for ${JSON.stringify(env)}`,
    );
  }
});

test('a root that is not a repository falls back to the epoch', async () => {
  const root = await miniRepo('date');
  assert.equal(await sourceDate({ root, env: {} }), 0);
});

test('the entries of the package carry the date SOURCE_DATE_EPOCH names', async () => {
  const root = await miniRepo('stamp');
  const out = await temp('out');
  await buildRelease({
    root,
    out,
    client: 'claude-code',
    system: 'linux',
    env: { SOURCE_DATE_EPOCH: '86400' },
  });
  const bytes = await readFile(join(out, 'demo-pkg-9.9.9-claude-code-linux-x64.tar.gz'));
  const entries = readTar(untarSync(bytes));

  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.equal(entry.mtime, 86400, `${entry.path} carries the date of the environment`);
  }
});

test('the entries of the zip carry the date SOURCE_DATE_EPOCH names', async () => {
  const root = await miniRepo('stamp');
  const out = await temp('out');
  await buildRelease({
    root,
    out,
    client: 'claude-code',
    system: 'windows',
    env: { SOURCE_DATE_EPOCH: '86400' },
  });
  const bytes = await readFile(join(out, 'demo-pkg-9.9.9-claude-code-windows-x64.zip'));
  const entries = readZip(bytes);

  assert.ok(entries.length > 0);
  for (const entry of entries) {
    // The DOS format holds no year before 1980, so the moment is the first
    // year the format can hold, at the same month and day.
    assert.equal(
      fromDos(entry.dosTime, entry.dosDate),
      Date.UTC(1980, 0, 2, 0, 0, 0) / 1000,
      `${entry.path} carries the date of the environment`,
    );
  }
});

test('the script lists the pairs and the refusals, and answers with a code that is not zero', async () => {
  // The root is a synthetic one, with the adapter of one client only: what is
  // refused here is a pair whose adapter folder is absent, not a client that
  // happens to have one in this repository.
  const root = await miniRepo('script-refuse');
  const out = [];
  const err = [];
  const code = await main(['--dry-run'], {
    root,
    env: { OKWORK_HOME: await temp('home') },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });

  assert.notEqual(code, 0, 'a run that refused something is not a success');
  assert.ok(out.some((line) => line.includes('claude-code-linux')), 'the pairs are listed');
  assert.ok(err.some((line) => /refused:.*codex/.test(line)), 'the refusals are listed');
  assert.ok(err.some((line) => /not implemented/.test(line)), 'the reason is given');
});

test('the script builds every pair whose adapter exists, against the real root', async () => {
  const out = [];
  const err = [];
  const code = await main(['--dry-run'], {
    root: REPO,
    env: { OKWORK_HOME: await temp('home') },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });

  assert.equal(code, 0, 'nothing was refused');
  assert.deepEqual(err, [], 'there is no refusal to report');
  for (const client of ['claude-code', 'codex', 'opencode']) {
    assert.ok(
      out.some((line) => line.startsWith('would build:') && line.includes(client)),
      `the pairs of ${client} are built`,
    );
  }
});

test('the script builds one pair and answers with zero', async () => {
  const out = await temp('script-out');
  const err = [];
  const code = await main(['--out', out, '--pair', 'claude-code:linux'], {
    root: REPO,
    env: { SOURCE_DATE_EPOCH: EPOCH },
    stdout: () => {},
    stderr: (line) => err.push(line),
  });

  assert.equal(code, 0, 'nothing was refused');
  assert.deepEqual(err, []);
  const files = await tree(out);
  assert.equal(files.length, 1);
  assert.match(files[0], /^okit-plugin-\d+\.\d+\.\d+-claude-code-linux-x64\.tar\.gz$/);
});

test('the script refuses an argument it does not know', async () => {
  const err = [];
  const code = await main(['--nope'], { root: REPO, env: {}, stdout: () => {}, stderr: (line) => err.push(line) });
  assert.equal(code, 2);
  assert.ok(err.some((line) => /unknown argument/.test(line)));
});
