import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import { installConfig } from '../src/install/config.js';
import { applyLink, linkPlan, managePath, pluginExecutable, quote, shellShim } from '../src/install/link.js';
import { collectorCommandIndex, commandWords, planStatusline } from '../src/install/statusline.js';
import { DEFAULT_CONFIG } from '../src/profiles.js';
import { executionPolicyStep, judgePolicy, parsePolicies } from '../src/install/policy.js';
import { createPresenter } from '../src/install/present.js';
import { commandInPath } from '../src/env/path.js';

// Must pass / must refuse:
// | case | must pass | must refuse |
// | Windows link plan | the .cmd (cmd, PowerShell) and the extensionless LF shim (Git Bash) | a .ps1; a CR in the shim |
// | install, update and uninstall | write both; replace our old ones; remove a .ps1 this plugin wrote; uninstall removes all | touching a file of either name that is not ours |
// | PATH check | resolves okit-plugin.cmd | counting a lone .ps1 or a lone extensionless shim as the command |
// | the shim | runs under bash with and without cygpath; is recognised as ours | a shell that interprets a quote or a space in a path |
// | statusLine on Windows | the absolute shim path, runs from Git Bash with system PATH; the old bare form is rewritten once | a bare name; a second rewrite |
// | execution policy | asks only when scripts are blocked, and applies only on a yes or the flag | asking when allowed, under a group policy or without a TTY |

async function fixture(t) {
  const home = await fs.mkdtemp(join(tmpdir(), 'windows-shim-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const destination = join(home, 'data'), bin = join(home, 'bin');
  await fs.mkdir(bin);
  const config = installConfig({ repository: 'example/project', api: 'https://fake.invalid', destination, linkDirectory: bin });
  const output = [];
  const deps = { fs, home, destination, bin, config, env: { HOME: home, PATH: '' }, platform: 'win32', temporary: home,
    out: (line) => output.push(line), pathExecute: async () => ({ stdout: 'true\n' }) };
  const record = { path: join(home, 'plugin'), bin: 'src/cli.js', client: 'claude-code' };
  const script = `& '${config.node}' '${join(record.path, record.bin)}' @args\n`;
  return { home, destination, bin, config, deps, output, record, script };
}

test('the Windows link plan is the .cmd and the Git Bash shim', async (t) => {
  const f = await fixture(t);
  const plan = linkPlan(f.record, f.deps);
  assert.deepEqual(plan.map((item) => item.path), [join(f.bin, 'okit-plugin.cmd'), join(f.bin, 'okit-plugin')]);
  assert.equal(plan[0].content, `@echo off\r\n"${f.config.node}" "${join(f.record.path, f.record.bin)}" %*\r\n`);
  assert.deepEqual(linkPlan(f.record, { ...f.deps, platform: 'linux' }), [{ path: join(f.bin, 'okit-plugin'), target: join(f.record.path, f.record.bin) }]);
  assert.deepEqual(linkPlan(f.record, { ...f.deps, platform: 'darwin' }).map((item) => item.path), [join(f.bin, 'okit-plugin')]);
});

test('every Windows shim without an extension is LF only, and a path cannot break out of its quotes', async (t) => {
  const f = await fixture(t);
  for (const node of [f.config.node, "C:\\Program Files\\o'neil $(touch x)`id`\\node.exe"]) {
    const config = { ...f.config, node };
    const plan = linkPlan(f.record, { ...f.deps, config });
    const bare = plan.filter((item) => !/\.[^\\/]+$/.test(item.path));
    assert.equal(bare.length, 1);
    for (const item of bare) {
      assert.doesNotMatch(item.content, /\r/, item.path);
      assert.ok(item.content.startsWith('#!/bin/sh\n') && item.content.endsWith('\n'));
    }
    assert.match(plan[0].content, /\r\n/, 'the .cmd keeps its CRLF');
  }
  for (const bad of ['a\rb', 'a\nb', 'a"b', 'a%b']) {
    assert.throws(() => linkPlan(f.record, { ...f.deps, config: { ...f.config, node: bad } }), /Unsupported shim path/);
    assert.throws(() => linkPlan({ ...f.record, path: bad }, f.deps), /Unsupported shim path/);
  }
});

test('install and update write the .cmd and remove a .ps1 this plugin wrote earlier', async (t) => {
  for (const previous of [null, 'previous']) {
    const f = await fixture(t);
    const old = { ...f.record, path: join(f.home, 'older') };
    const earlier = `& '${f.config.node}' '${join(old.path, old.bin)}' @args\n`;
    await fs.writeFile(join(f.bin, 'okit-plugin.ps1'), previous ? earlier : f.script);
    await applyLink(f.record, f.deps, previous ? old : null);
    assert.equal(await fs.stat(join(f.bin, 'okit-plugin.ps1')).catch(() => null), null, 'our .ps1 is gone');
    assert.match(await fs.readFile(join(f.bin, 'okit-plugin.cmd'), 'utf8'), /^@echo off\r\n/);
  }
});

test('a .ps1 that is not ours is never removed', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(join(f.bin, 'okit-plugin.ps1'), 'Write-Host "someone else"\n');
  await applyLink(f.record, f.deps);
  assert.equal(await fs.readFile(join(f.bin, 'okit-plugin.ps1'), 'utf8'), 'Write-Host "someone else"\n');
  assert.ok(await fs.stat(join(f.bin, 'okit-plugin.cmd')));
  await applyLink(f.record, f.deps, null, true);
  assert.equal(await fs.readFile(join(f.bin, 'okit-plugin.ps1'), 'utf8'), 'Write-Host "someone else"\n');
  assert.equal(await fs.stat(join(f.bin, 'okit-plugin.cmd')).catch(() => null), null, 'the .cmd goes on uninstall');
});

test('uninstall removes both the .cmd and an own .ps1', async (t) => {
  const f = await fixture(t);
  await applyLink(f.record, f.deps);
  await fs.writeFile(join(f.bin, 'okit-plugin.ps1'), f.script);
  await applyLink(f.record, f.deps, null, true);
  assert.deepEqual(await fs.readdir(f.bin), []);
});

test('the PATH check resolves okit-plugin.cmd, and a lone .ps1 is not the command', async (t) => {
  const f = await fixture(t);
  await applyLink(f.record, f.deps);
  const result = await managePath(f.deps);
  assert.equal(result.resolved, join(f.bin, 'okit-plugin.cmd'));
  await fs.rm(join(f.bin, 'okit-plugin.cmd'));
  await fs.writeFile(join(f.bin, 'okit-plugin.ps1'), f.script);
  assert.equal(await commandInPath({ fs, config: f.config, windows: true, path: f.bin, separator: ';' }), undefined);
});

const COMMANDS = (f) => [`${f.config.command}.cmd`, f.config.command];

test('both Windows shims follow the same ownership: a foreign file stays, our old one is replaced, uninstall removes it', async (t) => {
  for (const name of COMMANDS(await fixture(t))) {
    // A file of the person's own stays, with a warning, and the other shim is still written.
    const foreign = await fixture(t);
    const warnings = [];
    await fs.writeFile(join(foreign.bin, name), 'someone else\n');
    await applyLink(foreign.record, { ...foreign.deps, out: (line) => warnings.push(line) });
    assert.equal(await fs.readFile(join(foreign.bin, name), 'utf8'), 'someone else\n', `${name} kept`);
    assert.deepEqual((await fs.readdir(foreign.bin)).sort(), COMMANDS(foreign).sort());
    assert.ok(warnings.join('\n').includes(join(foreign.bin, name)), `${name} said`);
    const conflict = await applyLink(foreign.record, foreign.deps);
    assert.equal(conflict.how, 'conflict');
    assert.equal(conflict.where, join(foreign.bin, name));
    await applyLink(foreign.record, foreign.deps, null, true);
    assert.equal(await fs.readFile(join(foreign.bin, name), 'utf8'), 'someone else\n', `${name} kept on uninstall`);
    assert.equal((await fs.readdir(foreign.bin)).length, 1);

    // Our old content (the previous record) is replaced; uninstall removes it.
    const f = await fixture(t);
    const old = { ...f.record, path: join(f.home, 'older') };
    const oldItem = linkPlan(old, f.deps).find((item) => item.path === join(f.bin, name));
    await fs.writeFile(oldItem.path, oldItem.content);
    await applyLink(f.record, f.deps, old);
    const fresh = linkPlan(f.record, f.deps).find((item) => item.path === join(f.bin, name));
    assert.equal(await fs.readFile(fresh.path, 'utf8'), fresh.content, `${name} replaced`);
    await applyLink(f.record, f.deps, null, true);
    assert.deepEqual(await fs.readdir(f.bin), [], `${name} removed`);
  }
});

test('the legacy command gets both shims too, and an own old one is removed while a foreign one stays', async (t) => {
  const f = await fixture(t);
  const config = installConfig({ repository: 'example/project', api: 'https://fake.invalid', destination: f.destination, linkDirectory: f.bin, legacyCommands: ['okit'] });
  const deps = { ...f.deps, config };
  const legacy = { ...deps, config: { ...config, command: 'okit' } };
  for (const item of linkPlan(f.record, legacy)) await fs.writeFile(item.path, item.content);
  await applyLink(f.record, deps);
  assert.deepEqual((await fs.readdir(f.bin)).sort(), ['okit-plugin', 'okit-plugin.cmd']);
  for (const name of ['okit.cmd', 'okit']) {
    const g = await fixture(t);
    const gdeps = { ...g.deps, config: installConfig({ repository: 'example/project', api: 'https://fake.invalid', destination: g.destination, linkDirectory: g.bin, legacyCommands: ['okit'] }) };
    await fs.writeFile(join(g.bin, name), 'someone else\n');
    await applyLink(g.record, gdeps);
    assert.equal(await fs.readFile(join(g.bin, name), 'utf8'), 'someone else\n', `${name} kept`);
  }
});

test('the extensionless shim is recognised as ours, and no other file is', async (t) => {
  const f = await fixture(t);
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  await fs.mkdir(join(f.record.path, 'src'), { recursive: true });
  await fs.writeFile(join(f.record.path, 'package.json'), JSON.stringify({ name: pkg.name, bin: { [f.config.command]: f.record.bin } }));
  await fs.writeFile(join(f.record.path, f.record.bin), '');
  await applyLink(f.record, f.deps);
  assert.equal(await pluginExecutable(join(f.bin, 'okit-plugin'), f.deps), true);
  assert.equal(await pluginExecutable(join(f.bin, 'okit-plugin.cmd'), f.deps), true);
  const [, node, target] = linkPlan(f.record, f.deps)[1].content.split('\n');
  for (const [name, content] of [['edited', `#!/bin/sh\n${node}\n${target}\necho changed\n`], ['script', '#!/bin/sh\necho hi\n'], ['big', shellShim('n'.repeat(5000), join(f.record.path, f.record.bin))]]) {
    await fs.writeFile(join(f.home, name), content);
    assert.equal(await pluginExecutable(join(f.home, name), f.deps), false, name);
  }
  assert.equal(await pluginExecutable(join(f.home, 'missing'), f.deps), false);
});

test('the PATH check: a lone extensionless shim is not the Windows command, the .cmd is', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(join(f.bin, 'okit-plugin'), linkPlan(f.record, f.deps)[1].content);
  assert.equal(await commandInPath({ fs, config: f.config, windows: true, path: f.bin, separator: ';' }), undefined);
  await applyLink(f.record, f.deps);
  assert.equal((await managePath(f.deps)).resolved, join(f.bin, 'okit-plugin.cmd'));
});

// The shim under bash with a fake node.
async function shimFixture(t, { spaces = false } = {}) {
  const f = await fixture(t);
  const tools = join(f.home, spaces ? "fake tools 'quoted'" : 'tools');
  await fs.mkdir(tools, { recursive: true });
  const log = join(f.home, 'log');
  const node = join(tools, 'node');
  await fs.writeFile(node, `#!/bin/sh\nprintf '%s\\n' "$@" > ${quote(log)}\ncat > ${quote(`${log}.stdin`)}\n`, { mode: 0o755 });
  const cli = join(tools, 'cli.js');
  await fs.writeFile(cli, '');
  const config = { ...f.config, node };
  const record = { ...f.record, path: tools, bin: 'cli.js' };
  return { ...f, config, record, tools, node, cli, log, deps: { ...f.deps, config } };
}
const bash = (args, options) => spawnSync('bash', args, { encoding: 'utf8', ...options });

test('the shim runs under bash with a fake node, with and without cygpath', async (t) => {
  for (const spaces of [false, true]) {
    const f = await shimFixture(t, { spaces });
    const shim = join(f.home, 'shim');
    await fs.writeFile(shim, linkPlan(f.record, f.deps)[1].content);
    const clean = { PATH: '/usr/bin:/bin' };
    const result = bash([shim, 'a', 'b c'], { env: clean });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await fs.readFile(f.log, 'utf8'), `${f.cli}\na\nb c\n`, 'no cygpath');
    await fs.rm(f.log);

    // A fake cygpath earlier in PATH turns the Windows paths of the configuration into the real ones.
    const winNode = 'C:\\Users\\me\\node.exe', winCli = join('C:\\Users\\me\\plugin', 'cli.js');
    const win = { ...f.deps, config: { ...f.config, node: winNode }, };
    const mapped = linkPlan({ ...f.record, path: 'C:\\Users\\me\\plugin', bin: 'cli.js' }, win)[1].content;
    const converter = join(f.home, 'converter');
    await fs.mkdir(converter);
    await fs.writeFile(join(converter, 'cygpath'), `#!/bin/sh\n[ "$1" = -u ] || exit 9\ncase "$2" in\n  ${quote(winNode)}) printf '%s\\n' ${quote(f.node)} ;;\n  ${quote(winCli)}) printf '%s\\n' ${quote(f.cli)} ;;\n  *) exit 8 ;;\nesac\n`, { mode: 0o755 });
    await fs.writeFile(shim, mapped);
    const converted = bash([shim, 'x'], { env: { PATH: `${converter}:/usr/bin:/bin` } });
    assert.equal(converted.status, 0, converted.stderr);
    assert.equal(await fs.readFile(f.log, 'utf8'), `${f.cli}\nx\n`, 'cygpath present');
    // Without cygpath the same Windows paths are used as given, so the fake node cannot be found.
    assert.notEqual(bash([shim, 'x'], { env: clean }).status, 0);
  }
});

test('statusLine command runs from Git Bash', async (t) => {
  const f = await fixture(t);
  const root = fileURLToPath(new URL('..', import.meta.url));
  const config = { ...f.config, node: process.execPath };
  const record = { ...f.record, path: root, bin: 'src/cli.js' };
  const deps = { ...f.deps, config };
  await fs.writeFile(join(f.bin, 'okit-plugin'), linkPlan(record, deps)[1].content, { mode: 0o755 });
  const settings = join(f.home, 'claude', 'settings.json');
  await fs.mkdir(join(f.home, 'claude'));
  const plan = await planStatusline({ client: 'claude-code', path: settings }, { ...deps, statuslineConfig: DEFAULT_CONFIG.statuslineRegistration });
  const command = JSON.parse(plan.bytes).statusLine.command;
  assert.ok(command.startsWith(`'${join(f.bin, 'okit-plugin').replaceAll('\\', '/')}' 'statusline-collector'`), command);
  const state = join(f.home, 'state');
  const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 25, resets_at: Date.now() / 1000 + 3600 } } });
  const result = bash(['-c', command], { input, env: { PATH: '/usr/bin:/bin', OKWORK_HOME: state } });
  assert.equal(result.status, 0, result.stderr);
  const reading = JSON.parse(await fs.readFile(join(state, 'quota', 'claude-code.json'), 'utf8'));
  assert.equal(reading.remainingPct, 75);
});

test('on Windows the statusLine names the shim, rewrites an owned bare command once and keeps --previous', async (t) => {
  const f = await fixture(t);
  const settings = DEFAULT_CONFIG.statuslineRegistration;
  const path = join(f.home, 'settings.json');
  const shim = join(f.bin, 'okit-plugin').replaceAll('\\', '/');
  const deps = { ...f.deps, statuslineConfig: settings };
  const write = (command) => fs.writeFile(path, JSON.stringify({ statusLine: { type: 'command', command } }));
  for (const previous of ['', " '--previous' 'echo' 'hello world'"]) {
    await write(`'okit-plugin' 'statusline-collector'${previous}`);
    const plan = await planStatusline({ client: 'claude-code', path, statusline: { path } }, deps);
    const rewritten = JSON.parse(plan.bytes).statusLine.command;
    assert.equal(rewritten, `'${shim}' 'statusline-collector'${previous}`);
    assert.deepEqual(commandWords(rewritten).slice(2), commandWords(`x y${previous}`).slice(2));
    await fs.writeFile(path, plan.bytes);
    assert.equal(await planStatusline({ client: 'claude-code', path, statusline: { path } }, deps), null, 'idempotent');
  }
  // A command that is not ours is wrapped, naming the shim; other platforms keep the bare name.
  await write('echo hi');
  const wrapped = JSON.parse((await planStatusline({ client: 'claude-code', statusline: { path } }, deps)).bytes).statusLine.command;
  assert.equal(wrapped, `'${shim}' 'statusline-collector' '--previous' 'echo' 'hi'`);
  for (const platform of ['linux', 'darwin']) {
    const plain = JSON.parse((await planStatusline({ client: 'claude-code', statusline: { path } }, { ...deps, platform })).bytes).statusLine.command;
    assert.equal(plain, "'okit-plugin' 'statusline-collector' '--previous' 'echo' 'hi'");
  }
});

test('collectorCommandIndex recognises the old and the new form of the collector, and not a mention in another bar', () => {
  const settings = DEFAULT_CONFIG.statuslineRegistration;
  const config = installConfig({});
  const index = (command) => collectorCommandIndex(command, settings, config);
  for (const command of ["'okit-plugin' 'statusline-collector'", 'okit-plugin statusline-collector',
    "'C:/Users/me/AppData/Local/bin/okit-plugin' 'statusline-collector'",
    '"C:/Users/me/AppData/Local/bin/okit-plugin" statusline-collector',
    "'C:/Users/me/AppData/Local/bin/okit-plugin' 'statusline-collector' '--previous' 'echo' 'hi'",
    '"C:\\Users\\me\\AppData\\Local\\bin\\okit-plugin" statusline-collector --previous echo hi',
    "'C:/Users/me/AppData/Local/bin/okit-plugin.cmd' 'statusline-collector'"]) {
    assert.ok(index(command) > 0, command);
  }
  for (const command of ["echo 'C:/bin/okit-plugin' statusline-collector", "'/usr/bin/other' '--previous' 'okit-plugin' 'statusline-collector'",
    "'C:/bin/okit-plugin' 'statusline-collector' '--typo'"]) {
    assert.equal(index(command), -1, command);
  }
});


// The execution policy.
const LIST = (local, extra = {}) => ['MachinePolicy', 'UserPolicy', 'Process', 'CurrentUser', 'LocalMachine']
  .map((scope) => `${scope}=${extra[scope] ?? (scope === 'LocalMachine' ? local : 'Undefined')}`).join('\r\n') + '\r\n';
const SET = 'Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned';

function policyRun({ list, tty = true, answer = 'n', locale = 'en', platform = 'win32', dryRun = false, fail = false, flags = {} }) {
  const lines = [], calls = [], questions = [];
  const ui = createPresenter({ locale, write: (line) => lines.push(line) });
  const deps = { config: installConfig({}), platform, tty, dryRun, env: {},
    read: async (question) => { questions.push({ question, before: lines.length }); return answer; },
    policyExecute: async (executable, args) => {
      const command = args.at(-1);
      calls.push(command);
      if (command.startsWith('Set-ExecutionPolicy')) { if (fail) throw new Error('denied'); return { stdout: '' }; }
      return { stdout: list };
    } };
  return { lines, calls, questions, run: () => executionPolicyStep(ui, flags, deps) };
}
const sets = (calls) => calls.filter((call) => call.startsWith('Set-ExecutionPolicy'));

test('the policy parser and judge: blocked, allowed and group', () => {
  assert.deepEqual(parsePolicies('Process=Undefined\r\nLocalMachine=Restricted\r\nnoise\r\n'), [['Process', 'Undefined'], ['LocalMachine', 'Restricted']]);
  for (const blocked of ['Restricted', 'AllSigned', 'Undefined']) {
    const judged = judgePolicy(parsePolicies(LIST(blocked)));
    assert.equal(judged.blocked, true, blocked);
    assert.equal(judged.group, false);
  }
  for (const allowed of ['RemoteSigned', 'Unrestricted', 'Bypass']) assert.equal(judgePolicy(parsePolicies(LIST(allowed))).blocked, false, allowed);
  assert.equal(judgePolicy(parsePolicies(LIST('Restricted', { Process: 'Bypass' }))).blocked, false, 'a narrower scope wins');
  assert.deepEqual(judgePolicy(parsePolicies(LIST('Restricted', { MachinePolicy: 'AllSigned' }))), { effective: 'AllSigned', blocked: true, group: true });
});

test('blocked policy: explains first, asks last, and a no changes nothing', async () => {
  const r = policyRun({ list: LIST('Restricted'), answer: '' });
  await r.run();
  assert.equal(r.questions.length, 1);
  assert.equal(r.questions[0].question, 'Allow PowerShell scripts for your user? [y/N] ');
  const before = r.lines.slice(0, r.questions[0].before).join('\n');
  assert.match(before, /RemoteSigned/);
  assert.match(before, /To undo: Set-ExecutionPolicy -Scope CurrentUser Undefined/);
  assert.deepEqual(sets(r.calls), []);
  assert.match(r.lines.at(-1), new RegExp(`^\\s+PowerShell scripts\\s+skipped\\s+not changed\\. To allow later: ${SET}$`));
});

test('blocked policy: y and s apply it for the current user only', async () => {
  for (const [locale, answer] of [['en', 'y'], ['en', 's'], ['pt-BR', 'y'], ['pt-BR', 's']]) {
    const r = policyRun({ list: LIST('AllSigned'), answer, locale });
    await r.run();
    assert.deepEqual(sets(r.calls), [`${SET} -Force`], `${locale} ${answer}`);
    assert.match(r.lines.at(-1), locale === 'en' ? /PowerShell scripts\s+ok\s+allowed for your user \(RemoteSigned\)$/ : /Scripts do PowerShell\s+ok\s+permitidos para o seu usuário \(RemoteSigned\)$/);
  }
  const pt = policyRun({ list: LIST('Restricted'), answer: 'n', locale: 'pt-BR' });
  await pt.run();
  assert.equal(pt.questions[0].question, 'Permitir scripts do PowerShell para o seu usuário? [s/N] ');
});

test('an allowed policy prints nothing and asks nothing', async () => {
  const r = policyRun({ list: LIST('RemoteSigned') });
  await r.run();
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.questions, []);
  assert.deepEqual(sets(r.calls), []);
});

test('a group policy is left alone and said so', async () => {
  const r = policyRun({ list: LIST('Restricted', { UserPolicy: 'AllSigned' }), flags: { 'set-execution-policy': true } });
  await r.run();
  assert.deepEqual(r.questions, []);
  assert.deepEqual(sets(r.calls), []);
  assert.match(r.lines.at(-1), /PowerShell scripts\s+skipped\s+blocked by a group policy, so it was left alone$/);
});

test('--set-execution-policy applies without asking, with or without a terminal', async () => {
  for (const tty of [true, false]) {
    const r = policyRun({ list: LIST('Restricted'), tty, flags: { 'set-execution-policy': true } });
    await r.run();
    assert.deepEqual(r.questions, []);
    assert.deepEqual(sets(r.calls), [`${SET} -Force`]);
    assert.match(r.lines.at(-1), /PowerShell scripts\s+ok\s+allowed for your user/);
  }
});

test('--set-execution-policy on an allowed policy changes nothing', async () => {
  const r = policyRun({ list: LIST('Bypass'), flags: { 'set-execution-policy': true } });
  await r.run();
  assert.deepEqual(sets(r.calls), []);
  assert.deepEqual(r.lines, []);
});

test('--no-execution-policy does not even look', async () => {
  const r = policyRun({ list: LIST('Restricted'), flags: { 'no-execution-policy': true } });
  await r.run();
  assert.deepEqual(r.calls, []);
  assert.deepEqual(r.lines, []);
});

test('without a terminal it never asks, and says how to allow it', async () => {
  const r = policyRun({ list: LIST('Restricted'), tty: false });
  await r.run();
  assert.deepEqual(r.questions, []);
  assert.deepEqual(sets(r.calls), []);
  assert.match(r.lines.at(-1), new RegExp(`PowerShell scripts\\s+skipped\\s+blocked\\. To allow: ${SET}$`));
});

test('a failed change is reported as a skipped row, not an error', async () => {
  const r = policyRun({ list: LIST('Restricted'), flags: { 'set-execution-policy': true }, fail: true });
  await r.run();
  assert.match(r.lines.at(-1), /PowerShell scripts\s+skipped\s+could not change it: denied$/);
});

test('it does nothing outside Windows and on a dry run', async () => {
  for (const options of [{ platform: 'linux' }, { platform: 'darwin' }, { dryRun: true }]) {
    const r = policyRun({ list: LIST('Restricted'), flags: { 'set-execution-policy': true }, ...options });
    await r.run();
    assert.deepEqual(r.calls, [], JSON.stringify(options));
    assert.deepEqual(r.lines, []);
  }
});

test('the two policy flags cannot be combined and are refused on uninstall', async (t) => {
  const f = await fixture(t);
  const output = [];
  const io = { ...f.deps, root: join(f.home, 'state'), platform: 'linux', stdout: (line) => output.push(line), stderr: (line) => output.push(line), out: (line) => output.push(line) };
  await fs.mkdir(io.root);
  assert.notEqual(await main(['install', '--set-execution-policy', '--no-execution-policy'], io), 0);
  assert.ok(output.some((line) => /cannot be combined/.test(line)), output.join('\n'));
  output.length = 0;
  assert.notEqual(await main(['uninstall', '--set-execution-policy'], io), 0);
  assert.ok(output.some((line) => /Unknown flag: --set-execution-policy/.test(line)), output.join('\n'));
});
