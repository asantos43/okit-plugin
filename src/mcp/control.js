// The local control API: the endpoint where a tool call comes in from the
// machine itself, answered by the same call the MCP makes. The endpoint
// module decides where the API listens and keeps the record of the process
// that listens; this one opens the endpoint, guards it with the token of the
// record and answers the frames that arrive.

import { once } from 'node:events';
import * as filesystem from 'node:fs/promises';
import net from 'node:net';
import process from 'node:process';
import { StringDecoder } from 'node:string_decoder';

import {
  endpointFor,
  fitsPlatform,
  listRecords,
  newToken,
  openControlDir,
  removeRecord,
  SOCKET_PATH_LIMIT,
  tokenMatches,
  writeRecord,
} from './control-endpoint.js';
import { callTool } from './call-tool.js';

// The platforms that answer on a socket file: it has a mode of its own.
const POSIX_PLATFORMS = new Set(['linux', 'darwin']);
// The mode of the socket file: the owner of the machine only.
const PRIVATE_SOCKET = 0o600;
// How long a socket of a caller that is over the line may stay open.
const REFUSED_TIMEOUT = 1000;

/**
 * Starts the local control API of one process: it listens on the endpoint of
 * the process and answers the tool calls that arrive on it.
 *
 * An API that does not open is not a crash: the caller is told with `null`
 * and a line on the error stream, so the process that owns it carries on
 * without the API.
 *
 * @param {object} options
 * @param {object[]} options.tools the table of tools
 * @param {{root: string}} options.ctx the context of the caller
 * @param {string} [options.version] the version written in the record
 * @param {number} [options.pid] the process that owns the endpoint
 * @param {string} [options.platform]
 * @param {{write: (text: string) => void}} [options.stderr] where an open failure is told
 * @param {(pid: number) => boolean} [options.isAlive] who is still alive
 * @param {number} [options.idleMs] how long a connection may say nothing
 * @param {number} [options.maxFrame] the most bytes of one frame
 * @param {number} [options.maxConnections] how many callers at a time
 * @param {number} [options.maxQueued] how many frames one caller may have waiting
 * @returns {Promise<{endpoint: string, token: string, stop: () => Promise<void>}|null>}
 */
export async function startControl({
  tools,
  ctx,
  version,
  pid = process.pid,
  platform = process.platform,
  stderr = process.stderr,
  isAlive,
  idleMs = 30000,
  maxFrame = 1048576,
  maxConnections = 8,
  maxQueued = 16,
} = {}) {
  const root = ctx?.root;
  const isPosix = POSIX_PLATFORMS.has(platform);
  const connections = new Set();
  // The callers that are over the line: their sockets are tracked too, so a
  // stop takes them away with the others.
  const refused = new Set();
  // The state every connection reads: a stop that happened while a frame was
  // waiting must be seen by the handler of that frame.
  const state = { stopped: false };
  let server = null;
  let endpoint = null;
  let secured = false;
  let listening = false;
  let recorded = false;

  try {
    endpoint = endpointFor({ root, pid, platform });
    if (!fitsPlatform(endpoint, platform)) {
      throw new Error(`the endpoint is longer than ${SOCKET_PATH_LIMIT} bytes`);
    }
    // The folder is ours before anything of it is read: the records of it are
    // not opened by a process that does not own the folder.
    await openControlDir(root, { platform });
    secured = true;
    // A process that died leaves its record and its socket behind: they are
    // pruned before the API takes an endpoint of its own.
    await listRecords(root, isAlive === undefined ? {} : { isAlive });
    // A socket file of this pid from a run that died is not ours to keep.
    if (isPosix) await filesystem.rm(endpoint, { force: true });

    const token = newToken();
    // The shutdown of the api: one promise for every stop, so a caller that
    // stops the api twice waits for the same shutdown and never hears that
    // the api is gone before it is.
    let stopping = null;
    const shutdown = async () => {
      state.stopped = true;
      for (const socket of connections) socket.destroy();
      connections.clear();
      for (const socket of refused) socket.destroy();
      refused.clear();
      if (server !== null) {
        // A connection that comes while the server is closing is sent away by
        // the handler of it: a caller that never closes its side must not
        // keep the API waiting.
        const closed = new Promise((resolve) => server.close(() => resolve()));
        await closed;
      }
      // The socket file and the record of the API go with it.
      await removeRecord(root, pid, { platform });
    };
    const stop = () => {
      stopping ??= shutdown();
      return stopping;
    };

    server = net.createServer();
    // An error of the server after it opened must not take the process with
    // it: the API is local and a failed caller is the caller's problem.
    server.on('error', () => {});
    server.on('connection', (socket) => {
      handleConnection(socket, {
        tools,
        ctx,
        token,
        idleMs,
        maxFrame,
        maxConnections,
        maxQueued,
        connections,
        refused,
        state,
      });
    });
    const opened = once(server, 'listening');
    server.listen(endpoint);
    listening = true;
    await opened;

    // The socket file belongs to the owner of the machine only.
    if (isPosix) await filesystem.chmod(endpoint, PRIVATE_SOCKET);

    // The record is written only when the API is already listening, so a
    // record never points at an endpoint that is not there.
    recorded = true;
    await writeRecord(root, { pid, endpoint, token, startedAt: Date.now(), version }, { platform });

    return { endpoint, token, stop };
  } catch (error) {
    // Whatever was opened on the way is closed again, so a failed API leaves
    // nothing behind.
    if (server !== null) {
      server.close();
    }
    for (const socket of connections) socket.destroy();
    connections.clear();
    for (const socket of refused) socket.destroy();
    refused.clear();
    if (secured && listening && isPosix) await filesystem.rm(endpoint, { force: true }).catch(() => {});
    if (secured && recorded) await removeRecord(root, pid, { platform }).catch(() => {});
    stderr.write(`okit control api: ${openReason(error)}\n`);
    return null;
  }
}

// A refused caller has a fixed time to close its side.
function closeSoon(socket) {
  socket.end();
  const timer = setTimeout(() => socket.destroy(), REFUSED_TIMEOUT);
  timer.unref?.();
  socket.once('close', () => clearTimeout(timer));
}

/**
 * Answers one connection: one frame in, one answer out, in the order the
 * frames arrived.
 *
 * @param {import('node:net').Socket} socket
 * @param {object} options
 */
function handleConnection(socket, {
  tools,
  ctx,
  token,
  idleMs,
  maxFrame,
  maxConnections,
  maxQueued,
  connections,
  refused,
  state,
}) {
  if (state.stopped) {
    // The API is already gone: the caller is sent away.
    socket.destroy();
    return;
  }
  if (connections.size >= maxConnections) {
    // The API takes only a few callers: the one over the line is told to go.
    // Its socket is tracked anyway, so a caller that never closes its side
    // does not keep the API waiting.
    socket.on('error', () => {});
    socket.write(`${JSON.stringify({ id: null, ok: false, error: 'too many connections' })}\n`);
    closeSoon(socket);
    refused.add(socket);
    socket.on('close', () => refused.delete(socket));
    return;
  }
  connections.add(socket);
  // A connection that says nothing for a while is of no use to anybody.
  socket.on('timeout', () => socket.destroy());
  socket.setTimeout(idleMs);

  const decoder = new StringDecoder('utf8');
  let pending = '';
  let oversized = false;
  let flooded = false;
  // Lines are answered in the order they arrived, so one chain is enough.
  let chain = Promise.resolve();
  // The frames that arrived and were not answered yet.
  let queued = 0;

  const reply = (payload) => {
    if (socket.destroyed || socket.writableEnded) return;
    socket.write(`${JSON.stringify(payload)}\n`);
  };

  // The clock of the idle time only runs when there is nothing to answer.
  const arm = () => {
    if (socket.destroyed || socket.writableEnded) return;
    socket.setTimeout(idleMs);
  };
  const disarm = () => {
    if (socket.destroyed) return;
    socket.setTimeout(0);
  };

  const handle = async (line) => {
    try {
      await answer(line);
    } finally {
      queued -= 1;
      // The clock starts again when the queue is empty and the answer of the
      // last frame was written.
      if (queued === 0) arm();
    }
  };

  const answer = async (line) => {
    // A frame that comes after the connection went away, or after the API
    // was stopped, is not answered and does not run.
    if (socket.destroyed || socket.writableEnded || state.stopped) return;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      reply({ id: null, ok: false, error: 'invalid frame' });
      return;
    }
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
      reply({ id: null, ok: false, error: 'invalid frame' });
      return;
    }
    const id = frame.id === undefined ? null : frame.id;
    // The token of the record opens the API: a call without it is refused
    // and the caller is gone.
    if (!tokenMatches(token, frame.token)) {
      reply({ id, ok: false, error: 'unauthorized' });
      closeSoon(socket);
      return;
    }
    if (typeof frame.tool !== 'string' || frame.tool === '') {
      reply({ id, ok: false, error: 'invalid frame' });
      return;
    }
    // The arguments go to the tool as they came, the way the mcp hands them
    // over: a null stays a null and an absent one stays nothing.
    const args = frame.arguments;
    // The clock of the idle time stops while the call runs: a call that takes
    // its time is not an idle connection.
    disarm();
    try {
      const result = await callTool(tools, ctx, frame.tool, args);
      if (result.isError) reply({ id, ok: false, error: result.text });
      else reply({ id, ok: true, text: result.text });
    } catch (error) {
      // The only failure that reaches here is the name of a tool the table
      // does not hold: a refusal of the tool itself is an answer.
      reply({ id, ok: false, error: reason(error) });
    }
  };

  // A frame that did not fit is answered once: what comes after it is of
  // no interest.
  const tooLarge = () => {
    reply({ id: null, ok: false, error: 'frame too large' });
    socket.destroy();
  };

  socket.on('data', (chunk) => {
    if (oversized || flooded) return;
    pending += decoder.write(chunk);
    let index = pending.indexOf('\n');
    while (index >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (Buffer.byteLength(line) > maxFrame) {
        oversized = true;
        pending = '';
        chain = chain.then(tooLarge).catch(() => {});
        return;
      }
      // The queue of one caller is bounded: a caller that floods the API is
      // told and goes, and the frames that were waiting do not run.
      if (queued + 1 > maxQueued) {
        flooded = true;
        pending = '';
        reply({ id: null, ok: false, error: 'too many pending calls' });
        closeSoon(socket);
        return;
      }
      queued += 1;
      chain = chain.then(() => handle(line)).catch(() => {});
      index = pending.indexOf('\n');
    }
    // A frame that grows past the limit without a line break is not a frame.
    if (Buffer.byteLength(pending) > maxFrame) {
      oversized = true;
      pending = '';
      chain = chain.then(tooLarge).catch(() => {});
    }
  });

  const forget = () => connections.delete(socket);
  socket.on('close', forget);
  socket.on('error', forget);
}

/**
 * The reason of a failure, without the name the endpoint module already
 * gave it.
 *
 * @param {unknown} error
 * @returns {string}
 */
function reason(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^control api:\s*/, '');
}

/**
 * The reason of a failure of the open, in words that name no path of the
 * machine: the message of the system carries the path of the endpoint, and
 * that path is not one to print.
 *
 * @param {unknown} error
 * @returns {string}
 */
function openReason(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error?.code;
  if (typeof code === 'string' && code !== '') return `could not open the endpoint (${code})`;
  if (message.includes('is not a plain folder')) {
    return 'the control folder is not a plain folder of this user';
  }
  if (message.includes('is not owned by this user')) {
    return 'the control folder belongs to another user';
  }
  if (message.includes(`longer than ${SOCKET_PATH_LIMIT} bytes`)) {
    return `the endpoint is longer than ${SOCKET_PATH_LIMIT} bytes`;
  }
  return 'could not open the endpoint';
}
