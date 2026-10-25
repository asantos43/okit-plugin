import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_CONFIG, configOf, profilePick } from '../src/profiles.js';
import { clientsOf } from '../src/status.js';

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

test('configuration normalizes legacy limits and validates values on read', () => {
  assert.deepEqual(configOf({ limits: { global: 8 } }).limits, { global: 8, clients: {} });
  const legacy = configOf({ limits: { global: 8, perClient: 2 } });
  assert.deepEqual(legacy.limits, { global: 2, clients: {} });
  assert.ok(legacy.limitWarnings.includes('deprecated perClient'));
  assert.throws(() => configOf({ limits: { clients: { codex: 0 } } }), /limits.clients.codex/);
  assert.throws(() => configOf({ limits: { global: null } }), /limits.global/);
  assert.throws(() => configOf({ limits: { perClient: 0 } }), /integer >= 1/);
  assert.throws(() => configOf({ limits: [] }), /limits must be an object/);
});

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

const CATALOG = {
  'claude-code': {
    simple: { model: 'haiku', effort: 'low', maxTurns: 20 },
    normal: { model: 'sonnet', effort: 'medium', maxTurns: 40 },
    hard: { model: 'opus', effort: 'high', maxTurns: 80 },
  },
  codex: {
    simple: { model: 'gpt-5-codex', effort: 'low', maxTurns: 20 },
    normal: { model: 'gpt-5-codex', effort: 'medium', maxTurns: 40 },
    hard: { model: 'gpt-5-codex', effort: 'high', maxTurns: 80 },
  },
  opencode: {
    simple: { model: 'minimax/MiniMax-M3', effort: 'low', maxTurns: 20 },
    normal: { model: 'minimax/MiniMax-M3', effort: 'medium', maxTurns: 40 },
    hard: { model: 'minimax/MiniMax-M3', effort: 'high', maxTurns: 80 },
  },
};

test('the default catalog covers every client and class', () => {
  assert.deepEqual(DEFAULT_CONFIG.profiles, CATALOG);
  for (const [client, classes] of Object.entries(CATALOG)) {
    for (const [effort, profile] of Object.entries(classes)) {
      assert.deepEqual(profilePick({ client, effort }), profile);
    }
  }
});

test('a user profile wins per class without erasing the rest of the catalog', () => {
  const config = { profiles: { 'claude-code': { hard: { model: 'custom-opus', effort: 'medium', maxTurns: 12 } } } };
  const merged = configOf(config);
  assert.deepEqual(merged.profiles['claude-code'].hard, config.profiles['claude-code'].hard);
  assert.deepEqual(merged.profiles['claude-code'].simple, CATALOG['claude-code'].simple);
  assert.deepEqual(merged.profiles['claude-code'].normal, CATALOG['claude-code'].normal);
  assert.deepEqual(merged.profiles.codex, CATALOG.codex);
  assert.deepEqual(merged.profiles.opencode, CATALOG.opencode);
  assert.deepEqual(profilePick({ client: 'claude-code', effort: 'hard', config }), config.profiles['claude-code'].hard);
});

test('an unknown client gets a simple bilingual message without demand or order ids', () => {
  assert.throws(() => profilePick({ client: 'ghost', effort: 'normal' }), (error) => {
    assert.match(error.message, /Client "ghost" has no default profile/);
    assert.match(error.message, /O cliente "ghost" não tem perfil padrão/);
    assert.match(error.message, /claude-code, codex, opencode/);
    assert.doesNotMatch(error.message, /\b[IDOG]\d+\b/);
    return true;
  });
});

test('an unknown class gets a simple bilingual message', () => {
  assert.throws(() => profilePick({ client: 'codex', effort: 'urgent' }), (error) => {
    assert.match(error.message, /Unknown profile class "urgent"/);
    assert.match(error.message, /Classe de perfil desconhecida "urgent"/);
    assert.match(error.message, /simple, normal, hard/);
    return true;
  });
});

test('a low quota descends one class using the default catalog', () => {
  assert.deepEqual(profilePick({ client: 'codex', effort: 'hard', quota: { source: 'api', remainingPct: 5 } }),
    CATALOG.codex.normal);
  assert.deepEqual(profilePick({ client: 'opencode', effort: 'normal', quota: { source: 'api', remainingPct: 5 } }),
    CATALOG.opencode.simple);
});

test('a missing profile throws an error naming the client and the class', () => {
  assert.throws(() => profilePick({ client: 'beta', effort: 'hard', config: CONFIG }),
    (error) => {
      assert.match(error.message, /beta/);
      assert.match(error.message, /hard/);
      return true;
    });
  assert.throws(() => profilePick({ client: 'alpha', effort: 'normal' }),
    /alpha/);
});

test('an unknown effort class throws instead of guessing', () => {
  assert.throws(() => pick('urgent', undefined), /urgent/);
});

test('DEFAULT_CONFIG keeps its limits and quota floor beside the editable catalog', () => {
  assert.deepEqual(DEFAULT_CONFIG.limits, { global: 3, clients: {} });
  assert.equal(DEFAULT_CONFIG.lowQuotaPct, 15);
  assert.deepEqual(Object.keys(DEFAULT_CONFIG.profiles), ['claude-code', 'codex', 'opencode']);
});

// Must pass / must refuse:
// | pass: a root that names a client keeps it, a root that names none keeps the known ones |
// | refuse: the default catalog never adds a client to the list of the root |
test('the default catalog does not widen the clients of a root', () => {
  const named = configOf({ profiles: { 'claude-code': {
    hard: { model: 'custom-opus', effort: 'high', maxTurns: 9 } } } });
  assert.deepEqual(named.configuredClients, ['claude-code']);
  assert.deepEqual(clientsOf(named), ['claude-code']);
  assert.deepEqual(Object.keys(named.profiles), ['claude-code', 'codex', 'opencode']);
  const clean = configOf({});
  assert.deepEqual(clean.configuredClients, []);
  assert.deepEqual(clientsOf(clean), ['claude-code', 'codex', 'opencode']);
});
