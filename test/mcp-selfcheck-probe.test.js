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
function probe(args, { env = {} } = {}) {
  const result = spawnSync(process.execPath, [PROBE, ...args], {
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
  assert.ok(result.answer.mcp.error.length > 0, result.stdout);
  assert.equal(result.answer.api.ok, false, result.stdout);
});

test('a server that stops at once is a failed answer, and the probe stops too', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  const server = await serverOf(t, 'stops', 'process.exit(0);\n');
  const started = Date.now();
  const result = probe([server, '6000'], { env: { OKWORK_HOME: root } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.answer?.mcp.ok, false, result.stdout);
  assert.ok(Date.now() - started < 5000, 'the probe waited for a server that was gone');
});

test('a server that answers tools/list with no tools is a failed answer', { skip }, async (t) => {
  const root = await folder(t, 'okit-probe-root-');
  const server = await serverOf(t, 'no-tools', `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  const result = frame.method === 'tools/list' ? { tools: [] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\\n');
});
`);
  const result = probe([server, '6000'], { env: { OKWORK_HOME: root } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.answer?.mcp.ok, false, result.stdout);
  assert.match(result.answer.mcp.error, /no tools/, result.stdout);
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
  const result = frame.method === 'tools/list' ? { tools: [{ name: 'one' }] } : { protocolVersion: '2025-06-18' };
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
  const result = frame.method === 'tools/list' ? { tools: [{ name: 'other_tool' }] } : { protocolVersion: '2025-06-18' };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\\n');
});
lines.on('close', async () => { await control?.stop(); process.exit(0); });
`);
  const result = probe([server, '6000'], { env: { OKWORK_HOME: root } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.answer?.mcp.ok, true, `${result.stdout}${result.stderr}`);
  assert.equal(result.answer.api.ok, false, JSON.stringify(result.answer));
  assert.match(result.answer.api.error, /inbox_list/, JSON.stringify(result.answer));
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
  assert.match(result.answer.api.error, /did not open its control API/, JSON.stringify(result.answer));
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
  assert.match(result.answer.mcp.error, /answered initialize with an error/, result.stdout);
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
  assert.match(result.answer.mcp.error, /did not answer/, result.stdout);
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
