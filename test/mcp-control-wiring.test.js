// The server of the mcp with the control api: the api of a server that runs
// answers the same call the server answers, and it goes away with it.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { callControl } from '../src/mcp/control-client.js';
import { listRecords, writeRecord } from '../src/mcp/control-endpoint.js';

const { mkdtemp, rm, stat } = filesystem;

const SERVER = fileURLToPath(new URL('../src/mcp/server.js', import.meta.url));
// A tool that only reads the state of the root: it needs no network and no
// file outside it.
const TOOL = 'limits_status';
// How long the test waits for something the server does.
const WAIT_MS = 5000;

const roots = [];
const children = [];

async function tempRoot() {
  // The root has to be short: the socket of the api lives under it and a
  // socket path is limited to a hundred bytes.
  const dir = await mkdtemp(join(tmpdir(), 'okit-ctl-'));
  roots.push(dir);
  return dir;
}

after(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

// Starts the server as a child process and reads the frames it writes.
function startServer(root) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, OKWORK_HOME: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  const frames = [];
  const errors = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim() !== '') frames.push(JSON.parse(line));
      index = buffer.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => errors.push(chunk));
  return { child, frames, errors };
}

// Waits for a frame that answers what was asked.
async function waitFor(frames, predicate, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = frames.find(predicate);
    if (found !== undefined) return found;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// Sends one message of the protocol and waits for its answer.
async function ask(child, frames, id, method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return waitFor(frames, (frame) => frame.id === id);
}

// The handshake a client does before anything else.
async function handshake(child, frames) {
  const answer = await ask(child, frames, 1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'mcp-control-wiring-test', version: '0.0.0' },
  });
  assert.ok(answer !== null, 'the server should answer the handshake');
  assert.equal(answer.result.serverInfo.name, 'okit');
}

// The records of the folder, waiting for one to show up.
async function waitForRecords(root, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const records = await listRecords(root);
    if (records.length > 0) return records;
    if (Date.now() >= deadline) return [];
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// The code a child left with.
function exited(child) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

// A pid of a process that is not running any more.
async function deadPid() {
  const child = spawn(process.execPath, ['-e', '']);
  const pid = child.pid;
  await new Promise((resolve) => child.once('exit', resolve));
  return pid;
}

test('the api of a running server answers the same call the server answers', async () => {
  const root = await tempRoot();
  const server = startServer(root);
  await handshake(server.child, server.frames);

  const records = await waitForRecords(root);
  assert.equal(records.length, 1, 'the server should leave a record of its api');
  assert.equal(records[0].pid, server.child.pid);

  const overApi = await callControl({ root, tool: TOOL, arguments: {} });
  assert.equal(overApi.ok, true);

  const overMcp = await ask(server.child, server.frames, 2, 'tools/call', { name: TOOL, arguments: {} });
  assert.ok(overMcp !== null, 'the server should answer the call');
  assert.equal(overApi.text, overMcp.result.content[0].text);

  // The stdin closes: the server leaves, and the api leaves with it.
  server.child.stdin.end();
  assert.equal(await exited(server.child), 0);

  const folder = join(root, 'control');
  await assert.rejects(stat(join(folder, `${server.child.pid}.json`)), { code: 'ENOENT' });
  await assert.rejects(stat(join(folder, `${server.child.pid}.sock`)), { code: 'ENOENT' });
});

test('a record of a process that died is pruned when the server starts', async () => {
  const root = await tempRoot();
  const dead = await deadPid();
  await writeRecord(root, {
    pid: dead,
    endpoint: join(root, 'control', `${dead}.sock`),
    token: 'tk-dead',
    startedAt: Date.now(),
  });

  const server = startServer(root);
  await handshake(server.child, server.frames);

  const records = await waitForRecords(root);
  assert.equal(records.length, 1, 'only the record of the server that runs is left');
  assert.notEqual(records[0].pid, dead);
  await assert.rejects(stat(join(root, 'control', `${dead}.json`)), { code: 'ENOENT' });
  await assert.rejects(stat(join(root, 'control', `${dead}.sock`)), { code: 'ENOENT' });

  server.child.stdin.end();
  assert.equal(await exited(server.child), 0);
});
