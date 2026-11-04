// Whether the executors can be launched, told from the one environment snapshot so the doctor, `env_report` and
// `status` never disagree: every size class must have an actor that `canLaunch` on some client that is installed. A
// client that is not installed is optional and never a gap.

import { accountRows } from './account-rows.js';

const REASONS = { unconfirmed: 'no-model', 'not-logged-in': 'not-logged-in', 'unknown-quota': 'no-quota', 'expired-quota': 'expired-quota', low: 'low', busy: 'busy' };

/**
 * The reason a size class cannot be launched: the first restriction, in the order of what the person fixes first, of
 * the actor of the size that is closest to launching.
 *
 * @param {object[]} rows the rows of the installed clients of the snapshot
 * @param {string} size the size class
 * @returns {string} `no-client`, `no-actor`, `no-model`, `no-quota`, `expired-quota`, `low` or `busy`
 */
function reasonOf(rows, size) {
  if (!rows.length) return 'no-client';
  const actors = rows.flatMap((row) => row.candidates ?? []).filter((actor) => actor.sizes.includes(size))
    .sort((a, b) => a.restrictions.length - b.restrictions.length);
  if (!actors.length) return 'no-actor';
  return REASONS[Object.keys(REASONS).find((key) => actors[0].restrictions.includes(key))] ?? 'no-actor';
}

/**
 * The readiness of a snapshot.
 *
 * @param {object} snapshot the environment snapshot
 * @returns {{ready: boolean, gaps: {size: string, reason: string}[]}} `gaps` names each size class with no launchable actor
 */
export function readiness(snapshot) {
  const sizes = Object.keys(snapshot?.config?.actors?.sizeClasses ?? {});
  // A client whose installation is not known (`null`) is not installed as far as the answer goes: ready is never a guess.
  const rows = accountRows(snapshot?.clients).filter((row) => row.installed === true);
  const gaps = sizes
    .filter((size) => !rows.some((row) => (row.candidates ?? []).some((actor) => actor.canLaunch && actor.sizes.includes(size))))
    .map((size) => ({ size, reason: reasonOf(rows, size) }));
  const accounts = (snapshot?.clients ?? []).filter((row) => row.accounts?.length > 1).map((row) => ({
    client: row.client, ready: row.installed === true ? row.accounts.filter((account) => account.candidates.some((actor) => actor.canLaunch)).length : 0,
    total: row.accounts.length,
  }));
  return { ready: sizes.length > 0 && gaps.length === 0, gaps, ...accounts.length ? { accounts } : {} };
}

const WORDS = {
  en: { line: 'Ready to launch executors', yes: 'yes', no: 'no', gaps: 'gaps',
    reasons: { 'no-client': 'no client installed', 'no-actor': 'no actor configured', 'no-model': 'no model confirmed',
      'not-logged-in': 'account logged out', 'no-quota': 'quota not recorded', 'expired-quota': 'quota expired', low: 'quota low', busy: 'no free slot' } },
  'pt-BR': { line: 'Pronto para lançar executores', yes: 'sim', no: 'não', gaps: 'faltas',
    reasons: { 'no-client': 'nenhum cliente instalado', 'no-actor': 'nenhum ator configurado', 'no-model': 'nenhum modelo confirmado',
      'not-logged-in': 'conta deslogada', 'no-quota': 'cota não registrada', 'expired-quota': 'cota expirada', low: 'cota baixa', busy: 'sem vaga livre' } },
};

/**
 * The one line the doctor and `env_report` close with: the answer and, when it is no, the size classes with the reason.
 *
 * @param {{ready: boolean, gaps: {size: string, reason: string}[]}} result the readiness of a snapshot
 * @param {string} [locale] `en` or `pt-BR`
 * @returns {string}
 */
export function readyLine({ ready, gaps, accounts = [] }, locale = 'en') {
  const words = WORDS[locale] ?? WORDS.en;
  const why = gaps.map(({ size, reason }) => `${size} (${words.reasons[reason] ?? reason})`).join(', ');
  const counts = accounts.map(({ client, ready, total }) => `${client}: ${ready}/${total} ${locale === 'pt-BR' ? 'contas prontas' : 'accounts ready'}`).join('; ');
  return `${words.line}: ${ready ? words.yes : words.no}${why ? `; ${words.gaps}: ${why}` : ''}${counts ? `; ${counts}` : ''}.`;
}
