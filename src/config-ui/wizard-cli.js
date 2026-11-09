import { UsageError, exitCodeFor } from '../install/exit.js';
import { startConfigServer } from './server.js';
import { routeReason } from '../install/route.js';

/** Returned instead of an exit code when `--auto` could not open the browser: the caller runs the terminal installer. */
export const UI_FALLBACK = Symbol('ui-fallback');

/** Only explicit install UI flags enter here. Never fall back to terminal input. */
export async function installUiCommand(ctx, options, io, openBrowser, launchBrowser) {
  const supported = ['ui', 'headless', 'client', 'from', 'dest', 'no-path', 'no-link',
    'no-statusline', 'prerelease', 'locale', 'yes', 'auto',
    // From the generated script, which also holds the terminal fallback's arguments; only an `--auto` run has them.
    ...(options.auto ? ['asset', 'fallback', 'repo'] : [])];
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
  if (options.auto && !options.headless && launchBrowser) {
    // Nothing ran yet and no URL was shown: a browser that cannot open means the terminal installer, with the reason said.
    if (!(await launchBrowser(session.url, ctx.platform, io.spawn))) {
      stop(); await session.closed;
      ctx.out(routeReason(ctx.locale, 'opener-failed'));
      return UI_FALLBACK;
    }
    ctx.sessionUrl = session.url; ctx.out(session.url); ctx.sessionUrl = undefined;
  } else {
    ctx.sessionUrl = session.url; ctx.out(session.url); ctx.sessionUrl = undefined;
    if (!options.headless) openBrowser(session.url, ctx.platform, io.spawn);
  }
  if (ctx.signal?.aborted) stop();
  try { await session.closed; return exitCodeFor('ok'); }
  finally { ctx.signal?.removeEventListener('abort', stop); }
}
