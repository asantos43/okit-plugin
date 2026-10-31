// The reading of a status bar sample. The collector writes the JSON the client
// sent as it came; the core is the one that reads the percentages out of it.
// Nothing here writes and nothing here reads a file: a stored sample that is
// not a sample is no reading, never an exception.

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const plain = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The instant of a stored sample, or the oldest one there is: a text that is not a date is not a date. */
function stamp(text) {
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : -Infinity;
}

/**
 * The reading with the later instant of the two; one with no instant is the
 * oldest there is, so the other one wins.
 *
 * @param {object|null} first
 * @param {object|null} second
 * @returns {object|null}
 */
export function newerReading(first, second) {
  if (first === null) return second;
  if (second === null) return first;
  return stamp(second.recordedAt) > stamp(first.recordedAt) ? second : first;
}

/**
 * The reading of a stored sample, or `null` when the stored bytes hold none.
 *
 * The stored sample is `{ receivedAt, input }`: `receivedAt` is the instant the
 * collector wrote it and `input` is the client's own JSON. A window is a window
 * of the configuration whose used percentage is a number between 0 and 100 and
 * whose reset is a date; the tightest of them is the reading.
 *
 * @param {object} stored the file the collector wrote
 * @param {object} settings the `statuslineCollector` settings of the root
 * @returns {object|null} the reading, or `null` when there is none
 */
export function readingOf(stored, settings) {
  if (!plain(stored) || !plain(settings)) return null;
  const recordedAt = stored.receivedAt;
  if (typeof recordedAt !== 'string' || !Number.isFinite(Date.parse(recordedAt))) return null;
  if (!plain(stored.input) || !plain(settings.fields) || !plain(settings.windows)) return null;
  const fields = settings.fields;
  const limits = stored.input[fields.rateLimits];
  if (!plain(limits)) return null;
  const windows = Object.entries(settings.windows).flatMap(([key, windowMinutes]) => {
    const value = limits[key];
    const used = value?.[fields.usedPercentage];
    const reset = value?.[fields.resetsAt];
    if (!finite(used) || used < 0 || used > 100 || !finite(reset)
      || !Number.isFinite(new Date(reset * 1000).getTime())) return [];
    return [{ windowMinutes, remainingPct: 100 - used,
      resetsAt: new Date(reset * 1000).toISOString() }];
  });
  if (!windows.length) return null;
  const tightest = windows.reduce((a, b) => a.remainingPct <= b.remainingPct ? a : b);
  return { remainingPct: tightest.remainingPct, windowMinutes: tightest.windowMinutes,
    windows, recordedAt, source: 'automatic' };
}
