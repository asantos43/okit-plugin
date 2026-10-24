// The daemon core: one pass that opens the due template children and hands the
// pending demands to an injected spawner, inside the concurrency cap. The core
// starts nothing itself: `spawn` is a parameter, so a test drives it and an
// adapter drives it for real.

import { appendFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { classify } from './classify.js';
import { demandRef, projectName, withDemandRef } from './demand-ref.js';
import { inboxList, inboxSetExt, inboxSetStatus } from './inbox.js';
import { acquireSlot, releaseSlot } from './limits.js';
import { DEFAULT_CONFIG, profilePick } from './profiles.js';
import { orderPurge } from './orders.js';
import { readJson, withLock, writeJsonAtomic } from './state.js';
import { statusTable } from './status.js';
import { paths } from './store.js';
import { openDue } from './templates.js';

const DEFAULT_DAEMON = {
  intervalSeconds: 60,
  minQuotaPct: 10,
  logKeepDays: 14,
};

const KILL_SWITCH = 'kill switch';
const LOW_QUOTA = 'quota below the minimum';
const PAUSED = 'paused';
const BUSY = 'the concurrency cap is full';

const DEFAULT_CLIENT = 'unknown';
// One attempt, and no poll: a second daemon on the same root is a mistake, not a
// queue, so it has to say who holds the lock instead of waiting for it. `0` is
// that case in `withLock` — the lock is still created and still taken over when
// its owner is dead, but a live owner is reported on the first try. Waiting would
// make the refusal as slow as the disk is, since every poll costs two calls.
const LOCK_TIMEOUT_MS = 0;
const STOP_FILE = 'daemon.stop';
const PAUSE_FILE = 'daemon.paused';
const PID_FILE = 'daemon.pid.json';
const LOCK_BASE = 'daemon';
const RUN_PREFIX = 'd-';
const LIVE_STATUSES = ['delegated', 'criticised'];

const stopFile = (root) => join(root, STOP_FILE);
const pauseFile = (root) => join(root, PAUSE_FILE);
const pidFile = (root) => join(root, PID_FILE);
const lockBase = (root) => join(root, LOCK_BASE);

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Positive number or the default, so a broken config never stops the loop. */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function daemonSettings(config) {
  const merged = { ...DEFAULT_CONFIG, ...(config ?? {}) };
  const daemon = { ...DEFAULT_DAEMON, ...(merged.daemon ?? {}) };
  return {
    intervalSeconds: Math.max(1, numberOr(daemon.intervalSeconds, DEFAULT_DAEMON.intervalSeconds)),
    minQuotaPct: numberOr(daemon.minQuotaPct, DEFAULT_DAEMON.minQuotaPct),
    logKeepDays: Math.max(1, numberOr(daemon.logKeepDays, DEFAULT_DAEMON.logKeepDays)),
    maxTurns: numberOr(daemon.maxTurns, undefined),
    maxMinutes: numberOr(daemon.maxMinutes, undefined),
    limits: { ...DEFAULT_CONFIG.limits, ...(merged.limits ?? {}) },
    config: merged,
  };
}

async function loadSettings(root) {
  return daemonSettings(await readJson(paths(root).config, {}));
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const logFile = (root, ms) => join(paths(root).logs, `${dayOf(ms)}.jsonl`);

// One decision record per pass, appended as a single line so a reader can tail
// the file and always see a whole pass.
async function appendDecision(root, record) {
  const file = logFile(root, Date.parse(record.at));
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
  return file;
}

// The clients this pass knows about are the clients of its pending demands, so
// a demand nobody claims never blocks the pass on a quota reading.
function clientsOf(items) {
  const clients = new Set();
  for (const item of items) clients.add(item.client ?? DEFAULT_CLIENT);
  return [...clients];
}

// A reading is `{remainingPct}` or null; `profilePick` wants a source with it.
function quotaOf(reading) {
  if (!reading || typeof reading.remainingPct !== 'number') return { source: 'off' };
  return { source: 'api', remainingPct: reading.remainingPct };
}

async function readQuota(deps, client, cache) {
  if (!cache.has(client)) {
    cache.set(client, typeof deps.quota === 'function' ? await deps.quota(client) : null);
  }
  return cache.get(client);
}

async function readIdle(deps, client, cache) {
  if (!cache.has(client)) {
    cache.set(client, typeof deps.idle === 'function' ? await deps.idle(client) : true);
  }
  return cache.get(client);
}

// The floor is a pass condition: below it on every known client, nothing is
// opened and nothing is spawned. A client with no reading is not below it, so
// an unmeasured client never paralyzes the daemon.
async function quotaStopReason(deps, clients, minQuotaPct, cache) {
  if (clients.length === 0) return null;
  const below = [];
  for (const client of clients) {
    const reading = await readQuota(deps, client, cache);
    if (typeof reading?.remainingPct === 'number' && reading.remainingPct < minQuotaPct) {
      below.push(`${client} at ${reading.remainingPct}%`);
    }
  }
  if (below.length !== clients.length) return null;
  return `${LOW_QUOTA} of ${minQuotaPct}%: ${below.join(', ')}`;
}

/** The period a demand belongs to: the template slot that opened it. */
function periodOf(item) {
  const template = item.ext?.template;
  return template ? `${template}@${item.ext?.period ?? ''}` : item.id;
}

// A period serves one run at a time: while a sibling of the same template and
// period is still delegated, the others wait instead of stacking up.
function liveHolders(items) {
  const held = new Set();
  for (const item of items) {
    if (LIVE_STATUSES.includes(item.status)) held.add(periodOf(item));
  }
  return held;
}

const newRunId = () => `${RUN_PREFIX}${randomBytes(4).toString('hex')}`;

// The slot is taken before the spawner runs, so the cap cannot be crossed, and
// given back when the spawner fails, so a refusal costs nothing.
async function delegate(root, item, deps, settings, cache) {
  const client = item.client ?? DEFAULT_CLIENT;
  const effort = item.effort ?? classify(item).effort;
  const quota = quotaOf(await readQuota(deps, client, cache));
  const profile = profilePick({ client, effort, quota, config: settings.config });
  const runId = newRunId();

  const slot = await acquireSlot(root, runId, { client, config: settings.config });
  if (!slot.ok) return { skip: slot.reason ?? BUSY };

  let spawned;
  try {
    spawned = await deps.spawn(item, {
      client,
      profile,
      limits: settings.limits,
      maxTurns: settings.maxTurns,
      maxMinutes: settings.maxMinutes,
      runId,
    });
  } catch (error) {
    await releaseSlot(root, runId);
    return { skip: `the spawner failed: ${error.message}` };
  }
  const returned = spawned?.runId ?? runId;
  if (returned === runId) return { runId };
  return { runId: await relinkSlot(root, runId, returned, client, settings.config) };
}

/**
 * A spawner that returned a run id of its own must be the id the slot is held
 * under, or the core counts a run nobody can see. The slot is given up first,
 * so the cap always leaves room for the id that is actually in use. When that
 * id cannot be taken the original is taken again: a slot that lags the run id
 * is better than a run outside the cap, and neither throws.
 *
 * @returns {Promise<string>} the id the slot is held under
 */
async function relinkSlot(root, from, to, client, config) {
  try {
    await releaseSlot(root, from);
    const taken = await acquireSlot(root, to, { client, config });
    if (taken.ok) return to;
    await acquireSlot(root, from, { client, config });
    return from;
  } catch {
    return from;
  }
}

/**
 * One pass over the state root: the stop conditions, the due templates and the
 * pending demands, in that order. Returns the decision record `{at, opened,
 * spawned, skipped, purged, stopped?}` and appends it as one JSON line to
 * `logs/<date>.jsonl`.
 *
 * `deps` carries everything the core cannot know: `now()`, `quota(client)`,
 * `idle(client)` and `spawn(demand, {client, profile, limits, maxTurns,
 * maxMinutes, runId})`. A spawner should keep the `runId` it is given: that is
 * the slot already reserved for the run, so returning the same id is the cheap
 * path, and returning another one moves the slot to that id. The daemon never
 * refuses a demand on its own: a demand is skipped only for a technical bound
 * (paused, kill switch, quota floor, the concurrency cap) or a spawner failure,
 * and every skip says which.
 *
 * @param {string} root state root
 * @param {{now?: () => number, quota?: Function, idle?: Function, spawn: Function}} deps
 * @returns {Promise<{at: string, opened: string[], spawned: object[], skipped: object[], purged?: number, stopped?: string, paused?: boolean}>}
 */
export async function tick(root, deps = {}) {
  const at = typeof deps.now === 'function' ? deps.now() : Date.now();
  const stamp = new Date(at).toISOString();
  const settings = await loadSettings(root);
  const record = { at: stamp, opened: [], spawned: [], skipped: [] };
  const cache = new Map();

  const finish = async () => {
    const name = await projectName(root);
    const items = await inboxList(root);
    const names = new Map(items.map((item) => [item.id, withDemandRef(item, name).ref]));
    record.openedRefs = record.opened.map((id) => names.get(id) ?? demandRef(id, name));
    for (const entry of [...record.spawned, ...record.skipped]) {
      if (names.has(entry.id)) entry.ref = names.get(entry.id);
    }
    await appendDecision(root, record);
    return record;
  };

  if (await exists(pauseFile(root))) {
    record.paused = true;
    record.skipped.push({ id: 'daemon', reason: PAUSED });
    return finish();
  }
  if (await exists(stopFile(root))) {
    record.stopped = KILL_SWITCH;
    record.skipped.push({ id: 'daemon', reason: `${KILL_SWITCH}: ${stopFile(root)} exists` });
    return finish();
  }

  // Housekeeping comes after the two switches, so a paused or stopped daemon
  // leaves the orders alone, and before the pass asks for anything: an inactive
  // order past its retention is dropped whatever the quota says, and the line
  // says how many went.
  record.purged = (await orderPurge(root, { now: at })).length;

  const pending = await inboxList(root, { status: 'pending' });
  const clients = clientsOf(pending);
  const stop = await quotaStopReason(deps, clients, settings.minQuotaPct, cache);
  if (stop !== null) {
    record.stopped = stop;
    record.skipped.push({ id: 'daemon', reason: stop });
    return finish();
  }

  // The template engine asks one instant-wide question, so the pass reports the
  // worst reading it knows: the lowest quota and the least idle of its clients.
  const readings = await Promise.all(clients.map((client) => readQuota(deps, client, cache)));
  const percentages = readings.map((r) => r?.remainingPct).filter((p) => typeof p === 'number');
  const idles = await Promise.all(clients.map((client) => readIdle(deps, client, cache)));
  const opened = await openDue(root, at, {
    quotaPct: percentages.length === 0 ? null : Math.min(...percentages),
    idle: clients.length === 0 ? true : idles.every(Boolean),
  });
  record.opened = opened.ids;

  // The inbox lists newest first, but a queue is served oldest first, so a
  // demand that waits behind newer ones never starves.
  const live = liveHolders(await inboxList(root));
  const queue = (await inboxList(root, { status: 'pending' })).reverse();
  for (const item of queue) {
    if (live.has(periodOf(item))) {
      record.skipped.push({ id: item.id, reason: 'a live child already holds this period' });
      continue;
    }
    const outcome = await delegate(root, item, deps, settings, cache)
      .catch((error) => ({ skip: `the demand could not be prepared: ${error.message}` }));
    if (outcome.skip !== undefined) {
      record.skipped.push({ id: item.id, reason: outcome.skip });
      continue;
    }
    live.add(periodOf(item));
    await inboxSetExt(root, item.id, { runId: outcome.runId, delegatedAt: stamp });
    await inboxSetStatus(root, item.id, 'delegated');
    record.spawned.push({ id: item.id, client: item.client ?? DEFAULT_CLIENT, runId: outcome.runId });
  }

  return finish();
}

const defaultSleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

// An injected sleep is never interrupted, so the abort races it: the loop
// leaves on the signal and the pending timer is dropped with the listener.
async function pause(ms, signal, sleep) {
  if (signal?.aborted) return false;
  let onAbort = null;
  const asleep = sleep(ms).then(() => true);
  const aborted = signal ? new Promise((resolve) => {
    onAbort = () => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });
  }) : null;

  try {
    return await (aborted ? Promise.race([asleep, aborted]) : asleep);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * The loop: takes the daemon lock, writes `daemon.pid.json`, ticks every
 * `daemon.intervalSeconds` and rotates the logs once a day. It leaves on the
 * kill switch or on `signal.abort()`, and removes its pid file on the way out.
 *
 * The interval is paced on a monotonic clock, so a wall-clock jump forwards or
 * backwards moves neither the number of passes nor the per-period idempotency.
 *
 * @param {string} root state root
 * @param {object} deps the same dependencies `tick` takes
 * @param {{signal?: AbortSignal, sleep?: (ms: number) => Promise<void>}} [options]
 * @returns {Promise<object>} the number of passes run
 * @throws when another daemon already holds the lock on this root
 */
export async function daemonRun(root, deps = {}, options = {}) {
  const { signal } = options;
  const sleep = options.sleep ?? defaultSleep;
  const settings = await loadSettings(root);
  const intervalMs = settings.intervalSeconds * 1000;

  return withLock(lockBase(root), async () => {
    await writeJsonAtomic(pidFile(root), { pid: process.pid, startedAt: Date.now() });
    const origin = process.hrtime.bigint();
    let rotated = dayOf(typeof deps.now === 'function' ? deps.now() : Date.now());
    let passes = 0;

    try {
      for (let index = 0; !signal?.aborted; index += 1) {
        const record = await tick(root, deps);
        passes += 1;
        const day = dayOf(typeof deps.now === 'function' ? deps.now() : Date.now());
        if (day !== rotated) {
          rotated = day;
          await rotateLogs(root, settings.logKeepDays, Date.now());
        }
        if (record.stopped === KILL_SWITCH) break;
        const due = origin + BigInt(index + 1) * BigInt(intervalMs) * 1_000_000n;
        const waited = Number((due - process.hrtime.bigint()) / 1_000_000n);
        if (!await pause(Math.max(0, waited), signal, sleep)) break;
      }
    } finally {
      await rm(pidFile(root), { force: true });
    }
    return { passes };
  }, { timeoutMs: LOCK_TIMEOUT_MS });
}

// A pid file survives a crash, so the pid itself is the evidence: ESRCH means
// the process is gone and only that is treated as not running.
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

// The stale test is the only one the pid file cannot answer alone: a pid file
// written by a clock ahead of ours says nothing about a process we can see.
const isStale = (startedAt) => typeof startedAt !== 'number' || startedAt - Date.now() > 60_000;

/** The last decision record of today's log, or null when there is none. */
async function readLastTick(root, now = Date.now()) {
  let text;
  try {
    text = await readFile(logFile(root, now), 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

/**
 * Reports the daemon of one state root: whether it is running, its pid, when it
 * started, whether it is paused and the last decision record. `running` needs
 * a live pid and a pid file that is not stale, so a crashed daemon reads as
 * stopped even while its pid file is still on disk.
 *
 * @param {string} root state root
 * @param {{now?: number, table?: object}} [options] the clock that names today's
 *   log file, and the `statusTable` deps of a table the caller asked for
 * @returns {Promise<{running: boolean, pid: number|null, startedAt: string|null, paused: boolean, lastTick: object|null, table?: object}>}
 */
export async function daemonStatus(root, options = {}) {
  const owner = await readJson(pidFile(root), null);
  const paused = await exists(pauseFile(root));
  const lastTick = await readLastTick(root, options.now ?? Date.now());
  const startedAt = typeof owner?.startedAt === 'number' ? owner.startedAt : null;
  // The table is a view someone asked for, never something a pass reads: with no
  // `options.table` nothing is read and the result is the one of any other day.
  const table = options.table === undefined ? null : await statusTable(root, options.table);
  const shown = table === null
    ? {}
    : { table: { markdown: table.markdown, capacityLine: table.capacityLine } };

  if (typeof owner?.pid !== 'number') {
    return { running: false, pid: null, startedAt: null, paused, lastTick, ...shown };
  }
  return {
    running: isProcessAlive(owner.pid) && !isStale(startedAt),
    pid: owner.pid,
    startedAt: startedAt === null ? null : new Date(startedAt).toISOString(),
    paused,
    lastTick,
    ...shown,
  };
}

/**
 * Pauses the daemon of one state root: the next tick records `paused` and does
 * nothing, and the loop keeps running.
 *
 * @param {string} root state root
 * @returns {Promise<{paused: boolean}>}
 */
export async function daemonPause(root) {
  await writeJsonAtomic(pauseFile(root), { at: new Date().toISOString() });
  return { paused: true };
}

/**
 * Resumes the daemon of one state root by removing the pause file.
 *
 * @param {string} root state root
 * @returns {Promise<{paused: boolean}>}
 */
export async function daemonResume(root) {
  await rm(pauseFile(root), { force: true });
  return { paused: false };
}

const DAY_MS = 86_400_000;

/**
 * Removes `logs/*.jsonl` older than `keepDays`, by modification time, and
 * returns the names it removed. Files inside the window and anything that is
 * not a decision log are left alone.
 *
 * @param {string} root state root
 * @param {number} [keepDays]
 * @param {number} [now]
 * @returns {Promise<string[]>} removed file names
 */
export async function rotateLogs(root, keepDays = DEFAULT_DAEMON.logKeepDays, now = Date.now()) {
  const folder = paths(root).logs;
  let names;
  try {
    names = await readdir(folder);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`Cannot read ${folder}: ${error.message}`, { cause: error });
  }

  const days = Math.max(0, numberOr(keepDays, DEFAULT_DAEMON.logKeepDays));
  const cutoff = now - days * DAY_MS;
  const removed = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = join(folder, name);
    try {
      const info = await stat(file);
      if (info.mtimeMs >= cutoff) continue;
      await rm(file, { force: true });
      removed.push(name);
    } catch {
      // A log that vanished or cannot be read is not this caller's problem.
    }
  }
  return removed;
}
