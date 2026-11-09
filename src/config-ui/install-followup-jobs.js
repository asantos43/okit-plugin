import { randomUUID } from 'node:crypto';
import { prepareFollowup, sameFollowup } from './install-followups.js';
import { sensitive } from './state.js';
import { createStructuredPresenter, localizeReason } from '../install/present.js';

const id = (value) => typeof value === 'string' && /^[\w-]{1,128}$/.test(value);
export function createFollowupJobs({ getJob, busy, ctx, io, lock, clean, event, fail,
  now, ttl, limit, maxRuns, locale }) {
  const plans = new Map(), runs = new Map();
  let running, closing = false;
  const prepare = (input) => {
    const ui = createStructuredPresenter({ locale });
    ui.events.push = (...values) => { values.forEach((value) => event(getJob(), value)); return 0; };
    return prepareFollowup(input, ctx, { ...io, ui }, fail);
  };
  function shape(input, keys) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !keys.includes(key))) throw fail(400, 'Invalid install request.');
  }
  function requireJob(input) {
    const job = getJob();
    if (!id(input.jobId) || input.jobId !== job?.id
      || !job.clients.some((row) => row.client === input.client && row.state === 'ok')) throw fail(409, 'stale-plan');
    return job;
  }
  async function plan(input) {
    shape(input, ['jobId', 'kind', 'client', ...(input?.kind === 'setup' ? ['profiles', 'expectedMtime'] : [])]);
    if (!['setup', 'panel', 'policy'].includes(input.kind)
      || !['claude-code', 'codex', 'opencode'].includes(input.client)) throw fail(400, 'Invalid install request.');
    if (input.kind === 'panel' && input.client !== 'claude-code') throw fail(400, 'Invalid install request.');
    requireJob(input);
    if (closing || busy()) throw fail(409, 'Install session is busy; poll or reopen after completion.');
    if (input.kind === 'setup') validateProfiles(input);
    for (const [key, entry] of plans) if (entry.expires <= now()) plans.delete(key);
    if (plans.size >= limit) throw fail(409, 'Install session is full or closing; reopen and review again.');
    const proposal = await prepare(input);
    requireJob(input);
    if (closing || busy() || plans.size >= limit) throw fail(409, 'Install session is busy; poll or reopen after completion.');
    const followupId = randomUUID();
    plans.set(followupId, { input: structuredClone(input), proposal, expires: now() + ttl });
    return clean({ followupId, jobId: input.jobId, preview: proposal.preview });
  }
  function validateProfiles(input) {
    if (!(input.expectedMtime === null || typeof input.expectedMtime === 'number' && Number.isFinite(input.expectedMtime))
      || !Array.isArray(input.profiles) || !input.profiles.length || input.profiles.length > 3) throw fail(400, 'Invalid install request.');
    const classes = new Set();
    for (const profile of input.profiles) {
      shape(profile, ['class', 'model', 'effort', 'confirm']);
      if (!['simple', 'normal', 'hard'].includes(profile.class) || classes.has(profile.class)
        || typeof profile.model !== 'string' || !profile.model.trim() || profile.model !== profile.model.trim()
        || profile.model.length > 256 || /[\0\r\n]/.test(profile.model) || sensitive('', profile.model)
        || typeof profile.effort !== 'string' || profile.confirm !== undefined && typeof profile.confirm !== 'boolean') {
        throw fail(400, 'Invalid install request.');
      }
      classes.add(profile.class);
    }
  }
  function apply(input) {
    shape(input, ['jobId', 'kind', 'followupId', 'consent', 'idempotencyKey']);
    if (!id(input.jobId) || !id(input.followupId) || !id(input.idempotencyKey) || input.consent !== true
      || !['setup', 'panel', 'policy'].includes(input.kind)) throw fail(400, 'Invalid install request.');
    if (input.jobId !== getJob()?.id) throw fail(409, 'stale-plan');
    const previous = runs.get(input.idempotencyKey);
    if (previous) {
      if (previous.followupId !== input.followupId || previous.kind !== input.kind) throw fail(409, 'Idempotency key belongs to another plan.');
      return previous.promise;
    }
    const approved = plans.get(input.followupId);
    if (!approved || approved.expires <= now() || approved.used || approved.input.jobId !== input.jobId
      || approved.input.kind !== input.kind) throw fail(409, 'stale-plan');
    if (closing || busy() || runs.size >= maxRuns) throw fail(409, 'Install session is busy; poll or reopen after completion.');
    const promise = start(input, approved);
    // Keep rejected validation attempts from producing an unhandled rejection
    // when a caller disconnects; the original promise still rejects to callers.
    void promise.catch(() => {});
    runs.set(input.idempotencyKey, { ...input, promise });
    return promise;
  }
  async function start(input, approved) {
    const job = requireJob(approved.input);
    const operation = { followupId: input.followupId, kind: input.kind,
      client: approved.input.client, state: 'applying', completed: [], remaining: [], result: null };
    running = operation;
    let release;
    try {
      release = await lock(ctx.root);
      const fresh = await prepare(approved.input);
      if (!sameFollowup(approved.proposal, fresh)) throw fail(409, 'stale-plan');
      if (closing || operation.cancelRequested) throw fail(409, 'Install cancelled at a safe boundary.');
      approved.used = true;
      job.followups.push(operation);
      job.followupDone = perform(job, operation, fresh, release);
      release = null;
      return clean(operation);
    } catch (error) {
      running = null;
      throw error;
    } finally { if (release) await release(); }
  }
  async function perform(job, operation, proposal, release) {
    let step;
    const checkpoint = (next) => {
      if (step) operation.completed.push(step);
      step = null;
      operation.remaining = next ? [next] : [];
      if (operation.cancelRequested) throw fail(409, 'Install cancelled at a safe boundary.');
      step = next;
    };
    try {
      operation.result = clean(await proposal.execute(checkpoint));
      operation.state = 'succeeded';
    } catch (error) {
      operation.state = operation.cancelRequested ? 'cancelled' : 'failed';
      operation.reason = clean(localizeReason(error.message, locale));
    } finally {
      try { await release(); } catch (error) { operation.state = 'failed'; operation.reason = clean(localizeReason(error.message, locale)); }
      event(job, { stage: 'followup', client: operation.client, status: operation.state,
        messageKey: 'install-followup', params: clean(operation) });
      running = null;
    }
  }
  return { plan, apply, active: () => Boolean(running),
    cancel: () => { if (running) running.cancelRequested = true; },
    close: async () => { closing = true; if (running) running.cancelRequested = true;
      await Promise.allSettled([...runs.values()].map((entry) => entry.promise));
      await getJob()?.followupDone; } };
}
