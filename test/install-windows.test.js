import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { installConfig } from '../src/install/config.js';
import { applyLink, linkPlan, managePath } from '../src/install/link.js';
import { executionPolicyStep, judgePolicy, parsePolicies } from '../src/install/policy.js';
import { createPresenter } from '../src/install/present.js';
import { commandInPath } from '../src/env/path.js';

// Must pass / must refuse:
// | case | must pass | must refuse |
// | Windows link plan | the .cmd only | a .ps1 |
// | install, update and uninstall | remove a .ps1 this plugin wrote; uninstall removes both | deleting a .ps1 that is not ours |
// | PATH check | resolves okit-plugin.cmd | counting a lone .ps1 as the command |
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

test('the Windows link plan is the .cmd only', async (t) => {
  const f = await fixture(t);
  const plan = linkPlan(f.record, f.deps);
  assert.deepEqual(plan.map((item) => item.path), [join(f.bin, 'okit-plugin.cmd')]);
  assert.equal(plan[0].content, `@echo off\r\n"${f.config.node}" "${join(f.record.path, f.record.bin)}" %*\r\n`);
  assert.deepEqual(linkPlan(f.record, { ...f.deps, platform: 'linux' }).map((item) => item.path), [join(f.bin, 'okit-plugin')]);
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
