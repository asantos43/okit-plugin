import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { detectKit } from '../src/install/kit.js';
import { installConfig } from '../src/install/config.js';
import { DEFAULT_CONFIG } from '../src/profiles.js';
import { renderName } from '../src/install/config.js';

// | Corpus | Must pass | Must refuse |
// | version, custom name/path/args/deadline | installed | |
// | missing executable | absent, informational exit 0 | --require exit 1 |
// | garbage, exit failure, timeout | broken, informational exit 0 | --require exit 1 |
// | invalid config/flags | | validation/usage |
// | legacy/current plugin bin, Windows shim | absent, never probe plugin | installed |
// | plugin and kit together | each command runs its own tool | plugin counted as kit |
const execute = promisify(execFile);

test('legacy plugin executable is absent; fallback kit alone is installed', async (t) => {
  const f = await fixture(t, { executables: DEFAULT_CONFIG.install.kit.executables });
  const plugin = join(f.home, 'plugin');
  await fs.mkdir(join(plugin, 'src'), { recursive: true });
  await fs.writeFile(join(plugin, 'package.json'), JSON.stringify({ name: 'okit-plugin', bin: { okit: 'src/cli.js' } }));
  const target = join(plugin, 'src/cli.js');
  await fs.writeFile(target, '#!/bin/sh\necho 0.2.0\n', { mode: 0o755 });
  await fs.symlink(target, join(f.home, 'okit'));
  const calls = [];
  const deps = { ...f.deps, run: async (input) => { calls.push(input.command); return f.deps.run(input); } };
  assert.equal((await detectKit(deps)).state, 'absent');
  assert.deepEqual(calls, []);
  const fallback = await f.executable("console.log('kit 4.5.6')", 'kit');
  assert.equal((await detectKit(deps)).path, fallback);
  assert.deepEqual(calls, [fallback]);
  deps.config = installConfig({ kit: { path: join(f.home, 'okit') } });
  assert.equal((await detectKit(deps)).state, 'absent');
});
async function fixture(t, kit = {}) {
  const home = await fs.mkdtemp(join(tmpdir(), 'kit-detector-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const config = installConfig({ destination: join(home, 'data'), kit: { executables: ['custom-orchestrator'], ...kit } });
  const env = { HOME: home, PATH: home };
  const output = [];
  await fs.writeFile(join(home, 'config.json'), JSON.stringify({ install: config }));
  const run = ({ command, args, signal, timeoutMs }) => execute(command, args, { signal, timeout: timeoutMs, killSignal: 'SIGKILL', env });
  const deps = { fs, config, env, platform: process.platform, run };
  const io = { root: home, home, env, stdout: (line) => output.push(line), stderr: (line) => output.push(line) };
  const executable = async (body, name = config.kit.executables[0]) => {
    const path = join(home, name);
    await fs.writeFile(path, `#!${process.execPath}\nconsole.log = (line) => require('node:fs').writeSync(1, String(line) + '\\n');\n${body}\n`, { mode: 0o755 });
    return path;
  };
  return { home, config, deps, io, output, executable };
}

test('plugin and kit coexist; legacy plugin never counts as kit', async (t) => {
  const f = await fixture(t, { executables: ['okit', 'kit'] });
  const folder = join(f.home, 'plugin');
  await fs.mkdir(folder);
  const plugin = join(folder, 'cli.cjs');
  await fs.writeFile(join(folder, 'package.json'), JSON.stringify({ name: 'okit-plugin', bin: { 'okit-plugin': 'cli.cjs' } }));
  await fs.writeFile(plugin, `#!${process.execPath}\nrequire('node:fs').writeSync(1, 'plugin v0.2.0\\n');`, { mode: 0o755 });
  await fs.symlink(plugin, join(f.home, 'okit-plugin'));
  const kit = await f.executable("console.log('kit v1.2.3')", 'okit');
  assert.match((await f.deps.run({ command: join(f.home, 'okit-plugin'), args: [] })).stdout, /plugin v0.2.0/);
  assert.equal((await detectKit(f.deps)).path, kit);
  await fs.unlink(kit);
  await fs.symlink(plugin, kit);
  f.deps.run = async () => { throw new Error('plugin must never be probed'); };
  assert.match((await detectKit(f.deps)).message, /absent.*plugin executable ignored/);
  const fallback = await f.executable("console.log('kit v2.0.0')", 'kit');
  f.deps.run = ({ command, args }) => execute(command, args);
  assert.equal((await detectKit(f.deps)).path, fallback);
});

test('Windows legacy shim to a recorded plugin is absent without executing it', async (t) => {
  const f = await fixture(t, { executables: ['okit', 'kit'] });
  await fs.mkdir(f.config.destination);
  const path = join(f.config.destination, '0.2.0-codex');
  await fs.mkdir(path);
  await fs.writeFile(join(f.config.destination, 'install.codex.json'), JSON.stringify({ client: 'codex', path }));
  await fs.writeFile(join(f.home, 'okit.cmd'), `@echo off\r\n"node" "${join(path, 'cli.js')}" %*\r\n`);
  const result = await detectKit({ ...f.deps, platform: 'win32', run: () => { throw new Error('must not execute plugin'); } });
  assert.equal(result.state, 'absent');
  assert.match(result.message, /plugin executable ignored/);
});

test('custom executable and version arguments work on injected PATH; only version is run', async (t) => {
  const f = await fixture(t, { versionArgs: ['version', '--short'] });
  const path = await f.executable("if (process.argv.slice(2).join(' ') !== 'version --short') process.exit(9); console.log('custom v2.3.4-beta.1');");
  const result = await detectKit(f.deps);
  assert.equal(result.state, 'installed');
  assert.equal(result.path, path);
  assert.equal(result.version, 'custom v2.3.4-beta.1');
  assert.match(result.message, /ARCHITECTURE.md#kit-and-plugin-overlap-d1/);
  assert.equal(await main(['kit', '--require'], f.io), 0);
  assert.equal(f.output.length, 1);
});

test('absent detector uses configured hint, optional and required exit codes', async (t) => {
  const f = await fixture(t, { hint: 'Read custom installation documentation.' });
  assert.deepEqual(await detectKit(f.deps), { state: 'absent', path: null, version: null, message: 'kit: absent. Read custom installation documentation.' });
  assert.equal(await main(['kit'], f.io), 0);
  assert.equal(await main(['kit', '--require'], f.io), 1);
  assert.equal(await main(['kit', '--require=true'], f.io), 2);
  assert.equal(await main(['kit', 'unknown'], f.io), 2);
  f.config.kit.require = true;
  await fs.writeFile(join(f.home, 'config.json'), JSON.stringify({ install: f.config }));
  assert.equal(await main(['kit'], f.io), 1);
});

test('PATH discovery tries the second configured executable name', async (t) => {
  const f = await fixture(t, { executables: ['missing-first-probe', 'available-second-probe'] });
  const path = await f.executable("console.log('2.3.4')", 'available-second-probe');
  const result = await detectKit(f.deps);
  assert.equal(result.state, 'installed');
  assert.equal(result.path, path);
  assert.equal(result.version, '2.3.4');
});

test('configured directory is absent even with executable permission bits', async (t) => {
  const f = await fixture(t, { path: '.' });
  f.config.kit.path = f.home;
  await fs.chmod(f.home, 0o755);
  const result = await detectKit(f.deps);
  assert.equal(result.state, 'absent');
  assert.equal(result.path, null);
  assert.equal(result.version, null);
});

test('configured path takes precedence; missing paths and non-executable files are absent', async (t) => {
  const f = await fixture(t);
  const path = await f.executable("console.log('3.2.1')", 'alternate-tool');
  f.deps.config = installConfig({ kit: { path } });
  assert.equal((await detectKit(f.deps)).path, path);
  await fs.chmod(path, 0o644);
  if (process.platform !== 'win32') assert.equal((await detectKit(f.deps)).state, 'absent');
  await fs.rm(path);
  assert.equal((await detectKit(f.deps)).state, 'absent');
});

test('garbage version, empty output and failed command are broken and informational', async (t) => {
  const f = await fixture(t);
  for (const body of ["console.log('not a version')", "console.log('build 123')", '', "console.log('1.2.3'); process.exit(4)"]) {
    await f.executable(body);
    assert.equal((await detectKit(f.deps)).state, 'broken');
    assert.equal(await main(['kit'], f.io), 0);
    assert.equal(await main(['kit', '--require'], f.io), 1);
    assert.match(f.output.at(-1), /^kit: broken/);
  }
});

test('valid version output with failed exit is broken for rejected and resolved runs', async (t) => {
  const f = await fixture(t);
  const path = await f.executable("console.log('1.2.3'); process.exit(4)");
  const run = f.deps.run;
  await assert.rejects(run({ command: path, args: f.config.kit.versionArgs }), (error) => {
    assert.equal(error.code, 4);
    assert.equal(error.stdout.trim(), '1.2.3');
    return true;
  });
  assert.equal((await detectKit(f.deps)).state, 'broken');
  f.deps.run = (options) => run(options).catch((error) => error);
  assert.equal((await detectKit(f.deps)).state, 'broken');
  for (const failure of [{ code: 4 }, { exitCode: 4 }, { signal: 'SIGTERM' }]) {
    f.deps.run = async () => ({ stdout: '1.2.3\n', ...failure });
    const result = await detectKit(f.deps);
    assert.equal(result.state, 'broken', JSON.stringify(failure));
    assert.equal(result.path, path);
    assert.equal(result.version, null);
  }
});

test('configured deadline changes outcome and kills an unresponsive process', async (t) => {
  const f = await fixture(t, { timeoutMs: 10 });
  await f.executable("process.on('SIGTERM', () => {}); setTimeout(() => console.log('1.2.3'), 150);");
  let child;
  f.deps.run = ({ command, args, signal, timeoutMs }) => new Promise((resolve, reject) => {
    child = execFile(command, args, { timeout: timeoutMs, killSignal: 'SIGKILL' }, (error, stdout) => error ? reject(error) : resolve({ stdout }));
    signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
  });
  const result = await detectKit(f.deps);
  assert.equal(result.state, 'broken');
  assert.match(result.message, /10 ms/);
  if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(child.signalCode, 'SIGKILL');
  f.config.kit.timeoutMs = 2000;
  assert.equal((await detectKit(f.deps)).state, 'installed');
  f.config.kit.timeoutMs = 10;
  assert.equal(await main(['kit', '--require'], f.io), 1);
  assert.match(f.output.at(-1), /timed out after 10 ms/);
});

test('configuration rejects invalid detector settings', () => {
  for (const kit of [{ executables: [] }, { executables: ['dir/tool'] }, { path: '' }, { versionArgs: '--version' }, { timeoutMs: 0 }, { timeoutMs: 1.5 }, { require: 'yes' }, { hint: '' }, { overlap: '\n' }]) {
    assert.throws(() => installConfig({ kit }), /Invalid install.kit/);
  }
});

test('install/update summaries and status contain kit; dry-run writes nothing', async (t) => {
  const f = await fixture(t);
  await f.executable("console.log('kit v1.2.3')");
  const source = join(f.home, 'source');
  await fs.mkdir(join(source, 'src'), { recursive: true });
  const pkg = { name: 'okit-plugin', version: '1.0.0', bin: { 'okit-plugin': 'src/cli.js' } };
  await fs.writeFile(join(source, 'package.json'), JSON.stringify(pkg));
  await fs.writeFile(join(source, 'src/cli.js'), '// fixture');
  const io = { ...f.io, pkg, run: f.deps.run, detect: async () => false, fetch: async () => { throw new Error('must stay offline'); } };
  const before = await fs.readdir(f.home, { recursive: true });
  const readonly = { ...fs };
  for (const method of ['writeFile', 'mkdir', 'rename', 'rm', 'chmod', 'copyFile', 'symlink', 'unlink']) readonly[method] = () => { throw new Error(`unexpected write: ${method}`); };
  // The kit is one row of the run ("Kit (optional)"), before the closing line.
  const kitRow = () => f.output.filter((line) => line.includes('Kit (optional)'));
  const kitInstalled = /^\s*Kit \(optional\)\s+ok\s+\S+ \(kit v1\.2\.3\)$/;
  assert.equal(await main(['install', '--from', source, '--client', 'codex', '--dry-run'], { ...io, fs: readonly }), 0);
  assert.equal(kitRow().length, 1);
  assert.match(kitRow()[0], kitInstalled);
  assert.deepEqual(await fs.readdir(f.home, { recursive: true }), before);
  f.output.length = 0;
  assert.equal(await main(['install', '--from', source, '--client', 'codex', '--no-link'], io), 0);
  assert.equal(kitRow().length, 1);
  assert.match(kitRow()[0], kitInstalled);
  const system = f.config.systems[process.platform];
  const name = renderName({ template: DEFAULT_CONFIG.release.name, values: { package: pkg.name, version: '1.0.0', client: 'codex', system, arch: f.config.architectures[process.arch], ext: DEFAULT_CONFIG.release.formats[system] } });
  const fetch = async () => Response.json({ tag_name: 'v1.0.0', assets: [{ name }, { name: 'okit-plugin-1.0.0-checksums.sha256' }] });
  for (const flags of [[], ['--dry-run']]) {
    f.output.length = 0;
    assert.equal(await main(['update', ...flags], { ...io, fetch }), 0);
    assert.equal(kitRow().length, 1);
    assert.match(kitRow()[0], kitInstalled);
  }
  assert.equal(await main(['status'], { ...io, clients: [], orders: [] }), 0);
  assert.match(f.output.at(-1), /^kit: installed/);
});
