import { readJson } from './state.js';
import { paths } from './store.js';
import { limitsStatus } from './limits.js';
import { environmentSnapshot } from './env/snapshot.js';
import { deliverRole } from '../adapters/claude-code/index.js';

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
    const observed = snapshot ?? await loadSnapshot({ root, config, env, limits, orders: orders.orders });
    const result = deliverRole({ snapshot: observed, limits, items: inbox.items, orders: orders.orders,
      cwd: input.cwd, briefing: input.briefing });
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
