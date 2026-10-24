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
import { place, readRecord, readRecords, saveRecord } from '../src/install/place.js';
import { applyLink, managePath } from '../src/install/link.js';
import { DEFAULT_CONFIG } from '../src/profiles.js';
import { register } from '../src/install/register.js';
import { installerCommand } from '../src/install/index.js';
import { rollback } from '../src/install/update.js';
import * as moduleAdapter from '../adapters/opencode/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
import { detectKit } from '../src/install/kit.js';

// | Input | Must pass | Must refuse |
// | legacy owned link, every client, install/update | migrate and uninstall | |
// | kit at legacy command, configured command | coexist and preserve kit | remove kit |
for (const client of Object.keys(DEFAULT_CONFIG.install.clients)) {
  for (const action of ['install', 'update']) for (const foreign of [false, true]) {
    test(`${action} migrates ${client}; foreign kit=${foreign}`, async (t) => {
      const f = await fixture(t);
      f.io.loadAdapter = async () => moduleAdapter;
      assert.equal(await main(['install', '--client', client], f.io), 0);
      const record = await readRecord(f.destination, client, fs);
      record.settings.command = DEFAULT_CONFIG.install.legacyCommands[0];
      await saveRecord(f.destination, record, f.deps);
      await fs.rename(join(f.bin, f.config.command), join(f.bin, record.settings.command));
      if (foreign) {
        await fs.unlink(join(f.bin, record.settings.command));
        await fs.writeFile(join(f.bin, record.settings.command), `#!${process.execPath}\nrequire('node:fs').writeSync(1, 'kit 3.2.1\\n');\n`, { mode: 0o755 });
      }
      const { command, ...settings } = f.config;
      await fs.writeFile(join(f.root, 'config.json'), JSON.stringify({ install: settings }));
      f.setVersion('2.0.0');
      assert.equal(await main([action, '--client', client], f.io), 0, f.output.join('\n'));
      const active = await readRecord(f.destination, client, fs);
      assert.equal(await fs.readlink(join(f.bin, command)), join(active.path, active.bin));
      const old = join(f.bin, record.settings.command);
      assert.equal(Boolean(await fs.lstat(old).catch(() => null)), foreign);
      if (foreign) assert.equal((await execute(old)).stdout.trim(), 'kit 3.2.1');
      assert.equal(await main(['uninstall', '--client', client], f.io), 0);
      assert.equal(await fs.lstat(join(f.bin, command)).catch(() => null), null);
      assert.equal(Boolean(await fs.lstat(old).catch(() => null)), foreign);
    });
  }
}

test('plugin and kit commands execute their own tool in a temporary HOME', async (t) => {
  const f = await fixture(t);
  assert.equal(await main(['install', '--client', 'codex'], f.io), 0);
  const record = await readRecord(f.destination, 'codex', fs);
  await fs.writeFile(join(record.path, record.bin), `#!${process.execPath}\nrequire('node:fs').writeSync(1, 'plugin\\n');\n`, { mode: 0o755 });
  await fs.chmod(join(record.path, record.bin), 0o755);
  await fs.writeFile(join(f.bin, 'okit'), `#!${process.execPath}\nrequire('node:fs').writeSync(1, 'kit 3.2.1\\n');\n`, { mode: 0o755 });
  const env = { HOME: f.home, PATH: f.bin };
  assert.equal((await execute(f.config.command, [], { env })).stdout.trim(), 'plugin');
  assert.equal((await execute('okit', [], { env })).stdout.trim(), 'kit 3.2.1');
  const run = ({ command, args }) => execute(command, args, { env });
  assert.equal((await detectKit({ ...f.deps, env, run })).state, 'installed');
});

// PATH corpus: must pass: new shell, repeat, rollback, user edits, candidates.
// Must refuse: duplicate blocks, editing profiles with --no-path or PATH present.
test('managed PATH resolves and executes skill command, repeats and rolls back without duplication', async (t) => {
  const f = await fixture(t);
  f.io.env.SHELL = '/bin/bash';
  const profile = join(f.home, '.profile');
  const rc = join(f.home, '.bashrc');
  await fs.writeFile(profile, '# user login\n');
  await fs.writeFile(rc, '# user rc\n');
  assert.equal(await main(['install', '--client', 'codex'], f.io), 0, f.output.join('\n'));
  const installed = await fs.readFile(profile, 'utf8');
  assert.ok(installed.includes(f.config.path.begin));
  assert.ok((await fs.readFile(rc, 'utf8')).includes(f.config.path.begin));
  assert.equal(await main(['install', '--client', 'codex'], f.io), 0);
  assert.equal(await fs.readFile(profile, 'utf8'), installed);
  f.setVersion('2.0.0');
  assert.equal(await main(['update'], f.io), 0);
  assert.equal(await main(['update', '--rollback'], f.io), 0);
  assert.equal(await fs.readFile(profile, 'utf8'), installed);
  const record = await readRecord(f.destination, 'codex', fs);
  await fs.writeFile(join(record.path, record.bin), `#!${process.execPath}\nrequire('node:fs').writeSync(1, process.argv.slice(2).join(' ')+'\\n');\n`, { mode: 0o755 });
  const result = await execute('/bin/sh', ['-ec', '. "$1"; . "$1"; command -v okit-plugin; okit-plugin client-smoke --dry-run; printf "%s" "$PATH"', 'sh', profile], { env: { HOME: f.home, PATH: '' } });
  assert.equal(result.stdout, `${join(f.bin, 'okit-plugin')}\nclient-smoke --dry-run\n${f.bin}`);
  assert.ok(f.output.some((line) => line.includes(`Verificação do PATH: ${join(f.bin, 'okit-plugin')}`)));
});

test('uninstall removes only owned PATH blocks and keeps later user edits', async (t) => {
  const f = await fixture(t);
  const profile = join(f.home, '.profile');
  assert.equal(await main(['install', '--client', 'codex'], f.io), 0);
  await fs.appendFile(profile, '# user appended\n');
  assert.equal(await main(['uninstall'], f.io), 0);
  assert.equal(await fs.readFile(profile, 'utf8'), '# user appended\n');
  assert.equal(await fs.stat(join(f.destination, f.config.path.stateFile)).catch(() => null), null);
});

for (const mode of ['present', 'no-path', 'disabled']) test(`PATH ${mode} leaves profiles untouched`, async (t) => {
  const f = await fixture(t);
  const profile = join(f.home, '.profile');
  await fs.writeFile(profile, '# untouched\n');
  if (mode === 'present') { await fs.mkdir(f.bin); f.io.env.PATH = f.bin; }
  if (mode === 'disabled') {
    await fs.writeFile(join(f.root, 'config.json'), JSON.stringify({ install: { ...f.config, path: { enabled: false } } }));
  }
  const args = ['install', '--client', 'codex', ...(mode === 'no-path' ? ['--no-path'] : [])];
  assert.equal(await main(args, f.io), 0);
  assert.equal(await fs.readFile(profile, 'utf8'), '# untouched\n');
  assert.equal(await fs.stat(join(f.home, '.bashrc')).catch(() => null), null);
  assert.equal(await fs.stat(join(f.destination, f.config.path.stateFile)).catch(() => null), null);
});

test('installer selects a writable configured candidate already on PATH', async (t) => {
  const f = await fixture(t);
  const candidate = join(f.home, 'chosen');
  await fs.mkdir(candidate);
  f.io.env.PATH = candidate;
  await fs.writeFile(join(f.root, 'config.json'), JSON.stringify({ install: {
    ...f.config, linkDirectory: null, path: { candidates: [['absent'], ['chosen']] },
  } }));
  assert.equal(await main(['install', '--client', 'codex'], f.io), 0);
  assert.equal((await readRecord(f.destination, 'codex', fs)).linkDirectory, candidate);
  assert.ok(await fs.lstat(join(candidate, f.config.command)));
  assert.equal(await fs.stat(join(f.home, '.profile')).catch(() => null), null);
});

for (const shell of ['bash', 'zsh', 'fish']) test(`${shell} creates its configured login profile when none exists`, async (t) => {
  const f = await fixture(t);
  f.io.env.SHELL = `/bin/${shell}`;
  assert.equal(await main(['install', '--client', 'codex'], f.io), 0);
  const profile = join(f.home, f.config.path.shells[shell].login);
  const content = await fs.readFile(profile, 'utf8');
  assert.ok(content.includes(f.config.path.begin));
  assert.equal(await main(['install', '--client', 'codex'], f.io), 0);
  assert.equal(await fs.readFile(profile, 'utf8'), content);
});

for (const owned of [true, false]) test(`Windows user PATH preserves existing entries; owns addition=${owned}`, async (t) => {
  const f = await fixture(t);
  const calls = [];
  const deps = { ...f.deps, platform: 'win32', pathExecute: async (command, args) => {
    assert.equal(command, f.config.path.windowsExecutable);
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    calls.push(script);
    assert.match(script, /GetEnvironmentVariable\('Path','User'\)/);
    assert.match(script, /SetEnvironmentVariable\('Path',\(\$next -join ';'\),'User'\)/);
    return { stdout: owned ? 'true\n' : 'false\n' };
  } };
  await managePath(deps);
  await managePath(deps);
  assert.equal(calls.length, owned ? 1 : 2);
  assert.match(calls[0], /-icontains \$bin/);
  assert.match(calls[0], /\$next=@\(\$parts\)\+\$bin/);
  await managePath(deps, true);
  assert.equal(calls.length, owned ? 2 : 2);
  if (owned) assert.match(calls.at(-1), /Where-Object \{ \$_ -ine \$bin \}/);
});

// Must pass / must refuse corpus:
// | Input | Must pass | Must refuse |
// | exact pair, unique detected client, same version | install/menu/no-op | |
// | valid tar/zip, executable mode, retained version | extraction/rollback | |
// | checksum mismatch/missing line, paths/links, size/timeout | | before placement |
// | ambiguous menu, invalid client, purge without yes | | before mutation |
// | dry-run, edited skill/module, foreign command link | preserve tree/edits | overwrite |
// | registered client, shared settings, own chain | synchronize/preserve other folders | |
// | unregistered client, previous from another client | | before mutation |
// | legacy plugin link / foreign kit link | migrate plugin / preserve kit | delete kit |

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
  const pkg = { name: 'sample', version, bin: { 'okit-plugin': 'src/cli.js' }, repository: { url: 'https://example.invalid/example/project' } };
  const payload = () => tarGz([
    { path: 'package.json', mode: 0o644, data: JSON.stringify({ ...pkg, version }) },
    { path: 'src/cli.js', mode: 0o755, data: '#!/usr/bin/env node\n' },
    { path: 'skills/example/SKILL.md', mode: 0o644, data: 'fake skill' },
  ]);
  const clients = Object.keys(config.clients);
  const name = (client = 'claude-code') => `sample-${version}-${client}-linux-x64.tar.gz`;
  const selected = () => ({ tag_name: `v${version}`, prerelease, published_at: '2026-10-24', assets: [
    ...clients.map((client) => ({ name: name(client), browser_download_url: `https://fake.invalid/package/${client}` })),
    { name: `sample-${version}-checksums.sha256`, browser_download_url: 'https://fake.invalid/manifest' },
  ] });
  const fetch = async (url) => {
    if (url.endsWith('/latest')) return prerelease ? new Response('', { status: 404 }) : Response.json(selected());
    if (url.endsWith('/releases')) return Response.json([selected()]);
    if (url.includes('/package/')) return new Response(payload());
    if (url.endsWith('/manifest')) return new Response(clients.map((client) => `${badHash ? '0'.repeat(64) : createHash('sha256').update(payload()).digest('hex')}  ${missing ? 'other.tar.gz' : name(client)}\n`).join(''));
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

test('multiple client menu selections and detected all', async (t) => {
  const { deps } = await fixture(t);
  assert.deepEqual(await chooseClient(null, { ...deps, tty: true, read: async () => '1,3,1' }), ['claude-code', 'opencode']);
  assert.deepEqual(await chooseClient(null, { ...deps, tty: true, read: async () => 'all' }), Object.keys(deps.config.clients));
  assert.deepEqual(await chooseClient('all', { ...deps, detect: async () => true }), Object.keys(deps.config.clients));
  await assert.rejects(chooseClient('all', deps), /No detected/);
});

test('legacy record migrates on write with previous chain intact', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.destination);
  const legacy = { client: 'codex', version: '2', previous: { client: 'codex', version: '1', previous: null } };
  await fs.writeFile(join(f.destination, 'install.json'), JSON.stringify(legacy));
  assert.deepEqual(await readRecord(f.destination, 'codex', fs), legacy);
  await saveRecord(f.destination, legacy, f.deps);
  assert.deepEqual(await readRecords(f.destination, fs), { codex: legacy });
  await assert.rejects(fs.stat(join(f.destination, 'install.json')), { code: 'ENOENT' });
});

test('record naming is configurable and refuses a shared filename', async (t) => {
  const f = await fixture(t);
  assert.throws(() => installConfig({ recordName: 'shared.json' }), /recordName/);
  const config = installConfig({ ...f.config, recordName: 'record-{client}.json' });
  await fs.mkdir(f.destination);
  await saveRecord(f.destination, { client: 'codex', version: '1' }, { ...f.deps, config });
  assert.equal((await readRecord(f.destination, 'codex', fs, config)).version, '1');
  assert.deepEqual(await fs.readdir(f.destination), ['record-codex.json']);
});

test('install all continues after failed package; unknown registered client refuses', async (t) => {
  const f = await fixture(t);
  const before = await tree(f.home);
  for (const args of [['update'], ['update', '--check'], ['update', '--rollback'], ['uninstall']]) {
    assert.equal(await main([...args, '--client', 'codex'], f.io), 2);
    assert.deepEqual(await tree(f.home), before);
  }
  const fetch = async (url, opts) => {
    if (url.endsWith('/package/codex')) throw new Error('fake package failure');
    return f.io.fetch(url, opts);
  };
  const io = { ...f.io, fetch, detect: async () => true, loadAdapter: async () => moduleAdapter };
  assert.equal(await main(['install', '--client', 'all', '--dry-run'], io), 0);
  assert.deepEqual(await tree(f.home), before);
  assert.equal(await main(['install', '--client', 'all'], io), 1);
  assert.ok(await readRecord(f.destination, 'claude-code', fs));
  assert.ok(await readRecord(f.destination, 'opencode', fs));
  assert.equal(await readRecord(f.destination, 'codex', fs), null);
  assert.ok(f.output.includes('codex: failed'));
});

test('unregistered client refuses update and uninstall before touching files', async (t) => {
  const f = await fixture(t);
  assert.equal(await main(['install', '--client', 'claude-code'], f.io), 0);
  const before = await tree(f.home);
  for (const command of ['update', 'uninstall']) {
    f.output.length = 0;
    assert.equal(await main([command, '--client', 'codex'], f.io), 2);
    assert.ok(f.output.some((line) => line.includes('Client not registered: codex')));
    assert.deepEqual(await tree(f.home), before);
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.commands, []);
  }
});

for (const route of ['direct', 'installerCommand']) test(`cross-client previous refuses rollback via ${route}`, async (t) => {
  const f = await fixture(t);
  for (const client of ['claude-code', 'codex']) assert.equal(await main(['install', '--client', client], f.io), 0);
  const records = await readRecords(f.destination, fs);
  const corrupt = { ...records.codex, previous: records['claude-code'] };
  await saveRecord(f.destination, corrupt, f.deps);
  const before = await tree(f.home);
  if (route === 'direct') {
    await assert.rejects(rollback(corrupt, f.io), {
      name: 'TypeError', message: 'Previous version belongs to another client',
    });
  } else {
    assert.equal(await installerCommand('update', ['--rollback', '--client', 'codex'], f.deps, f.io), 2);
    assert.ok(f.output.includes('refused: Previous version belongs to another client'));
  }
  assert.deepEqual(await tree(f.home), before);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.commands, []);
});

test('second client synchronizes shared link and autostart into existing record', async (t) => {
  const f = await fixture(t);
  assert.equal(await main(['install', '--client', 'claude-code', '--no-link'], f.io), 0);
  const first = await readRecord(f.destination, 'claude-code', fs);
  assert.equal(first.autostart, false);
  assert.equal(first.link, false);
  assert.equal(await main(['install', '--client', 'codex', '--autostart'], f.io), 0);
  const records = await readRecords(f.destination, fs);
  assert.equal(records.codex.autostart, true);
  assert.equal(records.codex.link, true);
  assert.equal(records.codex.linkDirectory, f.bin);
  assert.deepEqual(records['claude-code'], { ...first, autostart: true,
    link: records.codex.link, linkDirectory: records.codex.linkDirectory });
  assert.equal(await fs.readlink(join(f.bin, 'okit-plugin')), join(records.codex.path, records.codex.bin));
});

for (const corruption of ['protected path', 'foreign client']) test(`uninstall preserves cross-client previous with ${corruption}`, async (t) => {
  const f = await fixture(t);
  for (const client of ['claude-code', 'codex']) assert.equal(await main(['install', '--client', client], f.io), 0);
  const records = await readRecords(f.destination, fs);
  const retained = corruption === 'protected path' ? records.codex.path : join(f.destination, 'orphan-codex');
  if (corruption === 'foreign client') {
    await fs.mkdir(retained);
    await fs.writeFile(join(retained, 'sentinel'), 'keep foreign history');
  }
  const ownPrevious = join(f.destination, 'old-claude-code');
  await fs.mkdir(ownPrevious);
  await saveRecord(f.destination, { ...records['claude-code'], previous: {
    ...records['claude-code'], path: ownPrevious, previous: {
      ...records.codex, client: corruption === 'protected path' ? 'claude-code' : 'codex', path: retained,
    },
  } }, f.deps);
  const before = await tree(retained);
  assert.equal(await main(['uninstall', '--client', 'claude-code'], f.io), 0);
  assert.deepEqual(await tree(retained), before);
  assert.deepEqual(await readRecord(f.destination, 'codex', fs), records.codex);
  assert.equal(await readRecord(f.destination, 'claude-code', fs), null);
  for (const path of [records['claude-code'].path, ownPrevious]) await assert.rejects(fs.stat(path), { code: 'ENOENT' });
});

test('three clients keep independent records, updates, rollback and shared link', async (t) => {
  const f = await fixture(t);
  f.io.loadAdapter = async () => moduleAdapter;
  const clients = Object.keys(f.config.clients);
  for (const client of clients) assert.equal(await main(['install', '--client', client], f.io), 0);
  const initial = await readRecords(f.destination, fs);
  assert.deepEqual(Object.keys(initial), clients);
  assert.equal((await fs.readdir(f.destination)).filter((name) => name.endsWith('.json') && name !== f.config.path.stateFile).length, 3);
  for (const client of clients) assert.ok(await fs.stat(initial[client].path));
  f.setVersion('2.0.0');
  const before = await tree(f.home);
  assert.equal(await main(['update', '--dry-run'], f.io), 0);
  assert.deepEqual(await tree(f.home), before);
  assert.equal(await main(['update', '--check'], f.io), 0);
  assert.equal(await main(['uninstall', '--purge', '--yes', '--dry-run'], f.io), 0);
  assert.deepEqual(await tree(f.home), before);
  const downloads = [];
  const fetch = async (url, opts) => { if (url.includes('/package/')) downloads.push(url); return f.io.fetch(url, opts); };
  assert.equal(await main(['update'], { ...f.io, fetch }), 0);
  assert.equal(new Set(downloads).size, 3); assert.equal(downloads.length, 3);
  assert.equal(f.events.filter((event) => event === 'smoke').length, 3);
  const updated = await readRecords(f.destination, fs);
  assert.equal(await main(['update', '--rollback', '--client', 'codex'], f.io), 0);
  let records = await readRecords(f.destination, fs);
  assert.equal(records.codex.version, '1.0.0');
  assert.deepEqual(records['claude-code'], updated['claude-code']);
  assert.deepEqual(records.opencode, updated.opencode);
  f.setVersion('3.0.0');
  assert.equal(await main(['update', '--client', 'codex'], f.io), 0);
  records = await readRecords(f.destination, fs);
  assert.equal(records.codex.version, '3.0.0');
  assert.deepEqual(records.opencode, updated.opencode);
  const protectedTree = await tree(f.home);
  assert.equal(await main(['uninstall', '--client', 'codex', '--purge', '--yes'], f.io), 2);
  assert.deepEqual(await tree(f.home), protectedTree);
  assert.equal(await main(['uninstall', '--client', 'codex'], f.io), 0);
  assert.equal(await readRecord(f.destination, 'codex', fs), null);
  for (const client of ['claude-code', 'opencode']) {
    assert.deepEqual(await readRecord(f.destination, client, fs), updated[client]);
    assert.ok(await fs.stat(updated[client].path));
    assert.ok(await fs.stat(updated[client].previous.path));
  }
  assert.ok(await fs.stat(join(f.bin, 'okit-plugin')));
  assert.equal(await main(['uninstall'], f.io), 0);
  assert.deepEqual(await readRecords(f.destination, fs), {});
  assert.equal(await fs.lstat(join(f.bin, 'okit-plugin')).catch(() => null), null);
});

test('update all continues after smoke failure and synchronizes shared settings', async (t) => {
  const f = await fixture(t);
  const io = { ...f.io, detect: async () => true, loadAdapter: async () => moduleAdapter };
  assert.equal(await main(['install', '--client', 'all', '--autostart'], io), 0);
  f.setVersion('2.0.0');
  const checked = [];
  assert.equal(await main(['update'], { ...io, smoke: async (record) => {
    checked.push(record.client); return { code: record.client === 'codex' ? 1 : 0 };
  } }), 1);
  assert.deepEqual(checked, Object.keys(f.config.clients));
  const records = await readRecords(f.destination, fs);
  for (const record of Object.values(records)) {
    assert.equal(record.version, '2.0.0'); assert.equal(record.autostart, true);
    assert.equal(record.previous.client, record.client);
  }
  assert.equal(await main(['uninstall', '--client', 'opencode'], io), 0);
  const target = await fs.readlink(join(f.bin, 'okit-plugin'));
  assert.ok(await fs.stat(target));
  assert.ok(f.events.filter((event) => event === 'autostart').length > 3);
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
  assert.equal(await fs.readlink(join(f.bin, 'okit-plugin')), join(prior.path, prior.bin));
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
  assert.equal(await fs.lstat(join(f.bin, 'okit-plugin')).catch(() => null), null);
  assert.equal(await main(['install', '--client', 'claude-code'], f.io), 0);
  assert.equal(await main(['uninstall', '--purge', '--yes'], f.io), 0);
  assert.equal(await fs.stat(f.root).catch(() => null), null);
});

test('all dry-run routes preserve the entire tree and never download assets', async (t) => {
  const f = await fixture(t);
  const fetch = async (url, options) => { assert.ok(!/\/(package\/|manifest$)/.test(url)); return f.io.fetch(url, options); };
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
  await fs.writeFile(join(f.bin, 'okit-plugin'), 'foreign');
  await applyLink({ path: f.destination, bin: 'src/cli.js' }, f.deps);
  assert.equal(await fs.readFile(join(f.bin, 'okit-plugin'), 'utf8'), 'foreign');
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

for (const action of ['install', 'update', 'uninstall']) test(`${action} migrates 0.2.0 links for every client and preserves kit`, async (t) => {
  const f = await fixture(t);
  f.io.loadAdapter = async () => moduleAdapter;
  f.io.detect = async () => true;
  assert.equal(await main(['install', '--client', 'all'], f.io), 0);
  for (const record of Object.values(await readRecords(f.destination, fs))) {
    record.settings.command = 'okit';
    await fs.writeFile(join(f.destination, `install.${record.client}.json`), JSON.stringify(record));
  }
  const current = await readRecord(f.destination, fs);
  const old = join(f.bin, 'okit');
  await fs.symlink(join(current.path, current.bin), old);
  const args = action === 'install' ? ['install', '--client', 'all'] : [action];
  if (action === 'update') f.setVersion('1.1.0');
  assert.equal(await main(args, f.io), 0);
  assert.equal(await fs.lstat(old).catch(() => null), null);
  assert.equal(Boolean(await fs.lstat(join(f.bin, 'okit-plugin')).catch(() => null)), action !== 'uninstall');
  if (action === 'uninstall') assert.equal(await main(['install', '--client', 'all'], f.io), 0);
  const kit = join(f.home, 'kit');
  await fs.writeFile(kit, 'foreign kit', { mode: 0o755 });
  await fs.symlink(kit, old);
  assert.equal(await main(args, f.io), 0);
  assert.equal(await fs.readlink(old), kit);
  assert.equal(await fs.readFile(kit, 'utf8'), 'foreign kit');
});

test('Windows migrates owned legacy shims and preserves foreign kit shims', async (t) => {
  const f = await fixture(t);
  const record = { path: join(f.destination, '0.2.0-codex'), bin: 'src/cli.js', client: 'codex' };
  await fs.mkdir(record.path, { recursive: true });
  await saveRecord(f.destination, record, f.deps);
  const deps = { ...f.deps, platform: 'win32' };
  await applyLink(record, { ...deps, config: { ...f.config, command: 'okit' } });
  await applyLink(record, deps);
  for (const suffix of ['.cmd', '.ps1']) {
    assert.equal(await fs.stat(join(f.bin, `okit${suffix}`)).catch(() => null), null);
    assert.ok(await fs.stat(join(f.bin, `${f.config.command}${suffix}`)));
    await fs.writeFile(join(f.bin, `okit${suffix}`), 'foreign kit');
  }
  await applyLink(record, deps, null, true);
  for (const suffix of ['.cmd', '.ps1']) {
    assert.equal(await fs.readFile(join(f.bin, `okit${suffix}`), 'utf8'), 'foreign kit');
    assert.equal(await fs.stat(join(f.bin, `${f.config.command}${suffix}`)).catch(() => null), null);
  }
});

test('Windows creates both configured shims and preserves a foreign replacement', async (t) => {
  const f = await fixture(t);
  const deps = { ...f.deps, platform: 'win32' };
  const record = { path: join(f.home, 'path with spaces'), bin: 'src/cli.js' };
  await applyLink(record, deps);
  assert.match(await fs.readFile(join(f.bin, 'okit-plugin.cmd'), 'utf8'), /".*path with spaces.*" %\*/);
  assert.match(await fs.readFile(join(f.bin, 'okit-plugin.ps1'), 'utf8'), /@args/);
  await fs.writeFile(join(f.bin, 'okit-plugin.cmd'), 'foreign');
  await applyLink(record, deps, null, true);
  assert.equal(await fs.readFile(join(f.bin, 'okit-plugin.cmd'), 'utf8'), 'foreign');
  assert.equal(await fs.stat(join(f.bin, 'okit-plugin.ps1')).catch(() => null), null);
});

test('Windows migrates only owned legacy shims, including during uninstall', async (t) => {
  const f = await fixture(t);
  const deps = { ...f.deps, platform: 'win32' };
  const record = { path: join(f.home, 'plugin'), bin: 'src/cli.js' };
  const old = { ...deps, config: { ...deps.config, command: deps.config.legacyCommands[0] } };
  await applyLink(record, old);
  await applyLink(record, deps);
  for (const suffix of ['.cmd', '.ps1']) {
    assert.equal(await fs.lstat(join(f.bin, old.config.command + suffix)).catch(() => null), null);
    assert.ok(await fs.stat(join(f.bin, deps.config.command + suffix)));
  }
  await applyLink(record, old);
  await fs.writeFile(join(f.bin, old.config.command + '.cmd'), 'foreign kit');
  await applyLink(record, deps, null, true);
  assert.equal(await fs.readFile(join(f.bin, old.config.command + '.cmd'), 'utf8'), 'foreign kit');
  assert.equal(await fs.lstat(join(f.bin, old.config.command + '.ps1')).catch(() => null), null);
  assert.equal(await fs.lstat(join(f.bin, deps.config.command + '.cmd')).catch(() => null), null);
});

test('migration removes a dangling owned link and preserves a foreign symlink', async (t) => {
  const f = await fixture(t);
  const record = { client: 'codex', path: join(f.destination, '0.2.0-codex'), bin: 'src/cli.js' };
  await fs.mkdir(f.destination);
  await saveRecord(f.destination, record, f.deps);
  await fs.mkdir(f.bin);
  const legacy = join(f.bin, f.config.legacyCommands[0]);
  await fs.symlink(join(record.path, record.bin), legacy);
  await applyLink(record, f.deps);
  assert.equal(await fs.lstat(legacy).catch(() => null), null);
  const kit = join(f.home, 'foreign-kit');
  await fs.symlink(kit, legacy);
  await applyLink(record, f.deps, null, true);
  assert.equal(await fs.readlink(legacy), kit);
});
