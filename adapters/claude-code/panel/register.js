import { boardSegments, loadState } from './panel.js';
import { createRefresh } from './refresh.js';

const PANE = 'okit-plugin';
// The host supplies global h in JavaScript; verified with claude-code/testing.
/** @param {import('./types.js').On} on */
export function register(on) {
  /** @type {import('./types.js').Result} */
  let cached = { ok: false, error: 'Loading state…' };
  /** @type {ReturnType<typeof createRefresh> | undefined} */
  let refresh;
  /** @param {Parameters<typeof createRefresh>[0]} deps @param {() => Promise<void>} open */
  const openPane = async (deps, open) => {
    refresh?.close();
    refresh = createRefresh(deps);
    cached = { ok: false, error: 'Loading state…' };
    await open();
    refresh.open();
  };
  on('session.start', async ($, event, next) => {
    refresh?.close();
    cached = { ok: false, error: 'Loading state…' };
    try { await $.ui.close({ id: PANE }); }
    catch {}
    try { await $.command.register({ name: 'okit-panel', description: 'Open or close the okit plugin panel' }); }
    catch {}
    try {
      const state = await loadState((args, options) => $.process.run(args, options));
      if (!state.ok || state.state.panel?.autoOpen !== false) await openPane({
        clock: { every: (ms, tick) => $.clock.every(ms, tick) },
        load: () => loadState((args, options) => $.process.run(args, options)),
        visible: async () => (await $.ui.panes()).some(pane => pane.id === PANE),
        publish(value) { cached = value; $.ui.invalidate('ui.render'); },
      }, () => $.ui.open({ id: PANE, title: 'okit plugin' }));
    } catch { refresh?.close(); }
    return next(event);
  });
  on('command.run', { command: 'okit-panel' }, async $ => {
    try {
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
      try { await $.ui.close({ id: PANE }); }
      catch (error) { return unavailable(error); }
      refresh?.close();
      return { text: 'okit plugin panel closed.' };
    }
    await openPane({
      clock: { every: (ms, tick) => $.clock.every(ms, tick) },
      load: () => loadState((args, options) => $.process.run(args, options)),
      visible: async () => (await $.ui.panes()).some(pane => pane.id === PANE),
      publish(value) { cached = value; $.ui.invalidate('ui.render'); },
    }, () => $.ui.open({ id: PANE, title: 'okit plugin' }));
    return { text: 'okit plugin panel opened.' };
    } catch (error) { refresh?.close(); return unavailable(error); }
  });
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, event) => {
    const { Box, Text } = $.ui.resolve(event);
    const width = Math.max(1, (event.props?.bodyColumns ?? 80) - 2);
    const colors = { ok: 'success', warn: 'warning', low: 'error', dim: 'inactive' };
    const styled = cached.ok && cached.state.panel?.color !== false;
    // One Text per line with a nested Text per segment: only the segment's own text has a color, never the frame.
    return h(Box, { flexDirection: 'column' }, ...boardSegments(cached, width).map((line, index) =>
      h(Text, { key: String(index) }, ...(line.length ? line : [{ text: ' ' }]).map((segment, part) => {
        const color = styled && segment.tone ? colors[segment.tone] : undefined;
        return h(Text, { key: String(part), ...(color ? { color } : {}), ...(styled && segment.bold ? { bold: true } : {}) }, segment.text);
      }))));
  });
}

/** @param {unknown} error */
function unavailable(error) {
  return { text: `okit plugin panel unavailable: ${error instanceof Error ? error.message : String(error)}` };
}
