import * as fs from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { accountFiles, accountsOf } from './accounts.js';
import { configOf } from './profiles.js';
import { readJson } from './state.js';
import { environmentSnapshot } from './env/snapshot.js';
import { adapterQuotaReader, FIVE_HOURS_MINUTES } from './env/quota.js';
import { readiness, readyLine } from './env/ready.js';
import { finiteNumber, windowsOf } from './quota-fields.js';
import { UsageError } from './install/exit.js';
import { loginState } from './accounts-login.js';
import { pollStateFile } from './quota/active-poller.js';
import { pollReason, rotationStatus } from './quota/rotation.js';
import { requestQuotaRead, serviceRunning } from './quota/active-trigger.js';
import { collectorState } from './quota/collector-registration.js';

const RECENT_RUNS = 100;
const MAX_RUN_BYTES = 256 * 1024;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const staleRun = (run, now, minutes) => run.status === 'live'
  && typeof run.startedAt === 'number' && now - run.startedAt > minutes * 60_000;

function windowState(reading, short, now) {
  const windows = windowsOf(reading?.windows);
  if (!windows.length && finiteNumber(reading?.remainingPct) !== null) windows.push(reading);
  const window = windows.filter((entry) => finiteNumber(entry.remainingPct) !== null
    && ((entry.windowMinutes ?? entry.minutes ?? 10080) <= FIVE_HOURS_MINUTES) === short)
    .sort((a, b) => (b.windowMinutes ?? b.minutes ?? 10080) - (a.windowMinutes ?? a.minutes ?? 10080)
      || a.remainingPct - b.remainingPct)[0];
  if (!window) return null;
  const reset = Date.parse(window.resetsAt);
  const resetMs = Number.isFinite(reset) ? reset : finiteNumber(window.resetsInMinutes) !== null
    ? now + window.resetsInMinutes * 60_000 : null;
  const recorded = Date.parse(reading.recordedAt);
  return { remaining_pct: window.remainingPct,
    resets_at: resetMs === null ? null : new Date(resetMs).toISOString(),
    source: reading.source ?? 'unknown',
    age_seconds: Number.isFinite(recorded) ? Math.max(0, now - recorded) / 1000 : null };
}

async function installed(executable, env) {
  const candidates = executable.includes('/') || executable.includes('\\') ? [executable]
    : (env.PATH ?? '').split(delimiter).filter(Boolean).flatMap((directory) =>
      (process.platform === 'win32' ? ['', '.exe', '.cmd'] : ['']).map((suffix) => join(directory, executable + suffix)));
  return (await Promise.all(candidates.map(async (file) => {
    try { await fs.access(file, fs.constants.X_OK); return (await fs.stat(file)).isFile(); } catch { return false; }
  }))).some(Boolean);
}

/** Snapshot returns cached quotas; bounded active reads run in a separate worker. */
export async function panelState(ctx, client, { readRunJson = readJson } = {}) {
  const internal = client === 'claude' ? 'claude-code' : client;
  const warnings = [];
  try {
    const stored = await readJson(join(ctx.root, 'config.json'), {});
    if (!isObject(stored)) throw new Error('Invalid configuration object.');
    if (stored.configuredClients !== undefined && !Array.isArray(stored.configuredClients)) {
      throw new Error('Invalid configured clients.');
    }
    return await configuredState(ctx, client, internal, stored, warnings, readRunJson);
  } catch {
    warnings.push('config file unreadable');
    return configuredState(ctx, client, internal, {}, warnings, readRunJson);
  }
}

async function configuredState(ctx, client, internal, stored, warnings, readRunJson) {
  const config = configOf(stored);
  const identities = accountsOf(config, internal);
  const now = ctx.now();
  if (!await serviceRunning(ctx.root)) {
    await Promise.all(identities.map((identity) => requestQuotaRead(ctx, internal, identity.id)));
  }
  const runs = await records(ctx.root, now, config.staleMinutes, readRunJson);
  const present = await installed(config.install.clients[internal].executable, ctx.env);
  const byClient = {};
  for (const run of runs) {
    if (run.status !== 'live' || staleRun(run, now, config.staleMinutes)) continue;
    const key = !run.account || run.account === 'default' ? run.client : `${run.client}:${run.account}`;
    byClient[key] = (byClient[key] ?? 0) + 1;
  }
  const adapter = adapterQuotaReader({ stateRoot: ctx.root, env: ctx.env, now: () => now, config });
  const readQuota = async (client, account = 'default') => {
    try {
      const stored = await readJson(join(ctx.root, 'quota', accountFiles(client, account).reading), {});
      if (!isObject(stored)) throw new Error('Invalid quota object.');
      return await adapter(client, account);
    } catch {
      if (!warnings.includes('quota file unreadable')) warnings.push('quota file unreadable');
      return null;
    }
  };
  const snapshot = await environmentSnapshot({ ...ctx, config, client: internal, runs, readQuota,
    now: () => now, record: false, cache: new Map(), plugin: { onPath: null }, limits: { byClient },
    versions: { [internal]: { installed: present } },
    detectClients: async () => ({ clients: [{ client: internal, installed: present,
      source: 'catalog', models: [], hidden: [] }] }),
    run: async () => { throw new Error('Panel state cannot start processes.'); } });
  const row = snapshot.clients[0];
  const saved = Object.hasOwn(stored.accounts ?? {}, internal)
    || Object.hasOwn(stored.profiles ?? {}, internal)
    || (Array.isArray(stored.configuredClients) && stored.configuredClients.includes(internal))
    || finiteNumber(row.reading?.remainingPct) !== null;
  const accounts = saved ? await Promise.all(identities.map(async (identity, index) => {
    const account = row.accounts?.[index] ?? row;
    const state = await readJson(join(ctx.root, 'quota', pollStateFile(internal, identity.id)), null).catch(() => null);
    const login = await loginState({ ...ctx, client: internal, account: identity, config });
    return { id: identity.id, label: identity.label,
      collector: await collectorState(ctx, config, identity),
      rotation: rotationStatus({ reading: account.reading, login, config, now, locale: ctx.locale ?? config.language }),
      quota_state: state ? { state: state.state, reason: pollReason(state, ctx.locale ?? config.language) } : null,
      quota: { session: windowState(account.reading, true, now), weekly: windowState(account.reading, false, now) } };
  })) : [];
  return { schema_version: 1, client, accounts, panel: { autoOpen: config.panel?.autoOpen !== false, color: config.panel?.color !== false },
    runs: runs.filter((run) => run.client === internal && (!run.role || run.role === 'executor')).map((run) => runState(run, now, config.staleMinutes)),
    launchable: saved ? identities.flatMap((identity, index) => (row.accounts?.[index] ?? row).candidates.map((actor) => ({
      account: identity.id, model: actor.model, effort: actor.effort, can_launch: actor.canLaunch,
      actor_classes: Object.entries(config.profiles[internal] ?? {}).filter(([, profile]) =>
        profile.model === actor.model && profile.effort === actor.effort).map(([name]) => name),
      reasons: actor.restrictions }))) : [],
    readiness: readyLine(readiness(snapshot), 'en'), warnings };
}

function runState(run, now, staleMinutes) {
  const progress = typeof run.lastProgress === 'string' ? run.lastProgress.split(/\r?\n/).filter(Boolean).at(-1) ?? null : null;
  const characters = progress === null ? [] : Array.from(progress);
  const started = finiteNumber(run.startedAt);
  const ended = finiteNumber(run.endedAt) ?? finiteNumber(run.finishedAt);
  const demand = typeof run.demand === 'string' ? Array.from(run.demand).slice(0, 120).join('') : null;
  const finishReason = typeof run.error === 'string' && run.error.trim()
    || (Number.isFinite(run.exitCode) && run.exitCode !== 0) ? 'error' : null;
  return { id: run.runId ?? null, status: run.status ?? null, stale: staleRun(run, now, staleMinutes), account: run.account ?? 'default',
    actor: run.actor ?? null, model: run.model ?? run.profile?.model ?? null,
    effort: run.effort ?? run.profile?.effort ?? null,
    ...(demand ? { demand } : {}),
    ...(finishReason ? { finish_reason: finishReason } : {}),
    started_at: started === null ? null : new Date(started).toISOString(),
    elapsed_seconds: started === null ? null : Math.max(0, (ended ?? now) - started) / 1000,
    last_progress: characters.length > 500 ? characters.slice(0, 499).join('') + '…' : progress };
}

export async function panelStateCommand(ctx, flags) {
  let client;
  let json = false;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === '--json') json = true;
    else if (flag === '--client' && client === undefined) client = flags[++index];
    else throw new UsageError(`Unknown flag: ${flag}`);
  }
  if (!json || !['claude', 'codex'].includes(client)) {
    throw new UsageError('Use panel-state --json --client <claude|codex>.');
  }
  ctx.out(JSON.stringify(await panelState(ctx, client)));
  return 0;
}

async function records(root, now, staleMinutes, readJson) {
  const directory = join(root, 'runs');
  const names = await fs.readdir(directory).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const entries = (await Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => {
    try {
      const info = await fs.stat(join(directory, name));
      return info.isFile() && info.size <= MAX_RUN_BYTES ? { name, mtime: info.mtimeMs } : null;
    } catch { return null; }
  }))).filter(Boolean).sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  return (await Promise.all(entries.filter((entry, index) => index < RECENT_RUNS
    || entry.mtime >= now - staleMinutes * 60_000).map(async ({ name }) => {
    try { return await readJson(join(directory, name), null); } catch { return null; }
  }))).filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
}
