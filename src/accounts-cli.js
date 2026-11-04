import path from 'node:path';
import { accountsOf, withAccountAdded, withAccountRemoved, withAccountRenamed } from './accounts.js';
import { loginState } from './accounts-login.js';
import { configOf } from './profiles.js';
import { paths } from './store.js';
import { readJson, withLock, writeJsonAtomic, settingsError } from './state.js';
import { clientRoot, installConfig, homeOf } from './install/config.js';
import { OperationalError, exitCodeFor } from './install/exit.js';
import { presentAccount, accountInstructions, accountChanged } from './cli-present.js';
import { isReadableConfig } from './setup/setup.js';

const CLIENTS = ['claude-code', 'codex'];

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
  const load = async () => {
    let raw;
    try { raw = await readJson(target.config, {}); }
    catch { throw new OperationalError('Settings could not be read. Inspect them: MCP config_get {}'); }
    if (!isReadableConfig(raw)) throw new OperationalError('Account configuration must be an object with readable profiles.');
    configOf(raw);
    return raw;
  };
  const describe = async (account) => ({ client: account.client, id: account.id, label: account.label,
    configDir: account.configDir, login: await loginState({ ...ctx, client: account.client, account }) });
  if (action === 'list') {
    const raw = await load();
    const rows = await Promise.all((client ? [client] : CLIENTS).flatMap((id) => accountsOf(raw, id)).map(describe));
    if (json) ctx.out(JSON.stringify(rows));
    else rows.forEach((row) => ctx.out(presentAccount(row)));
    return exitCodeFor('ok');
  }
  try {
    await ctx.fs.mkdir(target.locks, { recursive: true });
    return await withLock(path.join(target.locks, 'config'), async () => {
      const raw = await load();
      const selected = accountsOf(raw, client).find((account) => account.id === name)
        ?? accountsOf(raw, client).find((account) => account.label === name);
      const defaultDir = clientRoot(client, { config: installConfig(raw.install), env: ctx.env,
        home: ctx.home ?? homeOf(ctx.env, ctx.platform) ?? '' });
      const next = action === 'add' ? withAccountAdded(raw, client, name, directory, { env: ctx.env, defaultDir })
        : action === 'remove' ? withAccountRemoved(raw, client, name)
          : withAccountRenamed(raw, client, selected?.id ?? name, value, { env: ctx.env, defaultDir });
      if (action === 'add') await ctx.fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await (ctx.writeConfig ?? ctx.write ?? writeJsonAtomic)(target.config, next);
      if (action === 'add') {
        const account = accountsOf(next, client).at(-1);
        const row = await describe(account);
        ctx.out(presentAccount(row));
        accountInstructions(row, ctx).forEach(ctx.out);
      } else ctx.out(accountChanged(action, ctx.locale));
      return exitCodeFor('ok');
    });
  } catch (error) { throw settingsError(error); }
}
