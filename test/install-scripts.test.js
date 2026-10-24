import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tarGz } from '../src/release/archive.js';
import { scriptDefaults, renderInstallScripts } from '../src/release/install-scripts.js';
import { DEFAULT_CONFIG } from '../src/profiles.js';
const exec = promisify(execFile);
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));

async function fixture(t) {
  const home = await fs.mkdtemp(join(tmpdir(), 'bootstrap-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const temporary = join(home, 'tmp'), bin = join(home, 'bin'), dest = join(home, 'dest');
  await fs.mkdir(temporary); await fs.mkdir(bin);
  await fs.writeFile(join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const state = { bad: false, missing: false, pre: false, requests: [] };
  const name = `${pkg.name}-1.2.3-claude-code-linux-x64.tar.gz`;
  const cli = `const fs=require('fs'),p=require('path');const a=process.argv.slice(2);const get=k=>a[a.indexOf(k)+1];const dest=get('--dest')||process.env.OKIT_DEST;console.log('delegated '+a[0]);if(a[0]==='install'){fs.mkdirSync(dest,{recursive:true});const target=p.join(dest,'active');const from=get('--from');if(from&&p.resolve(from)===p.resolve(target))console.log('up to date');else fs.cpSync(from,target,{recursive:true});fs.writeFileSync(p.join(dest,'install.json'),JSON.stringify({path:target,version:'1.2.3',client:'claude-code'}));}if(a[0]==='uninstall')fs.rmSync(dest,{recursive:true,force:true});`;
  const bytes = tarGz([{ path: 'package.json', mode: 0o644, data: JSON.stringify({ name: pkg.name, version: '1.2.3' }) }, { path: 'src/cli.js', mode: 0o755, data: cli }]);
  let base;
  const release = () => ({ tag_name: 'v1.2.3', prerelease: state.pre, published_at: '2026-10-24', assets: [
    { name, browser_download_url: `${base}/package` },
    { name: `${pkg.name}-1.2.3-checksums.sha256`, browser_download_url: `${base}/manifest` },
  ] });
  const server = createServer((req, res) => {
    state.requests.push(req.url);
    if (req.url.endsWith('/latest')) { res.statusCode = state.pre ? 404 : 200; res.end(JSON.stringify(release())); }
    else if (req.url.endsWith('/releases')) res.end(JSON.stringify([release()]));
    else if (req.url === '/package') res.end(bytes);
    else if (req.url === '/manifest') res.end(`${state.bad ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex')}  ${state.missing ? 'absent' : name}\n`);
    else { res.statusCode = 404; res.end(); }
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    t.skip(`not run in sandbox: ${error.message}`); return null;
  }
  t.after(() => new Promise((resolve) => server.close(resolve)));
  base = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, HOME: home, OKWORK_HOME: join(home, 'state'), TMPDIR: temporary, OKIT_DEST: dest,
    OKIT_API: base, OKIT_REPO: 'fake/repo', PATH: `${bin}:${process.env.PATH}` };
  const run = async (args = [], overrides = {}) => {
    try { return { ...(await exec('sh', ['install.sh', ...args], { env: { ...env, ...overrides }, timeout: 15000 })), code: 0 }; }
    catch (error) { return { ...error, code: error.code }; }
  };
  return { home, dest, temporary, bin, env, state, run };
}

// Must pass / must refuse:
// explicit client, pre-release, dry-run, repeated install, local lifecycle | pass
// non-TTY ambiguity, hash mismatch, missing manifest line, unsupported arch | refuse
test('script configuration and generated content cannot drift', async () => {
  const rendered = await renderInstallScripts('.', pkg);
  for (const [file, expected] of Object.entries(rendered)) {
    const source = await fs.readFile(file, 'utf8');
    assert.deepEqual(JSON.parse(source.match(/const defaults = (.+);/)[1]), scriptDefaults(pkg));
    assert.equal(source, expected);
  }
});

test('shellcheck and PowerShell parser when installed', async (t) => {
  for (const [tool, args] of [
    ['shellcheck', ['install.sh']],
    ['pwsh', ['-NoProfile', '-Command', "$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD 'install.ps1'),[ref]$tokens,[ref]$errors) > $null; if ($errors.Count) { $errors; exit 1 }"]],
  ]) await t.test(tool, (t) => {
    const result = spawnSync(tool, args, { encoding: 'utf8' });
    if (result.error?.code === 'ENOENT') return t.skip(`${tool} unavailable; not run in sandbox`);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
  const source = await fs.readFile('install.ps1', 'utf8');
  for (const command of ['Invoke-WebRequest', 'Get-FileHash', 'Expand-Archive', 'install', 'update', 'uninstall']) assert.ok(source.includes(command));
});

test('install modules never depend on excluded release modules; documentation repo matches', async () => {
  for (const file of await fs.readdir('src/install')) {
    assert.doesNotMatch(await fs.readFile(join('src/install', file), 'utf8'), /(?:from\s*|import\s*\()['"][^'"]*release\//);
  }
  for (const file of ['INSTALL.md', 'INSTALL.pt-BR.md']) {
    const source = await fs.readFile(file, 'utf8');
    assert.ok(source.includes(`${pkg.repository.url}/releases/latest/download/install.sh`));
    assert.ok(source.includes(`${pkg.repository.url}/releases/latest/download/install.ps1`));
  }
});

test('POSIX bootstrap loopback corpus', async (t) => {
  const f = await fixture(t); if (!f) return;
  let result = await f.run();
  assert.equal(result.code, 2); assert.match(result.stderr, /Without TTY/);
  result = await f.run(['--client', 'claude-code', '--dry-run']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Release: 1.2.3/); assert.match(result.stdout, /Asset:.*tar.gz/);
  await assert.rejects(fs.stat(f.dest), { code: 'ENOENT' });
  f.state.bad = true;
  result = await f.run(['--client', 'claude-code']);
  assert.equal(result.code, 1); assert.match(result.stderr, /SHA-256 mismatch/);
  await assert.rejects(fs.stat(f.dest), { code: 'ENOENT' });
  f.state.bad = false; f.state.missing = true;
  result = await f.run(['--client', 'claude-code']);
  assert.equal(result.code, 1); assert.match(result.stderr, /manifest/);
  f.state.missing = false; f.state.pre = true;
  result = await f.run(['--client', 'claude-code']);
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /pre-release fallback/);
  result = await f.run(); assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /up to date/);
  f.state.requests.length = 0;
  for (const action of ['update', 'uninstall']) {
    result = await f.run([action]); assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, new RegExp(`delegated ${action}`));
  }
  assert.deepEqual(f.state.requests, []); assert.deepEqual(await fs.readdir(f.temporary), []);
});

test('unsupported architecture refuses before requesting a package', async (t) => {
  const f = await fixture(t); if (!f) return;
  await fs.writeFile(join(f.bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Linux;; *) echo mips;; esac\n', { mode: 0o755 });
  const result = await f.run(['--client', 'claude-code']);
  assert.equal(result.code, 2); assert.match(result.stderr, /No package.*mips/);
  assert.deepEqual(f.state.requests, []);
});
