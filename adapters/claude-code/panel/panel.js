import { elapsed, localTimestamps, quotaRows, quotaTone } from './formatters.js';
import { frameLines, wrapText } from './frame.js';

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
    ...Object.fromEntries(['actor', 'model', 'effort', 'status', 'account', 'last_progress', 'started_at', 'demand', 'finish_reason'].map(key =>
      [key, typeof run[key] === 'string' ? run[key] : null])),
  }));
  value.skipped_runs = value.runs.length - runs.length;
  value.runs = runs;
  return { ok: true, state: value };
}
/** @param {any} value */
function validState(value) {
  return value.client === 'claude' && typeof value.readiness === 'string' &&
    (value.panel === undefined || (record(value.panel) &&
      (value.panel.autoOpen === undefined || typeof value.panel.autoOpen === 'boolean') &&
      (value.panel.color === undefined || typeof value.panel.color === 'boolean'))) &&
    Array.isArray(value.warnings) && value.warnings.every(/** @param {unknown} w */ w => typeof w === 'string') &&
    Array.isArray(value.accounts) && value.accounts.every(/** @param {any} a */ a => record(a) &&
      typeof a.id === 'string' && typeof a.label === 'string' && record(a.quota) &&
      quota(a.quota.session) && quota(a.quota.weekly)) &&
    Array.isArray(value.runs) && (value.launchable === undefined || (Array.isArray(value.launchable) &&
      value.launchable.every(/** @param {any} entry */ entry => record(entry) &&
        typeof entry.account === 'string' && typeof entry.can_launch === 'boolean' &&
        (entry.actor_classes === undefined || (Array.isArray(entry.actor_classes) &&
          entry.actor_classes.every(/** @param {unknown} name */ name => typeof name === 'string'))))));
}
/** @param {any} r */
function readableRun(r) {
  return record(r);
}

/** @param {import('./types.js').Result} result @param {number} width @param {number} [now] @param {string} [timeZone] */
export function boardLines(result, width, now = Date.now(), timeZone) {
  const w = Number.isFinite(width) ? Math.max(1, Math.min(240, Math.floor(width))) : 80;
  return viewModel(result, now, timeZone).flatMap((block, index) => result.ok && index === 0
    ? wrapText(block.title, w) : frameLines(block.title, block.rows, w));
}

/** Parallel metadata for boardLines; frames and non-quota rows have no tone.
 * @param {import('./types.js').Result} result @param {number} width @param {number} [now] @param {string} [timeZone] */
export function boardTones(result, width, now = Date.now(), timeZone) {
  const w = Number.isFinite(width) ? Math.max(1, Math.min(240, Math.floor(width))) : 80;
  const tones = result.ok ? result.state.accounts.flatMap(account =>
    [undefined, quotaTone(account.quota.session?.remaining_pct ?? null), quotaTone(account.quota.weekly?.remaining_pct ?? null)]) : [];
  return viewModel(result, now, timeZone).flatMap((block, index) => {
    if (result.ok && index === 0) return wrapText(block.title, w).map(() => undefined);
    const rows = block.rows.flatMap((row, rowIndex) => wrapText(row, w < 40 ? w : w - 4)
      .map(() => result.ok && index === 1 ? tones[rowIndex] : undefined));
    return w < 40 ? [undefined, ...rows] : [undefined, ...rows, undefined];
  });
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

/** @param {import('./types.js').Result} result @param {number} [now] @param {string} [timeZone] */
export function viewModel(result, now = Date.now(), timeZone) {
  if (!result.ok) return [{ title: 'okit plugin', rows: [result.error] }];
  const { state } = result;
  const labels = new Map(state.accounts.map(account => [account.id, account.label]));
  /** @param {string | null} id */
  const accountName = id => labels.get(id ?? '') ?? 'unknown account';
  const quotas = quotaRows(state.accounts, now, timeZone);
  const accounts = state.accounts.flatMap((account, index) => [
    `${account.label} · ${state.runs.some(run => run.account === account.id && run.status === 'live' && !run.stale) ? 'running' : 'idle'}`,
    quotas[index * 2], quotas[index * 2 + 1],
  ]);
  const newest = [...state.runs].sort((a, b) =>
    (Date.parse(b.started_at ?? '') || 0) - (Date.parse(a.started_at ?? '') || 0));
  /** @param {import('./types.js').Run} run */
  const live = run => run.status === 'live' && !run.stale;
  /** @param {import('./types.js').Run[]} runs @param {boolean} running */
  const runRows = (runs, running) => [
    ...runs.slice(0, 20).flatMap(run => [
      `${run.id}: ${run.status ?? 'unknown'}${run.stale ? ' · stale' : ''}` +
      `${run.demand ? ` · demand ${run.demand}` : ''} · account ${accountName(run.account)}` +
      (running ? ` · actor ${run.actor ?? '-'} · ${run.model ?? '-'} · effort ${run.effort ?? '-'}` : '') +
      ` · elapsed ${elapsed(run.elapsed_seconds)}` +
      (!running && run.finish_reason ? ` · ${run.finish_reason}` : ''),
      ...(running ? [`Last progress: ${run.last_progress ?? 'unknown'}`] : []),
    ]),
    ...(runs.length > 20 ? [`… ${runs.length - 20} more runs`] : []),
  ];
  const launchable = ['simple', 'normal', 'hard', 'critic'].map(actor => {
    const names = (state.launchable ?? []).filter(entry => entry.can_launch === true &&
      Array.isArray(entry.actor_classes) && entry.actor_classes.includes(actor))
      .map(entry => accountName(entry.account));
    return `${actor}: ${[...new Set(names)].join(', ') || 'none'}`;
  });
  const ready = /^Ready to launch executors: yes(?:[;. ]|$)/.test(state.readiness);
  return [{ title: `okit plugin · claude · ${state.accounts.length} accounts · ready: ${ready ? 'yes' : 'no'}`, rows: [] },
  { title: 'ACCOUNTS', rows: accounts.length ? accounts : ['No accounts.'] },
  { title: 'RUNNING', rows: newest.some(live) ? runRows(newest.filter(live), true) : ['No live runs.'] },
  { title: 'RECENT', rows: newest.some(run => !live(run)) ? runRows(newest.filter(run => !live(run)), false) : ['No recent runs.'] },
  { title: 'LAUNCHABLE NOW', rows: launchable },
  { title: 'Readiness', rows: [state.readiness,
    ...(state.runs.length || state.skipped_runs ? [] : ['No runs.']),
    ...(state.skipped_runs ? [`${state.skipped_runs} ${state.skipped_runs === 1 ? 'run' : 'runs'} skipped (unreadable)`] : []),
    ...state.warnings.map(warning => `Warning: ${warning}`)] }]
    .map(block => ({ ...block, rows: block.rows.map(row => localTimestamps(row, now, timeZone)) }));
}
