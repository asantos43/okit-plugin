import assert from 'node:assert/strict';
import { test } from 'node:test';
import { roleContext, formatRoleContext, briefedRole } from '../src/roles.js';
import { mkdtemp, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../src/cli.js';
import { runSessionStart } from '../src/hook-session-start.js';

// | Must pass | Must refuse |
// | main Director; explicit Executor/Critic; same bilingual facts | missing/conflicting briefed role |
test('role selection requires an explicit, unambiguous briefed role', () => {
  assert.equal(briefedRole(), 'Director');
  for (const role of ['Executor', 'Critic']) {
    assert.equal(briefedRole(`Papel: ${role}\nDo the step`), role);
    assert.equal(briefedRole({ role, text: 'Do the step' }), role);
  }
  for (const briefing of ['', 'be an executor or critic', 'Role: Director', 'Role: Executor\nRole: Critic', {}]) {
    assert.equal(roleContext({ briefing }).status, 'clarification');
  }
});

test('unknown facts stay explicit and expired/out-of-scope orders are excluded', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  const context = roleContext({ cwd: 'project', scope: 'effort:normal', snapshot: { now, clients: [], config: { limits: { global: 2 } } },
    orders: [{ active: true, text: 'Expired', until: '2026-10-25T12:00:00Z' },
      { active: true, text: 'Other class', scope: 'effort:hard' },
      { active: true, text: 'Applies', scope: 'all' }] });
  assert.deepEqual(context.orders, ['Applies']);
  assert.deepEqual(context.limits, { global: 2 });
  assert.ok(context.unknown.includes('work / demandas'));
  assert.match(formatRoleContext(context), /Unknown facts:.*actors, quota and slots/);
});

test('role answer scopes facts, uses readable titles and preserves the actor', () => {
  const options = { client: 'codex', cwd: 'project', actor: { model: 'chosen', effort: 'high' },
    items: [{ id: 'D57', title: 'Integration guide', status: 'delegated' }, { title: 'Other', appliesTo: 'elsewhere' }],
    orders: [{ id: 'G000001', active: true, text: 'Stay in scope' }, { active: true, text: 'Other order', appliesTo: 'elsewhere' }],
    limits: { live: 0, byClient: { codex: 0 } }, snapshot: { clients: [{ client: 'codex',
      actors: [{ model: 'chosen', effort: 'high', restrictions: ['busy'] }], quota: { remainingPct: 70 }, slots: { available: 0 } }] } };
  const context = roleContext(options);
  assert.deepEqual(context.actor, options.actor);
  assert.deepEqual(context.work, ['Integration guide']);
  for (const language of ['en', 'pt']) {
    const answer = formatRoleContext(context, language);
    for (const fact of ['Director', 'Integration guide', 'Stay in scope', 'chosen + high', '70%', 'busy']) assert.ok(answer.includes(fact));
    assert.doesNotMatch(answer, /D57|G000001|Other order/);
    for (const field of language === 'en' ? ['Role:', 'May:', 'Must not:', 'Orders:', 'Limits:', 'Work in hand:', 'Available actors:', 'Unknown facts:']
      : ['Papel:', 'Pode:', 'Não pode:', 'Ordens:', 'Limites:', 'Demandas em mãos:', 'Atores disponíveis:', 'Fatos desconhecidos:']) assert.ok(answer.includes(field));
  }
});

test('environment question and native startup never save, launch or spend quota', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'okit-role-readonly-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'config.json'), '{}');
  const snapshot = { clients: [], now: Date.now(), plugin: { configured: [], missing: [] } };
  const output = [];
  const refuse = () => assert.fail('read-only question must not mutate or launch');
  const before = await readdir(root);
  const io = { root, env: { HOME: root, CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude') },
    snapshot, writeConfig: refuse, write: refuse, spawn: refuse, run: refuse, stdout: (text) => output.push(text) };
  assert.equal(await main(['env', 'report'], io), 0);
  assert.equal(await runSessionStart({ ...io, stdin: JSON.stringify({ cwd: root }) }), 0);
  const hook = JSON.parse(output.at(-1));
  assert.match(hook.hookSpecificOutput.additionalContext, /Role: Director/);
  assert.deepEqual(await readdir(root), before);
  assert.equal(await readFile(join(root, 'config.json'), 'utf8'), '{}');
  await runSessionStart({ ...io, stdin: JSON.stringify({ cwd: root, briefing: 'do the step' }) });
  assert.match(JSON.parse(output.at(-1)).hookSpecificOutput.additionalContext, /Clarify/);
  assert.equal(await runSessionStart({ ...io, stdin: 'invalid native input' }), 0);
  assert.match(JSON.parse(output.at(-1)).hookSpecificOutput.additionalContext, /contexto de papel indisponível/);
});
