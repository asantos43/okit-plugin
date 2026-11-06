import { elapsed, quotaBar } from './formatters.js';

export const COMMAND = Object.freeze(['okit-plugin', 'panel-state', '--json', '--client', 'claude']);
export const PROCESS_OPTIONS = Object.freeze({ timeoutMs: 5000, maxOutputBytes: 1024 * 1024 });
/** @param {unknown} value @returns {boolean} */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** @param {unknown} value */
const nullableText = value => value === null || typeof value === 'string';
/** @param {any} value */
const quota = value => value === null || (record(value) && Number.isFinite(value.remaining_pct) &&
  nullableText(value.resets_at));

// The generic parse-to-result and failed-command patterns come from hooks/panel.ts (3451493).
/** @param {string} stdout @returns {import('./types.js').Result} */
export function parseState(stdout) {
  if (new TextEncoder().encode(stdout).length > PROCESS_OPTIONS.maxOutputBytes)
    return { ok: false, error: 'State unavailable: output too large.' };
  let value;
  try { value = JSON.parse(stdout); }
  catch { return { ok: false, error: 'State unavailable: invalid JSON.' }; }
  if (!record(value)) return { ok: false, error: 'State unavailable: invalid document.' };
  if (value.schema_version !== 1) return { ok: false, error: 'State unavailable: unsupported schema version.' };
  if (!validState(value)) return { ok: false, error: 'State unavailable: invalid Claude state.' };
  const runs = value.runs.filter(readableRun).map(/** @param {any} run */ run => ({ ...run,
    id: typeof run.id === 'string' ? run.id : 'unknown',
    stale: run.stale === true,
    elapsed_seconds: Number.isFinite(run.elapsed_seconds) && run.elapsed_seconds >= 0 ? run.elapsed_seconds : null,
    ...Object.fromEntries(['actor', 'model', 'effort', 'status', 'account', 'last_progress', 'started_at'].map(key =>
      [key, typeof run[key] === 'string' ? run[key] : null])),
  }));
  value.skipped_runs = value.runs.length - runs.length;
  value.runs = runs;
  return { ok: true, state: value };
}
/** @param {any} value */
function validState(value) {
  return value.client === 'claude' && typeof value.readiness === 'string' &&
    Array.isArray(value.warnings) && value.warnings.every(/** @param {unknown} w */ w => typeof w === 'string') &&
    Array.isArray(value.accounts) && value.accounts.every(/** @param {any} a */ a => record(a) &&
      typeof a.id === 'string' && typeof a.label === 'string' && record(a.quota) &&
      quota(a.quota.session) && quota(a.quota.weekly)) &&
    Array.isArray(value.runs);
}
/** @param {any} r */
function readableRun(r) {
  return record(r);
}

/** @param {import('./types.js').Runner} run @returns {Promise<import('./types.js').Result>} */
export async function loadState(run) {
  try {
    const result = await run([...COMMAND], { ...PROCESS_OPTIONS });
    if (result.exitCode !== 0) return { ok: false, error: `State unavailable: command exited ${result.exitCode}.` };
    return parseState(result.stdout);
  } catch {
    return { ok: false, error: 'State unavailable: command missing, unreadable or timed out.' };
  }
}

/** @param {import('./types.js').Result} result @param {number} [now] */
export function viewModel(result, now = Date.now()) {
  if (!result.ok) return [{ title: 'okit plugin', rows: [result.error] }];
  const { state } = result;
  const groups = new Map(state.accounts.map(account => [account.id, {
    title: `${account.label} (${account.id})`,
    rows: [`Session 5 h: ${quotaBar(account.quota.session, now)}`,
      `Weekly: ${quotaBar(account.quota.weekly, now)}`],
  }]));
  const counts = new Map();
  const newest = [...state.runs].sort((a, b) =>
    (Date.parse(b.started_at ?? '') || 0) - (Date.parse(a.started_at ?? '') || 0));
  for (const run of newest) {
    const id = run.account ?? 'default';
    const group = groups.get(id) ?? { title: id, rows: ['Account details unavailable.'] };
    groups.set(id, group);
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    if (count > 20) continue;
    group.rows.push(`${run.id}: ${run.status ?? 'unknown'}${run.stale ? ' · stale' : ''}` +
      ` · actor ${run.actor ?? '-'} · ${run.model ?? '-'} · effort ${run.effort ?? '-'}` +
      ` · elapsed ${elapsed(run.elapsed_seconds)}`);
    group.rows.push(`Last progress: ${run.last_progress ?? 'unknown'}`);
  }
  for (const [id, count] of counts) {
    if (count > 20) groups.get(id)?.rows.push(`… ${count - 20} more runs`);
  }
  return [{ title: 'okit plugin', rows: [state.readiness,
    ...(state.accounts.length ? [] : ['No accounts.']),
    ...(state.runs.length || state.skipped_runs ? [] : ['No runs.']),
    ...(state.skipped_runs ? [`${state.skipped_runs} ${state.skipped_runs === 1 ? 'run' : 'runs'} skipped (unreadable)`] : []),
    ...state.warnings.map(warning => `Warning: ${warning}`)] }, ...groups.values()];
}
