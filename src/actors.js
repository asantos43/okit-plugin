// Read-only presentation of environment actors and launch restrictions.
import { configOf } from './profiles.js';
import { ageOf, labelsOf, quotaOrigin } from './env/quota.js';
import { environmentSnapshot } from './env/snapshot.js';

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => values[key]);
const cell = (value) => String(value).replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');

export function formatActors(result, { json = false } = {}) {
  if (json) return JSON.stringify(result);
  const line = (values) => `| ${values.map(cell).join(' | ')} |`;
  return [line(result.columns), line(result.columns.map(() => '---')),
    ...result.actors.map((actor) => line(actor.cells)), ...result.notes].join('\n');
}

export async function listActors(deps = {}) {
  const config = configOf(deps.snapshot?.config ?? deps.config);
  if (deps.profiles !== undefined) config.profiles = deps.profiles;
  const settings = config.actors;
  const messages = settings.messages[deps.locale] ?? settings.messages.en;
  const snapshot = await environmentSnapshot({ ...deps, config, view: 'selected', orders: [] });
  const actors = [];
  const notes = [];
  if (!deps.client && !deps.all && !snapshot.inUse) notes.push(labelsOf(deps.locale).unknownClient);
  for (const observation of snapshot.clients) {
    if (observation.installed === false) {
      notes.push(`${observation.client}: ${labelsOf(deps.locale).optional}.`);
      continue;
    }
    const { cells: _cells, order: _order, ...quota } = observation.quota;
    const { remainingPct, readAt, status } = quota;
    const origin = quotaOrigin(observation.reading, snapshot.now, labelsOf(deps.locale));
    const quotaText = fill(messages.quota, {
      state: messages[`quota${status[0].toUpperCase()}${status.slice(1)}`],
      percentage: remainingPct !== null ? fill(messages.percentage, { value: Math.round(remainingPct) }) : messages.missing,
      age: readAt === null ? messages.missing : ageOf(readAt, snapshot.now, {
        age: (seconds) => fill(messages.age, { seconds }),
      }),
    }) + (['automatic', 'manual'].includes(quota.source) ? `; ${origin}` : '');
    const client = quota.client;
    const freeSlots = observation.slots.available;
    const pairs = new Map(observation.candidates.map((candidate) => {
      const reasons = candidate.restrictions.map((reason) => messages[reason] ?? ({
        unconfirmed: deps.locale === 'pt-BR' ? 'Modelo não confirmado. Rode setup.' : 'Model unconfirmed. Run setup.',
        'unknown-quota': labelsOf(deps.locale).noQuota(client),
        'expired-quota': deps.locale === 'pt-BR' ? 'Cota expirada.' : 'Quota expired.',
      })[reason]);
      return [JSON.stringify([candidate.model, candidate.effort]),
        { ...candidate, freeSlots, quota, origin, reasons }];
    }));
    if (!pairs.size) {
      notes.push(fill(messages.empty, { client }));
      continue;
    }
    for (const actor of pairs.values()) {
      actor.cells = [client, actor.model, actor.effort ?? messages.missing,
        [...actor.sizes, ...(actor.critic ? [messages.critic] : [])].join(', ') || messages.missing, freeSlots,
        quotaText, actor.canLaunch ? messages.yes : messages.no, actor.reasons.join(' ') || messages.missing];
      actors.push(actor);
    }
    for (const { size, alternative } of observation.sizeCoverage.gaps) {
      notes.push(fill(messages.gap, { client, size, alternative: alternative ?? messages.none }));
    }
  }
  const result = { columns: messages.columns, actors, notes, clients: snapshot.clients.map((row) => row.client), missing: snapshot.plugin.missing };
  result.markdown = formatActors(result);
  return result;
}
