import { frameLines } from './frame.js';
import { loadState, viewModel } from './panel.js';
import { createRefresh } from './refresh.js';

const PANE = 'okit-plugin';
// Host supplies h for UI elements, as in the reference mod's TSX runtime.
/** @param {import('./types.js').On} on */
export function register(on) {
  /** @type {import('./types.js').Result} */
  let cached = { ok: false, error: 'Loading state…' };
  /** @type {ReturnType<typeof createRefresh> | undefined} */
  let refresh;
  /** @type {import('./types.js').Engine} */
  let engine;
  on('session.start', {}, async ($, event, next) => {
    refresh?.close();
    engine = $;
    cached = { ok: false, error: 'Loading state…' };
    try { await $.ui.close({ id: PANE }); }
    catch {}
    try { await $.command.register({ name: 'okit-panel', description: 'Open or close the okit plugin panel' }); }
    catch {}
    return next(event);
  });
  on('command.run', { command: 'okit-panel' }, async $ => {
    engine = $;
    try {
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
      try { await $.ui.close({ id: PANE }); }
      catch (error) { return unavailable(error); }
      refresh?.close();
      return { text: 'okit plugin panel closed.' };
    }
    refresh ??= createRefresh({
      clock: { every: (ms, tick) => engine.clock.every(ms, tick) },
      load: () => loadState((args, options) => engine.process.run(args, options)),
      visible: async () => (await engine.ui.panes()).some(pane => pane.id === PANE),
      publish(value) { cached = value; engine.ui.invalidate('ui.render'); },
    });
    refresh.close();
    cached = { ok: false, error: 'Loading state…' };
    await $.ui.open({ id: PANE, title: 'okit plugin' });
    refresh.open();
    return { text: 'okit plugin panel opened.' };
    } catch (error) { refresh?.close(); return unavailable(error); }
  });
  on('ui.render', { component: 'Pane', requestId: PANE }, ($, event) => {
    const { Box, Text } = $.ui.resolve(event);
    const width = Math.max(1, (event.props?.bodyColumns ?? 80) - 2);
    const lines = viewModel(cached).flatMap(block => frameLines(block.title, block.rows, width));
    return h(Box, { flexDirection: 'column' }, ...lines.map((line, index) => h(Text, { key: String(index) }, line)));
  });
}

/** @param {unknown} error */
function unavailable(error) {
  return { text: `okit plugin panel unavailable: ${error instanceof Error ? error.message : String(error)}` };
}
