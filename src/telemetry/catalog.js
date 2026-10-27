import { createHash } from 'node:crypto';

export const CATALOG = Object.freeze({
  'demand.status': ['pending', 'delegated', 'criticised', 'consolidated', 'failed'],
  'profile.choice': [], 'role.choice': ['Director', 'Executor', 'Critic'],
  'smoke.report': ['pass', 'partial', 'refused', 'failed'],
  'quota.check': ['green', 'yellow', 'red', 'off', 'unknown'],
  'daemon.tick': ['running', 'stopped', 'paused'],
});
export const privateField = key => !['count', 'durationMs', 'state', 'client', 'model', 'effort', 'role'].includes(key);
export const projectHash = project => createHash('sha256').update(String(project)).digest('hex');

// Unknown keys and nested objects are refused, rather than recursively copied.
export function redact(event, fields = {}) {
  if (!Object.hasOwn(CATALOG, event)) return null;
  const safe = {};
  for (const [key, value] of Object.entries(fields)) {
    if (privateField(key)) continue;
    if (['count', 'durationMs'].includes(key)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) safe[key] = value;
    } else if (key === 'state') {
      if (CATALOG[event].includes(value)) safe[key] = value;
    } else if (typeof value === 'string' && /^[a-zA-Z0-9_.:+-]+(?:\/[a-zA-Z0-9_.:+-]+)?$/.test(value)
      && !value.includes('..')) safe[key] = value;
  }
  return safe;
}
