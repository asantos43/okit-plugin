// Adapted from task-board/hooks/logic.ts elapsed, formatHm and barRows (3451493).
/** @param {number | null} seconds */
export function elapsed(seconds) {
  if (seconds === null || !Number.isFinite(seconds)) return 'unknown';
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
/** @param {number} seconds */
export function formatHm(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  if (total >= 172800) return `${Math.floor(total / 86400)}d${Math.floor(total % 86400 / 3600)}h`;
  return `${Math.floor(total / 3600)}h${String(Math.floor(total % 3600 / 60)).padStart(2, '0')}m`;
}
/** @param {import('./types.js').Quota | null} window @param {number} now */
export function quotaBar(window, now) {
  if (window === null) return 'unknown';
  const pct = Math.round(Math.max(0, Math.min(100, window.remaining_pct)));
  const filled = Math.round(Math.max(0, Math.min(100, pct)) / 10);
  const reset = window.resets_at === null ? NaN : Date.parse(window.resets_at);
  return `[${'█'.repeat(filled)}${'░'.repeat(10 - filled)}] ${pct}%` +
    (Number.isFinite(reset) ? ` left · resets ${new Date(reset).toISOString()} (${reset < now ? 'passed' : `in ${formatHm((reset - now) / 1000)}`})`
      : ' left · reset unknown');
}
