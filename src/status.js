// The quota table and inbox view. `statusTable`
// builds no command and prints no ANSI: the readings, the clock,
// the cap counts and the clock the cache ages with all arrive in `deps`, so
// the same table can be printed by the CLI, answered over MCP and asserted in a
// test without anything real.
import { readQuota as readClientQuota } from '../adapters/claude-code/index.js';
import { readQuota as readCodexQuota } from '../adapters/codex/index.js';
import { readQuota as readOpencodeQuota } from '../adapters/opencode/index.js';
import { configOf, normalizeLimits } from './profiles.js';
import { capOf } from './limits.js';
import { CLIENTS } from './spawn-process.js';
import { projectName, withDemandRef } from './demand-ref.js';
import { inboxList, holdText } from './inbox.js';

const DEFAULT_TTL_MS = 60_000;
const FIVE_HOURS_MINUTES = 360;
// A reading this far above the floor is comfortably green, not borderline.
const GREEN_MARGIN_PCT = 15;
// Any order that names the quota or the floor is the one a red row quotes.
const FLOOR_WORDS = /quota|cota|floor|piso/i;
const MISSING = '-';

/** A finite number, or `null`. `NaN` is not a reading and never becomes a zero. */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Every word the table prints lives here, in both languages, so a pt-BR table is
// the same table translated and never a second implementation.
export const LABELS = {
  en: {
    columns: ['Subscription', '5h remaining', 'Week remaining', 'Resets in', 'Status', 'Source (age)'],
    demandColumns: ['Demand', 'Status', 'Title', 'Holder'],
    status: { green: 'green', yellow: 'yellow', red: 'red', off: 'off' },
    missing: MISSING,
    pct: (value) => `${Math.round(value)}%`,
    capacity: (clients, floor) => (
      `executors that can launch now: ${clients}; quota floor ${floor}%`
    ),
    capSource: { client: 'client', default: 'default' },
    cap: (client, live, cap, source, available) => `${client}: ${live}/${cap} (${source}), ${available} available`,
    warning: (warning) => `warning: ${warning === 'deprecated perClient' ? 'limits.perClient is deprecated; used as limits.global (default per client)' : warning}`,
    floorOrder: (floor) => `lowQuotaPct is ${floor}%`,
    resets: (minutes) => `${minutes}m`,
    age: (seconds) => `${seconds}s`,
  },
  'pt-BR': {
    columns: ['Assinatura', 'Restante 5h', 'Restante semana', 'Reseta em', 'Situação', 'Origem (idade)'],
    demandColumns: ['Demanda', 'Situação', 'Título', 'Dono'],
    status: { green: 'verde', yellow: 'amarelo', red: 'vermelho', off: 'desligado' },
    missing: MISSING,
    pct: (value) => `${Math.round(value)}%`,
    capacity: (clients, floor) => (
      `executores que podem iniciar agora: ${clients}; piso de cota ${floor}%`
    ),
    capSource: { client: 'própria', default: 'padrão' },
    cap: (client, live, cap, source, available) => `${client}: ${live}/${cap} (${source}), ${available} disponíveis`,
    warning: (warning) => `aviso: ${warning === 'deprecated perClient' ? 'limits.perClient obsoleto; usado como limits.global (padrão por cliente)' : warning.replace('unknown client:', 'cliente desconhecido:')}`,
    floorOrder: (floor) => `lowQuotaPct é ${floor}%`,
    resets: (minutes) => `${minutes}m`,
    age: (seconds) => `${seconds}s`,
  },
};

/**
 * The label set of one locale. An unknown locale falls back to `en`, never to a
 * half-translated line.
 *
 * @param {string} [locale]
 * @returns {object} the labels
 */
export function labelsOf(locale) {
  return LABELS[locale] ?? LABELS.en;
}

/**
 * The reading, or `null` when there is nothing to show: no reading at all, one
 * with the source `off`, or one that never carried a number. A missing number
 * is never turned into a zero, which would read as "all spent".
 */
function readingOf(reading) {
  if (reading === null || typeof reading !== 'object') return null;
  if (reading.source === 'off') return null;
  const hasWindows = Array.isArray(reading.windows)
    && reading.windows.some((window) => finite(window?.remainingPct) !== null);
  if (finite(reading.remainingPct) === null && !hasWindows) return null;
  return reading;
}

/**
 * Splits a reading into the two columns the table shows. A `windows` array is
 * used as it comes, the widest window of each kind; without it the single
 * `remainingPct` is the 5h window when `windowMinutes` says so and the week
 * window otherwise, including when `windowMinutes` is absent.
 */
function windowsOf(reading) {
  let fiveHour = null;
  let week = null;
  for (const window of Array.isArray(reading.windows) ? reading.windows : []) {
    const remaining = finite(window?.remainingPct);
    if (remaining === null) continue;
    const entry = {
      minutes: finite(window.minutes) ?? Number.NaN,
      remainingPct: remaining,
      resetsInMinutes: finite(window.resetsInMinutes),
    };
    const short = entry.minutes <= FIVE_HOURS_MINUTES;
    const held = short ? fiveHour : week;
    if (held === null || entry.minutes > held.minutes) {
      if (short) fiveHour = entry;
      else week = entry;
    }
  }

  if (fiveHour === null && finite(reading.remainingPct) !== null) {
    const single = {
      minutes: null,
      remainingPct: finite(reading.remainingPct),
      resetsInMinutes: finite(reading.resetsInMinutes),
    };
    const short = finite(reading.windowMinutes) !== null && reading.windowMinutes <= FIVE_HOURS_MINUTES;
    if (short) fiveHour = single;
    else if (week === null) week = single;
  }
  return { fiveHour, week };
}

// The row shows the tightest of the two windows: a green 5h bar next to a week
// that is nearly gone is still a red row.
function remainingOf({ fiveHour, week }) {
  const values = [fiveHour?.remainingPct, week?.remainingPct].map(finite).filter((value) => value !== null);
  return values.length === 0 ? null : Math.min(...values);
}

function statusOf(remaining, floor) {
  if (typeof remaining !== 'number') return 'off';
  if (remaining < floor) return 'red';
  if (remaining >= floor + GREEN_MARGIN_PCT) return 'green';
  return 'yellow';
}

/**
 * What a red row quotes: the standing order that names the quota or the floor,
 * so the reason is the user's own words, or `lowQuotaPct` itself when the user
 * wrote no order about it.
 */
function floorQuote(orders, floor, labels) {
  const texts = (Array.isArray(orders) ? orders : [])
    .map((order) => (typeof order?.text === 'string' ? order.text : null))
    .filter((text) => text !== null && FLOOR_WORDS.test(text));
  return texts[0] ?? labels.floorOrder(floor);
}

/** A reading is aged by the clock it arrived on, in whole seconds. */
function ageOf(readAt, now, labels) {
  if (typeof readAt !== 'number') return MISSING;
  return labels.age(Math.max(0, Math.round((now - readAt) / 1000)));
}

/**
 * Reads a client once per TTL. The cache is shared by default so two calls in a
 * row cost one read, and `deps.cache` hands a caller one of its own instead.
 * The key carries the root, so two state roots never trade a reading.
 *
 * @param {Map} cache
 * @param {string} root
 * @param {string} client
 * @param {Function} read
 * @param {Function} now
 * @param {number} ttlMs
 * @returns {Promise<{reading: object|null, readAt: number|null, cached: boolean}>}
 */
async function readingWithAge(cache, root, client, read, now, ttlMs) {
  const key = `${root}\n${client}`;
  const held = cache.get(key);
  if (held !== undefined && now() - held.at < ttlMs) return { ...held, cached: true };
  const reading = typeof read === 'function' ? await read(client) : null;
  const entry = { reading, at: now() };
  cache.set(key, entry);
  return { ...entry, cached: false };
}

function rowOf(client, reading, readAt, config, labels, now, orders) {
  const { fiveHour, week } = reading === null ? { fiveHour: null, week: null } : windowsOf(reading);
  const floor = config.lowQuotaPct;
  const status = reading === null ? 'off' : statusOf(remainingOf({ fiveHour, week }), floor);
  const cell = (value) => {
    const shown = finite(value);
    return shown === null ? labels.missing : labels.pct(shown);
  };
  const resets = finite(fiveHour?.resetsInMinutes) ?? finite(week?.resetsInMinutes);
  const source = reading === null ? 'off' : (reading.source ?? MISSING);
  const order = status === 'red' ? floorQuote(orders, floor, labels) : null;
  return {
    client,
    fiveHour: fiveHour?.remainingPct ?? null,
    week: week?.remainingPct ?? null,
    resetsInMinutes: resets ?? null,
    status,
    source,
    readAt: readAt ?? null,
    order,
    // The cells are strings as well, so a caller never formats the table twice.
    cells: [
      client,
      cell(fiveHour?.remainingPct),
      cell(week?.remainingPct),
      typeof resets === 'number' ? labels.resets(resets) : labels.missing,
      order === null ? labels.status[status] : `${labels.status[status]}: ${order}`,
      `${source} (${ageOf(readAt, now, labels)})`,
    ],
  };
}

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

/** How many executors can launch right now, never below zero. */
function room(limit, live) {
  const used = Number.isFinite(live) ? live : 0;
  return Math.max(0, (Number.isFinite(limit) ? limit : 0) - used);
}

// The readings stay for a minute between two calls, so a Director that asks
// twice in a row (a table, then a step) does not ask the client twice.
const READING_CACHE = new Map();

/**
 * The quota table of every client, as Markdown, plus the capacity line under it.
 *
 * Quota readings come only through `deps.readQuota`; demand display names
 * come from the state root. The reader is
 * wrapped in a TTL cache, so two calls inside `deps.ttlMs` read once.
 *
 * @param {string} root state root, part of the cache key
 * @param {{config?: object, clients?: string[], readQuota?: Function,
 *   now?: Function, orders?: object[], locale?: string, ttlMs?: number,
 *   limits?: object, cache?: Map, demands?: object[]}} deps
 * @returns {Promise<{markdown: string, capacityLine: string, rows: object[], demands: object[]}>}
 */
export async function statusTable(root, deps = {}) {
  const now = deps.now ?? Date.now;
  const labels = labelsOf(deps.locale);
  const config = configOf(deps.config);
  const floor = config.lowQuotaPct;
  const ttlMs = Number.isFinite(deps.ttlMs) ? deps.ttlMs : DEFAULT_TTL_MS;
  const cache = deps.cache ?? READING_CACHE;
  const clients = Array.isArray(deps.clients) ? deps.clients : [];

  const rows = [];
  for (const client of clients) {
    const { reading, at } = await readingWithAge(cache, root, client, deps.readQuota, now, ttlMs);
    rows.push(rowOf(client, readingOf(reading), at, config, labels, now(), deps.orders));
  }

  const limits = normalizeLimits(deps.limits?.limits ?? config.limits);
  const byClient = deps.limits?.byClient ?? {};
  const capacityClients = new Set([...clients, ...Object.keys(limits.clients), ...Object.keys(byClient)]);
  const capacity = [...capacityClients].map((client) => {
    const { cap, source } = capOf(limits, client);
    return labels.cap(client, byClient[client] ?? 0, cap, labels.capSource[source], room(cap, byClient[client]));
  }).join('; ');
  const warnings = (deps.limits?.warnings ?? config.limitWarnings).map(labels.warning);
  const name = await projectName(root);
  const demands = (deps.demands ?? await inboxList(root)).map((item) => withDemandRef(item, name));
  const demandTable = demands.length === 0 ? '' : `\n\n${markdownOf(
    labels.demandColumns,
    demands.map((item) => ({ cells: [item.ref, item.status, item.title, holdText(item, config, deps.locale, now())] })),
  )}`;
  return {
    markdown: markdownOf(labels.columns, rows) + demandTable,
    capacityLine: [labels.capacity(capacity, floor), ...warnings].join('\n'),
    rows,
    demands,
  };
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

// Real readings come from the adapter of each client, the same `readQuota` the
// daemon is handed as `deps.quota`. A client with no adapter yet reads `off`,
// which is a fact about the client, never a number invented here.
const ADAPTER_QUOTA = { 'claude-code': readClientQuota, codex: readCodexQuota, opencode: readOpencodeQuota };

/**
 * The subscriptions a table shows: the clients `config.profiles` gives a
 * profile to, and the known clients when it gives none, so a root that never
 * wrote a profile still shows its rows instead of an empty table.
 *
 * @param {object} config
 * @param {string[]} [fallback]
 * @returns {string[]}
 */
export function clientsOf(config, fallback = CLIENTS) {
  const configured = Object.keys(config?.profiles ?? {}).sort();
  const wanted = Array.isArray(fallback) && fallback.length > 0 ? fallback : CLIENTS;
  return configured.length > 0 ? configured : [...wanted];
}

/**
 * The `readQuota` the CLI and the MCP tool use: the adapter of the client, or
 * `off` for a client that has none.
 *
 * @param {{stateRoot: string, env?: object, adapters?: object}} input
 * @returns {Function} `async (client) => reading`
 */
export function adapterQuotaReader({ stateRoot: root, env, adapters = ADAPTER_QUOTA } = {}) {
  return async (client) => {
    const read = adapters[client];
    if (read === undefined) return { source: 'off' };
    return read({ stateRoot: root, env });
  };
}
