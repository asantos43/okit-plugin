// The texts of the installer that the presenter does not have yet (src/install/present.js): every one of them in
// English and in Brazilian Portuguese, in the same shape as the ones of the presenter.
//
// The presenter of the installer (TEXTS in src/install/present.js) is the one place every message goes through; these
// are the few texts of the doctor and of the self-check that the presenter does not have yet. They are picked and
// filled with the same functions of the presenter, so a run speaks one language and nothing is written twice.

import { fill, pick } from './present.js';

export const EXTRA_TEXTS = Object.freeze({
  // The check of the payload of an installation: every file the installed package lists is there.
  selfcheckPayload: { en: 'Payload', 'pt-BR': 'Conteúdo da instalação' },
  selfcheckPayloadWhole: { en: 'every file of the installation is there', 'pt-BR': 'todo o conteúdo da instalação está lá' },
  selfcheckPayloadMissing: { en: 'the file {file} of the installation is missing', 'pt-BR': 'o arquivo {file} da instalação está faltando' },
  // The Fix of the row of the autostart: the daemon starts with the machine, and the command that starts it is
  // written with the node the plan of the machine writes (never a bare `node`, which the PATH of an unknown shell
  // would have to resolve).
  doctorFixAutostartDaemon: {
    en: 'Set it up: the daemon starts with {daemon}; the setup offers the autostart step and installs it when the answer is yes: {command} setup',
    'pt-BR': 'Configure: o daemon começa com {daemon}; o setup oferece o passo de inicialização automática e o instala quando a resposta for sim: {command} setup',
  },
});

/**
 * One text of these, in the language of the run, with its values in it.
 *
 * @param {string} key the key of the text
 * @param {string} locale the language of the run
 * @param {object} [values] the values of the placeholders
 * @returns {string} the sentence
 */
export const extraText = (key, locale, values = {}) => fill(pick(EXTRA_TEXTS[key], locale), values);
