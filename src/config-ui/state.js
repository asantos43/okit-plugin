import { configOf, PROFILE_EFFORTS } from '../profiles.js';
import { schemaEntries, effectiveValue } from '../core/config.js';
import { accountsOf, ACCOUNT_CLIENTS } from '../accounts.js';
import { confirmedModels } from '../env/models.js';
import { readiness, readyLine } from '../env/ready.js';

const SECRET = /(?:password|passwd|secret|credential|authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|private[-_]?key)/i;
const CONTENT = /(?:\b(?:Bearer|Basic)\s+\S+|\bsk-[\w-]+|-----BEGIN .*PRIVATE KEY|https?:\/\/[^\s/]+:[^\s/]+@|(?:password|secret|token|api[-_]?key)\s*[=:]\s*\S+)/i;
export function sensitive(path, value) {
  return SECRET.test(path) || /(?:^|[._])token(?:$|[._])/i.test(path)
    || typeof value === 'string' && CONTENT.test(value);
}
export function redact(value, path = '') {
  if (sensitive(path, value)) return '[Redacted]';
  if (Array.isArray(value)) return value.map((item) => redact(item, path));
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redact(item, `${path}.${key}`)]));
  return value;
}

export function buildState({ raw = {}, observations = [], snapshot, locale = 'en', expectedMtime = null } = {}) {
  const config = configOf(raw);
  const defaults = configOf({});
  const local = (text) => text?.[locale] ?? text?.en;
  const fields = schemaEntries(raw).map((entry) => {
    const current = effectiveValue(entry, raw, config);
    const fallback = effectiveValue(entry, {}, defaults).value;
    return { path: entry.path, type: entry.type, constraint: local(entry.constraint),
      description: local(entry.description), allowedValues: entry.allowedValues ?? null,
      value: redact(current.value, entry.path), default: redact(fallback, entry.path),
      isDefault: JSON.stringify(current.value) === JSON.stringify(fallback) };
  });
  const accounts = Object.keys(config.profiles).flatMap((client) => ACCOUNT_CLIENTS.includes(client)
    ? accountsOf(config, client).map(({ id, label }) => ({ client, id, label: redact(label) })) : []);
  const actors = Object.keys(config.profiles).flatMap((client) => {
    const identities = accounts.filter((account) => account.client === client);
    return (identities.length ? identities : [{ id: null }]).map((account) => {
      const reading = observations.find((item) => item.client === client
        && (item.account ?? 'default') === (account.id ?? 'default'));
      const models = confirmedModels(config, client, reading, reading?.installed);
      const row = snapshot?.clients?.find((item) => item.client === client);
      const observed = row?.accounts?.find((item) => item.id === account.id) ?? row;
      const reason = reading?.reason ?? (reading?.installed === false
        ? 'Client is not installed.' : reading ? null : 'Model list is unavailable.');
      return { client, account: account.id, reason,
        classes: actorClasses(config, client, models, observed), models };
    });
  });
  return redact({ fields, actors, accounts, expectedMtime,
    readiness: readyLine(readiness(snapshot ?? { config, clients: [] }), locale) });
}

function actorClasses(config, client, models, observed) {
  return [...Object.keys(PROFILE_EFFORTS), 'critic'].map((name) => {
    const profileClass = name === 'critic' ? config.actors.criticClass : name;
    const profile = config.profiles[client]?.[profileClass];
    const candidate = observed?.candidates?.find((actor) => actor.model === profile?.model
      && actor.effort === profile?.effort);
    const choices = [...models];
    if (profile?.model && !choices.includes(profile.model)) choices.push(profile.model);
    return { class: name, path: `profiles.${client}.${profileClass}`, enabled: profile != null,
      model: profile?.model ?? null, effort: profile?.effort ?? null, maxTurns: profile?.maxTurns ?? null,
      efforts: [...new Set(Object.values(PROFILE_EFFORTS))],
      modelChoices: choices.map((model) => ({ model, confirmed: models.includes(model) })),
      launchableNow: candidate?.canLaunch === true, reasons: candidate?.restrictions ?? ['unobserved'] };
  });
}
