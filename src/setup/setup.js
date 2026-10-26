import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';

import { CONFIG_SCHEMA, resolveEntry } from '../config.js';
import { configOf, DEFAULT_CONFIG, PROFILE_EFFORTS } from '../profiles.js';
import { readJson, withLock, writeJsonAtomic } from '../state.js';
import { paths } from '../store.js';
import { environmentSnapshot } from '../env/snapshot.js';

/**
 * Whether the input already ended: a reader opened on it would wait for an
 * `end` event that will never come again, so every question would wait
 * forever.
 */
function inputEnded(stdin) {
  return stdin?.readableEnded === true || stdin?.destroyed === true;
}

export function setupReader({ stdin = process.stdin, output = process.stdout } = {}) {
  // An input that already ended has nothing to read: every question is
  // answered with nothing, which cancels the setup, and no reader is opened.
  if (inputEnded(stdin)) {
    return { ask: async () => undefined, close: () => {} };
  }
  const reader = createInterface({ input: stdin, output });
  const lines = reader[Symbol.asyncIterator]();
  let closed = false;
  reader.on('close', () => { closed = true; });
  return {
    ask: async (question, recommended) => {
      const suffix = recommended ? ` [${recommended}]` : '';
      // The input ended between two questions: the prompt is not written
      // again, but the lines that already arrived are still answers.
      if (!closed) {
        reader.setPrompt(`${question}${suffix} `);
        reader.prompt();
      }
      const answer = await lines.next();
      return answer.done ? undefined : answer.value;
    },
    close: () => reader.close(),
  };
}

// The one sentence for a configuration that cannot be read: the setup, the
// offer at the end of an installation and the command line all say the same
// thing, in the two languages, without ids and without jargon.
export const CONFIG_UNREADABLE = Object.freeze({
  en: 'Could not check the configuration: the file is not readable. Fix it with `{command} config show`.',
  'pt-BR': 'Não foi possível verificar a configuração: o arquivo não está legível. Corrija com `{command} config show`.',
});

// The one sentence for a configuration that could not be saved: the folder
// that holds it refused the write. It names that folder and the command to
// run again, and never the technical text of the system.
export const CONFIG_NOT_SAVED = Object.freeze({
  en: 'Could not save the configuration: check the permissions of the folder `{path}` and run `{command} setup` again.',
  'pt-BR': 'Não foi possível salvar a configuração: verifique as permissões da pasta `{path}` e rode `{command} setup` de novo.',
});

/**
 * The write of the configuration failed: the folder that holds it refused
 * the write. The setup, the offer at the end of an installation and the
 * command line all say the same simple sentence, in the two languages.
 */
export class SetupSaveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SetupSaveError';
  }
}

/**
 * A refusal of the setup itself: an unreadable configuration or a name
 * outside the schema. It keeps its own sentence and never becomes the
 * sentence of a failed write.
 */
class SetupRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'SetupRefusal';
  }
}

export const SETUP_MESSAGES = Object.freeze({
  plan: {
    en: '{client} ({class}): use {model}. {reason}',
    'pt-BR': '{client} ({classe}): usar {model}. {reason}',
  },
  question: {
    en: 'Choose a model for {client} ({class}). Options: {options}. Recommended: {recommended}. {reason}',
    'pt-BR': 'Escolha um modelo para {client} ({classe}). Opções: {options}. Recomendado: {recommended}. {reason}',
  },
  invalid: {
    en: 'Choose one of the listed models.',
    'pt-BR': 'Escolha um dos modelos listados.',
  },
  cancelled: {
    en: 'Setup was cancelled and nothing was saved.',
    'pt-BR': 'O setup foi cancelado e nada foi salvo.',
  },
  confirm: {
    en: 'Save these model settings? {choices}',
    'pt-BR': 'Salvar estas configurações de modelo? {choices}',
  },
  omitted: {
    en: 'No model was chosen for {client} ({class}). You can choose one later with `okit-plugin config set profiles.{client}.{class}.model <model>`.',
    'pt-BR': 'Nenhum modelo foi escolhido para {client} ({classe}). Você pode escolher um depois com `okit-plugin config set profiles.{client}.{class}.model <model>`.',
  },
  summary: {
    en: 'Saved {count} model settings for {clients}.',
    'pt-BR': 'Foram salvas {count} configurações de modelo para {clients}.',
  },
  unchanged: {
    en: 'Everything was already configured; nothing changed.',
    'pt-BR': 'Tudo já estava configurado; nada mudou.',
  },
  none: {
    en: 'No model settings were saved.',
    'pt-BR': 'Nenhuma configuração de modelo foi salva.',
  },
  noActiveModel: {
    en: 'No client with an active model was found; install or activate one and run the setup again.',
    'pt-BR': 'Nenhum cliente com modelo ativo foi encontrado; instale ou ative um e rode o setup de novo.',
  },
  kept: {
    en: 'Kept the newer values for {classes}.',
    'pt-BR': 'Manteve os valores mais novos para {classes}.',
  },
  unknownClass: {
    en: 'Unknown class "{class}" for "{client}". Valid classes: {classes}.',
    'pt-BR': 'Classe desconhecida "{class}" para "{client}". Classes válidas: {classes}.',
  },
  unknownClient: {
    en: 'Unknown client "{client}". Valid clients: {clients}.',
    'pt-BR': 'Cliente desconhecido "{client}". Clientes válidos: {clients}.',
  },
  invalidSetting: {
    en: 'The model or effort for {client} ({class}) is not valid. Nothing was saved.',
    'pt-BR': 'O modelo ou o esforço de {client} ({classe}) não é válido. Nada foi salvo.',
  },
  invalidConfigValue: {
    en: 'The configuration file has a value that is not accepted; fix it with `{command} config show` and run `{command} setup` again.',
    'pt-BR': 'O arquivo de configuração tem um valor que não é aceito; corrija com `{command} config show` e rode `{command} setup` de novo.',
  },
  invalidProfiles: {
    en: 'The configuration has a name that is not allowed. Nothing was saved.',
    'pt-BR': 'A configuração tem um nome que não é permitido. Nada foi salvo.',
  },
  invalidAnswer: {
    en: 'No valid answer was chosen. Nothing was saved.',
    'pt-BR': 'Nenhuma resposta válida foi escolhida. Nada foi salvo.',
  },
  invalidConfirmation: {
    en: 'Answer yes to save or leave it empty to cancel.',
    'pt-BR': 'Responda sim para salvar ou deixe vazio para cancelar.',
  },
  askUnavailable: {
    en: 'Interactive setup needs an input reader.',
    'pt-BR': 'O setup interativo precisa de um leitor de entrada.',
  },
  unreadable: CONFIG_UNREADABLE,
  notSaved: CONFIG_NOT_SAVED,
});

function fill(text, values) {
  return text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
}

function format(key, locale, values = {}) {
  const message = SETUP_MESSAGES[key];
  const language = locale === 'en' ? message.en : locale === 'pt-BR' ? message['pt-BR'] : null;
  if (language !== null) return fill(language, values);
  return `${fill(message.en, values)} / ${fill(message['pt-BR'], values)}`;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether the raw profiles can be read: they are a plain object and every
 * client inside them holds a plain object too. A name outside the schema is
 * a different refusal, with its own sentence.
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
function readableRawProfiles(raw) {
  if (raw?.profiles === undefined) return true;
  if (!isRecord(raw.profiles)) return false;
  return Object.values(raw.profiles).every((values) => isRecord(values));
}

/**
 * Whether the configuration file holds a configuration: its root is a plain
 * object and the profiles it holds are plain objects too. An array, a number,
 * a text or `null` is not one, and a setup that found one refuses to write
 * anything.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isReadableConfig(value) {
  return isRecord(value) && readableRawProfiles(value);
}

/**
 * The one sentence for a configuration that cannot be read: the setup, the
 * offer at the end of an installation and the command line all say the same
 * thing, in the language asked for.
 *
 * @param {string} [locale] 'en', 'pt-BR' or 'both'
 * @param {string} [command] the name of the command
 * @returns {string}
 */
export function formatUnreadable(locale = 'both', command = DEFAULT_CONFIG.install.command) {
  return format('unreadable', locale, { command });
}

/**
 * The one sentence for a configuration that could not be saved: the folder
 * that holds it refused the write. It names that folder and the command to
 * run again, and never the technical text of the system.
 *
 * @param {string} [locale] 'en', 'pt-BR' or 'both'
 * @param {string} [path] the folder that holds the configuration
 * @param {string} [command] the name of the command
 * @returns {string}
 */
export function formatNotSaved(locale = 'both', path = '', command = DEFAULT_CONFIG.install.command) {
  return format('notSaved', locale, { path, command });
}

/** A configuration that cannot be read stops the setup before any write. */
function assertReadableConfig(raw, locale, command) {
  if (!isReadableConfig(raw)) throw new SetupRefusal(formatUnreadable(locale, command));
}

/** Keep configuration validation failures in the setup's plain language. */
function setupConfig(raw, locale, command) {
  try {
    return configOf(raw);
  } catch {
    throw new SetupRefusal(format('invalidConfigValue', locale, { command }));
  }
}

function validScopeName(scope, value) {
  return typeof value === 'string'
    && !CONFIG_SCHEMA.reservedPathSegments.includes(value)
    && CONFIG_SCHEMA.scopePatterns[scope].test(value);
}

function invalidRawProfiles(raw) {
  const profiles = raw?.profiles;
  if (!isRecord(profiles)) return false;
  const classes = new Set(Object.keys(PROFILE_EFFORTS));
  for (const [client, values] of Object.entries(profiles)) {
    if (!validScopeName('clients', client)) return true;
    if (!isRecord(values)) continue;
    for (const className of Object.keys(values)) {
      if (!validScopeName('classes', className) || !classes.has(className)) return true;
    }
  }
  return false;
}

function assertValidRawProfiles(raw, locale) {
  if (invalidRawProfiles(raw)) throw new SetupRefusal(format('invalidProfiles', locale));
}

function reasonParts(reason) {
  const text = String(reason ?? '');
  const parts = text.split(' / ');
  return { en: parts[0], 'pt-BR': parts.slice(1).join(' / ') };
}

function formatConfirmation(locale, changes) {
  const entries = (language) => changes.map((change) => {
    const reason = reasonParts(change.reason)[language];
    return `${change.client} (${change.class}): ${change.model}. ${reason}`;
  }).join('\n');
  if (locale === 'en') return fill(SETUP_MESSAGES.confirm.en, { choices: entries('en') });
  if (locale === 'pt-BR') return fill(SETUP_MESSAGES.confirm['pt-BR'], { choices: entries('pt-BR') });
  return `${fill(SETUP_MESSAGES.confirm.en, { choices: entries('en') })} / ${fill(SETUP_MESSAGES.confirm['pt-BR'], { choices: entries('pt-BR') })}`;
}

function formatWithReason(key, locale, values, reason) {
  const message = SETUP_MESSAGES[key];
  const parts = reasonParts(reason);
  if (locale === 'en') return fill(message.en, { ...values, reason: parts.en });
  if (locale === 'pt-BR') return fill(message['pt-BR'], { ...values, reason: parts['pt-BR'] });
  return `${fill(message.en, { ...values, reason: parts.en })} / ${fill(message['pt-BR'], { ...values, reason: parts['pt-BR'] })}`;
}

function maxAttemptsOf(config) {
  const value = config?.setup?.maxAttempts;
  return Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_CONFIG.setup.maxAttempts;
}

const EFFORT_ENTRY = CONFIG_SCHEMA.entries.find(
  (entry) => entry.path === 'profiles.<client>.<class>.effort',
);
const ALLOWED_EFFORTS = new Set(EFFORT_ENTRY?.allowedValues ?? []);

function validateProfile(config, client, className, model, effort) {
  const scope = resolveEntry(`profiles.${client}.${className}.model`, config);
  if (scope.error) return { error: scope.error };
  const profiles = configOf(config).profiles;
  if (!Object.hasOwn(profiles, client)) return { error: { type: 'unknown' } };
  const profile = profiles[client]?.[className];
  if (!profile || typeof profile !== 'object') return { error: { type: 'unknown' } };
  const cleanModel = String(model ?? '').trim();
  const cleanEffort = String(effort ?? '').trim();
  if (!cleanModel || !ALLOWED_EFFORTS.has(cleanEffort)) return { error: { type: 'value' } };
  return { value: { model: cleanModel, effort: cleanEffort } };
}

function refusalText(locale, client, className, error) {
  if (error?.type === 'scope' && error.message === 'unknownClass') {
    return format('unknownClass', locale, {
      client, class: className, classe: className, classes: error.values.join(', '),
    });
  }
  if (error?.type === 'scope' && error.message === 'unknownClient') {
    return format('unknownClient', locale, {
      client, class: className, classe: className, clients: error.values.join(', '),
    });
  }
  return format('invalidSetting', locale, { client, class: className, classe: className });
}

function profileValue(profiles, client, className) {
  const profile = profiles?.[client]?.[className];
  return profile === undefined ? undefined : structuredClone(profile);
}

function classLabel(change) {
  return `${change.client} (${change.class})`;
}

/**
 * The object a key holds, or `null` when the value there is not one: a
 * configuration with an unexpected shape is refused by the setup with its own
 * sentence, never with a technical error from JavaScript.
 *
 * @param {object} parent
 * @param {string} key
 * @returns {object|null}
 */
function ownObject(parent, key) {
  if (!Object.hasOwn(parent, key)) {
    Object.defineProperty(parent, key, {
      value: {}, writable: true, enumerable: true, configurable: true,
    });
  }
  const value = parent[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function applyChanges(raw, changes, locale, command) {
  const applied = [];
  const kept = [];
  const current = setupConfig(raw, locale, command).profiles;
  for (const change of changes) {
    const value = profileValue(current, change.client, change.class);
    if (!isDeepStrictEqual(value, change.previous)) {
      kept.push({ client: change.client, class: change.class });
      continue;
    }
    const { previous, ...proposal } = change;
    applied.push(proposal);
  }
  for (const change of applied) {
    const profiles = ownObject(raw, 'profiles');
    const client = profiles === null ? null : ownObject(profiles, change.client);
    if (client === null) {
      return { error: change };
    }
    const existing = Object.hasOwn(client, change.class) ? client[change.class] : {};
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      return { error: change };
    }
    client[change.class] = { ...existing, model: change.model, effort: change.effort };
  }
  return { error: null, applied, kept };
}

async function saveSetup(root, changes, write, locale, command) {
  const target = paths(root);
  // The folder that holds the configuration: the one the sentence names.
  const folder = dirname(target.config);
  try {
    await mkdir(target.locks, { recursive: true });
  } catch {
    throw new SetupSaveError(formatNotSaved(locale, folder, command));
  }
  try {
    return await withLock(join(target.locks, 'config'), async () => {
      // The file is read again under the lock: it may have changed since the
      // first read, and a file that cannot be read stops the write.
      let raw;
      try {
        raw = await readJson(target.config, {});
      } catch {
        throw new SetupRefusal(formatUnreadable(locale, command));
      }
      assertReadableConfig(raw, locale, command);
      assertValidRawProfiles(raw, locale);
      const outcome = applyChanges(raw, changes, locale, command);
      if (outcome.error) return outcome;
      // Nothing was configured: the file keeps its own state and the setup
      // stays pending, so the status still asks for it.
      if (outcome.applied.length === 0) {
        return { error: null, raw, applied: [], kept: outcome.kept, written: false };
      }
      const setup = raw.setup && typeof raw.setup === 'object' && !Array.isArray(raw.setup)
        ? raw.setup : {};
      raw.setup = { ...setup, done: { at: new Date().toISOString() } };
      try {
        await write(target.config, raw);
      } catch {
        throw new SetupSaveError(formatNotSaved(locale, folder, command));
      }
      return { error: null, raw, applied: outcome.applied, kept: outcome.kept, written: true };
    });
  } catch (error) {
    // A refusal of the setup keeps its own sentence; a write that failed
    // becomes the one simple sentence, without the technical text.
    if (error instanceof SetupSaveError || error instanceof SetupRefusal) throw error;
    throw new SetupSaveError(formatNotSaved(locale, folder, command));
  }
}

async function askValue(ask, question, recommended) {
  try {
    return await ask(question, recommended);
  } catch (error) {
    if (error?.code === 'ERR_USE_AFTER_CLOSE') return undefined;
    throw error;
  }
}

function affirmative(value) {
  return /^(y|yes|s|sim)$/i.test(value);
}

function negative(value) {
  return /^(n|no|nao|não)$/i.test(value);
}

async function askModel({ ask, locale, client, className, proposal, candidates, attempts }) {
  const recommended = candidates[0];
  const values = {
    client,
    class: className,
    classe: className,
    options: candidates.join(', '),
    recommended,
  };
  let question = formatWithReason('question', locale, values, proposal.reason);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const answer = await askValue(ask, question, recommended);
    if (answer === undefined || answer === null) return { cancelled: true };
    const clean = String(answer).trim();
    const selected = clean === '' ? recommended : clean;
    if (candidates.includes(selected)) return { value: selected };
    question = `${format('invalid', locale)} ${question}`;
  }
  return { invalid: true };
}

async function confirmSetup({ ask, locale, attempts, changes }) {
  let question = formatConfirmation(locale, changes);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const answer = await askValue(ask, question, undefined);
    if (answer === undefined || answer === null) return { cancelled: true };
    const clean = String(answer).trim();
    if (clean === '' || negative(clean)) return { cancelled: true };
    if (affirmative(clean)) return { confirmed: true };
    question = `${format('invalidConfirmation', locale)} ${question}`;
  }
  return { invalid: true };
}

function detectedByClient(detected) {
  return new Map((detected?.clients ?? []).map((client) => [client?.client, client]));
}

function clientCanBeConfigured(client) {
  return client !== null && client !== undefined && client.installed !== false;
}

/**
 * The clients that can be configured: their installation is not known to be
 * false, and an installed client offers a listing with at least one active
 * model. A catalog answer stands in for a listing that could not be read.
 *
 * @param {object} detected
 * @returns {object[]}
 */
function configurableClients(detected) {
  return (detected?.clients ?? []).filter((client) => {
    if (!clientCanBeConfigured(client)) return false;
    if (client.installed === true && client.source === 'listing') {
      return activeModels(client).length > 0;
    }
    return true;
  });
}

function activeModels(detected) {
  return detected?.models ?? [];
}

function storedModel(raw, client, className) {
  const profile = raw?.profiles?.[client]?.[className];
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
  return typeof profile.model === 'string' && profile.model.trim() !== ''
    ? profile.model.trim()
    : null;
}

function wasDone(raw) {
  const done = raw?.setup?.done;
  return done !== undefined && done !== null && done !== false;
}

export async function runSetup({
  root,
  config,
  env = process.env,
  run,
  ask,
  defaults = false,
  adapters,
  snapshot,
  write = writeJsonAtomic,
  locale = 'both',
  again = false,
  command = DEFAULT_CONFIG.install.command,
} = {}) {
  if (!root) throw new TypeError('root is required');
  if (!defaults && typeof ask !== 'function') {
    throw new Error(format('askUnavailable', locale));
  }
  // A file that cannot be read, or whose root is not a configuration, stops
  // the setup before anything is asked or written.
  let stored;
  try {
    stored = await readJson(paths(root).config, {});
  } catch {
    throw new SetupRefusal(formatUnreadable(locale, command));
  }
  assertReadableConfig(stored, locale, command);
  assertValidRawProfiles(stored, locale);
  setupConfig(stored, locale, command);
  if (config !== undefined && config !== null) assertReadableConfig(config, locale, command);
  assertValidRawProfiles(config, locale);
  const givenProfiles = config?.profiles;
  const profiles = givenProfiles && typeof givenProfiles === 'object' && !Array.isArray(givenProfiles)
    ? givenProfiles
    : stored.profiles;
  const storedSetup = stored.setup && typeof stored.setup === 'object' && !Array.isArray(stored.setup)
    ? stored.setup
    : {};
  const givenSetup = config?.setup && typeof config.setup === 'object' && !Array.isArray(config.setup)
    ? config.setup
    : {};
  const resolved = setupConfig({ ...stored, ...config, profiles, setup: { ...storedSetup, ...givenSetup } }, locale, command);
  const attempts = maxAttemptsOf(resolved);
  const observation = await environmentSnapshot({ config: resolved, env, run, adapters, snapshot,
    plugin: {}, versions: {} });
  const { detected, proposals } = observation;
  const clients = detectedByClient(detected);
  // Nothing was detected: no client offers a model to configure, so there is
  // nothing to write and no `setup.done` to leave behind. The setup says so
  // in one simple sentence, writes nothing, and the status keeps asking for
  // the configuration.
  if (configurableClients(detected).length === 0) {
    return {
      code: 0,
      cancelled: false,
      changes: [],
      skipped: [],
      omitted: [],
      messages: [format('noActiveModel', locale)],
    };
  }
  const changes = [];
  const skipped = [];
  const omitted = [];
  const messages = [];
  const done = wasDone(stored);

  for (const clientProposal of proposals.clients) {
    const detectedClient = clients.get(clientProposal.client);
    if (!clientCanBeConfigured(detectedClient)) continue;
    const active = new Set(activeModels(detectedClient));
    for (const [className, proposal] of Object.entries(clientProposal.profiles)) {
      if (proposal.source === 'omitted') continue;
      const current = storedModel(stored, clientProposal.client, className);
      if (done && !again && current !== null && active.has(current)) {
        skipped.push({ client: clientProposal.client, class: className, model: current });
        continue;
      }
      const valid = validateProfile(
        resolved,
        clientProposal.client,
        className,
        proposal.model,
        proposal.effort,
      );
      if (valid.error) {
        throw new Error(refusalText(locale, clientProposal.client, className, valid.error));
      }
      changes.push({
        client: clientProposal.client,
        class: className,
        ...valid.value,
        previous: profileValue(resolved.profiles, clientProposal.client, className),
        reason: proposal.reason,
      });
      messages.push(formatWithReason('plan', locale, {
        client: clientProposal.client,
        class: className,
        classe: className,
        model: valid.value.model,
      }, proposal.reason));
    }
  }

  for (const clientProposal of proposals.clients) {
    const detectedClient = clients.get(clientProposal.client);
    if (!clientCanBeConfigured(detectedClient)) continue;
    const candidates = activeModels(detectedClient);
    for (const [className, proposal] of Object.entries(clientProposal.profiles)) {
      if (proposal.source !== 'omitted') continue;
      if (defaults || candidates.length === 0) {
        omitted.push({ client: clientProposal.client, class: className });
        messages.push(format('omitted', locale, {
          client: clientProposal.client, class: className, classe: className,
        }));
        continue;
      }
      const answer = await askModel({
        ask, locale, client: clientProposal.client, className,
        proposal, candidates, attempts,
      });
      if (answer.cancelled) {
        return { code: 0, cancelled: true, changes: [], skipped, omitted, messages: [format('cancelled', locale)] };
      }
      if (answer.invalid) throw new Error(format('invalidAnswer', locale));
      const valid = validateProfile(
        resolved,
        clientProposal.client,
        className,
        answer.value,
        proposal.effort,
      );
      if (valid.error) {
        throw new Error(refusalText(locale, clientProposal.client, className, valid.error));
      }
      changes.push({
        client: clientProposal.client,
        class: className,
        ...valid.value,
        previous: profileValue(resolved.profiles, clientProposal.client, className),
        reason: proposal.reason,
      });
    }
  }

  if (done && !again && changes.length === 0) {
    messages.push(format('unchanged', locale));
    return { code: 0, cancelled: false, changes, skipped, omitted, messages };
  }

  if (!defaults) {
    const confirmation = await confirmSetup({ ask, locale, attempts, changes });
    if (confirmation.cancelled) {
      return { code: 0, cancelled: true, changes: [], skipped, omitted, messages: [format('cancelled', locale)] };
    }
    if (confirmation.invalid) throw new Error(format('invalidAnswer', locale));
  }

  const saved = await saveSetup(root, changes, write, locale, command);
  if (saved.error) {
    throw new Error(format('invalidSetting', locale, {
      client: saved.error.client, class: saved.error.class, classe: saved.error.class,
    }));
  }
  const savedChanges = saved.applied;
  const kept = saved.kept;
  const names = [...new Set(savedChanges.map((change) => change.client))];
  if (savedChanges.length > 0) {
    messages.push(format('summary', locale, { count: savedChanges.length, clients: names.join(', ') }));
  } else if (kept.length === 0) {
    messages.push(format('none', locale));
  }
  if (kept.length > 0) {
    messages.push(format('kept', locale, { classes: kept.map(classLabel).join(', ') }));
  }
  return { code: 0, cancelled: false, changes: savedChanges, kept, skipped, omitted, messages };
}
