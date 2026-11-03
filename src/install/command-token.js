// A command inside a text another module writes (a note, the detail of a step, a Fix line) is written as a token, never
// as final text: only the installer view swaps the token for the command a person can type on this terminal. Text with
// no token is never touched. The token uses control characters, which no path, message or user text contains.
export const TOKEN_START = '\u0001', TOKEN_SEP = '\u0002', TOKEN_END = '\u0003';
const MODES = { later: 'l', now: 'n', program: 'p' };

/**
 * The token of a command: `later` is the command a new terminal finds, otherwise the program as it runs now. A writer that
 * has proven its own program (the self-check, on the PATH it ran with) gives it as `program`, already typed for the shell.
 */
export const commandToken = (words = [], { later = false, program } = {}) =>
  `${TOKEN_START}${program ? MODES.program : later ? MODES.later : MODES.now}${(program ? [program, ...words] : words).join(TOKEN_SEP)}${TOKEN_END}`;

/** Whether a text carries a command to type (a remedy), whoever wrote it. */
export const hasCommand = (text) => String(text ?? '').includes(TOKEN_START);

/** Every token of a text, replaced by what `build(words, {later, program})` says; the rest of the text stays as written. */
export const resolveTokens = (text, build) => String(text).replace(
  new RegExp(`${TOKEN_START}([lnp])([^${TOKEN_END}]*)${TOKEN_END}`, 'g'),
  (_, mode, words) => {
    const list = words ? words.split(TOKEN_SEP) : [];
    return mode === MODES.program ? build(list.slice(1), { later: false, program: list[0] }) : build(list, { later: mode === MODES.later });
  });

/**
 * The command a module writes into its text. With the installer view (`ui.command`) it is a token; without a view (JSON,
 * scripts, the standalone commands) it is the plain command, as it always was. With no words it is the program alone,
 * for the texts that carry their own verb (`{command} setup`).
 */
export const commandText = (ui, command, words = [], options = {}) =>
  typeof ui?.command === 'function' ? ui.command(words, options) : [command, ...words].join(' ');
