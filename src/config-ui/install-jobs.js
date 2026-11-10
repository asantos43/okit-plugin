import * as fs from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildInstallPlan, compareInstallFingerprints } from '../install/plan.js';
import { installerCommand } from '../install/index.js';
import { createStructuredPresenter, localizeReason, redact } from '../install/present.js';
import { UsageError } from '../install/exit.js';
import { installedRecords } from './wizard-state.js';
import { createFollowupJobs } from './install-followup-jobs.js';

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v) => typeof v === 'string' && /^[\w-]{1,128}$/.test(v);
export function installError(status, reason) {
  return Object.assign(new UsageError(reason), { status, code: reason });
}
function shape(value, keys) {
  if (!object(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw installError(400, 'Invalid install request.');
  }
}
const flags = { from: 'from', destination: 'dest', noPath: 'no-path', noLink: 'no-link',
  noStatusline: 'no-statusline', prerelease: 'prerelease' };
const cancelled = () => installError(409, 'Install cancelled at a safe boundary.');

async function reclaimGuard(folder, owner, busy) {
  const marker = `${owner.pid}-${owner.startedAt}-${owner.nonce}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await fs.mkdir(folder); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      for (const entry of await fs.readdir(folder)) {
        const pid = Number(entry.split('-')[0]);
        if (!Number.isInteger(pid) || pid <= 0) throw busy();
        try { process.kill(pid, 0); throw busy(); }
        catch (failure) { if (failure.code !== 'ESRCH') throw busy(); }
        await fs.unlink(join(folder, entry)).catch((failure) => { if (failure.code !== 'ENOENT') throw failure; });
      }
      await fs.rmdir(folder).catch((failure) => { if (failure.code !== 'ENOENT') throw busy(); });
      continue;
    }
    const file = join(folder, marker);
    try {
      await fs.writeFile(file, '', { flag: 'wx', mode: 0o600 });
      const entries = await fs.readdir(folder);
      if (entries.length !== 1 || entries[0] !== marker) throw busy();
      return async () => {
        await fs.unlink(file).catch(() => {});
        await fs.rmdir(folder).catch(() => {});
      };
    } catch (error) {
      await fs.unlink(file).catch(() => {});
      await fs.rmdir(folder).catch(() => {});
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw busy();
}

/** An exclusive file is also the cross-process boundary; no session secrets live here. */
export async function acquireInstallLock(root) {
  await fs.mkdir(root, { recursive: true });
  const file = join(await fs.realpath(resolve(root)), 'install-job.lock');
  const owner = { pid: process.pid, startedAt: Date.now(), nonce: randomUUID() };
  const busy = () => installError(409, 'Install lock held; close the other installer and review again.');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(owner)); }
      catch (error) { await fs.unlink(file); throw error; }
      finally { await handle.close(); }
      return async () => {
        const current = JSON.parse(await fs.readFile(file, 'utf8'));
        if (current.nonce === owner.nonce) await fs.unlink(file);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    // Serialize stale reclamation, including the re-read, to avoid unlinking a new owner.
    const guard = `${file}.reclaim`;
    const releaseGuard = await reclaimGuard(guard, owner, busy);
    try {
      let holder;
      try { holder = JSON.parse(await fs.readFile(file, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw busy(); }
      if (!object(holder) || !Number.isInteger(holder.pid) || holder.pid <= 0 || !Number.isFinite(holder.startedAt)) throw busy();
      try { process.kill(holder.pid, 0); throw busy(); }
      catch (error) { if (error.code !== 'ESRCH') throw busy(); }
      await fs.unlink(file);
    } finally { await releaseGuard(); }
  }
  throw busy();
}

export function createInstallJobs({ root, env = process.env, platform = process.platform, locale = 'en', token = '',
  io = {}, run, buildPlan = buildInstallPlan, compare = compareInstallFingerprints,
  execute = installerCommand, lock = acquireInstallLock, now = Date.now,
  planTtlMs = 600_000, maxPlans = 16, maxEvents = 256, maxJobs = 64 } = {}) {
  const plans = new Map(), jobs = new Map(), pending = new Map();
  let current, applying = false, closing = false;
  const clean = (value) => JSON.parse(JSON.stringify(value, (key, item) => {
    if (/^x-okit-token$/i.test(key)) return '[redacted]';
    if (typeof item !== 'string') return item;
    return redact(item).replace(/x-okit-token\s*[:=]\s*\S+/gi, 'x-okit-token: [redacted]')
      .split(token || '\0').join('[redacted]');
  }).split(token || '\0').join('[redacted]'));
  const ctx = { root, env, platform, run, command: 'okit-plugin', now, fs: io.fs ?? fs,
    write: io.write, writeConfig: io.writeConfig };
  const followups = createFollowupJobs({ getJob: () => current, busy: () => active() || current?.running, ctx,
    io, lock, clean, event, fail: installError, now, ttl: planTtlMs, limit: maxPlans, maxRuns: maxJobs, locale });
  function event(job, value) {
    job.events.push(clean({ ...value, seq: ++job.seq }));
    if (job.events.length > maxEvents) job.events.shift();
  }
  const prune = () => {
    for (const [key, entry] of plans) if (entry.expires <= now()) plans.delete(key);
  };
  const active = () => applying || current?.state === 'applying'
    || current?.state === 'waiting' || followups.active();
  // The records of what is installed, read-only: repair and model-only runs need one for every client they name.
  async function recorded() {
    let saved = {};
    try { saved = JSON.parse(await (io.fs ?? fs).readFile(join(root, 'config.json'), 'utf8')); } catch { /* none yet */ }
    return installedRecords({ root, env, platform, io: { ...io, config: saved?.install } });
  }
  async function plan(input) {
    shape(input, ['operation', 'clients', 'options']);
    const { operation, clients, options = {} } = input;
    if (!['install', 'update', 'repair', 'models'].includes(operation) || !Array.isArray(clients) || !clients.length
      || clients.length > 3 || new Set(clients).size !== clients.length
      || clients.some((c) => !['claude-code', 'codex', 'opencode'].includes(c))) {
      throw installError(400, 'Invalid install request.');
    }
    shape(options, Object.keys(flags));
    const args = ['--locale', locale];
    for (const [key, value] of Object.entries(options)) {
      const text = ['from', 'destination'].includes(key);
      if (text ? typeof value !== 'string' || !value.trim() || value.startsWith('--') || /[\0\r\n]/.test(value)
        : typeof value !== 'boolean') throw installError(400, 'Invalid install request.');
      if (operation === 'repair' && ['destination', 'noLink', 'prerelease'].includes(key)) {
        throw installError(400, 'Invalid install request.');
      }
      if (operation === 'update' && ['from', 'destination', 'noLink', 'prerelease'].includes(key)
        || operation === 'models') {
        throw installError(400, 'Invalid install request.');
      }
      if (text) args.push(`--${flags[key]}`, value);
      else if (value) args.push(`--${flags[key]}`);
    }
    prune();
    if (closing || plans.size >= maxPlans) throw installError(409, 'Install session is full or closing; reopen and review again.');
    const entries = [];
    const records = ['repair', 'models'].includes(operation) ? await recorded() : null;
    if (records && clients.some((client) => !records[client])) throw installError(409, 'not-installed');
    for (const client of clients) {
      // A model-only run has no payload and nothing to preview but the saved settings: the follow-up that follows
      // shows each change and asks again. Repair is the install run again, so it is previewed as one.
      const entryPlan = operation === 'models'
        ? { schemaVersion: 1, operation, locale, clients: [{ client }], releases: [], mutations: [], conflicts: [],
          deferred: [], events: [], fingerprints: [], reviewable: true }
        : await buildPlan(operation === 'repair' ? 'install' : operation, [...args, '--client', client], ctx, io);
      entries.push({ args: [...args, '--client', client], plan: { ...entryPlan, operation } });
    }
    prune();
    if (closing || plans.size >= maxPlans) throw installError(409, 'Install session is full or closing; reopen and review again.');
    const combined = { ...entries[0].plan, reviewable: entries.every((e) => e.plan.reviewable) };
    for (const key of ['clients', 'releases', 'mutations', 'fingerprints', 'conflicts', 'deferred', 'events']) {
      combined[key] = entries.flatMap((e) => e.plan[key] ?? []);
    }
    const planId = randomUUID();
    plans.set(planId, { operation, entries, plan: combined, expires: now() + planTtlMs });
    return clean({ planId, plan: combined, fingerprints: combined.fingerprints });
  }
  function snapshot(after = 0, job = current) {
    if (!job) return { jobId: null, state: 'idle', events: [], question: null, result: null };
    const fullSnapshot = after < (job.events[0]?.seq ?? 1) - 1 || after > job.seq;
    return clean({ jobId: job.id, state: job.state, seq: job.seq, fullSnapshot,
      events: job.events.filter((e) => fullSnapshot || e.seq > after), question: job.question,
      cancelRequested: Boolean(job.cancel), currentStep: { client: job.client ?? null, stage: job.step ?? null },
      completed: job.completed, remaining: job.remaining, result: job.result, followups: job.followups });
  }
  function checkpoint(job, step) {
    if (job.step && !['client', 'question', 'answer'].includes(job.step)) {
      const finished = `${job.client}:${job.step}`;
      if (!job.completed.includes(finished)) job.completed.push(finished);
      job.remaining = job.remaining.filter((s) => s !== finished);
    }
    job.step = null;
    if (job.cancel) throw cancelled();
    job.step = step;
  }
  function cancel() {
    followups.cancel();
    if (current && ['applying', 'waiting'].includes(current.state)) {
      current.cancel = true;
      current.resolveAnswer?.(false);
    }
    return snapshot();
  }
  async function question(job, proposal) {
    checkpoint(job, 'question');
    if (!object(proposal.preview) || !Object.keys(proposal.preview).length
      || (proposal.type !== undefined && proposal.type !== 'boolean')) {
      throw installError(400, 'Install question requires a typed preview.');
    }
    job.question = clean({ ...proposal, questionId: randomUUID(), type: 'boolean' });
    job.state = 'waiting';
    const answer = await new Promise((resolve) => { job.resolveAnswer = resolve; });
    job.resolveAnswer = null;
    job.question = null;
    job.state = 'applying';
    checkpoint(job, 'answer');
    return answer;
  }
  function answer(input) {
    shape(input, ['jobId', 'questionId', 'answer']);
    if (!id(input.jobId) || !id(input.questionId) || typeof input.answer !== 'boolean') {
      throw installError(400, 'Invalid install request.');
    }
    if (input.jobId !== current?.id || input.questionId !== current?.question?.questionId
      || !current.resolveAnswer) throw installError(409, 'Install question expired; poll again.');
    const resolve = current.resolveAnswer;
    current.resolveAnswer = null;
    current.question = null;
    resolve(input.answer);
    return { accepted: true };
  }
  async function perform(job, approved, release) {
    try {
      const output = (stage, status) => (message) => event(job,
        { stage, client: job.client ?? null, status, messageKey: stage, params: { message } });
      const runContext = { ...ctx, out: output('output', 'info'), err: output('error', 'failed') };
      const lifecycle = execute === installerCommand
        ? (await import('../cli.js')).installerLifecycle(runContext, io) : {};
      for (const entry of approved.entries) {
        checkpoint(job, 'client');
        job.client = entry.plan.clients[0]?.client;
        const outcome = job.clients.find((row) => row.client === job.client);
        const ui = createStructuredPresenter({ locale });
        // Stream typed presenter events into bounded job history; retain no second event buffer.
        ui.events.push = (...values) => { values.forEach((v) => event(job, v)); return 0; };
        ui.confirm = (_read, proposal) => question(job, { message: proposal.question,
          preview: { mutations: entry.plan.mutations, explain: proposal.explain ?? [] } });
        const unsupported = () => { throw installError(400, 'Install question requires a typed preview.'); };
        if (approved.operation === 'models') { outcome.state = 'ok'; checkpoint(job, null); continue; }
        const code = await execute(approved.operation === 'repair' ? 'install' : approved.operation, [...entry.args, '--no-panel', '--no-execution-policy'],
          runContext,
          { ...io, ...lifecycle, ui, tty: false, deferFollowups: true, read: unsupported, ask: unsupported,
            question: (proposal) => question(job, proposal), checkpoint: (step) => checkpoint(job, step) });
        if (code !== 0) {
          outcome.state = job.cancel ? 'cancelled' : 'failed';
          // The reason the run gave for its refusal (the `failure` call of the presenter), so the screen can say it per client.
          const refusal = job.events.findLast((item) => item.stage === 'failure')?.params?.args?.[0];
          if (!job.cancel && typeof refusal?.reason === 'string') outcome.reason = localizeReason(refusal.reason, locale);
          job.state = job.cancel ? 'cancelled' : 'failed'; break;
        }
        outcome.state = 'ok';
        checkpoint(job, null);
      }
      if (job.state === 'applying') job.state = job.cancel ? 'cancelled' : 'succeeded';
    } catch (error) {
      job.state = job.cancel ? 'cancelled' : 'failed';
      const outcome = job.clients.find((row) => row.client === job.client);
      if (outcome && outcome.state !== 'ok') {
        outcome.state = job.cancel ? 'cancelled' : 'failed';
        outcome.reason = localizeReason(error.message, locale);
      }
      event(job, { stage: 'result', client: null, status: job.state,
        messageKey: 'install-failed', params: { reason: localizeReason(error.message, locale) } });
    } finally {
      job.question = null;
      job.result = clean({ state: job.state, clients: job.clients,
        completed: job.completed, remaining: job.remaining });
      try { await release(); }
      catch (error) {
        job.state = 'failed';
        job.result = clean({ ...job.result, state: 'failed', reason: localizeReason(error.message, locale) });
      }
      event(job, { stage: 'result', client: null, status: job.state,
        messageKey: 'install-result', params: job.result });
      job.running = false;
    }
  }
  async function startApply(input) {
    shape(input, ['planId', 'consent', 'idempotencyKey']);
    if (!id(input.planId) || input.consent !== true || !id(input.idempotencyKey)) {
      throw installError(400, 'Invalid install request.');
    }
    const existing = jobs.get(input.idempotencyKey);
    if (existing) {
      if (existing.planId !== input.planId) throw installError(409, 'Idempotency key belongs to another plan.');
      return snapshot(0, existing);
    }
    if (closing || active() || jobs.size >= maxJobs) throw installError(409, 'Install session is busy; poll or reopen after completion.');
    applying = true;
    let release;
    try {
      prune();
      const approved = plans.get(input.planId);
      if (!approved) throw installError(409, 'stale-plan');
      // Everything is compared before the lock; the lock may create its own folder (and so change that folder's
      // listing and its parent's), so after it only changes outside those two paths can make a plan stale.
      for (const entry of approved.entries) {
        if (!(await compare(entry.plan, { ...io, env })).matches) throw installError(409, 'stale-plan');
      }
      release = await lock(root);
      const lockPaths = new Set([resolve(root), dirname(resolve(root))]);
      for (const entry of approved.entries) {
        const { changed = [] } = await compare(entry.plan, { ...io, env });
        if (changed.some((path) => !lockPaths.has(path))) throw installError(409, 'stale-plan');
      }
      if (!approved.plan.reviewable) throw installError(409, 'Install preview is incomplete; review again.');
      if (closing) throw cancelled();
      current = { id: randomUUID(), planId: input.planId, state: 'applying', running: true, events: [], seq: 0,
        clients: approved.entries.map((entry) => ({ client: entry.plan.clients[0]?.client, state: 'skipped' })), followups: [],
        completed: [], remaining: approved.entries.flatMap((e) => e.plan.events
          .filter((v) => v.stage === 'sequence').flatMap((v) => v.params.keys
            .map((key) => `${e.plan.clients[0]?.client}:${key}`))), question: null, result: null };
      jobs.set(input.idempotencyKey, current);
      const held = release;
      release = null;
      current.done = perform(current, approved, held);
      return snapshot();
    } finally { applying = false; if (release) await release(); }
  }
  function apply(input) {
    shape(input, ['planId', 'consent', 'idempotencyKey']);
    if (!id(input.planId) || input.consent !== true || !id(input.idempotencyKey)) {
      throw installError(400, 'Invalid install request.');
    }
    const previous = pending.get(input.idempotencyKey);
    if (previous) {
      if (previous.planId !== input.planId) throw installError(409, 'Idempotency key belongs to another plan.');
      return previous.promise;
    }
    const promise = startApply(input).finally(() => pending.delete(input.idempotencyKey));
    pending.set(input.idempotencyKey, { planId: input.planId, promise });
    return promise;
  }
  return { plan, apply, answer, cancel, snapshot, active, recorded,
    'followup-plan': followups.plan, followup: followups.apply,
    async close() {
      closing = true; cancel();
      await Promise.allSettled([...pending.values()].map((p) => p.promise));
      cancel(); await current?.done;
      await followups.close();
    } };
}
