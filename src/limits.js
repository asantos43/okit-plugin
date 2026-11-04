// Concurrency cap over runs/<runId>.json. The core counts its own live runs
// instead of trusting the client to hold the cap.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { accountKey, accountsOf } from './accounts.js';

import { DEFAULT_CONFIG, configOf } from './profiles.js';
import { readJson, withLock, writeJsonAtomic } from './state.js';

const POLL_MS = 100;

async function settingsOf(root, config) {
  return configOf(config === undefined ? await readJson(join(root, 'config.json'), {}) : config);
}

function runsDir(root) {
  return join(root, 'runs');
}

function runFile(root, runId) {
  return join(runsDir(root), `${runId}.json`);
}

function isLive(run, staleMs, now) {
  if (!run || run.status !== 'live') return false;
  // No startedAt means the age is unknown, so the run counts until released.
  if (typeof run.startedAt !== 'number') return true;
  return now - run.startedAt <= staleMs;
}

async function readLiveRuns(root, staleMinutes) {
  let names;
  try {
    names = await readdir(runsDir(root));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`Cannot read ${runsDir(root)}: ${error.message}`, { cause: error });
  }

  const now = Date.now();
  const staleMs = staleMinutes * 60_000;
  const runs = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const run = await readJson(join(runsDir(root), name), null);
    if (isLive(run, staleMs, now)) runs.push(run);
  }
  return runs;
}

// A hand-edited run file may carry a client or account the model refuses: it still counts, under its bare client.
function keyOfRun(run) {
  const client = run.client ?? 'unknown';
  if (run.account === undefined) return client;
  try { return accountKey(run.client, run.account); } catch { return client; }
}

function tally(runs) {
  const byClient = {};
  for (const run of runs) {
    const client = keyOfRun(run);
    byClient[client] = (byClient[client] ?? 0) + 1;
  }
  return { global: runs.length, byClient };
}

/**
 * Counts live runs under `root`, ignoring runs older than `staleMinutes`.
 *
 * @param {string} root state root
 * @param {object} [config]
 * @returns {Promise<number>} live run count across all clients
 */
export async function countLive(root, config) {
  const { staleMinutes } = await settingsOf(root, config);
  const runs = await readLiveRuns(root, staleMinutes);
  return runs.length;
}
async function liveCounts(root, client, config) {
  const { staleMinutes } = await settingsOf(root, config);
  const runs = await readLiveRuns(root, staleMinutes);
  const { global, byClient } = tally(runs);
  return { global, perClient: byClient[client] ?? 0 };
}

function refusal(reason, counts) {
  return { ok: false, reason, global: counts.global, perClient: counts.perClient };
}

export function capOf(limits, client) {
  const own = Object.hasOwn(limits.clients, client);
  return { cap: own ? limits.clients[client] : limits.global, source: own ? 'client' : 'default' };
}

function checkCaps(counts, limits, client) {
  const { cap, source } = capOf(limits, client);
  if (counts.perClient >= cap) return refusal(`${source} limit`, counts);
  return { ok: true, global: counts.global, perClient: counts.perClient };
}

/**
 * Reports whether one more run fits under this client's effective cap.
 *
 * @param {string} root state root
 * @param {{client: string, account?: string, config?: object}} input
 * @returns {Promise<{ok: boolean, reason?: string, global: number, perClient: number}>}
 */
export async function canSpawn(root, { client, account, config } = {}) {
  const { limits } = await settingsOf(root, config);
  const key = account === undefined ? client : accountKey(client, account);
  return checkCaps(await liveCounts(root, key, config), limits, client);
}
/**
 * Reserves a slot for `runId` and writes its run file, or reports `busy`.
 * The check and the write share one lock, so parallel callers cannot both
 * pass the cap. `waitMs` polls every 100 ms for a free slot.
 *
 * @param {string} root state root
 * @param {string} runId
 * @param {{client: string, account?: string, config?: object, waitMs?: number}} input
 * @returns {Promise<{ok: boolean, reason?: string, runId?: string, client?: string, global?: number, perClient?: number}>}
 */
export async function acquireSlot(root, runId, { client, account, config, waitMs = 0 } = {}) {
  const key = account === undefined ? client : accountKey(client, account);
  const identity = account === undefined || account === 'default' ? {} : { account };
  const deadline = Date.now() + Math.max(0, waitMs);

  for (;;) {
    // The lock is released before sleeping, so a waiter never blocks a release.
    const result = await withLock(runsDir(root), async () => {
      const { limits } = await settingsOf(root, config);
      const counts = await liveCounts(root, key, config);
      const room = checkCaps(counts, limits, client);
      if (!room.ok) return room;
      await writeJsonAtomic(runFile(root, runId), {
        runId, client, ...identity, status: 'live', startedAt: Date.now(),
      });
      return { ok: true, runId, client, ...identity };
    });

    if (result.ok || Date.now() >= deadline) return result;
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
  }
}
/**
 * Frees the slot of `runId` by marking its run file `done`.
 *
 * @param {string} root state root
 * @param {string} runId
 * @returns {Promise<{ok: boolean, reason?: string, runId: string}>}
 */
export async function releaseSlot(root, runId) {
  return withLock(runsDir(root), async () => {
    const file = runFile(root, runId);
    const run = await readJson(file, null);
    if (!run) return { ok: false, reason: 'unknown run', runId };
    await writeJsonAtomic(file, { ...run, status: 'done', endedAt: Date.now() });
    return { ok: true, runId };
  });
}

/**
 * Reports the caps and the current live counts, per client.
 *
 * @param {string} root state root
 * @param {object} [config]
 * @returns {Promise<{limits: object, live: number, byClient: object, caps: object, warnings: string[]}>}
 */
export async function limitsStatus(root, config, { client, account } = {}) {
  const key = account === undefined ? client : accountKey(client, account);
  const settings = await settingsOf(root, config);
  const { limits, staleMinutes, limitWarnings } = settings;
  const runs = await readLiveRuns(root, staleMinutes);
  const { global, byClient } = tally(runs);
  const clients = new Set([
    ...Object.keys(DEFAULT_CONFIG.release.adapters), ...Object.keys(limits.clients),
    ...Object.keys(config?.profiles ?? {}), ...Object.keys(byClient),
    ...Object.keys(settings.accounts ?? {}).flatMap((client) => accountsOf(settings, client).map((account) => account.key)),
  ]);
  if (key !== undefined) clients.add(key);
  const caps = Object.fromEntries([...clients].map((client) => [client, capOf(limits, client.split(':')[0])]));
  if (key !== undefined) {
    return { limits, live: global, byClient: { [key]: byClient[key] ?? 0 }, caps: { [key]: caps[key] }, warnings: limitWarnings };
  }
  return { limits, live: global, byClient, caps, warnings: limitWarnings };
}
