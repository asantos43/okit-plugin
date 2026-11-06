// Adapted from panels.tsx's busy guard and register.tsx's cancellable clock (3451493).
/**
 * @param {{clock: import('./types.js').Clock, load: () => Promise<import('./types.js').Result>,
 * publish: (value: import('./types.js').Result) => void,
 * visible: () => Promise<boolean>, loadTimeoutMs?: number}} runtime
 * @param {number} [requestedMs]
 */
export function createRefresh(runtime, requestedMs = 3000) {
  const intervalMs = Number.isFinite(requestedMs) ? Math.max(2000, Math.ceil(requestedMs)) : 3000;
  let active = false;
  let busy = -1;
  let generation = 0;
  /** @type {import('./types.js').Timer | undefined} */
  let timer;
  function boundedLoad() {
    return new Promise(/** @param {(value: import('./types.js').Result) => void} resolve */ resolve => {
      let settled = false;
      /** @param {import('./types.js').Result} value */
      const finish = value => {
        if (settled) return;
        settled = true;
        deadline.cancel();
        resolve(value);
      };
      const requested = runtime.loadTimeoutMs ?? 15000;
      const deadline = runtime.clock.every(Number.isFinite(requested) && requested > 0 ? requested : 15000,
        () => finish({ ok: false, error: 'State unavailable: refresh timed out.' }));
      try { runtime.load().then(finish, () => finish({ ok: false, error: 'State unavailable: refresh failed.' })); }
      catch { finish({ ok: false, error: 'State unavailable: refresh failed.' }); }
    });
  }
  function close() {
    active = false;
    generation++;
    timer?.cancel();
    timer = undefined;
  }
  async function refresh(checkVisibility = true) {
    if (!active || busy === generation) return;
    busy = generation;
    const current = generation;
    try {
      if (checkVisibility) {
        const visible = await runtime.visible();
        if (!active || generation !== current) return;
        if (!visible) { close(); return; }
      }
      if (!active || generation !== current) return;
      const value = await boundedLoad();
      if (active && generation === current) runtime.publish(value);
    } catch {
      if (active && generation === current)
        runtime.publish({ ok: false, error: 'State unavailable: refresh failed.' });
    } finally { if (busy === current) busy = -1; }
  }
  return {
    intervalMs, close, refresh,
    get isOpen() { return active; },
    open() {
      if (active) return;
      active = true;
      generation++;
      timer = runtime.clock.every(intervalMs, () => { void refresh(); });
      void refresh(false);
    },
  };
}
