import { classify } from '../../classify.js';
import { profilePick } from '../../profiles.js';
import { inboxSetStatus } from '../../inbox.js';
import { capOf } from '../../limits.js';
import { attempt, checksFor } from './attempt.js';
import { writeFile } from 'node:fs/promises';
import { safeFile } from './scenario.js';

export async function executeDemands(ctx) {
  const { result, scenario, config, client, actors, scratch, say, controller } = ctx;
  const cap = capOf(config.limits, client).cap;
  say(cap > 1 ? 'Independent tasks can be done together.' : 'One place is available; tasks will run in sequence.',
    cap > 1 ? 'Trabalhos independentes podem ser feitos juntos.' : 'Há uma vaga; os trabalhos serão feitos em sequência.');
  const pending = new Set(result.demands);
  const active = new Set();
  const skip = (row, reason) => { row.verdict = 'skipped'; row.skipReason = reason; result.status = 'partial'; };
  const run = async (row, demand) => {
    try { await executeDemand(ctx, row, demand); }
    catch (error) { skip(row, error.message); controller.abort(error); result.reasons.push(error.message); }
  };
  while (pending.size || active.size) {
    if (controller.signal.aborted) {
      for (const row of pending) {
        const demand = scenario.demands.find((item) => item.key === row.key);
        if (demand.dependsOn.some((key) => result.demands.some((item) => item.key === key
          && ['failed', 'skipped'].includes(item.verdict)))) continue;
        skip(row, ctx.locale === 'pt-BR' ? 'Execução interrompida.' : 'Run interrupted.');
      }
      for (const row of [...pending]) if (row.verdict === 'skipped') pending.delete(row);
    }
    for (const row of pending) {
      const demand = scenario.demands.find((item) => item.key === row.key);
      const dependencies = demand.dependsOn.map((key) => result.demands.find((item) => item.key === key));
      if (dependencies.some((item) => ['failed', 'skipped'].includes(item.verdict))) {
        skip(row, ctx.locale === 'pt-BR' ? 'Dependência não aprovada.' : 'Dependency not approved.'); pending.delete(row); continue;
      }
      if (active.size >= cap || dependencies.some((item) => item.verdict !== 'approved')) continue;
      pending.delete(row);
      const task = run(row, demand).finally(() => active.delete(task)); active.add(task);
    }
    if (active.size) await Promise.race(active);
    else if (pending.size) throw new Error('blocked dependencies');
  }
}

async function executeDemand(ctx, row, demand) {
  const { result, actors, client, config, scratch, say, locale, controller } = ctx;
  const classification = classify({ title: demand.title.en, body: demand.body.en, kind: demand.kind });
  row.class = classification.effort; row.classificationReasons = classification.reasons;
  const profile = profilePick({ client, effort: row.class, quota: result.quotaEvidence, config });
  const executor = actors.find((actor) => actor.client === client && actor.confirmed && actor.canLaunch
    && actor.sizes.includes(row.size) && actor.model === profile.model && actor.effort === profile.effort);
  const reviewer = actors.find((actor) => actor.client === client && actor.confirmed && actor.canLaunch && actor.critic);
  if (!executor || !reviewer) throw new Error(locale === 'pt-BR' ? 'Ajudante ou crítico indisponível.' : 'Helper or critic unavailable.');
  row.actor = { client, model: profile.model, effort: profile.effort };
  row.profile = { ...profile, origin: 'snapshot' };
  say(`I have chosen a helper for ${row.title}.`, `Escolhi um ajudante para ${row.title}.`);
  let failedCriteria = [], delegated = false;
  for (let round = 0; round <= result.limits.demoMaxReworkRounds; round += 1) {
    const execution = await attempt(ctx, row, demand, 'Executor', row.actor, profile, round, failedCriteria,
      async () => { if (!delegated) { await inboxSetStatus(scratch.state, row.inboxId, 'delegated'); delegated = true; } });
    if (execution.status !== 'completed') throw new Error('executor did not complete');
    if (round === 0 && demand.fault) {
      await writeFile(await safeFile(scratch.root, `work/${demand.key}/${demand.fault.path}`), demand.fault.text);
      row.attempts.at(-1).injection = { ...demand.fault, applied: true };
    }
    const checks = await checksFor(scratch.root, demand);
    const reviewActor = { client, model: reviewer.model, effort: reviewer.effort };
    const review = await attempt(ctx, row, demand, 'Critic', reviewActor,
      config.profiles[client][config.actors.criticClass] ?? profile, round, failedCriteria, null, { execution, checks });
    const approved = checks.every((check) => check.passed) && review.verdict === 'approved';
    row.attempts.at(-1).criteria = checks; row.attempts.at(-1).verdict = approved ? 'approved' : 'rejected';
    if (approved) {
      await inboxSetStatus(scratch.state, row.inboxId, 'criticised');
      await inboxSetStatus(scratch.state, row.inboxId, 'consolidated'); row.verdict = 'approved';
      say(`${row.title} now passes.`, `${row.title} passou na verificação.`); return;
    }
    failedCriteria = checks.filter((check) => !check.passed);
    if (!failedCriteria.length) failedCriteria = review.criteria ?? [{ feedback: review.feedback }];
    say(`${row.title} needs correction.`, `${row.title} precisa de correção.`);
  }
  await inboxSetStatus(scratch.state, row.inboxId, 'failed'); row.verdict = 'failed';
  result.status = 'fail'; controller.abort(new Error('rework ceiling'));
}
