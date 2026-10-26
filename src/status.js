// The quota table and inbox view. `statusTable`
// builds no command and prints no ANSI: the readings, the clock,
// the cap counts and the clock the cache ages with all arrive in `deps`, so
// the same table can be printed by the CLI, answered over MCP and asserted in a
// test without anything real.
import { configOf, DEFAULT_CONFIG, setupPending } from './profiles.js';
import { CLIENTS } from './spawn-process.js';
import { environmentSnapshot } from './env/snapshot.js';
import { labelsOf, clientsOf, rowOf, readingOf } from './env/quota.js';
export { CLIENT_ENV_MARKERS, detectClient, LABELS, labelsOf, ageOf, quotaOrigin, clientsOf, adapterQuotaReader } from './env/quota.js';
import { projectName, withDemandRef } from './demand-ref.js';
import { inboxList, holdText } from './inbox.js';

/**
 * One cell, made safe for a Markdown table: a newline would end the row and a
 * bare `|` would open a new column, and a quoted standing order can hold either.
 * The separator and the row stay as they are; only the text inside is touched.
 */
function cellText(value) {
  return String(value).replaceAll('|', '\\|').replace(/\s*[\r\n]+\s*/g, ' ');
}

/** One Markdown table: a header, a rule and one line per row. */
function markdownOf(columns, rows) {
  const line = (cells) => `| ${cells.map(cellText).join(' | ')} |`;
  return [
    line(columns),
    line(columns.map(() => '---')),
    ...rows.map((row) => line(row.cells)),
  ].join('\n');
}

/**
 * The selected client's quota table, plus its capacity line.
 *
 * Quota readings come only through `deps.readQuota`; demand display names
 * come from the state root. The reader is
 * wrapped in a TTL cache, so two calls inside `deps.ttlMs` read once.
 *
 * @param {string} root state root, part of the cache key
 * @param {{config?: object, clients?: string[], readQuota?: Function,
 *   now?: Function, orders?: object[], locale?: string, ttlMs?: number,
 *   limits?: object, cache?: Map, demands?: object[], env?: object,
 *   all?: boolean, client?: string}} deps
 * @returns {Promise<{markdown: string, capacityLine: string, rows: object[], demands: object[]}>}
 */
export async function statusTable(root, deps = {}) {
  const now = deps.now ?? Date.now;
  const labels = labelsOf(deps.locale);
  const config = configOf(deps.snapshot?.config ?? deps.config);
  const floor = config.lowQuotaPct;
  if (deps.client !== undefined && !CLIENTS.includes(deps.client)) {
    throw new TypeError('client must be one of ' + CLIENTS.join(', '));
  }
  if (deps.all !== undefined && typeof deps.all !== 'boolean') throw new TypeError('all must be a boolean');
  const snapshot = await environmentSnapshot({ ...deps, root, config, view: 'selected' });
  const detected = snapshot.inUse;
  const selected = deps.client ?? (deps.all ? null : detected);
  const clients = selected ? [selected] : (deps.clients ?? clientsOf(config));
  const note = !selected && !deps.all ? `\n\n${labels.unknownClient}` : '';

  const observations = snapshot.clients.filter((row) => clients.includes(row.client));
  const rows = observations.map((row) => ({ ...row.quota,
    ...rowOf(row.client, readingOf(row.reading), row.quotaReadAt, snapshot.config,
      labels, snapshot.now, deps.orders), models: row.models, actors: row.actors, slots: row.slots }));
  const capacity = observations.map(({ client, slots, slotEvidence }) => labels.cap(client,
    slotEvidence.running, slots.total, labels.capSource[slotEvidence.source], slots.available)).join('; ');
  const warnings = (deps.limits?.warnings ?? config.limitWarnings).map(labels.warning);
  const name = deps.demands?.length === 0 ? null : await projectName(root);
  const demands = (deps.demands ?? await inboxList(root)).map((item) => withDemandRef(item, name));
  const demandTable = demands.length === 0 ? '' : `\n\n${markdownOf(
    labels.demandColumns,
    demands.map((item) => ({ cells: [item.ref, item.status, item.title, holdText(item, config, deps.locale, now())] })),
  )}`;
  return {
    markdown: markdownOf(labels.columns, rows) + demandTable + note + `\n\n${labels.views}`,
    capacityLine: [labels.capacity(capacity, floor), ...warnings].join('\n'),
    rows,
    snapshot,
    missing: snapshot.plugin.missing,
    demands,
  };
}

/**
 * The one line the status shows while the setup is pending: what is missing and
 * the command that does it. `null` once the setup is done, so the line is gone
 * and the rest of the table is untouched.
 *
 * @param {object} config the settings of the root
 * @param {{locale?: string, command?: string}} [deps]
 * @returns {string|null}
 */
export function setupPendingLine(config, { locale = 'en', command = DEFAULT_CONFIG.install.command } = {}) {
  if (!setupPending(config)) return null;
  return labelsOf(locale).setupPending(command);
}

/**
 * Whether the table is worth showing before a task starts: a big task, a demand
 * split in more than one step, or more than one executor. Anything smaller than
 * that costs a round trip the user did not ask for.
 *
 * @param {{size?: string, slices?: number, executors?: number}} [input]
 * @returns {boolean}
 */
export function shouldShowStatus({ size, slices, executors } = {}) {
  if (size === 'L') return true;
  if (Number.isFinite(slices) && slices >= 2) return true;
  if (Number.isFinite(executors) && executors > 1) return true;
  return false;
}
