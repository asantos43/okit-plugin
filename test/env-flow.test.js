import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import claude from '../adapters/claude-code/index.js';
import codex from '../adapters/codex/index.js';
import opencode from '../adapters/opencode/index.js';
import { environmentSnapshot } from '../src/env/snapshot.js';
import { environmentReport, formatEnvironmentReport } from '../src/env/report.js';
import { statusTable } from '../src/status.js';
import { listActors } from '../src/actors.js';
import { runSetup } from '../src/setup/setup.js';
import { DEFAULT_CONFIG } from '../src/profiles.js';
import { main } from '../src/cli.js';
import { formatRoleContext } from '../src/roles.js';
import { smokePreflight, runClientSmoke } from '../src/smoke/client.js';

const now = () => Date.parse('2026-10-26T12:05:00Z');
const refuse = () => assert.fail('unexpected probe, write, launch or quota spend');
const markers = { 'claude-code': 'CLAUDECODE', codex: 'CODEX_THREAD_ID', opencode: 'OPENCODE' };

// Must pass / Must refuse (§8): fresh automatic/manual samples, exact smoke
// floor and warning age pass; unknown/expired require explicit override;
// low quota refuses even with override. Discovery failures never confirm access.
test('smoke keeps its own thresholds and explicit unknown override on env observations', async () => {
  const budget = { ...DEFAULT_CONFIG.smoke, quotaMaxAgeMinutes: 2, quotaExpireMinutes: 4 };
  for (const [reading, reason, stale] of [
    [{ source: 'off' }, 'quota-unknown', false],
    [{ source: 'manual', remainingPct: 19 }, 'quota-below-floor', false],
    [{ source: 'automatic', remainingPct: 20, ageMinutes: 2 }, null, false],
    [{ source: 'automatic', remainingPct: 80, ageMinutes: 4 }, null, true],
    [{ source: 'manual', remainingPct: 80, ageMinutes: 5 }, 'quota-unknown', true],
    [{ source: 'automatic', remainingPct: 80, expired: true }, 'quota-unknown', false],
    [{ source: 'manual', remainingPct: 80, expiresAt: '2026-10-26T12:00:00Z' }, 'quota-unknown', false],
  ]) {
    const snapshot = await environmentSnapshot({ client: 'codex', env: {}, now,
      plugin: {}, versions: {}, detectClients: async () => ({ clients: [] }),
      cache: new Map(), readQuota: async () => reading });
    assert.equal(smokePreflight(snapshot, 'codex', budget).refusal, reason);
    assert.equal(smokePreflight(snapshot, 'codex', budget).stale, stale);
    assert.equal(smokePreflight(snapshot, 'codex', budget, true).refusal,
      reason === 'quota-below-floor' ? reason : null);
  }
});

for (const adapter of [claude, codex, opencode]) {
  test(`${adapter.CLIENT}: installation → discovery → confirmed setup → shared facts → Director → offline smoke`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), 'okit-env-flow-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const client = adapter.CLIENT;
    const root = join(home, 'state');
    const clientRoot = join(home, client);
    const env = { HOME: home, CLAUDE_CONFIG_DIR: join(home, 'claude'),
      CODEX_HOME: join(home, 'codex'), OPENCODE_CONFIG_DIR: join(home, 'opencode'), [markers[client]]: 'fixture' };
    const model = DEFAULT_CONFIG.profiles[client].simple.model;
    const config = { profiles: { [client]: Object.fromEntries(['simple', 'normal', 'hard']
      .map((name) => [name, { model, effort: 'low' }])) }, limits: { global: 4 },
    setup: { detect: { [client]: { command: 'fake-client', args: ['models'], parse: 'json-array',
      activeField: null, activeValues: null, timeoutMs: 1000 } } } };
    const installed = await adapter.installRole({ root: clientRoot, env });
    assert.equal(installed.status, 'ready');
    const skill = await adapter.installSkill('okit-environment', 'skills/okit-environment', { root: clientRoot, env });
    assert.ok((await readFile(join(skill.path, 'SKILL.md'), 'utf8')).includes('Question routing'));
    let probes = 0; let quotaReads = 0;
    const deps = { root, home, env, client, config, adapters: [adapter], now, cache: new Map(),
      plugin: { path: 'fixture-plugin', onPath: true }, versions: { [client]: { installed: true, version: 'fixture' } },
      run: async ({ command, env: received }) => { assert.equal(command, 'fake-client');
        assert.equal(received.HOME, home); probes += 1; return { code: 0, stdout: JSON.stringify([model]) }; },
      limits: { limits: config.limits, byClient: { [client]: 1 } },
      readQuota: async () => { quotaReads += 1; return { source: client === 'codex' ? 'manual' : 'automatic',
        remainingPct: 72, provider: 'fixture', recordedAt: '2026-10-26T12:00:00Z' }; } };
    const pending = await environmentSnapshot(deps);
    assert.deepEqual(pending.clients[0].models, [model]);
    assert.match(formatEnvironmentReport(await environmentReport({ snapshot: pending }), 'pt-BR'), /Falta:.*salva/);
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(root);
    await writeFile(join(root, 'config.json'), JSON.stringify(config));
    const cancelled = await runSetup({ root, config, env, snapshot: pending, ask: async () => undefined });
    assert.equal(cancelled.cancelled, true);
    assert.equal(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')).setup.done, undefined);
    let confirmed = false;
    const setup = await runSetup({ root, config, env, snapshot: pending, ask: async (_question, recommended) => {
      if (recommended) return recommended;
      confirmed = true; return 'yes';
    } });
    assert.equal(setup.code, 0); assert.equal(confirmed, true);
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
    assert.ok(saved.setup.done);
    const snapshot = await environmentSnapshot({ ...deps, config: saved });
    const shared = { root, env, snapshot, client, demands: [], orders: [],
      run: refuse, detectClients: refuse, readQuota: refuse, write: refuse, spawn: refuse };
    const report = await environmentReport(shared);
    const status = await statusTable(root, shared);
    const actors = await listActors(shared);
    assert.equal(snapshot.inUse, client);
    assert.deepEqual(report.plugin.missing, []);
    assert.deepEqual(status.missing, report.plugin.missing);
    assert.deepEqual(actors.missing, report.plugin.missing);
    for (const row of [report.clients[0], status.rows[0]]) {
      assert.equal(row.client, client);
      assert.deepEqual(row.models, [model]);
      assert.deepEqual(row.slots, { total: 4, available: 3 });
    }
    assert.ok(actors.actors.every((actor) => actor.confirmed && actor.freeSlots === 3));
    for (const quota of [report.clients[0].quota, status.rows[0], actors.actors[0].quota]) {
      assert.equal(quota.source, pending.clients[0].quota.source);
      assert.equal(quota.ageMinutes, 5); assert.equal(quota.provider, 'fixture');
      assert.equal(quota.remainingPct, 72);
    }
    const output = [];
    for (const argv of [['env', 'report'], ['status'], ['actors'], ['quota', 'show', client]]) {
      assert.equal(await main(argv, { ...shared, stdout: (line) => output.push(line), stderr: refuse }), 0);
    }
    assert.match(output.join('\n'), /5 minutes ago/);
    assert.match(output.join('\n'), /"remainingPct":72/);
    const delivery = adapter.deliverRole({ snapshot, env, items: [], orders: [] });
    assert.equal(delivery.status, 'ready'); assert.equal(delivery.context.role, 'Director');
    for (const locale of ['en', 'pt-BR']) {
      const answer = formatRoleContext(delivery.context, locale);
      assert.match(answer, locale === 'en' ? /Role: Director/ : /Papel: Director/);
      assert.ok(answer.includes(model)); assert.match(answer, /72%/);
    }
    assert.equal(probes, 2); assert.equal(quotaReads, 1);
    const preflight = smokePreflight(snapshot, client, DEFAULT_CONFIG.smoke);
    assert.equal(preflight.refusal, null);
    assert.equal(preflight.observed, snapshot.clients[0].quota);
    // The public real driver remains Claude-only. This injected C1 walk is offline
    // for every adapter and presents that adapter's observed actor, never a spawn.
    const demonstration = await runClientSmoke(['--demo', '--only', 'C1', '--allow-unknown-quota'], {
      ...shared, now, out: (line) => output.push(line), err: refuse,
      client: async ({ args, onEvent }) => {
        if (args[0] === '--help') return { stdout: '--output-format --include-hook-events --verbose --max-budget-usd --permission-mode --no-session-persistence' };
        const text = { message: { content: [{ type: 'text', text: `${client}: ${actors.actors[0].model}` }] } };
        onEvent(text);
        return { events: [{ subtype: 'init', plugins: [{ name: 'okit', path: 'fixture-plugin' }] },
          text, { type: 'result', total_cost_usd: 0 }] };
      },
    });
    assert.equal(demonstration.code, 1, 'selective C1 demonstration must report incomplete installation checks');
    assert.equal(demonstration.records[0].status, 'pass');
    assert.ok(output.includes(`${client}: ${model}`));
    assert.equal(probes, 2); assert.equal(quotaReads, 1);
    assert.equal(adapter.deliverRole({ briefing: 'Role: Executor\nRole: Critic' }).status, 'clarification');
    assert.equal(adapter.deliverRole({ nativeSupported: false }).status, 'unsupported');
    for (const run of [async () => { throw Object.assign(new Error('fixture missing'), { code: 'ENOENT' }); },
      async () => ({ code: 1, stdout: '' }), async () => ({ code: 0, stdout: 'invalid listing' })]) {
      const unknown = await environmentSnapshot({ ...deps, cache: new Map(), run });
      assert.deepEqual(unknown.clients[0].models, []);
      assert.ok(unknown.clients[0].candidates.every((actor) => !actor.confirmed && !actor.canLaunch));
    }
  });
}
