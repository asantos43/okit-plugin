// The operations of the view of the machine: the quota that was recorded, the
// actors that can run the work, the environment in use and the notice of the
// kit. Each function takes the state root, the arguments (which arrive as
// `unknown` and are checked inside) and the dependencies of the caller, and
// returns the data of the answer.
//
// The tools that used to live in `src/mcp/tools.js` are here now, with the
// rules of the arguments they always had: they are checked with the helpers
// of `tool-arguments.js`, so the message a client reads stays the same.

import { listActors } from '../actors.js';
import { environmentReport, formatEnvironmentReport } from '../env/report.js';
import { limitsStatus } from '../limits.js';
import { orderList } from '../orders.js';
import { DEFAULT_CONFIG, LOCALES } from '../profiles.js';
import { quotaReleasedNotice } from '../quota/released.js';
import { CLIENTS } from '../spawn-process.js';
import { adapterQuotaReader, clientsOf, shouldShowStatus, statusTable } from '../status.js';
import { configOf } from './context.js';
import {
  argsOf, fail, optionalChoice, optionalCount, optionalText,
} from './tool-arguments.js';

// The sizes of a task the quota table can be read against.
export const SIZES = ['S', 'M', 'L'];

/** Shows recorded quota, its age and available executors for the detected client. */
export async function statusOperation(root, args, deps) {
  const ctx = { ...deps, root };
  const a = argsOf('status', args, ['locale', 'size', 'slices', 'executors', 'all', 'client']);
  if (a.all !== undefined && typeof a.all !== 'boolean') fail('status: all must be a boolean');
  const size = optionalChoice('status', a, 'size', SIZES);
  const slices = optionalCount('status', a, 'slices');
  const executors = optionalCount('status', a, 'executors');
  const config = await configOf(deps, root);
  const env = ctx.env ?? process.env;
  const table = await statusTable(root, {
    ...ctx,
    config,
    env,
    all: a.all,
    client: optionalChoice('status', a, 'client', CLIENTS),
    clients: clientsOf(config),
    readQuota: ctx.readQuota ?? adapterQuotaReader({ stateRoot: root, env }),
    now: ctx.now,
    orders: ctx.orders ?? await orderList(root),
    limits: ctx.limits ?? (ctx.snapshot ? undefined : await limitsStatus(root, config)),
    locale: optionalChoice('status', a, 'locale', LOCALES, config),
    cache: ctx.quotaCache,
  });

  // The three facts of a task are optional, so `showBefore` appears only when
  // the caller sent at least one of them.
  const asked = [size, slices, executors].some((value) => value !== undefined);
  return asked ? { ...table, showBefore: shouldShowStatus({ size, slices, executors }) } : table;
}

/** Turns the kit's quota-back event into a plain sentence for the user, in their language. */
export async function quotaNoticeOperation(root, args, deps) {
  const a = argsOf('quota_notice', args, ['locale', 'event']);
  const config = await configOf(deps, root);
  const locale = optionalChoice('quota_notice', a, 'locale', LOCALES, config);
  const event = a.event === null ? undefined : a.event;
  if (event !== undefined && (typeof event !== 'object' || Array.isArray(event))) {
    fail(locale === 'pt-BR'
      ? 'quota_notice: o evento deve ser um objeto quando informado'
      : 'quota_notice: event must be an object when given');
  }
  return quotaReleasedNotice(event, locale);
}

/** Lists the actors of the clients: models, effort and availability. */
export async function actorsListOperation(root, args, deps) {
  const ctx = { ...deps, root };
  const a = argsOf('actors_list', args, ['locale', 'all', 'client']);
  const config = await configOf(deps, root);
  const env = ctx.env ?? process.env;
  return listActors({ ...ctx, root, config, env, all: a.all,
    client: optionalChoice('actors_list', a, 'client', CLIENTS),
    locale: optionalChoice('actors_list', a, 'locale', LOCALES, config),
    readQuota: ctx.readQuota ?? adapterQuotaReader({ stateRoot: root, env }),
    now: ctx.now, cache: ctx.quotaCache, orders: ctx.orders ?? await orderList(root),
    limits: ctx.limits ?? (ctx.snapshot ? undefined : await limitsStatus(root, config)) });
}

/** Shows which environment is in use and what is missing with commands to fix it. */
export async function envReportOperation(root, args, deps) {
  const ctx = { ...deps, root };
  const a = argsOf('env_report', args, ['client', 'locale']);
  const client = optionalText('env_report', a, 'client');
  const env = ctx.env ?? process.env;
  const config = await configOf(deps, root);
  const locale = optionalChoice('env_report', a, 'locale', LOCALES, config);
  if (client !== undefined && !Object.hasOwn(DEFAULT_CONFIG.install.clients, client)) {
    return { unknownClient: true, text: formatEnvironmentReport({ unknownClient: true }, locale) };
  }
  const report = await environmentReport({ ...ctx, config, env, client, locale,
    readQuota: ctx.readQuota ?? adapterQuotaReader({ stateRoot: root, env }),
    cache: ctx.quotaCache, limits: ctx.limits ?? (ctx.snapshot ? undefined : await limitsStatus(root, config)) });
  return { ...report, text: formatEnvironmentReport(report, locale) };
}
