// Which installer a Linux/macOS run uses, decided from the environment only. This file imports nothing: the generated
// install.sh embeds it (src/release/install-scripts.js), and the installed command (`install --ui --auto`) reads the
// same texts through src/config-ui/labels.js.
//
//   route   'ui' (the browser wizard) or 'terminal' (the terminal installer)
//   reason  why the terminal was chosen when nobody asked for it, or null
export const ROUTE_TEXT = {
  en: {
    ssh: 'No graphical session detected (SSH); using the terminal installer. Use --ui --headless for a forwarded browser session.',
    container: 'No graphical session detected (container); using the terminal installer. Use --ui --headless for a forwarded browser session.',
    display: 'No graphical session detected (no DISPLAY or WAYLAND_DISPLAY); using the terminal installer. Use --ui --headless for a forwarded browser session.',
    opener: 'No program to open a browser was found; using the terminal installer. Use --ui --headless and open the printed address yourself.',
    'opener-failed': 'The browser could not be opened; using the terminal installer. Use --ui --headless and open the printed address yourself.',
    options: 'Options only the terminal installer supports were given; using the terminal installer.',
    'no-terminal': 'The terminal installer needs a terminal to ask in. Pass --client, or use --ui --headless.',
  },
  'pt-BR': {
    ssh: 'Nenhuma sessão gráfica detectada (SSH); usando o instalador de terminal. Use --ui --headless para uma sessão de navegador encaminhada.',
    container: 'Nenhuma sessão gráfica detectada (contêiner); usando o instalador de terminal. Use --ui --headless para uma sessão de navegador encaminhada.',
    display: 'Nenhuma sessão gráfica detectada (sem DISPLAY nem WAYLAND_DISPLAY); usando o instalador de terminal. Use --ui --headless para uma sessão de navegador encaminhada.',
    opener: 'Nenhum programa para abrir o navegador foi encontrado; usando o instalador de terminal. Use --ui --headless e abra o endereço impresso por conta própria.',
    'opener-failed': 'Não foi possível abrir o navegador; usando o instalador de terminal. Use --ui --headless e abra o endereço impresso por conta própria.',
    options: 'Foram dadas opções que só o instalador de terminal aceita; usando o instalador de terminal.',
    'no-terminal': 'O instalador de terminal precisa de um terminal para perguntar. Passe --client, ou use --ui --headless.',
  },
};

/** The text of a reason in a language (English when the language is not one of the two). */
export function routeReason(locale, reason) {
  return (ROUTE_TEXT[locale] ?? ROUTE_TEXT.en)[reason];
}

/**
 * The route of a run. Pure: every fact is an argument.
 *   flags      { ui, headless, terminal } as given; an explicit one is never overridden (`--ui` never falls back)
 *   unattended the run carries options only the terminal installer supports (--yes, --autostart, the execution policy)
 *   env        the environment (SSH_CONNECTION, SSH_TTY, DISPLAY, WAYLAND_DISPLAY)
 *   platform   process.platform
 *   container  the program runs inside a container
 *   hasOpener  xdg-open (Linux) or open (macOS) was found
 */
export function chooseRoute({ flags = {}, unattended = false, env = {}, platform, container = false, hasOpener = false }) {
  if (flags.terminal) return { route: 'terminal', reason: null };
  if (flags.ui || flags.headless) return { route: 'ui', reason: null };
  if (unattended) return { route: 'terminal', reason: 'options' };
  if (env.SSH_CONNECTION || env.SSH_TTY) return { route: 'terminal', reason: 'ssh' };
  // macOS has a graphical session whenever it is not an SSH login and `open` exists; DISPLAY says nothing there.
  if (platform !== 'darwin' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return { route: 'terminal', reason: container ? 'container' : 'display' };
  if (!hasOpener) return { route: 'terminal', reason: 'opener' };
  return { route: 'ui', reason: null };
}
