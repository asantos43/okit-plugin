// The "quota is back" notice. The kit raises one event when a subscription that
// was blocked by its quota can launch executors again; the Director waits for
// it in the background (no polling) and hands it here to get plain words.
// Everything the user reads lives in `NOTICE`, in both languages, and never
// carries an event type, a demand id or a run id.
import { CLIENTS } from '../spawn-process.js';

/** The event type the kit raises when a blocked subscription can launch again. */
export const QUOTA_RELEASED_EVENT = 'quota.released';

const CLIENT_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };

const NOTICE = {
  en: {
    released: (name) => name
      ? `Good news: the quota of your ${name} subscription is back. Work that was waiting can start again.`
      : 'Good news: the quota of a subscription is back. Work that was waiting can start again.',
    unavailable: 'The quota-back notice is not available yet. Update the kit to get it; until then, ask for the quota table whenever you want to check.',
  },
  'pt-BR': {
    released: (name) => name
      ? `Boa notícia: a cota da sua assinatura do ${name} voltou. O trabalho que estava esperando já pode recomeçar.`
      : 'Boa notícia: a cota de uma assinatura voltou. O trabalho que estava esperando já pode recomeçar.',
    unavailable: 'O aviso de cota liberada ainda não está disponível. Atualize o kit para recebê-lo; até lá, peça a tabela de cota quando quiser conferir.',
  },
};

/** True when `event` is the kit's quota-released event, however much else it carries. */
export function isQuotaReleased(event) {
  return event !== null && typeof event === 'object' && !Array.isArray(event)
    && event.type === QUOTA_RELEASED_EVENT;
}

/**
 * The notice for one kit event, in `locale`. Any other value (no event, an
 * event of another kind) means the kit cannot send this notice, and the answer
 * says so. A client name the plugin does not know is left out of the sentence
 * rather than quoted raw.
 * @param {unknown} event
 * @param {'en'|'pt-BR'} [locale]
 * @returns {{available: boolean, released: boolean, text: string}}
 */
export function quotaReleasedNotice(event, locale = 'en') {
  const words = NOTICE[locale] ?? NOTICE.en;
  if (!isQuotaReleased(event)) return { available: false, released: false, text: words.unavailable };
  const name = CLIENTS.includes(event.client) ? CLIENT_NAMES[event.client] : undefined;
  return { available: true, released: true, text: words.released(name) };
}
