import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { tarGz } from '../src/release/archive.js';
import { scriptDefaults, renderInstallScripts } from '../src/release/install-scripts.js';
import * as present from '../src/install/present.js';
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
  const cli = `const fs=require('fs'),p=require('path');const a=process.argv.slice(2);const get=k=>a[a.indexOf(k)+1];const dest=get('--dest')||process.env.OKIT_DEST;console.log('delegated '+a.join(' '));if(a[0]==='install'){fs.mkdirSync(dest,{recursive:true});const target=p.join(dest,'active');const from=get('--from');if(from&&p.resolve(from)===p.resolve(target))console.log('up to date');else fs.cpSync(from,target,{recursive:true});fs.writeFileSync(p.join(dest,'install.json'),JSON.stringify({path:target,version:'1.2.3',client:'claude-code'}));}if(a[0]==='uninstall')fs.rmSync(dest,{recursive:true,force:true});`;
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
// update policy flags | forward each flag | reject it before reaching the CLI
// same-version reinstall | forward each policy flag | silently drop the flag
// early errors | explicit or environment language | English for --locale pt-BR
async function bootstrapRuntime(t, args, { env = {}, release, status = '200' } = {}) {
  const home = await fs.mkdtemp(join(tmpdir(), 'bootstrap-runtime-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const active = join(home, 'active'), calls = [];
  await fs.writeFile(join(home, 'install.json'), JSON.stringify({ path: active, client: 'claude-code', version: '1.2.3' }));
  const source = await fs.readFile('src/install/bootstrap.js', 'utf8');
  const load = new Function('imports', 'process', `${source.replaceAll('await import(', 'await imports(')}\nreturn bootstrap;`);
  const runtime = { env, versions: { node: '22' }, platform: 'win32', arch: 'x64', execPath: 'node',
    argv: ['node', ...args, '--dest', home] };
  const modules = { 'node:fs/promises': { ...fs, readFile: (path, ...options) =>
    release && path.endsWith('release.json') ? Promise.resolve(JSON.stringify(release)) : fs.readFile(path, ...options) },
  'node:path': { join, resolve }, 'node:os': { homedir: () => home, tmpdir: () => home },
  'node:child_process': { spawnSync: (...values) => {
    calls.push(values);
    return { status: 0, stdout: values[0] === 'powershell.exe' ? status : '' };
  } } };
  return { home, active, calls, runtime, run: () => load(async (name) => modules[name], runtime)(scriptDefaults(pkg), present) };
}

for (const flag of ['--set-execution-policy', '--no-execution-policy']) {
  test(`bootstrap update forwards ${flag}`, async (t) => {
    const home = await fs.mkdtemp(join(tmpdir(), 'bootstrap-forward-'));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    const active = join(home, 'active');
    await fs.writeFile(join(home, 'install.json'), JSON.stringify({ path: active, client: 'claude-code' }));
    const source = await fs.readFile('src/install/bootstrap.js', 'utf8');
    // Execute the actual bootstrap with injected modules, without shell or network.
    const load = new Function('imports', 'process', `${source.replaceAll('await import(', 'await imports(')}\nreturn bootstrap;`);
    for (const locale of ['en', 'pt-BR']) {
      const calls = [];
      const runtime = { env: {}, versions: { node: '22' }, platform: 'win32', arch: 'x64', execPath: 'node',
        argv: ['node', 'update', flag, '--dest', home, '--locale', locale] };
      const modules = { 'node:fs/promises': fs, 'node:path': { join, resolve },
        'node:os': { homedir: () => home, tmpdir: () => home },
        'node:child_process': { spawnSync: (...args) => { calls.push(args); return { status: 0 }; } } };
      await load(async (name) => modules[name], runtime)(scriptDefaults(pkg), present);
      assert.deepEqual(calls, [['node', [join(active, 'src/cli.js'), 'update', flag, '--locale', locale], { stdio: 'inherit' }]]);
      assert.equal(runtime.exitCode, 0);
    }
  });
}

test('bootstrap same-version reinstall forwards each execution-policy flag', async (t) => {
  const asset = `${pkg.name}-1.2.3-claude-code-windows-x64.zip`;
  const release = { tag_name: 'v1.2.3', prerelease: false, assets: [
    { name: asset }, { name: `${pkg.name}-1.2.3-checksums.sha256` },
  ] };
  for (const locale of ['en', 'pt-BR']) {
    for (const flag of ['--set-execution-policy', '--no-execution-policy']) {
      const f = await bootstrapRuntime(t, ['install', flag, '--locale', locale], { release });
      await f.run();
      const delegated = f.calls.filter(([command]) => command === 'node');
      assert.deepEqual(delegated, [['node', [join(f.active, 'src/cli.js'), 'install',
        '--client', 'claude-code', '--from', f.active, '--dest', f.home,
        '--asset', asset, '--locale', locale, flag], { stdio: 'inherit' }]]);
      assert.equal(f.runtime.exitCode, 0);
    }
  }
});

test('bootstrap selects the refusal language before validating flags', async (t) => {
  for (const locale of ['en', 'pt-BR']) {
    for (const explicit of [true, false]) {
      const env = { OKIT_LANGUAGE: explicit ? (locale === 'en' ? 'pt-BR' : 'en') : locale };
      // Both orders matter: an unknown flag must not prevent reading --locale.
      for (const args of explicit ? [['--locale', locale, '--unknown'], ['--unknown', '--locale', locale]] : [['--unknown']]) {
        const f = await bootstrapRuntime(t, ['install', ...args], { env });
        // A refusal is told the way the installed command tells it: its head, the reason, what to do next.
        await assert.rejects(f.run(), { code: 2,
          message: locale === 'en' ? /^Refused: Unknown flag: --unknown\n +Next: / : /^Recusado: Opção desconhecida: --unknown\n +O que fazer: / });
        assert.deepEqual(f.calls, [], 'refuse before any external command');
      }
    }
  }
});

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
  assert.equal(result.code, 2); assert.match(result.stderr, /Without a terminal to ask in/);
  result = await f.run(['--client', 'claude-code', '--dry-run']);
  assert.equal(result.code, 0, result.stderr);
  // The dry run shows one step line with the asset and no Release/Asset/Destination block.
  assert.match(result.stdout, /^okit-plugin 1\.2\.3 for Claude Code \(/m);
  assert.match(result.stdout, /\[1\/5\] Download and verify\s+would\s+\S+\.tar\.gz/);
  assert.match(result.stdout, /Dry run: nothing was changed\./);
  assert.doesNotMatch(result.stdout, /Release:|Asset:|Destination:|command:/);
  result = await f.run(['--client', 'claude-code', '--dry-run', '--locale', 'pt-BR']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Baixar e verificar\s+faria\s+\S+\.tar\.gz/);
  assert.match(result.stdout, /Simulação: nada foi alterado\./);
  assert.doesNotMatch(result.stdout, /Download and verify|Dry run/);
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
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /delegated install .*--asset \S+\.tar\.gz --fallback/);
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

// Must pass / must refuse:
// | case | must pass | must refuse |
// | bootstrap --dry-run without a record | the chosen destination and the installed command's numbered steps, en and pt-BR | a one-line summary, a missing destination |
// | --locale that is not a language | one language: a valid --locale, else OKIT_LANGUAGE, else English | both languages in one message |
// | Node missing (sh and ps1) | the refusal in the language --locale or OKIT_LANGUAGE names | English for pt-BR |
test('bootstrap dry-run shows the chosen destination and the numbered steps of the installed command', async (t) => {
  for (const [locale, steps, no] of [
    ['en', ['[1/5] Download and verify', '[2/5] Install files', '[3/5] Register in Claude Code', '[4/5] Command and PATH', '[5/5] Quota recording'], 'Dry run: nothing was changed.'],
    ['pt-BR', ['[1/5] Baixar e verificar', '[2/5] Instalar arquivos', '[3/5] Registrar no Claude Code', '[4/5] Comando e PATH', '[5/5] Registro de cota'], 'Simulação: nada foi alterado.'],
  ]) {
    const home = await fs.mkdtemp(join(tmpdir(), 'bootstrap-dry-'));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    const marker = join(home, 'DEST_MARKER');
    // The scratch folder is its own, so the chosen destination is not under what the output hides.
    const scratch = join(home, 'scratch');
    await fs.mkdir(scratch);
    const release = { tag_name: 'v1.2.3', prerelease: false, assets: [
      { name: `${pkg.name}-1.2.3-claude-code-linux-x64.tar.gz` }, { name: `${pkg.name}-1.2.3-checksums.sha256` } ] };
    const source = await fs.readFile('src/install/bootstrap.js', 'utf8');
    const load = new Function('imports', 'process', `${source.replaceAll('await import(', 'await imports(')}\nreturn bootstrap;`);
    const runtime = { env: {}, versions: { node: '22' }, platform: 'linux', arch: 'x64', execPath: 'node',
      argv: ['node', 'install', '--client', 'claude-code', '--dry-run', '--dest', marker, '--locale', locale] };
    const modules = { 'node:fs/promises': { ...fs, readFile: (path, ...options) =>
      path.endsWith('release.json') ? Promise.resolve(JSON.stringify(release)) : fs.readFile(path, ...options) },
    'node:path': { join, resolve }, 'node:os': { homedir: () => home, tmpdir: () => scratch },
    'node:child_process': { spawnSync: (command, args) => ({ status: 0, stdout: command === 'uname' ? (args[0] === '-s' ? 'Linux\n' : 'x86_64\n') : command === 'curl' ? '200' : '' }) } };
    const lines = [];
    const log = console.log;
    console.log = (line) => lines.push(line);
    try { await load(async (name) => modules[name], runtime)(scriptDefaults(pkg), present); } finally { console.log = log; }
    const out = lines.join('\n');
    for (const step of steps) assert.ok(out.includes(step), `${locale}: ${step} missing in\n${out}`);
    assert.match(out, new RegExp(`\\[2/5\\] .*(would|faria)\\s+${marker}[\\\\/]1\\.2\\.3-claude-code`), `${locale}: destination\n${out}`);
    assert.ok(out.includes(no));
    assert.match(out, /^okit-plugin 1\.2\.3 (for|para) Claude Code \(Linux x64\)$/m);
  }
});

test('the installed command and the bootstrap dry-run use the same step labels', async () => {
  const installed = await fs.readFile('src/install/bootstrap.js', 'utf8');
  assert.match(installed, /ui\.sequence\(present\.planSteps\(/, 'the plan numbers the steps with the one function the run uses');
  assert.doesNotMatch(installed, /Would download, verify|Download and verify|Baixar e verificar/, 'step texts live in the presenter only');
});

test('a --locale that is not a language is refused in one language by the bootstrap', async (t) => {
  for (const [env, locale, expected] of [
    ['pt-BR', 'fr', 'Escolha um idioma: en, pt-BR.'],
    ['en', 'fr', 'Choose a language: en, pt-BR.'],
    [undefined, 'fr', 'Choose a language: en, pt-BR.'],
    ['pt-BR', 'xx', 'Escolha um idioma: en, pt-BR.'],
  ]) {
    const f = await bootstrapRuntime(t, ['install', '--locale', locale], { env: env ? { OKIT_LANGUAGE: env } : {} });
    await assert.rejects(f.run(), (error) => {
      assert.match(error.message, new RegExp(`^${expected === 'Escolha um idioma: en, pt-BR.' ? 'Recusado' : 'Refused'}: ${expected.replace(/[.]/g, '\\.')}\n`));
      assert.doesNotMatch(error.message, / \/ /);
      return error.code === 2;
    });
  }
});

test('install.sh and install.ps1 say Node is missing in the language --locale or OKIT_LANGUAGE names', async () => {
  const cases = [
    [{ OKIT_LANGUAGE: 'pt-BR' }, ['--locale', 'pt-BR'], 'pt'],
    [{ OKIT_LANGUAGE: 'pt-BR' }, [], 'pt'],
    [{}, ['--locale', 'pt-BR'], 'pt'],
    [{ OKIT_LANGUAGE: 'pt-BR' }, ['--locale', 'en'], 'en'],
    [{ OKIT_LANGUAGE: 'pt-BR' }, ['--locale', 'fr'], 'pt'],
    [{ OKIT_LANGUAGE: 'pt-BR' }, ['--locale', 'pt-BR', '--locale', 'fr'], 'pt'],
    [{ OKIT_LANGUAGE: 'en' }, ['--locale', 'fr'], 'en'],
    [{}, [], 'en'],
    [{}, ['--locale', 'fr'], 'en'],
  ];
  for (const [env, args, language] of cases) {
    const result = spawnSync('/bin/sh', ['install.sh', ...args], { encoding: 'utf8', env: { PATH: '/nonexistent', ...env } });
    assert.equal(result.status, 2, `${JSON.stringify(env)} ${args}`);
    assert.equal(result.stderr.trim(), language === 'pt' ? 'Node.js é necessário: https://nodejs.org/' : 'Node required: https://nodejs.org/', `${JSON.stringify(env)} ${args}`);
    assert.equal(result.stdout, '');
  }
  // The PowerShell wrapper has the same two messages and the same precedence (pwsh is not always installed).
  const ps = await fs.readFile('install.ps1', 'utf8');
  assert.ok(ps.includes("-ceq '--locale'") && ps.includes('$env:OKIT_LANGUAGE'));
  assert.ok(ps.includes("Write-Error 'Node required: https://nodejs.org/'"));
  assert.ok(ps.includes("'Node.js '+[char]0xE9+' necess'+[char]0xE1+'rio: https://nodejs.org/'"));
  assert.ok(ps.indexOf("Node required") < ps.indexOf('$okitBootstrap'), 'the check comes before the bootstrap');
});

test('R12-1: the bootstrap: no release and a release without the asset are failures of the work (kind operational, exit 1), in both languages', async (t) => {
  for (const locale of ['en', 'pt-BR']) {
    const none = await bootstrapRuntime(t, ['install', '--client', 'claude-code', '--locale', locale], { release: [], status: '404' });
    await assert.rejects(none.run(), (error) => {
      assert.equal(error.kind, 'operational');
      assert.equal(error.code, 1);
      assert.match(error.message, locale === 'en' ? /No published releases found/ : /Nenhuma versão publicada encontrada/);
      assert.doesNotMatch(error.message, / \/ |TypeError/);
      return true;
    });
    const bare = await bootstrapRuntime(t, ['install', '--client', 'claude-code', '--locale', locale], { release: { tag_name: 'v1.2.3', prerelease: false, assets: [] } });
    await assert.rejects(bare.run(), (error) => {
      assert.equal(error.kind, 'operational');
      assert.equal(error.code, 1);
      assert.match(error.message, locale === 'en' ? /Missing release asset/ : /Arquivo ausente na versão/);
      return true;
    });
  }
  // The script ends with the exit code of the kind of the error, never of its type.
  const scripts = await renderInstallScripts('.', pkg);
  for (const text of Object.values(scripts)) assert.ok(text.includes('present.exitCodeFor(present.kindOf(error))'));
});

// A PATH with nothing in it: what a computer without Node looks like, and the prelude must still work, so it uses
// shell built-ins only (no sed, no head, no cat).
async function pathWithoutNode(t) {
  const bin = await fs.mkdtemp(join(tmpdir(), 'prelude-bin-'));
  t.after(() => fs.rm(bin, { recursive: true, force: true }));
  return bin;
}

// The language of the one refusal the wrappers say without Node, in this order: a valid --locale, a valid OKIT_LANGUAGE,
// the language of the system (the first non-empty of LC_ALL, LC_MESSAGES, LANG: `pt` followed by the end, `_`, `-` or
// `.` is pt-BR, anything else English), then English. This is the documented exception to the installer's order (there
// is no Node, so the saved configuration is not read): neither config.json nor any other file is looked at.
const NODE = { en: 'Node required: https://nodejs.org/', 'pt-BR': 'Node.js é necessário: https://nodejs.org/' };
const validLanguage = (value) => value === 'en' || value === 'pt-BR';
const systemLanguage = (system) => {
  const chosen = [system.LC_ALL, system.LC_MESSAGES, system.LANG].find((value) => value !== undefined && value !== '') ?? '';
  return /^pt($|[_.-])/.test(chosen) ? 'pt-BR' : 'en';
};
const SYSTEMS = [
  {}, { LANG: '' }, { LANG: 'C' }, { LANG: 'POSIX' }, { LANG: 'en_US.UTF-8' },
  { LANG: 'pt_BR.UTF-8' }, { LANG: 'pt-BR' }, { LANG: 'pt' }, { LANG: 'pt.UTF-8' }, { LANG: 'pt_PT' }, { LANG: 'ptx' }, { LANG: 'PT_BR' },
  { LANG: 'en_US.UTF-8', LC_ALL: 'pt_BR.UTF-8' }, { LANG: 'pt_BR.UTF-8', LC_ALL: 'en_US.UTF-8' },
  { LANG: 'en_US.UTF-8', LC_MESSAGES: 'pt_BR.UTF-8' }, { LANG: 'pt_BR.UTF-8', LC_MESSAGES: 'C' },
  { LC_ALL: 'en_US.UTF-8', LC_MESSAGES: 'pt_BR.UTF-8', LANG: 'pt_BR.UTF-8' }, { LC_ALL: 'pt_BR.UTF-8', LC_MESSAGES: 'en_US.UTF-8', LANG: 'en_US.UTF-8' },
  { LC_ALL: '', LC_MESSAGES: 'pt_BR.UTF-8', LANG: 'en_US.UTF-8' }, { LC_ALL: '', LC_MESSAGES: '', LANG: 'pt_BR.UTF-8' },
];
test('R15-1: install.sh without Node says so in the language of the flag, then OKIT_LANGUAGE, then the system, then English', async (t) => {
  const flags = [undefined, 'en', 'pt-BR', 'fr', 'pt-br'];
  const environments = [undefined, 'en', 'pt-BR', 'fr', ''];
  const home = await fs.mkdtemp(join(tmpdir(), 'prelude-system-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  // The saved configuration, and a file called `language`, say the opposite of everything: the script must not look.
  await fs.writeFile(join(home, 'config.json'), JSON.stringify({ language: 'pt-BR' }));
  await fs.writeFile(join(home, 'language'), 'pt-BR\n');
  const bin = await pathWithoutNode(t);
  let ran = 0;
  for (const flag of flags) for (const environment of environments) for (const system of SYSTEMS) {
    const expected = validLanguage(flag) ? flag : validLanguage(environment) ? environment : systemLanguage(system);
    const result = spawnSync('/bin/sh', ['install.sh', ...(flag ? ['--locale', flag] : [])], { encoding: 'utf8',
      env: { PATH: bin, HOME: home, OKWORK_HOME: home, ...(environment !== undefined ? { OKIT_LANGUAGE: environment } : {}), ...system } });
    const label = `flag ${flag}, OKIT_LANGUAGE ${environment}, system ${JSON.stringify(system)}`;
    assert.equal(result.status, 2, label);
    assert.equal(result.stderr.trim(), NODE[expected], label);
    assert.equal(result.stdout, '', label);
    ran += 1;
  }
  assert.equal(ran, flags.length * environments.length * SYSTEMS.length);
});

test('R15-2: the language of the system in the prelude is only compared, never evaluated by the shell', async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), 'prelude-eval-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const bin = await pathWithoutNode(t);
  const marker = join(home, 'evaluated');
  for (const hostile of [`$(touch ${marker})`, `\`touch ${marker}\``, `pt_BR"; touch ${marker}; "`, `pt-BR\\"`]) {
    for (const variable of ['LC_ALL', 'LC_MESSAGES', 'LANG', 'OKIT_LANGUAGE']) {
      spawnSync('/bin/sh', ['install.sh', '--locale', hostile], { encoding: 'utf8', env: { PATH: bin, HOME: home, [variable]: hostile } });
      await assert.rejects(fs.access(marker), `${variable}=${hostile}`);
    }
  }
});

test('R15-3: the prelude of both scripts reads no configuration and no file at all', async () => {
  const sh = await fs.readFile('install.sh', 'utf8');
  const ps = await fs.readFile('install.ps1', 'utf8');
  const preludes = { 'install.sh': sh.slice(0, sh.indexOf('node -e "$(cat')), 'install.ps1': ps.slice(0, ps.indexOf('$okitBootstrap')) };
  for (const [name, prelude] of Object.entries(preludes)) {
    assert.ok(prelude.includes('Node'), `${name}: the prelude is where it was expected`);
    assert.doesNotMatch(prelude, /config\.json|OKWORK_HOME|\.okwork|\blanguage\b|ConvertFrom-Json|ReadAllText|Get-Content|Join-Path|\bsed\b|\bgrep\b|\bcat\b|< "|<"/, `${name}: no file is read`);
    assert.doesNotMatch(prelude, /Invoke-Expression|\biex\b|\beval\b/i, `${name}: nothing is evaluated`);
  }
  assert.ok(preludes['install.sh'].indexOf('okit_flag') < preludes['install.sh'].indexOf('LC_ALL') && preludes['install.sh'].includes('LC_MESSAGES') && preludes['install.sh'].includes('LANG'), 'sh: the system variables');
  const prelude = preludes['install.ps1'];
  assert.ok(prelude.includes('CurrentUICulture') && prelude.includes("'pt-BR'"), 'ps: the UI culture');
  assert.ok(prelude.indexOf('$okitFlag') < prelude.indexOf('CurrentUICulture'), 'ps: the flag is read first');
  assert.ok(prelude.indexOf("-ccontains $okitFlag") < prelude.indexOf('$okitLang = $okitSystem'), 'ps: flag, then environment, then system');
  assert.ok(prelude.includes("'Node.js '+[char]0xE9+' necess'+[char]0xE1+'rio: https://nodejs.org/'") && prelude.includes("Write-Error 'Node required: https://nodejs.org/'"));
});

// The generated install.sh, run as JavaScript with the imports injected: nothing is downloaded or installed.
async function runGenerated(t, { argv, env = {}, tmpdir: temporary }) {
  const home = await fs.mkdtemp(join(tmpdir(), 'bootstrap-redact-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const scripts = await renderInstallScripts('.', pkg);
  const js = scripts['install.sh'].split("OKIT_BOOTSTRAP'\n")[1].split('\nOKIT_BOOTSTRAP\n')[0];
  const run = new Function('imports', 'process', 'console', js.replaceAll('await import(', 'await imports(').replace('bootstrap(defaults, present).catch', 'return bootstrap(defaults, present).catch'));
  const name = `${pkg.name}-1.2.3-claude-code-linux-x64.tar.gz`;
  const secret = 'https://user:PASSWORD_SECRET@example.invalid/pkg?token=TEST_SECRET#TEST_FRAGMENT';
  const release = { tag_name: 'v1.2.3', assets: [{ name, browser_download_url: secret },
    { name: `${pkg.name}-1.2.3-checksums.sha256`, browser_download_url: 'https://example.invalid/manifest' }] };
  const modules = {
    'node:fs/promises': { ...fs, readFile: (path, ...rest) => String(path).endsWith('release.json') ? Promise.resolve(JSON.stringify(release))
      : String(path).endsWith('checksums.sha256') ? Promise.resolve(`${'a'.repeat(64)}  ${name}\n`) : fs.readFile(path, ...rest) },
    'node:path': { join, resolve },
    'node:os': { homedir: () => home, tmpdir: () => temporary ?? home },
    'node:child_process': { spawnSync: (command, args) => command === 'uname' ? { status: 0, stdout: args[0] === '-s' ? 'Linux\n' : 'x86_64\n' }
      : command === 'curl' && args.includes('-w') ? { status: 0, stdout: '200' }
      : command === 'curl' && String(args.at(-1)).includes('TEST_SECRET') ? { status: 22, stderr: `curl: (22) 403 ${secret}` }
      : { status: 0, stdout: '' } },
  };
  const lines = [];
  const runtime = { env, versions: { node: '22' }, platform: 'linux', arch: 'x64', execPath: 'node', argv: ['node', '--client', 'claude-code', '--dest', join(home, 'dest'), ...argv] };
  await run(async (module) => modules[module], runtime, { log: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) });
  return { lines, exitCode: runtime.exitCode };
}

test('the generated bootstrap hides the temporary folder in an error that is not its own', async (t) => {
  for (const locale of ['en', 'pt-BR']) {
    const base = await fs.mkdtemp(join(tmpdir(), 'bootstrap-enotdir-'));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const file = join(base, 'NOT_A_DIRECTORY');
    await fs.writeFile(file, 'x');
    // TMPDIR is a file: mkdtemp fails with ENOTDIR and the system names the path.
    const { lines, exitCode } = await runGenerated(t, { argv: ['--locale', locale], tmpdir: file });
    const text = lines.join('\n');
    assert.equal(exitCode, 1, text);
    assert.ok(!text.includes(file), `${locale}: ${text}`);
    assert.ok(text.includes('<temp>'), `${locale}: ${text}`);
  }
});

test('the generated bootstrap never prints credentials, query or fragment of an address', async (t) => {
  for (const locale of ['en', 'pt-BR']) {
    for (const verbose of [false, true]) {
      const { lines, exitCode } = await runGenerated(t, { argv: ['--locale', locale, ...(verbose ? ['--verbose'] : [])] });
      const text = lines.join('\n');
      assert.equal(exitCode, 1, text);
      assert.doesNotMatch(text, /PASSWORD_SECRET|TEST_SECRET|TEST_FRAGMENT|user:/, `${locale} ${verbose}: ${text}`);
      // The failure from the download tool is still told, with the plain address.
      assert.match(text, /403 https:\/\/example\.invalid\/pkg/, text);
      assert.equal(lines.some((line) => /GET https:\/\/example\.invalid\/pkg$/.test(line.trim())), verbose, `${locale} ${verbose}: ${text}`);
    }
  }
});
