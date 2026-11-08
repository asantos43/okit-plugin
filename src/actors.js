// Read-only presentation of environment actors and launch restrictions.
import { configOf } from './profiles.js';
import { ageOf, labelsOf, quotaOrigin, callingClient, isolationNotes } from './env/quota.js';
import { environmentSnapshot } from './env/snapshot.js';
import { accountRows, accountName, shownWarnings, warningText } from './env/account-rows.js';
import { accountReasonText } from './accounts-choose.js';

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => values[key]);
const cell = (value) => String(value).replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');

export function formatActors(result) {
  const line = (values) => `| ${values.map(cell).join(' | ')} |`;
  return [...(result.actors.length || (!result.informational?.length && !result.notes.includes(result.otherLabel))
    ? [line(result.columns), line(result.columns.map(() => '---')),
      ...result.actors.map((actor) => line(actor.cells))] : []),
    ...(result.informational?.length ? [result.otherLabel,
      line(result.columns.filter((_, i) => i !== 6)), line(result.columns.filter((_, i) => i !== 6).map(() => '---')),
      ...result.informational.map((actor) => line(actor.cells))] : []), ...result.notes].join('\n');
}

export async function listActors(deps = {}) {
  const config = configOf(deps.snapshot?.config ?? deps.config);
  if (deps.profiles !== undefined) config.profiles = deps.profiles;
  const settings = config.actors;
  const messages = settings.messages[deps.locale] ?? settings.messages.en;
  const snapshot = await environmentSnapshot({ ...deps, config, view: 'selected', orders: [] });
  const actors = [];
  const informational = [];
  const caller = callingClient(deps);
  const selected = deps.client ?? (deps.all ? null : caller);
  const notes = [];
  if (!deps.client && !deps.all && !caller) notes.push(labelsOf(deps.locale).unknownClient);
  for (const observation of accountRows(snapshot.clients)) {
    if (selected && observation.client !== selected) continue;
    const other = caller && observation.client !== caller;
    if (observation.installed === false) {
      // A client with several saved accounts has one row for each, and one note.
      const note = `${observation.client}: ${labelsOf(deps.locale).optional}.`;
      if (!notes.includes(note)) notes.push(note);
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
    const client = accountName(observation);
    for (const warning of shownWarnings(observation)) notes.push(`${client}: ${warningText(warning, deps.locale)}`);
    const freeSlots = observation.slots.available;
    const pairs = new Map(observation.candidates.map((candidate) => {
      const reasons = candidate.restrictions.map((reason) => messages[reason] ?? ({
        'unknown-install': deps.locale === 'pt-BR' ? 'Instalação não confirmada. Rode setup.' : 'Installation unconfirmed. Run setup.', // locale:pt-BR
        unconfirmed: deps.locale === 'pt-BR' ? 'Modelo não confirmado. Rode setup.' : 'Model unconfirmed. Run setup.', // locale:pt-BR
        'unknown-quota': labelsOf(deps.locale).noQuota(observation.client, observation.account),
        'expired-quota': deps.locale === 'pt-BR' ? 'Cota expirada.' : 'Quota expired.',
        'not-logged-in': deps.locale === 'pt-BR' ? 'Conta deslogada.' : 'Account logged out.',
      })[reason]);
      return [JSON.stringify([candidate.model, candidate.effort]),
        // The actor names the client and the account; the display text is only in the table.
        { ...candidate, ...(observation.account ? { account: observation.account } : {}), freeSlots, quota, origin, reasons }];
    }));
    if (!pairs.size) {
      notes.push(fill(messages.empty, { client }));
      continue;
    }
    for (const actor of pairs.values()) {
      actor.cells = [client, actor.model, actor.effort ?? messages.missing,
        [...actor.sizes, ...(actor.critic ? [messages.critic] : [])].join(', ') || messages.missing, freeSlots,
        quotaText, actor.canLaunch ? messages.yes : messages.no, actor.reasons.join(' ') || messages.missing];
      if (other) {
        actor.cells.splice(6, 1);
        delete actor.canLaunch;
        informational.push(actor);
      } else actors.push(actor);
    }
    for (const { size, alternative } of other ? [] : observation.sizeCoverage.gaps) {
      notes.push(fill(messages.gap, { client, size, alternative: alternative ?? messages.none }));
    }
  }
  if (!informational.length && caller && snapshot.clients.some((row) => row.client !== caller
    && (!selected || row.client === selected))) notes.push(isolationNotes(deps.locale).other);
  notes.push(isolationNotes(deps.locale).shared);
  const accountChoices = (snapshot.accountChoices ?? []).filter((choice) => !selected || choice.client === selected);
  for (const choice of accountChoices) notes.push(`${choice.client} (${choice.actorClass}): ${choice.account ?? '—'}. ${accountReasonText(choice.reason, deps.locale)}`);
  const result = { columns: messages.columns, actors, informational, otherLabel: isolationNotes(deps.locale).other, notes, accountChoices,
    clients: snapshot.clients.filter((row) => !selected || row.client === selected).map((row) => row.client), missing: snapshot.plugin.missing };
  result.markdown = formatActors(result);
  return result;
}
