import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { main } from '../src/cli.js';
import { tarGz, zip } from '../src/release/archive.js';
import { installConfig, installPaths } from '../src/install/config.js';
import { chooseClient, detect } from '../src/install/menu.js';
import { latestRelease } from '../src/install/release.js';
import { downloadRelease } from '../src/install/download.js';
import { extract } from '../src/install/extract.js';
import { place, readRecord } from '../src/install/place.js';
import { applyLink } from '../src/install/link.js';
import { DEFAULT_CONFIG } from '../src/profiles.js';
import { register } from '../src/install/register.js';
import * as moduleAdapter from '../adapters/opencode/index.js';

// Must pass / must refuse corpus:
// | Input | Must pass | Must refuse |
// | exact pair, unique detected client, same version | install/menu/no-op | |
// | valid tar/zip, executable mode, retained version | extraction/rollback | |
// | checksum mismatch/missing line, paths/links, size/timeout | | before placement |
// | ambiguous menu, invalid client, purge without yes | | before mutation |
// | dry-run, edited skill/module, foreign command link | preserve tree/edits | overwrite |

async function fixture(t) {
  const home = await fs.mkdtemp(join(tmpdir(), 'install-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = join(home, 'state');
  const destination = join(home, 'data');
  const bin = join(home, 'bin');
  await fs.mkdir(root);
  const config = installConfig({ repository: 'example/project', api: 'https://fake.invalid', destination, linkDirectory: bin });
  await fs.writeFile(join(root, 'config.json'), JSON.stringify({ install: config }));
  const output = [], commands = [], events = [];
  const deps = { fs, home, root, destination, bin, temporary: home, config,
    env: { HOME: home, PATH: '' }, platform: 'linux', now: () => 1700000000000,
    out: (line) => output.push(line), detect: async () => false };
  let version = '1.0.0';
  let badHash = false, missing = false, prerelease = false;
  const pkg = { name: 'sample', version, bin: { okit: 'src/cli.js' }, repository: { url: 'https://example.invalid/example/project' } };
  const payload = () => tarGz([
    { path: 'package.json', mode: 0o644, data: JSON.stringify({ ...pkg, version }) },
    { path: 'src/cli.js', mode: 0o755, data: '#!/usr/bin/env node\n' },
  ]);
  const name = () => `sample-${version}-claude-code-linux-x64.tar.gz`;
  const selected = () => ({ tag_name: `v${version}`, prerelease, published_at: '2026-10-24', assets: [
    { name: name(), browser_download_url: 'https://fake.invalid/package' },
    { name: `sample-${version}-checksums.sha256`, browser_download_url: 'https://fake.invalid/manifest' },
  ] });
  const fetch = async (url) => {
    if (url.endsWith('/latest')) return prerelease ? new Response('', { status: 404 }) : Response.json(selected());
    if (url.endsWith('/releases')) return Response.json([selected()]);
    if (url.endsWith('/package')) return new Response(payload());
    if (url.endsWith('/manifest')) return new Response(`${badHash ? '0'.repeat(64) : createHash('sha256').update(payload()).digest('hex')}  ${missing ? 'other.tar.gz' : name()}\n`);
    throw new Error(`Unexpected request ${url}`);
  };
  deps.fetch = fetch;
  const io = { ...deps, pkg, arch: 'x64', tmpdir: home, tty: false, stdout: deps.out, stderr: deps.out,
    run: async (command) => { commands.push(command); return {}; },
    stopDaemon: async () => { events.push('stop'); return true; },
    startDaemon: async () => { events.push('start'); }, autostart: async () => { events.push('autostart'); },
    smoke: async () => { events.push('smoke'); return { code: 0 }; } };
  return { home, root, destination, bin, config, deps, io, output, commands, events, pkg, payload,
    setVersion: (value) => { version = value; }, badHash: () => { badHash = true; },
    missing: () => { missing = true; }, pre: () => { prerelease = true; } };
}

async function tree(dir) {
  const result = {};
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    result[item.name] = item.isDirectory() ? await tree(path) : item.isSymbolicLink() ? await fs.readlink(path) : (await fs.readFile(path)).toString('base64');
  }
  return result;
}

test('--from installs offline, validates identity and preserves source', async (t) => {
  const f = await fixture(t);
  const source = join(f.home, 'source');
  await fs.mkdir(join(source, 'src'), { recursive: true });
  await fs.writeFile(join(source, 'package.json'), JSON.stringify(f.pkg));
  await fs.writeFile(join(source, 'src/cli.js'), '// local CLI');
  const io = { ...f.io, fetch: async () => { throw new Error('must not fetch'); } };
  assert.equal(await main(['install', '--client', 'claude-code', '--from', source, '--dry-run'], io), 0);
  assert.equal(await readRecord(f.destination, fs), null);
  assert.equal(await main(['install', '--client', 'claude-code', '--from', source], io), 0);
  assert.equal((await readRecord(f.destination, fs)).version, f.pkg.version);
  assert.equal(await fs.readFile(join(source, 'src/cli.js'), 'utf8'), '// local CLI');
  await fs.writeFile(join(source, 'package.json'), JSON.stringify({ ...f.pkg, version: '2.0.0' }));
  assert.equal(await main(['install', '--client', 'claude-code', '--from', source], io), 0);
  assert.equal((await readRecord(f.destination, fs)).previous.version, f.pkg.version);
  assert.ok(f.events.includes('stop')); assert.ok(f.events.includes('smoke'));
  assert.equal(await fs.readFile(join(source, 'src/cli.js'), 'utf8'), '// local CLI');
  await fs.writeFile(join(source, 'package.json'), '{"name":"foreign","version":"2"}');
  assert.equal(await main(['install', '--client', 'claude-code', '--from', source], io), 2);
  await fs.rm(join(source, 'src/cli.js'));
  assert.equal(await main(['install', '--client', 'claude-code', '--from', source], io), 2);
});

test('menu: explicit, invalid, one detected, multiple/none without TTY, numbered TTY', async (t) => {
  const { deps } = await fixture(t);
  assert.equal(await chooseClient('codex', deps), 'codex');
  await assert.rejects(chooseClient('invalid', deps), /Invalid client/);
  await assert.rejects(chooseClient(null, deps), /Without TTY/);
  await assert.rejects(chooseClient(null, { ...deps, detect: async () => true }), /Without TTY/);
  assert.equal(await chooseClient(null, { ...deps, detect: async (name) => name === 'codex' }), 'codex');
  assert.equal(await chooseClient(null, { ...deps, tty: true, read: async () => '3' }), 'opencode');
  await assert.rejects(chooseClient(null, { ...deps, tty: true, read: async () => '0' }), /Invalid client number/);
});

test('detect checks executable permission and configured PATH', async (t) => {
  const { deps, home } = await fixture(t);
  await fs.writeFile(join(home, 'fake-client'), '', { mode: 0o755 });
  const options = { ...deps, env: { PATH: home } };
  assert.equal(await detect('fake-client', options), join(home, 'fake-client'));
  await fs.chmod(join(home, 'fake-client'), 0o644);
  assert.equal(await detect('fake-client', options), null);
});

test('latest release supports prerelease-only and rejects wrong system/architecture by filename', async (t) => {
  const f = await fixture(t);
  f.pre();
  const options = { ...f.deps, release: DEFAULT_CONFIG.release, pkg: f.pkg, repo: 'example/project', client: 'claude-code', system: 'linux', arch: 'x64' };
  assert.equal((await latestRelease(options)).prerelease, true);
  assert.equal((await latestRelease({ ...options, prerelease: true })).version, '1.0.0');
  await assert.rejects(latestRelease({ ...options, system: 'windows' }), /missing asset.*windows.*zip/);
  await assert.rejects(latestRelease({ ...options, arch: 'arm64' }), /missing asset.*arm64/);
});

for (const failure of ['badHash', 'missing']) test(`download refuses ${failure} and removes temporary folder`, async (t) => {
  const f = await fixture(t);
  const selected = await latestRelease({ ...f.deps, release: DEFAULT_CONFIG.release, pkg: f.pkg, repo: 'example/project', client: 'claude-code', system: 'linux', arch: 'x64' });
  f[failure]();
  const before = await tree(f.home);
  await assert.rejects(downloadRelease(selected, f.deps), /SHA-256 mismatch|missing unique/);
  assert.deepEqual(await tree(f.home), before);
});

for (const [format, writer] of [['tar.gz', tarGz], ['zip', zip]]) {
  for (const name of ['../outside', '/absolute', 'C:/absolute']) test(`${format} refuses path ${name}`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(extract(writer([{ path: name, data: 'bad', mode: 0o755 }]), f.destination,
      { fs, format, maxExtractBytes: 10000 }), /Unsafe archive path/);
    assert.equal(await fs.stat(f.destination).catch(() => null), null);
  });
  test(`${format} preserves executable and refuses excess size`, async (t) => {
    const f = await fixture(t);
    const bytes = writer([{ path: 'cli', data: 'x'.repeat(2000), mode: 0o755 }]);
    await assert.rejects(extract(bytes, f.destination, { fs, format, maxExtractBytes: 1000 }));
    await extract(bytes, f.destination, { fs, format, maxExtractBytes: 10000 });
    assert.equal((await fs.stat(join(f.destination, 'cli'))).mode & 0o777, 0o755);
  });
}

test('tar and zip refuse symlinks before writing', async (t) => {
  const f = await fixture(t);
  const entries = [{ path: 'link', data: '../../outside', mode: 0o755 }];
  const tar = gunzipSync(tarGz(entries));
  tar.write('2', 156); tar.write('        ', 148);
  const sum = [...tar.subarray(0, 512)].reduce((a, b) => a + b, 0);
  tar.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  await assert.rejects(extract(gzipSync(tar), f.destination, { fs, format: 'tar.gz', maxExtractBytes: 10000 }), /links/);
  const zipped = zip(entries);
  const directory = zipped.readUInt32LE(zipped.length - 6);
  zipped.writeUInt32LE((0o120777 * 65536) >>> 0, directory + 38);
  await assert.rejects(extract(zipped, f.destination, { fs, format: 'zip', maxExtractBytes: 10000 }), /links/);
});

test('install idempotent, fixed destination, missing client skipped, update same no-op', async (t) => {
  const f = await fixture(t);
  assert.equal(await main(['install', '--client', 'claude-code'], f.io), 0);
  const record = await readRecord(f.destination, fs);
  assert.equal(record.path, join(f.destination, '1.0.0-claude-code'));
  assert.equal(f.commands.length, 0);
  assert.ok(f.output.some((line) => line.includes('Missing executable')));
  assert.ok(f.output.some((line) => line.includes('does not authenticate')));
  const before = await tree(f.home);
  assert.equal(await main(['install', '--client', 'claude-code'], f.io), 0);
  assert.deepEqual(await tree(f.home), before);
  assert.equal(await main(['update'], f.io), 0);
  assert.deepEqual(f.events, []);
  assert.deepEqual(await tree(f.home), before);
  assert.ok(f.output.includes('up to date'));
});

test('update check, backup, activate, smoke failure and rollback', async (t) => {
  const f = await fixture(t);
  assert.equal(await main(['install', '--client', 'claude-code'], f.io), 0);
  const prior = await readRecord(f.destination, fs);
  await fs.writeFile(join(f.root, 'user-state'), 'keep me');
  f.io.clientRoot = join(f.home, 'client-config');
  await fs.mkdir(f.io.clientRoot);
  await fs.writeFile(join(f.io.clientRoot, 'edited-hook'), 'user edit');
  f.setVersion('2.0.0');
  const before = await tree(f.home);
  assert.equal(await main(['update', '--check'], f.io), 0);
  assert.deepEqual(await tree(f.home), before);
  assert.equal(await main(['update'], { ...f.io, smoke: async () => { f.events.push('smoke'); return { code: 1 }; } }), 1);
  const current = await readRecord(f.destination, fs);
  assert.equal(current.version, '2.0.0');
  assert.equal(current.previous.version, prior.version);
  assert.deepEqual(f.events, ['stop', 'start', 'smoke']);
  assert.equal(await fs.readFile(join(f.destination, 'backups', '1700000000000', '0', 'user-state'), 'utf8'), 'keep me');
  assert.equal(await fs.readFile(join(f.destination, 'backups', '1700000000000', '1', 'edited-hook'), 'utf8'), 'user edit');
  assert.ok(f.output.some((line) => line.includes('update --rollback')));
  assert.equal(await main(['update', '--rollback'], f.io), 0);
  assert.equal((await readRecord(f.destination, fs)).version, prior.version);
  assert.equal(await fs.readlink(join(f.bin, 'okit')), join(prior.path, prior.bin));
});

test('uninstall preserves user state; purge requires yes', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(join(f.root, 'state'), 'user data');
  assert.equal(await main(['install', '--client', 'claude-code'], f.io), 0);
  const before = await tree(f.home);
  assert.equal(await main(['uninstall', '--purge'], f.io), 2);
  assert.deepEqual(await tree(f.home), before);
  assert.equal(await main(['uninstall'], f.io), 0);
  assert.equal(await fs.readFile(join(f.root, 'state'), 'utf8'), 'user data');
  assert.equal(await fs.lstat(join(f.bin, 'okit')).catch(() => null), null);
  assert.equal(await main(['install', '--client', 'claude-code'], f.io), 0);
  assert.equal(await main(['uninstall', '--purge', '--yes'], f.io), 0);
  assert.equal(await fs.stat(f.root).catch(() => null), null);
});

test('all dry-run routes preserve the entire tree and never download assets', async (t) => {
  const f = await fixture(t);
  const fetch = async (url, options) => { assert.ok(!/\/(package|manifest)$/.test(url)); return f.io.fetch(url, options); };
  let before = await tree(f.home);
  assert.equal(await main(['install', '--dry-run', '--client', 'claude-code'], { ...f.io, fetch }), 0);
  assert.deepEqual(await tree(f.home), before);
  assert.equal(await main(['install', '--client', 'claude-code'], f.io), 0);
  f.setVersion('2.0.0');
  before = await tree(f.home);
  for (const args of [['update', '--dry-run'], ['uninstall', '--dry-run']]) {
    assert.equal(await main(args, { ...f.io, fetch }), 0);
    assert.deepEqual(await tree(f.home), before);
  }
  assert.equal(await main(['update'], f.io), 0);
  before = await tree(f.home);
  assert.equal(await main(['update', '--rollback', '--dry-run'], f.io), 0);
  assert.deepEqual(await tree(f.home), before);
});

test('placement cleans staging on error, retains old version, and publishes by rename', async (t) => {
  const f = await fixture(t);
  assert.equal(await main(['install', '--client', 'claude-code'], f.io), 0);
  const before = await readRecord(f.destination, fs);
  const renames = [];
  const injected = { ...fs, rename: async (...args) => { renames.push(args); return fs.rename(...args); } };
  const selected = { version: '2.0.0', format: 'tar.gz' };
  await assert.rejects(place(selected, { bytes: f.payload(), sha256: 'hash' }, { client: 'claude-code' }, { ...f.deps, fs: injected }), /metadata version/);
  assert.deepEqual(await readRecord(f.destination, fs), before);
  assert.ok(!(await fs.readdir(f.destination)).some((name) => name.startsWith('.staging-')));
  f.setVersion('2.0.0');
  await place(selected, { bytes: f.payload(), sha256: 'hash' }, { client: 'claude-code' }, { ...f.deps, fs: injected });
  assert.ok(renames.some(([from, to]) => from.includes('.staging-') && to.endsWith('2.0.0-claude-code')));
  assert.ok(await fs.stat(before.path));
});

test('link preserves foreign files; configured data roots respect injected environment', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.bin);
  await fs.writeFile(join(f.bin, 'okit'), 'foreign');
  await applyLink({ path: f.destination, bin: 'src/cli.js' }, f.deps);
  assert.equal(await fs.readFile(join(f.bin, 'okit'), 'utf8'), 'foreign');
  const config = installConfig();
  assert.equal(installPaths(config, { env: { XDG_DATA_HOME: f.home }, platform: 'linux', home: '/unused' }).destination, join(f.home, config.directory));
  assert.equal(installPaths(config, { env: { LOCALAPPDATA: f.home }, platform: 'win32', home: '/unused' }).destination, join(f.home, config.directory));
});

test('installer contains no fixed service, client executable or repository identities', async () => {
  for (const item of await fs.readdir('src/install')) {
    const source = await fs.readFile(join('src/install', item), 'utf8');
    assert.doesNotMatch(source, /api\.github\.com|asantos43|\.local\/share|claude|okit-plugin@/);
  }
});

test('marketplace clients run configured commands; codex prints /plugins instruction', async (t) => {
  const f = await fixture(t);
  const commands = [];
  const deps = { ...f.deps, detect: async () => true, run: async (item) => commands.push(item) };
  const record = { client: 'claude-code', path: f.destination };
  await register(record, deps);
  assert.deepEqual(commands.map((item) => item.args.slice(0, 3)), [['plugin', 'marketplace', 'add'], ['plugin', 'install', 'okit-plugin@okit-plugin']]);
  await register({ ...record, client: 'codex' }, deps);
  assert.ok(f.output.some((line) => line.includes('/plugins')));
  await register(record, deps, 'update');
  assert.equal(commands.at(-1).args[1], 'update');
});

test('module registration installs through adapter and preserves edited skills and module', async (t) => {
  const f = await fixture(t);
  const source = join(f.home, 'payload');
  await fs.mkdir(join(source, 'skills', 'example'), { recursive: true });
  await fs.writeFile(join(source, 'skills', 'example', 'SKILL.md'), 'original');
  const record = { client: 'opencode', path: source };
  const clientRoot = join(f.home, 'client');
  const deps = { ...f.deps, clientRoot, detect: async () => true, loadAdapter: async () => moduleAdapter };
  await register(record, deps);
  const plugin = join(clientRoot, 'plugins', 'okit-plugin.js');
  const skill = join(clientRoot, 'skills', 'example', 'SKILL.md');
  assert.match(await fs.readFile(plugin, 'utf8'), /file:/);
  const before = await tree(clientRoot);
  await register(record, deps);
  assert.deepEqual(await tree(clientRoot), before);
  await fs.writeFile(skill, 'user skill');
  await fs.writeFile(plugin, 'user module');
  await register({ ...record, previous: record }, deps, 'update');
  assert.equal(await fs.readFile(skill, 'utf8'), 'user skill');
  assert.equal(await fs.readFile(plugin, 'utf8'), 'user module');
  await register(record, deps, 'uninstall');
  assert.equal(await fs.readFile(plugin, 'utf8'), 'user module');
});

test('download enforces size and body timeout; failed request is clear and writes nothing', async (t) => {
  const f = await fixture(t);
  const selected = await latestRelease({ ...f.deps, release: DEFAULT_CONFIG.release, pkg: f.pkg, repo: 'example/project', client: 'claude-code', system: 'linux', arch: 'x64' });
  let before = await tree(f.home);
  await assert.rejects(downloadRelease(selected, { ...f.deps, config: { ...f.config, maxDownloadBytes: 4 } }), /size limit/);
  assert.deepEqual(await tree(f.home), before);
  const hanging = async () => new Response(new ReadableStream({ start() {} }));
  await assert.rejects(downloadRelease(selected, { ...f.deps, fetch: hanging, config: { ...f.config, timeoutMs: 5 } }), /timeout/);
  assert.deepEqual(await tree(f.home), before);
  assert.equal(await main(['install', '--client', 'claude-code', '--dry-run'], { ...f.io, fetch: async () => { throw new Error('offline'); } }), 1);
  assert.ok(f.output.some((line) => line.includes('offline')));
  assert.deepEqual(await tree(f.home), before);
});

test('Windows creates both configured shims and preserves a foreign replacement', async (t) => {
  const f = await fixture(t);
  const deps = { ...f.deps, platform: 'win32' };
  const record = { path: join(f.home, 'path with spaces'), bin: 'src/cli.js' };
  await applyLink(record, deps);
  assert.match(await fs.readFile(join(f.bin, 'okit.cmd'), 'utf8'), /".*path with spaces.*" %\*/);
  assert.match(await fs.readFile(join(f.bin, 'okit.ps1'), 'utf8'), /@args/);
  await fs.writeFile(join(f.bin, 'okit.cmd'), 'foreign');
  await applyLink(record, deps, null, true);
  assert.equal(await fs.readFile(join(f.bin, 'okit.cmd'), 'utf8'), 'foreign');
  assert.equal(await fs.stat(join(f.bin, 'okit.ps1')).catch(() => null), null);
});
