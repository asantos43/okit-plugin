// Fields of quota/<client>.json, read by the three client adapters. The file is the
// person's: whatever valid JSON it holds, a field of the wrong type is no value, never an
// exception (test/input-inventory.test.js, "the quota file of a client").

/** A finite number, or `null`: an absent reading is never turned into a zero. */
export function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The time as text and as milliseconds, or `null` when the value is not text that is a date. */
export function timeOf(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? { text: value, ms } : null;
}

/**
 * The windows of an automatic reading: only the plain objects, with only the fields the
 * table reads, each of the right type. Anything else is dropped.
 *
 * @param {unknown} value
 * @returns {object[]}
 */
export function windowsOf(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const window of value) {
    if (typeof window !== 'object' || window === null || Array.isArray(window)) continue;
    const entry = {};
    for (const key of ['remainingPct', 'windowMinutes', 'minutes', 'resetsInMinutes']) {
      const number = finiteNumber(window[key]);
      if (number !== null) entry[key] = number;
    }
    if (timeOf(window.resetsAt)) entry.resetsAt = window.resetsAt;
    out.push(entry);
  }
  return out;
}
