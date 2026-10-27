import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, readFile, writeFile, unlink, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { loadScenario, validateScenario, createScratch } from '../src/smoke/demo/scenario.js';
import { classify } from '../src/classify.js';
import { configOf } from '../src/profiles.js';
import { actorPairs } from '../src/env/snapshot.js';
import { runDemo } from '../src/smoke/demo/index.js';
import { limitsStatus } from '../src/limits.js';
import { inboxList } from '../src/inbox.js';
import { ledger, resolveLimits } from '../src/smoke/demo/budget.js';
import { reportText } from '../src/smoke/demo/report.js';
import { attempt } from '../src/smoke/demo/attempt.js';

// | Input | Must pass | Must refuse |
// | token limit | null or positive safe integer | zero, negative, fractional, unsafe, missing |
// | measured tokens | zero or non-negative safe integer | missing/invalid with a ceiling |
// | next reservation | below ceiling | at/above ceiling or unresolved usage |
test('demo token limits preserve null and positive safe integers and reject invalid limits', () => {
  const smoke = configOf().smoke;
  for (const maxTokens of [null, 1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(resolveLimits({ ...smoke, maxTokens }, 5).maxTokens, maxTokens);
  }
  for (const maxTokens of [undefined, 0, -1, 0.5, NaN, Infinity, '10', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => resolveLimits({ ...smoke, maxTokens }, 5), /invalid maxTokens/);
  }
});

test('token ceiling refuses reservations at equality and after an overshoot', () => {
  for (const tokens of [10, 11]) {
    const budget = ledger(resolveLimits({ ...configOf().smoke, maxTokens: 10 }, 5));
    budget.settle(budget.reserve('first', 0), { costUsd: 0, turns: 1, tokens });
    assert.equal(budget.snapshot().tokens, tokens);
    assert.throws(() => budget.reserve('next', 0), /ceiling/);
  }
});

test('unknown token usage with a ceiling prevents any further reservation', () => {
  for (const tokens of [undefined, null, -1, 0.5, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER + 1]) {
    const budget = ledger(resolveLimits({ ...configOf().smoke, maxTokens: 10 }, 5));
    assert.throws(() => budget.settle(budget.reserve('first', 0), { costUsd: 0, turns: 1, tokens }),
      /unresolved usage or unenforced ceiling/);
    assert.equal(budget.snapshot().costUsd, null);
    assert.throws(() => budget.reserve('next', 0), /ceiling/);
  }
});

test('optional tokens and unlaunched tickets preserve money accounting', () => {
  const budget = ledger(resolveLimits(configOf().smoke, 5));
  budget.settle(budget.reserve('first', 0.01), { costUsd: 0.005, turns: 1 });
  assert.equal(budget.snapshot().costUsd, 0.005);
  const bounded = ledger(resolveLimits({ ...configOf().smoke, maxTokens: 10 }, 5));
  bounded.settle(bounded.reserve('cancelled', 0.01), undefined, false);
  bounded.settle(bounded.reserve('first', 0), { costUsd: 0, turns: 1, tokens: 0 });
  assert.equal(bounded.snapshot().tokens, 0);
  assert.equal(bounded.snapshot().turns, 1);
  bounded.reserve('next', 0);
});

test('a configured token ceiling requires tokens from money-reporting clients too', () => {
  for (const maxTokens of [10, null]) {
    const limits = resolveLimits({ ...configOf().smoke, maxTokens }, 5);
    assert.equal(Object.hasOwn(limits, 'reportsCost'), false);
    const budget = ledger(limits), ticket = budget.reserve('first', 0.01);
    const settle = () => budget.settle(ticket, { costUsd: 0.005, turns: 1 });
    if (maxTokens === null) {
      assert.equal(settle(), 0.005);
      assert.equal(budget.snapshot().costUsd, 0.005);
      assert.doesNotThrow(() => budget.reserve('next', 0));
    } else {
      assert.throws(settle, /unresolved usage or unenforced ceiling/);
      assert.equal(budget.snapshot().costUsd, null);
      assert.throws(() => budget.reserve('next', 0), /ceiling/);
    }
  }
});

test('two parallel reservations share one token ceiling across demands', async () => {
  const budget = ledger(resolveLimits({ ...configOf().smoke, maxTokens: 10 }, 5));
  const tickets = ['first', 'second'].map((key) => budget.reserve(key, 0));
  await Promise.all(tickets.map(async (ticket) => {
    await Promise.resolve();
    budget.settle(ticket, { costUsd: 0, turns: 1, tokens: 5 });
  }));
  assert.equal(budget.snapshot().tokens, 10);
  assert.equal(budget.snapshot().reservedUsd, 0);
  assert.throws(() => budget.reserve('third', 0), /ceiling/);
});

test('clients without money reports settle tokens and expose null cost in the summary', () => {
  const limits = { ...resolveLimits({ ...configOf().smoke, maxTokens: 10 }, 5), reportsCost: false };
  const budget = ledger(limits);
  assert.equal(budget.settle(budget.reserve('first', limits.maxUsd + 1), { costUsd: null, turns: 1, tokens: 10 }), null);
  assert.deepEqual(budget.snapshot(), { costUsd: null, reservedUsd: 0, turns: 1, tokens: 10, reportsCost: false });
  assert.throws(() => budget.reserve('next', 0), /ceiling/);
});

test('no-money driver attempts keep demand and attempt JSON costs unknown', async () => {
  const deps = fixture({ smoke: { maxTokens: 10 } });
  deps.actor.run = async () => ({ status: 'completed', artifacts: [], usage: { turns: 1, tokens: 2 } });
  const scenario = await loadScenario(), demand = scenario.demands[0];
  const scratch = await createScratch(scenario, deps.snapshot.config);
  const limits = { ...resolveLimits(deps.snapshot.config.smoke, 5), reportsCost: false };
  const budget = ledger(limits), result = { limits };
  const row = { key: demand.key, title: demand.title.en, size: 'S', class: 'simple',
    classificationReasons: [], slots: [], attempts: [], reworkRounds: 0, costUsd: 0, costKnown: true };
  const ctx = { options: deps, scratch, result, config: deps.snapshot.config, budget,
    scenario, controller: new AbortController(), clock: deps.clock, say() {}, client: 'codex', locale: 'en', startedAt: 1000 };
  try {
    for (let round = 0; round < 2; round += 1) {
      await attempt(ctx, row, demand, 'Executor', deps.snapshot.clients[0].candidates[0], {}, round, []);
      const json = JSON.parse(JSON.stringify({ demands: [row], ...budget.snapshot() }));
      assert.equal(json.costUsd, null);
      assert.equal(json.demands[0].costUsd, null);
      assert.equal(json.demands[0].costKnown, false);
      assert.ok(json.demands[0].attempts.every((record) => record.costUsd === null));
    }
  } finally { await scratch.cleanup(); }
});

test('no-money text reports localize unavailable cost and show tokens used against the ceiling', () => {
  const limits = { ...resolveLimits({ ...configOf().smoke, maxTokens: 10 }, 5), reportsCost: false };
  const budget = ledger(limits);
  budget.settle(budget.reserve('first', 0), { turns: 1, tokens: 3 });
  const result = { ...budget.snapshot(), limits, status: 'partial', events: [], demands: [
    { title: 'Example', verdict: 'approved', reworkRounds: 0, costKnown: true, costUsd: 0 },
  ] };
  for (const locale of ['en', 'pt-BR']) {
    const text = reportText(result, locale);
    assert.match(text, locale === 'en' ? /Money is not reported by this client\./ : /Este cliente não informa custo em dinheiro\./);
    assert.doesNotMatch(text, locale === 'en' ? /Este cliente|máximo/ : /Money is|\/ max /);
    assert.match(text, locale === 'en' ? /tokens: 3 \/ max 10/ : /tokens: 3 \/ máximo 10/);
    assert.match(text, locale === 'en' ? /cost: not reported/ : /custo: não informado/);
    assert.doesNotMatch(text, /USD|unknown|desconhecido/);
  }
  assert.equal(result.costUsd, null);
});

test('explicit money-reporting clients retain cost enforcement and measured totals', () => {
  const limits = { ...resolveLimits(configOf().smoke, 5), reportsCost: true };
  const budget = ledger(limits);
  budget.settle(budget.reserve('first', 0.01), { costUsd: 0.005, turns: 1, tokens: 4 });
  assert.equal(budget.snapshot().costUsd, 0.005);
  assert.equal(budget.snapshot().reportsCost, true);
  assert.throws(() => budget.reserve('first', limits.demoDemandMaxUsd), /ceiling/);
  assert.throws(() => budget.settle(budget.reserve('second', 0), { turns: 1 }), /unresolved usage/);
});

test('a settled budget ticket refuses a second settlement', () => {
  const budget = ledger(resolveLimits(configOf().smoke, 5));
  const ticket = budget.reserve('practice', 0);
  budget.settle(ticket, { costUsd: 0, turns: 1 });
  assert.throws(() => budget.settle(ticket, { costUsd: 0, turns: 1 }), /double settlement/);
  assert.equal(budget.snapshot().reservedUsd, 0);
});

test('failed prerequisite skips dependent work without calling its helper', async () => {
  for (const locale of ['en', 'pt-BR']) {
    const deps = fixture({ smoke: { demoMaxReworkRounds: 0 } });
    const calls = [], original = deps.actor.run;
    deps.actor.run = async (briefing) => { calls.push(briefing.demand.key); return original(briefing); };
    const result = await runDemo({ ...deps, locale });
    assert.equal(result.demands.find((row) => row.key === 'tickets').verdict, 'failed');
    const dependent = result.demands.find((row) => row.key === 'pack');
    assert.equal(dependent.verdict, 'skipped');
    assert.equal(dependent.skipReason, locale === 'pt-BR' ? 'Dependência não aprovada.' : 'Dependency not approved.');
    assert.equal(calls.includes('pack'), false);
    assert.equal(dependent.attempts.length, 0);
  }
});

const usage = { costUsd: 0, turns: 1 };
function fixture(overrides = {}) {
  const config = configOf({ limits: { global: 2 }, profiles: { codex: {
    simple: { model: 'small', effort: 'low' }, normal: { model: 'medium', effort: 'medium' },
    hard: { model: 'large', effort: 'high' }, critic: { model: 'reviewer', effort: 'high' },
  } }, ...overrides });
  const snapshot = { config, now: 1000, inUse: 'codex', plugin: { missing: [] }, clients: [{
    client: 'codex', quota: { source: 'user', remainingPct: 80, status: 'green', readAt: 1000, ageMinutes: 0 },
    reading: {}, slots: { available: 2 }, sizeCoverage: { gaps: [] },
    candidates: actorPairs(config, 'codex').map((pair) => ({ ...pair, confirmed: true, canLaunch: true, restrictions: [] })),
  }] };
  const actor = { async run(briefing) {
    assert.equal(briefing.role, 'Executor'); assert.match(briefing.text, /(?:Role|Papel): Executor/);
    assert.ok(briefing.env.HOME.startsWith(briefing.root + '/'));
    const inbox = await inboxList(briefing.env.OKWORK_HOME);
    assert.equal(inbox.find((item) => item.title === briefing.title).status, 'delegated');
    for (const key of briefing.demand.dependsOn) {
      const canonical = (await loadScenario()).demands.find((item) => item.key === key);
      assert.ok(inbox.some((item) => Object.values(canonical.title).includes(item.title) && item.status === 'consolidated'));
    }
    let artifacts = briefing.demand.files.map((file, index) => ({ path: briefing.allowedOutputPaths[index], content: file.content }));
    if (briefing.demand.key === 'guide') artifacts[0].content = `Arrival\n${await readFile(
      join(briefing.root, briefing.approvedDependencyArtifacts[0]), 'utf8')}Visit\nDeparture\n`;
    if (briefing.demand.key === 'pack') artifacts[0].content = (await Promise.all(
      briefing.approvedDependencyArtifacts.map((path) => readFile(join(briefing.root, path), 'utf8')))).join('');
    return { status: 'completed', summary: 'supplied files', artifacts, usage };
  } };
  const critic = { async review({ briefing, checks }) {
    assert.equal(briefing.role, 'Critic');
    return { verdict: checks.every((check) => check.passed) ? 'approved' : 'rejected', criteria: checks, feedback: '', usage };
  } };
  return { snapshot, actor, critic, clock: () => 1000 };
}

test('canonical corpus and disposable loader', async () => {
  const scenario = validateScenario(await loadScenario());
  for (const locale of ['en', 'pt-BR']) assert.deepEqual(scenario.demands.map((demand) =>
    classify({ title: demand.title[locale], body: demand.body[locale], kind: demand.kind }).effort),
  ['simple', 'simple', 'normal', 'normal', 'hard']);
  const scratch = await createScratch(scenario, configOf());
  try {
    assert.equal(JSON.parse(await readFile(join(scratch.root, 'scenario.json'))).version, 1);
    assert.ok(Object.values(scratch.env).every((path) => path.startsWith(scratch.root + '/')));
  } finally { await scratch.cleanup(); }
  await assert.rejects(access(scratch.root));
  for (const mutate of [
    (s) => { s.demands[0].files[0].path = '../escape'; },
    (s) => { s.demands[0].dependsOn = ['pack']; },
    (s) => { s.demands[0].acceptance[0].type = 'command'; },
    (s) => { s.demands[0].expectedSize = 'L'; },
  ]) { const bad = structuredClone(scenario); mutate(bad); assert.throws(() => validateScenario(bad)); }
});

test('parallel actors, planted fault, correction, slot release and matching reports', async () => {
  const deps = fixture();
  let active = 0, peak = 0, arrived = 0, unblock;
  const barrier = new Promise((resolve) => { unblock = resolve; });
  const original = deps.actor.run;
  deps.actor.run = async (briefing) => {
    active += 1; peak = Math.max(peak, active);
    const state = await limitsStatus(briefing.env.OKWORK_HOME, deps.snapshot.config);
    assert.ok(state.live <= 2);
    if (['card', 'hours'].includes(briefing.demand.key)) {
      arrived += 1; if (arrived === 2) unblock(); await barrier;
    }
    try { return await original(briefing); } finally { active -= 1; }
  };
  let exported; const stages = [];
  const result = await runDemo({ ...deps, exportReport: async (report, { stage }) => {
    stages.push(stage); exported = report;
    if (stage === 'before-cleanup') await access(report.json.cleanup.root);
    else await assert.rejects(access(report.json.cleanup.root));
  } });
  assert.equal(result.status, 'pass', JSON.stringify(result.reasons)); assert.equal(peak, 2);
  assert.deepEqual(result.demands.map((row) => row.size), ['S', 'S', 'M', 'M', 'L']);
  const tickets = result.demands.find((row) => row.key === 'tickets');
  assert.equal(tickets.reworkRounds, 1); assert.equal(tickets.attempts[0].injection.text, '11\n');
  assert.equal(tickets.attempts[1].criteria[0].actual, '11\n');
  assert.equal(tickets.attempts[1].verdict, 'rejected');
  assert.equal(tickets.attempts[3].criteria[0].actual, '12\n');
  assert.equal(result.costUsd, 0); assert.equal(result.reservedUsd, 0);
  assert.ok(result.demands.every((row) => row.slots.every((slot) => slot.acquired.ok && slot.released.ok)));
  assert.equal(new Set(result.demands.flatMap((row) => row.slots.map((slot) => slot.runId))).size, 12);
  assert.ok(result.events.every((event, index) => !index || event.seq < result.events[index - 1].seq));
  assert.ok(!result.text.includes('\n\n')); assert.ok(!result.text.includes('tickets-'));
  assert.equal(exported.json.status, result.status); assert.equal(exported.text, result.text);
  assert.deepEqual(stages, ['before-cleanup', 'final']);
  assert.equal(result.cleanup.removed, true); await assert.rejects(access(result.cleanup.root));
});

test('one slot serializes all executor and critic launches', async () => {
  const deps = fixture({ limits: { global: 3, clients: { codex: 1 } } });
  let calls = 0;
  const original = deps.actor.run;
  deps.actor.run = async (briefing) => {
    calls += 1;
    assert.equal((await limitsStatus(briefing.env.OKWORK_HOME, deps.snapshot.config)).live, 1);
    return original(briefing);
  };
  const result = await runDemo(deps);
  assert.equal(result.status, 'pass', JSON.stringify(result.reasons)); assert.equal(calls, 6);
});

test('failed byte checks override an approving critic and rework is bounded', async () => {
  const deps = fixture({ smoke: { demoMaxReworkRounds: 0 } });
  deps.critic.review = async () => ({ verdict: 'approved', criteria: [], usage });
  const result = await runDemo({ ...deps, locale: 'pt-BR' });
  const ticket = result.demands.find((row) => row.key === 'tickets');
  assert.equal(ticket.verdict, 'failed'); assert.equal(ticket.reworkRounds, 0);
  assert.equal(ticket.attempts.length, 2); assert.equal(ticket.attempts[1].verdict, 'rejected');
  assert.match(result.text, /PARCIAL: Pacote completo da visita/);
  assert.equal(result.cleanup.removed, true); await assert.rejects(access(result.cleanup.root));
});

test('an actor that never corrects stops at the configured round limit', async () => {
  const deps = fixture(); const original = deps.actor.run;
  deps.actor.run = async (briefing) => {
    const response = await original(briefing);
    if (briefing.demand.key === 'tickets') response.artifacts[0].content = '11\n';
    return response;
  };
  const result = await runDemo(deps); const ticket = result.demands.find((row) => row.key === 'tickets');
  assert.equal(ticket.verdict, 'failed'); assert.equal(ticket.reworkRounds, 1);
  assert.equal(ticket.attempts.length, 4); assert.notEqual(result.status, 'pass');
});

test('atomic simulated budget covers concurrent work, critics and corrections', async () => {
  const deps = fixture({ smoke: { maxUsd: 0.5, demoDemandMaxUsd: 0.5 } });
  const original = deps.actor.run, review = deps.critic.review;
  deps.actor.maxCostUsd = 0.2; deps.critic.maxCostUsd = 0.2;
  deps.actor.run = async (briefing) => ({ ...await original(briefing), usage: { costUsd: 0.2, turns: 1 } });
  deps.critic.review = async (args) => ({ ...await review(args), usage: { costUsd: 0.2, turns: 1 } });
  const result = await runDemo(deps);
  assert.equal(result.mode, 'test'); assert.equal(result.status, 'partial');
  assert.ok(result.costUsd <= 0.5); assert.equal(result.reservedUsd, 0);
  assert.equal(result.demands.reduce((total, row) => total + row.costUsd, 0), result.costUsd);
  assert.match(result.text, /PARTIAL/); await assert.rejects(access(result.cleanup.root));
});

test('demand budget includes the critic and rejects the next reservation', async () => {
  const deps = fixture({ limits: { global: 1 }, smoke: { demoDemandMaxUsd: 0.1 } });
  const original = deps.actor.run;
  deps.actor.maxCostUsd = 0.1; deps.critic.maxCostUsd = 0.1;
  deps.actor.run = async (briefing) => ({ ...await original(briefing), usage: { costUsd: 0.1, turns: 1 } });
  const result = await runDemo(deps);
  assert.equal(result.status, 'partial'); assert.equal(result.costUsd, 0.1);
  assert.equal(result.demands[0].attempts.length, 1);
});

test('quota and consent refuse before any real launch; missing cost enforcement is partial', async () => {
  for (const change of ['unknown', 'low', 'expired', 'stale', 'consent', 'disabled', 'driver']) {
    const deps = fixture(); let calls = 0;
    deps.actor.run = async () => { calls += 1; throw new Error('must not launch'); };
    const row = deps.snapshot.clients[0];
    if (change === 'unknown') row.quota.remainingPct = null;
    if (change === 'low') row.quota.remainingPct = 0;
    if (change === 'expired') row.reading.expired = true;
    if (change === 'stale') row.quota.ageMinutes = 31;
    if (change === 'disabled') deps.snapshot.config.smoke.demoRequireQuotaConfirmation = false;
    const result = await runDemo({ ...deps, mode: 'real', confirmed: change === 'driver' });
    assert.equal(calls, 0, change); assert.equal(result.status, change === 'driver' ? 'partial' : 'refused', change);
    assert.equal(result.costUsd, 0); assert.equal(result.cleanup.removed, true);
    await assert.rejects(access(result.cleanup.root));
  }
});

test('actor exceptions and unknown usage release slots and preserve unknown cost', async () => {
  for (const broken of ['exception', 'usage']) {
    const deps = fixture({ limits: { global: 1 } });
    deps.actor.run = async () => {
      if (broken === 'exception') throw new Error('injected actor failure');
      return { status: 'completed', artifacts: [], usage: {} };
    };
    const result = await runDemo(deps);
    assert.equal(result.status, 'partial'); assert.equal(result.costUsd, null);
    assert.equal(result.demands[0].costKnown, false); assert.match(result.text, /unknown/);
    assert.equal(result.demands[0].slots[0].released.ok, true);
    await assert.rejects(access(result.cleanup.root));
  }
});

test('interruption cancels cooperating actors and cleans the temporary root', async () => {
  const deps = fixture({ limits: { global: 1 } }); const controller = new AbortController();
  deps.actor.run = async (briefing) => {
    controller.abort(); assert.equal(briefing.signal.aborted, true);
    return { status: 'cancelled', artifacts: [], usage };
  };
  const result = await runDemo({ ...deps, signal: controller.signal });
  assert.equal(result.status, 'partial'); assert.equal(result.reservedUsd, 0);
  assert.ok(result.demands.flatMap((row) => row.slots).every((slot) => slot.released.ok));
  assert.equal(result.cleanup.removed, true); await assert.rejects(access(result.cleanup.root));
});

test('escaping artifact paths and symlinks are rejected without outside writes', async () => {
  for (const path of ['../outside.txt', '/tmp/outside.txt', 'work/hours/hours.txt', 'work/card/../../outside.txt']) {
    const deps = fixture({ limits: { global: 1 } });
    deps.actor.run = async () => ({ status: 'completed', artifacts: [{ path, content: 'forbidden' }], usage });
    const result = await runDemo(deps);
    assert.equal(result.status, 'partial'); assert.match(result.reasons.join(), /unsafe artifact/);
    assert.ok(result.demands[0].slots[0].released.ok); await assert.rejects(access(result.cleanup.root));
  }
});

test('settings refuse invalid rounds, demand budgets and confirmation flags', () => {
  for (const smoke of [{ demoMaxReworkRounds: -1 }, { demoMaxReworkRounds: 0.5 },
    { demoDemandMaxUsd: 0 }, { demoDemandMaxUsd: Infinity }, { demoRequireQuotaConfirmation: 'yes' }]) {
    assert.throws(() => configOf({ smoke }));
  }
  assert.equal(configOf({ smoke: { demoRequireQuotaConfirmation: false } }).smoke.demoRequireQuotaConfirmation, false);
});

test('symlink output cannot overwrite another location, even within the scratch root', async () => {
  const deps = fixture({ limits: { global: 1 } });
  let sentinel;
  deps.actor.run = async (briefing) => {
    sentinel = join(briefing.root, 'home/untouched.txt');
    await writeFile(sentinel, 'untouched');
    await unlink(join(briefing.root, briefing.allowedOutputPaths[0]));
    await symlink(sentinel, join(briefing.root, briefing.allowedOutputPaths[0]));
    return { status: 'completed', artifacts: [{ path: briefing.allowedOutputPaths[0], content: 'forbidden' }], usage };
  };
  // Observe the sentinel before cleanup through narration after slot release.
  let observed;
  const original = deps.actor.run;
  deps.actor.run = async (briefing) => {
    const response = await original(briefing);
    deps.critic.review = async () => { throw new Error('must not review a symlink'); };
    observed = () => readFile(sentinel, 'utf8');
    return response;
  };
  let textBeforeCleanup;
  const result = await runDemo({ ...deps, onNarration(text) {
    if (text.includes('is free again')) textBeforeCleanup = observed();
  } });
  assert.equal(await textBeforeCleanup, 'untouched'); assert.equal(result.status, 'partial');
  assert.match(result.reasons.join(), /unsafe symlink/); await assert.rejects(access(result.cleanup.root));
});

test('injected clock and turn ceiling stop further calls and release reservations', async () => {
  for (const ceiling of ['turns', 'time', 'quota']) {
    const deps = fixture({ limits: { global: 1 }, smoke: { maxTurns: ceiling === 'turns' ? 1 : null } });
    let now = 1000, calls = 0; const original = deps.actor.run;
    deps.clock = () => now;
    deps.actor.run = async (briefing) => {
      calls += 1; const response = await original(briefing);
      if (ceiling === 'time') now += deps.snapshot.config.smoke.maxMinutes * 60_000;
      if (ceiling === 'quota') now += (deps.snapshot.config.smoke.quotaExpireMinutes + 1) * 60_000;
      return response;
    };
    const result = await runDemo(deps);
    assert.equal(result.status, 'partial'); assert.equal(calls, 1);
    assert.equal(result.reservedUsd, 0); assert.equal(result.demands[0].slots[0].released.ok, true);
    await assert.rejects(access(result.cleanup.root));
  }
});

test('unlaunchable size, missing critic and invalid graph never reach an injected actor', async () => {
  for (const missing of ['size', 'critic', 'dependency']) {
    const deps = fixture(); let calls = 0;
    deps.actor.run = async () => { calls += 1; throw new Error('must not launch'); };
    if (missing === 'size') deps.snapshot.clients[0].candidates.forEach((actor) => { actor.canLaunch = false; });
    if (missing === 'critic') deps.snapshot.clients[0].candidates.forEach((actor) => { actor.critic = false; });
    if (missing === 'dependency') { deps.scenario = await loadScenario(); deps.scenario.demands[0].dependsOn = ['absent']; }
    const result = await runDemo(deps);
    assert.equal(calls, 0); assert.equal(result.status, missing === 'dependency' ? 'refused' : 'partial');
    if (result.cleanup.root) await assert.rejects(access(result.cleanup.root));
  }
});

test('a failed report checkpoint still cleans the owned root', async () => {
  let root;
  const result = await runDemo({ ...fixture(), exportReport: async (report, { stage }) => {
    root = report.json.cleanup.root;
    if (stage === 'before-cleanup') throw new Error('test export failure');
  } });
  assert.equal(result.status, 'partial'); assert.equal(result.cleanup.removed, true);
  await assert.rejects(access(root));
});

test('simulated measured usage charges executor, critic and rework and refunds unused caps', async () => {
  const deps = fixture();
  const execute = deps.actor.run, review = deps.critic.review;
  const simulated = { costUsd: 0.005, turns: 1 };
  deps.actor.maxCostUsd = 0.01; deps.critic.maxCostUsd = 0.01;
  deps.actor.run = async (briefing) => ({ ...await execute(briefing), usage: simulated });
  deps.critic.review = async (request) => ({ ...await review(request), usage: simulated });
  const result = await runDemo(deps);
  assert.equal(result.status, 'pass'); assert.equal(result.reservedUsd, 0);
  assert.ok(Math.abs(result.costUsd - 0.06) < Number.EPSILON);
  const ticket = result.demands.find((row) => row.key === 'tickets');
  assert.equal(ticket.costUsd, 0.02); assert.equal(ticket.reworkRounds, 1);
  assert.ok(result.demands.every((row) => row.attempts.every((attempt) => attempt.reservedUsd === 0.01
    && attempt.costUsd === simulated.costUsd)));
  assert.ok(Math.abs(result.demands.reduce((sum, row) => sum + row.costUsd, result.overheadUsd)
    - result.costUsd) < Number.EPSILON);
});
