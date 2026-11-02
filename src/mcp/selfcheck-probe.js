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
//   {"mcp":{"ok":true,"tools":12,"error":null},"api":{"ok":true,"error":null},"stderr":"","answers":2}
// `answers` is how many answers of the protocol were kept (never more than the
// two of the questions of the probe). The exit code says whether the probe
// could run the experiment at all (0), not whether the server answered: what
// the server said is in the line.
//
// A failure is a CODE and its data, never a sentence: the installer maps each
// code to the text of the language of the run (src/install/selfcheck.js). The
// codes are: `start-failed`, `stopped`, `timeout`, `init-error`, `list-error`,
// `no-tools`, `bad-frame`, `long-line`, `no-control-api` and `control-error`.

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';
import { StringDecoder } from 'node:string_decoder';

import { exitCodeFor } from '../install/exit.js';
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
// The most of the error stream that is kept: the last 4 KiB of it.
const STDERR_LIMIT = 4096;
// The most a line of the output may hold without a newline: past it the server
// is writing a line that never ends.
const LINE_LIMIT = 1024 * 1024;
// The ids of the two questions of the probe; no other answer is kept.
const QUESTION_IDS = new Set([1, 2]);

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** A refusal of the probe itself: it cannot run the experiment, so it stops. */
class Refusal extends Error {}

/** The reason of a failure, in plain words. */
const reason = (error) => (error instanceof Error ? error.message : String(error));

/** The codes of the failures of the probe, with the data each one carries. */
export const CODES = Object.freeze({
  startFailed: 'start-failed',
  stopped: 'stopped',
  timeout: 'timeout',
  initError: 'init-error',
  listError: 'list-error',
  noTools: 'no-tools',
  badFrame: 'bad-frame',
  longLine: 'long-line',
  noControlApi: 'no-control-api',
  controlError: 'control-error',
});

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
 * On POSIX the server is started in a group of its own, so the whole group is
 * killed: a server that started a process of its own takes it with it. On
 * Windows taskkill ends the entire process tree.
 *
 * The order is the platform's. On Windows the tree is killed BEFORE the wait:
 * `taskkill /pid N /T /F` needs the parent to be there to reach the children
 * it left behind, and a server that ends by itself leaves them behind (the
 * tree is then out of reach). On POSIX the group outlives the parent, so the
 * wait comes first and the group is killed once more when the server is gone.
 *
 * The group is killed once more after the server is gone: a server that ends
 * by itself may have left a process of its own behind, and that process is
 * still in the group. On Windows the tree is already gone (the kill before the
 * wait took it), so the last chance is only taken when that kill failed.
 *
 * @param {import('node:child_process').ChildProcess|null} child
 * @param {{platform?: string, kill?: Function|null}} [options] the platform and the seam that
 *   kills the tree (`killTree` of this file by default, with the platform of the run)
 * @returns {Promise<void>}
 */
export async function stop(child, { platform = process.platform, kill = null } = {}) {
  if (child === null || child === undefined) return;
  const tree = kill ?? ((target) => killTree(target, { platform }));
  try { child.stdin.end(); } catch { /* the pipe is already closed */ }
  const gone = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once('exit', resolve);
    child.once('error', resolve);
  });
  // Windows: the tree goes before the wait, while the parent of it is still there.
  let killed = false;
  if (platform === 'win32') killed = safeKill(child, tree);
  const timer = setTimeout(() => safeKill(child, tree), STOP_MS);
  await gone;
  clearTimeout(timer);
  // The server may have left a process of its own behind: the group is killed once more (on Windows only when the
  // kill before the wait did not work: the tree is already gone).
  if (!killed) safeKill(child, tree);
}

/** The kill of the tree, whatever the seam does: the cleanup of the probe never throws. */
function safeKill(child, kill) {
  try { kill(child); return true; } catch { /* best effort */ return false; }
}

/** Kills the entire server tree; cleanup never throws. */
export function killTree(child, { platform = process.platform, spawnSync: run = spawnSync, kill = process.kill } = {}) {
  if (platform === 'win32') {
    try { run('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false }); }
    catch { /* best effort */ }
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  } else {
    try { kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

function killGroup(child) {
  killTree(child);
}

/**
 * Whether the frame is the answer of the protocol the probe speaks: a JSON-RPC
 * 2.0 frame whose id is the one of the question.
 */
function isOurFrame(frame, id) {
  return frame !== null && frame.jsonrpc === '2.0' && frame.id === id;
}

/**
 * Whether the answer of `initialize` is the one of a server: an object with a
 * protocol version and a server (its name or what it can do).
 */
function initializeOk(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return false;
  if (typeof result.protocolVersion !== 'string' || result.protocolVersion === '') return false;
  const server = result.serverInfo ?? result.capabilities;
  return server !== null && typeof server === 'object' && !Array.isArray(server);
}

/**
 * Whether the answer of `tools/list` is the one of a server: a list of tools,
 * each one an object with a name of its own.
 */
function toolsOk(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return false;
  if (!Array.isArray(result.tools)) return false;
  return result.tools.every((tool) => tool !== null && typeof tool === 'object' && !Array.isArray(tool)
    && typeof tool.name === 'string' && tool.name !== '');
}

/**
 * The experiment: the server is started, the two questions are asked, and the
 * answer of each one is in the result.
 *
 * @param {string} serverPath the file of the MCP server
 * @param {number} budget how long the whole experiment may take, in ms
 * @param {string} root the state root the server works on
 * @returns {Promise<{mcp: {ok: boolean, tools: number, error: object|null},
 *   api: {ok: boolean, error: object|null}, stderr: string, answers: number}>}
 */
async function probe(serverPath, budget, root) {
  const answers = new Map();
  const mcp = { ok: false, tools: 0, error: null };
  const api = { ok: false, error: null };
  let stderr = '';
  let stopped = false;
  let broken = null;
  let overflow = false;

  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
    // Its own group of processes, so the whole group can be killed at the end.
    detached: process.platform !== 'win32',
  });
  // A signal (or the end of the pipe of the parent) ends the server first: the
  // probe never leaves a server behind, not even when it is killed.
  const shutdown = () => {
    killGroup(child);
    process.exit(exitCodeFor('ok'));
  };
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, shutdown);
  process.on('disconnect', shutdown);
  try {
    child.on('error', (error) => { broken = { code: CODES.startFailed, why: error?.code ?? reason(error) }; });
    child.on('exit', () => { stopped = true; });
    child.stderr.on('data', (chunk) => {
      // Only the last of it is kept: the error stream of a server may be endless.
      stderr = `${stderr}${chunk.toString()}`.slice(-STDERR_LIMIT);
    });

    let pending = '';
    const decoder = new StringDecoder('utf8');
    child.stdout.on('data', (chunk) => {
      if (overflow) return;
      pending += decoder.write(chunk);
      for (let index = pending.indexOf('\n'); index >= 0; index = pending.indexOf('\n')) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        const frame = parseFrame(line);
        // Only the answers of the two questions are kept.
        if (frame !== null && QUESTION_IDS.has(frame.id)) answers.set(frame.id, frame);
      }
      // A line that never ends is a line the server is not able to write: the
      // probe stops it instead of waiting for a newline that will not come.
      if (pending.length > LINE_LIMIT) {
        overflow = true;
        pending = '';
        killGroup(child);
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
    while (!answers.has(2) && !stopped && !overflow && Date.now() < deadline) await sleep(20);

    const one = answers.get(1);
    const two = answers.get(2);
    if (broken !== null) mcp.error = broken;
    else if (overflow) mcp.error = { code: CODES.longLine, limit: LINE_LIMIT };
    else if (stopped) mcp.error = { code: CODES.stopped };
    else if (one === undefined || two === undefined) mcp.error = { code: CODES.timeout, ms: budget };
    else if (!isOurFrame(one, 1) || !isOurFrame(two, 2)) mcp.error = { code: CODES.badFrame, why: 'jsonrpc' };
    else if (one.error !== undefined) mcp.error = { code: CODES.initError, why: one.error?.message ?? 'unknown' };
    else if (two.error !== undefined) mcp.error = { code: CODES.listError, why: two.error?.message ?? 'unknown' };
    else if (!initializeOk(one.result)) mcp.error = { code: CODES.badFrame, why: 'initialize' };
    else if (!toolsOk(two.result)) mcp.error = { code: CODES.badFrame, why: 'tools/list' };
    else if (two.result.tools.length === 0) mcp.error = { code: CODES.noTools };
    else { mcp.ok = true; mcp.tools = two.result.tools.length; }

    // The control API of the server, while it is still alive.
    if (mcp.ok) {
      let found = null;
      while (found === null && Date.now() < deadline) {
        const servers = await findServers(root).catch(() => []);
        found = servers.find((server) => server.pid === child.pid) ?? null;
        if (found === null) await sleep(POLL_MS);
      }
      if (found === null) api.error = { code: CODES.noControlApi };
      else {
        // The budget is the budget: no new wait is granted past it.
        const left = deadline - Date.now();
        if (left <= 0) api.error = { code: CODES.timeout, ms: budget };
        else {
          const answer = await callControl({ root, tool: READ_TOOL, arguments: {}, pid: child.pid, timeoutMs: left });
          if (answer.ok) api.ok = true;
          else api.error = { code: CODES.controlError, cause: answer.code, why: String(answer.error ?? '') };
        }
      }
    }
  } finally {
    // The handlers of the signals are ours only while the experiment runs: nothing of them leaks past it.
    for (const signal of ['SIGTERM', 'SIGINT']) process.off(signal, shutdown);
    process.off('disconnect', shutdown);
    await stop(child);
  }
  return { mcp, api, stderr, answers: answers.size };
}

/** The answer of a failure of the probe itself: the two checks say it did not run. */
const failure = (code, why) => ({
  mcp: { ok: false, tools: 0, error: { code, ...(why === undefined ? {} : { why }) } },
  api: { ok: false, error: { code, ...(why === undefined ? {} : { why }) } },
  stderr: '',
  answers: 0,
});

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
      process.exitCode = exitCodeFor('usage');
      return;
    }
    process.stdout.write(`${JSON.stringify(failure('start-failed', reason(error)))}\n`);
  }
}

const invoked = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
if (process.argv[1] && invoked(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
