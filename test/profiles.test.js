import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_CONFIG, profilePick } from '../src/profiles.js';

const CONFIG = {
  lowQuotaPct: 15,
  profiles: {
    alpha: {
      simple: { model: 'alpha-lite', effort: 'low', maxTurns: 4 },
      normal: { model: 'alpha-mid', effort: 'medium', maxTurns: 10 },
      hard: { model: 'alpha-max', effort: 'high', maxTurns: 24 },
    },
    beta: {
      simple: { model: 'beta-lite', effort: 'low', maxTurns: 2 },
      normal: { model: 'beta-mid', effort: 'low', maxTurns: 6 },
    },
  },
};

const pick = (effort, quota, config = CONFIG) => profilePick({ client: 'alpha', effort, quota, config });

test('a healthy quota keeps the class as is', () => {
  assert.deepEqual(pick('hard', { source: 'api', remainingPct: 80 }),
    { model: 'alpha-max', effort: 'high', maxTurns: 24 });
  assert.deepEqual(pick('normal', { source: 'user', remainingPct: 50 }).model, 'alpha-mid');
});

test('quota off or missing keeps the class as is', () => {
  assert.equal(pick('hard', undefined).model, 'alpha-max');
  assert.equal(pick('hard', { source: 'off' }).model, 'alpha-max');
  assert.equal(pick('hard', { source: 'api' }).model, 'alpha-max');
});

test('a low quota downgrades hard to normal and normal to simple', () => {
  assert.equal(pick('hard', { source: 'api', remainingPct: 14 }).model, 'alpha-mid');
  assert.equal(pick('normal', { source: 'api', remainingPct: 0 }).model, 'alpha-lite');
});

test('a low quota never upgrades and never drops below simple', () => {
  assert.equal(pick('simple', { source: 'api', remainingPct: 1 }).model, 'alpha-lite');
  assert.throws(() => pick('simple', { source: 'api', remainingPct: 1 }, {
    profiles: { alpha: { hard: { model: 'x', effort: 'low', maxTurns: 1 } } },
  }), /alpha/);
});
test('a rich quota never promotes a class', () => {
  assert.equal(pick('normal', { source: 'api', remainingPct: 100 }).model, 'alpha-mid');
  assert.equal(pick('simple', { source: 'api', remainingPct: 100 }).model, 'alpha-lite');
});

test('a missing profile throws an error naming the client and the class', () => {
  assert.throws(() => profilePick({ client: 'beta', effort: 'hard', config: CONFIG }),
    (error) => {
      assert.match(error.message, /beta/);
      assert.match(error.message, /hard/);
      return true;
    });
  assert.throws(() => profilePick({ client: 'alpha', effort: 'normal' }),
    /alpha.*normal|normal.*alpha/);
});

test('an unknown effort class throws instead of guessing', () => {
  assert.throws(() => pick('urgent', undefined), /urgent/);
});

test('DEFAULT_CONFIG ships limits, lowQuotaPct and no model names', () => {
  assert.deepEqual(DEFAULT_CONFIG.limits, { global: 4, perClient: 3 });
  assert.equal(DEFAULT_CONFIG.lowQuotaPct, 15);
  assert.deepEqual(DEFAULT_CONFIG.profiles, {});
  assert.equal(JSON.stringify(DEFAULT_CONFIG).includes('model'), false);
});