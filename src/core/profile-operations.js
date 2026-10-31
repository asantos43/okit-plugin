// The operations of the choice of the work: how hard the demand is and which
// assistant runs it. Each function takes the state root, the arguments (which
// arrive as `unknown` and are checked inside) and the dependencies of the
// caller, and returns the data of the answer.
//
// The tools that used to live in `src/mcp/tools.js` are here now, with the
// rules of the arguments they always had: they are checked with the helpers
// of `tool-arguments.js`, so the message a client reads stays the same.

import { classify } from '../classify.js';
import { profilePick } from '../profiles.js';
import { record } from '../telemetry/index.js';
import { configOf } from './context.js';
import { argsOf, optionalQuota, optionalText, requiredText } from './tool-arguments.js';

/** Classifies a demand as simple, normal or hard and says why. */
export async function classifyOperation(root, args) {
  const a = argsOf('classify', args, ['title', 'body', 'kind']);
  return classify({
    title: requiredText('classify', a, 'title'),
    body: optionalText('classify', a, 'body'),
    kind: optionalText('classify', a, 'kind'),
  });
}

/** Chooses an assistant for the work, using built-in choices before setup. */
export async function profilePickOperation(root, args, deps) {
  const a = argsOf('profile_pick', args, ['client', 'effort', 'quota']);
  const profile = profilePick({
    client: requiredText('profile_pick', a, 'client'),
    effort: requiredText('profile_pick', a, 'effort'),
    quota: optionalQuota('profile_pick', a, 'quota'),
    config: await configOf(deps, root),
  });
  await record(root, 'profile.choice', { client: a.client, ...profile });
  return profile;
}
