// The daemon of a root: whether it runs, whether it is paused, the last pass
// it made and the decision of one pass. The loop itself (start) and the kill
// switch (stop) belong to the command line: they are the life of the process,
// not a fact about the state of a root. Nothing here prints.

import { daemonPause, daemonResume, daemonStatus, tick } from '../daemon.js';
import { makeSpawner } from '../spawn-process.js';
import { paths } from '../store.js';
import { argsOf, optionalSwitch, requiredChoice } from './arguments.js';
import { Refusal } from './refusal.js';

export const DAEMON_ACTIONS = ['status', 'pause', 'resume', 'run-once'];

/**
 * The state of the daemon of a root, or the change of that state.
 *
 * @param {string} root state root
 * @param {{action: string, table?: boolean}} args what to do with the daemon
 * @param {object} [deps] the clock, the spawner of the pass and the table of the status
 * @returns {Promise<object>} the status of the daemon, or the record of the pass
 */
export async function daemonOperation(root, args = {}, deps = {}) {
  const given = argsOf('daemon', args, ['action', 'table']);
  const action = requiredChoice('daemon', given, 'action', DAEMON_ACTIONS);
  const table = optionalSwitch('daemon', given, 'table');
  if (action === 'pause') return daemonPause(root);
  if (action === 'resume') return daemonResume(root);
  if (action === 'status') {
    const options = { now: (deps.now ?? Date.now)() };
    // The table is a view someone asked for: it is built from the dependencies
    // of the caller, so without them there is no table to show and the answer
    // says so instead of pretending the status has none.
    if (table === true) {
      if (deps.table === undefined || deps.table === null) {
        throw new Refusal('daemon: table needs deps.table');
      }
      options.table = deps.table;
    }
    return daemonStatus(root, options);
  }
  const now = deps.now ?? Date.now;
  const spawn = deps.spawn ?? makeSpawner({ logDir: paths(root).runs, now });
  return tick(root, { spawn });
}
