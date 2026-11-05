import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseAccount, accountReasonText, ACCOUNT_REASON_TEXTS } from '../src/accounts-choose.js';
import { configOf } from '../src/profiles.js';
import { CONFIG_SCHEMA, entryAccepts } from '../src/config-schema.js';

const now = Date.UTC(2026, 10, 5);
const week = 10080 * 60_000;
const actorClass = { name: 'hard', model: 'opus', effort: 'high' };
const window = (remainingPct, windowMinutes, left = week / 2) => ({ remainingPct, windowMinutes,
  resetsAt: new Date(now + left).toISOString() });
const account = (id = 'default', weekly = 80, session = 90) => ({ client: 'claude-code', id,
  login: 'logged-in', actors: [{ model: 'opus', effort: 'high' }],
  reading: { windows: [window(session, 300), window(weekly, 10080)] } });
const choose = (accounts, extra = {}) => chooseAccount({ client: 'claude-code', actorClass, accounts, now, ...extra });
const freeze = (value) => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

test('one account passes without changing inputs or reading credentials', () => {
  const accounts = freeze([account()]);
  const result = choose(accounts);
  assert.equal(result.account, accounts[0]);
  assert.equal(result.reason.code, 'chosen');
  assert.equal(result.reason.weeklyHeadroom, 30);
  assert.deepEqual(choose(accounts), result);
});

// | Filter corpus | Must pass | Must refuse |
// | login | logged-in, unknown, absent | logged-out |
// | actor | exact model + effort | missing model or effort |
// | windows | unknown, above floor | session/weekly at or below floor |
// | slots | done/stale/other account | live at cap, unknown start time |
test('each filter refuses independently and urgency never bypasses filters', () => {
  const cases = [
    [{ ...account(), login: 'logged-out' }, {}, 'login'],
    [{ ...account(), actors: [] }, {}, 'actor'],
    [{ ...account(), actors: [{ model: 'opus', effort: 'low' }] }, {}, 'actor'],
    [account('default', 80, 10), { settings: { accountPolicy: { minQuotaPct: 10 } } }, 'session'],
    [account('default', 0), {}, 'weekly'],
    [account(), { settings: { limits: { global: 1 } }, runs: [
      { client: 'claude-code', status: 'live' },
    ] }, 'busy'],
  ];
  for (const [entry, extra, code] of cases) {
    const result = choose([entry], { ...extra, actorClass: { ...actorClass, urgent: true } });
    assert.deepEqual(result.wait_until, null);
    assert.equal(result.reason.code, code);
    assert.equal(result.account, undefined);
  }
});

test('unknown or absent login passes, ranks last and still obeys other filters and session pinning', () => {
  for (const login of ['unknown', undefined]) {
    const uncertain = { ...account('a'), login };
    if (login === undefined) delete uncertain.login;
    const known = account('z', 60, 60);
    const result = choose([uncertain]);
    assert.equal(result.account, uncertain);
    assert.equal(result.reason.code, 'unknown');
    assert.equal(choose([uncertain, known]).account, known);
    assert.equal(choose([known, uncertain]).account, known);
    assert.equal(choose([known, uncertain], { resumeSession: { account: 'a' } }).account, uncertain);
    uncertain.reading.windows[1].remainingPct = 0;
    assert.equal(choose([uncertain]).reason.code, 'weekly');
  }
});

test('weekly headroom uses own percentages and time to reset, then session, load, recency and id', () => {
  const a = account('a', 70);
  const b = account('b', 90);
  assert.equal(choose([a, b]).account.id, 'b');
  b.reading.windows[1].resetsAt = new Date(now + week).toISOString();
  assert.equal(choose([b, a]).account.id, 'a');
  assert.equal(choose([account('b'), account('a')]).account.id, 'a');
  assert.equal(choose([account('a', 80, 40), account('b')]).account.id, 'b');
  const runs = [{ client: 'claude-code', account: 'a', status: 'live', startedAt: now }];
  assert.equal(choose([account('a'), account('b')], { runs }).account.id, 'b');
  runs[0].status = 'done';
  assert.equal(choose([account('a'), account('b')], { runs }).account.id, 'b');
});

test('unknown windows rank last but do not bar; known exhausted window still bars', () => {
  const unknown = { ...account('a'), reading: null };
  assert.equal(choose([unknown, account('z', 20, 20)]).account.id, 'z');
  assert.equal(choose([unknown]).reason.code, 'unknown');
  unknown.reading = { windows: [window(0, 300)] };
  assert.equal(choose([unknown]).reason.code, 'session');
  unknown.reading = { remainingPct: 80 };
  assert.equal(choose([unknown]).account.id, 'a');
});

test('continuations pin their account even when another has more quota', () => {
  const accounts = [account('a', 20), account('b')];
  assert.equal(choose(accounts, { resumeSession: { account: 'a' } }).account.id, 'a');
  accounts[0].reading.windows[1].remainingPct = 0;
  assert.equal(choose(accounts, { resumeSession: { account: 'a' } }).reason.code, 'weekly');
  assert.equal(choose(accounts, { resumeSession: { account: 'removed' } }).reason.code, 'session-account');
  assert.equal(choose(accounts, { resumeSession: {} }).reason.code, 'session-account');
});

test('critic and verifier prefer another eligible account; preference cannot override pin or filters', () => {
  for (const role of ['critic', 'verifier']) {
    const actor = { ...actorClass, role, executorAccount: 'a' };
    const accounts = [account('a'), account('b', 30)];
    assert.equal(choose(accounts, { actorClass: actor }).account.id, 'b');
    assert.equal(choose(accounts, { actorClass: actor, resumeSession: { account: 'a' } }).account.id, 'a');
    accounts[1].login = 'logged-out';
    assert.equal(choose(accounts, { actorClass: actor }).account.id, 'a');
  }
});

test('pacing defaults to advice; enforced hard work waits until the margin catches up', () => {
  const accounts = [account('default', 20)];
  assert.equal(choose(accounts).reason.code, 'ahead');
  assert.equal(choose(accounts).account, accounts[0]);
  const settings = { accountPolicy: { enforcePace: true } };
  const deferred = choose(accounts, { settings });
  assert.equal(deferred.reason.code, 'deferred');
  assert.equal(deferred.wait_until, now + week * 0.15);
  assert.ok(deferred.wait_until <= now + week / 2);
  assert.ok(choose(accounts, { settings, now: deferred.wait_until }).account);
  for (const name of ['simple', 'normal']) assert.ok(choose(accounts, {
    settings, actorClass: { ...actorClass, name },
  }).account);
  assert.ok(choose(accounts, { settings, actorClass: { ...actorClass, urgent: true } }).account);
  assert.ok(choose([account('default', 35)], { settings }).account);
  assert.ok(choose(accounts, { settings: { accountPolicy: { enforcePace: true, paceMarginPct: 30 } } }).account);
});

test('run accounting follows live status, stale timeout and legacy default account', () => {
  const runs = [{ client: 'claude-code', status: 'live', startedAt: now - 31 * 60_000 },
    { client: 'codex', status: 'live' }, { client: 'claude-code', account: 'other', status: 'live' }];
  assert.ok(choose([account()], { runs, settings: { limits: { global: 1 } } }).account);
  runs[0].startedAt = now;
  assert.equal(choose([account()], { runs, settings: { limits: { global: 1 } } }).reason.code, 'busy');
  assert.equal(choose([{ ...account(), parallelLimit: 1 }], { runs }).reason.code, 'busy');
});

const golden = [
  ['chosen', 'Account selected by available weekly quota.', 'Conta escolhida pela cota semanal disponível.'],
  ['unknown', 'Account selected with unknown login or quota information.', 'Conta escolhida com informação de login ou cota desconhecida.'],
  ['login', 'The account is not logged in.', 'A conta não está logada.'],
  ['actor', 'The account does not offer this model and effort.', 'A conta não oferece este modelo e esforço.'],
  ['session', 'Session quota is 10%; it must be above 10%.', 'A cota da sessão é 10%; deve estar acima de 10%.'],
  ['weekly', 'Weekly quota is 10%; it must be above 10%.', 'A cota semanal é 10%; deve estar acima de 10%.'],
  ['busy', 'The account has 2 running; the limit is 2.', 'A conta tem 2 em execução; o limite é 2.'],
  ['unavailable', 'No account is available.', 'Nenhuma conta está disponível.'],
  ['session-account', 'The account holding this session is unavailable.', 'A conta que contém esta sessão está indisponível.'],
  ['ahead', 'Weekly use is ahead of pace by more than 15 points; launch allowed.',
    'O uso semanal está mais de 15 pontos à frente do ritmo; início permitido.'],
  ['deferred', 'Weekly use is ahead of pace by more than 15 points; hard work must wait.',
    'O uso semanal está mais de 15 pontos à frente do ritmo; trabalho difícil deve esperar.'],
];
test('golden account reasons in English and Brazilian Portuguese', () => {
  assert.deepEqual(golden.map(([code]) => code).sort(), Object.keys(ACCOUNT_REASON_TEXTS.en).sort());
  for (const [code, en, pt] of golden) {
    const reason = { code, remaining: 10, minimum: 10, running: 2, limit: 2, margin: 15 };
    assert.equal(accountReasonText(reason, 'en'), en);
    assert.equal(accountReasonText(reason, 'pt-BR'), pt);
    assert.equal(accountReasonText(reason, 'unknown'), en);
  }
});

test('settings defaults, partial merge, schema limits and profile lookup', () => {
  assert.deepEqual(configOf({}).accountPolicy, { minQuotaPct: 0, paceMarginPct: 15, enforcePace: false });
  assert.equal(configOf({ accountPolicy: { enforcePace: true } }).accountPolicy.paceMarginPct, 15);
  for (const accountPolicy of [null, [], false, { minQuotaPct: -1 }, { paceMarginPct: 101 },
    { enforcePace: 'yes' }, { paceMarginPct: NaN }]) assert.throws(() => configOf({ accountPolicy }));
  for (const key of ['minQuotaPct', 'paceMarginPct']) {
    const entry = CONFIG_SCHEMA.entries.find((e) => e.path === `accountPolicy.${key}`);
    assert.ok(entryAccepts(entry, 15));
    assert.equal(entryAccepts(entry, -1), false);
    assert.equal(entryAccepts(entry, 101), false);
  }
  assert.ok(choose([account()], { actorClass: 'hard', settings: configOf({}) }).account);
  assert.equal(choose([account()], { actorClass: 'absent' }).reason.code, 'actor');
  assert.equal(choose([]).reason.code, 'unavailable');
  assert.throws(() => choose([account()], { now: undefined }), /timestamp/);
});
