import { ACCOUNT_CLIENTS, DEFAULT_ACCOUNT_ID, accountEnv, accountsOf, requireAccount } from '../accounts.js';
import { clientRoot } from './config.js';
import { UsageError } from './exit.js';

// Accounts in the installer (D116). The payload is shared: one record, one folder. Only the registration (the plugin
// entry, the MCP entry, the hooks and the status bar in the settings of the client) belongs to an account, and each
// registration is made in that account's folder with the environment of that account and nothing of the others.
//
// The record keeps the DEFAULT account's registration in its existing fields; the extra accounts are in the optional
// `record.accounts` (by id); a default registration that was removed while extras remain is `defaultRegistered: false`.

/** Whether the client has accounts at all (OpenCode has none). */
export const hasAccounts = (client) => ACCOUNT_CLIENTS.includes(client);

/** Whether the person saved accounts for the client (the default is then the folder with no override). */
export const accountsSaved = (user, client) => hasAccounts(client) && Object.hasOwn(user?.accounts ?? {}, client);

/**
 * The account a command names with `--account`, checked against the saved accounts; null when the flag is absent.
 * Refused: a client without accounts, a malformed id, an id that is not saved.
 *
 * @param {{account?: string, client?: string}} flags the flags of the run
 * @param {object} user the configuration of the person (`accounts`)
 * @param {string} client the client of the run
 * @returns {object|null} the account (`accountsOf` shape)
 */
export function requestedAccount(flags, user, client) {
  if (flags.account === undefined) return null;
  if (!hasAccounts(client)) throw new UsageError('Accounts are not supported for this client.');
  const account = requireAccount(user, client, flags.account);
  if (!account.isDefault && !account.configDir) throw new UsageError('Unknown account.');
  return account;
}

/**
 * The folder and the environment of one account. The default keeps the environment of the run unless accounts are
 * saved (the variable may then name an extra); an extra overrides only the folder variable of the client.
 *
 * @param {object} deps the dependencies of the installer (`config`, `env`, `home`, `injectedRoot`)
 * @param {object} user the configuration of the person
 * @param {object} account an account of `accountsOf`
 * @returns {{id: string, label: string, isDefault: boolean, client: string, root: string, env: object}}
 */
export function targetOf(deps, user, account) {
  const env = accountEnv(account.client, account, deps.env, deps.config.clients[account.client].configEnv, user);
  const root = !account.isDefault ? account.configDir
    : env === deps.env ? deps.injectedRoot ?? clientRoot(account.client, deps) : clientRoot(account.client, { ...deps, env });
  return { id: account.id, label: account.label, isDefault: account.isDefault, client: account.client, root, env };
}

/** The dependencies of one account: its folder, and its environment for the client's own program. */
export const depsFor = (deps, target) => ({ ...deps, clientRoot: target.root, accountScope: target,
  cliEnv: target.env === deps.env ? undefined : target.env });

/** The header of the run, and the note of a run that named no account while extras are saved (the default was used). */
export function header(ui, deps, values) {
  ui.header(values);
  if (deps.accountNote) ui.explain([deps.accountNote]);
}

/** The record without the registrations of accounts that are no longer saved: their folder is unknown, nothing is touched. */
export function pruneAccounts(record, targets) {
  if (!record.accounts) return record;
  const kept = Object.fromEntries(Object.entries(record.accounts).filter(([id]) => targets.some((target) => target.id === id)));
  if (Object.keys(kept).length) record.accounts = kept; else delete record.accounts;
  return record;
}

/** The targets whose registration the record holds, the default first. An account that is no longer saved has no folder to act on. */
export function registeredTargets(record, user, deps) {
  if (!record || !hasAccounts(record.client)) return [];
  return accountsOf(user, record.client)
    .filter((account) => (account.isDefault ? record.defaultRegistered !== false
      : Object.hasOwn(record.accounts ?? {}, account.id) && Boolean(account.configDir)))
    .map((account) => targetOf(deps, user, account));
}

/** Whether the record or the run involves accounts at all: otherwise the single-account path runs as it always did. */
export const involvesAccounts = (record, user, client, requested) => hasAccounts(client)
  && (accountsSaved(user, client) || Boolean(requested && !requested.isDefault)
    || Object.keys(record?.accounts ?? {}).length > 0 || record?.defaultRegistered === false);

/** The record with this account's registration noted. */
export function markRegistered(record, target) {
  if (target.isDefault) delete record.defaultRegistered;
  else record.accounts = { ...record.accounts, [target.id]: record.accounts?.[target.id] ?? {} };
  return record;
}

/** The record with this account's registration taken out (the default is noted as not registered). */
export function markUnregistered(record, target) {
  if (target.isDefault) record.defaultRegistered = false;
  else {
    const { [target.id]: _gone, ...rest } = record.accounts ?? {};
    if (Object.keys(rest).length) record.accounts = rest; else delete record.accounts;
  }
  return record;
}

/** The record as one account sees it: its own status bar in the `statusline` field. */
export const viewOf = (record, target) => (target.isDefault ? record : { ...record, statusline: record.accounts?.[target.id]?.statusline });

/** The ids of the accounts saved for the client, in one line: the note of a run that names no account. */
export const accountIds = (user, client) => accountsOf(user, client).map(({ id }) => id).join(', ');

/** Whether the client has extra accounts saved (the note of a run without `--account`). */
export const hasExtras = (user, client) => hasAccounts(client) && accountsOf(user, client).length > 1;

export { DEFAULT_ACCOUNT_ID };
