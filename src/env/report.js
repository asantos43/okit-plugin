import { listActors } from '../actors.js';
import { capOf } from '../limits.js';
import { configOf, DEFAULT_CONFIG, setupPending } from '../profiles.js';
import { clientsOf, detectClient, LABELS, statusTable } from '../status.js';
import { detectClients } from '../setup/detect.js';
import { execFile } from 'node:child_process';
import * as filesystem from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { installConfig, installPaths } from '../install/config.js';
import { activationWarning } from '../install/link.js';
import { readRecords } from '../install/place.js';

const exec = promisify(execFile);

async function environmentVersions(deps, config) {
  const versions = {};
  const run = deps.run ?? (async ({ command, args, timeout, env }) => {
    const result = await exec(command, args, { timeout, env });
    return { ...result, code: 0 };
  });
  for (const [client, settings] of Object.entries(config.clients)) {
    if (deps.client && client !== deps.client) continue;
    try {
      const result = await run({ command: settings.executable,
        args: settings.versionArgs ?? config.kit.versionArgs,
        timeout: settings.timeoutMs ?? config.kit.timeoutMs, env: deps.env });
      const ok = (result.code ?? result.exitCode ?? 0) === 0;
      versions[client] = { installed: ok ? true : null, version: ok ? result.stdout?.trim() || null : null };
    } catch (error) {
      versions[client] = { installed: error.code === 'ENOENT' ? false : null, version: null };
    }
  }
  return versions;
}

export async function environmentReadings(deps) {
  if (deps.plugin !== undefined && deps.versions !== undefined) {
    return { plugin: deps.plugin, versions: deps.versions };
  }
  const config = installConfig(deps.config.install);
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? env.HOME ?? env.USERPROFILE ?? homedir();
  const location = { ...deps, env, platform, fs: deps.fs ?? filesystem, config, home,
    ...installPaths(config, { ...deps, env, platform, home }) };
  const records = Object.values(await readRecords(location.destination, location.fs, config));
  location.bin = records.find((record) => record.linkDirectory)?.linkDirectory ?? location.bin;
  const plugin = deps.plugin ?? { path: records.find((record) => record.path)?.path
    ?? resolve(fileURLToPath(new URL('../..', import.meta.url))),
  onPath: !(await activationWarning(location)) };
  return { plugin, versions: deps.versions ?? await environmentVersions({ ...deps, env }, config) };
}

const WORDS = {
  en: {
    unknownClient: 'Client not recognized. Choose a known client.', unknown: 'unknown', none: 'none confirmed',
    installed: 'installed', absent: 'not installed', inUse: 'in use', version: 'version',
    models: 'Active models', actors: 'Actors', sizes: 'sizes', critic: 'review',
    quota: 'Quota remaining', renews: 'renews in', minutes: 'minutes', slots: 'Free slots', of: 'of',
    plugin: 'Plugin folder', state: 'State folder', path: 'Command available in PATH', yes: 'yes', no: 'no',
    configured: 'Configured', missing: 'Missing', setup: 'model choices', run: 'Run',
    missingSetup: 'model choices have not been saved', missingPath: 'the command is not in PATH',
    missingModels: (client) => `no active model confirmed for ${client}`,
    missingSizes: (client, sizes) => `no model configured for sizes ${sizes.join(', ')} in ${client}`,
  },
  'pt-BR': {
    unknownClient: 'Cliente não reconhecido. Escolha um cliente conhecido.', unknown: 'desconhecida', none: 'nenhum confirmado',
    installed: 'instalado', absent: 'não instalado', inUse: 'em uso', version: 'versão',
    models: 'Modelos ativos', actors: 'Atores', sizes: 'tamanhos', critic: 'revisão',
    quota: 'Cota restante', renews: 'renova em', minutes: 'minutos', slots: 'Vagas livres', of: 'de',
    plugin: 'Pasta do plugin', state: 'Pasta de estado', path: 'Comando disponível no PATH', yes: 'sim', no: 'não',
    configured: 'Configurado', missing: 'Falta', setup: 'escolha de modelos', run: 'Rode',
    missingSetup: 'a escolha de modelos ainda não foi salva', missingPath: 'o comando não está no PATH',
    missingModels: (client) => `nenhum modelo ativo confirmado para ${client}`,
    missingSizes: (client, sizes) => `nenhum modelo configurado para os tamanhos ${sizes.join(', ')} em ${client}`,
  },
};

export async function environmentReport(deps = {}) {
  const config = configOf(deps.config);
  const known = Object.keys(DEFAULT_CONFIG.install.clients);
  if (deps.client !== undefined && !known.includes(deps.client)) {
    return { unknownClient: true };
  }
  const inUse = detectClient(deps.env);
  const clients = deps.client ? [deps.client] : [...new Set([...clientsOf(config), ...known])]
    .filter((client) => known.includes(client));
  clients.sort((a, b) => Number(b === inUse) - Number(a === inUse));
  const detected = await (deps.detectClients ?? detectClients)({ ...deps, config });
  const shared = { ...deps, config, clients, all: true, client: undefined,
    demands: [], orders: [], cache: deps.cache ?? new Map() };
  const table = await statusTable(deps.root, shared);
  const actors = await listActors({ ...shared, profiles: config.profiles });
  const command = deps.command ?? config.install.command ?? DEFAULT_CONFIG.install.command;
  const missing = [];
  const configured = [];
  if (setupPending(config)) missing.push({ item: 'setup', command: `${command} setup` });
  else configured.push('setup');
  if (deps.plugin?.onPath === true) configured.push('path');
  else if (deps.plugin?.onPath === false) missing.push({ item: 'path', command: `${command} install --client ${deps.client ?? inUse ?? clients[0]}` });
  const rows = clients.map((client) => {
    const reading = detected.clients.find((entry) => entry.client === client);
    const installed = deps.versions?.[client]?.installed ?? reading?.installed ?? null;
    const models = installed !== false && reading?.source === 'listing'
      ? [...new Set(reading.models.filter((model) => model.trim() && !reading.hidden?.includes(model)))] : [];
    const available = actors.actors.filter((actor) => actor.client === client && models.includes(actor.model));
    const { cap } = capOf(deps.limits?.limits ?? config.limits, client);
    if (!available.length) missing.push({ item: 'models', client, command: `${command} setup` });
    else configured.push({ item: 'models', client });
    const sizes = Object.keys(config.actors.sizeClasses).filter((size) => !available.some((actor) => actor.sizes.includes(size)));
    if (available.length && sizes.length) missing.push({ item: 'sizes', client, sizes, command: `${command} setup` });
    return { client, inUse: client === inUse, installed,
      version: deps.versions?.[client]?.version ?? null, models,
      actors: available.map(({ model, effort, sizes, critic }) => ({ model, effort, sizes, critic })),
      quota: table.rows.find((row) => row.client === client),
      slots: { total: cap, available: Math.max(0, cap - (deps.limits?.byClient?.[client] ?? 0)) } };
  });
  return { clients: rows, plugin: { ...deps.plugin, statePath: deps.root, configured, missing } };
}

export function formatEnvironmentReport(report, locale = 'en') {
  const words = WORDS[locale] ?? WORDS.en;
  const labels = LABELS[locale] ?? LABELS.en;
  if (report.unknownClient) return words.unknownClient;
  const lines = [];
  for (const row of report.clients) {
    lines.push(`${row.client}${row.inUse ? ` (${words.inUse})` : ''}: ${row.installed === null ? words.unknown : row.installed ? words.installed : words.absent}; ${words.version}: ${row.version ?? words.unknown}.`);
    lines.push(`${words.models}: ${row.models.join(', ') || words.none}.`);
    lines.push(`${words.actors}: ${row.actors.map((actor) => `${actor.model} (${actor.effort ?? words.unknown}; ${words.sizes}: ${actor.sizes.join(', ') || words.none}${actor.critic ? `; ${words.critic}` : ''})`).join('; ') || words.none}.`);
    const remaining = [row.quota?.fiveHour, row.quota?.week].filter(Number.isFinite);
    lines.push(`${words.quota}: ${remaining.length ? labels.pct(Math.min(...remaining)) : words.unknown}; ${words.renews}: ${Number.isFinite(row.quota?.resetsInMinutes) ? `${row.quota.resetsInMinutes} ${words.minutes}` : words.unknown}.`);
    lines.push(`${words.slots}: ${row.slots.available} ${words.of} ${row.slots.total}.`);
  }
  const plugin = report.plugin;
  lines.push(`${words.plugin}: ${plugin.path ?? words.unknown}.`, `${words.state}: ${plugin.statePath ?? words.unknown}.`);
  lines.push(`${words.path}: ${plugin.onPath === undefined ? words.unknown : plugin.onPath ? words.yes : words.no}.`);
  const itemText = (entry) => `${words[entry.item ?? entry]}${entry.client ? ` (${entry.client})` : ''}${entry.sizes ? `: ${entry.sizes.join(', ')}` : ''}`;
  lines.push(`${words.configured}: ${plugin.configured.map(itemText).join(', ') || words.none}.`);
  for (const entry of plugin.missing) {
    const text = entry.item === 'models' ? words.missingModels(entry.client)
      : entry.item === 'sizes' ? words.missingSizes(entry.client, entry.sizes)
        : entry.item === 'path' ? words.missingPath : words.missingSetup;
    lines.push(`${words.missing}: ${text}. ${words.run} ${entry.command}.`);
  }
  return lines.join('\n');
}
