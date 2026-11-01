// The one schema of the configuration: every key that is known, its type, its range and the rule that refuses a
// value. Two tables live here and one validator reads both kinds of value:
//   - CONFIG_SCHEMA, the keys `config show|get|set|unset` handle (their text is parsed by src/config.js);
//   - INSTALL_SCHEMA, the installer's settings (`install.*` of config.json), read by installConfig
//     (src/install/config.js) for install, update, uninstall, setup, kit, status and config.
// A value that is not valid is one refusal of usage (a `ConfigError`: kind `usage`, exit 2) that names the key and the
// rule, in English as raised and in pt-BR through `localizeReason`; never a TypeError or a RangeError of the code that
// would have used it. The tests build their invalid values from this table, so a key added without a type fails them.
import { ConfigError, DEFAULT_CONFIG, LOCALES, PROFILE_EFFORTS } from './profiles.js';
import { UsageError } from './install/exit.js';
import { RULES, fillRule } from './install/rules.js';

/** The largest number of milliseconds a timer takes (`setTimeout`, `AbortSignal.timeout`): 2^31 - 1. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

export const CONFIG_SCHEMA = Object.freeze({
  entries: [
    {
      path: 'limits.global', type: 'integer', minimum: 1, defaultPath: 'limits.global',
      legacyAliases: ['limits.perClient'],
      constraint: { en: 'an integer >= 1', 'pt-BR': 'um inteiro >= 1' },
      description: {
        en: 'Default number of executors allowed at once for each client.',
        'pt-BR': 'Número padrão de executores permitidos ao mesmo tempo em cada cliente.',
      },
    },
    {
      path: 'language', type: 'string', defaultPath: 'language', allowedValues: LOCALES,
      constraint: { en: 'one of the listed languages', 'pt-BR': 'um dos idiomas listados' },
      description: {
        en: 'Language used when no language is chosen for a command or tool.',
        'pt-BR': 'Idioma usado quando nenhum idioma é escolhido para um comando ou ferramenta.',
      },
    },
    {
      path: 'limits.clients.<client>', type: 'integer', minimum: 1, defaultPath: 'limits.global',
      placeholders: { client: 'clients' },
      constraint: { en: 'an integer >= 1', 'pt-BR': 'um inteiro >= 1' },
      description: {
        en: 'Executor limit for this client; it replaces the global limit.',
        'pt-BR': 'Limite de executores deste cliente; ele substitui o limite global.',
      },
    },
    {
      path: 'profiles.<client>.<class>', type: 'profile', defaultPath: 'profiles.<client>.<class>',
      placeholders: { client: 'clients', class: 'classes' },
      constraint: { en: 'the literal "null" to disable the class', 'pt-BR': 'o literal "null" para desligar a classe' },
      description: {
        en: 'The profile of this client and work class; null disables the class.',
        'pt-BR': 'O perfil deste cliente e desta classe de trabalho; null desliga a classe.',
      },
    },
    {
      path: 'profiles.<client>.<class>.model', type: 'string', defaultPath: 'profiles.<client>.<class>.model',
      placeholders: { client: 'clients', class: 'classes' },
      constraint: { en: 'non-empty text', 'pt-BR': 'texto não vazio' },
      description: {
        en: 'Model used for this client and work class.',
        'pt-BR': 'Modelo usado neste cliente e nesta classe de trabalho.',
      },
    },
    {
      path: 'profiles.<client>.<class>.effort', type: 'string', defaultPath: 'profiles.<client>.<class>.effort',
      placeholders: { client: 'clients', class: 'classes' },
      allowedValues: [...new Set(Object.values(PROFILE_EFFORTS))],
      constraint: { en: 'one of the listed efforts', 'pt-BR': 'um dos esforços listados' },
      description: {
        en: 'Reasoning effort used for this client and work class.',
        'pt-BR': 'Esforço de raciocínio usado neste cliente e nesta classe de trabalho.',
      },
    },
    {
      path: 'profiles.<client>.<class>.maxTurns', type: 'integer', minimum: 1,
      defaultPath: 'profiles.<client>.<class>.maxTurns',
      placeholders: { client: 'clients', class: 'classes' },
      constraint: { en: 'an integer >= 1', 'pt-BR': 'um inteiro >= 1' },
      description: {
        en: 'Maximum number of turns for this client and work class.',
        'pt-BR': 'Número máximo de voltas para este cliente e esta classe de trabalho.',
      },
    },
    {
      path: 'lowQuotaPct', type: 'number', minimum: 0, maximum: 100, defaultPath: 'lowQuotaPct',
      constraint: { en: 'a number from 0 to 100', 'pt-BR': 'um número de 0 a 100' },
      description: {
        en: 'Profiles are lowered when the remaining quota is below this percentage.',
        'pt-BR': 'Os perfis são rebaixados quando a cota restante fica abaixo deste percentual.',
      },
    },
    {
      path: 'daemon.minQuotaPct', type: 'number', minimum: 0, maximum: 100,
      defaultPath: 'daemon.minQuotaPct',
      constraint: { en: 'a number from 0 to 100', 'pt-BR': 'um número de 0 a 100' },
      description: {
        en: 'The daemon does not open demands when the remaining quota is below this percentage.',
        'pt-BR': 'O daemon não abre demandas quando a cota restante fica abaixo deste percentual.',
      },
    },
    {
      path: 'smoke.quotaFloorPct', type: 'number', minimum: 0, maximum: 100,
      defaultPath: 'smoke.quotaFloorPct',
      constraint: { en: 'a number from 0 to 100', 'pt-BR': 'um número de 0 a 100' },
      description: {
        en: 'Smoke refuses to start when the remaining quota is below this percentage.',
        'pt-BR': 'O smoke recusa iniciar quando a cota restante fica abaixo deste percentual.',
      },
    },
    ...Object.entries(DEFAULT_CONFIG.telemetry).filter(([key]) => key !== 'rede')
      .concat(Object.entries(DEFAULT_CONFIG.telemetry.rede).map(([key, value]) => [`rede.${key}`, value]))
      .map(([key, value]) => ({
        path: `telemetry.${key}`, defaultPath: `telemetry.${key}`,
        type: value === null ? 'text' : typeof value === 'object' ? 'object'
          : typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'integer' : 'string',
        // A timeout is a timer: past MAX_TIMER_MS it would fire at once.
        ...(typeof value === 'number' ? { minimum: 1, ...(/timeoutMs$/i.test(key) ? { maximum: MAX_TIMER_MS } : {}) } : {}),
        constraint: typeof value === 'string' ? { en: 'non-empty text', 'pt-BR': 'texto não vazio' }
          : typeof value !== 'number' ? { en: 'a measurement storage or sending setting', 'pt-BR': 'um ajuste de armazenamento ou envio de medições' }
          : /timeoutMs$/i.test(key) ? { en: `an integer from 1 to ${MAX_TIMER_MS}`, 'pt-BR': `um inteiro de 1 a ${MAX_TIMER_MS}` }
            : { en: 'an integer >= 1', 'pt-BR': 'um inteiro >= 1' },
        description: { en: 'Optional measurements; sending is separately enabled.',
          'pt-BR': 'Medições opcionais; o envio é ativado separadamente.' },
      })),
    ...Object.entries(DEFAULT_CONFIG.codexQuota).filter(([key]) => key !== 'fields')
      .concat(Object.entries(DEFAULT_CONFIG.codexQuota.fields).map(([key, value]) => [`fields.${key}`, value]))
      .map(([key, value]) => ({
        path: `codexQuota.${key}`, defaultPath: `codexQuota.${key}`,
        type: typeof value === 'number' ? 'integer' : 'string',
        ...(typeof value === 'number' ? { minimum: 1 } : {}),
        constraint: { en: typeof value === 'number' ? 'an integer >= 1' : 'non-empty text',
          'pt-BR': typeof value === 'number' ? 'um inteiro >= 1' : 'texto não vazio' },
        description: { en: 'Codex automatic quota reading setting.',
          'pt-BR': 'Ajuste da leitura automática de cota do Codex.' },
      })),
    ...['enabled', 'file', 'areaDir', 'section', 'checkbox.open', 'checkbox.progress', 'checkbox.done', 'projects'].map(key => ({
      path: `todo.${key}`, defaultPath: `todo.${key}`,
      type: key === 'enabled' ? 'boolean' : key === 'projects' ? 'object' : 'text',
      constraint: { en: 'a TODO setting (projects is a JSON object keyed by absolute project root)',
        'pt-BR': 'um ajuste do TODO (projects é um objeto JSON por raiz absoluta do projeto)' },
      description: { en: 'Project TODO synchronization setting.', 'pt-BR': 'Ajuste da sincronização do TODO do projeto.' },
    })),
  ],
  scopeMessages: { clients: 'unknownClient', classes: 'unknownClass' },
  scopePatterns: {
    clients: /^[A-Za-z0-9_-]+$/,
    classes: /^[A-Za-z0-9_-]+$/,
  },
  reservedPathSegments: ['__proto__', 'constructor', 'prototype'],
  origins: { default: 'default', user: 'user' },
  labels: {
    value: '{path} = {value} [{origin}] — {effect}',
    change: '{path}: before / antes = {before} [{beforeOrigin}] -> after / depois = {after} [{afterOrigin}] — {effect}',
  },
  messages: {
    unknownKey: 'Unknown configuration key "{key}". Valid key patterns: {patterns}. / Chave de configuração desconhecida "{key}". Padrões de chaves válidos: {patterns}.',
    unknownClient: 'Unknown client "{value}" for "{key}". Valid clients: {values}. / Cliente desconhecido "{value}" para "{key}". Clientes válidos: {values}.',
    unknownClass: 'Unknown class "{value}" for "{key}". Valid classes: {values}. / Classe desconhecida "{value}" para "{key}". Classes válidas: {values}.',
    invalidValue: 'Invalid value for "{key}". Expected {constraintEn}. / Valor inválido para "{key}". Esperado {constraintPt}.',
    invalidChoice: 'Invalid value for "{key}". Valid values: {values}. / Valor inválido para "{key}". Valores válidos: {values}.',
    disabledProfile: 'The profile "{path}" is disabled; run `config unset {path}` to enable it before changing a field. / O perfil "{path}" está desligado; rode `config unset {path}` para ligá-lo antes de mudar um campo.',
    legacyAliasRemoved: 'Removed legacy alias "{alias}"; it is the old name for "{key}". / O apelido legado "{alias}" foi removido; é o nome antigo de "{key}".',
  },
});

/** True when `value` (read from the saved file, already JSON) is one the entry takes: its type, minimum and maximum. */
export function entryAccepts(entry, value) {
  if (entry.type === 'string') return typeof value === 'string' && value.trim() !== '' && (entry.allowedValues ?? [value]).includes(value);
  if (entry.type === 'integer' ? !Number.isSafeInteger(value) : entry.type === 'number' ? !Number.isFinite(value) : false) return false;
  return !(entry.minimum !== undefined && value < entry.minimum) && !(entry.maximum !== undefined && value > entry.maximum);
}

/**
 * The values a subsystem reads from the saved configuration are checked by the same entries `config set` is checked by
 * (this table), never by a validator of the subsystem's own: a value saved outside them is one refusal of usage (exit 2)
 * that names the key and what it takes, in both languages as `config set` says it.
 *
 * @param {string[]} paths dotted paths of CONFIG_SCHEMA entries, e.g. `telemetry.retentionDays`
 * @param {(path: string) => unknown} valueOf the saved value of a path
 */
export function assertSavedValues(paths, valueOf) {
  for (const path of paths) {
    const entry = CONFIG_SCHEMA.entries.find((item) => item.path === path);
    if (entryAccepts(entry, valueOf(path))) continue;
    throw new UsageError(CONFIG_SCHEMA.messages.invalidValue.replaceAll('{key}', path)
      .replaceAll('{constraintEn}', entry.constraint.en).replaceAll('{constraintPt}', entry.constraint['pt-BR']));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The installer's settings.

const CONTROL = /[\r\n\0]/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// What `fetch` takes as the value of a header: single-byte characters (a ByteString), and no line break.
const BYTE_STRING = /^[\u0000-\u00ff]*$/;

// The nodes. `kind` says how a value is read; `rule` names the RULES entry (or is worked out from the node); the flags
// `nullable` (null is a value of the setting) and `optional` (the setting may be absent, with no default) are the only
// ways a node accepts more.
const text = (extra = {}) => ({ kind: 'text', ...extra });
const word = text();
const headerValue = text({ bytes: true, rule: 'headerValue' });
const plain = text({ plain: true });
const nullable = (node) => ({ ...node, nullable: true });
const optional = (node) => ({ ...node, optional: true });
const timer = { kind: 'integer', min: 1, max: MAX_TIMER_MS };
const size = { kind: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER };
const flag = { kind: 'boolean' };
const variable = { kind: 'text', pattern: ENV_NAME, rule: 'variable' };
const list = (item, extra = {}) => ({ kind: 'list', item, ...extra });
const filled = (item, extra = {}) => list(item, { min: 1, ...extra });
const record = (fields, extra = {}) => ({ kind: 'record', fields, ...extra });
const table = (open, extra = {}) => ({ kind: 'record', fields: {}, open, ...extra });

const SHELL = record({ files: filled(word), login: word });
const CLIENT = record({
  executable: word, strategy: { kind: 'choice', values: ['marketplace', 'module'] }, install: optional(flag), update: optional(flag),
  module: optional(word), configEnv: variable, rootParts: filled(word), xdgEnv: optional(variable), xdgParts: optional(filled(word)),
  // The MCP server of the client: the scope its own `mcp` commands take (null: the client takes none).
  mcp: optional(record({ scope: optional(nullable({ kind: 'choice', values: ['user', 'local', 'project'] })) })),
}, {
  // The pair reads one folder: a variable that names it and the folders under it, both or neither.
  refine: (client) => ((client.xdgEnv === undefined) !== (client.xdgParts === undefined)
    ? { at: client.xdgEnv === undefined ? 'xdgEnv' : 'xdgParts', rule: 'xdgPair' } : null),
});

// A shell of the check after an install: how it is started, how it finds the command, and (when it runs a string) how.
const SELFCHECK_SHELL = record({
  name: word, executable: word, candidates: optional(filled(word)), resolve: filled(word), run: optional(filled(word)), login: optional(filled(word)),
  quote: { kind: 'choice', values: ['posix', 'powershell', 'none'] },
});

/** The installer's settings (`install.*` of config.json): one node for every key of DEFAULT_CONFIG.install. */
export const INSTALL_SCHEMA = Object.freeze(record({
  kit: record({ executables: filled(plain), path: nullable(word), versionArgs: list(word), timeoutMs: timer, require: flag, hint: word, overlap: word }),
  repository: word,
  api: { kind: 'address' },
  headers: table(headerValue, { keys: { pattern: HEADER_NAME, rule: 'header' } }),
  timeoutMs: timer,
  maxDownloadBytes: size,
  maxExtractBytes: size,
  directory: word,
  destination: nullable(word),
  linkDirectory: nullable(word),
  recordName: text({ pattern: /^[^\\/]*\{client\}[^\\/]*$/, rule: 'recordName' }),
  dataRoots: table({ kind: 'list', min: 1, head: nullable(variable), item: word, rule: 'dataRoot' }),
  linkParts: filled(word),
  windowsLinkParts: filled(word),
  path: record({
    enabled: flag, candidates: filled(filled(word)), stateFile: plain,
    begin: word, end: word, shells: table(SHELL), fallbackShell: word,
    windowsShell: word, windowsExecutable: word, windowsVariable: word, shellVariable: variable,
    activate: table(word), messages: table(word),
  }, {
    refine: (path) => (path.begin === path.end ? { at: 'end', rule: 'differs' }
      : !Object.hasOwn(path.shells, path.fallbackShell) ? { at: 'fallbackShell', rule: 'knownShell' } : null),
  }),
  systems: table(word),
  architectures: table(word),
  windowsPlatform: word,
  command: plain,
  legacyCommands: list(plain),
  node: word,
  marketplace: word,
  entry: word,
  pluginsDirectory: word,
  daemonPollMs: timer,
  name: nullable(word),
  manifest: word,
  // The MCP server of the plugin: the name of the entry in the client and the file inside the installation.
  mcp: record({
    name: text({ pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/, rule: 'mcpName' }),
    server: text({ pattern: /^(?![\\/])(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, rule: 'mcpServer' }),
  }),
  clients: table(CLIENT),
  pathExtensions: list(text({ empty: true })),
  selfcheck: record({
    timeoutMs: timer, stateKeys: list(word), shells: table(filled(SELFCHECK_SHELL)), runner: table(word),
    sample: record({ usedPercentage: size, resetsInSeconds: size, hookInput: table(word) }),
  }),
}));

// ---------------------------------------------------------------------------------------------------------------
// The state files the installer writes and reads back (the person may have edited them). Each is checked by the same
// walker as the settings, so a field of the wrong type is a refusal of usage (exit 2), and a file that is not JSON is
// unreadable (exit 1). `<data>/install.<client>.json` is src/install/place.js; `managed-path.json` is src/install/link.js.

const textOrNull = nullable(text({ empty: true }));
const someText = optional(textOrNull);
/** The fields of an installation record; `previous` (the record it replaced) has the same fields, checked one by one. */
export const RECORD_FIELDS = Object.freeze({
  client: text(), system: someText, arch: someText, repo: someText, bin: someText, version: someText, path: someText,
  destination: someText, at: someText, sha256: someText, linkDirectory: optional(textOrNull),
  link: optional(nullable(flag)), autostart: optional(nullable(flag)), wasRunning: optional(nullable(flag)), prerelease: optional(nullable(flag)),
  statusline: optional(nullable(record({ path: text({ empty: true }), backup: text({ empty: true }), existed: optional(flag) }))),
  settings: optional(nullable(record({ node: someText }))),
});
/** `managed-path.json`: the profile blocks added to the person's shell files and the entry added to the Windows PATH. */
export const PATH_STATE_SCHEMA = Object.freeze(record({
  profiles: list(record({ path: text(), block: text({ lines: true, empty: true }) })),
  windows: optional(textOrNull),
}));

/** The first field of an installation record (and of the records it replaced) that is not valid, as a dotted path, or null. */
export function recordProblem(value) {
  let level = 'record';
  for (let item = value; ; item = item.previous) {
    if (!isObject(item)) return { path: level };
    const found = problemOf(record(level === 'record' ? RECORD_FIELDS : { ...RECORD_FIELDS, client: optional(text()) }), item);
    if (found) return { path: found.path ? `${level === 'record' ? '' : `${level}.`}${found.path}` : level };
    if (item.previous === undefined || item.previous === null) return null;
    level = level === 'record' ? 'previous' : `${level}.previous`;
  }
}

function describe(node) {
  const base = (() => {
    if (node.rule) return RULES[node.rule].en;
    switch (node.kind) {
      case 'text': return node.empty ? RULES.line.en : node.plain ? RULES.plain.en : RULES.text.en;
      case 'integer': return fillRule(RULES.integer.en, [node.min, node.max]);
      case 'boolean': return RULES.boolean.en;
      case 'address': return RULES.address.en;
      case 'choice': return fillRule(RULES.choice.en, [node.values.join(', ')]);
      case 'list': return fillRule(RULES[node.min ? 'filledList' : 'list'].en, [describe(node.item)]);
      default: return node.open ? fillRule(RULES.objectOf.en, [describe(node.open)]) : RULES.object.en;
    }
  })();
  return node.nullable ? fillRule(RULES.orNull.en, [base]) : base;
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function accepts(node, value) {
  switch (node.kind) {
    case 'text':
      return typeof value === 'string' && (node.empty || value.trim() !== '') && (node.lines ? !value.includes('\0') : !CONTROL.test(value))
        && (!node.plain || !/[\\/]/.test(value)) && (!node.pattern || node.pattern.test(value))
        && (!node.bytes || BYTE_STRING.test(value));
    case 'integer': return Number.isSafeInteger(value) && value >= node.min && value <= node.max;
    case 'boolean': return typeof value === 'boolean';
    case 'address':
      try {
        const address = typeof value === 'string' ? new URL(value) : null;
        // `fetch` refuses an address that carries a user name or a password.
        return address !== null && ['http:', 'https:'].includes(address.protocol) && !address.username && !address.password;
      } catch { return false; }
    case 'choice': return node.values.includes(value);
    default: return false;
  }
}

/**
 * The first thing wrong with a value, or null: `{ path, rule }` with the dotted path under the root and the rule in
 * English. `partial` is for what the user wrote on top of the defaults: a key that is absent is fine, a key that is
 * there must have the right type. The merged value is read in full, with the cross-key rules (`refine`).
 */
export function problemOf(node, value, { partial = false, path = '' } = {}) {
  const wrong = { path, rule: describe(node) };
  if (value === undefined) return partial || node.optional ? null : wrong;
  if (value === null) return node.nullable ? null : wrong;
  if (node.kind === 'list') {
    if (!Array.isArray(value) || value.length < (node.min ?? 0)) return wrong;
    const bad = value.some((item, index) => problemOf(index === 0 && node.head ? node.head : node.item, item, { partial: false }));
    return bad ? wrong : null;
  }
  if (node.kind === 'record') {
    if (!isObject(value)) return wrong;
    for (const [key, child] of Object.entries(node.fields)) {
      const found = problemOf(child, value[key], { partial, path: path ? `${path}.${key}` : key });
      if (found) return found;
    }
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(node.fields, key) || !node.open) continue;
      if (node.keys && !node.keys.pattern.test(key)) return { path: path ? `${path}.${key}` : key, rule: RULES[node.keys.rule].en };
      const found = problemOf(node.open, value[key], { partial, path: path ? `${path}.${key}` : key });
      if (found) return found;
    }
    const cross = !partial && node.refine?.(value);
    return cross ? { path: `${path}.${cross.at}`, rule: RULES[cross.rule].en } : null;
  }
  return accepts(node, value) ? null : wrong;
}

/**
 * Refuses a value of the installer's settings with one refusal of usage that names the key and the rule.
 *
 * @param {object} value the settings (the user's own, with `partial`, or the merged ones)
 * @param {object} [options]
 * @param {boolean} [options.partial] the user's settings over the defaults
 */
export function assertInstallSettings(value, { partial = false } = {}) {
  const found = problemOf(INSTALL_SCHEMA, value, { partial });
  if (!found) return;
  throw found.path
    ? new ConfigError('installSetting', { key: found.path, rule: found.rule })
    : new ConfigError('installRoot', { rule: found.rule });
}

/** The nodes of INSTALL_SCHEMA with their dotted path, the open tables filled from `defaults` (the tests walk them). */
export function installNodes(defaults = DEFAULT_CONFIG.install, node = INSTALL_SCHEMA, path = '') {
  const found = [];
  const own = (key, child, below) => found.push(...installNodes(below, child, path ? `${path}.${key}` : key));
  if (path) found.push({ path, node });
  if (node.kind !== 'record') return found;
  for (const [key, child] of Object.entries(node.fields)) own(key, child, defaults?.[key]);
  if (node.open) for (const key of Object.keys(defaults ?? {})) if (!Object.hasOwn(node.fields, key)) own(key, node.open, defaults[key]);
  return found;
}

// ---------------------------------------------------------------------------------------------------------------
// The keys of config.json that the code reads and neither table above lists.

/**
 * Top-level keys of config.json that are read and that DEFAULT_CONFIG does not hold, with their type and the place
 * that refuses a wrong value. The input inventory (test/helpers/input-inventory.js) scans src/ for every read of a key
 * of the configuration and fails for one that is in none of: DEFAULT_CONFIG, what `configOf` returns, this table.
 */
export const EXTRA_KEYS = Object.freeze({
  limitWarnings: { type: 'list', checkedBy: 'configOf (ConfigError limitWarnings)' },
  orders: { type: 'object', checkedBy: 'src/orders.js retentionDaysOf: a reader never stops, a wrong value is the default' },
});
