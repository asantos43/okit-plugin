import * as filesystem from 'node:fs/promises';
import { join } from 'node:path';
import { accountFiles, accountsOf } from '../accounts.js';
import { configOf } from '../profiles.js';
import { defaultFolderOf, homeOf, installPaths } from '../install/config.js';
import { planStatusline, applyStatusline, collectorCommandIndex } from '../install/statusline.js';
import { readRecord } from '../install/place.js';

const labels = {
  en: { registered: 'Registered', received: 'Reading received', waiting: 'Waiting for first reading', missing: 'Not registered', unnecessary: 'No status-bar collector needed', failed: 'Could not register the collector. Check account settings permissions and JSON.' },
  'pt-BR': { registered: 'Registrado', received: 'Leitura recebida', waiting: 'Aguardando primeira leitura', missing: 'Não registrado', unnecessary: 'Não precisa de coletor na barra de status', failed: 'Não foi possível registrar o coletor. Verifique permissões e JSON das configurações da conta.' }, // locale:pt-BR
};
const metadata = (root, account) => join(root, 'quota', `collector-${account.client}.${account.id}.json`);

/** Hand off an auto-registration's restoration data when its account installs the plugin later. */
export async function savedCollector(ctx, account) {
  if (!account || account.isDefault) return null;
  return (ctx.fs ?? filesystem).readFile(metadata(ctx.root, account), 'utf8')
    .then(JSON.parse).then(record => record.accounts?.[account.id]?.statusline ?? null)
    .catch(() => null);
}

export async function clearSavedCollector(ctx, account) {
  await (ctx.fs ?? filesystem).rm(metadata(ctx.root, account), { force: true });
}

/** Reuse the installer's account scope, backup and previous-command handling. Add must survive failure. */
export async function ensureCollector(ctx, raw, account) {
  if (account.client !== 'claude-code' || account.isDefault) return collectorState(ctx, raw, account);
  const fs = ctx.fs ?? filesystem, config = configOf(raw);
  const file = metadata(ctx.root, account);
  try {
    const locations = installPaths(config.install, { env: ctx.env, platform: ctx.platform, home: homeOf(ctx.env, ctx.platform) });
    const record = await fs.readFile(file, 'utf8').then(JSON.parse).catch(async error => {
      if (error.code !== 'ENOENT') throw error;
      const installed = await readRecord(locations.destination, account.client, fs, config.install);
      const held = installed?.accounts?.[account.id]?.statusline;
      return { client: account.client, ...(held ? { accounts: { [account.id]: { statusline: held } } } : {}) };
    });
    const deps = { ...ctx, fs, config: config.install, statuslineConfig: config.statuslineRegistration,
      ...locations,
      accountScope: { ...account, root: account.configDir },
      saveStatuslineRecord: async (_destination, next) => {
        await fs.mkdir(join(ctx.root, 'quota'), { recursive: true });
        await fs.writeFile(file, JSON.stringify(next), { mode: 0o600 });
      } };
    const plan = await planStatusline(record, deps);
    if (plan) await applyStatusline(record, plan, deps);
  } catch { /* State below reports a plain reason, never client-file contents. */ }
  return collectorState(ctx, raw, account);
}

export async function ensureSavedCollectors(ctx, raw, client = 'claude-code') {
  if (!['claude-code', 'codex'].includes(client)) return [];
  return Promise.all(accountsOf(raw, client).filter(account => !account.isDefault)
    .map(account => ensureCollector(ctx, raw, account)));
}

/** Inspect only settings and passive-file presence; active readings do not prove collection. */
export async function collectorState(ctx, raw, account) {
  const fs = ctx.fs ?? filesystem, config = configOf(raw);
  const text = labels[ctx.locale ?? config.language] ?? labels.en;
  if (account.client !== 'claude-code') return { state: 'not-needed', text: text.unnecessary };
  const folder = account.configDir ?? defaultFolderOf(account.client, { config, env: ctx.env, platform: ctx.platform });
  try {
    const settings = JSON.parse(await fs.readFile(join(folder, config.statuslineRegistration.settingsFile), 'utf8'));
    if (settings.statusLine?.type === 'command' && collectorCommandIndex(settings.statusLine.command, config.statuslineRegistration, config.install) > 0) {
      const received = await fs.stat(join(ctx.root, 'quota', accountFiles(account.client, account.id).statusline)).then(stat => stat.isFile(), () => false);
      return { state: 'registered', text: text.registered, reading: received ? 'reading received' : 'waiting for first reading',
        detail: received ? text.received : text.waiting };
    }
  } catch { /* Missing or unreadable settings are not a working registration. */ }
  return { state: 'not registered', text: text.missing, reason: text.failed };
}
