import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { installConfig } from '../src/install/config.js';
import { mcpPlan, registerMcp } from '../src/install/mcp-register.js';
import { TEXTS } from '../src/install/present.js';
import { fixture } from './helpers/install-fixture.js';

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

const CONFIG = installConfig({});
const RECORD = { client: 'claude-code', path: join('/opt', 'okit-plugin', '1.0.0-claude-code') };
const SERVER = join(RECORD.path, 'src/mcp/server.js');
const PREVIOUS = { client: 'claude-code', path: join('/opt', 'okit-plugin', '0.9.0-claude-code') };

/** The dependencies of the step: the installer's settings and the runner of the client. */
const depsOf = (run) => ({ config: CONFIG, run, out: () => {} });

/** The client of the test: what it holds for the entry `okit` and the commands it ran. */
function fakeClient(entry) {
  const calls = [];
  const run = async (input) => {
    calls.push(input);
    if (input.args[0] === 'mcp' && input.args[1] === 'get') {
      if (!entry) throw Object.assign(new Error('No MCP server found: okit'), { code: 1 });
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
