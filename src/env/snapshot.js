import { capOf } from '../limits.js';
import { accountsOf, accountEnv } from '../accounts.js';
import { loginState, accountWarnings } from '../accounts-login.js';
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
import { installConfig, installPaths, clientRoot, defaultFolderOf, homeOf } from '../install/config.js';
import { binInPath } from './path.js';
import { readRecords } from '../install/place.js';
import { paths } from '../store.js';
import { STATUSLINE_FILE } from '../quota/statusline-collector.js';

const exec = promisify(execFile);
const READING_CACHE = new Map();

// Whether the collector has written a reading yet: null when this cannot be told (no state folder, or the file system refused).
async function readingReceived(deps) {
  if (!deps.root) return null;
  try { await (deps.fs ?? filesystem).stat(join(paths(deps.root).quota, STATUSLINE_FILE)); return true; }
  catch (error) { return ['ENOENT', 'ENOTDIR'].includes(error?.code) ? false : null; }
}

async function statuslineState(deps, config, command) {
  const settings = config.statuslineRegistration;
  const location = { config: installConfig(config.install), env: deps.env ?? process.env,
    home: deps.home ?? homeOf(deps.env, deps.platform) ?? homedir() };
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
  const home = deps.home ?? homeOf(env, platform) ?? homedir();
  const location = { ...deps, env, platform, fs: deps.fs ?? filesystem, config, home,
    ...installPaths(config, { ...deps, env, platform, home }) };
  const unreadable = [];
  const records = Object.values(await readRecords(location.destination, location.fs, config, { unreadable }));
  location.bin = records.find((record) => record.linkDirectory)?.linkDirectory ?? location.bin;
  const plugin = deps.plugin ?? { path: records.find((record) => record.path)?.path
    ?? resolve(fileURLToPath(new URL('../..', import.meta.url))),
  onPath: binInPath(location), ...unreadable.length ? { unreadableRecords: unreadable } : {} };
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
    const key = JSON.stringify([request.command, request.args, request.cwd, request.env]);
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
  const accountsOfClient = (client) => (client === 'claude-code' || client === 'codex'
    ? accountsOf(config, client)
    : [{ id: 'default', key: client, label: 'default', isDefault: true, configDir: null }]);
  const observations = new Map();
  for (const client of clients) for (const account of accountsOfClient(client).slice(1)) {
    const env = accountEnv(client, account, deps.env ?? process.env);
    const result = await (deps.detectClients ?? detectClients)({ ...deps, config, env, onlyClient: client });
    const record = result.clients.find((entry) => entry.client === client);
    const versions = deps.detectClients ? {} : await environmentVersions({ ...deps, client, env }, installConfig(config.install));
    observations.set(account.key, record ? { ...normalizeClientObservation(record, client),
      installed: versions[client]?.installed ?? record.installed ?? null,
      version: versions[client]?.version ?? record.version } : null);
  }
  for (const client of clients) {
    for (const account of accountsOfClient(client)) {
      const { reading, at } = await readingWithAge(deps.cache ?? (deps.view === 'selected' ? READING_CACHE : new Map()), deps.root, account.key,
        readQuota ? () => readQuota(client, account.isDefault ? undefined : account.id) : undefined, () => now, deps.ttlMs ?? DEFAULT_TTL_MS);
      quotas.set(account.key, { reading, at });
    }
  }
  const command = deps.command ?? config.install.command ?? DEFAULT_CONFIG.install.command;
  const missing = [];
  const configured = [];
  if (setupPending(config)) missing.push({ item: 'setup', command: `${command} setup` });
  else configured.push('setup');
  if (deps.plugin?.onPath === true) configured.push('path');
  else if (deps.plugin?.onPath === false) missing.push({ item: 'path', command: `${command} install --client ${deps.client ?? inUse ?? clients[0]}` });
  // The logins are read before the rows are built, so the rows are made in one synchronous pass, in the order of the
  // clients: what `missing` and `configured` collect never depends on which read of a file answered first.
  const logins = new Map();
  await Promise.all(clients.flatMap((client) => accountsOfClient(client).map(async (account) => {
    logins.set(account.key, await loginState({ ...deps, client, account, install: config.install, config }));
  })));
  const rows = clients.map((client) => {
    const accounts = accountsOfClient(client);
    const accountRows = accounts.map((account) => {
    const target = { client, ...account.isDefault ? {} : { account: account.id } };
    const login = logins.get(account.key);
    const warnings = accountWarnings(client, deps.env, { config, platform: deps.platform,
      home: deps.home ?? homeOf(deps.env, deps.platform) ?? homedir() });
    const reading = account.isDefault ? detected.clients.find((entry) => entry.client === client) : observations.get(account.key);
    const installed = (account.isDefault ? deps.versions?.[client]?.installed : undefined) ?? reading?.installed ?? null;
    // Saved setup choices belong to the default; extras need their own confirmed listing.
    const catalog = account.isDefault || reading?.source === 'listing' ? reading : { ...reading, source: 'listing', models: [] };
    const models = confirmedModels(config, client, catalog, installed);
    const available = actorPairs(config, client).filter((actor) => confirmedActor(config, client, catalog, installed, actor));
    const { cap, source } = capOf(normalizeLimits(deps.limits?.limits ?? config.limits), client);
    if (installed !== false && !available.length) missing.push({ item: 'models', ...target,
      command: `${command} setup${setupPending(config) ? '' : ' --again'}` });
    else if (available.length) configured.push({ item: 'models', ...target });
    const sizes = Object.keys(config.actors.sizeClasses).filter((size) => !available.some((actor) => actor.sizes.includes(size)));
    if (available.length && sizes.length) missing.push({ item: 'sizes', ...target, sizes, command: `${command} setup` });
    const quota = rowOf(client, readingOf(quotas.get(account.key).reading), quotas.get(account.key).at,
      config, labelsOf(), now, deps.orders, target);
    // The item whose remedy is a tool carries the tool and no command: the model reads this object, so a command of
    // the kit in it would be a command the model is told to run.
    if (installed !== false && quota.status === 'off') missing.push({ item: 'quota', ...target, tool: 'quota_set' });
    const raw = quotas.get(account.key).reading;
    const recorded = Date.parse(raw?.recordedAt);
    quota.ageMinutes = Number.isFinite(recorded) ? Math.max(0, now - recorded) / 60_000 : raw?.ageMinutes ?? null;
    quota.recordedAt = raw?.recordedAt ?? null;
    quota.provider = raw?.provider ?? null;
    quota.observedAt = quotas.get(account.key).at;
    const free = Math.max(0, cap - (deps.limits?.byClient?.[account.key] ?? 0));
    const expired = Boolean(raw?.expired || (raw?.expiresAt && Date.parse(raw.expiresAt) <= now)
      || (quota.ageMinutes !== null && quota.ageMinutes > config.staleMinutes));
    const candidates = (installed === false ? [] : actorPairs(config, client)).map((actor) => {
      const confirmed = available.some((pair) => pair.model === actor.model && pair.effort === actor.effort);
      // An installation nobody could confirm is not a client to launch from: the readiness says the same.
      const restrictions = [installed === null && 'unknown-install', !confirmed && 'unconfirmed', quota.status === 'off' && 'unknown-quota',
        expired && 'expired-quota', accounts.length > 1 && login === 'logged-out' && 'not-logged-in',
        quota.status === 'red' && 'low', free === 0 && 'busy'].filter(Boolean);
      return { ...actor, confirmed, restrictions, canLaunch: restrictions.length === 0 };
    });
    const sizeOrder = Object.keys(config.actors.sizeClasses);
    const launchable = sizeOrder.filter((size) => candidates.some((actor) => actor.canLaunch && actor.sizes.includes(size)));
    const sizeCoverage = { launchable, gaps: sizeOrder.filter((size) => installed !== false && !launchable.includes(size)).map((size) => ({
      size, alternative: [...launchable].sort((a, b) => Math.abs(sizeOrder.indexOf(a) - sizeOrder.indexOf(size))
        - Math.abs(sizeOrder.indexOf(b) - sizeOrder.indexOf(size)))[0] ?? null,
    })) };
    const location = { config: installConfig(config.install), env: ['claude-code', 'codex'].includes(client)
      ? accountEnv(client, account, deps.env ?? process.env) : deps.env ?? process.env,
      home: deps.home ?? homeOf(deps.env, deps.platform) ?? homedir() };
    return { ...account, account: account.id, login, warnings, client, inUse: client === inUse, installed, candidates, sizeCoverage,
      configPath: !known.includes(client) ? null : account.isDefault && ['claude-code', 'codex'].includes(client)
        ? defaultFolderOf(client, { config, env: location.env, platform: deps.platform, home: location.home })
        : clientRoot(client, location),
      evidence: { models: reading?.source ?? 'unknown', reason: reading?.reason ?? null,
        error: reading?.error ?? null },
      version: (account.isDefault ? deps.versions?.[client]?.version : reading?.version) ?? null, models,
      actors: candidates.filter((actor) => actor.confirmed),
      quota,
      quotaReadAt: quotas.get(account.key).at,
      reading: quotas.get(account.key).reading,
      slots: { total: cap, available: free },
      slotEvidence: { running: deps.limits?.byClient?.[account.key] ?? 0, source } };
    });
    const { id: _id, key: _key, label: _label, isDefault: _default, configDir: _dir, account: _account,
      login: _login, warnings, ...row } = accountRows[0];
    // One account is the row as it always was; the list of accounts appears only when there are several. The one
    // warning a single account can need is a folder variable that names no saved account.
    const unregistered = warnings.filter(({ code }) => code === 'config-dir-unregistered');
    if (accountRows.length > 1) return { ...row, accounts: accountRows };
    return unregistered.length ? { ...row, warnings: unregistered } : row;
  });
  // `record: false` takes the snapshot read-only (the doctor): the telemetry of the quota check is not written.
  if (deps.root && deps.record !== false) {
    const { record } = await import('../telemetry/index.js');
    for (const row of rows) for (const account of row.accounts ?? [{ isDefault: true, quota: row.quota }]) await record(deps.root, 'quota.check', {
      client: row.client, state: account.quota.status, ...account.isDefault ? {} : { account: account.id },
    });
  }
  return { now, inUse, config, detected, proposals: proposeProfiles(detected, config), clients: rows,
    plugin: { ...deps.plugin, statusline: await statuslineState(deps, config, command),
      statePath: deps.root, configured, missing } };
}

