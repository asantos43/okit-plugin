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
} = {}) {
  const root = ctx?.root;
  const isPosix = POSIX_PLATFORMS.has(platform);
  const connections = new Set();
  let server = null;
  let endpoint = null;
  let stopped = false;

  try {
    // A process that died leaves its record and its socket behind: they are
    // pruned before the API takes an endpoint of its own.
    await listRecords(root, isAlive === undefined ? {} : { isAlive });

    endpoint = endpointFor({ root, pid, platform });
    if (!fitsPlatform(endpoint, platform)) {
      throw new Error(`the endpoint is longer than ${SOCKET_PATH_LIMIT} bytes`);
    }
    await openControlDir(root, { platform });
    // A socket file of this pid from a run that died is not ours to keep.
    if (isPosix) await filesystem.rm(endpoint, { force: true });

    const token = newToken();
    const stop = async () => {
      // Stopping twice is not a failure: the API is already gone.
      if (stopped) return;
      stopped = true;
      for (const socket of connections) socket.destroy();
      connections.clear();
      if (server !== null) {
        const closed = new Promise((resolve) => server.close(() => resolve()));
        server.closeAllConnections?.();
        await closed;
      }
      // The socket file and the record of the API go with it.
      await removeRecord(root, pid, { platform });
    };

    server = net.createServer();
    // An error of the server after it opened must not take the process with
    // it: the API is local and a failed caller is the caller's problem.
    server.on('error', () => {});
    server.on('connection', (socket) => {
      handleConnection(socket, { tools, ctx, token, idleMs, maxFrame, maxConnections, connections });
    });
    const opened = once(server, 'listening');
    server.listen(endpoint);
    await opened;

    // The socket file belongs to the owner of the machine only.
    if (isPosix) await filesystem.chmod(endpoint, PRIVATE_SOCKET);

    // The record is written only when the API is already listening, so a
    // record never points at an endpoint that is not there.
    await writeRecord(root, { pid, endpoint, token, startedAt: Date.now(), version }, { platform });

    return { endpoint, token, stop };
  } catch (error) {
    // Whatever was opened on the way is closed again, so a failed API leaves
    // nothing behind.
    if (server !== null) {
      server.close();
      server.closeAllConnections?.();
    }
    for (const socket of connections) socket.destroy();
    connections.clear();
    if (isPosix && endpoint !== null) await filesystem.rm(endpoint, { force: true }).catch(() => {});
    await removeRecord(root, pid, { platform }).catch(() => {});
    stderr.write(`okit control api: ${reason(error)}\n`);
    return null;
  }
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
  connections,
}) {
  if (connections.size >= maxConnections) {
    // The API takes only a few callers: the one over the line is told to go.
    socket.on('error', () => {});
    socket.end(`${JSON.stringify({ id: null, ok: false, error: 'too many connections' })}\n`);
    return;
  }
  connections.add(socket);
  // A connection that says nothing for a while is of no use to anybody.
  socket.setTimeout(idleMs, () => socket.destroy());

  const decoder = new StringDecoder('utf8');
  let pending = '';
  let oversized = false;
  // Lines are answered in the order they arrived, so one chain is enough.
  let chain = Promise.resolve();

  const reply = (payload) => {
    if (socket.destroyed || socket.writableEnded) return;
    socket.write(`${JSON.stringify(payload)}\n`);
  };

  const handle = async (line) => {
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
      socket.end();
      return;
    }
    if (typeof frame.tool !== 'string' || frame.tool === '') {
      reply({ id, ok: false, error: 'invalid frame' });
      return;
    }
    const args = frame.arguments ?? {};
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
    if (oversized) return;
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
