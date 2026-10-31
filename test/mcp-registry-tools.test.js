// The tools built from the registry of the operations: the seven the server
// announces, the answers they give, the refusals they make and the shape of
// the schema the client reads.

import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';

import { inboxAdd } from '../src/inbox.js';
import { OPERATIONS, operation } from '../src/core/operations.js';
import { createServer } from '../src/mcp/server.js';
import { toolsFromRegistry } from '../src/mcp/registry-tools.js';
import { TOOLS, TOOL_NAMES } from '../src/mcp/tools.js';

const SEVEN = ['config_get', 'config_set', 'quota_show', 'quota_set', 'daemon', 'kit_detect', 'todo_check'];

const roots = [];

// The clients of the machine are not read by a test: the quota of a root is
// about the root, and the probe of the clients would read the machine.
const DETECT = { detectClients: async () => ({ clients: [] }), versions: {} };

async function tempRoot() {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-registry-test-'));
  roots.push(dir);
  return dir;
}

after(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

// The server talks over two streams, so the tests drive it the way a client
// does: frames in on one side, frames out on the other.
function harness(ctx, version = '9.9.9') {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = createServer({ tools: TOOLS, input, output, ctx, version });
  const seen = [];
  const waiters = [];
  let buffer = '';
  let id = 0;

  const feed = (frame) => {
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else seen.push(frame);
  };

  output.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line !== '') feed(JSON.parse(line));
    }
  });

  server.start();

  const next = () => (seen.length > 0
    ? Promise.resolve(seen.shift())
    : new Promise((resolve) => {
      waiters.push(resolve);
    }));

  return {
    send(message) {
      input.write(`${JSON.stringify(message)}\n`);
    },
    next,
    request(method, params) {
      id += 1;
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return next();
    },
    call(name, args) {
      return this.request('tools/call', { name, arguments: args });
    },
    text(frame) {
      return frame.result.content[0].text;
    },
    data(frame) {
      return JSON.parse(this.text(frame));
    },
    stop() {
      return server.stop();
    },
  };
}

// | tool        | a good call                    | an unknown argument      | a wrong type or a missing one |
// | config_get  | {}                             | {junk: true}             | {key: 42}                    |
// | config_set  | {key, value}                   | {junk: true}             | {}                           |
// | quota_show  | {}                             | {junk: true}             | {client: 42}                 |
// | quota_set   | {client, pct}                  | {junk: true}             | {pct: '80'}                  |
// | daemon      | {action: 'status'}             | {junk: true}             | {}                           |
// | kit_detect  | {}                             | {junk: true}             | 'not an object'              |
// | todo_check  | {}                             | {junk: true}             | {project: 42}                |
const GOOD = {
  config_get: {},
  config_set: { key: 'limits.global', value: '7' },
  quota_show: {},
  quota_set: { client: 'claude-code', pct: 80 },
  daemon: { action: 'status' },
  kit_detect: {},
  todo_check: {},
};

const UNKNOWN = { junk: true };

const WRONG = {
  config_get: { key: 42 },
  config_set: {},
  quota_show: { client: 42 },
  quota_set: { client: 'claude-code', pct: '80' },
  daemon: {},
  kit_detect: 'not an object',
  todo_check: { project: 42 },
};

test('the server announces the seven tools of the registry', async () => {
  const server = harness({ root: await tempRoot() });
  const list = await server.request('tools/list');
  const names = list.result.tools.map((tool) => tool.name);
  for (const name of SEVEN) assert.ok(names.includes(name), name);
  assert.deepEqual(names.slice(-SEVEN.length), SEVEN, 'the tools of the registry are the last ones');
  await server.stop();
});

test('every tool of the registry answers, refuses an unknown argument and refuses a wrong type', async () => {
  const root = await tempRoot();
  await writeFile(join(root, 'config.json'), JSON.stringify({ limits: { global: 3, clients: {} } }), 'utf8');
  const server = harness({ root, ...DETECT });

  for (const name of SEVEN) {
    const good = await server.call(name, GOOD[name]);
    assert.equal(good.result.isError, false, `${name} answered with an error: ${server.text(good)}`);
    assert.equal(typeof server.text(good), 'string');
    assert.ok(server.text(good).length > 0, `${name} answered nothing`);

    const unknown = await server.call(name, UNKNOWN);
    assert.equal(unknown.result.isError, true, `${name} accepted an argument it does not have`);
    assert.match(server.text(unknown), /unknown argument/);

    const wrong = await server.call(name, WRONG[name]);
    assert.equal(wrong.result.isError, true, `${name} accepted a wrong argument`);
    assert.equal(typeof server.text(wrong), 'string');
  }

  // Refused or not, the loop is still answering.
  assert.deepEqual((await server.request('ping')).result, {});
  await server.stop();
});

test('quota_set writes the reading and quota_show reads it back', async () => {
  const root = await tempRoot();
  const server = harness({ root, ...DETECT });

  const written = await server.call('quota_set', { client: 'claude-code', pct: 80 });
  assert.equal(written.result.isError, false, server.text(written));
  assert.equal(server.data(written).client, 'claude-code');
  assert.equal(server.data(written).pct, 80);

  const shown = await server.call('quota_show', { client: 'claude-code' });
  assert.equal(shown.result.isError, false, server.text(shown));
  const rows = server.data(shown).clients;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].client, 'claude-code');
  assert.equal(rows[0].reading.remainingPct, 80);
  await server.stop();
});

test('config_set writes the setting and config_get reads it back', async () => {
  const root = await tempRoot();
  const server = harness({ root });

  const written = await server.call('config_set', { key: 'limits.global', value: '7' });
  assert.equal(written.result.isError, false, server.text(written));
  assert.equal(server.data(written).after.value, 7);

  const shown = await server.call('config_get', { key: 'limits.global' });
  assert.equal(shown.result.isError, false, server.text(shown));
  const entries = server.data(shown).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, 'limits.global');
  assert.equal(entries[0].value, 7);
  await server.stop();
});

test('the published schema is a copy, not the schema of the registry', async () => {
  const tools = toolsFromRegistry(OPERATIONS);
  const tool = tools.find((entry) => entry.name === 'config_get');
  assert.notEqual(tool.inputSchema, operation('config_get').schema);

  const before = operation('config_get').schema.properties.key.description;
  tool.inputSchema.properties.key.description = 'changed by a client';
  assert.equal(operation('config_get').schema.properties.key.description, before);

  // The table of the server holds the same copy, not the schema of the entry.
  const published = TOOLS.find((entry) => entry.name === 'config_get');
  assert.notEqual(published.inputSchema, operation('config_get').schema);
});

test('the daemon does not publish the key only the command line takes', async () => {
  const entry = operation('daemon');
  assert.deepEqual(entry.cliOnly, ['table']);
  assert.ok(entry.schema.properties.table, 'the registry keeps the key for the command line');

  const tool = TOOLS.find((candidate) => candidate.name === 'daemon');
  assert.equal(tool.inputSchema.properties.table, undefined, 'the published schema has no table');
  assert.ok(tool.inputSchema.properties.action, 'the published schema has the action');

  const root = await tempRoot();
  const server = harness({ root });
  const refused = await server.call('daemon', { action: 'status', table: true });
  assert.equal(refused.result.isError, true);
  assert.match(server.text(refused), /unknown argument table/);
  await server.stop();
});

test('an entry that leaves the registry leaves the table of tools', () => {
  const fewer = OPERATIONS.filter((entry) => entry.name !== 'todo_check');
  const names = toolsFromRegistry(fewer).map((tool) => tool.name);
  assert.ok(!names.includes('todo_check'));
  assert.equal(names.length, SEVEN.length - 1);

  // Every entry of the registry is a tool of the server, and every tool of the
  // registry is in the table.
  for (const entry of OPERATIONS) assert.ok(TOOL_NAMES.includes(entry.name), entry.name);
});

test('a generated tool refuses null, an array, a hidden key and an inherited one like the core does', async () => {
  const root = await tempRoot();
  const tool = TOOLS.find((entry) => entry.name === 'quota_set');
  const hidden = { client: 'claude-code', pct: 50 };
  Object.defineProperty(hidden, 'extra', { value: 1, enumerable: false });
  const inherited = Object.create({ client: 'claude-code', pct: 50 });
  for (const args of [null, [], hidden, inherited, { client: 'claude-code', pct: 50, [Symbol('x')]: 1 }]) {
    await assert.rejects(tool.handler(args, { root, ...DETECT }), TypeError);
  }
});

test('daemon answers the state it keeps: status, pause, status again and resume', async () => {
  const root = await tempRoot();
  const server = harness({ root, ...DETECT, now: () => 1_700_000_000_000 });

  const before = server.data(await server.call('daemon', { action: 'status' }));
  assert.deepEqual(before, { running: false, pid: null, startedAt: null, paused: false, lastTick: null });

  assert.deepEqual(server.data(await server.call('daemon', { action: 'pause' })), { paused: true });
  assert.equal(server.data(await server.call('daemon', { action: 'status' })).paused, true);
  assert.deepEqual(server.data(await server.call('daemon', { action: 'resume' })), { paused: false });
  assert.equal(server.data(await server.call('daemon', { action: 'status' })).paused, false);
  await server.stop();
});

test('kit_detect probes the kit of the root with the runner the server gives it', async () => {
  const root = await tempRoot();
  const kit = join(root, 'fake-kit');
  await writeFile(kit, '#!/bin/sh\n', 'utf8');
  await chmod(kit, 0o755);
  await writeFile(join(root, 'config.json'), JSON.stringify({ install: { kit: { path: kit } } }), 'utf8');
  const calls = [];
  const run = async (call) => {
    calls.push(call);
    return { code: 0, stdout: 'kit 2.0.1\n', stderr: '' };
  };
  const server = harness({ root, ...DETECT, run });

  const probe = server.data(await server.call('kit_detect', {}));
  assert.equal(probe.state, 'installed');
  assert.equal(probe.path, kit);
  assert.equal(probe.version, 'kit 2.0.1');
  assert.equal(calls.length, 1, 'the probe runs the kit once, through the runner of the server');
  assert.equal(calls[0].command, kit);
  await server.stop();
});

test('todo_check reports the work without a task and the tasks without work', async () => {
  const root = await tempRoot();
  const project = await tempRoot();
  await writeFile(join(project, 'TODO.md'), '# Tasks\n\n## Inbox\n- [ ] Add search\n', 'utf8');
  await writeFile(join(root, 'config.json'),
    JSON.stringify({ todo: { projects: { [project]: { enabled: true } } } }), 'utf8');
  await inboxAdd(root, { title: 'Missing work', appliesTo: project });
  const server = harness({ root, ...DETECT });

  const checked = server.data(await server.call('todo_check', {}));
  assert.equal(checked.reports.length, 1);
  assert.equal(checked.reports[0].project, project);
  assert.deepEqual(checked.reports[0].demandsWithoutItem.map((item) => item.title), ['Missing work']);
  assert.deepEqual(checked.reports[0].itemsWithoutDemand.map((item) => item.text), ['Add search']);
  await server.stop();
});
