import { configOf } from '../../profiles.js';
import { listActors } from '../../actors.js';
import { inboxAdd, inboxList } from '../../inbox.js';
import { smokePreflight } from '../client.js';
import { loadScenario, validateScenario, createScratch } from './scenario.js';
import { resolveLimits, ledger } from './budget.js';
import { reportText } from './report.js';
import { executeDemands } from './run.js';
import { record } from '../../telemetry/index.js';

// No environment detection or real driver: entry points must supply one snapshot.
export async function runDemo(options = {}) {
  const { snapshot, actor, critic, client = snapshot?.inUse, locale = 'en', mode = 'test',
    clock = () => Date.now(), signal, onNarration = () => {}, exportReport } = options;
  const pt = locale === 'pt-BR';
  const result = { version: 1, mode, client, status: 'refused', reasons: [], limits: null,
    quotaEvidence: null, confirmed: false, demands: [], overheadUsd: 0,
    costUsd: 0, reservedUsd: 0, events: [], cleanup: { removed: false } };
  const say = (en, br) => {
    const event = { seq: result.events.length + 1, at: clock(), text: pt ? br : en };
    result.events.unshift(event);
    try { onNarration(event.text); } catch (error) { result.reasons.push(`narration: ${error.message}`); }
  };
  let scratch, budget;
  const exportCurrent = async (stage) => {
    result.exitCode = result.status === 'pass' ? 0 : result.status === 'refused' ? 2 : 1;
    if (exportReport) await exportReport({ json: structuredClone(result), text: reportText(result, locale) }, { stage });
  };
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    say('I am checking which helpers are available.', 'Estou verificando quais ajudantes estão disponíveis.');
    if (!snapshot) throw new Error('environment snapshot required');
    const config = configOf(snapshot.config);
    const scenario = validateScenario(options.scenario ?? await loadScenario());
    result.limits = resolveLimits(config.smoke, scenario.demands.length);
    budget = ledger(result.limits);
    scratch = await createScratch(scenario, config);
    result.cleanup.root = scratch.root;
    const preflight = smokePreflight(snapshot, client, result.limits);
    result.quotaEvidence = preflight.observed ?? null;
    if (mode !== 'test' && !config.smoke.demoRequireQuotaConfirmation) throw new Error('real mode requires quota confirmation');
    if (preflight.refusal || preflight.stale) throw new Error(preflight.refusal ?? 'quota evidence needs refresh');
    const actors = (await listActors({ snapshot, client, locale })).actors;
    if (mode === 'test' && (!actor?.run || !critic?.review)) throw new Error('injected actor and critic required');
    for (const demand of scenario.demands) {
      const item = await inboxAdd(scratch.state, { title: demand.title[locale], body: demand.body.en,
        kind: demand.kind, accept: demand.acceptance.map((check) => `${check.path}: ${check.text}`),
        appliesTo: scratch.root });
      result.demands.push({ key: demand.key, title: demand.title[locale], size: demand.expectedSize,
        class: null, classificationReasons: [], actor: null, profile: null, slots: [],
        verdict: 'pending', reworkRounds: 0, costUsd: 0, costKnown: true, attempts: [],
        skipReason: null, inboxId: item.id });
    }
    await inboxList(scratch.state);
    say('I have prepared five practice tasks.', 'Preparei cinco trabalhos de exemplo.');
    if (mode !== 'test') {
      // Step 3 owns consent and real launch adapters. Injection never enables paid work.
      if (!options.confirmed) throw new Error('explicit quota confirmation required');
      result.status = 'partial';
      for (const row of result.demands) { row.verdict = 'skipped'; row.skipReason = pt ? 'Lançamento pago indisponível.' : 'Paid launch unavailable.'; }
    } else {
      say('This test uses injected helpers without allowance.', 'Este teste usa ajudantes injetados sem consumir cota.');
      result.status = 'pass';
      await executeDemands({ options, config, scenario, scratch, result, actors, budget,
        say, clock, controller, client, locale, startedAt: clock() });
    }
  } catch (error) {
    result.reasons.push(error.message);
    if (result.status !== 'refused') result.status = 'partial';
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (budget) Object.assign(result, budget.snapshot());
    if (result.status !== 'pass') say('The practice run has stopped.', 'A execução de exemplo foi interrompida.');
    if (scratch) {
      try { await exportCurrent('before-cleanup'); }
      catch (error) { result.status = 'partial'; result.reasons.push(`report export: ${error.message}`); }
      try {
        await scratch.cleanup(); result.cleanup.removed = true;
        say('The practice folder has been removed.', 'A pasta de exemplo foi removida.');
      } catch (error) { result.status = 'partial'; result.reasons.push(`cleanup: ${error.message}`); }
    }
  }
  await exportCurrent('final');
  if (options.root) await record(options.root, 'smoke.report', {
    state: result.status, count: result.demands.length, client,
  });
  const text = reportText(result, locale);
  return { ...result, text };
}
