// The MCP tools built from the registry of the operations: one tool per entry,
// with the name, the description and the schema the entry publishes. The tool
// calls the handler of the entry, so the command line and the client run the
// same code and cannot drift apart.
//
// The schema the client reads is a copy: the registry keeps its own, and a
// client that mutates what it read changes nothing else. The keys only the
// command line takes (`cliOnly`) are not published and are refused, the same
// way a tool refuses an argument it does not have.
//
// The arguments are not checked here: every handler checks its own, the way
// the tool always did. The keys only the command line takes are the ones
// refused by the tool, because the handler would never see them.

import { OPERATIONS } from '../core/operations.js';
import { Refusal } from '../core/refusal.js';

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

// The dependencies of the call: what the context of the server offers. The
// root is not among them (the handler takes it apart) and the table of the
// daemon is not either, because only the command line builds it.
function depsOf(ctx) {
  const deps = { ...(ctx ?? {}) };
  delete deps.root;
  return deps;
}

/**
 * Refuses the keys only the command line takes. The refusal is the one of a
 * tool that gets an argument it does not have, and it names the keys the tool
 * does take.
 *
 * @param {object} entry the entry of the registry
 * @param {unknown} args the arguments as they arrived
 */
function refuseCliOnly(entry, args) {
  const cliOnly = entry.cliOnly ?? [];
  if (cliOnly.length === 0) return;
  const source = args === undefined || args === null ? {} : args;
  const forbidden = Reflect.ownKeys(source).filter((key) => cliOnly.includes(key));
  if (forbidden.length === 0) return;
  throw new Refusal(`${entry.name}: unknown argument ${forbidden.map((key) => String(key)).join(', ')}; expected ${publishedKeys(entry).join('|')}`);
}

/**
 * The tools of a list of entries of the registry.
 *
 * @param {object[]} [operations] the entries of the registry
 * @returns {{name: string, description: string, inputSchema: object, handler: Function}[]}
 */
export function toolsFromRegistry(operations = OPERATIONS) {
  return operations.map((entry) => ({
    name: entry.name,
    description: entry.description['pt-BR'] === undefined
      ? entry.description.en
      : `${entry.description.en} / ${entry.description['pt-BR']}`,
    inputSchema: publishedSchema(entry),
    handler: async (args, ctx) => {
      refuseCliOnly(entry, args);
      return reply(await entry.handler(ctx.root, args, depsOf(ctx)));
    },
  }));
}
