import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { acquireSlot, releaseSlot } from '../../limits.js';
import { smokePreflight } from '../client.js';
import { safeFile } from './scenario.js';
import { record as telemetryRecord } from '../../telemetry/index.js';
import { capture } from '../../trajectory/capture.js';

export async function checksFor(root, demand) {
  return Promise.all(demand.acceptance.map(async (check) => {
    const path = `work/${demand.key}/${check.path}`;
    const actual = await readFile(await safeFile(root, path), 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error; return null;
    });
    return { ...check, path, actual, passed: actual === check.text };
  }));
}

export async function attempt(ctx, row, demand, role, actor, profile, round, failedCriteria, before, review) {
  const { options, scratch, result, config, budget, controller, clock, say, client, locale } = ctx;
  if (controller.signal.aborted) throw new Error('run interrupted');
  const now = clock();
  const snapshot = { ...options.snapshot, now, clients: options.snapshot.clients.map((observation) => ({
    ...observation, quota: { ...observation.quota, ageMinutes: observation.quota.ageMinutes === null ? null
      : observation.quota.ageMinutes + Math.max(0, now - options.snapshot.now) / 60_000 },
  })) };
  const quota = smokePreflight(snapshot, client, result.limits);
  if (options.root) {
    await telemetryRecord(options.root, 'quota.check', { client, state: quota.refusal || quota.stale ? 'red' : 'green' });
    await telemetryRecord(options.root, 'role.choice', { role, client });
    await telemetryRecord(options.root, 'profile.choice', { client, model: actor.model, effort: actor.effort });
  }
  if (quota.refusal || quota.stale) throw new Error(quota.refusal ?? 'quota needs refresh');
  const driver = role === 'Executor' ? options.actor : options.critic;
  const room = budget.remaining(row.key);
  const cap = driver.maxCostUsd ?? 0; // Injected calls are free unless explicitly simulating cost.
  const ticket = budget.reserve(row.key, cap);
  const runId = `${row.key}-${row.attempts.length}-${role.toLowerCase()}-${randomUUID()}`;
  const slot = { attempt: row.attempts.length + 1, runId };
  row.slots.push(slot);
  let launched = false, settled = false;
  const criticOf = role === 'Critic' ? row.attempts.findLast(item => item.role === 'Executor')?.runId ?? null : null;
  const record = { runId, role, actor, profile: { ...profile, origin: 'snapshot' }, start: clock(), end: null,
    reservedUsd: cap, costUsd: null, artifacts: [] };
  let timer;
  let transcript = null, summary = null, usage;
  try {
    slot.acquired = await acquireSlot(scratch.state, runId, { client, config,
      waitMs: Math.min(result.limits.checkTimeoutMs, Math.max(0,
        result.limits.maxMinutes * 60_000 - (clock() - ctx.startedAt))) });
    if (!slot.acquired.ok) { budget.settle(ticket, null, false); settled = true; throw new Error('slot unavailable'); }
    say(`A helper has a place to work on ${row.title}.`, `Um ajudante tem uma vaga para ${row.title}.`);
    if (controller.signal.aborted) throw new Error('run interrupted');
    const remainingMs = result.limits.maxMinutes * 60_000 - (clock() - ctx.startedAt);
    if (remainingMs <= 0) throw new Error('time ceiling');
    const outputPaths = demand.files.map((file) => `work/${demand.key}/${file.path}`);
    const dependencies = demand.dependsOn.flatMap((key) => {
      const dependency = ctx.scenario.demands.find((item) => item.key === key);
      return dependency.files.map((file) => `work/${key}/${file.path}`);
    });
    const briefing = { role, title: row.title, goal: demand.body[locale], demand,
      size: row.size, class: row.class, classificationReasons: row.classificationReasons,
      actor, profile, root: scratch.root, cwd: join(scratch.root, 'work', demand.key),
      env: scratch.env, allowedOutputPaths: outputPaths, approvedDependencyArtifacts: dependencies,
      acceptance: demand.acceptance, attempt: row.attempts.length + 1, reworkRound: round,
      failedCriteria, limits: { maxUsd: cap, maxTurns: Math.min(profile.maxTurns ?? result.limits.maxTurns,
        result.limits.maxTurns - budget.snapshot().turns + 1), timeoutMs: Math.min(remainingMs, result.limits.checkTimeoutMs) },
      remainingBudget: room, signal: controller.signal,
      requiredResult: role === 'Executor' ? '{status, summary, artifacts, usage}' : '{verdict, criteria, feedback, usage}',
      text: `${locale === 'pt-BR' ? 'Papel' : 'Role'}: ${role}\n${row.title}\n${demand.body[locale]}\n${locale === 'pt-BR' ? 'Trabalhe só na pasta de exemplo. Devolva arquivos e verificações.' : 'Work only in the practice folder. Return files and checks.'}` };
    timer = setTimeout(() => controller.abort(new Error('time ceiling')), briefing.limits.timeoutMs);
    await before?.(); launched = true; row.attempts.push(record);
    if (role === 'Executor' && round > 0) row.reworkRounds += 1;
    say(`${role === 'Executor' ? 'A helper is working on' : 'A reviewer is checking'} ${row.title}.`,
      `${role === 'Executor' ? 'Um ajudante está executando' : 'Um crítico está verificando'} ${row.title}.`);
    const response = role === 'Executor' ? await driver.run(briefing)
      : await driver.review({ briefing, result: review.execution, artifacts: review.execution.artifacts, checks: review.checks });
    transcript = response.transcript ?? null;
    summary = response.summary ?? response.feedback ?? response.verdict ?? response.status ?? null;
    if (transcript == null) usage = { cost_usd: response.usage?.costUsd };
    settled = true; record.costUsd = budget.settle(ticket, response.usage);
    if (record.costUsd === null) { row.costUsd = null; row.costKnown = false; }
    else row.costUsd += record.costUsd;
    if (response.usage.turns > briefing.limits.maxTurns) throw new Error('profile turn ceiling');
    if (controller.signal.aborted) throw new Error('run interrupted');
    if (role === 'Executor') {
      for (const artifact of response.artifacts ?? []) {
        if (!outputPaths.includes(artifact.path) || typeof artifact.content !== 'string') throw new Error('unsafe artifact');
        const target = await safeFile(scratch.root, artifact.path);
        await mkdir(dirname(target), { recursive: true }); await writeFile(target, artifact.content);
        record.artifacts.push(artifact.path);
      }
    }
    return response;
  } catch (error) {
    if (launched && !settled) {
      try { budget.settle(ticket, null); } catch { /* Keep unresolved reservation visible. */ }
      row.costKnown = false; row.costUsd = null;
    } else if (!launched && !settled) budget.settle(ticket, null, false);
    if (launched && record.costUsd === null) { row.costKnown = false; row.costUsd = null; }
    record.error = error.message; throw error;
  } finally {
    clearTimeout(timer); record.end = clock();
    if (launched && options.root) {
      await capture(options.root, { session_id: runId, client, model: actor.model,
        effort: actor.effort, role: role.toLowerCase(), demand: row.key,
        step: round, critic_of: criticOf }, { transcript,
        message: demand.body[locale], outcome: record.error ?? summary, usage });
    }
    if (slot.acquired?.ok) {
      slot.released = await releaseSlot(scratch.state, runId);
      say(`The helper's place for ${row.title} is free again.`, `A vaga do ajudante para ${row.title} está livre de novo.`);
    }
  }
}
