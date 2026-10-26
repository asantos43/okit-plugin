import { runPostCompact } from '../hook-post-compact.js';
import { stateRoot } from '../store.js';
import { configureRoles } from '../../adapters/opencode/index.js';

/** Native event bridge, loaded from the retained installation directory. */
export default async function plugin({ client, directory }) {
  return {
    config: async (config) => {
      const delivery = configureRoles(config);
      if (delivery.status !== 'ready') throw new Error(delivery.reason);
    },
    event: async ({ event }) => {
      if (event.type !== 'session.compacted') return;
      const lines = [];
      await runPostCompact({ root: stateRoot(), stdin: JSON.stringify({ cwd: directory }), stdout: (line) => lines.push(line) });
      if (lines.length) await client.app.log({ body: { service: 'installer', level: 'info', message: lines.join('\n') } });
    },
  };
}
