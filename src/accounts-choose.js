// Account policy over observations supplied by the caller; no readers or clock of its own.
import { fill } from './install/present.js';
import { finiteNumber, windowsOf } from './quota-fields.js';

const WEEK = 10080 * 60_000;
const compareId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const pct = (value) => finiteNumber(value) !== null && value >= 0 && value <= 100;

function inspect(account, actor, runs, now, settings) {
  const quota = quotaOf(account.reading, now);
  const ownRuns = runs.filter((run) => run.client === account.client && (run.account ?? 'default') === account.id);
  const live = ownRuns.filter((run) => run.status === 'live'
    && (typeof run.startedAt !== 'number' || now - run.startedAt <= (settings.staleMinutes ?? 30) * 60_000)).length;
  const cap = account.parallelLimit ?? settings.limits?.clients?.[account.client] ?? settings.limits?.global ?? 3;
  const minimum = settings.accountPolicy?.minQuotaPct ?? 0;
  let reason;
  if (account.login === 'logged-out') reason = { code: 'login' };
  else if (!actor.model || !actor.effort || !account.actors?.some((a) => a.model === actor.model && a.effort === actor.effort)) {
    reason = { code: 'actor' };
  } else if (quota.session && quota.session.remainingPct <= minimum) {
    reason = { code: 'session', remaining: quota.session.remainingPct, minimum };
  } else if (quota.weekly && quota.weekly.remainingPct <= minimum) {
    reason = { code: 'weekly', remaining: quota.weekly.remainingPct, minimum };
  } else if (live >= cap) reason = { code: 'busy', running: live, limit: cap };
  const last = Math.max(0, account.lastLaunchedAt ?? 0, ...ownRuns.map((r) => finiteNumber(r.startedAt) ?? 0));
  return { account, ...quota, live, last, reason,
    unknown: account.login !== 'logged-in' || !quota.session || !quota.weekly || quota.headroom === null };
}

function quotaOf(reading, now) {
  const windows = windowsOf(reading?.windows);
  if (!windows.length && pct(reading?.remainingPct)) windows.push({ ...reading });
  const widest = (short) => windows.filter((w) => pct(w.remainingPct)
    && ((w.windowMinutes ?? w.minutes ?? 10080) <= 300) === short)
    .sort((a, b) => (b.windowMinutes ?? b.minutes ?? 10080) - (a.windowMinutes ?? a.minutes ?? 10080))[0];
  const session = widest(true);
  const weekly = widest(false);
  const parsedReset = weekly?.resetsAt ? Date.parse(weekly.resetsAt) : null;
  const reset = Number.isFinite(parsedReset) ? parsedReset
    : finiteNumber(weekly?.resetsInMinutes) !== null ? now + weekly.resetsInMinutes * 60_000 : null;
  const expected = reset === null ? null : Math.min(100, Math.max(0, (reset - now) / WEEK * 100));
  return { session, weekly, reset, headroom: expected === null ? null : weekly.remainingPct - expected };
}

/**
 * Select from pre-read account identities: {client, id, login, actors: [{model, effort}], reading}.
 * Reading uses quota windows: remainingPct, windowMinutes (or minutes), resetsAt/resetsInMinutes.
 * The caller supplies fresh observations and resolves resumeSession to {account}; no owner means refusal.
 * actorClass is a profile name in settings.profiles[client], or {name, model, effort, role?, executorAccount?, urgent?}.
 * now is epoch milliseconds. Runs follow limits.js: status live, staleMinutes (30), absent account is default.
 * Slots use account.parallelLimit, then settings.limits.clients[client], then limits.global (3).
 * Recency uses account.lastLaunchedAt and run.startedAt. Unknown weekly reset disables pacing.
 * Critic/verifier prefer another eligible account; urgent means the person's explicit urgency.
 * The result preserves the supplied account object; null wait_until means no safe release time is known.
 */
export function chooseAccount({ client, actorClass, accounts = [], runs = [], now, resumeSession, settings = {} }) {
  if (!Number.isFinite(now)) throw new TypeError('now must be a finite timestamp');
  const actor = typeof actorClass === 'string'
    ? { ...settings.profiles?.[client]?.[actorClass], name: actorClass } : actorClass ?? {};
  const pin = resumeSession?.account;
  if (resumeSession && typeof pin !== 'string') return { wait_until: null, reason: { code: 'session-account' } };
  const candidates = accounts.filter((a) => a.client === client && (pin === undefined || a.id === pin))
    .map((a) => inspect(a, actor, runs, now, settings));
  let eligible = candidates.filter((a) => !a.reason);
  if (!eligible.length) {
    const first = candidates.sort((a, b) => compareId(a.account, b.account))[0];
    return { wait_until: null, reason: first?.reason ?? { code: pin === undefined ? 'unavailable' : 'session-account' } };
  }
  const review = ['critic', 'verifier'].includes(actor.role ?? actor.name);
  if (pin === undefined && review && eligible.some((a) => a.account.id !== actor.executorAccount)) {
    eligible = eligible.filter((a) => a.account.id !== actor.executorAccount);
  }
  eligible.sort((a, b) => Number(a.unknown) - Number(b.unknown)
    || (b.headroom ?? -Infinity) - (a.headroom ?? -Infinity)
    || (b.session?.remainingPct ?? -Infinity) - (a.session?.remainingPct ?? -Infinity)
    || a.live - b.live || a.last - b.last || compareId(a.account, b.account));
  return decision(eligible[0], actor, settings, now);
}

function decision(chosen, actor, settings, now) {
  const margin = settings.accountPolicy?.paceMarginPct ?? 15;
  const ahead = chosen.headroom !== null && chosen.headroom < -margin;
  const reason = { code: ahead ? 'ahead' : chosen.unknown ? 'unknown' : 'chosen',
    weeklyHeadroom: chosen.headroom, sessionRemaining: chosen.session?.remainingPct ?? null,
    running: chosen.live, margin };
  if (ahead && settings.accountPolicy?.enforcePace === true && actor.name === 'hard' && actor.urgent !== true) {
    const wait_until = Math.min(chosen.reset, Math.max(now, Math.ceil(chosen.reset
      - (chosen.weekly.remainingPct + margin) / 100 * WEEK)));
    return { wait_until, reason: { ...reason, code: 'deferred', wait_until } };
  }
  return { account: chosen.account, reason };
}

export const ACCOUNT_REASON_TEXTS = {
  en: {
    chosen: 'Account selected by available weekly quota.',
    unknown: 'Account selected with unknown login or quota information.',
    login: 'The account is not logged in.',
    actor: 'The account does not offer this model and effort.',
    session: 'Session quota is {remaining}%; it must be above {minimum}%.',
    weekly: 'Weekly quota is {remaining}%; it must be above {minimum}%.',
    busy: 'The account has {running} running; the limit is {limit}.',
    unavailable: 'No account is available.',
    'session-account': 'The account holding this session is unavailable.',
    ahead: 'Weekly use is ahead of pace by more than {margin} points; launch allowed.',
    deferred: 'Weekly use is ahead of pace by more than {margin} points; hard work must wait.',
  },
  'pt-BR': {
    chosen: 'Conta escolhida pela cota semanal disponível.',
    unknown: 'Conta escolhida com informação de login ou cota desconhecida.',
    login: 'A conta não está logada.',
    actor: 'A conta não oferece este modelo e esforço.',
    session: 'A cota da sessão é {remaining}%; deve estar acima de {minimum}%.',
    weekly: 'A cota semanal é {remaining}%; deve estar acima de {minimum}%.',
    busy: 'A conta tem {running} em execução; o limite é {limit}.',
    unavailable: 'Nenhuma conta está disponível.',
    'session-account': 'A conta que contém esta sessão está indisponível.',
    ahead: 'O uso semanal está mais de {margin} pontos à frente do ritmo; início permitido.',
    deferred: 'O uso semanal está mais de {margin} pontos à frente do ritmo; trabalho difícil deve esperar.',
  },
};

/** Structured reasons stay language-neutral until presentation. */
export function accountReasonText(reason, locale = 'en') {
  const texts = ACCOUNT_REASON_TEXTS[locale] ?? ACCOUNT_REASON_TEXTS.en;
  return fill(texts[reason?.code] ?? texts.unavailable, reason);
}
