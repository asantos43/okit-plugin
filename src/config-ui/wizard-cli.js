import { UsageError, exitCodeFor } from '../install/exit.js';
import { startConfigServer } from './server.js';

/** Only explicit install UI flags enter here. Never fall back to terminal input. */
export async function installUiCommand(ctx, options, io, openBrowser) {
  const supported = ['ui', 'headless', 'client', 'from', 'dest', 'no-path', 'no-link',
    'no-statusline', 'prerelease', 'locale', 'yes'];
  for (const key of Object.keys(options)) {
    if (!supported.includes(key)) throw new UsageError(`Unknown flag: --${key}`);
  }
  const choices = {};
  for (const [flag, key] of Object.entries({ from: 'from', dest: 'destination',
    'no-path': 'noPath', 'no-link': 'noLink', 'no-statusline': 'noStatusline', prerelease: 'prerelease' })) {
    if (options[flag] !== undefined) choices[key] = options[flag];
  }
  if (options.client && !['all', 'claude-code', 'codex', 'opencode'].includes(options.client)) {
    throw new UsageError(`Invalid client ${options.client}; choose: claude-code, codex, opencode`);
  }
  const session = await (io.startConfigServer ?? startConfigServer)({ root: ctx.root, env: ctx.env,
    locale: ctx.locale, platform: ctx.platform, firstRun: { operation: 'install',
      clients: options.client && options.client !== 'all' ? [options.client] : null, options: choices },
    install: { io, run: ctx.run } });
  let stopped = false;
  const stop = () => { if (!stopped) { stopped = true; session.close(); } };
  ctx.signal?.addEventListener('abort', stop, { once: true });
  ctx.sessionUrl = session.url; ctx.out(session.url); ctx.sessionUrl = undefined;
  if (!options.headless) openBrowser(session.url, ctx.platform, io.spawn);
  if (ctx.signal?.aborted) stop();
  try { await session.closed; return exitCodeFor('ok'); }
  finally { ctx.signal?.removeEventListener('abort', stop); }
}
