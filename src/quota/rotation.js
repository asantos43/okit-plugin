import { quotaOf, accountReasonText } from '../accounts-choose.js';

export function rotationStatus({ reading, login, config, now, locale = 'en' }) {
  const quota = quotaOf(reading, now, config);
  const minimum = config.accountPolicy?.minQuotaPct ?? 20;
  let reason;
  if (login === 'logged-out') reason = { code: 'login' };
  else if (quota.session?.remainingPct <= minimum) reason = { code: 'session', remaining: quota.session.remainingPct, minimum };
  else if (quota.weekly?.remainingPct <= minimum) reason = { code: 'weekly', remaining: quota.weekly.remainingPct, minimum };
  const known = Boolean(quota.session && quota.weekly);
  return { eligible: !reason, known, readAt: quota.readAt,
    reason: reason?.code ?? (known ? 'eligible' : 'no-reading'),
    text: reason ? accountReasonText(reason, locale) : locale === 'pt-BR' // locale:pt-BR
      ? known ? 'Elegível para rotação.' : 'Sem leitura atual; elegível por último.' // locale:pt-BR
      : known ? 'Eligible for rotation.' : 'No current reading; eligible last.' };
}

export function pollReason(state, locale = 'en') {
  if (!state || state.state === 'ok') return null;
  if (state.state === 'read-failed') {
    const status = /^Usage request failed \(HTTP (\d+)\)\.$/.exec(state.reason ?? '');
    if (status) return locale === 'pt-BR' ? `Falha na consulta de uso (HTTP ${status[1]}).` // locale:pt-BR
      : `Usage request failed (HTTP ${status[1]}).`;
    if (state.reason === 'Usage read timed out.') return locale === 'pt-BR' // locale:pt-BR
      ? 'Tempo esgotado na leitura de uso.' : 'Usage read timed out.'; // locale:pt-BR
  }
  const texts = locale === 'pt-BR' ? { // locale:pt-BR
    'not-logged-in': 'Conta não logada.', 'token-expired': 'Token indisponível; aguardando fallback.', // locale:pt-BR
    'read-failed': 'Falha na leitura de uso.', 'no-reading': 'Nenhuma leitura ainda.', // locale:pt-BR
  } : { 'not-logged-in': 'Account is not logged in.', 'token-expired': 'Token unavailable; waiting for fallback.',
    'read-failed': 'Usage read failed.', 'no-reading': 'No reading yet.' };
  return texts[state.state] ?? texts['read-failed'];
}
