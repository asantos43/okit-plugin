// The local control API: the endpoint where a tool call comes in, the token
// that opens it, the frames it takes and the answers it gives.

import assert from 'node:assert/strict';
import * as filesystem from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { after, test } from 'node:test';

import { startControl } from '../src/mcp/control.js';
import { endpointFor } from '../src/mcp/control-endpoint.js';
import { respond } from '../src/mcp/server.js';
import { paths } from '../src/store.js';

// A socket path is limited to a hundred bytes, so the folders of these tests are
// short even where TMPDIR is a long path.
const SHORT_TMP = process.platform === 'win32' ? tmpdir() : '/tmp';

const { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } = filesystem;

// The modes of a folder and of a file are a fact of POSIX only.
const POSIX_ONLY = process.platform === 'win32' ? 'the modes are a fact of POSIX' : false;

// A table of two tools: one that answers and one that refuses.
const TOOLS = [
  {
    name: 'first',
    description: 'a tool that answers',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (args) => JSON.stringify({ ok: true, args }),
  },
  {
    name: 'second',
    description: 'a tool that refuses',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      throw new Error('the second tool refused');
    },
  },
];

const roots = [];
const running = [];

async function tempRoot() {
  const dir = await mkdtemp(join(SHORT_TMP, 'mcp-control-test-'));
  roots.push(dir);
  return dir;
}

after(async () => {
  // A stop that fails must not keep the folders of the test on the disk.
  for (const control of running) await control.stop().catch(() => {});
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

// Opens the API of a root and keeps it in the list of the ones to stop.
async function start({ root, tools = TOOLS, ...options } = {}) {
  const control = await startControl({
    tools,
    ctx: { root },
    version: '0.0.0',
    ...options,
  });
  assert.ok(control !== null, 'the api should have opened');
  running.push(control);
  return control;
}

// The client of the API, in the test itself: it opens a socket, writes a
// frame and reads a line back.
function open(endpoint, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: endpoint, ...options });
    const client = { socket, lines: [], waiters: [], buffer: '' };
    let connected = false;
    // The close of the socket is a promise from the start, so a test that
    // waits for it never misses the event.
    client.closed = new Promise((done) => socket.once('close', done));
    socket.on('data', (chunk) => {
      client.buffer += chunk.toString('utf8');
      let index = client.buffer.indexOf('\n');
      while (index >= 0) {
        const line = client.buffer.slice(0, index);
        client.buffer = client.buffer.slice(index + 1);
        const waiter = client.waiters.shift();
        if (waiter === undefined) client.lines.push(line);
        else waiter.resolve(line);
        index = client.buffer.indexOf('\n');
      }
    });
    const fail = (error) => {
      const waiter = client.waiters.shift();
      if (waiter !== undefined) {
        waiter.reject(error);
        return;
      }
      // A connection that never opened is a failure of the test itself.
      if (!connected) reject(error);
    };
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('the connection closed before the answer')));
    socket.once('connect', () => {
      connected = true;
      resolve(client);
    });
  });
}

// The next line of the socket: one that already came or one that comes next.
function nextLine(client) {
  if (client.lines.length > 0) return Promise.resolve(client.lines.shift());
  return new Promise((resolve, reject) => client.waiters.push({ resolve, reject }));
}

// Writes a frame: an object becomes a line of JSON, a string is written as
// it is.
function send(client, frame) {
  client.socket.write(typeof frame === 'string' ? frame : `${JSON.stringify(frame)}\n`);
}

// A bounded wait fails the test instead of leaving a stuck socket behind.
async function within(promise, milliseconds = 3000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('the api did not finish in time')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('a call over the api answers the text the mcp gives for the same call', async () => {
  const root = await tempRoot();
  const control = await start({ root });
  const client = await open(control.endpoint);

  send(client, { id: 1, token: control.token, tool: 'first', arguments: { a: 1 } });
  const answer = JSON.parse(await nextLine(client));

  const expected = await respond(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'first', arguments: { a: 1 } } },
    { tools: TOOLS, ctx: { root }, version: '0.0.0' },
  );

  assert.equal(answer.id, 1);
  assert.equal(answer.ok, true);
  assert.equal(answer.text, expected.result.content[0].text);
  client.socket.destroy();
});

test('a call without the token of the record is refused and the tool does not run', async () => {
  const root = await tempRoot();
  let called = 0;
  const tools = [{
    name: 'counted',
    description: 'a tool that counts the calls',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      called += 1;
      return 'done';
    },
  }];
  const control = await start({ root, tools });

  const wrong = await open(control.endpoint);
  send(wrong, { id: 1, token: `${control.token}0`, tool: 'counted', arguments: {} });
  const refused = JSON.parse(await nextLine(wrong));
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'unauthorized');
  await wrong.closed;

  const missing = await open(control.endpoint);
  send(missing, { id: 2, tool: 'counted', arguments: {} });
  const noToken = JSON.parse(await nextLine(missing));
  assert.equal(noToken.ok, false);
  assert.equal(noToken.error, 'unauthorized');
  await missing.closed;

  assert.equal(called, 0, 'the tool must not run without the token');
});

test('a frame that is too long is refused', async () => {
  const root = await tempRoot();
  const control = await start({ root, maxFrame: 1024 });
  const client = await open(control.endpoint);

  send(client, { id: 1, token: control.token, tool: 'first', arguments: { a: 'x'.repeat(2000) } });
  const answer = JSON.parse(await nextLine(client));
  assert.equal(answer.ok, false);
  assert.equal(answer.error, 'frame too large');
  await client.closed;
});

test('a connection over the limit is refused and the others keep answering', async () => {
  const root = await tempRoot();
  const control = await start({ root, maxConnections: 2 });

  const first = await open(control.endpoint);
  const second = await open(control.endpoint);
  const third = await open(control.endpoint);

  const refused = JSON.parse(await nextLine(third));
  assert.equal(refused.id, null);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'too many connections');
  await third.closed;

  send(first, { id: 1, token: control.token, tool: 'first', arguments: {} });
  assert.equal(JSON.parse(await nextLine(first)).ok, true);
  send(second, { id: 2, token: control.token, tool: 'first', arguments: {} });
  assert.equal(JSON.parse(await nextLine(second)).ok, true);

  first.socket.destroy();
  second.socket.destroy();
});

test('a connection that says nothing is closed', async (t) => {
  const root = await tempRoot();
  const control = await start({ root, idleMs: 150 });
  const client = await open(control.endpoint);
  t.after(() => client.socket.destroy());

  const started = Date.now();
  await within(client.closed, 1500);
  assert.ok(Date.now() - started >= 100, 'the connection waited for the idle time');
  assert.ok(Date.now() - started < 1500, 'the idle connection should close promptly');
});

test('the record of a dead process is pruned when the api opens', async () => {
  const root = await tempRoot();
  const dir = paths(root).control;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '999999.json'), JSON.stringify({
    pid: 999999,
    endpoint: endpointFor({ root, pid: 999999 }),
    token: 'tk-999999',
  }), 'utf8');
  await writeFile(join(dir, '999999.sock'), '', 'utf8');

  const control = await start({ root, isAlive: () => false });
  assert.ok(control.endpoint.endsWith('.sock'));

  await assert.rejects(stat(join(dir, '999999.json')), { code: 'ENOENT' });
  await assert.rejects(stat(join(dir, '999999.sock')), { code: 'ENOENT' });
});

test('a name the table does not hold is refused', async () => {
  const root = await tempRoot();
  const control = await start({ root });
  const client = await open(control.endpoint);

  send(client, { id: 1, token: control.token, tool: 'x', arguments: {} });
  const answer = JSON.parse(await nextLine(client));
  assert.equal(answer.ok, false);
  assert.equal(answer.error, 'unknown tool x');
  client.socket.destroy();
});

test('a tool that refuses answers with the message', async () => {
  const root = await tempRoot();
  const control = await start({ root });
  const client = await open(control.endpoint);

  send(client, { id: 1, token: control.token, tool: 'second', arguments: {} });
  const answer = JSON.parse(await nextLine(client));
  assert.equal(answer.ok, false);
  assert.equal(answer.error, 'the second tool refused');
  client.socket.destroy();
});

test('a line that is not json is refused', async () => {
  const root = await tempRoot();
  const control = await start({ root });
  const client = await open(control.endpoint);

  send(client, '{ not json\n');
  const answer = JSON.parse(await nextLine(client));
  assert.equal(answer.ok, false);
  assert.equal(answer.error, 'invalid frame');
  client.socket.destroy();
});

test('two frames in one write are answered in the order they came', async () => {
  const root = await tempRoot();
  const control = await start({ root });
  const client = await open(control.endpoint);

  send(client, `${JSON.stringify({ id: 1, token: control.token, tool: 'first', arguments: { a: 1 } })}\n`
    + `${JSON.stringify({ id: 2, token: control.token, tool: 'second', arguments: {} })}\n`);

  const one = JSON.parse(await nextLine(client));
  const two = JSON.parse(await nextLine(client));
  assert.equal(one.id, 1);
  assert.equal(one.ok, true);
  assert.equal(two.id, 2);
  assert.equal(two.ok, false);
  assert.equal(two.error, 'the second tool refused');
  client.socket.destroy();
});

test('stop takes the socket and the record away and can be called twice', async () => {
  const root = await tempRoot();
  const control = await start({ root });
  const record = join(paths(root).control, `${process.pid}.json`);
  await stat(record);

  await control.stop();
  await assert.rejects(stat(record), { code: 'ENOENT' });
  await assert.rejects(stat(control.endpoint), { code: 'ENOENT' });

  // Stopping twice is not a failure.
  await control.stop();
});

test('a root whose path is too long does not open the api', { skip: POSIX_ONLY }, async () => {
  const root = join(tmpdir(), 'x'.repeat(120));
  roots.push(root);
  const lines = [];
  const stderr = { write: (text) => lines.push(text) };

  const control = await startControl({ tools: TOOLS, ctx: { root }, version: '0.0.0', stderr });
  assert.equal(control, null);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^okit control api: /);
  assert.ok(!lines[0].includes(root), 'an open failure must not print the root');
  assert.match(lines[0], /^okit control api: (?:the endpoint is longer than \d+ bytes|could not open the endpoint(?: \([A-Z0-9_]+\))?)\n$/);
});

test('the socket and the record belong to the owner of the machine only', { skip: POSIX_ONLY }, async () => {
  const root = await tempRoot();
  const control = await start({ root });

  const record = join(paths(root).control, `${process.pid}.json`);
  assert.equal((await stat(control.endpoint)).mode & 0o777, 0o600);
  assert.equal((await stat(record)).mode & 0o777, 0o600);
});

test('the record says who listens, where and with which token', async () => {
  const root = await tempRoot();
  const control = await start({ root, version: '1.2.3' });

  const record = JSON.parse(await readFile(join(paths(root).control, `${process.pid}.json`), 'utf8'));
  assert.equal(record.pid, process.pid);
  assert.equal(record.endpoint, control.endpoint);
  assert.match(record.token, /^[0-9a-f]{64}$/);
  assert.equal(record.token, control.token);
  assert.equal(record.version, '1.2.3');
});

test('a frame that grows without a line break is refused', async () => {
  const root = await tempRoot();
  const control = await start({ root, maxFrame: 1024 });
  const client = await open(control.endpoint);

  // No line break at all: the limit is what stops it, not the end of a line.
  send(client, 'x'.repeat(2000));
  const answer = JSON.parse(await nextLine(client));
  assert.equal(answer.ok, false);
  assert.equal(answer.error, 'frame too large');
  await client.closed;
});

test('a slow call is answered before the one that came after it', async () => {
  const root = await tempRoot();
  const slow = {
    name: 'slow',
    description: 'a tool that takes its time',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return 'slow';
    },
  };
  const control = await start({ root, tools: [slow, ...TOOLS] });
  const client = await open(control.endpoint);

  send(client, `${JSON.stringify({ id: 1, token: control.token, tool: 'slow', arguments: {} })}\n`
    + `${JSON.stringify({ id: 2, token: control.token, tool: 'first', arguments: {} })}\n`);

  assert.equal(JSON.parse(await nextLine(client)).id, 1);
  assert.equal(JSON.parse(await nextLine(client)).id, 2);
  client.socket.destroy();
});

test('a socket file left by a run of the same process does not stop the api', { skip: POSIX_ONLY }, async () => {
  const root = await tempRoot();
  const dir = paths(root).control;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${process.pid}.sock`), '', 'utf8');

  const control = await start({ root });
  const client = await open(control.endpoint);
  send(client, { id: 1, token: control.token, tool: 'first', arguments: {} });
  assert.equal(JSON.parse(await nextLine(client)).ok, true);
  client.socket.destroy();
});

test('stop destroys a refused connection whose client keeps its side open', async (t) => {
  const root = await tempRoot();
  const control = await start({ root, maxConnections: 1 });
  const first = await open(control.endpoint);
  t.after(() => first.socket.destroy());
  const refused = await open(control.endpoint, { allowHalfOpen: true });
  t.after(() => refused.socket.destroy());

  assert.equal(JSON.parse(await within(nextLine(refused))).error, 'too many connections');
  assert.equal(refused.socket.writableEnded, false);
  assert.equal(refused.socket.destroyed, false);

  const started = Date.now();
  await within(control.stop());
  assert.ok(Date.now() - started < 500, 'a refused caller must not hold stop open');
  // The caller still has its write side open: a write now sees the peer gone.
  refused.socket.write('still here\n');
  await within(refused.closed);
  assert.equal(refused.socket.destroyed, true);
});

test('a refused connection whose client never closes is destroyed by its timeout', async (t) => {
  const root = await tempRoot();
  const control = await start({ root, maxConnections: 1 });
  const first = await open(control.endpoint);
  t.after(() => first.socket.destroy());
  const refused = await open(control.endpoint, { allowHalfOpen: true });
  t.after(() => refused.socket.destroy());

  assert.equal(JSON.parse(await within(nextLine(refused))).error, 'too many connections');
  // Nobody stops the api: the timeout of the refused socket does the work.
  // The caller keeps its write side open, so a write after the timeout is
  // what shows that the peer is gone.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  refused.socket.write('still here\n');
  await within(refused.closed);
  assert.equal(refused.socket.destroyed, true);
});

test('five frames in one write overflow a queue of two without running extra calls', async (t) => {
  const root = await tempRoot();
  const calls = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const slow = {
    ...TOOLS[0],
    name: 'slow',
    handler: async (args) => {
      calls.push(args.id);
      await held;
      return 'done';
    },
  };
  const control = await start({ root, tools: [slow], maxQueued: 2 });
  const client = await open(control.endpoint);
  t.after(() => client.socket.destroy());

  send(client, [1, 2, 3, 4, 5].map((id) => JSON.stringify({
    id, token: control.token, tool: 'slow', arguments: { id },
  })).join('\n') + '\n');
  const answer = JSON.parse(await within(nextLine(client)));
  assert.equal(answer.id, null);
  assert.equal(answer.ok, false);
  assert.equal(answer.error, 'too many pending calls');
  await within(client.closed);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.length <= 2, 'only the accepted calls may run');
  assert.ok(calls.every((id) => id <= 2), 'the excess frames must not run');
});

// Hold the first call until stop or the client close has discarded the rest.
for (const ending of ['stop', 'client close']) {
  test(`${ending} discards two frames waiting behind a running tool`, async (t) => {
    const root = await tempRoot();
    const calls = [];
    let enter;
    let release;
    const entered = new Promise((resolve) => { enter = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    t.after(() => release());
    const slow = {
      ...TOOLS[0],
      name: 'slow',
      handler: async () => {
        calls.push('slow');
        enter();
        await held;
        return 'done';
      },
    };
    const second = {
      ...TOOLS[0],
      name: 'recorded',
      handler: async () => {
        calls.push('recorded');
        return 'done';
      },
    };
    const control = await start({ root, tools: [slow, second] });
    const client = await open(control.endpoint);
    t.after(() => client.socket.destroy());

    send(client, ['slow', 'recorded', 'recorded'].map((tool, id) => JSON.stringify({
      id, token: control.token, tool, arguments: {},
    })).join('\n') + '\n');
    await within(entered);
    if (ending === 'stop') await within(control.stop());
    else client.socket.end();
    await within(client.closed);

    release();
    // Let the promise chain drain after the running handler returns.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['slow'], 'the queued tool must never run');
  });
}

test('a call that takes longer than the idle time still gets its answer', async (t) => {
  const root = await tempRoot();
  const slow = {
    ...TOOLS[0],
    name: 'slow',
    handler: async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return 'done';
    },
  };
  const control = await start({ root, tools: [slow], idleMs: 150 });
  const client = await open(control.endpoint);
  t.after(() => client.socket.destroy());

  const started = Date.now();
  send(client, { id: 1, token: control.token, tool: 'slow', arguments: {} });
  assert.deepEqual(JSON.parse(await within(nextLine(client))), { id: 1, ok: true, text: 'done' });
  assert.ok(Date.now() - started >= 350, 'the tool should outlast the idle time');
  const answered = Date.now();
  await within(client.closed, 1500);
  assert.ok(Date.now() - answered >= 100, 'the idle clock should restart after the answer');
});

test('a control folder that is a link is refused without pruning its target', { skip: POSIX_ONLY }, async () => {
  const root = await tempRoot();
  const target = await tempRoot();
  const record = join(target, '999999.json');
  const contents = JSON.stringify({
    pid: 999999,
    endpoint: endpointFor({ root, pid: 999999 }),
    token: 'tk-dead',
  });
  await writeFile(record, contents, 'utf8');
  await symlink(target, paths(root).control, 'dir');
  const lines = [];

  const control = await startControl({
    tools: TOOLS, ctx: { root }, version: '0.0.0',
    isAlive: () => false,
    stderr: { write: (text) => lines.push(text) },
  });
  if (control !== null) running.push(control);
  assert.equal(control, null);
  assert.equal(await readFile(record, 'utf8'), contents, 'the linked record must stay untouched');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /the control folder is not a plain folder of this user/);
  assert.ok(!lines[0].includes(root));
  assert.ok(!lines[0].includes(target));
});
