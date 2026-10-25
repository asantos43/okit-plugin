// Read-only view of configured model + effort pairs; status owns selection and quota.
import { configOf } from './profiles.js';
import { ageOf, detectClient, labelsOf, statusTable } from './status.js';
import { capOf } from './limits.js';

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => values[key]);
const cell = (value) => String(value).replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');

export function formatActors(result, { json = false } = {}) {
  if (json) return JSON.stringify(result);
  const line = (values) => `| ${values.map(cell).join(' | ')} |`;
  return [line(result.columns), line(result.columns.map(() => '---')),
    ...result.actors.map((actor) => line(actor.cells)), ...result.notes].join('\n');
}

export async function listActors(deps = {}) {
  const config = configOf({ ...deps.config,
    ...(deps.profiles === undefined ? {} : { profiles: deps.profiles }) });
  const settings = config.actors;
  const messages = settings.messages[deps.locale] ?? settings.messages.en;
  const table = await statusTable(deps.root, { ...deps, config, demands: [], orders: [] });
  const actors = [];
  const notes = [];
  if (!deps.client && !deps.all && !detectClient(deps.env)) notes.push(labelsOf(deps.locale).unknownClient);
  for (const { client: quotaClient, fiveHour, week, resetsInMinutes, status, source, readAt } of table.rows) {
    const quota = { client: quotaClient, fiveHour, week, resetsInMinutes, status, source, readAt };
    const remaining = [fiveHour, week].filter((value) => typeof value === 'number' && Number.isFinite(value));
    const quotaText = fill(messages.quota, {
      state: messages[`quota${status[0].toUpperCase()}${status.slice(1)}`],
      percentage: remaining.length ? fill(messages.percentage, { value: Math.round(Math.min(...remaining)) }) : messages.missing,
      age: readAt === null ? messages.missing : ageOf(readAt, (deps.now ?? Date.now)(), {
        age: (seconds) => fill(messages.age, { seconds }),
      }),
    });
    const client = quota.client;
    const { cap } = capOf(deps.limits?.limits ?? config.limits, client);
    const freeSlots = Math.max(0, cap - (deps.limits?.byClient?.[client] ?? 0));
    const reasons = [quota.status === 'red' ? messages.low : null,
      freeSlots === 0 ? messages.busy : null].filter(Boolean);
    const pairs = new Map();
    for (const [profileClass, profile] of Object.entries(config.profiles[client] ?? {})) {
      if (typeof profile?.model !== 'string' || !profile.model.trim()) continue;
      const sizes = Object.entries(settings.sizeClasses).filter(([, value]) => value === profileClass).map(([size]) => size);
      const critic = profileClass === settings.criticClass;
      const key = JSON.stringify([profile.model, profile.effort]);
      const actor = pairs.get(key) ?? { client, model: profile.model, effort: profile.effort,
        sizes: [], critic: false, freeSlots, quota, canLaunch: reasons.length === 0, reasons };
      actor.sizes.push(...sizes);
      actor.critic ||= critic;
      pairs.set(key, actor);
    }
    if (!pairs.size) {
      notes.push(fill(messages.empty, { client }));
      continue;
    }
    for (const actor of pairs.values()) {
      actor.sizes = Object.keys(settings.sizeClasses).filter((size) => actor.sizes.includes(size));
      actor.cells = [client, actor.model, actor.effort ?? messages.missing,
        [...actor.sizes, ...(actor.critic ? [messages.critic] : [])].join(', ') || messages.missing, freeSlots,
        quotaText, actor.canLaunch ? messages.yes : messages.no, reasons.join(' ') || messages.missing];
      actors.push(actor);
    }
    const sizes = Object.keys(settings.sizeClasses);
    const available = sizes.filter((size) => [...pairs.values()].some((actor) => actor.canLaunch && actor.sizes.includes(size)));
    for (const size of sizes.filter((value) => !available.includes(value))) {
      const nearest = [...available].sort((a, b) => Math.abs(sizes.indexOf(a) - sizes.indexOf(size))
        - Math.abs(sizes.indexOf(b) - sizes.indexOf(size)))[0];
      notes.push(fill(messages.gap, { client, size, alternative: nearest ?? messages.none }));
    }
  }
  const result = { columns: messages.columns, actors, notes, clients: table.rows.map((row) => row.client) };
  result.markdown = formatActors(result);
  return result;
}
