import { readQuota as readClientQuota } from '../../adapters/claude-code/index.js';
import { readQuota as readCodexQuota } from '../../adapters/codex/index.js';
import { readQuota as readOpencodeQuota } from '../../adapters/opencode/index.js';
import { CLIENTS } from '../spawn-process.js';
const DEFAULT_TTL_MS = 60_000;
const FIVE_HOURS_MINUTES = 360;
// A reading this far above the floor is comfortably green, not borderline.
const GREEN_MARGIN_PCT = 15;
// Any order that names the quota or the floor is the one a red row quotes.
const FLOOR_WORDS = /quota|cota|floor|piso/i;
const MISSING = '-';

export const CLIENT_ENV_MARKERS = {
  'claude-code': ['CLAUDECODE'],
  codex: ['CODEX_THREAD_ID', 'CODEX_CI'],
  opencode: ['OPENCODE', 'OPENCODE_PID'],
};

/** Session markers only: a configured home does not mean a client is running. */
export function detectClient(env = {}) {
  return Object.entries(CLIENT_ENV_MARKERS).find(([, markers]) => markers.some((name) => (
    typeof env[name] === 'string' && env[name].trim() !== '' && env[name] !== '0'
  )))?.[0] ?? null;
}

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
    optional: 'not installed (optional)',
    noQuota: (client) => `No quota value recorded. Record it with: okit-plugin quota set ${client} <pct>`,
    unknownClient: 'Client not recognized. Showing all clients; use --client <name> to choose one.',
    views: 'Slots show running executors; actors lists available model + effort profiles, even when nothing is running.',
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
    quotaSource: { automatic: 'automatic', manual: 'manual' },
    quotaAge: (minutes) => `${minutes} minute${minutes === 1 ? '' : 's'} ago`,
    unknownAge: 'age unknown',
    provider: 'provider',
    setupPending: (command) => `Setup is not done yet. Run ${command} setup to choose the models.`,
    modelsMissing: (client, command) => `No model confirmed for ${client}. Run ${command}.`,
  },
  'pt-BR': {
    columns: ['Assinatura', 'Restante 5h', 'Restante semana', 'Reseta em', 'Situação', 'Origem (idade)'],
    demandColumns: ['Demanda', 'Situação', 'Título', 'Dono'],
    status: { green: 'verde', yellow: 'amarelo', red: 'vermelho', off: 'desligado' },
    missing: MISSING,
    optional: 'não instalado (opcional)',
    noQuota: (client) => `Nenhum valor de cota registrado. Registre com: okit-plugin quota set ${client} <pct>`,
    unknownClient: 'Cliente não reconhecido. Mostrando todos os clientes; use --client <nome> para escolher um.',
    views: 'Vagas mostram executores em execução; actors lista perfis modelo + esforço disponíveis, mesmo sem nada rodando.',
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
    quotaSource: { automatic: 'automática', manual: 'manual' },
    quotaAge: (minutes) => `há ${minutes} minuto${minutes === 1 ? '' : 's'}`,
    unknownAge: 'idade desconhecida',
    provider: 'provedor',
    setupPending: (command) => `O setup ainda não foi feito. Rode ${command} setup para escolher os modelos.`,
    modelsMissing: (client, command) => `Nenhum modelo confirmado para ${client}. Rode ${command}.`,
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
function windowsOf(reading, now) {
  let fiveHour = null;
  let week = null;
  for (const window of Array.isArray(reading.windows) ? reading.windows : []) {
    const remaining = finite(window?.remainingPct);
    if (remaining === null) continue;
    const entry = {
      minutes: finite(window.windowMinutes) ?? finite(window.minutes) ?? Number.NaN,
      remainingPct: remaining,
      resetsInMinutes: finite(window.resetsInMinutes) ?? (Number.isFinite(Date.parse(window.resetsAt))
        ? Math.max(0, Date.parse(window.resetsAt) - now) / 60_000 : null),
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
export function ageOf(readAt, now, labels) {
  if (typeof readAt !== 'number') return MISSING;
  return labels.age(Math.max(0, Math.round((now - readAt) / 1000)));
}

export function quotaOrigin(reading, now, labels = LABELS.en) {
  const recorded = Date.parse(reading?.recordedAt);
  const age = Number.isFinite(recorded) ? Math.max(0, now - recorded) / 60_000 : reading?.ageMinutes;
  return `${labels.quotaSource[reading?.source === 'user' ? 'manual' : reading?.source] ?? reading?.source ?? labels.missing} (${typeof age === 'number'
    ? labels.quotaAge(Math.floor(age)) : labels.unknownAge})${reading?.provider ? ` — ${labels.provider}: ${reading.provider}` : ''}`;
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
  const observedAt = readAt;
  const recordedAt = Date.parse(reading?.recordedAt);
  if (Number.isFinite(recordedAt)) readAt = recordedAt;
  const { fiveHour, week } = reading === null ? { fiveHour: null, week: null } : windowsOf(reading, now);
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
    remainingPct: remainingOf({ fiveHour, week }),
    resetsInMinutes: resets ?? null,
    status,
    source,
    readAt: readAt ?? null,
    sampledAt: reading?.recordedAt ?? null,
    observedAt,
    order,
    // The cells are strings as well, so a caller never formats the table twice.
    cells: [
      client,
      cell(fiveHour?.remainingPct),
      cell(week?.remainingPct),
      typeof resets === 'number' ? labels.resets(resets) : labels.missing,
      reading === null ? labels.noQuota(client)
        : order === null ? labels.status[status] : `${labels.status[status]}: ${order}`,
      reading === null ? labels.missing : labels.quotaSource[source]
        ? quotaOrigin(reading, now, labels) : `${source} (${ageOf(readAt, now, labels)})`,
    ],
  };
}

// Real readings come from the adapter of each client, the same `readQuota` the
// daemon is handed as `deps.quota`. A client with no adapter yet reads `off`,
// which is a fact about the client, never a number invented here.
const ADAPTER_QUOTA = { 'claude-code': readClientQuota, codex: readCodexQuota, opencode: readOpencodeQuota };

/**
 * The subscriptions a table shows: the clients the root's own configuration
 * names, and the known clients when it names none, so a root that never wrote
 * a profile still shows its rows instead of an empty table. The default
 * catalog of `config.profiles` is a fallback for the profiles, not a
 * subscription: it never adds a client to the list.
 *
 * @param {object} config
 * @param {string[]} [fallback]
 * @returns {string[]}
 */
export function clientsOf(config, fallback = CLIENTS) {
  const configured = Array.isArray(config?.configuredClients) ? [...config.configuredClients]
    : Object.keys(config?.profiles ?? {}).sort();
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
export function adapterQuotaReader({ stateRoot: root, env, now, config, adapters = ADAPTER_QUOTA } = {}) {
  return async (client) => {
    const read = adapters[client];
    if (read === undefined) return { source: 'off' };
    return read({ stateRoot: root, env, now, config });
  };
}

export { DEFAULT_TTL_MS, readingWithAge, readingOf, rowOf };
