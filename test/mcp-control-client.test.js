// The client of the local control API: it finds a server that is alive, asks
// it to run one tool and says what went wrong when it cannot.

import assert from 'node:assert/strict';
import * as filesystem from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { after, test } from 'node:test';

import { callControl, findServers } from '../src/mcp/control-client.js';
import { startControl } from '../src/mcp/control.js';
import { endpointFor, openControlDir, writeRecord } from '../src/mcp/control-endpoint.js';
import { respond } from '../src/mcp/server.js';

// A socket path is limited to a hundred bytes, so the folders of these tests are
// short even where TMPDIR is a long path.
const SHORT_TMP = process.platform === 'win32' ? tmpdir() : '/tmp';

const { mkdtemp, rm } = filesystem;

// A table of three tools: one that answers, one that refuses and one that
// takes its time.
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
  {
    name: 'slow',
    description: 'a tool that takes its time',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return 'slow';
    },
  },
];

const roots = [];
const running = [];
const servers = [];
// The sockets the servers of the test accepted: a server closes only when
// they are gone.
const accepted = [];

async function tempRoot() {
  const dir = await mkdtemp(join(SHORT_TMP, 'mcp-client-test-'));
  roots.push(dir);
  return dir;
}

after(async () => {
  // A stop that fails must not keep the folders of the test on the disk.
  for (const control of running) await control.stop().catch(() => {});
  for (const socket of accepted) socket.destroy();
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

// Opens the api of a root and keeps it in the list of the ones to stop.
async function start({ root, tools = TOOLS, ...options } = {}) {
  const control = await startControl({ tools, ctx: { root }, version: '0.0.0', ...options });
  assert.ok(control !== null, 'the api should have opened');
  running.push(control);
  return control;
}

test('a call over the api answers the text the mcp gives for the same call', async () => {
  const root = await tempRoot();
  await start({ root });

  const answer = await callControl({ root, tool: 'first', arguments: { a: 1 } });
  assert.equal(answer.ok, true);

  const expected = await respond(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'first', arguments: { a: 1 } } },
    { tools: TOOLS, ctx: { root }, version: '0.0.0' },
  );
  assert.equal(answer.text, expected.result.content[0].text);
});

test('a tool that refuses answers with the message of the refusal', async () => {
  const root = await tempRoot();
  await start({ root });

  const answer = await callControl({ root, tool: 'second', arguments: {} });
  assert.equal(answer.ok, false);
  assert.equal(answer.error, 'the second tool refused');
});

test('a name the table does not hold is refused', async () => {
  const root = await tempRoot();
  await start({ root });

  const answer = await callControl({ root, tool: 'x', arguments: {} });
  assert.equal(answer.ok, false);
  assert.equal(answer.error, 'unknown tool x');
});

test('a folder with no server says that none is running', async () => {
  const root = await tempRoot();

  const answer = await callControl({ root, tool: 'first', arguments: {} });
  assert.equal(answer.ok, false);
  assert.equal(answer.error, 'no okit server is running for this state folder');
});

test('a record of a server that is not there says that nobody answers', async () => {
  const root = await tempRoot();
  await writeRecord(root, {
    pid: 999999,
    endpoint: endpointFor({ root, pid: 999999 }),
    token: 'tk-999999',
    startedAt: Date.now(),
  });

  const answer = await callControl({ root, tool: 'first', arguments: {}, isAlive: () => true });
  assert.equal(answer.ok, false);
  assert.equal(answer.error, 'no okit server answers on this state folder');
});

test('the client falls back to the older server when the newest one is gone', async () => {
  const root = await tempRoot();
  await start({ root });
  // A record of a process that is not there, but that the caller says is
  // alive: the client tries it first and moves on to the one that answers.
  await writeRecord(root, {
    pid: 999999,
    endpoint: endpointFor({ root, pid: 999999 }),
    token: 'tk-999999',
    startedAt: Date.now() + 1000,
  });

  const answer = await callControl({ root, tool: 'first', arguments: {}, isAlive: () => true });
  assert.equal(answer.ok, true);
  assert.match(answer.text, /"ok":true/);
});

test('a server that is slow says that it did not answer in time', async () => {
  const root = await tempRoot();
  await start({ root });

  const answer = await callControl({ root, tool: 'slow', arguments: {}, timeoutMs: 100 });
  assert.equal(answer.ok, false);
  assert.equal(answer.error, 'the okit server did not answer in 100 ms');
});

// Lines that are not an answer: not JSON, JSON that is not an object, and an
// object whose `ok` is not a boolean.
for (const junk of ['not json', '42', '{"ok":"yes","text":"x"}']) {
  test(`a server that answers ${junk} says that it was not understood`, async () => {
    const root = await tempRoot();
    await openControlDir(root);
    const endpoint = endpointFor({ root, pid: 999998 });
    const server = net.createServer((socket) => {
      accepted.push(socket);
      socket.write(`${junk}\n`);
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(endpoint, resolve));
    await writeRecord(root, { pid: 999998, endpoint, token: 'tk-999998', startedAt: Date.now() });

    const answer = await callControl({ root, tool: 'first', arguments: {}, isAlive: () => true });
    assert.equal(answer.ok, false, junk);
    assert.equal(answer.error, 'the okit server sent an answer that is not understood', junk);
  });
}

test('the servers of a folder come with the newest first', async () => {
  const root = await tempRoot();
  await start({ root });
  await writeRecord(root, {
    pid: 999999,
    endpoint: endpointFor({ root, pid: 999999 }),
    token: 'tk-999999',
    startedAt: Date.now() + 1000,
  });

  const found = await findServers(root, { isAlive: () => true });
  assert.equal(found.length, 2);
  assert.equal(found[0].pid, 999999);
  assert.equal(found[1].pid, process.pid);

  const one = await findServers(root, { isAlive: () => true, pid: process.pid });
  assert.equal(one.length, 1);
  assert.equal(one[0].pid, process.pid);
});

test('a server that takes the call and says nothing is not tried again', async () => {
  const root = await tempRoot();
  await openControlDir(root);
  // The newest server takes the connection and never answers: the call may
  // already have run there, so the older one is never asked.
  const quiet = net.createServer((socket) => {
    accepted.push(socket);
  });
  servers.push(quiet);
  await new Promise((resolve) => quiet.listen(endpointFor({ root, pid: 999998 }), resolve));
  let olderCalls = 0;
  const older = net.createServer((socket) => {
    olderCalls += 1;
    accepted.push(socket);
    socket.write(`${JSON.stringify({ id: 1, ok: true, text: 'answered' })}\n`);
  });
  servers.push(older);
  await new Promise((resolve) => older.listen(endpointFor({ root, pid: 999997 }), resolve));
  await writeRecord(root, {
    pid: 999998,
    endpoint: endpointFor({ root, pid: 999998 }),
    token: 'tk-999998',
    startedAt: Date.now() + 1000,
  });
  await writeRecord(root, {
    pid: 999997,
    endpoint: endpointFor({ root, pid: 999997 }),
    token: 'tk-999997',
    startedAt: Date.now(),
  });

  const answer = await callControl({ root, tool: 'first', arguments: {}, timeoutMs: 150, isAlive: () => true });
  assert.equal(answer.ok, false);
  assert.equal(answer.error, 'the okit server did not answer in 150 ms');
  assert.equal(olderCalls, 0, 'the older server must not be asked');
});

test('a server that closes without answering is not tried again', async () => {
  const root = await tempRoot();
  await openControlDir(root);
  // The newest server takes the connection and hangs up: the call may
  // already have run there, so the older one is never asked.
  const closing = net.createServer((socket) => {
    accepted.push(socket);
    socket.on('data', () => socket.destroy());
  });
  servers.push(closing);
  await new Promise((resolve) => closing.listen(endpointFor({ root, pid: 999998 }), resolve));
  let olderCalls = 0;
  const older = net.createServer((socket) => {
    olderCalls += 1;
    accepted.push(socket);
    socket.write(`${JSON.stringify({ id: 1, ok: true, text: 'answered' })}\n`);
  });
  servers.push(older);
  await new Promise((resolve) => older.listen(endpointFor({ root, pid: 999997 }), resolve));
  await writeRecord(root, {
    pid: 999998,
    endpoint: endpointFor({ root, pid: 999998 }),
    token: 'tk-999998',
    startedAt: Date.now() + 1000,
  });
  await writeRecord(root, {
    pid: 999997,
    endpoint: endpointFor({ root, pid: 999997 }),
    token: 'tk-999997',
    startedAt: Date.now(),
  });

  const answer = await callControl({ root, tool: 'first', arguments: {}, timeoutMs: 5000, isAlive: () => true });
  assert.equal(answer.ok, false);
  assert.equal(answer.error, 'the okit server closed the connection');
  assert.equal(olderCalls, 0, 'the older server must not be asked');
});

test('arguments that cannot be sent are refused without throwing', async () => {
  const root = await tempRoot();
  await start({ root });
  const circular = { name: 'loop' };
  circular.self = circular;

  const loop = await callControl({ root, tool: 'first', arguments: circular });
  assert.equal(loop.ok, false);
  assert.match(loop.error, /^the arguments cannot be sent: /);

  const big = await callControl({ root, tool: 'first', arguments: { value: 1n } });
  assert.equal(big.ok, false);
  assert.match(big.error, /^the arguments cannot be sent: /);

  // The arguments are refused before any server is looked for: the call
  // says what is wrong with them and not who could have answered.
  const empty = await tempRoot();
  const nowhere = await callControl({ root: empty, tool: 'first', arguments: circular });
  assert.equal(nowhere.ok, false);
  assert.match(nowhere.error, /^the arguments cannot be sent: /);
});

test('an answer cut in the middle of a character keeps its text', async () => {
  const root = await tempRoot();
  await openControlDir(root);
  const line = `${JSON.stringify({ id: 1, ok: true, text: 'ação' })}\n`;
  const bytes = Buffer.from(line, 'utf8');
  // The cut is in the middle of the two bytes of the first accent.
  const cut = bytes.indexOf(0xc3) + 1;
  const server = net.createServer((socket) => {
    accepted.push(socket);
    socket.write(bytes.subarray(0, cut));
    setTimeout(() => socket.write(bytes.subarray(cut)), 30);
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(endpointFor({ root, pid: 999998 }), resolve));
  await writeRecord(root, {
    pid: 999998,
    endpoint: endpointFor({ root, pid: 999998 }),
    token: 'tk-999998',
    startedAt: Date.now(),
  });

  const answer = await callControl({ root, tool: 'first', arguments: {}, isAlive: () => true });
  assert.equal(answer.ok, true);
  assert.equal(answer.text, 'ação');
});
