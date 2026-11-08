import { resolve } from 'node:path';
import { startConfigServer } from './server.js';
import { argsOf, fail, optionalChoice } from '../core/tool-arguments.js';
import { configOf } from '../core/context.js';

// One page per state root in this MCP process; promises also serialize concurrent opens.
const sessions = new Map();

export async function openConfigSession(root, args, deps = {}) {
  const a = argsOf('config_ui_open', args, ['locale', 'open']);
  if (a.open !== undefined && typeof a.open !== 'boolean') fail('config_ui_open: open must be boolean');
  const locale = optionalChoice('config_ui_open', a, 'locale', ['en', 'pt-BR'], await configOf(deps, root));
  const open = a.open ?? true;
  const key = resolve(root);
  const reused = sessions.has(key);
  if (!reused) {
    const pending = (deps.startConfigServer ?? startConfigServer)({ root, locale,
      env: deps.env, background: true });
    sessions.set(key, pending);
    pending.then((session) => session.closed.then(() => {
      if (sessions.get(key) === pending) sessions.delete(key);
    }), () => { if (sessions.get(key) === pending) sessions.delete(key); });
  }
  const session = await sessions.get(key);
  const url = new URL(session.url);
  url.searchParams.set('locale', locale);
  if (open) {
    const { openConfigBrowser } = await import('../cli.js');
    (deps.openConfigBrowser ?? openConfigBrowser)(url.href, deps.platform ?? process.platform);
  }
  return { url: url.href, idleMinutes: 10, reused };
}

export async function closeConfigSession(root) {
  if (!root) return;
  const pending = sessions.get(resolve(root));
  if (pending) await (await pending).close();
}
