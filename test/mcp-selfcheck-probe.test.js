import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

// The probe of the install self-check: it starts the MCP server of the installation under a temporary state root and
// asks it two things: does it answer the protocol (`initialize` and `tools/list`), and does its own control API answer
// a tool call.
//
// | case | must pass | must refuse |
// | the real server | both answers true, exit 0 | a server left behind |
// | a server that is not there | mcp.ok false, exit 0 | a crash, an exit 1 |
// | a server that stops at once | mcp.ok false, exit 0 | a hang |
// | a server with no tools | mcp.ok false | a pass |
// | a server that never answers | mcp.ok false inside the budget | a server left behind |
// | no state root | exit 2, no server started | the state of the person |
// | a server that starts a process of its own | no process left behind | a grandchild left behind |
// | a budget that is over | no new wait, a bounded time | a wait of a second more |
// | a frame that is not the protocol | the code of the failure | a pass |
// | a line that never ends | the code of the failure, stopped at once | a wait for a newline that never comes |
// | an error stream that never ends | the last 4 KiB of it | the whole of it |
// | a flood of answers | only the two of the questions kept | every answer kept |
//
// The two answers of the probe are earned one by one: the protocol answered is not the control API answering, and the
// control API of another process is not the control API of ours.
//
// | case | must pass | must refuse |
// | a control API that does not run the tool | mcp.ok true, api.ok false | an api.ok true |
// | a control record of another process | api.ok false, our own API named | the record of another process taken as ours |
// | initialize answered with an error | mcp.ok false | an mcp.ok true |
// | initialize never answered | mcp.ok false | an mcp.ok true |
// | the server of ours | the probe is quick, no record and no socket left | a server left behind |

const REPO = fileURLToPath(new URL('../', import.meta.url));
const PROBE = join(REPO, 'src/mcp/selfcheck-probe.js');
const SERVER = join(REPO, 'src/mcp/server.js');
const CONTROL = join(REPO, 'src/mcp/control.js');
const POSIX = process.platform !== 'win32';
const skip = POSIX ? false : 'posix only';

/** The answer of the probe: the last line it printed, as JSON. */
function answerOf(stdout) {
  const lines = String(stdout ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  try { return JSON.parse(lines.at(-1) ?? ''); } catch { return null; }
}

/** Runs the probe and gives what it answered. */
function probe(args, { env = {}, at = PROBE } = {}) {
  const result = spawnSync(process.execPath, [at, ...args], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env },
  });
  return { ...result, answer: answerOf(result.stdout) };
}

/** Whether a process is still there. */
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function folder(t, name) {
  const path = await fs.mkdtemp(join(tmpdir(), name));
  t.after(() => fs.rm(path, { recursive: true, force: true }));
  return path;
}

/** A server of the test: a file that does what the case needs. */
async function serverOf(t, name, body) {
  const path = join(await folder(t, 'okit-probe-server-'), `${name}.cjs`);
  await fs.writeFile(path, body);
  return path;
}

/** A server of the test that is a module of its own (it imports the modules of the installation). */
async function moduleOf(t, name, body) {
  const path = join(await folder(t, 'okit-probe-server-'), `${name}.mjs`);
  await fs.writeFile(path, body);
  return path;
}

/** Waits until the record of a server is in the control folder of the root; the path of the record. */
async function untilRecord(root, pid, ms = 5000) {
  const file = join(root, 'control', `${pid}.json`);
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fs.stat(file).then(() => true, () => false)) return file;
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  throw new Error(`the server ${pid} wrote no record in ${root}`);
}

test('the real MCP server answers the protocol and its control API answers a tool call', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  const result = probe([SERVER, '6000'], { env: { OKWORK_HOME: root } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.answer?.mcp.ok, true, `${result.stdout}${result.stderr}`);
  assert.ok(result.answer.mcp.tools > 0, JSON.stringify(result.answer));
  assert.equal(result.answer.api.ok, true, JSON.stringify(result.answer));
});

test('the real MCP server started through a link to its folder still answers (a client may be given a linked path)', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  const where = await folder(t, 'okit-probe-link-');
  const link = join(where, 'plugin');
  await fs.symlink(join(REPO), link);
  const result = probe([join(link, 'src/mcp/server.js'), '6000'], { env: { OKWORK_HOME: root } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.answer?.mcp.ok, true, `${result.stdout}${result.stderr}`);
  assert.equal(result.answer.api.ok, true, JSON.stringify(result.answer));
});

test('the state of the person is never touched: the server works on the temporary root only', { skip }, async (t) => {
  const home = await folder(t, 'okit-probe-home-');
  const root = await folder(t, 'okit-probe-root-');
  const result = probe([SERVER, '6000'], { env: { OKWORK_HOME: root, HOME: home } });
  assert.equal(result.answer?.mcp.ok, true, `${result.stdout}${result.stderr}`);
  assert.deepEqual(await fs.readdir(home), [], 'the probe wrote in the home of the person');
});

test('a server that is not there is a failed answer, not a crash', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  const result = probe([join(root, 'no-server.cjs'), '2000'], { env: { OKWORK_HOME: root } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.answer?.mcp.ok, false, result.stdout);
  assert.ok(result.answer.mcp.error, result.stdout);
  assert.equal(result.answer.mcp.error.code, 'stopped', result.stdout);
  assert.equal(result.answer.api.ok, false, result.stdout);
});

test('a server that stops at once is a failed answer, and the probe stops too', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  const server = await serverOf(t, 'stops', 'process.exit(0);\n');
  const started = Date.now();
  const result = probe([server, '6000'], { env: { OKWORK_HOME: root } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.answer?.mcp.ok, false, result.stdout);
  assert.equal(result.answer.mcp.error.code, 'stopped', result.stdout);
  assert.ok(Date.now() - started < 5000, 'the probe waited for a server that was gone');
});

test('a server that answers tools/list with no tools is a failed answer', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  const server = await serverOf(t, 'no-tools', `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  const result = frame.method === 'tools/list' ? { tools: [] } : { protocolVersion: '2025-06-18', capabilities: {} };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\\n');
});
`);
  const result = probe([server, '6000'], { env: { OKWORK_HOME: root } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.answer?.mcp.ok, false, result.stdout);
  assert.equal(result.answer.mcp.error.code, 'no-tools', result.stdout);
});

test('a server that never answers is a failed answer inside the budget, and no server is left behind', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  const pid = join(root, 'pid.txt');
  const server = await serverOf(t, 'silent', `
require('node:fs').writeFileSync(${JSON.stringify(pid)}, String(process.pid));
setTimeout(() => {}, 60000);
`);
  const started = Date.now();
  const result = probe([server, '700'], { env: { OKWORK_HOME: root } });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.answer?.mcp.ok, false, result.stdout);
  assert.ok(elapsed < 700 + 2000, `the probe took ${elapsed} ms`);
  const child = Number(await fs.readFile(pid, 'utf8'));
  assert.ok(Number.isInteger(child) && child > 0, 'the server did not write its pid');
  assert.equal(alive(child), false, 'the server was left behind');
});

test('without a state root the probe refuses to run and starts no server', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  const pid = join(root, 'pid.txt');
  const server = await serverOf(t, 'silent', `
require('node:fs').writeFileSync(${JSON.stringify(pid)}, String(process.pid));
setTimeout(() => {}, 60000);
`);
  const env = { ...process.env };
  delete env.OKWORK_HOME;
  const result = spawnSync(process.execPath, [PROBE, server, '6000'], { encoding: 'utf8', timeout: 60000, env });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '', 'the probe printed something');
  await assert.rejects(fs.stat(pid), { code: 'ENOENT' }, 'the probe started the server without a state root');
});

test('a time that is not a whole number of milliseconds is refused', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  for (const asked of ['0', '-1', '1.5', 'abc']) {
    const result = spawnSync(process.execPath, [PROBE, SERVER, asked], {
      encoding: 'utf8', timeout: 60000, env: { ...process.env, OKWORK_HOME: root },
    });
    assert.equal(result.status, 2, `${asked}: ${result.stderr}`);
    assert.equal(result.stdout, '', `${asked}: the probe printed something`);
  }
});

/** A server of the test that answers the protocol and nothing else. */
const ANSWERS_PROTOCOL = `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  const result = frame.method === 'tools/list' ? { tools: [{ name: 'one' }] } : { protocolVersion: '2025-06-18', capabilities: { tools: {} } };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\\n');
});
`;

/** A server of the test that answers the protocol and opens a control API that never answers a call. */
const ANSWERS_PROTOCOL_WITH_HUNG_CONTROL = `
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const control = path.join(process.env.OKWORK_HOME, 'control');
fs.mkdirSync(control, { recursive: true, mode: 0o700 });
const endpoint = path.join(control, process.pid + '.sock');
const server = net.createServer(() => { /* the connection is never answered */ });
server.listen(endpoint, () => {
  fs.writeFileSync(path.join(control, process.pid + '.json'), JSON.stringify({
    pid: process.pid, endpoint, token: 'token-of-the-test', startedAt: Date.now(),
  }), { mode: 0o600 });
});

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  const result = frame.method === 'tools/list' ? { tools: [{ name: 'one' }] } : { protocolVersion: '2025-06-18', capabilities: { tools: {} } };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\\n');
});
`;

test('a control API that does not run the tool is a failed answer, not a passed one', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  // A server of its own with a control API: its table holds no `inbox_list`, the tool the probe asks for.
  const server = await moduleOf(t, 'control', `
import { pathToFileURL } from 'node:url';
import readline from 'node:readline';

const { startControl } = await import(pathToFileURL(${JSON.stringify(CONTROL)}).href);
const tools = [{ name: 'other_tool', description: 'a tool that is not the one the probe asks for',
  inputSchema: { type: 'object' }, handler: async () => 'ok' }];
const control = await startControl({ tools, ctx: { root: process.env.OKWORK_HOME } });
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const frame = JSON.parse(line);
  const result = frame.method === 'tools/list' ? { tools: [{ name: 'other_tool' }] } : { protocolVersion: '2025-06-18', capabilities: { tools: {} } };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\\n');
});
lines.on('close', async () => { await control?.stop(); process.exit(0); });
`);
  const result = probe([server, '6000'], { env: { OKWORK_HOME: root } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.answer?.mcp.ok, true, `${result.stdout}${result.stderr}`);
  assert.equal(result.answer.api.ok, false, JSON.stringify(result.answer));
  assert.equal(result.answer.api.error.code, 'control-error', JSON.stringify(result.answer));
  assert.match(result.answer.api.error.why, /inbox_list/, JSON.stringify(result.answer));
});

test('the control record of another process is not ours: our own API is the one that is asked', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  // A real server of ours on the same root, alive: its record is there, and it is not the record of the probe's server.
  const other = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, OKWORK_HOME: root } });
  t.after(() => { other.kill('SIGKILL'); });
  await untilRecord(root, other.pid);
  // The server of the probe answers the protocol but opens no control API at all.
  const server = await serverOf(t, 'no-control', ANSWERS_PROTOCOL);
  const result = probe([server, '700'], { env: { OKWORK_HOME: root } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.answer?.mcp.ok, true, `${result.stdout}${result.stderr}`);
  assert.equal(result.answer.api.ok, false, JSON.stringify(result.answer));
  assert.equal(result.answer.api.error.code, 'no-control-api', JSON.stringify(result.answer));
  other.kill('SIGKILL');
});

test('a server that answers initialize with an error is a failed answer', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  const server = await serverOf(t, 'bad-initialize', `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  const answer = frame.method === 'initialize'
    ? { jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'no initialize here' } }
    : { jsonrpc: '2.0', id: frame.id, result: { tools: [{ name: 'one' }] } };
  process.stdout.write(JSON.stringify(answer) + '\\n');
});
`);
  const result = probe([server, '2000'], { env: { OKWORK_HOME: root } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.answer?.mcp.ok, false, result.stdout);
  assert.equal(result.answer.mcp.error.code, 'init-error', result.stdout);
  assert.equal(result.answer.mcp.error.why, 'no initialize here', result.stdout);
});

test('a server that never answers initialize is a failed answer', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  const server = await serverOf(t, 'no-initialize', `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  if (frame.method === 'initialize') return;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { tools: [{ name: 'one' }] } }) + '\\n');
});
`);
  const result = probe([server, '2000'], { env: { OKWORK_HOME: root } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.answer?.mcp.ok, false, result.stdout);
  assert.equal(result.answer.mcp.error.code, 'timeout', result.stdout);
  assert.equal(result.answer.mcp.error.ms, 2000, result.stdout);
});

test('the server of ours ends by itself: the probe is quick and leaves no record and no socket', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  const started = Date.now();
  const result = probe([SERVER, '6000'], { env: { OKWORK_HOME: root } });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.answer?.mcp.ok, true, `${result.stdout}${result.stderr}`);
  // The server ended by itself (its input was closed), not by the kill of the probe.
  assert.ok(elapsed < 1200, `the probe took ${elapsed} ms`);
  const left = await fs.readdir(join(root, 'control')).catch(() => []);
  assert.deepEqual(left.filter((name) => name.endsWith('.sock') || name.endsWith('.json')), [],
    `the control folder holds ${left.join(', ')}`);
});

test('a server that starts a process of its own takes it with it: the probe leaves nothing behind', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  const pids = join(root, 'pids.json');
  const server = await serverOf(t, 'grandchild', `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ server: process.pid, child: child.pid }));
setTimeout(() => {}, 60000);
`);
  const result = probe([server, '700'], { env: { OKWORK_HOME: root } });
  assert.equal(result.status, 0, result.stderr);
  const written = JSON.parse(await fs.readFile(pids, 'utf8'));
  assert.ok(Number.isInteger(written.server) && written.server > 0, 'the server did not write its pid');
  assert.ok(Number.isInteger(written.child) && written.child > 0, 'the server did not write the pid of its process');
  // The group of the server is killed, so the process the server started goes with it.
  assert.equal(alive(written.server), false, 'the server was left behind');
  assert.equal(alive(written.child), false, 'the process the server started was left behind');
});

test('a server that ends by itself and leaves a process behind takes it with it', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  const pids = join(root, 'pids.json');
  const server = await serverOf(t, 'grandchild-leaves', `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const readline = require('node:readline');

const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ server: process.pid, child: child.pid }));

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const frame = JSON.parse(line);
  const result = frame.method === 'tools/list' ? { tools: [{ name: 'one' }] } : { protocolVersion: '2025-06-18', capabilities: { tools: {} } };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\\n');
});
lines.on('close', () => { process.exit(0); });
`);
  const result = probe([server, '700'], { env: { OKWORK_HOME: root } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.answer?.mcp.ok, true, `${result.stdout}${result.stderr}`);
  const written = JSON.parse(await fs.readFile(pids, 'utf8'));
  assert.ok(Number.isInteger(written.child) && written.child > 0, 'the server did not write the pid of its process');
  t.after(() => { try { process.kill(written.child, 'SIGKILL'); } catch { /* it is gone */ } });
  // The server ended by itself (its input was closed), so the group is killed once more: the process it left
  // behind is in that group, and goes with it.
  const until = Date.now() + 2000;
  let gone = false;
  while (Date.now() < until) {
    try { process.kill(written.child, 0); }
    catch (error) { if (error.code === 'ESRCH') { gone = true; break; } }
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  assert.ok(gone, 'the process the server started was left behind');
});

test('the handlers of the signals of the probe do not leak past the experiment', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  const server = await serverOf(t, 'good', ANSWERS_PROTOCOL);
  // The probe is a program of its own: it is imported by a helper of its own, which asks it for the handlers it
  // left behind once the experiment is over.
  const helper = join(await folder(t, 'okit-probe-helper-'), 'helper.mjs');
  await fs.writeFile(helper, `
import { pathToFileURL } from 'node:url';

process.argv = [process.argv[0], process.argv[1], ${JSON.stringify(server)}, '700'];
await import(pathToFileURL(${JSON.stringify(PROBE)}).href);
process.stdout.write('LISTENERS ' + JSON.stringify({ sigterm: process.listenerCount('SIGTERM'),
  sigint: process.listenerCount('SIGINT'), disconnect: process.listenerCount('disconnect') }) + '\\n');
`);
  const result = spawnSync(process.execPath, [helper], { encoding: 'utf8', timeout: 60000, env: { ...process.env, OKWORK_HOME: root } });
  const line = result.stdout.split('\n').map((item) => item.trim()).filter(Boolean).find((item) => item.startsWith('LISTENERS '));
  assert.ok(line, `the helper printed nothing: ${result.stdout}${result.stderr}`);
  assert.deepEqual(JSON.parse(line.slice('LISTENERS '.length)), { sigterm: 0, sigint: 0, disconnect: 0 });
});

test('a probe that is stopped takes the server group with it', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  const pids = join(root, 'pids.json');
  const server = await serverOf(t, 'grandchild', `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ server: process.pid, child: child.pid }));
setTimeout(() => {}, 60000);
`);
  const probe = spawn(process.execPath, [PROBE, server, '20000'], { env: { ...process.env, OKWORK_HOME: root }, stdio: 'ignore' });
  t.after(() => probe.kill('SIGKILL'));
  // The server and the process it started are there.
  const until = Date.now() + 10000;
  while (Date.now() < until && !await fs.stat(pids).then(() => true, () => false)) {
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  const written = JSON.parse(await fs.readFile(pids, 'utf8'));
  assert.ok(Number.isInteger(written.server) && written.server > 0, 'the server did not write its pid');
  // The probe is stopped: the server group goes with it.
  probe.kill('SIGTERM');
  await new Promise((resolve) => probe.on('exit', resolve));
  await new Promise((resolve) => { setTimeout(resolve, 100); });
  assert.equal(alive(written.server), false, 'the server was left behind');
  assert.equal(alive(written.child), false, 'the process the server started was left behind');
});

test('the budget is the budget: past it no new wait is granted to the control API', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  const server = await serverOf(t, 'hung-control', ANSWERS_PROTOCOL_WITH_HUNG_CONTROL);
  const budget = 700;
  const started = Date.now();
  const result = probe([server, String(budget)], { env: { OKWORK_HOME: root } });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.answer?.mcp.ok, true, `${result.stdout}${result.stderr}`);
  assert.equal(result.answer.api.ok, false, JSON.stringify(result.answer));
  assert.equal(result.answer.api.error.code, 'control-error', JSON.stringify(result.answer));
  // The call of the control API may not wait longer than what was left of the budget: a second more is not granted.
  const waited = Number(/did not answer in (\d+) ms/.exec(result.answer.api.error.why ?? '')?.[1]);
  assert.ok(Number.isInteger(waited), `the answer does not say how long it waited: ${result.answer.api.error.why}`);
  assert.ok(waited <= budget, `the probe waited ${waited} ms of a budget of ${budget} ms`);
  // The whole run stays inside the budget, the time the server takes to go and the time of the call.
  assert.ok(elapsed < budget + 3000, `the probe took ${elapsed} ms of a budget of ${budget} ms`);
});

test('a budget that is over grants nothing: the control API is never asked', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  const server = await serverOf(t, 'slow', `
const readline = require('node:readline');
setTimeout(() => {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const frame = JSON.parse(line);
    const result = frame.method === 'tools/list' ? { tools: [{ name: 'one' }] } : { protocolVersion: '2025-06-18', capabilities: { tools: {} } };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\\n');
  });
}, 3000);
`);
  const started = Date.now();
  const result = probe([server, '5'], { env: { OKWORK_HOME: root } });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.answer?.mcp.ok, false, result.stdout);
  assert.equal(result.answer.mcp.error.code, 'timeout', result.stdout);
  // The server never answered, so the control API was never asked: it has no answer at all.
  assert.equal(result.answer.api.ok, false, JSON.stringify(result.answer));
  assert.equal(result.answer.api.error, null, JSON.stringify(result.answer));
  assert.ok(elapsed < 3000, `the probe took ${elapsed} ms of a budget of 5 ms`);
});

test('a frame that is not the protocol is a failed answer, never a passed one', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  const cases = [
    { name: 'no-jsonrpc', line: '{"id":%ID%,"result":{"tools":[{"name":"one"}]}}' },
    { name: 'no-protocol-version', line: '{"jsonrpc":"2.0","id":%ID%,"result":{"capabilities":{}}}' },
    { name: 'no-server', line: '{"jsonrpc":"2.0","id":%ID%,"result":{"protocolVersion":"2025-06-18"}}' },
    { name: 'tools-not-objects', line: '{"jsonrpc":"2.0","id":%ID%,"result":{"tools":[7]}}' },
    { name: 'tool-without-name', line: '{"jsonrpc":"2.0","id":%ID%,"result":{"tools":[{"description":"no name"}]}}' },
    { name: 'tools-not-a-list', line: '{"jsonrpc":"2.0","id":%ID%,"result":{"tools":{}}}' },
  ];
  for (const one of cases) {
    const server = await serverOf(t, one.name, `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  process.stdout.write(${JSON.stringify(one.line)}.replace('%ID%', String(frame.id)) + '\\n');
});
`);
    const result = probe([server, '2000'], { env: { OKWORK_HOME: root } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.answer?.mcp.ok, false, `${one.name}: ${result.stdout}`);
    assert.equal(result.answer.mcp.error.code, 'bad-frame', `${one.name}: ${result.stdout}`);
    assert.ok(result.answer.mcp.error.why, `${one.name}: ${result.stdout}`);
  }
});

// D109 step 5: the probe is strict about the frames it keeps. A frame that is not the protocol is refused even when
// the shape of the answer is the right one: the shape alone would let a server of another protocol pass.

test('a frame that is not JSON-RPC 2.0 is a failed answer, even when the shape of the answer is the right one', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  for (const version of ['none', '1.0']) {
    const server = await serverOf(t, `no-jsonrpc-${version.replace('.', '-')}`, `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  const result = frame.method === 'tools/list' ? { tools: [{ name: 'one' }] } : { protocolVersion: '2025-06-18', capabilities: { tools: {} } };
  const answer = { id: frame.id, result };
  if (${JSON.stringify(version)} !== 'none') answer.jsonrpc = ${JSON.stringify(version)};
  process.stdout.write(JSON.stringify(answer) + '\\n');
});
`);
    const result = probe([server, '2000'], { env: { OKWORK_HOME: root } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.answer?.mcp.ok, false, `${version}: ${result.stdout}`);
    assert.equal(result.answer.mcp.error.code, 'bad-frame', `${version}: ${result.stdout}`);
    assert.equal(result.answer.mcp.error.why, 'jsonrpc', `${version}: ${result.stdout}`);
  }
});

test('an initialize answer without a protocol version is a failed answer, even when the tools are the right ones', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  for (const version of ['missing', 'empty']) {
    const server = await serverOf(t, `no-protocol-version-${version}`, `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  const result = frame.method === 'tools/list'
    ? { tools: [{ name: 'one' }] }
    : { capabilities: { tools: {} }, ...(${JSON.stringify(version)} === 'empty' ? { protocolVersion: '' } : {}) };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\\n');
});
`);
    const result = probe([server, '2000'], { env: { OKWORK_HOME: root } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.answer?.mcp.ok, false, `${version}: ${result.stdout}`);
    assert.equal(result.answer.mcp.error.code, 'bad-frame', `${version}: ${result.stdout}`);
    assert.equal(result.answer.mcp.error.why, 'initialize', `${version}: ${result.stdout}`);
  }
});

test('a tool of the list that has no name of its own is a failed answer, even when the initialize answer is the right one', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  for (const tools of ['[{"description":"x"}]', '[{"name":""}]']) {
    const server = await serverOf(t, `tool-without-name-${tools.length}`, `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  const result = frame.method === 'tools/list' ? { tools: ${tools} } : { protocolVersion: '2025-06-18', capabilities: { tools: {} } };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\\n');
});
`);
    const result = probe([server, '2000'], { env: { OKWORK_HOME: root } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.answer?.mcp.ok, false, `${tools}: ${result.stdout}`);
    assert.equal(result.answer.mcp.error.code, 'bad-frame', `${tools}: ${result.stdout}`);
    assert.equal(result.answer.mcp.error.why, 'tools/list', `${tools}: ${result.stdout}`);
  }
});

test('a budget that runs out after the record of the server is found asks nothing: the control API is never called', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  const where = await folder(t, 'okit-probe-client-');
  // The probe of the installation, copied as it is (only the client of the control API is faked), so the poll of the
  // record of the server takes longer than the budget of the probe.
  await fs.writeFile(join(where, 'package.json'), JSON.stringify({ type: 'module' }));
  await fs.copyFile(PROBE, join(where, 'selfcheck-probe.js'));
  const called = join(root, 'control-called.txt');
  const connections = join(root, 'connections.txt');
  const budget = 1000;
  const delay = 2000;
  await fs.writeFile(join(where, 'control-client.js'), `
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// The poll of the record takes longer than the budget of the probe: the record is found after the deadline.
export async function findServers(root) {
  await new Promise((resolve) => { setTimeout(resolve, ${delay}); });
  const dir = join(root, 'control');
  const names = await readdir(dir).catch(() => []);
  const records = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const record = JSON.parse(await readFile(join(dir, name), 'utf8').catch(() => 'null'));
    if (record && typeof record.pid === 'number') records.push(record);
  }
  return records;
}

// The call of the control API is never made: when it is, it says so in a file.
export async function callControl() {
  await writeFile(${JSON.stringify(called)}, 'the control API of the server was asked');
  return { ok: true, text: 'ok' };
}
`);
  // The server of the test: it answers the protocol at once and opens a control API that records every connection.
  const server = await serverOf(t, 'late-record', `
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const readline = require('node:readline');

const control = path.join(process.env.OKWORK_HOME, 'control');
fs.mkdirSync(control, { recursive: true });
const endpoint = path.join(control, process.pid + '.sock');
const api = net.createServer((socket) => {
  fs.appendFileSync(${JSON.stringify(connections)}, 'connection\\n');
  socket.destroy();
});
const record = () => fs.writeFileSync(path.join(control, process.pid + '.json'), JSON.stringify({
  pid: process.pid, endpoint, token: 'token-of-the-test', startedAt: Date.now(),
}));
api.on('error', record);
api.listen(endpoint, record);

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const frame = JSON.parse(line);
  const result = frame.method === 'tools/list' ? { tools: [{ name: 'one' }] } : { protocolVersion: '2025-06-18', capabilities: { tools: {} } };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\\n');
});
lines.on('close', () => { process.exit(0); });
`);
  const result = probe([server, String(budget)], { env: { OKWORK_HOME: root }, at: join(where, 'selfcheck-probe.js') });
  assert.equal(result.status, 0, result.stderr);
  // The protocol was answered: the failure is not there.
  assert.equal(result.answer?.mcp.ok, true, `${result.stdout}${result.stderr}`);
  // The budget ran out between the record that was found and the call: the code says so.
  assert.equal(result.answer.api.ok, false, JSON.stringify(result.answer));
  assert.equal(result.answer.api.error.code, 'timeout', JSON.stringify(result.answer));
  assert.equal(result.answer.api.error.ms, budget, JSON.stringify(result.answer));
  // The control API was never asked, and the server never received a control request.
  assert.equal(await fs.stat(called).catch(() => null), null, 'the control API was asked');
  assert.equal(await fs.stat(connections).catch(() => null), null, 'the server received a control request');
});

test('a server that answers the protocol right still passes after the strict answers', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  const server = await serverOf(t, 'good', ANSWERS_PROTOCOL);
  const result = probe([server, '2000'], { env: { OKWORK_HOME: root } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.answer?.mcp.ok, true, `${result.stdout}${result.stderr}`);
  assert.equal(result.answer.mcp.tools, 1, JSON.stringify(result.answer));
});

test('a line that never ends is stopped at once: the probe does not wait for a newline that will not come', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  const server = await serverOf(t, 'endless', `
const chunk = 'x'.repeat(65536);
const write = () => { process.stdout.write(chunk); setTimeout(write, 5); };
write();
setTimeout(() => {}, 60000);
`);
  const started = Date.now();
  const result = probe([server, '10000'], { env: { OKWORK_HOME: root } });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.answer?.mcp.ok, false, result.stdout);
  assert.equal(result.answer.mcp.error.code, 'long-line', result.stdout);
  assert.ok(elapsed < 6000, `the probe took ${elapsed} ms`);
});

test('an error stream that never ends keeps only its last 4 KiB', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  const server = await serverOf(t, 'endless-error', `
const chunk = 'e'.repeat(4096);
const write = () => { process.stderr.write(chunk); setTimeout(write, 5); };
write();
setTimeout(() => {}, 60000);
`);
  const result = probe([server, '1500'], { env: { OKWORK_HOME: root } });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.answer.stderr.length <= 4096, `the probe kept ${result.answer.stderr.length} bytes of the error stream`);
  assert.ok(result.answer.stderr.length > 0, 'the probe kept nothing of the error stream');
});

test('a flood of answers keeps only the two of the questions of the probe', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  const server = await serverOf(t, 'flood', `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  for (let id = 3; id < 300; id += 1) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [{ name: 'noise' }] } }) + '\\n');
  }
  const result = frame.method === 'tools/list' ? { tools: [{ name: 'one' }] } : { protocolVersion: '2025-06-18', capabilities: { tools: {} } };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\\n');
});
`);
  const result = probe([server, '3000'], { env: { OKWORK_HOME: root } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.answer?.mcp.ok, true, `${result.stdout}${result.stderr}`);
  assert.equal(result.answer.answers, 2, `the probe kept ${result.answer.answers} answers`);
});
