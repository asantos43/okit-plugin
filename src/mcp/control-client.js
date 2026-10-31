// The client of the local control API: it finds a server that is alive under
// a state folder and asks it to run one tool. The answer is always a plain
// object, so the caller never has to catch anything: every failure is said
// in the same plain words.
//
// The client asks the servers from the newest to the oldest, because the one
// that started last is the one that holds the state of the moment. A server
// that does not accept the connection is skipped: a record of a process that
// died can be there for a while, and the client must not stop at it.

import net from 'node:net';

import { listRecords } from './control-endpoint.js';

// What the caller reads when the folder holds no server at all.
const NO_SERVER = 'no okit server is running for this state folder';
// What the caller reads when no server of the folder answers.
const NO_ANSWER = 'no okit server answers on this state folder';
// What the caller reads when the answer of a server makes no sense.
const NOT_UNDERSTOOD = 'the okit server sent an answer that is not understood';
// What the caller reads when a server hangs up before it answers.
const CLOSED = 'the okit server closed the connection';

const refusal = (error) => ({ ok: false, error });

/**
 * The servers that answer for a state folder, the newest first.
 *
 * The records of the processes that died are pruned by the endpoint module,
 * so what is left here is what may answer. A pid given asks for that server
 * alone.
 *
 * @param {string} root the state root
 * @param {{isAlive?: (pid: number) => boolean, platform?: string, pid?: number}} [options]
 * @returns {Promise<object[]>} the records of the servers, the newest first
 */
export async function findServers(root, { isAlive, platform, pid } = {}) {
  // The endpoint module has its own defaults, so a value that was not given
  // is not passed at all.
  const options = {};
  if (isAlive !== undefined) options.isAlive = isAlive;
  if (platform !== undefined) options.platform = platform;
  const records = await listRecords(root, options);
  const chosen = pid === undefined
    ? records
    : records.filter((record) => record.pid === pid);
  // The newest one first: the server that started last is the one of the
  // state of the moment.
  return [...chosen].sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0));
}

/**
 * Asks one server to run one tool and gives the answer in plain words.
 *
 * The call never rejects: a server that is not there, one that is slow and
 * one that says something else all come back as `{ ok: false, error }`.
 *
 * @param {object} options
 * @param {string} options.root the state root
 * @param {string} options.tool the name of the tool
 * @param {object} [options.arguments] the arguments of the call
 * @param {number} [options.pid] the server to ask, when it is named
 * @param {number} [options.timeoutMs] how long one attempt may take
 * @param {(pid: number) => boolean} [options.isAlive] who is still alive
 * @param {string} [options.platform]
 * @returns {Promise<{ok: true, text: string}|{ok: false, error: string}>}
 */
export async function callControl({
  root,
  tool,
  arguments: args = {},
  pid,
  timeoutMs = 5000,
  isAlive,
  platform,
} = {}) {
  let servers;
  try {
    servers = await findServers(root, { isAlive, platform, pid });
  } catch (error) {
    return refusal(reason(error));
  }
  if (servers.length === 0) return refusal(NO_SERVER);

  let timeout = null;
  for (const server of servers) {
    const answer = await ask(server, { tool, args, timeoutMs });
    if (answer.ok) return { ok: true, text: answer.text };
    // A server that does not accept the connection is not the one the
    // caller wants: the next one is tried.
    if (answer.retry) continue;
    if (answer.timeout) {
      timeout = answer;
      continue;
    }
    return refusal(answer.error);
  }
  // A server that was there and did not answer in time says more than the
  // silence of a folder where nobody listens.
  if (timeout !== null) return refusal(timeout.error);
  return refusal(NO_ANSWER);
}

/**
 * One attempt: open the socket, write the frame of the call and read one
 * line back.
 *
 * @param {object} server the record of the server
 * @param {{tool: string, args: object, timeoutMs: number}} options
 * @returns {Promise<{ok: true, text: string}|{ok: false, error: string, retry?: boolean, timeout?: boolean}>}
 */
function ask(server, { tool, args, timeoutMs }) {
  return new Promise((resolve) => {
    const socket = net.connect(server.endpoint);
    let settled = false;
    let buffer = '';
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    // The whole attempt has one budget: the connection, the frame and the
    // answer together may not take longer than that.
    const timer = setTimeout(
      () => settle({ ok: false, error: `the okit server did not answer in ${timeoutMs} ms`, timeout: true }),
      timeoutMs,
    );
    socket.on('error', () => settle({ ok: false, error: 'the okit server did not accept the connection', retry: true }));
    socket.on('close', () => settle({ ok: false, error: CLOSED }));
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id: 1, token: server.token, tool, arguments: args })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      settle(answerOf(buffer.slice(0, index)));
    });
  });
}

/**
 * The answer of a server: the text of the tool, or what went wrong.
 *
 * @param {string} line the line the server wrote
 * @returns {{ok: true, text: string}|{ok: false, error: string}}
 */
function answerOf(line) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return { ok: false, error: NOT_UNDERSTOOD };
  }
  if (frame === null || typeof frame !== 'object' || typeof frame.ok !== 'boolean') {
    return { ok: false, error: NOT_UNDERSTOOD };
  }
  if (frame.ok) return { ok: true, text: typeof frame.text === 'string' ? frame.text : '' };
  return { ok: false, error: typeof frame.error === 'string' ? frame.error : NOT_UNDERSTOOD };
}

/**
 * The reason of a failure, in plain words.
 *
 * @param {unknown} error
 * @returns {string}
 */
function reason(error) {
  return error instanceof Error ? error.message : String(error);
}
