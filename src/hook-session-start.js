import { readJson } from './state.js';
import { paths, SELFCHECK_ENV } from './store.js';
import { limitsStatus } from './limits.js';
import { environmentSnapshot } from './env/snapshot.js';
import { deliverRole } from '../adapters/claude-code/index.js';
import { record } from './telemetry/index.js';
import { briefedRole } from './roles.js';

/**
 * The snapshot of a run of the post-install check: what the hook reads from the state root and the files, and nothing
 * that starts a process (no client version probe, no model listing, no quota source command). Nothing it finds is
 * installed, which is all the check needs: it proves the hook starts, reads its input and answers.
 */
export const quietSnapshot = (deps) => environmentSnapshot({ ...deps, plugin: {}, versions: {},
  detectClients: async () => ({ clients: [] }), readQuota: async () => ({ source: 'off' }),
  run: async () => { throw Object.assign(new Error('not run'), { code: 'ENOENT' }); } });

/** Read-only native SessionStart response, including explicit diagnostic failures. */
export async function runSessionStart({ root, stdin = process.stdin, stdout = () => {},
  snapshot, env = process.env, loadSnapshot = environmentSnapshot } = {}) {
  try {
    let raw = typeof stdin === 'string' ? stdin : '';
    if (typeof stdin !== 'string') for await (const chunk of stdin) raw += chunk;
    const input = JSON.parse(raw);
    const files = paths(root);
    const [config, inbox, orders] = await Promise.all([
      readJson(files.config, {}), readJson(files.inbox, { items: [] }), readJson(files.orders, { orders: [] }),
    ]);
    const limits = await limitsStatus(root, config);
    // The check of an install sets SELFCHECK_ENV: the hook then starts nothing, whatever the configuration lists.
    const load = env?.[SELFCHECK_ENV] ? quietSnapshot : loadSnapshot;
    const observed = snapshot ?? await load({ root, config, env, limits, orders: orders.orders });
    const result = deliverRole({ snapshot: observed, limits, items: inbox.items, orders: orders.orders,
      cwd: input.cwd, briefing: input.briefing });
    await record(root, 'role.choice', { role: briefedRole(input.briefing), client: 'claude-code' });
    stdout(JSON.stringify(result.status === 'ready' ? { hookSpecificOutput: result.native.hookSpecificOutput }
      : { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: result.reason } }));
    // Claude only consumes context from successful command hooks.
    return 0;
  } catch (error) {
    stdout(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart',
      additionalContext: `okit role context unavailable / contexto de papel indisponível: ${error.message}` } }));
    return 0;
  }
}
