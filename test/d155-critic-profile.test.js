import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSetMany } from '../src/core/config.js';
import { configOf } from '../src/profiles.js';
import { actorPairs } from '../src/env/snapshot.js';
import { smokeDemo, smokeDemoCommand } from '../src/smoke/demo/entry.js';
import { buildState } from '../src/config-ui/state.js';
import { clientMain } from '../src/config-ui/client.js';
import { labels } from '../src/config-ui/labels.js';

async function fixture(t, { critic = true, client = 'claude-code' } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'd155-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = configOf(), now = Date.now();
  config.limits.global = 1;
  if (critic) config.profiles[client].critic = { ...config.profiles[client].hard };
  const snapshot = (ageMinutes, readAt) => ({ config, now, inUse: client, plugin: { missing: [] }, clients: [{ client,
    quota: { source: 'user', remainingPct: 80, status: 'green', readAt, recordedAt: readAt, observedAt: readAt, ageMinutes },
    reading: { recordedAt: new Date(readAt).toISOString() }, slots: { available: 2 }, sizeCoverage: { gaps: [] },
    candidates: actorPairs(config, client).map((pair) => ({ ...pair, confirmed: true, canLaunch: true, restrictions: [] })),
  }] });
  return { root: join(home, 'state'), home, env: { HOME: home, PATH: '/fake/bin' }, config, now, snapshot,
    deps: (ageMinutes = 0, readAt = now) => ({ root: join(home, 'state'), env: { HOME: home, PATH: '/fake/bin' },
      config, snapshot: snapshot(ageMinutes, readAt), run() { throw new Error('model process forbidden'); } }) };
}

test('D155 the critic profile can be written, alone or with its fields', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'd155-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await configSetMany(root, [{ path: 'profiles.claude-code.critic', unset: true },
    { path: 'profiles.claude-code.critic.model', value: 'sonnet' },
    { path: 'profiles.claude-code.critic.effort', value: 'medium' },
    { path: 'profiles.claude-code.critic.maxTurns', value: 40 }]);
  assert.deepEqual({ ...result.write.profiles['claude-code'].critic }, { model: 'sonnet', effort: 'medium', maxTurns: 40 });
  await assert.rejects(configSetMany(root, [{ path: 'profiles.claude-code.nonsense.model', value: 'x' }]), /Unknown class/);
});

test('D155 the preview refuses without a critic profile and says how to set one (en and pt-BR)', async (t) => {
  const f = await fixture(t, { critic: false });
  const en = await smokeDemo({ dryRun: true }, f.deps());
  assert.equal(en.status, 'refused'); assert.equal(en.exitCode, 2);
  assert.match(en.text, /critic profile of claude-code is missing/);
  assert.match(en.text, /profiles\.claude-code\.critic/);
  const pt = await smokeDemo({ dryRun: true, locale: 'pt-BR' }, f.deps());
  assert.match(pt.text, /Falta o perfil de crítico de claude-code/); // locale:pt-BR
  const lines = [];
  const code = await smokeDemoCommand(['--dry-run'], { ...f.deps(), out: (line) => lines.push(line), err: () => {} });
  assert.equal(code, 2);
  assert.ok(!lines.join('\n').includes('--confirm '), 'no confirmation code for a refused preview');
  const ok = await fixture(t);
  assert.equal((await smokeDemo({ dryRun: true }, ok.deps())).status, 'preview');
});

test('D155 the confirmation code ignores a renewed allowance reading but not a changed ceiling', async (t) => {
  const f = await fixture(t);
  const first = await smokeDemo({ dryRun: true }, f.deps(0, f.now));
  const renewed = await smokeDemo({ dryRun: true }, f.deps(7, f.now + 600000));
  assert.equal(renewed.planHash, first.planHash);
  f.config.smoke.maxUsd = (f.config.smoke.maxUsd ?? 1) + 1;
  const changed = await smokeDemo({ dryRun: true }, f.deps(0, f.now));
  assert.notEqual(changed.planHash, first.planHash);
});

test('D155 the configuration page proposes the normal profile for a row turned on', async () => {
  const state = buildState({ raw: {} });
  const critic = state.actors.find((a) => a.client === 'claude-code').classes.find((row) => row.class === 'critic');
  assert.equal(critic.enabled, false);
  assert.deepEqual(critic.proposed, { model: 'sonnet', effort: 'medium', maxTurns: 40 });
  const on = { dataset: { actor: 'profiles.claude-code.critic' }, type: 'checkbox', checked: false };
  const controls = [on, ...['model', 'effort', 'maxTurns'].map((key) => ({
    dataset: { actorPath: `profiles.claude-code.critic.${key}`, type: key === 'maxTurns' ? 'integer' : 'string' }, value: '' }))];
  const calls = [], nodes = {};
  for (const id of ['error', 'status', 'review', 'changes']) nodes[id] = { hidden: true, textContent: '' };
  nodes.review.scrollIntoView = () => {}; nodes.review.focus = () => {};
  nodes.state = { textContent: JSON.stringify({ expectedMtime: 1, actors: state.actors, accounts: [], labels: labels.en,
    locale: 'en', instance: 'i', home: '/h', pathSeparator: '/' }) };
  const handlers = {};
  const win = { navigator: {}, location: { hash: '', search: '?token=t', reload() {} }, history: { replaceState() {} },
    document: { getElementById: (id) => nodes[id], querySelector: (s) => nodes[s.slice(1)],
      querySelectorAll: (s) => (s === '[role="tab"]' || s === '[role="tabpanel"]' || s === 'details.section > summary' || s === 'tr[data-account-id]' ? [] : controls),
      addEventListener: (name, handler) => { handlers[name] = handler; }, defaultView: { addEventListener() {} } },
    fetch: async (path, options) => { calls.push({ path, ...options }); return { status: 200, json: async () => ({}) }; } };
  clientMain(win);
  on.checked = true;
  handlers.change({ target: on });
  assert.deepEqual(controls.slice(1).map((c) => c.value), ['sonnet', 'medium', '40']);
  handlers.click({ target: { closest: (s) => (s === '[data-action]' ? { dataset: { action: 'review' }, closest: () => null } : null) } });
  const text = nodes.changes.textContent;
  assert.match(text, /Before: Off/);
  assert.match(text, /After: On \(model: sonnet, effort: medium, maxTurns: 40\)/);
  assert.ok(!/Default/.test(text) && !/false/.test(text));
});

test('D155 the confirmation code changes when the allowance percentage the user approved changes', async (t) => {
  const f = await fixture(t);
  const first = await smokeDemo({ dryRun: true }, f.deps());
  const lower = f.deps(); lower.snapshot.clients[0].quota.remainingPct = 55;
  assert.notEqual((await smokeDemo({ dryRun: true }, lower)).planHash, first.planHash);
});
