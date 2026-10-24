import { runPostCompact } from '../hook-post-compact.js';
import { stateRoot } from '../store.js';

/** Native event bridge, loaded from the retained installation directory. */
export default async function plugin({ client, directory }) {
  return {
    event: async ({ event }) => {
      if (event.type !== 'session.compacted') return;
      const lines = [];
      await runPostCompact({ root: stateRoot(), stdin: JSON.stringify({ cwd: directory }), stdout: (line) => lines.push(line) });
      if (lines.length) await client.app.log({ body: { service: 'installer', level: 'info', message: lines.join('\n') } });
    },
  };
}
