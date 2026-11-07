import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../profiles.js';
import { OperationalError, UsageError, exitCodeFor } from './exit.js';
import { saveRecord } from './place.js';
import { presenterOf } from './present.js';
import { commandText } from './command-token.js';

export const PANEL_NAME = 'okit-plugin-panel';
export const PANEL_CLIENT = DEFAULT_CONFIG.statuslineRegistration.client;
const panelOpeningText = (ui) => ui.locale === 'pt-BR'
  ? 'Somente leitura; abre automaticamente no Claude Code. Defina panel.autoOpen como false no config.json para desligar; /okit-panel alterna o painel.' // locale:pt-BR
  : 'Read-only; opens automatically in Claude Code. Set panel.autoOpen to false in config.json to disable; /okit-panel toggles the pane.';
const ownerOf = (record, deps) => deps.accountScope && !deps.accountScope.isDefault
  ? record?.accounts?.[deps.accountScope.id] : record;
export const panelOf = (record, deps) => ownerOf(record, deps)?.panel;
export const forgetPanel = (record, deps) => { const owner = ownerOf(record, deps); if (owner) delete owner.panel; };

/** Offer only after the main registration has succeeded in this account. */
export async function offerPanel(record, flags, deps) {
  if (record.client !== PANEL_CLIENT || flags['no-panel'] || panelOf(record, deps)
    || deps.dryRun || flags.check) return;
  const ui = presenterOf(deps);
  try {
    if (deps.tty && await ui.confirm(deps.read, {
      explain: [ui.text('panelExplain'), panelOpeningText(ui)], question: ui.text('panelAsk'),
    })) {
      await panelCommand('install', record, deps);
    } else {
      const command = commandText(ui, deps.config.command, ['install', '--panel',
        ...(deps.accountScope && !deps.accountScope.isDefault ? ['--account', deps.accountScope.id] : [])], { later: true });
      ui.row(ui.text('panel'), 'skipped', ui.text('panelHow', { command }));
    }
  } catch (error) {
    ui.warn(ui.text('panelRefreshFailed', { action: 'install', reason: error.message }));
  }
}

async function run(deps, args) {
  const command = { command: deps.config.clients[PANEL_CLIENT].executable, args: ['plugin', ...args] };
  presenterOf(deps).detail([command.command, ...command.args].join(' '));
  return deps.run({ ...command, env: deps.cliEnv ?? deps.env });
}

/** Only an installer-owned registration is ever removed or refreshed. */
export async function refreshPanel(record, deps, action) {
  if (record.client !== PANEL_CLIENT) return;
  const panel = panelOf(record, deps);
  if (!panel) return;
  try {
    await run(deps, [action, panel.identity, '--scope', 'user']);
  } catch (error) {
    const ui = presenterOf(deps);
    const reason = [error?.message, error?.stderr, error?.stdout].filter(Boolean).join(' ');
    if (action === 'update' && /not installed|not found|no plugin/i.test(reason)) forgetPanel(record, deps);
    ui.warn(ui.text('panelRefreshFailed', { action, reason }));
  } finally {
    if (action === 'uninstall') forgetPanel(record, deps);
  }
}

async function listedPanels(deps) {
  const ui = presenterOf(deps);
  let installed;
  try { installed = JSON.parse((await run(deps, ['list', '--json'])).stdout); }
  catch { throw new OperationalError(ui.text('panelInvalid')); }
  if (!Array.isArray(installed)) throw new OperationalError(ui.text('panelInvalid'));
  return installed;
}
const includesPanel = (installed, identity) => installed.some((item) => item?.id === identity || item?.name === identity);

export async function panelCommand(command, record, deps) {
  const ui = presenterOf(deps);
  const owner = ownerOf(record, deps);
  const held = panelOf(record, deps);
  if (command === 'install' && (!owner || (record.defaultRegistered === false && owner === record))) {
    throw new UsageError(ui.text('panelNeedsMain'));
  }
  if ((command === 'uninstall' && !held) || (command === 'install' && held)) {
    ui.row(ui.text('panel'), 'skipped', ui.text(held ? 'panelPresent' : 'panelAbsent'));
    return exitCodeFor('ok');
  }
  if (deps.dryRun) { ui.row(ui.text('panel'), 'plan'); return exitCodeFor('ok'); }
  if (command === 'uninstall') {
    const installed = await listedPanels(deps);
    if (includesPanel(installed, held.identity)) await run(deps, ['uninstall', held.identity, '--scope', 'user']);
    delete owner.panel;
  } else {
    const manifest = join(record.path, DEFAULT_CONFIG.release.adapters[PANEL_CLIENT], 'panel',
      DEFAULT_CONFIG.release.clientFiles[PANEL_CLIENT].plugin);
    if (!await deps.fs.stat(manifest).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; })) {
      throw new UsageError(ui.text('panelMissing'));
    }
    const identity = `${PANEL_NAME}@${deps.config.marketplace}`;
    const installed = await listedPanels(deps);
    if (includesPanel(installed, identity)) {
      ui.row(ui.text('panel'), 'skipped', ui.text('panelPresent'));
      return exitCodeFor('ok');
    }
    await run(deps, ['install', identity, '--scope', 'user']);
    owner.panel = { identity };
  }
  await saveRecord(deps.destination, record, deps);
  ui.row(ui.text('panel'), 'ok', ui.text(command === 'install' ? 'panelInstalled' : 'panelRemoved'));
  if (command === 'install') ui.detail(panelOpeningText(ui));
  return exitCodeFor('ok');
}
