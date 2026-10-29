import { LABELS, quotaOrigin } from './quota.js';
import { environmentSnapshot } from './snapshot.js';
export { environmentReadings } from './snapshot.js';
export const environmentReport = environmentSnapshot;

const WORDS = {
  en: {
    unknownClient: 'Client not recognized. Choose a known client.', unknown: 'unknown', none: 'none confirmed',
    installed: 'installed', absent: 'not installed (optional)', inUse: 'in use', version: 'version',
    collector: 'Status bar collector (statusline-collector)', active: 'active', inactive: 'inactive',
    noReading: 'no reading received yet',
    models: 'Active models', actors: 'Actors', sizes: 'sizes', critic: 'review',
    quota: 'Quota remaining', renews: 'renews in', minutes: 'minutes', slots: 'Free slots', of: 'of',
    plugin: 'Plugin folder', state: 'State folder', path: 'Command available in PATH', yes: 'yes', no: 'no',
    configured: 'Configured', missing: 'Missing', setup: 'model choices', run: 'Run',
    missingSetup: 'model choices have not been saved', missingPath: 'the command is not in PATH',
    missingModels: (client) => `no active model confirmed for ${client}`,
    missingQuota: (client) => `no remaining allowance recorded for ${client}`,
    missingSizes: (client, sizes) => `no model configured for sizes ${sizes.join(', ')} in ${client}`,
  },
  'pt-BR': {
    unknownClient: 'Cliente não reconhecido. Escolha um cliente conhecido.', unknown: 'desconhecida', none: 'nenhum confirmado',
    installed: 'instalado', absent: 'não instalado (opcional)', inUse: 'em uso', version: 'versão',
    collector: 'Coletor da barra de status (statusline-collector)', active: 'ativo', inactive: 'inativo',
    noReading: 'nenhuma leitura recebida ainda',
    models: 'Modelos ativos', actors: 'Atores', sizes: 'tamanhos', critic: 'revisão',
    quota: 'Cota restante', renews: 'renova em', minutes: 'minutos', slots: 'Vagas livres', of: 'de',
    plugin: 'Pasta do plugin', state: 'Pasta de estado', path: 'Comando disponível no PATH', yes: 'sim', no: 'não',
    configured: 'Configurado', missing: 'Falta', setup: 'escolha de modelos', run: 'Rode',
    missingSetup: 'a escolha de modelos ainda não foi salva', missingPath: 'o comando não está no PATH',
    missingModels: (client) => `nenhum modelo ativo confirmado para ${client}`,
    missingQuota: (client) => `nenhuma cota restante registrada para ${client}`,
    missingSizes: (client, sizes) => `nenhum modelo configurado para os tamanhos ${sizes.join(', ')} em ${client}`,
  },
};

export function formatEnvironmentReport(report, locale = 'en') {
  const words = WORDS[locale] ?? WORDS.en;
  const labels = LABELS[locale] ?? LABELS.en;
  if (report.unknownClient) return words.unknownClient;
  const lines = [];
  for (const row of report.clients) {
    lines.push(`${row.client}${row.inUse ? ` (${words.inUse})` : ''}: ${row.installed === null ? words.unknown : row.installed ? words.installed : words.absent}; ${words.version}: ${row.version ?? words.unknown}.`);
    if (row.installed === false) continue;
    lines.push(`${words.models}: ${row.models.join(', ') || words.none}.`);
    lines.push(`${words.actors}: ${row.actors.map((actor) => `${actor.model} (${actor.effort ?? words.unknown}; ${words.sizes}: ${actor.sizes.join(', ') || words.none}${actor.critic ? `; ${words.critic}` : ''})`).join('; ') || words.none}.`);
    const remaining = [row.quota?.fiveHour, row.quota?.week].filter(Number.isFinite);
    lines.push(`${words.quota}: ${remaining.length ? labels.pct(Math.min(...remaining)) : words.unknown}; ${words.renews}: ${Number.isFinite(row.quota?.resetsInMinutes) ? `${row.quota.resetsInMinutes} ${words.minutes}` : words.unknown}; ${locale === 'pt-BR' ? 'origem' : 'origin'}: ${quotaOrigin(row.reading, report.now, labels)}.`);
    lines.push(`${words.slots}: ${row.slots.available} ${words.of} ${row.slots.total}.`);
  }
  const plugin = report.plugin;
  if (plugin.statusline) {
    const { active, command, received } = plugin.statusline;
    const state = active === null ? words.unknown : active ? words.active : words.inactive;
    lines.push(`${words.collector}: ${state}${active === true && received === false ? `; ${words.noReading}` : ''}.${active === true ? '' : ` ${words.run} ${command}.`}`);
  }
  lines.push(`${words.plugin}: ${plugin.path ?? words.unknown}.`, `${words.state}: ${plugin.statePath ?? words.unknown}.`);
  lines.push(`${words.path}: ${plugin.onPath === undefined ? words.unknown : plugin.onPath ? words.yes : words.no}.`);
  const itemText = (entry) => `${words[entry.item ?? entry]}${entry.client ? ` (${entry.client})` : ''}${entry.sizes ? `: ${entry.sizes.join(', ')}` : ''}`;
  lines.push(`${words.configured}: ${plugin.configured.map(itemText).join(', ') || words.none}.`);
  for (const entry of plugin.missing) {
    const text = entry.item === 'models' ? words.missingModels(entry.client)
      : entry.item === 'quota' ? words.missingQuota(entry.client)
      : entry.item === 'sizes' ? words.missingSizes(entry.client, entry.sizes)
        : entry.item === 'path' ? words.missingPath : words.missingSetup;
    lines.push(`${words.missing}: ${text}. ${words.run} ${entry.command}.`);
  }
  return lines.join('\n');
}
