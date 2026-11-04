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

/** The implicit default is always first; saved extras retain their order. */
export function accountsOf(config, client) {
  supported(client);
  const entries = config?.accounts?.[client] ?? [];
  const defaultEntry = entries.find(({ id }) => id === DEFAULT_ACCOUNT_ID);
  return [{ id: DEFAULT_ACCOUNT_ID, label: defaultEntry?.label ?? 'default' },
    ...entries.filter(({ id }) => id !== DEFAULT_ACCOUNT_ID)].map((entry) => ({
    client, id: entry.id, label: entry.label, configDir: entry.configDir ?? null,
    isDefault: entry.id === DEFAULT_ACCOUNT_ID, key: accountKey(client, entry.id),
  }));
}

/** Only extras override the client's environment; the default preserves it. */
export function accountEnv(client, account, env, configEnv = CLIENT_ENV[client]) {
  supported(client);
  return account?.isDefault || account?.id === DEFAULT_ACCOUNT_ID || !account?.configDir
    ? env : { ...env, [configEnv]: account.configDir };
}

/** Compare lexical paths using the requested platform, without following links. */
export function accountOfConfigDir({ client, config, env = {}, platform = process.platform }) {
  const accounts = accountsOf(config, client);
  const normalize = (value) => {
    const resolved = (platform === 'win32' ? path.win32 : path.posix).resolve(value).replace(/[\\/]+$/, '');
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const dir = env[CLIENT_ENV[client]];
  return (dir && accounts.find((account) => account.configDir && normalize(account.configDir) === normalize(dir))) || accounts[0];
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
export function accountsProblem(value) {
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
export function withAccountAdded(config, client, label, configDir) {
  const accounts = accountsOf(config, client);
  const check = validateLabel(label, { client, accounts });
  if (!check.ok) refuse(check.reason);
  const id = newAccountId(label, accounts.map((account) => account.id));
  return withEntries(config, client, [...(config?.accounts?.[client] ?? []), { id, label, configDir }]);
}

/** Removal only changes configuration; it never deletes account files. */
export function withAccountRemoved(config, client, id) {
  const accounts = accountsOf(config, client);
  if (id === DEFAULT_ACCOUNT_ID) refuse(reason('The default account cannot be removed.', 'A conta default não pode ser removida.'));
  if (!accounts.some((account) => account.id === id)) refuse(reason('Unknown account.', 'Conta desconhecida.'));
  return withEntries(config, client, (config?.accounts?.[client] ?? []).filter((entry) => entry.id !== id));
}

/** Renaming the implicit default saves only its label, never a directory. */
export function withAccountRenamed(config, client, id, label) {
  const accounts = accountsOf(config, client);
  if (!accounts.some((account) => account.id === id)) refuse(reason('Unknown account.', 'Conta desconhecida.'));
  const check = validateLabel(label, { client, accounts, exceptId: id });
  if (!check.ok) refuse(check.reason);
  const entries = config?.accounts?.[client] ?? [];
  return withEntries(config, client, entries.some((entry) => entry.id === id)
    ? entries.map((entry) => entry.id === id ? { ...entry, label } : entry)
    : [...entries, { id, label }]);
}
