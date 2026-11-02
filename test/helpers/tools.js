// The tools of the server, called the way a client calls them: the assistant's side of the work,
// the side the removed commands of the command line used to be. The tools answer with the JSON of what
// the core returned, so the answer of a tool is read as data here.

import { TOOLS } from '../../src/mcp/tools.js';

/**
 * The tool of a name, or a refusal of the caller: a test that asks for a tool that does not exist
 * must fail loudly.
 *
 * @param {string} name the name of the tool
 * @returns {object} the tool
 */
export function toolOf(name) {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) throw new Error(`unknown tool ${name}`);
  return tool;
}

/**
 * Calls one tool of the server and answers with what it returned.
 *
 * @param {string} name the name of the tool
 * @param {object} [args] the arguments of the call
 * @param {object} [ctx] the context of the caller (the root, the environment, ...)
 * @returns {Promise<object>} the answer of the tool, parsed
 */
export async function callTool(name, args = {}, ctx = {}) {
  return JSON.parse(await toolOf(name).handler(args, ctx));
}

/**
 * The text of one tool, the way the server sends it.
 *
 * @param {string} name the name of the tool
 * @param {object} [args] the arguments of the call
 * @param {object} [ctx] the context of the caller (the root, the environment, ...)
 * @returns {Promise<string>} the answer of the tool, as it goes on the wire
 */
export async function toolText(name, args = {}, ctx = {}) {
  return toolOf(name).handler(args, ctx);
}
