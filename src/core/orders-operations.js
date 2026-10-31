// The operations of the standing orders: the instruction the Director reads
// with every demand until it is revoked. Each function takes the state root,
// the arguments (which arrive as `unknown` and are checked inside) and the
// dependencies of the caller, and returns the data of the answer.
//
// The tools that used to live in `src/mcp/tools.js` are here now, with the
// rules of the arguments they always had: they are checked with the helpers
// of `tool-arguments.js`, so the message a client reads stays the same.

import { orderAdd, orderList, orderRemove, SCOPES } from '../orders.js';
import {
  argsOf, optionalAppliesTo, optionalChoice, optionalText, requiredText,
} from './tool-arguments.js';

// The core wants a reason on every revoke, so the tool supplies its own.
export const DEFAULT_REASON = 'revoked by the mcp tool order_remove';

/** Adds a standing order: one instruction the Director reads with every demand until it is revoked. */
export async function orderAddOperation(root, args) {
  const a = argsOf('order_add', args, ['text', 'scope', 'until', 'appliesTo']);
  return orderAdd(root, {
    text: requiredText('order_add', a, 'text'),
    scope: optionalChoice('order_add', a, 'scope', SCOPES),
    until: optionalText('order_add', a, 'until'),
    appliesTo: optionalAppliesTo('order_add', a, 'appliesTo'),
  });
}

/** Lists the standing orders that are active now, optionally for one project. */
export async function orderListOperation(root, args) {
  const a = argsOf('order_list', args, ['appliesTo']);
  return orderList(root, { appliesTo: optionalText('order_list', a, 'appliesTo') });
}

/** Revokes a standing order by id. Nothing is deleted, so the history survives. */
export async function orderRemoveOperation(root, args) {
  const a = argsOf('order_remove', args, ['id', 'reason']);
  return orderRemove(
    root,
    requiredText('order_remove', a, 'id'),
    { reason: optionalText('order_remove', a, 'reason') ?? DEFAULT_REASON },
  );
}
