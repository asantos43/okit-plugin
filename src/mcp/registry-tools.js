// The MCP tools built from the registry of the operations: one tool per entry,
// with the name, the description and the schema the entry publishes. The tool
// calls the handler of the entry, so the command line and the client run the
// same code and cannot drift apart.
//
// The schema the client reads is a copy: the registry keeps its own, and a
// client that mutates what it read changes nothing else. The keys only the
// command line takes (`cliOnly`) are not published and are refused, the same
// way a tool refuses an argument it does not have.

import { argsOf } from '../core/arguments.js';
import { OPERATIONS } from '../core/operations.js';

// A tool answers with the JSON of what the core returned, so a refusal
// (`ok: false`) and a result (`ok: true`) read the same way.
const reply = (value) => JSON.stringify(value);

/**
 * The keys the entry publishes: the ones of its schema, minus the ones only
 * the command line takes.
 *
 * @param {object} entry the entry of the registry
 * @returns {string[]} the names of the keys
 */
export function publishedKeys(entry) {
  const properties = entry.schema?.properties ?? {};
  return Object.keys(properties).filter((key) => !(entry.cliOnly ?? []).includes(key));
}

/**
 * The schema the client reads: a copy of the schema of the entry, without the
 * keys of the command line.
 *
 * @param {object} entry the entry of the registry
 * @returns {object} the schema published
 */
export function publishedSchema(entry) {
  const schema = structuredClone(entry.schema);
  for (const key of entry.cliOnly ?? []) {
    if (schema.properties !== undefined) delete schema.properties[key];
  }
  return schema;
}

// The dependencies of the call: what the context of the server offers and the
// operation asks for. The table of the daemon is not among them, because only
// the command line builds it.
function depsOf(ctx) {
  const deps = {};
  const source = ctx ?? {};
  for (const key of ['config', 'env', 'now', 'quotaCache', 'spawn', 'run', 'fs', 'platform',
    'detectClients', 'versions', 'plugin']) {
    if (source[key] !== undefined) deps[key] = source[key];
  }
  return deps;
}

/**
 * The tools of a list of entries of the registry.
 *
 * @param {object[]} [operations] the entries of the registry
 * @returns {{name: string, description: string, inputSchema: object, handler: Function}[]}
 */
export function toolsFromRegistry(operations = OPERATIONS) {
  return operations.map((entry) => {
    const allowed = publishedKeys(entry);
    return {
      name: entry.name,
      description: `${entry.description.en} / ${entry.description['pt-BR']}`,
      inputSchema: publishedSchema(entry),
      handler: async (args, ctx) => {
        const given = argsOf(entry.name, args, allowed);
        return reply(await entry.handler(ctx.root, given, depsOf(ctx)));
      },
    };
  });
}
