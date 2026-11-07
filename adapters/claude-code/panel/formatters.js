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
  if (total >= 86400) return `${Math.floor(total / 86400)}d ${Math.floor(total % 86400 / 3600)}h`;
  return `${Math.floor(total / 3600)}h${String(Math.floor(total % 3600 / 60)).padStart(2, '0')}m`;
}
/** @param {number} timestamp @param {number} now @param {string} [timeZone] */
export function localTime(timestamp, now, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', ...(timestamp - now > 86400000 ? { weekday: 'short' } : {}) })
    .format(timestamp).replace(',', '');
}
/** @param {import('./types.js').Quota | null} window @param {number} now @param {string} [timeZone] */
export function quotaColumns(window, now, timeZone) {
  if (window === null) return [' ', ' '.repeat(12), 'unknown', ''];
  const pct = Math.round(Math.max(0, Math.min(100, window.remaining_pct)));
  const filled = Math.round(Math.max(0, Math.min(100, pct)) / 10);
  const reset = window.resets_at === null ? NaN : Date.parse(window.resets_at);
  return [window.remaining_pct < 20 ? '!' : ' ', `[${'█'.repeat(filled)}${'░'.repeat(10 - filled)}]`, `${pct}% left`,
    Number.isFinite(reset) ? `resets ${localTime(reset, now, timeZone)} (${reset < now ? 'passed' : `in ${formatHm((reset - now) / 1000)}`})`
      : 'reset unknown'];
}
/** @param {import('./types.js').Quota | null} window @param {number} now @param {string} [timeZone] */
export function quotaBar(window, now, timeZone) {
  if (window === null) return 'unknown';
  return quotaColumns(window, now, timeZone).join(' ').trim();
}
/** Align columns over every account, including unknown windows.
 * @param {import('./types.js').Account[]} accounts @param {number} now @param {string} [timeZone] */
export function quotaRows(accounts, now, timeZone) {
  const rows = accounts.flatMap(account => [['session 5h', account.quota.session], ['week', account.quota.weekly]]
    .map(([label, window]) => {
      const [marker, bar, left, reset] = quotaColumns(/** @type {import('./types.js').Quota | null} */ (window), now, timeZone);
      return [marker, String(label), bar, left, reset];
    }));
  const widths = [0, 1, 2, 3].map(column => Math.max(0, ...rows.map(row => row[column].length)));
  return rows.map(row => row.map((cell, index) => index < 4 ? cell.padEnd(widths[index]) : cell).join(' ').trimEnd());
}
/** @param {string} text @param {number} now @param {string} [timeZone] */
export function localTimestamps(text, now, timeZone) {
  return text.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)/g,
    value => Number.isFinite(Date.parse(value)) ? localTime(Date.parse(value), now, timeZone) : value);
}
