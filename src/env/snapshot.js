import { capOf } from '../limits.js';
import { configOf, DEFAULT_CONFIG, normalizeLimits } from '../profiles.js';
import { setupPending } from './configuration.js';
import { adapterQuotaReader, clientsOf, detectClient, labelsOf, DEFAULT_TTL_MS, readingWithAge, readingOf, rowOf } from './quota.js';
import { confirmedActor, confirmedModels, detectClients, proposeProfiles, normalizeClientObservation } from './models.js';
import { execFile } from 'node:child_process';
import * as filesystem from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { collectorCommandIndex } from '../install/statusline.js';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { installConfig, installPaths, clientRoot } from '../install/config.js';
import { binInPath } from './path.js';
import { readRecords } from '../install/place.js';
import { paths } from '../store.js';
import { READING_FILE } from '../quota/statusline-collector.js';

const exec = promisify(execFile);
const READING_CACHE = new Map();

// Whether the collector has written a reading yet: null when this cannot be told (no state folder, or the file system refused).
async function readingReceived(deps) {
  if (!deps.root) return null;
  try { await (deps.fs ?? filesystem).stat(join(paths(deps.root).quota, READING_FILE)); return true; }
  catch (error) { return ['ENOENT', 'ENOTDIR'].includes(error?.code) ? false : null; }
}

async function statuslineState(deps, config, command) {
  const settings = config.statuslineRegistration;
  const location = { config: installConfig(config.install), env: deps.env ?? process.env,
    home: deps.home ?? deps.env?.HOME ?? deps.env?.USERPROFILE ?? homedir() };
  const path = join(clientRoot(settings.client, location), settings.settingsFile);
  let active = null;
  try {
    const value = JSON.parse(await (deps.fs ?? filesystem).readFile(path, 'utf8'));
    // Only a text command can be a registration; the installer refuses any other as unreadable.
    active = value.statusLine?.type === 'command' && typeof value.statusLine.command === 'string'
      && collectorCommandIndex(value.statusLine.command, settings, { ...config.install, command }) > 0;
  } catch (error) { if (error.code === 'ENOENT') active = false; }
  return { active, path, command: `${command} install --client ${settings.client} --statusline`,
    received: active === true ? await readingReceived(deps) : null };
}

async function withTimeout(pending, milliseconds) {
  let timer;
  try {
    return await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export async function refreshEnvironmentSnapshot(deps) {
  const cache = deps.cache ?? READING_CACHE;
  for (const key of cache.keys()) if (key.startsWith(`${deps.root}\n`)) cache.delete(key);
  return environmentSnapshot({ ...deps, snapshot: undefined, cache });
}

export function actorPairs(config, client) {
  const pairs = new Map();
  for (const [profileClass, profile] of Object.entries(config.profiles[client] ?? {})) {
    if (typeof profile?.model !== 'string' || !profile.model.trim()) continue;
    const key = JSON.stringify([profile.model, profile.effort]);
    const actor = pairs.get(key) ?? { client, model: profile.model, effort: profile.effort,
      sizes: [], critic: false };
    actor.sizes.push(...Object.entries(config.actors.sizeClasses)
      .filter(([, value]) => value === profileClass).map(([size]) => size));
    actor.critic ||= profileClass === config.actors.criticClass;
    pairs.set(key, actor);
  }
  return [...pairs.values()].map((actor) => ({ ...actor,
    sizes: Object.keys(config.actors.sizeClasses).filter((size) => actor.sizes.includes(size)) }));
}

async function environmentVersions(deps, config) {
  const versions = {};
  const run = deps.run ?? (async ({ command, args, timeout, env }) => {
    const result = await exec(command, args, { timeout, env });
    return { ...result, code: 0 };
  });
  for (const [client, settings] of Object.entries(config.clients)) {
    if (deps.client && client !== deps.client) continue;
    try {
      const result = await withTimeout(run({ command: settings.executable,
        args: settings.versionArgs ?? config.kit.versionArgs,
        timeout: settings.timeoutMs ?? config.kit.timeoutMs, env: deps.env }),
      settings.timeoutMs ?? config.kit.timeoutMs);
      const ok = (result.code ?? result.exitCode ?? 0) === 0;
      versions[client] = { installed: ok ? true : null, version: ok ? result.stdout?.trim() || null : null };
    } catch (error) {
      versions[client] = { installed: error.code === 'ENOENT' ? false : null, version: null };
    }
  }
  return versions;
}

export async function environmentReadings(deps) {
  if (deps.plugin !== undefined && deps.versions !== undefined) {
    return { plugin: deps.plugin, versions: deps.versions };
  }
  const config = installConfig(deps.config.install);
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? env.HOME ?? env.USERPROFILE ?? homedir();
  const location = { ...deps, env, platform, fs: deps.fs ?? filesystem, config, home,
    ...installPaths(config, { ...deps, env, platform, home }) };
  const records = Object.values(await readRecords(location.destination, location.fs, config));
  location.bin = records.find((record) => record.linkDirectory)?.linkDirectory ?? location.bin;
  const plugin = deps.plugin ?? { path: records.find((record) => record.path)?.path
    ?? resolve(fileURLToPath(new URL('../..', import.meta.url))),
  onPath: binInPath(location) };
  return { plugin, versions: deps.versions ?? await environmentVersions({ ...deps, env }, config) };
}

export async function environmentSnapshot(deps = {}) {
  if (deps.snapshot) return deps.snapshot;
  const config = configOf(deps.config);
  if (deps.profiles !== undefined) config.profiles = deps.profiles;
  const known = Object.keys(DEFAULT_CONFIG.install.clients);
  if (deps.view === 'selected') {
    if (deps.client !== undefined && !known.includes(deps.client)) {
      throw new TypeError('client must be one of ' + known.join(', '));
    }
    if (deps.all !== undefined && typeof deps.all !== 'boolean') throw new TypeError('all must be a boolean');
  }
  if (deps.client !== undefined && !known.includes(deps.client)) {
    return { unknownClient: true };
  }
  const inUse = detectClient(deps.env);
  const probes = new Map();
  const run = deps.run ?? (async ({ command, args, timeout, timeoutMs, env, cwd }) => ({
    ...await exec(command, args, { timeout: timeoutMs ?? timeout, env, cwd }), code: 0,
  }));
  deps = { ...deps, run: (request) => {
    const key = JSON.stringify([request.command, request.args, request.cwd]);
    if (!probes.has(key)) probes.set(key, Promise.resolve().then(() => run(request)));
    return probes.get(key);
  } };
  const runtime = await environmentReadings({ ...deps, config });
  deps = { ...deps, ...runtime };
  const selected = deps.client ?? (deps.all ? null : inUse);
  const clients = deps.view === 'selected'
    ? selected ? [selected] : (deps.clients ?? clientsOf(config))
    : deps.client ? [deps.client] : [...new Set([...clientsOf(config), ...known])]
      .filter((client) => known.includes(client));
  if (deps.view !== 'selected') clients.sort((a, b) => Number(b === inUse) - Number(a === inUse));
  const observed = await (deps.detectClients ?? detectClients)({ ...deps, config });
  const detected = { clients: observed.clients.map((record) => {
    const normalized = normalizeClientObservation(record, record.client);
    normalized.installed = deps.versions?.[record.client]?.installed ?? normalized.installed;
    return normalized;
  }) };
  const now = (deps.now ?? Date.now)();
  const quotas = new Map();
  const readQuota = deps.readQuota ?? (deps.root ? adapterQuotaReader({
    stateRoot: deps.root, env: deps.env, now: deps.now, config,
  }) : undefined);
  for (const client of clients) {
    const { reading, at } = await readingWithAge(deps.cache ?? (deps.view === 'selected' ? READING_CACHE : new Map()), deps.root, client,
      readQuota, () => now, deps.ttlMs ?? DEFAULT_TTL_MS);
    quotas.set(client, { reading, at });
  }
  const command = deps.command ?? config.install.command ?? DEFAULT_CONFIG.install.command;
  const missing = [];
  const configured = [];
  if (setupPending(config)) missing.push({ item: 'setup', command: `${command} setup` });
  else configured.push('setup');
  if (deps.plugin?.onPath === true) configured.push('path');
  else if (deps.plugin?.onPath === false) missing.push({ item: 'path', command: `${command} install --client ${deps.client ?? inUse ?? clients[0]}` });
  const rows = clients.map((client) => {
    const reading = detected.clients.find((entry) => entry.client === client);
    const installed = deps.versions?.[client]?.installed ?? reading?.installed ?? null;
    const models = confirmedModels(config, client, reading, installed);
    const available = actorPairs(config, client).filter((actor) => confirmedActor(config, client, reading, installed, actor));
    const { cap, source } = capOf(normalizeLimits(deps.limits?.limits ?? config.limits), client);
    if (installed !== false && !available.length) missing.push({ item: 'models', client,
      command: `${command} setup${setupPending(config) ? '' : ' --again'}` });
    else if (available.length) configured.push({ item: 'models', client });
    const sizes = Object.keys(config.actors.sizeClasses).filter((size) => !available.some((actor) => actor.sizes.includes(size)));
    if (available.length && sizes.length) missing.push({ item: 'sizes', client, sizes, command: `${command} setup` });
    const quota = rowOf(client, readingOf(quotas.get(client).reading), quotas.get(client).at,
      config, labelsOf(), now, deps.orders);
    if (installed !== false && quota.status === 'off') missing.push({ item: 'quota', client,
      command: `${command} quota set ${client} <pct>` });
    const raw = quotas.get(client).reading;
    const recorded = Date.parse(raw?.recordedAt);
    quota.ageMinutes = Number.isFinite(recorded) ? Math.max(0, now - recorded) / 60_000 : raw?.ageMinutes ?? null;
    quota.recordedAt = raw?.recordedAt ?? null;
    quota.provider = raw?.provider ?? null;
    quota.observedAt = quotas.get(client).at;
    const free = Math.max(0, cap - (deps.limits?.byClient?.[client] ?? 0));
    const candidates = (installed === false ? [] : actorPairs(config, client)).map((actor) => {
      const confirmed = available.some((pair) => pair.model === actor.model && pair.effort === actor.effort);
      const restrictions = [!confirmed && 'unconfirmed', quota.status === 'off' && 'unknown-quota',
        (raw?.expired || (raw?.expiresAt && Date.parse(raw.expiresAt) <= now)
          || (quota.ageMinutes !== null && quota.ageMinutes > config.staleMinutes)) && 'expired-quota',
        quota.status === 'red' && 'low', free === 0 && 'busy'].filter(Boolean);
      return { ...actor, confirmed, restrictions, canLaunch: restrictions.length === 0 };
    });
    const sizeOrder = Object.keys(config.actors.sizeClasses);
    const launchable = sizeOrder.filter((size) => candidates.some((actor) => actor.canLaunch && actor.sizes.includes(size)));
    const sizeCoverage = { launchable, gaps: sizeOrder.filter((size) => installed !== false && !launchable.includes(size)).map((size) => ({
      size, alternative: [...launchable].sort((a, b) => Math.abs(sizeOrder.indexOf(a) - sizeOrder.indexOf(size))
        - Math.abs(sizeOrder.indexOf(b) - sizeOrder.indexOf(size)))[0] ?? null,
    })) };
    const location = { config: installConfig(config.install), env: deps.env ?? process.env,
      home: deps.home ?? deps.env?.HOME ?? deps.env?.USERPROFILE ?? homedir() };
    return { client, inUse: client === inUse, installed, candidates, sizeCoverage,
      configPath: known.includes(client) ? clientRoot(client, location) : null,
      evidence: { models: reading?.source ?? 'unknown', reason: reading?.reason ?? null,
        error: reading?.error ?? null },
      version: deps.versions?.[client]?.version ?? null, models,
      actors: candidates.filter((actor) => actor.confirmed),
      quota,
      quotaReadAt: quotas.get(client).at,
      reading: quotas.get(client).reading,
      slots: { total: cap, available: Math.max(0, cap - (deps.limits?.byClient?.[client] ?? 0)) },
      slotEvidence: { running: deps.limits?.byClient?.[client] ?? 0, source } };
  });
  if (deps.root) {
    const { record } = await import('../telemetry/index.js');
    for (const row of rows) await record(deps.root, 'quota.check', { client: row.client, state: row.quota.status });
  }
  return { now, inUse, config, detected, proposals: proposeProfiles(detected, config), clients: rows,
    plugin: { ...deps.plugin, statusline: await statuslineState(deps, config, command),
      statePath: deps.root, configured, missing } };
}

