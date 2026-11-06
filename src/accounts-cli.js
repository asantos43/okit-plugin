import path from 'node:path';
import { accountsOf, withAccountAdded, withAccountRemoved, withAccountRenamed } from './accounts.js';
import { loginState } from './accounts-login.js';
import { configOf } from './profiles.js';
import { paths } from './store.js';
import { readJson, withLock, writeJsonAtomic, settingsError } from './state.js';
import { defaultFolderOf, homeOf } from './install/config.js';
import { OperationalError, exitCodeFor } from './install/exit.js';
import { presentAccount, accountInstructions, accountChanged } from './cli-present.js';
import { isReadableConfig } from './setup/setup.js';

const CLIENTS = ['claude-code', 'codex'];

async function loadAccounts(target) {
  let raw;
  try { raw = await readJson(target.config, {}); }
  catch { throw new OperationalError('Settings could not be read. Inspect them: MCP config_get {}'); }
  if (!isReadableConfig(raw)) throw new OperationalError('Account configuration must be an object with readable profiles.');
  configOf(raw);
  return raw;
}

/** Account changes share setup's atomic writer and config lock. */
export async function accountCommand(ctx, action, args) {
  const json = action === 'list' && args.includes('--json');
  const words = json ? args.filter((word) => word !== '--json') : args;
  const [client, name, value, directory] = words;
  const valid = action === 'list' ? words.length <= 1
    : action === 'add' ? words.length === 4 && value === '--config-dir'
      : action === 'remove' ? words.length === 2
        : action === 'rename' && words.length === 3;
  if (!valid || args.filter((word) => word === '--json').length > 1) return ctx.unknown();
  if (client !== undefined) accountsOf({}, client);
  if (action !== 'list' && !client) return ctx.unknown();
  const target = paths(ctx.root);
  const load = () => loadAccounts(target);
  const describe = async (account, settings) => ({ client: account.client, id: account.id, label: account.label,
    configDir: account.configDir,
    login: await loginState({ ...ctx, client: account.client, account, install: settings.install, config: settings }) });
  if (action === 'list') {
    const raw = await load();
    const rows = await Promise.all((client ? [client] : CLIENTS).flatMap((id) => accountsOf(raw, id))
      .map((account) => describe(account, raw)));
    if (json) ctx.out(JSON.stringify(rows));
    else rows.forEach((row) => ctx.out(presentAccount(row, ctx.locale)));
    return exitCodeFor('ok');
  }
  return changeAccount(ctx, action, { client, name, value, directory }, async (next) => {
    if (action === 'add') {
      const account = accountsOf(next, client).at(-1);
      const row = await describe(account, next);
      ctx.out(presentAccount(row, ctx.locale));
      accountInstructions(row, ctx).forEach(ctx.out);
    } else ctx.out(accountChanged(action, ctx.locale));
    return exitCodeFor('ok');
  });
}

/** Shared locked account mutation; the caller may present the saved configuration under the same lock. */
export async function changeAccount(ctx, action, { client, name, value, directory }, saved = (next) => next) {
  const target = paths(ctx.root);
  try {
    await ctx.fs.mkdir(target.locks, { recursive: true });
    return await withLock(path.join(target.locks, 'config'), async () => {
      const raw = await loadAccounts(target);
      const selected = accountsOf(raw, client).find((account) => account.id === name)
        ?? accountsOf(raw, client).find((account) => account.label === name);
      const folderOptions = { env: ctx.env, platform: ctx.platform, home: ctx.home ?? homeOf(ctx.env, ctx.platform) ?? '' };
      // The default's folder as it will be once this change is saved: saving the first account of a client stops the
      // default from following the client's folder variable, so a new folder is checked against that one.
      const currentDefaultDir = defaultFolderOf(client, { config: raw, ...folderOptions });
      const defaultDir = defaultFolderOf(client, { ...folderOptions,
        config: { ...raw, accounts: { ...raw.accounts, [client]: raw.accounts?.[client] ?? [] } } });
      const next = action === 'add' ? withAccountAdded(raw, client, name, directory, { env: ctx.env, defaultDir })
        : action === 'remove' ? withAccountRemoved(raw, client, name)
          : withAccountRenamed(raw, client, selected?.id ?? name, value, { env: ctx.env, defaultDir, currentDefaultDir });
      if (action === 'add') {
        try { await ctx.fs.mkdir(directory, { recursive: true, mode: 0o700 }); } catch (error) {
          // The folder is what failed, not the settings: say so, with the system code and no path.
          const failure = /^E[A-Z0-9]+$/.test(error?.code ?? '') ? `Cannot create the account folder (${error.code}).` : 'Cannot create the account folder.';
          throw new OperationalError(failure);
        }
      }
      await (ctx.writeConfig ?? ctx.write ?? writeJsonAtomic)(target.config, next);
      return await saved(next);
    });
  } catch (error) { throw settingsError(error); }
}
