// The operations of the inbox: the demand that arrives, the one that is held
// and the status it moves along. Each function takes the state root, the
// arguments (which arrive as `unknown` and are checked inside) and the
// dependencies of the caller, and returns the data of the answer.
//
// The tools that used to live in `src/mcp/tools.js` are here now, with the
// rules of the arguments they always had: they are checked with the helpers
// of `tool-arguments.js`, so the message a client reads stays the same.

import { EFFORT_CLASSES } from '../classify.js';
import { projectName, withDemandRef } from '../demand-ref.js';
import { inboxAdd, inboxClaim, inboxRelease, inboxList, inboxSetStatus, holdText, STATUSES } from '../inbox.js';
import { LOCALES } from '../profiles.js';
import { configOf } from './context.js';
import {
  argsOf, optionalAppliesTo, optionalChoice, optionalCount, optionalText, optionalTextList, requiredText,
} from './tool-arguments.js';

/** Adds a demand to the shared inbox and returns the stored item, id included. */
export async function inboxAddOperation(root, args) {
  const a = argsOf('inbox_add', args, ['title', 'body', 'kind', 'accept', 'effort', 'client', 'appliesTo', 'todoLink']);
  return inboxAdd(root, {
    title: requiredText('inbox_add', a, 'title'),
    body: optionalText('inbox_add', a, 'body'),
    kind: optionalText('inbox_add', a, 'kind'),
    accept: optionalTextList('inbox_add', a, 'accept'),
    effort: optionalChoice('inbox_add', a, 'effort', EFFORT_CLASSES),
    client: optionalText('inbox_add', a, 'client'),
    appliesTo: optionalAppliesTo('inbox_add', a, 'appliesTo'),
    todoLink: a.todoLink,
  });
}

/** Lists inbox items newest first, optionally filtered by status, client or project. */
export async function inboxListOperation(root, args, deps) {
  const a = argsOf('inbox_list', args, ['status', 'client', 'appliesTo', 'limit', 'locale']);
  const config = await configOf(deps, root);
  const locale = optionalChoice('inbox_list', a, 'locale', LOCALES, config);
  const items = await inboxList(root, {
    status: optionalChoice('inbox_list', a, 'status', STATUSES),
    client: optionalText('inbox_list', a, 'client'),
    appliesTo: optionalText('inbox_list', a, 'appliesTo'),
    limit: optionalCount('inbox_list', a, 'limit'),
  });
  const name = await projectName(root);
  return items.map((item) => ({ ...withDemandRef(item, name), owner: holdText(item, config, locale) }));
}

// The two holds share their shape: the id of the item, the client that holds
// it and the keys that say who is holding it.
async function holdOperation(name, keys, operation, root, args) {
  const a = argsOf(name, args, keys);
  const owner = { client: requiredText(name, a, 'client') };
  for (const key of keys.slice(2)) {
    const value = optionalText(name, a, key);
    if (value !== undefined) owner[key] = value;
  }
  return operation(root, requiredText(name, a, 'id'), owner);
}

/** Claims an inbox item atomically; refuses another active holder. */
export function inboxClaimOperation(root, args) {
  return holdOperation('inbox_claim', ['id', 'client', 'session', 'worktree'], inboxClaim, root, args);
}

/** Releases an owned or stale hold. */
export function inboxReleaseOperation(root, args) {
  return holdOperation('inbox_release', ['id', 'client', 'session'], inboxRelease, root, args);
}

/** Moves one inbox item along pending, delegated, criticised, consolidated or failed. */
export async function inboxSetStatusOperation(root, args) {
  const a = argsOf('inbox_set_status', args, ['id', 'status', 'holder']);
  if (a.holder !== undefined) {
    argsOf('holder', a.holder, ['client', 'session']);
    requiredText('holder', a.holder, 'client');
    optionalText('holder', a.holder, 'session');
  }
  return inboxSetStatus(
    root,
    requiredText('inbox_set_status', a, 'id'),
    optionalChoice('inbox_set_status', a, 'status', STATUSES),
    { holder: a.holder },
  );
}
