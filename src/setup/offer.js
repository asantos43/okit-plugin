// The end of an install or an update: the setup was not done yet, so the user
// is told what is missing and offered the command that does it. The offer never
// fails an installation: a setup that cannot run is reported and the
// installation stays successful.
import process from 'node:process';

import { readJson } from '../state.js';
import { paths } from '../store.js';
import { setupPending, DEFAULT_CONFIG } from '../profiles.js';
import { runSetup, formatUnreadable, isReadableConfig, CONFIG_UNREADABLE } from './setup.js';

// Every text here is simple, bilingual and free of demand or order ids.
export const OFFER_MESSAGES = Object.freeze({
  offer: {
    en: 'Setup is not done yet. Run {command} setup to choose the models.',
    'pt-BR': 'O setup ainda não foi feito. Rode {command} setup para escolher os modelos.',
  },
  question: {
    en: 'Configure now? [S/n]',
    'pt-BR': 'Configurar agora? [S/n]',
  },
  declined: {
    en: 'Setup was not run. Run {command} setup whenever you want it.',
    'pt-BR': 'O setup não foi executado. Rode {command} setup quando quiser.',
  },
  failed: {
    en: 'Setup could not run: {reason}. Run {command} setup later.',
    'pt-BR': 'O setup não pôde rodar: {reason}. Rode {command} setup depois.',
  },
  unreadable: CONFIG_UNREADABLE,
});

function fill(text, values) {
  return text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
}

/** The text of one message in one language; `both` shows the two of them. */
export function formatOffer(key, locale, values = {}) {
  const message = OFFER_MESSAGES[key];
  const language = locale === 'en' ? message.en : locale === 'pt-BR' ? message['pt-BR'] : null;
  if (language !== null) return fill(language, values);
  return `${fill(message.en, values)} / ${fill(message['pt-BR'], values)}`;
}

/** An empty answer accepts the recommendation, like the setup wizard does. */
function affirmative(value) {
  const answer = String(value ?? '').trim();
  return answer === '' || /^(y|yes|s|sim)$/i.test(answer);
}

/**
 * Offers the setup at the end of an installation: the line that says what is
 * missing, and, on an interactive terminal, the question that runs it. Without
 * an interactive terminal the offer is printed and nothing else happens.
 *
 * @param {{root: string, command?: string, locale?: string, tty?: boolean,
 *   ask?: Function, out?: Function, run?: Function, env?: object,
 *   adapters?: object, write?: Function}} input
 * @returns {Promise<{pending: boolean, offered: boolean, ran: boolean}>}
 */
async function runOffer({
  root,
  command = DEFAULT_CONFIG.install.command,
  locale = 'both',
  tty = process.stdin.isTTY,
  ask,
  out = () => {},
  run,
  env = process.env,
  adapters,
  write,
} = {}) {
  const stored = await readJson(paths(root).config, {});
  // A file whose root is not a configuration is not a configuration: the offer
  // says the same simple sentence the setup says and the install goes on.
  if (!isReadableConfig(stored)) {
    out(formatUnreadable(locale, command));
    return { pending: true, offered: false, ran: false, failed: true };
  }
  if (!setupPending(stored)) return { pending: false, offered: false, ran: false };

  out(formatOffer('offer', locale, { command }));
  // Without a terminal there is nobody to answer, so the offer is the end of it.
  if (!tty || typeof ask !== 'function') return { pending: true, offered: true, ran: false };

  let answer;
  try {
    answer = await ask(formatOffer('question', locale));
  } catch (error) {
    out(formatOffer('failed', locale, { command, reason: error.message }));
    return { pending: true, offered: true, ran: false, failed: true };
  }
  if (!affirmative(answer)) {
    out(formatOffer('declined', locale, { command }));
    return { pending: true, offered: true, ran: false, declined: true };
  }

  try {
    const result = await runSetup({
      root,
      config: stored,
      env,
      run,
      ask,
      adapters,
      write,
      locale,
      command,
    });
    for (const message of result.messages) out(message);
    return { pending: true, offered: true, ran: true, code: result.code };
  } catch (error) {
    out(formatOffer('failed', locale, { command, reason: error.message }));
    return { pending: true, offered: true, ran: false, failed: true };
  }
}

export async function offerSetup(input = {}) {
  const locale = input.locale ?? 'both';
  const command = input.command ?? DEFAULT_CONFIG.install.command;
  const out = input.out ?? (() => {});
  try {
    return await runOffer(input);
  } catch {
    out(formatOffer('unreadable', locale, { command }));
    return { pending: true, offered: false, ran: false, failed: true };
  }
}
