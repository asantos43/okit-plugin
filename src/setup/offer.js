// The end of an install or an update: the setup was not done yet, so the user
// is told what is missing and offered the command that does it. The offer never
// fails an installation: a setup that cannot run is reported and the
// installation stays successful.
import process from 'node:process';

import { readJson } from '../state.js';
import { paths } from '../store.js';
import { commandText } from '../install/command-token.js';
import { localizeReason } from '../install/present.js';
import { setupPending, DEFAULT_CONFIG, PROFILE_EFFORTS } from '../profiles.js';
import { runSetup, setupResultLines, formatUnreadable, isReadableConfig, CONFIG_UNREADABLE } from './setup.js';

// Every text here is simple, bilingual and free of demand or order ids.
export const OFFER_MESSAGES = Object.freeze({
  offer: {
    en: 'Setup is not done yet. Run {command} setup to choose the models.',
    'pt-BR': 'O setup ainda não foi feito. Rode {command} setup para escolher os modelos.',
  },
  question: {
    en: 'Configure now? [Y/n] Recommended: yes, review the detected choices together.',
    'pt-BR': 'Configurar agora? [S/n] Recomendação: sim, revisar juntos as escolhas encontradas.',
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

/**
 * The text of one message in one language; `both` shows the two of them.
 *
 * The reason of a failure is told here, once: the Portuguese side says it in Portuguese (REASONS),
 * the English side says it as the system said it. The caller never translates the reason itself.
 */
export function formatOffer(key, locale, values = {}) {
  const message = OFFER_MESSAGES[key];
  const language = locale === 'en' ? message.en : locale === 'pt-BR' ? message['pt-BR'] : null;
  // The reason of a failure is told in the language of the side that shows it (REASONS).
  const portuguese = values.reason === undefined ? values : { ...values, reason: localizeReason(values.reason, 'pt-BR') };
  if (language !== null) return fill(language, locale === 'pt-BR' ? portuguese : values);
  return `${fill(message.en, values)} / ${fill(message['pt-BR'], portuguese)}`;
}

/** An empty answer accepts the recommendation, like the setup wizard does. */
function affirmative(value) {
  const answer = String(value ?? '').trim();
  return answer === '' || /^(y|yes|s|sim)$/i.test(answer);
}

// A confirmation for another client cannot confirm the client being installed.
function pendingForClients(stored, clients) {
  return setupPending(stored) || Boolean(clients?.some((client) => Object.keys(PROFILE_EFFORTS).some((name) =>
    !stored.setup?.done?.profiles?.[client]?.[name])));
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
  clients,
  root,
  command = DEFAULT_CONFIG.install.command,
  locale = 'both',
  tty = process.stdin.isTTY,
  ask,
  out = () => {},
  run,
  env = process.env,
  adapters,
  snapshot,
  write,
} = {}) {
  const stored = await readJson(paths(root).config, {});
  // A file whose root is not a configuration is not a configuration: the offer
  // says the same simple sentence the setup says and the install goes on.
  if (!isReadableConfig(stored)) {
    out(formatUnreadable(locale, command));
    return { pending: true, offered: false, ran: false, failed: true };
  }
  if (!pendingForClients(stored, clients)) return { pending: false, offered: false, ran: false };

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
      clients,
      again: !setupPending(stored) && pendingForClients(stored, clients),
      root,
      config: stored,
      env,
      run,
      ask,
      adapters,
      snapshot,
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

/**
 * The same offer through the installer's presenter: one `Models` row at the
 * end of the run, the explanation first and the question last.
 */
async function runOfferRow({
  clients,
  ui,
  root,
  command = DEFAULT_CONFIG.install.command,
  tty = process.stdin.isTTY,
  ask,
  run,
  env = process.env,
  adapters,
  snapshot,
  write,
} = {}) {
  const row = (status, detail) => ui.row(ui.text('models'), status, detail);
  // The program the guides below start with: a token the installer view resolves, the plain command with no view.
  const program = commandText(ui, command, [], { later: true });
  const stored = await readJson(paths(root).config, {});
  if (!isReadableConfig(stored)) {
    row('skipped', formatUnreadable(ui.locale, program));
    return { pending: true, offered: false, ran: false, failed: true };
  }
  if (!pendingForClients(stored, clients)) return { pending: false, offered: false, ran: false };
  // Without a terminal there is nobody to answer, so the row says how to do it later.
  if (!tty || typeof ask !== 'function') {
    row('info', ui.text('modelsPending', { command: program }));
    return { pending: true, offered: true, ran: false };
  }
  try {
    const accepted = await ui.confirm(ask, { explain: [ui.text('modelsExplain', { command: program })], question: ui.text('modelsAsk'), defaultYes: true });
    if (!accepted) {
      row('skipped', ui.text('modelsDeclined', { command: program }));
      return { pending: true, offered: true, ran: false, declined: true };
    }
    const result = await runSetup({ clients, root, config: stored, env, run, ask, adapters, snapshot, write, command: program, ui,
      again: !setupPending(stored) && pendingForClients(stored, clients) });
    if (ui.humanOutput) {
      // An installation into a custom folder is somewhere the doctor does not look: no doctor line is offered for it.
      ui.explain(setupResultLines(result, ui.locale, program, { doctor: false }));
      if (result.changes.length) row('ok', ui.text('modelsSaved', { models: [...new Set(result.changes.map((change) => change.model))].join(', ') }));
      else row(result.cancelled ? 'skipped' : 'info', result.messages[0] ?? ui.text('modelsPending', { command: program }));
      return { pending: true, offered: true, ran: true, code: result.code };
    }
    const models = [...new Set(result.changes.map((change) => change.model))];
    if (result.cancelled || !models.length) row(result.cancelled ? 'skipped' : 'info', result.messages[0] ?? '');
    else row('ok', ui.text('modelsSaved', { models: models.join(', ') }));
    for (const message of result.messages.slice(result.cancelled || !models.length ? 1 : 0)) ui.note(message);
    return { pending: true, offered: true, ran: true, code: result.code };
  } catch (error) {
    row('skipped', formatOffer('failed', ui.locale, { command: program, reason: error.message }));
    return { pending: true, offered: true, ran: false, failed: true };
  }
}

export async function offerSetup(input = {}) {
  const locale = input.locale ?? 'both';
  const command = input.command ?? DEFAULT_CONFIG.install.command;
  const out = input.out ?? (() => {});
  try {
    return await (input.ui ? runOfferRow(input) : runOffer(input));
  } catch {
    const message = formatOffer('unreadable', input.ui?.locale ?? locale, { command: commandText(input.ui, command, [], { later: true }) });
    if (input.ui) input.ui.row(input.ui.text('models'), 'skipped', message);
    else out(message);
    return { pending: true, offered: false, ran: false, failed: true };
  }
}
