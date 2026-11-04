// Pure account identities and configuration changes; no credential access.
import path from 'node:path';
import process from 'node:process';
import { UsageError } from './install/exit.js';

export const DEFAULT_ACCOUNT_ID = 'default';
const CLIENT_ENV = { 'claude-code': 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' };
const ID = /^[a-z0-9-]{1,32}$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const reason = (en, pt) => ({ en, 'pt-BR': pt });
// Raised in English; `localizeReason` (src/install/present.js, REASONS) shows it in the language of the run.
const refuse = (why) => { throw new UsageError(why.en); };
const supported = (client) => {
  if (!Object.hasOwn(CLIENT_ENV, client)) refuse(reason('Unsupported account client.', 'Cliente de conta não suportado.'));
};

/** The default keeps the historical client key. */
export function accountKey(client, id = DEFAULT_ACCOUNT_ID) {
  supported(client);
  if (typeof id !== 'string' || !ID.test(id)) refuse(reason('Invalid account id.', 'Id de conta inválido.'));
  return id === DEFAULT_ACCOUNT_ID ? client : `${client}:${id}`;
}

/** Stable filenames, independent of the editable label. */
export function accountFiles(client, id = DEFAULT_ACCOUNT_ID) {
  accountKey(client, id);
  const suffix = id === DEFAULT_ACCOUNT_ID ? '' : `.${id}`;
  return { reading: `${client}${suffix}.json`, statusline: `${client}-statusline${suffix}.json` };
}

/**
 * Whether the saved accounts have the shape of a configuration: an absent configuration or absent accounts mean
 * "none saved"; a root that is not an object, accounts that are not an object, or a client whose entries are not
 * a list of objects with a valid id is not a configuration at all. Structure only: values are for `accountsProblem`.
 */
export function accountsWellFormed(config) {
  if (config === undefined) return true;
  if (!object(config)) return false;
  if (config.accounts === undefined) return true;
  return object(config.accounts) && Object.values(config.accounts).every((entries) => Array.isArray(entries)
    && entries.every((entry) => object(entry) && typeof entry.id === 'string' && ID.test(entry.id)));
}

/** The implicit default is always first; saved extras retain their order. A malformed list counts as none saved. */
export function accountsOf(config, client) {
  supported(client);
  const saved = object(config?.accounts) ? config.accounts[client] : undefined;
  const entries = Array.isArray(saved)
    ? saved.filter((entry) => object(entry) && typeof entry.id === 'string' && ID.test(entry.id)) : [];
  const defaultEntry = entries.find(({ id }) => id === DEFAULT_ACCOUNT_ID);
  return [{ id: DEFAULT_ACCOUNT_ID, label: defaultEntry?.label ?? 'default' },
    ...entries.filter(({ id }) => id !== DEFAULT_ACCOUNT_ID)].map((entry) => ({
    client, id: entry.id, label: entry.label, configDir: entry.configDir ?? null,
    isDefault: entry.id === DEFAULT_ACCOUNT_ID, key: accountKey(client, entry.id),
  }));
}

/** Resolve an input id against saved accounts, never just its slug syntax. */
export function requireAccount(config, client, id = DEFAULT_ACCOUNT_ID) {
  accountKey(client, id);
  const account = accountsOf(config, client).find((entry) => entry.id === id);
  if (!account) refuse(reason('Unknown account.', 'Conta desconhecida.'));
  return account;
}

const pathOf = (platform) => platform === 'win32' ? path.win32 : path.posix;
function normalizedDir(value, platform) {
  const resolved = pathOf(platform).resolve(value).replace(/[\\/]+$/, '');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function duplicateDir(accounts, client, { platform = process.platform, env = process.env, defaultDir } = {}) {
  const dirs = new Set();
  for (const dir of [defaultDir ?? env[CLIENT_ENV[client]], ...accounts.map((entry) => entry.configDir)]) {
    if (!dir || !pathOf(platform).isAbsolute(dir)) continue;
    const key = normalizedDir(dir, platform);
    if (dirs.has(key)) return true;
    dirs.add(key);
  }
  return false;
}

/**
 * Only extras override the client's environment. The default preserves it, unless the configuration (`config`) has
 * saved accounts for the client: the default is then the folder the client uses with no override (`defaultFolderOf`),
 * so the variable, which may name an extra, is dropped. A call without `config` is the default as it always was.
 */
export function accountEnv(client, account, env, configEnv = CLIENT_ENV[client], config = undefined) {
  supported(client);
  if (account?.isDefault || account?.id === DEFAULT_ACCOUNT_ID) {
    if (!config || !Object.hasOwn(config.accounts ?? {}, client) || !env || !Object.hasOwn(env, configEnv)) return env;
    const { [configEnv]: _override, ...clean } = env;
    return clean;
  }
  return !account?.configDir ? env : { ...env, [configEnv]: account.configDir };
}

/** The environment of the default account of every client at once: what `accountEnv` gives the default of each. */
export function defaultEnv(env, config) {
  let clean = env;
  for (const client of Object.keys(CLIENT_ENV)) {
    if (config && Object.hasOwn(config.accounts ?? {}, client)) {
      clean = accountEnv(client, { id: DEFAULT_ACCOUNT_ID }, clean ?? process.env, undefined, config);
    }
  }
  return clean;
}

/**
 * The account a folder names, or null when the folder names no saved account.
 *
 * The folder of an extra account is the one saved with it. The folder of the default is the one the client
 * uses when no account overrides it: with no environment of its own, or with a client that never had accounts,
 * the folder is the default's. The default has no folder saved with it, so the caller tells which folder is its
 * own (`defaultDir`): a folder that names it is the default's. A folder that names no saved account (the folder
 * of an account that was removed, or one that was never saved) belongs to nobody: the caller must write nothing
 * for it, or the reading of one account would overwrite the reading of another.
 *
 * @param {{client: string, config: object, env?: object, platform?: string, defaultDir?: string}} input
 * @returns {object|null} the account of the folder, or null when the folder names none
 */
export function accountOfConfigDir({ client, config, env = {}, platform = process.platform, defaultDir }) {
  const accounts = accountsOf(config, client);
  const dir = env[CLIENT_ENV[client]];
  if (!dir) return accounts[0];
  // A configuration of the wrong shape says nothing about which account the folder is: it names none.
  if (!accountsWellFormed(config)) return null;
  const named = accounts.find((account) => account.configDir
    && normalizedDir(account.configDir, platform) === normalizedDir(dir, platform));
  if (named) return named;
  // The folder of the default account is never saved with it, so the caller says which one is its own.
  if (defaultDir && normalizedDir(defaultDir, platform) === normalizedDir(dir, platform)) return accounts[0];
  // The configuration knows the accounts of this client (even when every one of them was removed: the folder of
  // a removed account stays and its collector still runs), so the folder names no account and belongs to nobody.
  if (Object.hasOwn(config?.accounts ?? {}, client)) return null;
  return accounts[0];
}

/** Generate a bounded slug once, reserving default and resolving collisions. */
export function newAccountId(name, existingIds = []) {
  const base = String(name).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'account';
  const used = new Set([DEFAULT_ACCOUNT_ID, ...existingIds]);
  let id = base;
  for (let n = 2; used.has(id); n += 1) {
    const suffix = `-${n}`;
    id = `${base.slice(0, 32 - suffix.length)}${suffix}`;
  }
  return id;
}

/** Labels are display text; exact duplicates within the client are refused. */
export function validateLabel(label, { client, accounts = [], exceptId } = {}) {
  let why = null;
  if (typeof label !== 'string' || !label.trim() || label.length > 40 || /[\p{Cc}]/u.test(label)) {
    why = reason('Account label must be non-empty text of at most 40 characters without controls.',
      'O nome da conta deve ser um texto não vazio de até 40 caracteres sem controles.');
  } else if (accounts.some((account) => (!client || !account.client || account.client === client)
    && account.id !== exceptId && account.label === label)) {
    why = reason('Account labels must be unique within the client.', 'Os nomes das contas devem ser únicos no cliente.');
  }
  return { ok: why === null, reason: why };
}

/** First invalid saved accounts value, or null; consumed by the config schema. */
export function accountsProblem(value, options = {}) {
  const invalid = (key) => ({ key, ...reason('Use unique account ids, valid labels and absolute config directories; default has no directory.',
    'Use ids de conta únicos, nomes válidos e pastas de configuração absolutas; default não tem pasta.') });
  if (!object(value)) return invalid('accounts');
  for (const [client, entries] of Object.entries(value)) {
    if (!Object.hasOwn(CLIENT_ENV, client) || !Array.isArray(entries)) return invalid(`accounts.${client}`);
    const ids = new Set();
    for (const entry of entries) {
      if (!object(entry) || typeof entry.id !== 'string' || !ID.test(entry.id) || ids.has(entry.id)
        || !validateLabel(entry.label).ok) return invalid(`accounts.${client}`);
      ids.add(entry.id);
      if (entry.id === DEFAULT_ACCOUNT_ID ? entry.configDir !== undefined
        : typeof entry.configDir !== 'string' || !entry.configDir.trim()
          || /\p{Cc}/u.test(entry.configDir) || !(path.posix.isAbsolute(entry.configDir) || path.win32.isAbsolute(entry.configDir))) {
        return invalid(`accounts.${client}`);
      }
    }
    const accounts = accountsOf({ accounts: value }, client);
    // A collector may run with an extra's environment; only an explicit context identifies the default here.
    if (duplicateDir(accounts, client, { env: {}, ...options })) return invalid(`accounts.${client}`);
    if (accounts.some((entry) => !validateLabel(entry.label, { accounts, exceptId: entry.id }).ok)) return invalid(`accounts.${client}`);
  }
  return null;
}

function withEntries(config, client, entries) {
  const next = { ...config, accounts: { ...config?.accounts, [client]: entries } };
  const problem = accountsProblem(next.accounts);
  if (problem) refuse(problem);
  return next;
}

/** Add an extra using its initial label as the seed of its stable id. */
export function withAccountAdded(config, client, label, configDir, options = {}) {
  const accounts = accountsOf(config, client);
  if (typeof configDir !== 'string' || !pathOf(options.platform ?? process.platform).isAbsolute(configDir)) {
    refuse(reason('Account folder must be absolute on this system.', 'A pasta da conta deve ser absoluta neste sistema.'));
  }
  if (duplicateDir([...accounts, { configDir }], client, options)) {
    refuse(reason('Account folders must be unique within the client.', 'As pastas das contas devem ser únicas no cliente.'));
  }
  const check = validateLabel(label, { client, accounts });
  if (!check.ok) refuse(check.reason);
  const id = newAccountId(label, accounts.map((account) => account.id));
  return withEntries(config, client, [...(config?.accounts?.[client] ?? []), { id, label, configDir }]);
}

/** Removal only changes configuration; it never deletes account files. */
export function withAccountRemoved(config, client, id) {
  requireAccount(config, client, id);
  if (id === DEFAULT_ACCOUNT_ID) refuse(reason('The default account cannot be removed.', 'A conta default não pode ser removida.'));
  return withEntries(config, client, (config?.accounts?.[client] ?? []).filter((entry) => entry.id !== id));
}

/** Renaming the implicit default saves only its label, never a directory. */
export function withAccountRenamed(config, client, id, label, options = {}) {
  const accounts = accountsOf(config, client);
  requireAccount(config, client, id);
  if (duplicateDir(accounts, client, options)) {
    refuse(reason('Account folders must be unique within the client.', 'As pastas das contas devem ser únicas no cliente.'));
  }
  const check = validateLabel(label, { client, accounts, exceptId: id });
  if (!check.ok) refuse(check.reason);
  const saved = Object.hasOwn(config?.accounts ?? {}, client);
  if (id === DEFAULT_ACCOUNT_ID && !saved && options.currentDefaultDir !== undefined && options.defaultDir !== options.currentDefaultDir) {
    refuse(reason('The default account follows the folder variable of the client; register that folder as an account before giving the default a label.',
      'A conta default segue a variável de pasta do cliente; cadastre essa pasta como uma conta antes de dar um nome à default.'));
  }
  const entries = config?.accounts?.[client] ?? [];
  return withEntries(config, client, entries.some((entry) => entry.id === id)
    ? entries.map((entry) => entry.id === id ? { ...entry, label } : entry)
    : [...entries, { id, label }]);
}
