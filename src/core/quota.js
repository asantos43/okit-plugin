// The quota of a client: the reading the adapters give and the reading the
// person records. The clients of a root are the ones its configuration names
// (or the known ones when it names none): a client outside that list has no
// reading and no record. Nothing here prints.

import { join } from 'node:path';
import process from 'node:process';

import { adapterQuotaReader, clientsOf } from '../env/quota.js';
import { environmentSnapshot, refreshEnvironmentSnapshot } from '../env/snapshot.js';
import { configOf } from '../profiles.js';
import { CLIENTS } from '../spawn-process.js';
import { paths } from '../store.js';
import { readJson, writeJsonAtomic } from '../state.js';
import { argsOf, optionalNumber, optionalText, requiredNumber, requiredText } from './arguments.js';
import { Refusal } from './refusal.js';

/** The settings of a root: `config.json` over the defaults. */
async function readConfig(root) {
  return configOf(await readJson(paths(root).config, {}));
}

/** The settings of the root, when the caller already read them. */
function settingsOf(root, deps) {
  return deps.config ?? readConfig(root);
}

/** The clients of this root, the same list the quota table shows. */
function clientsOfRoot(config, deps) {
  const fallback = Array.isArray(deps.clients) && deps.clients.length > 0 ? deps.clients : CLIENTS;
  return clientsOf(config, fallback);
}

/**
 * The readings of the clients of this root: the recorded one, the automatic
 * one, or none at all.
 *
 * @param {string} root state root
 * @param {{client?: string}} [args] one client, or every client of the root
 * @param {object} [deps] the environment, the clock and the cache of the readings
 * @returns {Promise<{clients: {client: string, reading: object|null}[], now: number}>}
 */
export async function quotaShow(root, args = {}, deps = {}) {
  const given = argsOf('quota_show', args, ['client']);
  const client = optionalText('quota_show', given, 'client');
  const config = await settingsOf(root, deps);
  const known = clientsOfRoot(config, deps);
  if (client !== undefined && !known.includes(client)) {
    throw new Refusal(`quota_show: unknown client ${client}`);
  }
  const readers = adapterQuotaReader({ stateRoot: root, env: deps.env ?? process.env, now: deps.now, config });
  const snapshot = await environmentSnapshot({ ...deps, root, config, view: 'selected', all: true,
    clients: client === undefined ? known : [client], readQuota: readers, cache: deps.quotaCache ?? new Map() });
  return {
    clients: snapshot.clients.map((row) => ({ client: row.client, reading: row.reading })),
    now: snapshot.now,
  };
}

/**
 * The reading the person records for a client: the percentage that is left,
 * and the window it belongs to when one is given.
 *
 * @param {string} root state root
 * @param {{client: string, pct: number, windowMinutes?: number}} args the client and the percentage
 * @param {object} [deps] the environment, the clock and the cache of the readings
 * @returns {Promise<{client: string, pct: number, value: object, snapshot: object}>}
 */
export async function quotaSet(root, args = {}, deps = {}) {
  const given = argsOf('quota_set', args, ['client', 'pct', 'windowMinutes']);
  const client = requiredText('quota_set', given, 'client');
  const pct = requiredNumber('quota_set', given, 'pct', { min: 0, max: 100 });
  const windowMinutes = optionalNumber('quota_set', given, 'windowMinutes', { above: 0 });
  const config = await settingsOf(root, deps);
  const known = clientsOfRoot(config, deps);
  if (!known.includes(client)) throw new Refusal(`quota_set: unknown client ${client}`);
  const now = deps.now ?? Date.now;
  const value = { remainingPct: pct, recordedAt: new Date(now()).toISOString() };
  if (windowMinutes !== undefined) value.windowMinutes = windowMinutes;
  await writeJsonAtomic(join(paths(root).quota, `${client}.json`), value);
  const readers = adapterQuotaReader({ stateRoot: root, env: deps.env ?? process.env, now, config });
  // The reading is read again, so the cache of the root does not answer with
  // the value it held before this one was recorded.
  const snapshot = await refreshEnvironmentSnapshot({ ...deps, root, config, view: 'selected', all: true,
    clients: known, readQuota: readers, cache: deps.quotaCache });
  return { client, pct, value, snapshot };
}
