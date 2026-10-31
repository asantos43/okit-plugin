// The call of one tool of a table: the one place that decides how a tool
// answers, shared by the MCP server and the local control API.

/**
 * Calls one tool of the table and answers the way a tool answers: the text of
 * the tool, plus the flag that tells the client the run failed. A refusal or a
 * bad argument is reported as a failed call, so the client can read the
 * message and the caller keeps going.
 *
 * @param {object[]} tools the table of tools
 * @param {object} ctx the context of the caller
 * @param {string} name the name of the tool
 * @param {object} args the arguments of the call
 * @returns {Promise<{text: string, isError: boolean}>}
 * @throws when the table holds no tool with that name
 */
export async function callTool(tools, ctx, name, args) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`unknown tool ${name}`);
  try {
    return { text: await tool.handler(args, ctx), isError: false };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return { text, isError: true };
  }
}
