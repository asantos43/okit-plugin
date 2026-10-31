// The operations of the concurrency: the slot a run takes, the one it gives
// back and the caps of the moment. Each function takes the state root, the
// arguments (which arrive as `unknown` and are checked inside) and the
// dependencies of the caller, and returns the data of the answer.
//
// The tools that used to live in `src/mcp/tools.js` are here now, with the
// rules of the arguments they always had: they are checked with the helpers
// of `tool-arguments.js`, so the message a client reads stays the same.

import { acquireSlot, limitsStatus, releaseSlot } from '../limits.js';
import { configOf } from './context.js';
import { argsOf, optionalMs, requiredText } from './tool-arguments.js';

/** Reserves one concurrency slot for a run, or reports the cap that refuses it. */
export async function acquireSlotOperation(root, args, deps) {
  const a = argsOf('acquire_slot', args, ['runId', 'client', 'waitMs']);
  return acquireSlot(
    root,
    requiredText('acquire_slot', a, 'runId'),
    {
      client: requiredText('acquire_slot', a, 'client'),
      config: await configOf(deps, root),
      waitMs: optionalMs('acquire_slot', a, 'waitMs'),
    },
  );
}

/** Frees the slot of a run, so the next one fits under the cap. */
export async function releaseSlotOperation(root, args) {
  const a = argsOf('release_slot', args, ['runId']);
  return releaseSlot(root, requiredText('release_slot', a, 'runId'));
}

/** Reports the concurrency caps and the live runs per client. */
export async function limitsStatusOperation(root, args, deps) {
  argsOf('limits_status', args, []);
  return limitsStatus(root, await configOf(deps, root));
}
