// MCP over stdio: newline-delimited JSON-RPC 2.0, hand-written and with no
// dependencies. Only protocol frames go to the output stream; anything a
// human may need goes to stderr. A refused tool is an answer, not a crash, so
// nothing in a handler ever leaves the loop.
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';

import { callTool } from './call-tool.js';
import { startControl } from './control.js';
import { makeContext, TOOLS } from './tools.js';

// The call of one tool lives in its own module, so the control API can use it
// without importing the server; it stays reachable from here.
export { callTool };

const PROTOCOL_VERSION = '2025-06-18';
// Versions this server speaks; anything else gets the default back.
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_NAME = 'okit';
const FALLBACK_VERSION = '0.3.0';
const PACKAGE_URL = new URL('../../package.json', import.meta.url);

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const success = (id, result) => ({ jsonrpc: '2.0', id, result });
const failure = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

// Every tool answers the same way: text content, plus the flag that tells the
// client the run of the tool failed.
function toolResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

/**
 * The version reported in `serverInfo`, read from the package file so it never
 * drifts from it. An unreadable file is not worth failing a handshake over.
 */
export async function serverVersion() {
  try {
    const pkg = JSON.parse(await readFile(PACKAGE_URL, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

function initializeResult(params, version) {
  const asked = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '';
  return {
    protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version },
  };
}

// Only the three fields a client needs to advertise a tool; the handler stays
// on this side. The listing is exported so the cost of the list can be
// measured without a second copy of it.
export function toolListing(tools) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

/**
 * Answers one parsed message, or `null` when the message is a notification and
 * must stay unanswered.
 */
export async function respond(message, { tools, ctx, version }) {
  const id = message.id === undefined ? null : message.id;
  const method = message.method;
  if (typeof method !== 'string' || method === '') {
    return failure(id, INVALID_REQUEST, 'Invalid Request: method must be a non-empty string');
  }
  // A notification is a message with no id, whatever its method is.
  const silent = message.id === undefined || method.startsWith('notifications/');
  const params = message.params ?? {};

  switch (method) {
    case 'initialize':
      return silent ? null : success(id, initializeResult(params, version));
    case 'ping':
      return silent ? null : success(id, {});
    case 'tools/list':
      return silent ? null : success(id, { tools: toolListing(tools) });
    case 'tools/call': {
      if (silent) return null;
      const name = params?.name;
      if (typeof name !== 'string' || name === '') {
        return failure(id, INVALID_PARAMS, 'Invalid params: tools/call needs a tool name');
      }
      try {
        const result = await callTool(tools, ctx, name, params.arguments);
        return success(id, toolResult(result.text, result.isError));
      } catch (error) {
        // The only failure that reaches here is the name of a tool the table
        // does not hold: a refusal of the tool itself is an answer.
        return failure(id, INVALID_PARAMS, `Invalid params: ${error.message}`);
      }
    }
    default:
      return silent ? null : failure(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/**
 * Answers one input line. An unparsable line is a parse error with a null id
 * and the loop carries on, since one bad line says nothing about the next.
 */
export async function handleLine(line, context) {
  const text = line.trim();
  if (text === '') return null;
  let message;
  try {
    message = JSON.parse(text);
  } catch (error) {
    return failure(null, PARSE_ERROR, `Parse error: ${error.message}`);
  }
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return failure(null, INVALID_REQUEST, 'Invalid Request: a JSON-RPC message must be an object');
  }
  return respond(message, context);
}

/**
 * The server over two streams: one line in, one frame out.
 *
 * @param {{tools?: object[], input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, ctx?: {root: string, config?: object}, version?: string}} options
 * @returns {{start: () => void, stop: () => Promise<void>, context: object}}
 */
export function createServer({ tools = TOOLS, input, output, ctx, version = FALLBACK_VERSION } = {}) {
  const context = { tools, ctx: ctx ?? makeContext(), version };
  const decoder = new StringDecoder('utf8');
  let pending = '';
  // Lines are answered in the order they arrived, so a queue of one chain is
  // enough: the next handler never starts before the previous one settles.
  let chain = Promise.resolve();

  const write = (frame) => {
    output.write(`${JSON.stringify(frame)}\n`);
  };

  const process = async (line) => {
    const frame = await handleLine(line, context);
    if (frame !== null) write(frame);
  };

  const onData = (chunk) => {
    pending += decoder.write(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    for (let index = pending.indexOf('\n'); index >= 0; index = pending.indexOf('\n')) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      // A write that fails must not take the queue with it.
      chain = chain.then(() => process(line)).catch(() => {});
    }
  };

  return {
    context,
    /** Answers one line without going through the streams. */
    handle: (line) => handleLine(line, context),
    start() {
      input.on('data', onData);
    },
    async stop() {
      input.off('data', onData);
      // A last line with no newline still counts as a request.
      const rest = `${pending}${decoder.end()}`;
      pending = '';
      if (rest.trim() !== '') await process(rest);
      await chain;
    },
  };
}

/** Runs the server on stdin and stdout, the way a client spawns it. */
export async function main() {
  const version = await serverVersion();
  const server = createServer({
    tools: TOOLS,
    input: process.stdin,
    output: process.stdout,
    ctx: makeContext(),
    version,
  });
  server.start();
  // The control API of this process: an API that does not open is not a
  // crash, and `startControl` already said why on the error stream.
  const control = await startControl({ tools: TOOLS, ctx: server.context.ctx, version });
  await new Promise((resolve) => {
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
  });
  // The API goes down before the server, so its socket and its record are
  // gone by the time the process leaves.
  await control?.stop();
  await server.stop();
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error) => {
    // stdout carries protocol frames only, so a failure is written to stderr.
    process.stderr.write(`okit mcp server: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
