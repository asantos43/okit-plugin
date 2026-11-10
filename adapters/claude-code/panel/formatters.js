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
/** @param {number | null} percent @returns {'ok' | 'warn' | 'low' | 'dim'} */
export function quotaTone(percent) {
  return percent === null ? 'dim' : percent >= 50 ? 'ok' : percent >= 20 ? 'warn' : 'low';
}
const BAR_CELLS = 10;
/** One quota window as display parts. The bar uses thin line characters (not solid blocks).
 * @param {import('./types.js').Quota | null} window @param {number} now @param {string} [timeZone] */
export function quotaParts(window, now, timeZone) {
  if (window === null) return { marker: ' ', filled: '', empty: '─'.repeat(BAR_CELLS), pct: 'unknown', tone: /** @type {'ok' | 'warn' | 'low' | 'dim'} */ ('dim'), reset: '' };
  const pct = Math.round(Math.max(0, Math.min(100, window.remaining_pct)));
  const filled = Math.round(pct / 10);
  const reset = window.resets_at === null ? NaN : Date.parse(window.resets_at);
  const tone = quotaTone(window.remaining_pct);
  return { marker: tone === 'low' ? '!' : ' ', filled: '━'.repeat(filled), empty: '─'.repeat(BAR_CELLS - filled), pct: `${pct}%`, tone,
    reset: Number.isFinite(reset) ? `resets ${localTime(reset, now, timeZone)} (${reset < now ? 'passed' : `in ${formatHm((reset - now) / 1000)}`})`
      : 'reset unknown' };
}
/** @param {import('./types.js').Quota | null} window @param {number} now @param {string} [timeZone] */
export function quotaColumns(window, now, timeZone) {
  const part = quotaParts(window, now, timeZone);
  return [part.marker, part.filled + part.empty, part.pct, part.reset];
}
/** @param {import('./types.js').Quota | null} window @param {number} now @param {string} [timeZone] */
export function quotaBar(window, now, timeZone) {
  if (window === null) return 'unknown';
  return quotaColumns(window, now, timeZone).join(' ').trim();
}
/** Segment lines (two per account, session then week) with columns aligned over every account.
 * Only the percentage and the filled bar carry the band's tone; labels and resets stay plain or dim.
 * @param {import('./types.js').Account[]} accounts @param {number} now @param {string} [timeZone]
 * @returns {import('./types.js').Segment[][]} */
export function quotaLines(accounts, now, timeZone) {
  const rows = accounts.flatMap(account => [['5h', account.quota.session], ['week', account.quota.weekly]]
    .map(([label, window]) => ({ label: String(label), ...quotaParts(/** @type {import('./types.js').Quota | null} */ (window), now, timeZone) })));
  const labelWidth = Math.max(0, ...rows.map(row => row.label.length));
  const pctWidth = Math.max(0, ...rows.filter(row => row.reset).map(row => row.pct.length));
  return rows.map(row => [
    { text: `${row.marker} ${row.label.padEnd(labelWidth)}  ` },
    ...(row.filled ? [{ text: row.filled, tone: row.tone }] : []),
    { text: row.empty, tone: /** @type {'dim'} */ ('dim') },
    ...(row.reset ? [{ text: '  ' }, { text: row.pct.padEnd(pctWidth), tone: row.tone }, { text: '  ' }, { text: row.reset, tone: /** @type {'dim'} */ ('dim') }]
      : [{ text: '  ' }, { text: row.pct, tone: row.tone }]),
  ]);
}
/** Plain text of quotaLines. @param {import('./types.js').Account[]} accounts @param {number} now @param {string} [timeZone] */
export function quotaRows(accounts, now, timeZone) {
  return quotaLines(accounts, now, timeZone).map(line => line.map(segment => segment.text).join(''));
}
/** @param {string} text @param {number} now @param {string} [timeZone] */
export function localTimestamps(text, now, timeZone) {
  return text.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)/g,
    value => Number.isFinite(Date.parse(value)) ? localTime(Date.parse(value), now, timeZone) : value);
}
