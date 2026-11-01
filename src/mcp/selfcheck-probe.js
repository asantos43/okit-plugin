// The probe of the install self-check: it starts the MCP server of one
// installation under a temporary state root and asks it two things: does it
// answer the protocol (`initialize` and `tools/list`), and does its own
// control API answer a tool call.
//
// The probe is a program of its own, started as a process by the installer
// (never imported by it), so the server runs the way a client starts it:
// `node <installation>/src/mcp/server.js`, with the state root of the check
// on the environment.
//
// The state root comes from OKWORK_HOME and the probe refuses to run without
// it (exit 2), so it can never reach the state of the person: the check gives
// it a temporary folder and removes it afterwards.
//
// The answer is one line of JSON on the standard output:
//   {"mcp":{"ok":true,"tools":12,"error":""},"api":{"ok":true,"error":""}}
// The exit code says whether the probe could run the experiment at all (0),
// not whether the server answered: what the server said is in the line.

import { spawn } from 'node:child_process';
import process from 'node:process';
import { StringDecoder } from 'node:string_decoder';

import { callControl, findServers } from './control-client.js';

// The variable that names the state root; the check sets it to a temporary
// folder and the probe refuses to run without it.
const HOME_ENV = 'OKWORK_HOME';
// How long the probe waits for the server, when the caller does not say.
const DEFAULT_MS = 6000;
// How often the probe looks for the record of the server.
const POLL_MS = 50;
// How long the server may take to go away before it is killed.
const STOP_MS = 1500;
// The tool the control API is asked for: one that only reads.
const READ_TOOL = 'inbox_list';
// The version of the protocol the probe speaks.
const PROTOCOL = '2025-06-18';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** A refusal of the probe itself: it cannot run the experiment, so it stops. */
class Refusal extends Error {}

/** The reason of a failure, in plain words. */
const reason = (error) => (error instanceof Error ? error.message : String(error));

/** The words of the error stream of the server: what it said before it stopped. */
function withStderr(message, stderr) {
  const value = String(stderr ?? '').trim();
  return value === '' ? message : `${message} (stderr: ${value.slice(-200)})`;
}

/** One frame of the protocol, or null when the line is not one. */
function parseFrame(line) {
  try {
    const frame = JSON.parse(line);
    return frame !== null && typeof frame === 'object' && !Array.isArray(frame) ? frame : null;
  } catch {
    return null;
  }
}

/**
 * Ends the server: its input is closed, it may take a moment to go, and it is
 * killed when it does not. The probe never leaves a server behind.
 *
 * @param {import('node:child_process').ChildProcess|null} child
 * @returns {Promise<void>}
 */
async function stop(child) {
  if (child === null || child === undefined) return;
  try { child.stdin.end(); } catch { /* the pipe is already closed */ }
  const gone = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once('exit', resolve);
    child.once('error', resolve);
  });
  const kill = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* it is already gone */ }
  }, STOP_MS);
  await gone;
  clearTimeout(kill);
}

/**
 * The experiment: the server is started, the two questions are asked, and the
 * answer of each one is in the result.
 *
 * @param {string} serverPath the file of the MCP server
 * @param {number} budget how long the whole experiment may take, in ms
 * @param {string} root the state root the server works on
 * @returns {Promise<{mcp: {ok: boolean, tools: number, error: string}, api: {ok: boolean, error: string}}>}
 */
async function probe(serverPath, budget, root) {
  const answers = new Map();
  const mcp = { ok: false, tools: 0, error: '' };
  const api = { ok: false, error: '' };
  let stderr = '';
  let stopped = false;
  let broken = '';

  const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  try {
    child.on('error', (error) => { broken = `the server could not start (${error?.code ?? reason(error)})`; });
    child.on('exit', () => { stopped = true; });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    let pending = '';
    const decoder = new StringDecoder('utf8');
    child.stdout.on('data', (chunk) => {
      pending += decoder.write(chunk);
      for (let index = pending.indexOf('\n'); index >= 0; index = pending.indexOf('\n')) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        const frame = parseFrame(line);
        if (frame !== null && typeof frame.id === 'number') answers.set(frame.id, frame);
      }
    });

    // The two questions of the protocol, in one go; the input stays open, so
    // the server waits for more (as a client does).
    child.stdin.on('error', () => {});
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'okit-selfcheck', version: '1' } } })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    } catch { /* the server is already gone; the answers below say so */ }

    const deadline = Date.now() + budget;
    while (!answers.has(2) && !stopped && Date.now() < deadline) await sleep(20);

    const one = answers.get(1);
    const two = answers.get(2);
    const late = stopped ? 'the server stopped before it answered' : `the server did not answer in ${budget} ms`;
    if (broken !== '') mcp.error = broken;
    else if (one === undefined) mcp.error = withStderr(late, stderr);
    else if (two === undefined) mcp.error = withStderr(late, stderr);
    else if (one.error !== undefined) mcp.error = `the server answered initialize with an error (${one.error?.message ?? 'unknown'})`;
    else if (two.error !== undefined) mcp.error = `the server answered tools/list with an error (${two.error?.message ?? 'unknown'})`;
    else {
      const tools = two.result?.tools;
      if (!Array.isArray(tools) || tools.length === 0) mcp.error = 'the server answered tools/list with no tools';
      else { mcp.ok = true; mcp.tools = tools.length; }
    }

    // The control API of the server, while it is still alive.
    if (mcp.ok) {
      let found = null;
      while (found === null && Date.now() < deadline) {
        const servers = await findServers(root).catch(() => []);
        found = servers.find((server) => server.pid === child.pid) ?? null;
        if (found === null) await sleep(POLL_MS);
      }
      if (found === null) api.error = withStderr('the server did not open its control API', stderr);
      else {
        const answer = await callControl({ root, tool: READ_TOOL, arguments: {}, pid: child.pid,
          timeoutMs: Math.max(1000, deadline - Date.now()) });
        if (answer.ok) api.ok = true;
        else api.error = withStderr(String(answer.error ?? ''), stderr);
      }
    }
  } finally {
    await stop(child);
  }
  return { mcp, api };
}

/** The answer of a failure of the probe itself: the two checks say it did not run. */
const failure = (why) => ({ mcp: { ok: false, tools: 0, error: why }, api: { ok: false, error: why } });

async function main() {
  try {
    const serverPath = process.argv[2];
    const asked = process.argv[3];
    let budget = DEFAULT_MS;
    if (asked !== undefined && asked !== '') {
      const value = Number(asked);
      if (!Number.isInteger(value) || value <= 0) throw new Refusal('the probe needs a whole number of milliseconds');
      budget = value;
    }
    const root = String(process.env[HOME_ENV] ?? '').trim();
    if (root === '') throw new Refusal('the probe needs a state root (OKWORK_HOME)');
    if (!serverPath) throw new Refusal('the probe needs the path of the MCP server');
    process.stdout.write(`${JSON.stringify(await probe(serverPath, budget, root))}\n`);
  } catch (error) {
    if (error instanceof Refusal) {
      process.stderr.write(`okit self-check probe: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    process.stdout.write(`${JSON.stringify(failure(`the probe could not run (${reason(error)})`))}\n`);
  }
}

await main();
