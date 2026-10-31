// The three entry points the client launches: the two hooks and the status bar
// collector. They all go through this module and nothing else, so the user help
// can leave them out (they are internal) and the core stays the only place that
// reads what the collector wrote.
//
// This module imports nothing at the top level: each launcher loads only what
// it needs, when it is launched. The daemon, the MCP server and the CLI are
// never among them.

import process from 'node:process';
import { stateRoot } from './store.js';

/** The entry points the client launches, in the order the client meets them. */
export const LAUNCHERS = Object.freeze(['hook session-start', 'hook post-compact', 'statusline-collector']);

/** The state root of a run: the one the caller names, or the one of the environment. */
const rootOf = (io) => io.root ?? stateRoot(io.env ?? process.env);

/**
 * Runs one launcher.
 *
 * The answer is the exit code of the entry point, or `undefined` when the argv
 * names no launcher (the caller goes on with its own command). Nothing here
 * throws into the client: a launcher that fails is a failure of the client, so
 * it is swallowed and the exit code is zero.
 *
 * @param {string[]} [argv] the arguments of the command line
 * @param {object} [io] the same parameters the command line takes
 * @returns {Promise<number|undefined>}
 */
export async function launch(argv, io = {}) {
  const [group, action] = argv ?? [];
  try {
    if (group === 'statusline-collector') {
      const { statuslineCommand } = await import('./quota/statusline-collector.js');
      return await statuslineCommand(argv.slice(1), io);
    }
    if (group === 'hook' && action === 'session-start') {
      const { runSessionStart } = await import('./hook-session-start.js');
      return await runSessionStart({ root: rootOf(io), env: io.env, stdin: io.stdin,
        stdout: io.stdout, snapshot: io.snapshot });
    }
    if (group === 'hook' && action === 'post-compact') {
      const { runPostCompact } = await import('./hook-post-compact.js');
      return await runPostCompact({ root: rootOf(io), stdin: io.stdin, stdout: io.stdout });
    }
  } catch {
    // The client asked for a launcher and got nothing: it goes on.
    return 0;
  }
  return undefined;
}
