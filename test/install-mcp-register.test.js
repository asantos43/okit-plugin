import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { main } from '../src/cli.js';
import { installConfig } from '../src/install/config.js';
import { ensureMcp, mcpPlan, pointsAt, registerMcp, shown } from '../src/install/mcp-register.js';
import { mcpStep, register } from '../src/install/register.js';
import { TEXTS, createPresenter, fill } from '../src/install/present.js';
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

// What the clients print for the entry they hold: Claude Code names the scope, the type and the command; Codex prints
// the entry as a list of settings. Neither of them quotes the arguments: they join them with spaces. The fields of the
// server are indented two spaces, the nested lists (the headers, the environment) four.
const claudeEntry = (args) => `okit:\n  Scope: User config (available in all your projects)\n  Type: stdio\n  Command: node\n  Args: ${args}\n`;
const codexEntry = (args) => `okit\n  enabled: true\n  transport: stdio\n  command: node\n  args: ${args}\n`;

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
  const client = fakeClient(codexEntry(SERVER));
  const result = await registerMcp(RECORD, depsOf(client.run), 'install');
  assert.equal(result.status, 'skipped');
  assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit']]);
});

test('our entry that points at the installation this one replaces is taken out and written again', async () => {
  const client = fakeClient(codexEntry(join(PREVIOUS.path, 'src/mcp/server.js')));
  const result = await registerMcp({ ...RECORD, previous: PREVIOUS }, depsOf(client.run), 'update');
  assert.equal(result.status, 'ok');
  assert.deepEqual(argvOf(client), [
    ['mcp', 'get', 'okit'],
    ['mcp', 'remove', 'okit', '--scope', 'user'],
    ['mcp', 'add', '--scope', 'user', 'okit', '--', CONFIG.node, SERVER],
  ]);
});

test('an entry that is not ours is kept, with a warning', async () => {
  const client = fakeClient(codexEntry('/somewhere/else/src/mcp/server.js'));
  const result = await registerMcp(RECORD, depsOf(client.run), 'install');
  assert.equal(result.status, 'kept');
  assert.match(result.detail, /not ours/, result.detail);
  assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit']]);
});

test('on Windows the case and the separator of the path do not matter', () => {
  const path = 'C:\\okit\\1.0.0-claude-code\\src\\mcp\\server.js';
  assert.equal(pointsAt(claudeEntry(path), [path], 'win32'), true);
  assert.equal(pointsAt(claudeEntry(path.toLowerCase().replaceAll('\\', '/')), [path], 'win32'), true);
  assert.equal(pointsAt(claudeEntry(`${path}.backup`), [path], 'win32'), false);
  assert.equal(pointsAt(claudeEntry(path.replace('1.0.0-claude-code', '1.0.0')), [path], 'win32'), false);
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
  const ours = fakeClient(codexEntry(SERVER));
  const removed = await registerMcp(RECORD, depsOf(ours.run), 'uninstall');
  assert.equal(removed.status, 'ok');
  assert.deepEqual(argvOf(ours), [['mcp', 'get', 'okit'], ['mcp', 'remove', 'okit', '--scope', 'user']]);
  const foreign = fakeClient(codexEntry('/somewhere/else/src/mcp/server.js'));
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
  for (const key of ['mcpRegistered', 'mcpAlready', 'mcpReplaced', 'mcpRemoved', 'mcpKept', 'mcpManual', 'mcpAmbiguous', 'mcpFailed']) {
    assert.ok(TEXTS[key]?.en, key);
    assert.ok(TEXTS[key]?.['pt-BR'], key);
    assert.notEqual(TEXTS[key].en, TEXTS[key]['pt-BR'], key);
  }
});

test('an entry that is not ours is a warning of the installation, which goes on', async (t) => {
  const f = await fixture(t);
  const run = f.io.run;
  f.io.run = async (input) => (input.args?.[0] === 'mcp' && input.args[1] === 'get'
    ? { stdout: codexEntry('/somewhere/else/src/mcp/server.js') } : run(input));
  assert.equal(await main(['install', '--client', 'claude-code'], f.io), 0, f.output.join('\n'));
  assert.ok(f.output.some((line) => /warning: an MCP server named okit that is not ours/.test(line)), f.output.join('\n'));
  assert.deepEqual(f.commands.filter((item) => item.args[0] === 'mcp' && item.args[1] !== 'get'), []);
});

test('the uninstall takes out the entry that points at the installation this one replaced', async () => {
  const client = fakeClient(codexEntry(join(PREVIOUS.path, 'src/mcp/server.js')));
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
// D110 correction round 7: the ownership of an entry is the arguments of the entry, whole: the clients print the
// arguments joined by spaces and never quoted, so the value of the arguments line is the whole argument list.

test('the entry whose arguments are our path, whole, is ours', () => {
  const printed = [
    claudeEntry(SERVER),
    codexEntry(SERVER),
    claudeEntry(SPACED_SERVER),
    codexEntry(SPACED_SERVER),
    codexEntry(SERVER).trimEnd(),
  ];
  for (const text of printed) assert.equal(pointsAt(text, [SERVER, SPACED_SERVER]), true, text);
  assert.equal(pointsAt(claudeEntry(SPACED_SERVER), [SPACED_SERVER]), true);
});

test('the entry whose arguments are not our path alone is not ours', () => {
  const foreign = [
    `${SERVER} backup.js`,
    `${SERVER} extra`,
    `extra ${SERVER}`,
    `${SERVER}.bak`,
    `/foreign/${SERVER}`,
    `"${SERVER}"`,
    '',
  ];
  for (const args of foreign) {
    assert.equal(pointsAt(codexEntry(args), [SERVER]), false, args);
    assert.equal(pointsAt(claudeEntry(args), [SERVER]), false, args);
  }
  // The path in another line is not the arguments of the entry: there is no arguments line at all.
  const elsewhere = `okit:\n  Scope: User config (available in all your projects)\n  Command: ${SERVER}\n`;
  assert.equal(pointsAt(elsewhere, [SERVER]), false, elsewhere);
});

test('the entry that is not ours is kept: nothing is written nor taken out', async () => {
  const foreign = [
    `${SERVER} backup.js`,
    `${SERVER} extra`,
    `extra ${SERVER}`,
    `${SERVER}.bak`,
    `/foreign/${SERVER}`,
    `"${SERVER}"`,
    '',
    `Command: ${SERVER}`,
  ];
  for (const args of foreign) {
    const text = args.startsWith('Command:') ? `okit:\n  ${args}\n` : codexEntry(args);
    assert.equal(pointsAt(text, [SERVER]), false, args);
    // The install, the update and the uninstall leave the entry of somebody else alone.
    for (const action of ['install', 'update', 'uninstall']) {
      const client = fakeClient(text);
      const record = action === 'update' ? { ...RECORD, previous: PREVIOUS } : RECORD;
      const answer = await registerMcp(record, depsOf(client.run), action);
      assert.equal(answer.status, 'kept', `${action}: ${args}`);
      assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit']], `${action}: ${args}`);
    }
  }
});

test('on Windows the path is ours in every spelling, and only then', () => {
  const path = 'C:\\Users\\Jo Silva\\AppData\\okit\\src\\mcp\\server.js';
  assert.equal(pointsAt(codexEntry(path), [path], 'win32'), true);
  assert.equal(pointsAt(codexEntry(path.replaceAll('\\', '/')), [path], 'win32'), true);
  assert.equal(pointsAt(codexEntry(path.toLowerCase()), [path], 'win32'), true);
  // A foreign word at its side is not ours.
  assert.equal(pointsAt(codexEntry(`/backup${path}`), [path], 'win32'), false);
  assert.equal(pointsAt(codexEntry(`${path}.backup`), [path], 'win32'), false);
  // On another system the case and the separator do matter.
  assert.equal(pointsAt(codexEntry(path.toLowerCase()), [path], 'linux'), false);
  assert.equal(pointsAt(codexEntry(path.replaceAll('\\', '/')), [path], 'linux'), false);
});

test('the entry that names our path with spaces is left as it is: the display cannot tell it from a foreign one', async () => {
  const client = fakeClient(codexEntry(SPACED_SERVER));
  const result = await registerMcp({ ...RECORD, path: SPACED }, depsOf(client.run), 'install');
  // The entry is not claimed: the printed arguments are ours, whole, but a foreign entry whose arguments were split
  // prints the very same line.
  assert.equal(result.status, 'kept');
  assert.equal(result.manual, true);
  assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit']]);
  // The warning names the commands to run by hand.
  assert.match(result.detail, /claude mcp remove okit --scope user ; claude mcp add --scope user okit --/, result.detail);
});

test('the entry that names our path after a comma is not ours', async () => {
  const client = fakeClient(codexEntry(`/foreign,${SERVER}`));
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
    if (input.args[1] === 'get') return { stdout: `okit\n  transport: stdio\n  args: ${join(PREVIOUS.path, 'src/mcp/server.js')}\n` };
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
// D110 correction round 7: the arguments of the entry are ours only when they are our path, whole.

test('an arguments line a foreign character holds at its side is not ours, and nothing of it is removed', async () => {
  const foreign = [
    `/foreign=${SERVER}`,
    `${SERVER}]backup`,
    `x=${SERVER}`,
    `[${SERVER}`,
    `${SERVER}]`,
  ];
  for (const path of foreign) {
    assert.equal(pointsAt(codexEntry(path), [SERVER]), false, path);
    const client = fakeClient(codexEntry(path));
    const result = await registerMcp(RECORD, depsOf(client.run), 'install');
    assert.equal(result.status, 'kept', path);
    assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit']], path);
    // The update and the uninstall leave the entry of somebody else alone.
    for (const action of ['update', 'uninstall']) {
      const other = fakeClient(codexEntry(path));
      const answer = await registerMcp(RECORD, depsOf(other.run), action);
      assert.equal(answer.status, 'kept', `${action}: ${path}`);
      assert.deepEqual(argvOf(other), [['mcp', 'get', 'okit']], `${action}: ${path}`);
    }
  }
});

test('our path is ours when the arguments line holds it alone', async () => {
  const ours = [
    [codexEntry(SERVER), SERVER, RECORD],
    [claudeEntry(SERVER), SERVER, RECORD],
  ];
  for (const [text, path, record] of ours) {
    assert.equal(pointsAt(text, [path]), true, text);
    const client = fakeClient(text);
    const result = await registerMcp(record, depsOf(client.run), 'install');
    assert.equal(result.status, 'skipped', text);
    assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit']], text);
  }
  // A path that holds a space is our path too, but the display cannot tell it from a foreign entry whose arguments
  // were split: the entry is left as it is.
  const spaced = claudeEntry(SPACED_SERVER);
  assert.equal(pointsAt(spaced, [SPACED_SERVER]), true);
  const client = fakeClient(spaced);
  const result = await registerMcp({ ...RECORD, path: SPACED }, depsOf(client.run), 'install');
  assert.equal(result.status, 'kept');
  assert.equal(result.manual, true);
  assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit']]);
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
  // The scope of the entry is of no use to a client that does not report one: nothing of it is taken out (round 8).
  const removed = fakeClient(LOCAL_SCOPE);
  const uninstalled = await registerMcp(record, depsOf(removed.run), 'uninstall');
  assert.equal(uninstalled.status, 'kept');
  assert.deepEqual(argvOf(removed), [['mcp', 'get', 'okit']]);
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

// ---------------------------------------------------------------------------------------------------------------
// D110 correction round 7: the commands of the client run from a folder the installer owns, so that the configuration
// of a project is never read nor changed.

const CODEX = { client: 'codex', path: join('/opt', 'okit-plugin', '1.0.0-codex') };
const CODEX_PREVIOUS = { client: 'codex', path: join('/opt', 'okit-plugin', '0.9.0-codex') };
const CODEX_SERVER = join(CODEX.path, 'src/mcp/server.js');
const CODEX_PREVIOUS_SERVER = join(CODEX_PREVIOUS.path, 'src/mcp/server.js');
// The directory the dependencies name: the one the commands of the client run from, when there is one.
const NEUTRAL = join(tmpdir(), 'okit-mcp-neutral');
// The entry of a project: ours (the installation this one replaces), so it looks like ours to the client.
const PROJECT_ENTRY = codexEntry(CODEX_PREVIOUS_SERVER);
// The global entry of somebody else: not ours.
const FOREIGN_GLOBAL = codexEntry('/somewhere/else/src/mcp/server.js');
// The global entry of ours.
const OUR_GLOBAL = codexEntry(CODEX_SERVER);

/**
 * A client that reads the configuration of the project of the directory it runs in (Codex reads the `.codex/config.toml`
 * of the trusted project it finds from the current directory upward): inside a project it shows the entry of that
 * project, and from the folder of the installation the global one. What `add` and `remove` write is the global entry,
 * as the real clients do.
 *
 * @param {{project: string, global: string|null, neutral: string}} world the two worlds of the client
 * @returns {{calls: object[], run: Function, state: {global: string|null}, argv: () => string[][]}}
 */
function twoWorlds({ project, global, neutral }) {
  const calls = [];
  const state = { global };
  const run = async (input) => {
    calls.push(input);
    const verb = input.args[1];
    if (verb === 'get') {
      const entry = input.cwd === neutral ? state.global : project;
      // The real clients answer that they hold no entry with this name, print it and exit with 1.
      if (!entry) throw Object.assign(new Error(`Command failed: ${input.command} mcp get okit`), { code: 1,
        stdout: 'No MCP server named "okit" found.\n', stderr: '' });
      return { stdout: entry };
    }
    if (verb === 'add') { state.global = codexEntry(input.args.at(-1)); return {}; }
    if (verb === 'remove') { state.global = null; return {}; }
    return {};
  };
  return { calls, run, state, argv: () => calls.map((call) => call.args) };
}

test('every write of the step for Claude Code runs from the installation folder too', async () => {
  const removing = fakeClient(claudeEntry(SERVER));
  await registerMcp(RECORD, depsOf(removing.run), 'uninstall');
  assert.deepEqual(argvOf(removing).map((words) => words[1]), ['get', 'remove']);
  assert.deepEqual(removing.calls.map((call) => call.cwd), [RECORD.path, RECORD.path]);
  const replacing = fakeClient(claudeEntry(join(PREVIOUS.path, 'src/mcp/server.js')));
  await registerMcp({ ...RECORD, previous: PREVIOUS }, depsOf(replacing.run), 'update');
  assert.deepEqual(argvOf(replacing).map((words) => words[1]), ['get', 'remove', 'add']);
  assert.deepEqual(replacing.calls.map((call) => call.cwd), [RECORD.path, RECORD.path, RECORD.path]);
});

test('a name with a dot, which Claude Code refuses, has no plan even when the configuration is not validated', () => {
  const config = { ...CONFIG, mcp: { ...CONFIG.mcp, name: 'okit.extra' } };
  assert.equal(mcpPlan(RECORD, depsOf(() => {}, config)), null);
});

test('a Codex entry the uninstall leaves for the person is a warning, a foreign one stays a note', async () => {
  const ours = twoWorlds({ project: PROJECT_ENTRY, global: OUR_GLOBAL, neutral: CODEX.path });
  const lines = [];
  const deps = { ...depsOf(ours.run), out: (line) => lines.push(line) };
  const notes = await mcpStep(CODEX, deps, 'uninstall');
  assert.deepEqual(notes, []);
  assert.ok(lines.some((line) => /codex mcp remove okit/.test(line)), lines.join('\n'));
  assert.deepEqual(ours.argv().map((words) => words[1]), ['get']);
  const foreign = twoWorlds({ project: FOREIGN_GLOBAL, global: FOREIGN_GLOBAL, neutral: CODEX.path });
  const other = [];
  const notes2 = await mcpStep(CODEX, { ...depsOf(foreign.run), out: (line) => other.push(line) }, 'uninstall');
  assert.equal(notes2.length, 1);
});

test('the uninstall reads the global entry and leaves the foreign one alone', async () => {
  const client = twoWorlds({ project: PROJECT_ENTRY, global: FOREIGN_GLOBAL, neutral: NEUTRAL });
  const result = await registerMcp({ ...CODEX, previous: CODEX_PREVIOUS }, { ...depsOf(client.run), mcpCwd: NEUTRAL }, 'uninstall');
  assert.equal(result.status, 'kept');
  // Every command of the client ran from the directory of the dependencies: no configuration of a project was read.
  assert.deepEqual(client.calls.map((call) => call.cwd), [NEUTRAL]);
  // The global entry of somebody else is still there: nothing was taken out nor written.
  assert.deepEqual(client.argv().map((words) => words[1]), ['get']);
  assert.equal(client.state.global, FOREIGN_GLOBAL);
});

test('the update reads the global entry and leaves the foreign one alone', async () => {
  const client = twoWorlds({ project: PROJECT_ENTRY, global: FOREIGN_GLOBAL, neutral: NEUTRAL });
  const result = await registerMcp({ ...CODEX, previous: CODEX_PREVIOUS }, { ...depsOf(client.run), mcpCwd: NEUTRAL }, 'update');
  assert.equal(result.status, 'kept');
  assert.deepEqual(client.calls.map((call) => call.cwd), [NEUTRAL]);
  // The entry of the project (ours) is not the one the client shows from that directory: nothing is written.
  assert.deepEqual(client.argv().map((words) => words[1]), ['get']);
  assert.equal(client.state.global, FOREIGN_GLOBAL);
});

test('the uninstall of a client that does not report a scope never takes our global entry out', async () => {
  const client = twoWorlds({ project: PROJECT_ENTRY, global: OUR_GLOBAL, neutral: NEUTRAL });
  const result = await registerMcp(CODEX, { ...depsOf(client.run), mcpCwd: NEUTRAL }, 'uninstall');
  // The client does not say where the entry it shows is kept, so the installer does not take it out (round 8).
  assert.equal(result.status, 'kept');
  assert.deepEqual(client.calls.map((call) => call.cwd), [NEUTRAL]);
  assert.deepEqual(client.argv().map((words) => words[1]), ['get']);
  // The global entry of ours is still there, and the warning names the command to run by hand.
  assert.equal(client.state.global, OUR_GLOBAL);
  assert.match(result.detail, /codex mcp remove okit/, result.detail);
});

test('without a directory of its own, the commands run from the installation folder of the record', async () => {
  const client = twoWorlds({ project: PROJECT_ENTRY, global: FOREIGN_GLOBAL, neutral: CODEX.path });
  const result = await registerMcp(CODEX, depsOf(client.run), 'uninstall');
  assert.equal(result.status, 'kept');
  for (const call of client.calls) assert.equal(call.cwd, CODEX.path);
  assert.deepEqual(client.argv().map((words) => words[1]), ['get']);
});

test('every command of the step runs from the installation folder of the record', async () => {
  const client = twoWorlds({ project: PROJECT_ENTRY, global: null, neutral: CODEX.path });
  const result = await registerMcp(CODEX, depsOf(client.run), 'install');
  assert.equal(result.status, 'ok');
  assert.deepEqual(client.calls.map((call) => call.cwd), [CODEX.path, CODEX.path]);
  assert.deepEqual(client.argv().map((words) => words[1]), ['get', 'add']);
});

test('the temporary folder of the system is never the directory of the commands', async () => {
  const made = join(tmpdir(), 'okit-mcp-tmpdir');
  const before = process.env.TMPDIR;
  process.env.TMPDIR = made;
  try {
    const client = twoWorlds({ project: PROJECT_ENTRY, global: FOREIGN_GLOBAL, neutral: CODEX.path });
    const result = await registerMcp(CODEX, depsOf(client.run), 'uninstall');
    assert.equal(result.status, 'kept');
    for (const call of client.calls) assert.equal(call.cwd, CODEX.path);
    assert.deepEqual(client.argv().map((words) => words[1]), ['get']);
  } finally {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
  }
});

// ---------------------------------------------------------------------------------------------------------------
// D110 correction round 7: a scope only for a client whose own `mcp` commands take one.

test('a scope for a client whose own mcp commands take none is refused, in both languages', async (t) => {
  const f = await fixture(t);
  const file = join(f.root, 'config.json');
  for (const [locale, expected] of [
    ['en', /Invalid install\.clients\.codex\.mcp\.scope: a scope only for a client whose own mcp commands take one/],
    ['pt-BR', /install\.clients\.codex\.mcp\.scope inválido: um escopo só para um cliente cujos comandos mcp aceitam um/],
  ]) {
    await fs.writeFile(file, JSON.stringify({ language: locale,
      install: { clients: { codex: { mcp: { scope: 'user' } } } } }));
    f.clear();
    const code = await main(['install', '--client', 'claude-code', '--dry-run'], f.io);
    const text = f.output.join('\n');
    assert.equal(code, 2, `${locale}\n${text}`);
    assert.match(text, expected, `${locale}\n${text}`);
  }
});

test('the defaults and a null scope for a client whose commands take none are accepted', () => {
  assert.doesNotThrow(() => installConfig());
  const config = installConfig({ clients: { codex: { mcp: { scope: null } } } });
  assert.equal(config.clients.codex.mcp.scope, null);
  assert.equal(mcpPlan({ ...RECORD, client: 'codex' }, depsOf(() => {}, config)).scope, null);
});

test('a scope for a client whose own mcp commands take one is accepted, and the plan carries it', () => {
  const config = installConfig({ clients: { 'claude-code': { mcp: { scope: 'local' } } } });
  assert.equal(config.clients['claude-code'].mcp.scope, 'local');
  const plan = mcpPlan(RECORD, depsOf(() => {}, config));
  assert.deepEqual(plan.add, ['claude', 'mcp', 'add', '--scope', 'local', 'okit', '--', config.node, SERVER]);
  assert.deepEqual(plan.remove, ['claude', 'mcp', 'remove', 'okit', '--scope', 'local']);
});

test('the dry run shows the plan of the MCP step, with no directory of its own', () => {
  const plan = mcpPlan(CODEX, depsOf(() => {}));
  assert.deepEqual(plan.get, ['codex', 'mcp', 'get', 'okit']);
  assert.deepEqual(plan.add, ['codex', 'mcp', 'add', 'okit', '--', CONFIG.node, CODEX_SERVER]);
  assert.deepEqual(plan.remove, ['codex', 'mcp', 'remove', 'okit']);
  assert.deepEqual(plan.steps, [plan.get, plan.add]);
  assert.equal(plan.cwd, CODEX.path);
  assert.deepEqual(mcpPlan(CODEX, depsOf(() => {}), 'uninstall').steps, [plan.get, plan.remove]);
});

// ---------------------------------------------------------------------------------------------------------------
// D110 correction round 8: a client whose own `mcp get` does not say where an entry is kept (Codex) is only ever
// added to: what it shows is the entry of the highest precedence it holds, while its `mcp add` and `mcp remove` only
// ever touch the global entry. The installer cannot tell which one it is looking at, so an entry that is there is
// never replaced nor taken out by it, and the warning gives the commands to run by hand.
//
// Must pass / must refuse:
// | case | must pass | must refuse |
// | Codex, our entry of the version it replaces | nothing is written; the commands by hand | the remove or the add |
// | Codex, our entry, uninstall | nothing is written; the command by hand | the remove |
// | Codex, no entry | the add | -- |
// | Codex, our entry of this installation | nothing is written | the remove or the add |
// | Claude Code, our entry of the version it replaces | the remove and then the add | -- |

test('a client that does not say where an entry is kept never replaces our entry of the version it replaces', async () => {
  const client = twoWorlds({ project: PROJECT_ENTRY, global: PROJECT_ENTRY, neutral: NEUTRAL });
  const record = { ...CODEX, previous: CODEX_PREVIOUS };
  const result = await registerMcp(record, { ...depsOf(client.run), mcpCwd: NEUTRAL }, 'update');
  // Nothing at all is written: neither the remove nor the add.
  assert.equal(result.status, 'kept');
  assert.deepEqual(client.argv().map((words) => words[1]), ['get']);
  assert.equal(client.state.global, PROJECT_ENTRY);
  // The warning names the two commands, in the order they are to be run.
  assert.match(result.detail, /codex mcp remove okit ; codex mcp add okit --/, result.detail);
  assert.match(result.detail, new RegExp(`${CODEX_SERVER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), result.detail);
});

test('a client that does not say where an entry is kept never takes our entry out on the uninstall', async () => {
  for (const [entry, name] of [[OUR_GLOBAL, 'this installation'], [PROJECT_ENTRY, 'the version it replaces']]) {
    const client = twoWorlds({ project: PROJECT_ENTRY, global: entry, neutral: NEUTRAL });
    const record = { ...CODEX, previous: CODEX_PREVIOUS };
    const result = await registerMcp(record, { ...depsOf(client.run), mcpCwd: NEUTRAL }, 'uninstall');
    assert.equal(result.status, 'kept', name);
    // No remove ran: the entry the client shows may not be the one the remove would take out.
    assert.deepEqual(client.argv().map((words) => words[1]), ['get'], name);
    assert.equal(client.state.global, entry, name);
    // The warning names the command to run by hand.
    assert.match(result.detail, /codex mcp remove okit/, result.detail);
    assert.doesNotMatch(result.detail, /mcp add/, result.detail);
  }
});

test('a client that does not say where an entry is kept still adds the entry when there is none', async () => {
  const client = twoWorlds({ project: PROJECT_ENTRY, global: null, neutral: NEUTRAL });
  const result = await registerMcp(CODEX, { ...depsOf(client.run), mcpCwd: NEUTRAL }, 'install');
  assert.equal(result.status, 'ok');
  assert.deepEqual(client.argv().map((words) => words[1]), ['get', 'add']);
  assert.equal(client.state.global, codexEntry(CODEX_SERVER));
});

test('a client that does not say where an entry is kept writes nothing when the entry is ours already', async () => {
  const client = twoWorlds({ project: PROJECT_ENTRY, global: OUR_GLOBAL, neutral: NEUTRAL });
  const result = await registerMcp(CODEX, { ...depsOf(client.run), mcpCwd: NEUTRAL }, 'install');
  assert.equal(result.status, 'skipped');
  assert.deepEqual(client.argv().map((words) => words[1]), ['get']);
  assert.equal(client.state.global, OUR_GLOBAL);
});

test('a client that says where an entry is kept replaces ours and takes it out, as before', async () => {
  const replaced = fakeClient(claudeEntry(join(PREVIOUS.path, 'src/mcp/server.js')));
  const updated = await registerMcp({ ...RECORD, previous: PREVIOUS }, depsOf(replaced.run), 'update');
  assert.equal(updated.status, 'ok');
  assert.deepEqual(argvOf(replaced), [
    ['mcp', 'get', 'okit'],
    ['mcp', 'remove', 'okit', '--scope', 'user'],
    ['mcp', 'add', '--scope', 'user', 'okit', '--', CONFIG.node, SERVER],
  ]);
  const removed = fakeClient(claudeEntry(SERVER));
  const uninstalled = await registerMcp(RECORD, depsOf(removed.run), 'uninstall');
  assert.equal(uninstalled.status, 'ok');
  assert.deepEqual(argvOf(removed), [['mcp', 'get', 'okit'], ['mcp', 'remove', 'okit', '--scope', 'user']]);
});

test('a client that does not say where an entry is kept keeps an entry that is not ours, as before', async () => {
  const client = twoWorlds({ project: PROJECT_ENTRY, global: FOREIGN_GLOBAL, neutral: NEUTRAL });
  const result = await registerMcp({ ...CODEX, previous: CODEX_PREVIOUS }, { ...depsOf(client.run), mcpCwd: NEUTRAL }, 'update');
  assert.equal(result.status, 'kept');
  assert.match(result.detail, /not ours/, result.detail);
  assert.deepEqual(client.argv().map((words) => words[1]), ['get']);
  assert.equal(client.state.global, FOREIGN_GLOBAL);
});

test('the dry run of a client that does not say where an entry is kept shows the plan and writes nothing', () => {
  const plan = mcpPlan({ ...CODEX, previous: CODEX_PREVIOUS }, depsOf(() => {}), 'update');
  assert.deepEqual(plan.steps, [plan.get, plan.add]);
});

// ---------------------------------------------------------------------------------------------------------------
// D110 correction round 8: the value of the arguments line is read exactly, as the client wrote it.

test('an arguments line that ends with a space is not our path', async () => {
  const text = claudeEntry(`${SERVER} `);
  assert.equal(pointsAt(text, [SERVER]), false);
  // A client that would take our entry out leaves the entry of somebody else alone.
  const removed = fakeClient(text);
  const uninstalled = await registerMcp(RECORD, depsOf(removed.run), 'uninstall');
  assert.equal(uninstalled.status, 'kept');
  assert.deepEqual(argvOf(removed), [['mcp', 'get', 'okit']]);
  const updated = fakeClient(text);
  const replaced = await registerMcp({ ...RECORD, previous: PREVIOUS }, depsOf(updated.run), 'update');
  assert.equal(replaced.status, 'kept');
  assert.deepEqual(argvOf(updated), [['mcp', 'get', 'okit']]);
});

test('an arguments line that ends with a carriage return is our path', () => {
  const text = claudeEntry(SERVER).replaceAll('\n', '\r\n');
  assert.equal(pointsAt(text, [SERVER]), true);
  assert.equal(pointsAt(codexEntry(SERVER).replaceAll('\n', '\r\n'), [SERVER]), true);
});

test('a path with spaces inside it is still our path', () => {
  assert.equal(pointsAt(claudeEntry(SPACED_SERVER), [SPACED_SERVER]), true);
  assert.equal(pointsAt(codexEntry(SPACED_SERVER), [SPACED_SERVER]), true);
});

// ---------------------------------------------------------------------------------------------------------------
// D110 correction round 9: the ownership of an entry needs the real stdio arguments field. The fields of an entry are
// the lines indented by exactly two spaces (the nested lists, such as the headers or the environment, are indented
// four), and only a stdio entry (the `Type` field of Claude Code, the `transport` field of Codex) can be ours: a server
// of another type never runs our server, even when one of its headers holds a line that looks like the arguments.
//
// Must pass / must refuse:
// | case | must pass | must refuse |
// | a stdio entry of ours | our path, whole | the arguments of somebody else |
// | an HTTP server whose header holds our path | the entry is kept | the remove and the add |
// | an HTTP server whose header holds a `Type: stdio` | the entry is kept | the remove and the add |
// | an entry that names no type | the entry is kept | the remove and the add |
// | a nested line that looks like the arguments | the field of the entry | the nested line |

// The entry of an HTTP server of Claude Code: the fields of the server are indented two spaces, the headers four.
const HTTP_ENTRY = `okit:\n  Scope: User config (available in all your projects)\n  Status: Connected\n  Type: http\n  URL: https://example.com/mcp\n  Headers:\n    Args: ${SERVER}\n`;
// The same server, with a header that holds the type of a stdio server and our path.
const HTTP_WITH_STDIO_HEADER = `okit:\n  Scope: User config (available in all your projects)\n  Type: http\n  URL: https://example.com/mcp\n  Headers:\n    Type: stdio\n    Args: ${SERVER}\n`;
// The entry of an HTTP server of Codex: it names no arguments line at all.
const CODEX_HTTP = 'okit\n  enabled: true\n  transport: streamable_http\n  url: https://example.com/mcp\n';
// The entry of a server that names our path as its arguments, but is not a stdio one.
const NOT_STDIO_WITH_OUR_PATH = `okit\n  enabled: true\n  transport: streamable_http\n  args: ${SERVER}\n`;
// The entry that names our path in a nested line only.
const NO_TYPE = `okit:\n  Command: node\n  Args: ${SERVER}\n`;

test('the header of an HTTP server that looks like the arguments field is not ours', async () => {
  assert.equal(pointsAt(HTTP_ENTRY, [SERVER]), false);
  for (const action of ['install', 'update', 'uninstall']) {
    const client = fakeClient(HTTP_ENTRY);
    const record = action === 'update' ? { ...RECORD, previous: PREVIOUS } : RECORD;
    const result = await registerMcp(record, depsOf(client.run), action);
    // The entry of somebody else is kept: nothing is written nor taken out.
    assert.equal(result.status, 'kept', action);
    assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit']], action);
  }
});

test('the header of an HTTP server that holds the type of a stdio server is not ours', async () => {
  assert.equal(pointsAt(HTTP_WITH_STDIO_HEADER, [SERVER]), false);
  const client = fakeClient(HTTP_WITH_STDIO_HEADER);
  const result = await registerMcp(RECORD, depsOf(client.run), 'uninstall');
  assert.equal(result.status, 'kept');
  assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit']]);
});

test('the entry of a server that is not a stdio one is not ours, whatever its arguments hold', async () => {
  assert.equal(pointsAt(CODEX_HTTP, [SERVER]), false);
  assert.equal(pointsAt(NOT_STDIO_WITH_OUR_PATH, [SERVER]), false);
  const client = fakeClient(NOT_STDIO_WITH_OUR_PATH);
  const result = await registerMcp({ ...RECORD, client: 'codex' }, depsOf(client.run), 'uninstall');
  assert.equal(result.status, 'kept');
  assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit']]);
});

test('the entry that names no type is not ours', async () => {
  assert.equal(pointsAt(NO_TYPE, [SERVER]), false);
  const client = fakeClient(NO_TYPE);
  const result = await registerMcp(RECORD, depsOf(client.run), 'install');
  assert.equal(result.status, 'kept');
  assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit']]);
});

test('the nested line that looks like the arguments is not the arguments of the entry', () => {
  // The environment holds a line that looks like the arguments of the entry, before the field of the entry.
  const nested = `okit:\n  Scope: User config (available in all your projects)\n  Type: stdio\n  Command: node\n  Environment:\n    Args: ${SERVER}\n`;
  assert.equal(pointsAt(nested, [SERVER]), false);
  // The field of the entry is the one that is read, not the nested one.
  const ours = `okit:\n  Scope: User config (available in all your projects)\n  Type: stdio\n  Command: node\n  Environment:\n    Args: /somewhere/else/server.js\n  Args: ${SERVER}\n`;
  assert.equal(pointsAt(ours, [SERVER]), true);
  const foreign = `okit:\n  Scope: User config (available in all your projects)\n  Type: stdio\n  Command: node\n  Environment:\n    Args: ${SERVER}\n  Args: /somewhere/else/server.js\n`;
  assert.equal(pointsAt(foreign, [SERVER]), false);
});

test('our own entries are still ours, the carriage returns of a CRLF output too', () => {
  const claude = `okit:\n  Scope: User config (available in all your projects)\n  Status: Failed to connect\n  Issue: CONNECTION_CLOSED: Connection closed\n  Type: stdio\n  Command: node\n  Args: ${SERVER}\n  Environment:\n`;
  assert.equal(pointsAt(claude, [SERVER]), true);
  assert.equal(pointsAt(claude.replaceAll('\n', '\r\n'), [SERVER]), true);
  assert.equal(pointsAt(codexEntry(SERVER), [SERVER]), true);
  assert.equal(pointsAt(codexEntry(SERVER).replaceAll('\n', '\r\n'), [SERVER]), true);
});

test('the header of a server that holds a scope is not the scope of the entry', async () => {
  // The scope of the entry is a field of the entry: a header that holds one is not it.
  const header = `okit:\n  Type: stdio\n  Command: node\n  Args: ${SERVER}\n  Headers:\n    Scope: Project config\n`;
  assert.equal(pointsAt(header, [SERVER]), true);
  const client = fakeClient(header);
  const result = await registerMcp(RECORD, depsOf(client.run), 'install');
  // The entry is ours: the scope of the header did not make it an entry of another scope.
  assert.equal(result.status, 'skipped');
  assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit']]);
});

// ---------------------------------------------------------------------------------------------------------------
// D110 correction round 10: the clients print the arguments of an entry joined by spaces, never quoted, so a path
// that holds whitespace cannot be told apart from a foreign entry whose arguments were split. The installer only
// adds the entry that is missing and leaves the one that is there, printing the commands to run by hand.
//
// Must pass / must refuse:
// | case | must pass | must refuse |
// | our path holds a space, the entry is there | the read alone; the commands by hand | the add and the remove |
// | our path holds a space, the entry is missing | the add | -- |
// | our path holds no space | the entry is ours, as before | -- |

// The installation this one replaces, in a folder whose name holds a space too.
const SPACED_PREVIOUS = join('/Users/me/Library/Application Support/okit/0.9.0');
const SPACED_PREVIOUS_SERVER = join(SPACED_PREVIOUS, 'src/mcp/server.js');

test('the arguments of a foreign entry that were split print the line of our path with a space', () => {
  // The foreign entry whose arguments were split: the client prints them joined by spaces, exactly like ours.
  const at = SPACED_SERVER.indexOf(' ');
  const foreign = [SPACED_SERVER.slice(0, at), SPACED_SERVER.slice(at + 1)];
  assert.equal(foreign.join(' '), SPACED_SERVER);
  assert.equal(codexEntry(foreign.join(' ')), codexEntry(SPACED_SERVER));
});

test('an entry of ours whose path holds a space is left as it is: nothing is written nor taken out', async () => {
  for (const action of ['install', 'update', 'uninstall']) {
    const client = fakeClient(claudeEntry(SPACED_SERVER));
    const record = { ...RECORD, path: SPACED, previous: { path: SPACED_PREVIOUS } };
    const result = await registerMcp(record, depsOf(client.run), action);
    // The entry is read and nothing else: no add, no remove.
    assert.equal(result.status, 'kept', action);
    assert.equal(result.manual, true, action);
    assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit']], action);
    // The warning names the commands to run by hand.
    assert.match(result.detail, /claude mcp remove okit --scope user/, result.detail);
    if (action === 'uninstall') assert.doesNotMatch(result.detail, /mcp add/, result.detail);
    else assert.match(result.detail, /claude mcp add --scope user okit --/, result.detail);
  }
});

test('an entry of ours whose path holds a space is left as it is in Codex too', async () => {
  for (const action of ['install', 'update', 'uninstall']) {
    const client = fakeClient(codexEntry(SPACED_SERVER));
    const record = { ...RECORD, client: 'codex', path: SPACED, previous: { path: SPACED_PREVIOUS } };
    const result = await registerMcp(record, depsOf(client.run), action);
    assert.equal(result.status, 'kept', action);
    assert.equal(result.manual, true, action);
    assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit']], action);
    assert.match(result.detail, /codex mcp remove okit/, result.detail);
    if (action === 'uninstall') assert.doesNotMatch(result.detail, /mcp add/, result.detail);
    else assert.match(result.detail, /codex mcp add okit --/, result.detail);
  }
});

test('the entry of the installation with a space that this one replaces is left as it is', async () => {
  const client = fakeClient(claudeEntry(SPACED_PREVIOUS_SERVER));
  const record = { ...RECORD, path: SPACED, previous: { path: SPACED_PREVIOUS } };
  const result = await registerMcp(record, depsOf(client.run), 'update');
  // The entry is ours, but the display cannot tell it from a foreign one: it is neither replaced nor taken out.
  assert.equal(result.status, 'kept');
  assert.equal(result.manual, true);
  assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit']]);
  assert.match(result.detail, /claude mcp remove okit --scope user ; claude mcp add --scope user okit --/, result.detail);
});

test('an installation whose path holds a space still adds the entry that is missing', async () => {
  const client = fakeClient(null);
  const result = await registerMcp({ ...RECORD, path: SPACED }, depsOf(client.run), 'install');
  assert.equal(result.status, 'ok');
  assert.deepEqual(argvOf(client), [
    ['mcp', 'get', 'okit'],
    ['mcp', 'add', '--scope', 'user', 'okit', '--', CONFIG.node, SPACED_SERVER],
  ]);
  // On the uninstall there is no entry to take out.
  const uninstalled = fakeClient(null);
  const removed = await registerMcp({ ...RECORD, path: SPACED }, depsOf(uninstalled.run), 'uninstall');
  assert.equal(removed.status, 'skipped');
  assert.deepEqual(argvOf(uninstalled), [['mcp', 'get', 'okit']]);
});

test('an entry that names no path of ours is kept on an installation whose path holds a space, as before', async () => {
  for (const action of ['install', 'update', 'uninstall']) {
    const client = fakeClient(claudeEntry('/somewhere/else/src/mcp/server.js'));
    const record = { ...RECORD, path: SPACED, previous: { path: SPACED_PREVIOUS } };
    const result = await registerMcp(record, depsOf(client.run), action);
    assert.equal(result.status, 'kept', action);
    assert.match(result.detail, /not ours/, result.detail);
    assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit']], action);
  }
});

test('an installation whose path holds no space owns its entry, as before', async () => {
  const installed = fakeClient(claudeEntry(SERVER));
  const already = await registerMcp(RECORD, depsOf(installed.run), 'install');
  assert.equal(already.status, 'skipped');
  assert.match(already.detail, /already registered/, already.detail);
  assert.deepEqual(argvOf(installed), [['mcp', 'get', 'okit']]);
  const replaced = fakeClient(claudeEntry(join(PREVIOUS.path, 'src/mcp/server.js')));
  const updated = await registerMcp({ ...RECORD, previous: PREVIOUS }, depsOf(replaced.run), 'update');
  assert.equal(updated.status, 'ok');
  assert.deepEqual(argvOf(replaced), [
    ['mcp', 'get', 'okit'],
    ['mcp', 'remove', 'okit', '--scope', 'user'],
    ['mcp', 'add', '--scope', 'user', 'okit', '--', CONFIG.node, SERVER],
  ]);
  const removed = fakeClient(claudeEntry(SERVER));
  const uninstalled = await registerMcp(RECORD, depsOf(removed.run), 'uninstall');
  assert.equal(uninstalled.status, 'ok');
  assert.deepEqual(argvOf(removed), [['mcp', 'get', 'okit'], ['mcp', 'remove', 'okit', '--scope', 'user']]);
});

// ---------------------------------------------------------------------------------------------------------------
// D110 correction round 11: the commands printed for the person to run by hand are quoted for the shell: the clients
// take an argv, a person pastes one line, and a path that holds whitespace has to stay one argument.
//
// Must pass / must refuse:
// | case | must pass | must refuse |
// | a word no shell reads differently | the word as it is | -- |
// | a word with a space, a quote, a `$`, a `;`, a `~`, nothing | the word quoted | the word as it is |
// | the command of a path that holds a space | the path quoted whole | the path split in two |

test('the shown command keeps the words no shell reads differently as they are', () => {
  const words = ['claude', 'mcp', 'add', '--scope', 'user', 'okit', '--', 'node', '/opt/okit/1.0.0/src/mcp/server.js'];
  assert.equal(shown(words), words.join(' '));
  assert.equal(shown(words, 'win32'), words.join(' '));
  assert.equal(shown(words, 'linux'), words.join(' '));
});

test('a word that a shell would read differently is quoted', () => {
  assert.equal(shown(['a b']), "'a b'");
  assert.equal(shown(["O'Brien"]), "'O'\\''Brien'");
  assert.equal(shown(['$HOME']), "'$HOME'");
  assert.equal(shown([';']), "';'");
  assert.equal(shown(['']), "''");
  assert.equal(shown(['~/okit']), "'~/okit'");
  assert.equal(shown(['*']), "'*'");
  // Only the word that needs it is quoted.
  assert.equal(shown(['a b', 'c']), "'a b' c");
});

test('on Windows the quote of a word doubles the quote of the word', () => {
  assert.equal(shown(["O'Brien"], 'win32'), "'O''Brien'");
  // A path of Windows that holds no whitespace is left as it is.
  assert.equal(shown(['C:\\Program\\okit\\server.js'], 'win32'), 'C:\\Program\\okit\\server.js');
  // One that holds whitespace is quoted whole.
  assert.equal(shown(['C:\\Program Files\\okit\\server.js'], 'win32'), "'C:\\Program Files\\okit\\server.js'");
});

test('the shown command is parsed by a shell as the very same argv', { skip: process.platform === 'win32' }, () => {
  const claude = mcpPlan({ ...RECORD, path: SPACED }, depsOf(() => {}));
  const codex = mcpPlan({ ...RECORD, client: 'codex', path: SPACED }, depsOf(() => {}));
  const argvs = [
    claude.add, claude.remove, codex.add, codex.remove,
    ['claude', 'mcp', 'add', '--scope', 'user', 'okit', '--', 'node', "/Users/me/O'Brien/Application Support/$HOME x/server.js"],
  ];
  for (const argv of argvs) {
    const printed = execFileSync('sh', ['-c', `printf "%s\\0" ${shown(argv)}`], { encoding: 'utf8' });
    const parsed = printed.split('\0');
    parsed.pop();
    assert.deepEqual(parsed, argv);
  }
});

test('the commands printed for the person are quoted for the shell, on Claude Code', async () => {
  const record = { ...RECORD, path: SPACED };
  const client = fakeClient(claudeEntry(SPACED_SERVER));
  const result = await registerMcp(record, depsOf(client.run), 'install');
  const plan = mcpPlan(record, depsOf(() => {}));
  // The entry of ours whose path holds a space is left as it is: the commands by hand are given.
  assert.equal(result.status, 'kept');
  assert.equal(result.manual, true);
  // The path is quoted whole: pasted in a terminal, it stays one argument.
  assert.ok(result.detail.includes(`'${SPACED_SERVER}'`), result.detail);
  assert.ok(result.detail.includes(`${shown(plan.remove)} ; ${shown(plan.add)}`), result.detail);
  // Nothing was written: the entry of the client was read alone.
  assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit']]);
});

test('the commands printed for the person are quoted for the shell, on Codex', async () => {
  const record = { ...RECORD, client: 'codex', path: SPACED };
  const client = fakeClient(codexEntry(SPACED_SERVER));
  const result = await registerMcp(record, depsOf(client.run), 'install');
  const plan = mcpPlan(record, depsOf(() => {}));
  assert.equal(result.status, 'kept');
  assert.equal(result.manual, true);
  assert.ok(result.detail.includes(`'${SPACED_SERVER}'`), result.detail);
  assert.ok(result.detail.includes(`${shown(plan.remove)} ; ${shown(plan.add)}`), result.detail);
  assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit']]);
});

test('the commands printed for the person are quoted for the shell, on a client that does not say where an entry is kept', async () => {
  // Codex, our entry of the version the installation replaces: nothing is written, the commands by hand are given.
  const record = { ...RECORD, client: 'codex', path: SPACED, previous: { path: PREVIOUS.path } };
  const client = fakeClient(codexEntry(join(PREVIOUS.path, 'src/mcp/server.js')));
  const result = await registerMcp(record, depsOf(client.run), 'update');
  const plan = mcpPlan(record, depsOf(() => {}));
  assert.equal(result.status, 'kept');
  assert.equal(result.manual, true);
  assert.ok(result.detail.includes(`'${SPACED_SERVER}'`), result.detail);
  assert.ok(result.detail.includes(`${shown(plan.remove)} ; ${shown(plan.add)}`), result.detail);
  assert.deepEqual(argvOf(client), [['mcp', 'get', 'okit']]);
});

test('the command printed for the person when the client refuses is quoted for the shell', async () => {
  const record = { ...RECORD, path: SPACED };
  const client = fakeClient(null);
  const calls = [];
  const run = async (input) => {
    calls.push(input.args);
    if (input.args[1] === 'add') throw new Error('the client refused the entry');
    return client.run(input);
  };
  const result = await registerMcp(record, depsOf(run), 'install');
  const plan = mcpPlan(record, depsOf(() => {}));
  assert.equal(result.status, 'failed');
  assert.ok(result.detail.includes(`'${SPACED_SERVER}'`), result.detail);
  assert.ok(result.detail.includes(shown(plan.add)), result.detail);
  // The command that ran is an argv: the path of the server is one argument.
  assert.deepEqual(calls, [
    ['mcp', 'get', 'okit'],
    ['mcp', 'add', '--scope', 'user', 'okit', '--', CONFIG.node, SPACED_SERVER],
  ]);
});

test('the command of the step that ran is printed quoted for the shell', async () => {
  const record = { ...RECORD, path: SPACED };
  const client = fakeClient(null);
  const lines = [];
  const ui = createPresenter({ write: (line) => lines.push(line), verbose: true });
  await registerMcp(record, { ...depsOf(client.run), ui }, 'install');
  const plan = mcpPlan(record, depsOf(() => {}));
  assert.ok(lines.some((line) => line.includes(shown(plan.add))), lines.join('\n'));
  assert.ok(lines.some((line) => line.includes(`'${SPACED_SERVER}'`)), lines.join('\n'));
  // The command that ran is still an argv: the path of the server is one argument.
  assert.deepEqual(argvOf(client), [
    ['mcp', 'get', 'okit'],
    ['mcp', 'add', '--scope', 'user', 'okit', '--', CONFIG.node, SPACED_SERVER],
  ]);
});
