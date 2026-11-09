import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { renderInstallScripts, scriptDefaults, selectTarget } from '../src/release/install-scripts.js';
import * as present from '../src/install/present.js';
import * as routing from '../src/install/route.js';

// The Windows script is a launcher: Node prelude, requirement checks, a verified download and the browser wizard.
// Must pass / must refuse:
// | case | must pass | must refuse |
// | generated install.ps1 | checks, SHA-256, `--ui`/`--headless`, locale and destination forwarded | any terminal client question, setup or menu route |
// | --terminal and terminal-only options | nothing | refused in words, exit 2, before any command or download |
// | client | explicit, OKIT_CLIENT, the record, else the first installed of the configured order | none installed: exit 2, guidance naming the programs |
// | folders | writable temporary and destination | an unwritable one: exit 2 before downloading |
// | package | one unambiguous checksum line that matches | `SHA-256 mismatch: package refused`, exit 1, nothing extracted or run |
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
const WINDOWS = selectTarget(await fs.readFile('src/install/bootstrap.js', 'utf8'), 'windows');
const asset = `${pkg.name}-1.2.3-claude-code-windows-x64.zip`;
const manifestName = `${pkg.name}-1.2.3-checksums.sha256`;
const good = 'a'.repeat(64), bad = 'b'.repeat(64);

/** Runs the Windows program with injected modules: nothing is downloaded or started, every command is recorded. */
async function launcher(t, args, { found = ['claude', 'codex', 'opencode'], record = true, env = {}, source = WINDOWS, hash = good, lines = [`${good}  ${asset}`], denied = false } = {}) {
  const home = await fs.mkdtemp(join(tmpdir(), 'windows-launcher-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const active = join(home, 'active'), calls = [];
  if (record) await fs.writeFile(join(home, 'install.json'), JSON.stringify({ path: active, client: 'claude-code', version: '1.2.3' }));
  const release = { tag_name: 'v1.2.3', prerelease: false, assets: [
    ...['claude-code', 'codex', 'opencode'].map((client) => ({ name: asset.replace('claude-code', client), browser_download_url: 'https://example.invalid/asset' })),
    { name: manifestName, browser_download_url: 'https://example.invalid/manifest' }] };
  const load = new Function('imports', 'process', `${source.replaceAll('await import(', 'await imports(')}\nreturn bootstrap;`);
  const runtime = { env, stdin: {}, stdout: {}, versions: { node: '22' }, platform: 'win32', arch: 'x64', execPath: 'node', argv: ['node', ...args, '--dest', home] };
  const modules = {
    'node:fs/promises': { ...fs, constants: fs.constants,
      access: (path, mode) => (denied ? Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })) : fs.access(path, mode)),
      readFile: (path, ...rest) => {
        if (String(path).endsWith('release.json')) return Promise.resolve(JSON.stringify(release));
        if (String(path).endsWith('checksums.sha256')) return Promise.resolve(`${lines.join('\n')}\n`);
        return fs.readFile(path, ...rest);
      } },
    'node:path': { join, resolve }, 'node:os': { homedir: () => home, tmpdir: () => home },
    'node:child_process': { spawnSync: (command, values) => {
      calls.push([command, values]);
      if (command === 'where.exe') return { status: found.includes(values[0]) ? 0 : 1, stdout: '' };
      if (command === 'powershell.exe') {
        const code = Buffer.from(values.at(-1), 'base64').toString('utf16le');
        return { status: 0, stdout: code.includes('Get-FileHash') ? hash : '200' };
      }
      return { status: 0, stdout: '' };
    } },
  };
  const run = async () => { try { await load(async (name) => modules[name], runtime)(scriptDefaults(pkg), present, routing); return null; } catch (error) { return error; } };
  const commands = () => calls.map(([command, values]) => (command === 'powershell.exe' ? Buffer.from(values.at(-1), 'base64').toString('utf16le') : command));
  return { home, active, calls, runtime, run, commands };
}

// The scenarios, each returning what is wrong (so the mutation proofs can use them too).
const scenarios = {
  async terminalRefused(t, source) {
    const wrong = [];
    for (const flag of ['--terminal', '--yes', '--autostart', '--set-execution-policy', '--no-execution-policy']) {
      for (const [locale, text] of [['en', /^Refused: This option does not exist on Windows.*install\.ps1.*okit-plugin install --ui.*okit-plugin config ui/], ['pt-BR', /^Recusado: Esta opção não existe no Windows.*install\.ps1.*okit-plugin install --ui.*okit-plugin config ui/]]) { // locale:pt-BR
        const f = await launcher(t, ['install', '--client', 'claude-code', flag, '--locale', locale], { source });
        const error = await f.run();
        if (error?.code !== 2 || !text.test(error.message)) wrong.push(`${flag} ${locale}: ${error?.message ?? 'not refused'}`);
        if (f.calls.length) wrong.push(`${flag} ${locale}: ran ${f.commands().join(' | ')}`);
      }
    }
    return wrong;
  },
  async noClient(t, source) {
    const wrong = [];
    for (const [locale, text] of [['en', /Install at least one of claude, codex, opencode, then run this script again/], ['pt-BR', /Instale pelo menos um de claude, codex, opencode e rode este script de novo/]]) { // locale:pt-BR
      const f = await launcher(t, ['install', '--locale', locale], { source, found: [], record: false });
      const error = await f.run();
      if (error?.code !== 2 || !text.test(error.message)) wrong.push(`${locale}: ${error?.message ?? 'no refusal'}`);
      if (f.commands().some((command) => /Invoke-WebRequest|Expand-Archive/.test(command) || command === 'node')) wrong.push(`${locale}: went on after the refusal`);
    }
    return wrong;
  },
  async unwritable(t, source) {
    const wrong = [];
    const f = await launcher(t, ['install', '--client', 'claude-code', '--locale', 'en'], { source, denied: true, record: false });
    const error = await f.run();
    if (error?.code !== 2 || !/Cannot write to /.test(error.message)) wrong.push(error?.message ?? 'no refusal');
    if (f.commands().some((command) => /Invoke-WebRequest/.test(command))) wrong.push('downloaded before the check');
    const pt = await launcher(t, ['install', '--client', 'claude-code', '--locale', 'pt-BR'], { source, denied: true, record: false });
    if (!/Não é possível gravar em /.test((await pt.run())?.message ?? '')) wrong.push('pt-BR'); // locale:pt-BR
    return wrong;
  },
  async mismatch(t, source) {
    const wrong = [];
    for (const [locale, text] of [['en', 'SHA-256 mismatch: package refused'], ['pt-BR', 'SHA-256 diferente do esperado: pacote recusado']]) { // locale:pt-BR
      const f = await launcher(t, ['install', '--client', 'claude-code', '--locale', locale], { source, record: false, hash: bad });
      const error = await f.run();
      if (error?.code !== 1 || error.message !== text) wrong.push(`${locale}: ${error?.code} ${error?.message}`);
      if (f.commands().some((command) => /Expand-Archive/.test(command) || command === 'node')) wrong.push(`${locale}: extracted or ran a refused package`);
    }
    return wrong;
  },
  async headless(t, source) {
    const wrong = [];
    for (const [args, mode] of [[[], '--ui'], [['--ui'], '--ui'], [['--headless'], '--headless']]) {
      const f = await launcher(t, ['install', '--client', 'claude-code', '--locale', 'pt-BR', ...args], { source });
      await f.run();
      const started = f.calls.filter(([command]) => command === 'node');
      const expected = [[ 'node', [join(f.active, 'src/cli.js'), 'install', mode, '--client', 'claude-code', '--from', f.active, '--dest', f.home, '--locale', 'pt-BR'] ]];
      if (JSON.stringify(started) !== JSON.stringify(expected)) wrong.push(`${args.join(' ') || 'default'}: ${JSON.stringify(started)}`);
    }
    return wrong;
  },
};

test('the Windows script refuses --terminal and the options only the terminal installer supports, before any command', async (t) => {
  assert.deepEqual(await scenarios.terminalRefused(t, WINDOWS), []);
});

test('the Windows script picks a client without asking and says what to install when there is none', async (t) => {
  assert.deepEqual(await scenarios.noClient(t, WINDOWS), []);
  // Deterministic: the explicit client, else the first installed of the configured order (never a question).
  const f = await launcher(t, ['install', '--locale', 'en', '--dry-run'], { found: ['codex', 'opencode'], record: false });
  assert.equal(await f.run(), null);
  assert.deepEqual(f.calls.filter(([command]) => command === 'where.exe').map(([, values]) => values[0]), ['claude', 'codex'], 'claude is missing, codex is the first installed');
  const named = await launcher(t, ['install', '--client', 'opencode', '--locale', 'en', '--dry-run'], { found: [], record: false });
  assert.equal(await named.run(), null, 'an explicit client is not looked for');
});

test('the Windows script checks the temporary and destination folders before downloading', async (t) => {
  assert.deepEqual(await scenarios.unwritable(t, WINDOWS), []);
});

test('the Windows script refuses a package whose SHA-256 differs, and an ambiguous checksum list', async (t) => {
  assert.deepEqual(await scenarios.mismatch(t, WINDOWS), []);
  const twice = await launcher(t, ['install', '--client', 'claude-code'], { record: false, lines: [`${good}  ${asset}`, `${good}  ${asset}`] });
  assert.match((await twice.run()).message, /Checksum manifest missing unique package line or malformed/);
  const ok = await launcher(t, ['install', '--client', 'claude-code', '--locale', 'en'], { record: false });
  assert.equal(await ok.run(), null);
  assert.ok(ok.commands().some((command) => /Expand-Archive/.test(command)), 'a matching package is extracted');
  assert.ok(ok.calls.some(([command, values]) => command === 'node' && values.includes('--ui')), 'and the browser wizard starts');
});

test('the Windows script starts the browser wizard, `--headless` only prints the address, locale and destination are forwarded', async (t) => {
  assert.deepEqual(await scenarios.headless(t, WINDOWS), []);
});

test('the generated install.ps1 holds no terminal client question, setup or menu route; install.sh keeps them', async () => {
  const { 'install.sh': sh, 'install.ps1': ps } = await renderInstallScripts('.', pkg);
  for (const script of [sh, ps]) assert.doesNotMatch(script, /^\/\/#(if|endif)/m);
  for (const gone of ["'node:readline/promises'", 'createInterface', "t('Number: '", "t('Which client do you want to install for?'", '/dev/tty', 'routing.chooseRoute(', "'xdg-open'", "'--auto'"]) {
    assert.ok(!ps.includes(gone), `install.ps1 must not hold ${gone}`);
    assert.ok(sh.includes(gone), `install.sh keeps ${gone}`);
  }
  for (const kept of ['Invoke-WebRequest', 'Get-FileHash', 'Expand-Archive', 'SHA-256 mismatch: package refused', "'--headless'", "'--client', client, '--from'", 'Install at least one of']) assert.ok(ps.includes(kept), kept);
  assert.ok(!sh.includes('Install at least one of'));
  assert.match(ps, /Node required: https:\/\/nodejs\.org\//);
  assert.ok(!/ExecutionPolicy|-Verb RunAs|Start-Process[^\n]*-Verb/.test(ps), 'no elevation and no execution-policy bypass');
});

test('selectTarget keeps a block for its target only, drops the marker lines and refuses broken markers', () => {
  const source = 'a\n//#if unix\nu\n//#endif\n//#if windows\nw\n//#endif\nz';
  assert.equal(selectTarget(source, 'unix'), 'a\nu\nz');
  assert.equal(selectTarget(source, 'windows'), 'a\nw\nz');
  assert.throws(() => selectTarget('//#if unix\nx', 'unix'), /without \/\/#endif/);
  assert.throws(() => selectTarget('x\n//#endif', 'unix'), /without \/\/#if/);
  assert.throws(() => selectTarget('//#if unix\n//#if windows\n//#endif', 'unix'), /nested/);
});

test('the route text of the Windows refusal says the browser wizard in both languages', () => {
  assert.match(routing.routeReason('en', 'windows'), /does not exist on Windows.*browser wizard.*--headless/);
  assert.match(routing.routeReason('pt-BR', 'windows'), /não existe no Windows.*assistente no navegador.*--headless/); // locale:pt-BR
});

// Each new refusal is proved by a mutation: break the source, and its scenario must report something wrong.
test('mutation proof: every new Windows refusal and the launch mode are caught when the source is broken', async (t) => {
  const mutants = [
    ['terminal options are not refused', 'terminalRefused', ['if (terminalOnly) fail(', 'if (false) fail(']],
    ['--terminal is not in the refused list', 'terminalRefused', ["const terminalOnly = ['--terminal', ", "const terminalOnly = ["]],
    ['no client is not refused', 'noClient', ["if (!client) {\n      const executables", "if (false) {\n      const executables"]],
    ['an unwritable folder is not refused', 'unwritable', ['catch { fail(t(`Cannot write', 'catch { void (t(`Cannot write']],
    ['a SHA-256 mismatch is not refused', 'mismatch', ['if (hash !== matches[0][1]) fail(', 'if (false) fail(']],
    ['--headless starts the browser', 'headless', ["flags['--headless'] ? '--headless' : '--ui'", "'--ui'"]],
  ];
  for (const [name, scenario, [from, to]] of mutants) {
    assert.ok(WINDOWS.includes(from), `${name}: the mutation does not apply`);
    assert.deepEqual(await scenarios[scenario](t, WINDOWS), [], `${name}: the unbroken source passes`);
    assert.notDeepEqual(await scenarios[scenario](t, WINDOWS.replace(from, to)), [], `${name}: the scenario must fail`);
  }
});
