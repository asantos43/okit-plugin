import { ACCOUNT_CLIENTS, DEFAULT_ACCOUNT_ID, accountEnv, accountKey, accountsOf, requireAccount } from '../accounts.js';
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
export function requestedAccount(flags, user, client, record = null, command = 'install') {
  if (flags.account === undefined) return null;
  if (!hasAccounts(client)) throw new UsageError('Accounts are not supported for this client.');
  let account;
  try { account = requireAccount(user, client, flags.account); } catch (error) {
    // What is registered is known by the record alone: an account that is no longer saved can still be taken out, in the
    // folder the registration was made in. Installing it again needs it saved (the configuration gives the folder).
    const folder = command === 'uninstall' ? record?.accounts?.[flags.account]?.configDir : null;
    if (!folder) throw error;
    return { client, id: flags.account, label: flags.account, configDir: folder, isDefault: false, key: accountKey(client, flags.account) };
  }
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
  // The environment of the run itself, never the one a previous account left in `deps.env` (see `depsFor`).
  const base = deps.baseEnv ?? deps.env;
  const env = accountEnv(account.client, account, base, deps.config.clients[account.client].configEnv, user);
  const root = !account.isDefault ? account.configDir
    : env === base ? deps.injectedRoot ?? clientRoot(account.client, { ...deps, env: base }) : clientRoot(account.client, { ...deps, env });
  return { id: account.id, label: account.label, isDefault: account.isDefault, client: account.client, root, env };
}

/**
 * The dependencies of one account: its folder and ITS environment (every command that is run for the account, the
 * client's own program and the checks of what was registered, sees the folder variable of that account and of no other).
 * `baseEnv` keeps the environment of the run, the one the accounts are derived from.
 */
export function depsFor(deps, target) {
  const base = deps.baseEnv ?? deps.env;
  return { ...deps, baseEnv: base, env: target.env, clientRoot: target.root, accountScope: target,
    cliEnv: target.env === base ? undefined : target.env };
}

/** The header of the run, and the note of a run that named no account while extras are saved (the default was used). */
export function header(ui, deps, values) {
  ui.header(values);
  if (deps.accountNote) ui.explain([deps.accountNote]);
}

/**
 * The ids of the accounts that hold a registration, the default first. Only the record knows them: an account that was
 * removed from the configuration is still registered until someone takes it out, and it still keeps the payload.
 */
export function registeredIds(record) {
  if (!record || !hasAccounts(record.client)) return [];
  return [...(record.defaultRegistered === false ? [] : [DEFAULT_ACCOUNT_ID]), ...Object.keys(record.accounts ?? {})];
}

/**
 * The targets whose registration the record holds, the default first. The folder of an extra is the one the registration
 * was made in (`record.accounts[id].configDir`), whatever the configuration says now; the configuration only gives the
 * label. A registration with no folder anywhere (neither recorded nor saved) cannot be acted on and is left as it is.
 */
export function registeredTargets(record, user, deps) {
  if (!record || !hasAccounts(record.client)) return [];
  const saved = new Map(accountsOf(user, record.client).map((account) => [account.id, account]));
  return registeredIds(record).flatMap((id) => {
    const account = saved.get(id);
    if (id === DEFAULT_ACCOUNT_ID) return [targetOf(deps, user, account)];
    const configDir = record.accounts[id]?.configDir ?? account?.configDir;
    if (!configDir) return [];
    return [targetOf(deps, user, { client: record.client, id, label: account?.label ?? id, configDir, isDefault: false, key: accountKey(record.client, id) })];
  });
}

/** Whether the record or the run involves accounts at all: otherwise the single-account path runs as it always did. */
export const involvesAccounts = (record, user, client, requested) => hasAccounts(client)
  && (accountsSaved(user, client) || Boolean(requested && !requested.isDefault)
    || Object.keys(record?.accounts ?? {}).length > 0 || record?.defaultRegistered === false);

/** The record with this account's registration noted. */
export function markRegistered(record, target) {
  if (target.isDefault) delete record.defaultRegistered;
  else record.accounts = { ...record.accounts, [target.id]: { ...record.accounts?.[target.id], configDir: target.root } };
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
