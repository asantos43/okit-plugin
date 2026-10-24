import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';

import { createServer } from '../src/mcp/server.js';
import { makeContext, TOOLS } from '../src/mcp/tools.js';

const NAMES = [
  'acquire_slot',
  'release_slot',
  'limits_status',
  'status',
  'classify',
  'profile_pick',
  'inbox_add',
  'inbox_list',
  'inbox_claim',
  'inbox_release',
  'inbox_set_status',
  'order_add',
  'order_list',
  'order_remove',
];

const roots = [];

test('MCP claims, lists ownership in both languages, refuses takeover and releases', async () => {
  const root = await tempRoot();
  const server = harness({ root });
  const item = server.data(await server.call('inbox_add', { title: 'claim me' }));
  const owner = { id: item.id, client: 'codex', session: 's', worktree: 'wt' };
  assert.equal(server.data(await server.call('inbox_claim', owner)).hold.session, 's');
  const listed = server.data(await server.call('inbox_list', {}))[0];
  assert.equal(listed.hold.client, 'codex');
  assert.match(listed.owner, /taken by codex/);
  assert.match(server.data(await server.call('inbox_list', { locale: 'pt-BR' }))[0].owner, /em posse de codex/);
  assert.equal((await server.call('inbox_claim', { ...owner, producer: true })).result.isError, true);
  assert.equal((await server.call('inbox_claim', { ...owner, session: 'other' })).result.isError, true);
  assert.equal(server.data(await server.call('inbox_release', { id: item.id, client: 'codex', session: 's' })).hold, undefined);
  await server.stop();
});

async function tempRoot() {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-test-'));
  roots.push(dir);
  return dir;
}

async function writeConfig(root, config) {
  await writeFile(join(root, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
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
    write(text) {
      input.write(text);
    },
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

test('the handshake answers initialize, the notification, ping and tools/list', async () => {
  const dir = await tempRoot();
  const server = harness({ root: dir });

  const init = await server.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  assert.equal(init.jsonrpc, '2.0');
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.deepEqual(init.result.serverInfo, { name: 'okit', version: '9.9.9' });

  // A notification is never answered: the next frame must be the ping.
  server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const ping = await server.request('ping');
  assert.deepEqual(ping.result, {});

  const list = await server.request('tools/list');
  assert.deepEqual(list.result.tools.map((tool) => tool.name), NAMES);
  for (const tool of list.result.tools) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 0);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  await server.stop();
});

test('an unsupported protocol version gets the default one back', async () => {
  const dir = await tempRoot();
  const server = harness({ root: dir });
  const older = await server.request('initialize', { protocolVersion: '2024-01-01' });
  assert.equal(older.result.protocolVersion, '2025-06-18');
  const missing = await server.request('initialize', {});
  assert.equal(missing.result.protocolVersion, '2025-06-18');
  await server.stop();
});

test('acquire_slot, limits_status and release_slot run against the state root', async () => {
  const dir = await tempRoot();
  const server = harness({ root: dir });

  const taken = await server.call('acquire_slot', { runId: 'run-1', client: 'alpha' });
  assert.equal(taken.result.isError, false);
  assert.deepEqual(server.data(taken), { ok: true, runId: 'run-1', client: 'alpha' });

  const status = await server.call('limits_status', {});
  assert.deepEqual(server.data(status).limits, { global: 3, clients: {} });
  assert.equal(server.data(status).live, 1);
  assert.deepEqual(server.data(status).byClient, { alpha: 1 });

  const freed = await server.call('release_slot', { runId: 'run-1' });
  assert.deepEqual(server.data(freed), { ok: true, runId: 'run-1' });
  assert.equal(server.data(await server.call('limits_status', {})).live, 0);

  // An unknown run is a refusal, not a failed call.
  const ghost = await server.call('release_slot', { runId: 'ghost' });
  assert.equal(ghost.result.isError, false);
  assert.deepEqual(server.data(ghost), { ok: false, reason: 'unknown run', runId: 'ghost' });
  await server.stop();
});

test('acquire_slot refuses the run that would pass the cap in config.json', async () => {
  const dir = await tempRoot();
  await writeConfig(dir, { limits: { global: 4, perClient: 1 } });
  const server = harness({ root: dir });

  const first = await server.call('acquire_slot', { runId: 'a', client: 'alpha' });
  assert.equal(server.data(first).ok, true);
  const refused = await server.call('acquire_slot', { runId: 'b', client: 'alpha' });
  assert.equal(refused.result.isError, false);
  assert.equal(server.data(refused).ok, false);
  assert.equal(server.data(refused).reason, 'default limit');
  // The refusal is the cap holding, not a slot quietly taken.
  assert.equal(server.data(await server.call('limits_status', {})).live, 1);

  const other = await server.call('acquire_slot', { runId: 'c', client: 'beta' });
  assert.equal(server.data(other).ok, true);
  await server.stop();
});

test('classify answers with an effort class and its reasons', async () => {
  const dir = await tempRoot();
  const server = harness({ root: dir });

  const hard = await server.call('classify', {
    title: 'migrate the inbox store',
    body: 'Move every record to the new layout.',
    kind: 'code',
  });
  assert.equal(hard.result.isError, false);
  assert.equal(server.data(hard).effort, 'hard');
  assert.ok(server.data(hard).reasons.length > 0);

  const simple = await server.call('classify', { title: 'fix a typo in the readme' });
  assert.equal(server.data(simple).effort, 'simple');
  await server.stop();
});

test('profile_pick uses the profiles in config.json', async () => {
  const dir = await tempRoot();
  await writeConfig(dir, {
    lowQuotaPct: 15,
    profiles: {
      alpha: {
        simple: { model: 'alpha-small', effort: 'low', maxTurns: 4 },
        normal: { model: 'alpha-mid', effort: 'medium', maxTurns: 8 },
      },
    },
  });
  const server = harness({ root: dir });

  const normal = await server.call('profile_pick', { client: 'alpha', effort: 'normal' });
  assert.equal(normal.result.isError, false);
  assert.deepEqual(server.data(normal), { model: 'alpha-mid', effort: 'medium', maxTurns: 8 });

  // Low quota steps the class down instead of reporting it.
  const low = await server.call('profile_pick', { client: 'alpha', effort: 'normal', quota: 5 });
  assert.deepEqual(server.data(low), { model: 'alpha-small', effort: 'low', maxTurns: 4 });

  const unknown = await server.call('profile_pick', { client: 'ghost', effort: 'normal' });
  assert.equal(unknown.result.isError, true);
  assert.match(server.text(unknown), /No profile for client/);
  await server.stop();
});

test('inbox_add, inbox_list and inbox_set_status share one inbox', async () => {
  const dir = await tempRoot();
  const server = harness({ root: dir });

  const added = await server.call('inbox_add', {
    title: 'write the release note',
    accept: ['the file exists'],
    kind: 'writing',
    appliesTo: 'mcp-server',
  });
  assert.equal(added.result.isError, false);
  const item = server.data(added);
  assert.match(item.id, /^I\d{6}$/);
  assert.equal(item.status, 'pending');
  assert.deepEqual(item.accept, ['the file exists']);
  assert.deepEqual(item.appliesTo, 'mcp-server');

  const shared = server.data(await server.call('inbox_add', { title: 'keep the docs in step' }));
  assert.equal(shared.appliesTo, undefined);

  const scoped = await server.call('inbox_list', { appliesTo: 'mcp-server' });
  // Newest first, and the item without appliesTo is shared, so it shows too.
  assert.deepEqual(server.data(scoped).map((each) => each.id), [shared.id, item.id]);
  assert.equal(server.data(scoped)[1].ref, `${item.id} (mcp-server)`);
  assert.equal(server.data(scoped)[0].ref, shared.id);
  await writeFile(join(dir, 'project.json'), JSON.stringify({ name: 'registered' }));
  const named = server.data(await server.call('inbox_list', { appliesTo: 'global' }));
  assert.equal(named[0].id, shared.id);
  assert.equal(named[0].ref, `${shared.id} (registered)`);

  const sharedOnly = server.data(await server.call('inbox_list', { appliesTo: 'global' }));
  assert.deepEqual(sharedOnly.map((each) => each.title), ['keep the docs in step']);

  const all = await server.call('inbox_list', { limit: 1 });
  assert.equal(server.data(all).length, 1);

  const moved = await server.call('inbox_set_status', { id: item.id, status: 'delegated' });
  assert.equal(server.data(moved).status, 'delegated');

  // pending -> consolidated is not a step in the sequence.
  const jump = await server.call('inbox_set_status', { id: shared.id, status: 'consolidated' });
  assert.equal(jump.result.isError, true);
  assert.match(server.text(jump), /cannot move/);
  await server.stop();
});

test('order_add, order_list and order_remove share one order store', async () => {
  const dir = await tempRoot();
  const server = harness({ root: dir });

  const added = await server.call('order_add', { text: 'never push to main', scope: 'all' });
  assert.equal(added.result.isError, false);
  const order = server.data(added);
  assert.match(order.id, /^G\d{6}$/);
  assert.equal(order.active, true);

  const listed = await server.call('order_list', {});
  assert.deepEqual(server.data(listed).map((each) => each.text), ['never push to main']);

  const removed = await server.call('order_remove', { id: order.id, reason: 'no longer wanted' });
  assert.equal(server.data(removed).active, false);
  assert.deepEqual(server.data(await server.call('order_list', {})), []);
  await server.stop();
});

test('order_remove needs a reason and supplies its own when none is given', async () => {
  const dir = await tempRoot();
  const server = harness({ root: dir });
  const order = server.data(await server.call('order_add', { text: 'run the tests before commit' }));
  const removed = await server.call('order_remove', { id: order.id });
  assert.equal(server.data(removed).revokedReason.length > 0, true);
  await server.stop();
});

// Must pass / must refuse table for the tool arguments:
// | case                 | must pass              | must refuse                     |
// | required text        | runId "r"              | runId 7, runId missing          |
// | known keys only      | {runId, client}        | a key the tool does not have    |
// | no arguments         | {}                     | any argument                    |
// | optional text        | body "x"               | body 7                          |
// | optional list        | accept ["a"]           | accept "a", accept [7]          |
// | optional count       | limit 1                | limit -1, limit 1.5             |
// | one of a list        | status "pending"       | status "later"                  |
// | quota reading        | quota 5                | quota "half", quota {junk: 1}   |
// | arguments an object  | {}                     | arguments "title"               |
const REFUSED = [
  ['acquire_slot', { runId: 7, client: 'alpha' }],
  ['acquire_slot', { runId: 'r' }],
  ['acquire_slot', { runId: 'r', client: 'alpha', waitMs: -1 }],
  ['release_slot', {}],
  ['limits_status', { junk: true }],
  ['classify', 'title'],
  ['classify', { title: 'x', body: 7 }],
  ['classify', { body: 'no title' }],
  ['classify', { title: 'x', ext: {} }],
  ['profile_pick', { client: 'alpha' }],
  ['profile_pick', { client: 'alpha', effort: 'gigantic' }],
  ['profile_pick', { client: 'alpha', effort: 'simple', quota: 'half' }],
  ['profile_pick', { client: 'alpha', effort: 'simple', quota: { junk: 1 } }],
  ['inbox_add', { title: '   ' }],
  ['inbox_add', { title: 'x', accept: 'a' }],
  ['inbox_add', { title: 'x', accepts: ['a'] }],
  ['inbox_list', { status: 'later' }],
  ['inbox_list', { limit: -1 }],
  ['inbox_list', { appliesTo: ['a', 'b'] }],
  ['inbox_set_status', { id: 'I000001' }],
  ['inbox_set_status', { id: 'I000001', status: 'weird' }],
  ['order_add', { text: 'x', scope: 'effort:gigantic' }],
  ['order_add', { text: 'x', until: 'yesterday' }],
  ['order_list', { appliesTo: 3 }],
  ['order_list', { activeOnly: true }],
  ['order_remove', {}],
  ['order_remove', { id: 'G999999' }],
];

test('every tool refuses the arguments it does not accept', async () => {
  const dir = await tempRoot();
  const server = harness({ root: dir });
  for (const [name, args] of REFUSED) {
    const frame = await server.call(name, args);
    assert.equal(frame.result.isError, true, `${name} ${JSON.stringify(args)} should be refused`);
    assert.equal(typeof frame.result.content[0].text, 'string');
  }
  // Refused or not, the loop is still answering.
  assert.deepEqual((await server.request('ping')).result, {});
  await server.stop();
});

test('an unknown method, an unknown tool and a message with no method are errors', async () => {
  const dir = await tempRoot();
  const server = harness({ root: dir });

  const unknown = await server.request('spawn', { stepId: 's1' });
  assert.equal(unknown.error.code, -32601);
  assert.equal(unknown.id > 0, true);

  const tool = await server.call('spawn', {});
  assert.equal(tool.error.code, -32602);
  assert.match(tool.error.message, /unknown tool spawn/);

  const nameless = await server.request('tools/call', {});
  assert.equal(nameless.error.code, -32602);

  server.send({ jsonrpc: '2.0', id: 99 });
  assert.equal((await server.next()).error.code, -32600);
  await server.stop();
});

// next() is not part of the public server; the harness reads the stream.
test('a malformed line is a parse error and the loop carries on', async () => {
  const dir = await tempRoot();
  const server = harness({ root: dir });

  server.write('{ this is not json\n');
  const parseError = await server.next();
  assert.equal(parseError.error.code, -32700);
  assert.equal(parseError.id, null);

  const after = await server.request('ping');
  assert.deepEqual(after.result, {});
  await server.stop();
});

test('a request split across two chunks is answered once', async () => {
  const dir = await tempRoot();
  const server = harness({ root: dir });

  const line = `${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' })}\n`;
  const cut = Math.floor(line.length / 2);
  server.write(line.slice(0, cut));
  // The first half is not a message, so nothing is answered until the rest
  // arrives with the newline that ends it.
  server.write(line.slice(cut));
  const listing = await server.next();
  assert.equal(listing.id, 7);
  assert.deepEqual(listing.result.tools.map((tool) => tool.name), NAMES);
  assert.deepEqual((await server.request('ping')).result, {});
  await server.stop();
});

test('the state root comes from OKWORK_HOME when no root is given', async () => {
  const dir = await tempRoot();
  const previous = process.env.OKWORK_HOME;
  process.env.OKWORK_HOME = dir;
  const server = harness(makeContext());
  try {
    const added = await server.call('inbox_add', { title: 'from the environment' });
    const listed = server.data(await server.call('inbox_list', {}));
    assert.deepEqual(listed.map((each) => each.id), [server.data(added).id]);
  } finally {
    if (previous === undefined) delete process.env.OKWORK_HOME;
    else process.env.OKWORK_HOME = previous;
    await server.stop();
  }
});
