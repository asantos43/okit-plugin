import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { installConfig } from '../src/install/config.js';
import { ensureMcp, mcpPlan, pointsAt, registerMcp } from '../src/install/mcp-register.js';
import { mcpStep, register } from '../src/install/register.js';
import { TEXTS, fill } from '../src/install/present.js';
import { fixture, mcpWorld } from './helpers/install-fixture.js';
import * as moduleAdapter from '../adapters/opencode/index.js';

// D110 step 1: the installer registers one MCP server, named `okit`, in the client it installs, through the client's
// own `mcp` commands. Only that entry is ever touched: an entry that is not ours is kept, and a failure of the
// registration is a warning, never a failure of the installation.
//
// Must pass / must refuse:
// | case | must pass | must refuse |
// | an absent entry | the add command of the client | any other entry |
// | our entry, this installation | nothing | a second add |
// | our entry, the installation it replaces | the remove and then the add | the add alone |
// | an entry that is not ours | it is kept, with a warning | the remove or the add |
// | an uninstall | the remove of our entry | the remove of an entry that is not ours |
// | a client that refuses | the install goes on | a failed installation |
// | a dry run | the plan, and nothing run | any command of the client |
//
// D110 correction round 1: the entry is ours when the client names our path, whole (a path that only holds ours as a
// part of it is not ours), a read that fails is not an absent entry (nothing is written), OpenCode is never asked,
// the installation that is already there registers its entry again, and a rollback shows the plan.
//
// D110 correction round 2: the ownership of an entry is the whole path as the client printed it (a path with spaces
// is ours, a path with a foreign word at its side is not), a runner that resolves a non-zero code failed as much as
// one that throws, nothing of the MCP step throws into the installer, and the module strategy keeps the MCP step.

const CONFIG = installConfig({});
const RECORD = { client: 'claude-code', path: join('/opt', 'okit-plugin', '1.0.0-claude-code') };
const SERVER = join(RECORD.path, 'src/mcp/server.js');
const PREVIOUS = { client: 'claude-code', path: join('/opt', 'okit-plugin', '0.9.0-claude-code') };
// An installation in a folder whose name holds a space: the path of the server holds it too.
const SPACED = join('/Users/me/Library/Application Support/okit/1.0.0');
const SPACED_SERVER = join(SPACED, 'src/mcp/server.js');

/** The dependencies of the step: the installer's settings and the runner of the client. */
const depsOf = (run, config = CONFIG) => ({ config, run, out: () => {} });

/** The client of the test: what it holds for the entry `okit` and the commands it ran. */
function fakeClient(entry) {
  const calls = [];
  const run = async (input) => {
    calls.push(input);
    if (input.args[0] === 'mcp' && input.args[1] === 'get') {
      const name = input.args[3];
      // The real clients answer that they hold no entry with this name, print it and exit with 1.
      if (!entry) throw Object.assign(new Error(`Command failed: ${input.command} mcp get ${name}`), { code: 1,
        stdout: `No MCP server named "${name}" found.\n`, stderr: '' });
      return { stdout: entry };
    }
    return {};
  };
  return { calls, run, argv: () => calls.map((call) => call.args) };
}

const argvOf = (client) => client.argv();

test('the plan of each client is the argv of its own mcp commands', () => {
  const plan = mcpPlan(RECORD, depsOf(() => {}));
  assert.deepEqual(plan.get, ['claude', 'mcp', 'get', 'okit']);
  assert.deepEqual(plan.add, ['claude', 'mcp', 'add', '--scope', 'user', 'okit', '--', CONFIG.node, SERVER]);
  assert.deepEqual(plan.remove, ['claude', 'mcp', 'remove', 'okit', '--scope', 'user']);
  const codex = mcpPlan({ ...RECORD, client: 'codex' }, depsOf(() => {}));
  assert.deepEqual(codex.get, ['codex', 'mcp', 'get', 'okit']);
  assert.deepEqual(codex.add, ['codex', 'mcp', 'add', 'okit', '--', CONFIG.node, SERVER]);
  assert.deepEqual(codex.remove, ['codex', 'mcp', 'remove', 'okit']);
  // A client with no MCP registration of its own has no plan.
  assert.equal(mcpPlan({ ...RECORD, client: 'opencode' }, depsOf(() => {})), null);
  // The dry run shows the read and the write of the action.
  assert.deepEqual(plan.steps, [plan.get, plan.add]);
  assert.deepEqual(mcpPlan(RECORD, depsOf(() => {}), 'uninstall').steps, [plan.get, plan.remove]);
});

test('the commands of the client run with the timeout of the installer', async () => {
  const client = fakeClient(null);
  await registerMcp(RECORD, depsOf(client.run), 'install');
  assert.ok(client.calls.length >= 2);
  for (const call of client.calls) assert.equal(call.timeout, CONFIG.timeoutMs);
});

test('an entry the client does not hold is added', async () => {
  const client = fakeClient(null);
  const result = await registerMcp(RECORD, depsOf(client.run), 'install');
  assert.equal(result.status, 'ok');
  assert.deepEqual(argvOf(client), [
    ['mcp', 'get', 'okit'],
    ['mcp', 'add', '--scope', 'user', 'okit', '--', CONFIG.node, SERVER],
  ]);
});

test('our entry that already points at this installation is left alone', async () => {
  const client = fakeClient(`okit\n  command: ${CONFIG.node}\n  args: ${SERVER}\n`);
  const result = await registerMcp(RECORD, depsOf(client.run), 'install');
  assert.equal(result.status, 'skipped');
  assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit']]);
});

test('our entry that points at the installation this one replaces is taken out and written again', async () => {
  const client = fakeClient(`okit\n  args: ${join(PREVIOUS.path, 'src/mcp/server.js')}\n`);
  const result = await registerMcp({ ...RECORD, previous: PREVIOUS }, depsOf(client.run), 'update');
  assert.equal(result.status, 'ok');
  assert.deepEqual(argvOf(client), [
    ['mcp', 'get', 'okit'],
    ['mcp', 'remove', 'okit', '--scope', 'user'],
    ['mcp', 'add', '--scope', 'user', 'okit', '--', CONFIG.node, SERVER],
  ]);
});

test('an entry that is not ours is kept, with a warning', async () => {
  const client = fakeClient('okit\n  args: /somewhere/else/src/mcp/server.js\n');
  const result = await registerMcp(RECORD, depsOf(client.run), 'install');
  assert.equal(result.status, 'kept');
  assert.match(result.detail, /not ours/, result.detail);
  assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit']]);
});

test('a path that only holds ours as a part of it is not ours', async () => {
  const foreign = [
    `/backup${SERVER}`,
    `${SERVER}.backup`,
    `${SERVER}/x`,
    join('/opt', 'okit-plugin', '1.0.0', 'src/mcp/server.js'),
  ];
  for (const path of foreign) {
    const client = fakeClient(`okit\n  args: ${path}\n`);
    const result = await registerMcp(RECORD, depsOf(client.run), 'install');
    assert.equal(result.status, 'kept', path);
    assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit']], path);
    // The uninstall leaves it alone too.
    const other = fakeClient(`okit\n  args: ${path}\n`);
    const removed = await registerMcp(RECORD, depsOf(other.run), 'uninstall');
    assert.equal(removed.status, 'kept', path);
    assert.deepEqual(argvOf(other), [['mcp', 'get', 'okit']], path);
  }
});

test('on Windows the case and the separator of the path do not matter', () => {
  const path = 'C:\\okit\\1.0.0-claude-code\\src\\mcp\\server.js';
  assert.equal(pointsAt(`okit\n  args: ${path}\n`, [path], 'win32'), true);
  assert.equal(pointsAt(`okit\n  args: ${path.toLowerCase().replaceAll('\\', '/')}\n`, [path], 'win32'), true);
  assert.equal(pointsAt(`okit\n  args: ${path}.backup\n`, [path], 'win32'), false);
  assert.equal(pointsAt(`okit\n  args: ${path.replace('1.0.0-claude-code', '1.0.0')}\n`, [path], 'win32'), false);
});

test('a name or a scope the client would read as a flag never reaches its argv', () => {
  const named = { ...CONFIG, mcp: { ...CONFIG.mcp, name: '--scope' } };
  assert.equal(mcpPlan(RECORD, depsOf(() => {}, named)), null);
  const scoped = { ...CONFIG, clients: { ...CONFIG.clients,
    'claude-code': { ...CONFIG.clients['claude-code'], mcp: { scope: '-x' } } } };
  assert.equal(mcpPlan(RECORD, depsOf(() => {}, scoped)), null);
});

test('a read that failed is not an absent entry: nothing is written', async () => {
  const failures = [
    Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }),
    Object.assign(new Error('no answer within 15000 ms'), { code: 'ETIMEDOUT', killed: true, signal: 'SIGKILL' }),
    Object.assign(new Error('Command failed: claude mcp get okit'), { code: 2, stdout: '', stderr: 'permission denied' }),
    Object.assign(new Error('Command failed: claude mcp get okit'), { code: 1, stdout: 'the client is broken\n', stderr: '' }),
  ];
  for (const error of failures) {
    const client = fakeClient(null);
    const run = async (input) => { client.calls.push(input); if (input.args[1] === 'get') throw error; return {}; };
    const result = await registerMcp(RECORD, depsOf(run), 'install');
    assert.equal(result.status, 'failed', error.message);
    assert.match(result.reason, /ENOENT|ETIMEDOUT|2:|1:/, result.reason);
    // The command the person can run by hand is in the warning.
    assert.match(result.detail, /mcp add --scope user okit --/, result.detail);
    assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit']], error.message);
  }
});

test('a read that answers that the client holds no entry is an absent entry', async () => {
  const client = fakeClient(null);
  const result = await registerMcp(RECORD, depsOf(client.run), 'install');
  assert.equal(result.status, 'ok');
  assert.deepEqual(argvOf(client).map((words) => words[1]), ['get', 'add']);
});

test('a run that answers with the code of an absent entry is an absent entry too', async () => {
  const calls = [];
  const run = async (input) => {
    calls.push(input);
    if (input.args[1] === 'get') return { code: 1, stdout: 'No MCP server named "okit" found.\n', stderr: '' };
    return {};
  };
  const result = await registerMcp(RECORD, depsOf(run), 'install');
  assert.equal(result.status, 'ok');
  assert.deepEqual(calls.map((call) => call.args[1]), ['get', 'add']);
});

test('the uninstall takes our entry out and leaves the entries that are not ours alone', async () => {
  const ours = fakeClient(`okit\n  args: ${SERVER}\n`);
  const removed = await registerMcp(RECORD, depsOf(ours.run), 'uninstall');
  assert.equal(removed.status, 'ok');
  assert.deepEqual(argvOf(ours), [['mcp', 'get', 'okit'], ['mcp', 'remove', 'okit', '--scope', 'user']]);
  const foreign = fakeClient('okit\n  args: /somewhere/else/src/mcp/server.js\n');
  const kept = await registerMcp(RECORD, depsOf(foreign.run), 'uninstall');
  assert.equal(kept.status, 'kept');
  assert.deepEqual(argvOf(foreign), [['mcp', 'get', 'okit']]);
  const absent = fakeClient(null);
  const nothing = await registerMcp(RECORD, depsOf(absent.run), 'uninstall');
  assert.equal(nothing.status, 'skipped');
  assert.deepEqual(argvOf(absent), [['mcp', 'get', 'okit']]);
});

test('a command the client refuses is a warning, never a failure', async () => {
  const client = fakeClient(null);
  const run = async (input) => {
    if (input.args[1] === 'add') throw new Error('the client refused the entry');
    return client.run(input);
  };
  const result = await registerMcp(RECORD, depsOf(run), 'install');
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /the client refused the entry/);
  assert.match(result.detail, /the client refused the entry/, result.detail);
  // The command the person can run by hand is in the warning.
  assert.match(result.detail, /mcp add --scope user okit --/, result.detail);
});

test('the installation registers the MCP server of the client and goes on', async (t) => {
  const f = await fixture(t);
  assert.equal(await main(['install', '--client', 'claude-code'], f.io), 0, f.output.join('\n'));
  assert.ok(f.output.some((line) => /MCP server registered in Claude Code/.test(line)), f.output.join('\n'));
  const commands = f.commands.filter((item) => item.args[0] === 'mcp');
  assert.deepEqual(commands.map((item) => item.args.slice(0, 3)), [['mcp', 'get', 'okit'], ['mcp', 'add', '--scope']]);
});

test('a client that refuses the entry does not fail the installation', async (t) => {
  const f = await fixture(t);
  const run = f.io.run;
  f.io.run = async (input) => {
    if (input.args?.[0] === 'mcp' && input.args[1] === 'add') throw new Error('the client refused the entry');
    return run(input);
  };
  assert.equal(await main(['install', '--client', 'claude-code'], f.io), 0, f.output.join('\n'));
  assert.ok(f.output.some((line) => /warning: the MCP server of Claude Code could not be changed/.test(line)), f.output.join('\n'));
});

test('a client that is not on the machine leaves the manual MCP command in the notes', async (t) => {
  const f = await fixture(t);
  f.io.detect = async () => false;
  assert.equal(await main(['install', '--client', 'claude-code'], f.io), 0, f.output.join('\n'));
  const notes = f.output.filter((line) => /mcp add/.test(line));
  assert.equal(notes.length, 1, f.output.join('\n'));
  assert.match(notes[0], /claude mcp add --scope user okit --/, notes[0]);
  // Nothing of the MCP was run: the client is not there.
  assert.deepEqual(f.commands.filter((item) => item.args[0] === 'mcp'), []);
});

test('the uninstall takes the MCP entry out before the plugin it points at', async (t) => {
  const f = await fixture(t);
  assert.equal(await main(['install', '--client', 'claude-code'], f.io), 0, f.output.join('\n'));
  f.clear();
  assert.equal(await main(['uninstall'], f.io), 0, f.output.join('\n'));
  assert.ok(f.output.some((line) => /MCP server removed from Claude Code/.test(line)), f.output.join('\n'));
  const names = f.commands.map((item) => item.args.join(' '));
  const removal = names.findIndex((name) => name.startsWith('mcp remove'));
  const plugin = names.findIndex((name) => name.startsWith('plugin uninstall'));
  assert.ok(removal >= 0 && plugin >= 0 && removal < plugin, names.join(' / '));
});

test('a dry run runs nothing and shows the plan of the MCP step', async (t) => {
  const f = await fixture(t);
  assert.equal(await main(['install', '--client', 'claude-code', '--dry-run', '--verbose'], f.io), 0, f.output.join('\n'));
  assert.deepEqual(f.commands.filter((item) => item.args[0] === 'mcp'), []);
  assert.ok(f.output.some((line) => /claude mcp get okit/.test(line)), f.output.join('\n'));
  assert.ok(f.output.some((line) => /claude mcp add --scope user okit --/.test(line)), f.output.join('\n'));
});

test('every text of the MCP step is written in both languages', () => {
  for (const key of ['mcpRegistered', 'mcpAlready', 'mcpReplaced', 'mcpRemoved', 'mcpKept', 'mcpFailed']) {
    assert.ok(TEXTS[key]?.en, key);
    assert.ok(TEXTS[key]?.['pt-BR'], key);
    assert.notEqual(TEXTS[key].en, TEXTS[key]['pt-BR'], key);
  }
});

test('an entry that is not ours is a warning of the installation, which goes on', async (t) => {
  const f = await fixture(t);
  const run = f.io.run;
  f.io.run = async (input) => (input.args?.[0] === 'mcp' && input.args[1] === 'get'
    ? { stdout: 'okit\n  args: /somewhere/else/src/mcp/server.js\n' } : run(input));
  assert.equal(await main(['install', '--client', 'claude-code'], f.io), 0, f.output.join('\n'));
  assert.ok(f.output.some((line) => /warning: an MCP server named okit that is not ours/.test(line)), f.output.join('\n'));
  assert.deepEqual(f.commands.filter((item) => item.args[0] === 'mcp' && item.args[1] !== 'get'), []);
});

test('the uninstall takes out the entry that points at the installation this one replaced', async () => {
  const client = fakeClient(`okit\n  args: ${join(PREVIOUS.path, 'src/mcp/server.js')}\n`);
  const result = await registerMcp({ ...RECORD, previous: { path: PREVIOUS.path } }, depsOf(client.run), 'uninstall');
  assert.equal(result.status, 'ok');
  assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit'], ['mcp', 'remove', 'okit', '--scope', 'user']]);
});

test('a user config that gives OpenCode an MCP scope still runs no MCP command', async () => {
  const config = installConfig({ clients: { opencode: { mcp: { scope: 'user' } } } });
  assert.equal(config.clients.opencode.mcp.scope, 'user');
  const calls = [];
  const deps = { config, run: async (input) => { calls.push(input); }, detect: async () => true, out: () => {} };
  const record = { client: 'opencode', path: RECORD.path };
  assert.equal(mcpPlan(record, deps), null);
  assert.equal(await registerMcp(record, deps, 'install'), null);
  assert.equal(await ensureMcp(record, deps), null);
  assert.deepEqual(calls, []);
});

test('the installation that is already there registers its entry again', async (t) => {
  const f = await fixture(t);
  const run = f.io.run;
  f.io.run = async (input) => {
    if (input.args?.[0] === 'mcp' && input.args[1] === 'add') { f.commands.push(input); throw new Error('the client refused the entry'); }
    return run(input);
  };
  assert.equal(await main(['install', '--client', 'claude-code'], f.io), 0, f.output.join('\n'));
  assert.deepEqual(f.commands.filter((item) => item.args[0] === 'mcp').map((item) => item.args[1]), ['get', 'add']);
  // The same version again: the entry that failed to be added is added now.
  f.io.run = run;
  f.clear();
  assert.equal(await main(['install', '--client', 'claude-code'], f.io), 0, f.output.join('\n'));
  assert.deepEqual(f.commands.filter((item) => item.args[0] === 'mcp').map((item) => item.args[1]), ['get', 'add', 'get', 'add']);
});

test('the installation that is already there and holds our entry reads it and writes nothing', async (t) => {
  const f = await fixture(t);
  assert.equal(await main(['install', '--client', 'claude-code'], f.io), 0, f.output.join('\n'));
  const before = f.commands.length;
  f.clear();
  assert.equal(await main(['install', '--client', 'claude-code'], f.io), 0, f.output.join('\n'));
  const commands = f.commands.slice(before).filter((item) => item.args[0] === 'mcp');
  assert.deepEqual(commands.map((item) => item.args), [['mcp', 'get', 'okit']]);
});

test('a dry run of the installation that is already there shows the plan of the MCP step', async (t) => {
  const f = await fixture(t);
  assert.equal(await main(['install', '--client', 'claude-code'], f.io), 0, f.output.join('\n'));
  const before = f.commands.length;
  f.clear();
  assert.equal(await main(['install', '--client', 'claude-code', '--dry-run', '--verbose'], f.io), 0, f.output.join('\n'));
  assert.deepEqual(f.commands.slice(before).filter((item) => item.args[0] === 'mcp'), []);
  assert.ok(f.output.some((line) => /claude mcp get okit/.test(line)), f.output.join('\n'));
  assert.ok(f.output.some((line) => /claude mcp add --scope user okit --/.test(line)), f.output.join('\n'));
});

test('a rollback points the MCP entry at the version it restores', async (t) => {
  const f = await fixture(t);
  assert.equal(await main(['install', '--client', 'claude-code'], f.io), 0, f.output.join('\n'));
  f.setVersion('2.0.0');
  assert.equal(await main(['update'], f.io), 0, f.output.join('\n'));
  assert.equal(f.mcp.entry('claude', 'okit').args.at(-1), join(f.destination, '2.0.0-claude-code', 'src/mcp/server.js'));
  f.clear();
  assert.equal(await main(['update', '--rollback'], f.io), 0, f.output.join('\n'));
  assert.equal(f.mcp.entry('claude', 'okit').args.at(-1), join(f.destination, '1.0.0-claude-code', 'src/mcp/server.js'));
});

test('a rollback in a dry run shows the plan of the MCP step and runs nothing', async (t) => {
  const f = await fixture(t);
  assert.equal(await main(['install', '--client', 'claude-code'], f.io), 0, f.output.join('\n'));
  f.setVersion('2.0.0');
  assert.equal(await main(['update'], f.io), 0, f.output.join('\n'));
  const before = f.commands.length;
  f.clear();
  assert.equal(await main(['update', '--rollback', '--dry-run', '--verbose'], f.io), 0, f.output.join('\n'));
  assert.deepEqual(f.commands.slice(before), []);
  assert.ok(f.output.some((line) => /claude mcp get okit/.test(line)), f.output.join('\n'));
});

test('a failed read that says the entry is absent but exits with another code is a failure, not an absent entry', async () => {
  const client = fakeClient(null);
  const run = async (input) => {
    if (input.args[1] === 'get') throw Object.assign(new Error('failed'), { code: 2, stderr: 'No MCP server named okit' });
    return client.run(input);
  };
  const result = await registerMcp(RECORD, depsOf(run), 'install');
  assert.equal(result.status, 'failed');
  assert.deepEqual(client.argv(), []);
});

// ---------------------------------------------------------------------------------------------------------------
// D110 correction round 2: the ownership of an entry is the whole path as the client printed it.

test('a path with spaces is ours when the client prints it whole', () => {
  const printed = [
    `okit\n  Args: ${SPACED_SERVER}\n`,
    `okit\n  args: ${SPACED_SERVER}\n`,
    `okit\n  args: "${SPACED_SERVER}"\n`,
    `okit\n  args: ["${SPACED_SERVER}"]\n`,
    `okit\n  args: ${SPACED_SERVER}`,
  ];
  for (const text of printed) assert.equal(pointsAt(text, [SPACED_SERVER]), true, text);
});

test('a path with a foreign word at its side is not ours', () => {
  const foreign = [
    `/foreign,${SERVER}`,
    `/backup${SERVER}`,
    `${SERVER}.backup`,
    `${SERVER}/x`,
    `${SERVER}-old`,
    `x${SERVER}`,
    join('/opt', 'okit-plugin', '1.0.0', 'src/mcp/server.js'),
  ];
  for (const path of foreign) assert.equal(pointsAt(`okit\n  args: ${path}\n`, [SERVER]), false, path);
});

test('every occurrence of the path counts, not only the first', () => {
  const text = `okit\n  args: /backup${SERVER}\n  args: ${SERVER}\n`;
  assert.equal(pointsAt(text, [SERVER]), true);
  // The other way around: the first one is ours, the second one is not.
  const other = `okit\n  args: ${SERVER}\n  args: /backup${SERVER}\n`;
  assert.equal(pointsAt(other, [SERVER]), true);
});

test('on Windows the path is ours in every spelling, and only then', () => {
  const path = 'C:\\Users\\Jo Silva\\AppData\\okit\\src\\mcp\\server.js';
  assert.equal(pointsAt(`okit\n  args: ${path}\n`, [path], 'win32'), true);
  assert.equal(pointsAt(`okit\n  args: ${path.replaceAll('\\', '/')}\n`, [path], 'win32'), true);
  assert.equal(pointsAt(`okit\n  args: ${path.toLowerCase()}\n`, [path], 'win32'), true);
  assert.equal(pointsAt(`okit\n  args: "${path}"\n`, [path], 'win32'), true);
  // A foreign word at its side is not ours.
  assert.equal(pointsAt(`okit\n  args: /backup${path}\n`, [path], 'win32'), false);
  assert.equal(pointsAt(`okit\n  args: ${path}.backup\n`, [path], 'win32'), false);
  // On another system the case and the separator do matter.
  assert.equal(pointsAt(`okit\n  args: ${path.toLowerCase()}\n`, [path], 'linux'), false);
  assert.equal(pointsAt(`okit\n  args: ${path.replaceAll('\\', '/')}\n`, [path], 'linux'), false);
});

test('the entry that names our path with spaces is ours', async () => {
  const client = fakeClient(`okit\n  args: ${SPACED_SERVER}\n`);
  const result = await registerMcp({ ...RECORD, path: SPACED }, depsOf(client.run), 'install');
  assert.equal(result.status, 'skipped');
  assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit']]);
});

test('the entry that names our path after a comma is not ours', async () => {
  const client = fakeClient(`okit\n  args: /foreign,${SERVER}\n`);
  const result = await registerMcp(RECORD, depsOf(client.run), 'install');
  assert.equal(result.status, 'kept');
  assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit']]);
});

// ---------------------------------------------------------------------------------------------------------------
// D110 correction round 2: a runner that resolves a non-zero code failed as much as one that throws.

test('a read that resolves a failure is a failure, not an absent entry', async () => {
  const calls = [];
  const run = async (input) => {
    calls.push(input);
    if (input.args[1] === 'get') return { code: 2, stdout: '', stderr: 'No MCP server named okit' };
    return {};
  };
  const result = await registerMcp(RECORD, depsOf(run), 'install');
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /2:/, result.reason);
  // Nothing is written: the add that would replace a foreign entry never runs.
  assert.deepEqual(calls.map((call) => call.args[1]), ['get']);
});

test('a read that resolves the code of an absent entry is an absent entry', async () => {
  const calls = [];
  const run = async (input) => {
    calls.push(input);
    if (input.args[1] === 'get') return { code: 1, stdout: '', stderr: 'No MCP server named okit' };
    return {};
  };
  const result = await registerMcp(RECORD, depsOf(run), 'install');
  assert.equal(result.status, 'ok');
  assert.deepEqual(calls.map((call) => call.args[1]), ['get', 'add']);
});

test('a remove that resolves a failure is not followed by an add', async () => {
  const calls = [];
  const run = async (input) => {
    calls.push(input);
    if (input.args[1] === 'get') return { stdout: `okit\n  args: ${join(PREVIOUS.path, 'src/mcp/server.js')}\n` };
    if (input.args[1] === 'remove') return { code: 1, stdout: '', stderr: 'the client refused the removal' };
    return {};
  };
  const result = await registerMcp({ ...RECORD, previous: PREVIOUS }, depsOf(run), 'update');
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /the client refused the removal/, result.reason);
  // The add never runs after a remove that failed.
  assert.deepEqual(calls.map((call) => call.args[1]), ['get', 'remove']);
});

test('an add that resolves a failure is a failure', async () => {
  const calls = [];
  const run = async (input) => {
    calls.push(input);
    if (input.args[1] === 'get') return { code: 1, stdout: '', stderr: 'No MCP server named okit' };
    if (input.args[1] === 'add') return { code: 1, stdout: '', stderr: 'the client refused the entry' };
    return {};
  };
  const result = await registerMcp(RECORD, depsOf(run), 'install');
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /the client refused the entry/, result.reason);
  assert.deepEqual(calls.map((call) => call.args[1]), ['get', 'add']);
});

// ---------------------------------------------------------------------------------------------------------------
// D110 correction round 2: nothing of the MCP step throws into the installer.

test('a client that cannot be looked for is a warning, not an exception', async () => {
  const deps = { config: CONFIG, run: async () => ({}), out: () => {},
    detect: async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } };
  const result = await ensureMcp(RECORD, deps);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /EACCES/, result.reason);
});

test('a client this step does not handle is never looked for', async () => {
  let called = 0;
  const deps = { config: CONFIG, run: async () => ({}), out: () => {},
    detect: async () => { called += 1; return true; } };
  const record = { client: 'opencode', path: RECORD.path };
  assert.equal(await ensureMcp(record, deps), null);
  assert.equal(called, 0);
  // Even when the configuration of the person gives OpenCode an MCP block of its own.
  const config = installConfig({ clients: { opencode: { mcp: { scope: 'user' } } } });
  assert.equal(config.clients.opencode.mcp.scope, 'user');
  assert.equal(await ensureMcp(record, { ...deps, config }), null);
  assert.equal(called, 0);
});

test('the MCP step survives an unexpected failure and warns', async () => {
  const lines = [];
  const deps = { config: { ...CONFIG, mcp: undefined }, run: async () => ({}), out: (line) => lines.push(line) };
  const notes = await mcpStep(RECORD, deps, 'install');
  assert.deepEqual(notes, []);
  assert.ok(lines.some((line) => /could not be changed/.test(line)), lines.join('\n'));
});

// ---------------------------------------------------------------------------------------------------------------
// D110 correction round 2: the module strategy keeps the MCP step.

test('a client with the module strategy registers and removes the MCP entry', async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), 'mcp-module-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const source = join(home, 'payload');
  await fs.mkdir(join(source, 'skills', 'example'), { recursive: true });
  await fs.writeFile(join(source, 'skills', 'example', 'SKILL.md'), 'skill');
  const clientRoot = join(home, 'client');
  const config = installConfig({ clients: { 'claude-code': { strategy: 'module', module: 'src/install/client-plugin.js' } } });
  assert.equal(config.clients['claude-code'].strategy, 'module');
  const commands = [];
  const mcp = mcpWorld();
  const deps = { config, fs, temporary: home, env: { HOME: home }, clientRoot, platform: 'linux',
    detect: async () => true, loadAdapter: async () => moduleAdapter, out: () => {},
    run: async (item) => { commands.push(item); return mcp.handles(item) ? mcp.run(item) : {}; } };
  const record = { client: 'claude-code', path: source };
  const installed = await register(record, deps, 'install');
  // The note of the MCP step is in the result of the step.
  assert.ok(installed.notes?.some((note) => /MCP server registered/.test(note)), JSON.stringify(installed.notes));
  assert.deepEqual(commands.filter((item) => item.args[0] === 'mcp').map((item) => item.args[1]), ['get', 'add']);
  // The module of the client is installed.
  assert.match(await fs.readFile(join(clientRoot, 'plugins', 'okit-plugin.js'), 'utf8'), /file:/);
  const removed = await register(record, deps, 'uninstall');
  assert.deepEqual(commands.filter((item) => item.args[0] === 'mcp').map((item) => item.args[1]), ['get', 'add', 'get', 'remove']);
  // The module is gone and the entry of the client is out.
  assert.equal(await fs.readFile(join(clientRoot, 'plugins', 'okit-plugin.js'), 'utf8').catch(() => null), null);
  assert.equal(mcp.entry('claude', 'okit'), undefined);
});

test('a client with the module strategy and no module of ours registers nothing', async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), 'mcp-module-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const source = join(home, 'payload');
  await fs.mkdir(join(source, 'skills', 'example'), { recursive: true });
  await fs.writeFile(join(source, 'skills', 'example', 'SKILL.md'), 'skill');
  const config = installConfig({ clients: { 'claude-code': { strategy: 'module' } } });
  assert.equal(config.clients['claude-code'].module, undefined);
  const commands = [];
  const mcp = mcpWorld();
  const deps = { config, fs, temporary: home, env: { HOME: home }, clientRoot: join(home, 'client'), platform: 'linux',
    detect: async () => true, loadAdapter: async () => moduleAdapter, out: () => {},
    run: async (item) => { commands.push(item); return mcp.handles(item) ? mcp.run(item) : {}; } };
  const record = { client: 'claude-code', path: source };
  for (const action of ['install', 'uninstall']) {
    commands.length = 0;
    const result = await register(record, deps, action);
    // Nothing of the client ran: no command, no MCP step, no role, no module.
    assert.equal(result.status, 'skipped', action);
    assert.deepEqual(commands, [], `${action}: no command of the client ran`);
    assert.deepEqual(result.notes, [], action);
    // The detail says why, in the language of the run.
    assert.equal(result.detail, fill(TEXTS.registerNoModule.en, { client: 'Claude Code' }), action);
  }
  // The text is written in both languages.
  assert.ok(TEXTS.registerNoModule?.en);
  assert.ok(TEXTS.registerNoModule?.['pt-BR']);
  assert.notEqual(TEXTS.registerNoModule.en, TEXTS.registerNoModule['pt-BR']);
});

// ---------------------------------------------------------------------------------------------------------------
// D110 correction round 4: the delimiters of our path are strict.

test('a path a foreign character holds at its side is not ours, and nothing of it is removed', async () => {
  const foreign = [
    `/foreign=${SERVER}`,
    `${SERVER}]backup`,
    `x=${SERVER}`,
    `[${SERVER}`,
    `${SERVER}]`,
  ];
  for (const path of foreign) {
    assert.equal(pointsAt(path, [SERVER]), false, path);
    const client = fakeClient(`okit\n  args: ${path}\n`);
    const result = await registerMcp(RECORD, depsOf(client.run), 'install');
    assert.equal(result.status, 'kept', path);
    assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit']], path);
    // The update and the uninstall leave the entry of somebody else alone.
    for (const action of ['update', 'uninstall']) {
      const other = fakeClient(`okit\n  args: ${path}\n`);
      const answer = await registerMcp(RECORD, depsOf(other.run), action);
      assert.equal(answer.status, 'kept', `${action}: ${path}`);
      assert.deepEqual(argvOf(other), [['mcp', 'get', 'okit']], `${action}: ${path}`);
    }
  }
});

test('our path is ours when a quote or a space stands at its side', async () => {
  const ours = [
    [`["${SERVER}"]`, SERVER],
    [`args = ["${SERVER}"]`, SERVER],
    [`Args: ${SERVER}`, SERVER],
    [`Args: ${SPACED_SERVER}`, SPACED_SERVER],
  ];
  for (const [text, path] of ours) {
    assert.equal(pointsAt(text, [path]), true, text);
    const client = fakeClient(`okit\n  ${text}\n`);
    const record = path === SPACED_SERVER ? { ...RECORD, path: SPACED } : RECORD;
    const result = await registerMcp(record, depsOf(client.run), 'install');
    assert.equal(result.status, 'skipped', text);
    assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit']], text);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// D110 correction round 4: the uninstall of a module warns when the client is not there.

test('the uninstall of a module warns with the manual command when the client is not there', async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), 'mcp-module-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const source = join(home, 'payload');
  await fs.mkdir(join(source, 'skills', 'example'), { recursive: true });
  await fs.writeFile(join(source, 'skills', 'example', 'SKILL.md'), 'skill');
  const clientRoot = join(home, 'client');
  const config = installConfig({ clients: { 'claude-code': { strategy: 'module', module: 'src/install/client-plugin.js' } } });
  const commands = [], lines = [];
  const mcp = mcpWorld();
  const deps = { config, fs, temporary: home, env: { HOME: home }, clientRoot, platform: 'linux',
    detect: async () => true, loadAdapter: async () => moduleAdapter, out: (line) => lines.push(line),
    run: async (item) => { commands.push(item); return mcp.handles(item) ? mcp.run(item) : {}; } };
  const record = { client: 'claude-code', path: source };
  await register(record, deps, 'install');
  assert.match(await fs.readFile(join(clientRoot, 'plugins', 'okit-plugin.js'), 'utf8'), /file:/);
  const cases = [
    { detect: async () => false, warned: true },
    { detect: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); }, warned: true },
    { detect: async () => true, warned: false },
  ];
  for (const item of cases) {
    commands.length = 0;
    lines.length = 0;
    deps.detect = item.detect;
    const removed = await register(record, deps, 'uninstall');
    // The uninstall succeeds and the module of ours is gone.
    assert.equal(removed.status, 'ok');
    assert.equal(await fs.readFile(join(clientRoot, 'plugins', 'okit-plugin.js'), 'utf8').catch(() => null), null);
    const warnings = lines.filter((line) => /mcp remove okit/.test(line));
    if (item.warned) {
      // The entry of the client is left alone: no MCP command ran.
      assert.deepEqual(commands.filter((call) => call.args[0] === 'mcp'), []);
      assert.equal(warnings.length, 1, lines.join('\n'));
      assert.match(warnings[0], /was not found/, warnings[0]);
    } else {
      // A client that is there: its entry goes out, and nothing is warned.
      assert.deepEqual(commands.filter((call) => call.args[0] === 'mcp').map((call) => call.args[1]), ['get', 'remove']);
      assert.deepEqual(warnings, [], lines.join('\n'));
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------
// D110 correction round 5: the scope the client names is the scope the entry is at.

const LOCAL_SCOPE = `okit:\n  Scope: Local config (private to you in this project)\n  Type: stdio\n  Command: node\n  Args: ${SERVER}\n`;
const USER_SCOPE = `okit:\n  Scope: User config (available in all your projects)\n  Type: stdio\n  Command: node\n  Args: ${SERVER}\n`;
const PROJECT_SCOPE = `okit:\n  Scope: Project config (private to you in this project)\n  Type: stdio\n  Command: node\n  Args: ${SERVER}\n`;
const NO_SCOPE = `okit:\n  Type: stdio\n  Command: node\n  Args: ${SERVER}\n`;

test('the plan of each client names the scope of its own command', () => {
  assert.equal(mcpPlan(RECORD, depsOf(() => {})).scope, 'user');
  // A client whose own command takes no scope has none.
  assert.equal(mcpPlan({ ...RECORD, client: 'codex' }, depsOf(() => {})).scope, null);
});

test('an entry at another scope than ours is kept: nothing is written nor taken out', async () => {
  // The client shows the entry of the highest precedence it holds: the local one, while ours is at the user scope.
  const installed = fakeClient(LOCAL_SCOPE);
  const answer = await registerMcp(RECORD, depsOf(installed.run), 'install');
  assert.equal(answer.status, 'kept');
  assert.match(answer.detail, /not ours/, answer.detail);
  assert.deepEqual(argvOf(installed), [['mcp', 'get', 'okit']]);
  const updated = fakeClient(LOCAL_SCOPE);
  const replaced = await registerMcp({ ...RECORD, previous: PREVIOUS }, depsOf(updated.run), 'update');
  assert.equal(replaced.status, 'kept');
  assert.deepEqual(argvOf(updated), [['mcp', 'get', 'okit']]);
  const removed = fakeClient(LOCAL_SCOPE);
  const uninstalled = await registerMcp(RECORD, depsOf(removed.run), 'uninstall');
  assert.equal(uninstalled.status, 'kept');
  assert.deepEqual(argvOf(removed), [['mcp', 'get', 'okit']]);
});

test('an entry at our scope is ours: the install leaves it alone and the uninstall takes it out', async () => {
  const installed = fakeClient(USER_SCOPE);
  const answer = await registerMcp(RECORD, depsOf(installed.run), 'install');
  assert.equal(answer.status, 'skipped');
  assert.match(answer.detail, /already registered/, answer.detail);
  assert.deepEqual(argvOf(installed), [['mcp', 'get', 'okit']]);
  const removed = fakeClient(USER_SCOPE);
  const uninstalled = await registerMcp(RECORD, depsOf(removed.run), 'uninstall');
  assert.equal(uninstalled.status, 'ok');
  assert.deepEqual(argvOf(removed), [['mcp', 'get', 'okit'], ['mcp', 'remove', 'okit', '--scope', 'user']]);
});

test('an entry at the scope of a project is kept', async () => {
  const installed = fakeClient(PROJECT_SCOPE);
  const answer = await registerMcp(RECORD, depsOf(installed.run), 'install');
  assert.equal(answer.status, 'kept');
  assert.deepEqual(argvOf(installed), [['mcp', 'get', 'okit']]);
  const removed = fakeClient(PROJECT_SCOPE);
  const uninstalled = await registerMcp(RECORD, depsOf(removed.run), 'uninstall');
  assert.equal(uninstalled.status, 'kept');
  assert.deepEqual(argvOf(removed), [['mcp', 'get', 'okit']]);
});

test('an entry the client prints without a scope is ours, as before', async () => {
  const installed = fakeClient(NO_SCOPE);
  const answer = await registerMcp(RECORD, depsOf(installed.run), 'install');
  assert.equal(answer.status, 'skipped');
  assert.deepEqual(argvOf(installed), [['mcp', 'get', 'okit']]);
  const removed = fakeClient(NO_SCOPE);
  const uninstalled = await registerMcp(RECORD, depsOf(removed.run), 'uninstall');
  assert.equal(uninstalled.status, 'ok');
  assert.deepEqual(argvOf(removed), [['mcp', 'get', 'okit'], ['mcp', 'remove', 'okit', '--scope', 'user']]);
});

test('a client whose own command takes no scope is not told by the scope the client prints', async () => {
  const record = { ...RECORD, client: 'codex' };
  const installed = fakeClient(LOCAL_SCOPE);
  const answer = await registerMcp(record, depsOf(installed.run), 'install');
  assert.equal(answer.status, 'skipped');
  assert.deepEqual(argvOf(installed), [['mcp', 'get', 'okit']]);
  const removed = fakeClient(LOCAL_SCOPE);
  const uninstalled = await registerMcp(record, depsOf(removed.run), 'uninstall');
  assert.equal(uninstalled.status, 'ok');
  assert.deepEqual(argvOf(removed), [['mcp', 'get', 'okit'], ['mcp', 'remove', 'okit']]);
});

// ---------------------------------------------------------------------------------------------------------------
// D110 correction round 5: the module strategy without a module has no MCP step.

test('a client with the module strategy and no module of ours has no MCP step at all', async () => {
  for (const client of ['claude-code', 'codex']) {
    const config = installConfig({ clients: { [client]: { strategy: 'module' } } });
    assert.equal(config.clients[client].strategy, 'module');
    assert.equal(config.clients[client].module, undefined);
    const calls = [];
    const deps = { config, out: () => {},
      run: async (input) => { calls.push(input); return {}; },
      detect: async () => { calls.push('detect'); return true; } };
    const record = { client, path: RECORD.path };
    assert.equal(mcpPlan(record, deps), null, client);
    assert.equal(await ensureMcp(record, deps), null, client);
    // Neither the client nor its MCP commands were touched.
    assert.deepEqual(calls, [], client);
  }
});

test('a client with the module strategy and a module of ours still has a plan', () => {
  const config = installConfig({ clients: { 'claude-code': { strategy: 'module', module: 'src/install/client-plugin.js' } } });
  assert.equal(config.clients['claude-code'].module, 'src/install/client-plugin.js');
  const plan = mcpPlan(RECORD, depsOf(() => {}, config));
  assert.ok(plan);
  assert.deepEqual(plan.get, ['claude', 'mcp', 'get', 'okit']);
  assert.deepEqual(plan.add, ['claude', 'mcp', 'add', '--scope', 'user', 'okit', '--', config.node, SERVER]);
});
