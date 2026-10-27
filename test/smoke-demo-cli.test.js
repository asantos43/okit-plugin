import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { TOOLS } from '../src/mcp/tools.js';
import { configOf } from '../src/profiles.js';
import { actorPairs } from '../src/env/snapshot.js';
import { smokeDemo } from '../src/smoke/demo/entry.js';

async function fixture(t, client = 'codex') {
  const home = await mkdtemp(join(tmpdir(), 'demo-entry-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = configOf(), now = Date.now();
  return { root: join(home, 'state'), home, env: { HOME: home, PATH: '' }, config,
    snapshot: { config, now, inUse: client, plugin: { missing: [] }, clients: [{ client,
      quota: { source: 'user', remainingPct: 80, status: 'green', readAt: now, ageMinutes: 0 },
      reading: { recordedAt: new Date(now).toISOString() }, slots: { available: 2 }, sizeCoverage: { gaps: [] },
      candidates: actorPairs(config, client).map((pair) => ({ ...pair, confirmed: true, canLaunch: true, restrictions: [] })),
    }] }, run() { throw new Error('model process forbidden'); } };
}

const tool = TOOLS.find((item) => item.name === 'smoke_demo');

test('confirmation binds work, settings, helpers and allowance to the preview', async (t) => {
  const deps = await fixture(t);
  const preview = await smokeDemo({ dryRun: true }, deps);
  const args = { confirm: preview.planHash };
  const unchanged = await smokeDemo(args, deps);
  assert.equal(unchanged.confirmed, true);
  assert.equal(unchanged.status, 'refused');
  assert.match(unchanged.text, /Measured usage and a cost ceiling are not proven/);
  for (const change of [
    (d) => { d.snapshot.config.smoke.maxUsd += 1; },
    (d) => { d.snapshot.clients[0].candidates[0].model = 'another-helper'; },
    (d) => { d.snapshot.clients[0].quota.remainingPct -= 1; },
    (d) => { d.snapshot.clients[0].reading.recordedAt = 'new-reading'; },
    (d) => { d.scenario = structuredClone(preview.plan.scenario); d.scenario.demands[0].title.en += ' changed'; },
  ]) {
    const changed = { ...deps, snapshot: structuredClone(deps.snapshot) };
    change(changed);
    const result = await smokeDemo(args, changed);
    assert.equal(result.status, 'refused');
    assert.equal(result.confirmed, false);
    assert.notEqual(result.planHash, preview.planHash);
    assert.match(result.text, /fresh confirmation/);
  }
});
// | Input | Must pass | Must refuse |
// | preview | allowance and configured ceilings, no launch | claiming execution |
// | confirmation | same plan and evidence | absent or changed plan/evidence |

test('CLI and MCP share previews and refusal for all clients and languages', async (t) => {
  for (const client of ['claude-code', 'codex', 'opencode']) {
    const deps = await fixture(t, client);
    for (const locale of ['en', 'pt-BR']) {
      for (const dryRun of [true, false]) {
        const output = [], errors = [];
        const code = await main(['smoke-demo', '--client', client, '--locale', locale, '--json',
          ...(dryRun ? ['--dry-run'] : [])], { ...deps, stdout: (line) => output.push(line), stderr: (line) => errors.push(line) });
        assert.deepEqual(errors, []);
        const cli = JSON.parse(output.join(''));
        const mcp = JSON.parse(await tool.handler({ client, locale, dryRun }, deps));
        assert.deepEqual(cli, mcp);
        assert.equal(code, dryRun ? 0 : 2);
        assert.equal(cli.status, dryRun ? 'preview' : 'refused');
        assert.doesNotMatch(cli.text, /\b[DO]\d+\b|runId|inbox|profile_pick|Executor|Critic|snapshot/);
        if (client === 'codex') {
          assert.match(cli.text, locale === 'en'
            ? /does not report money, so no money ceiling is available/
            : /não informa custo em dinheiro, então não há teto de dinheiro disponível/);
          assert.match(cli.text, locale === 'en'
            ? /set "maxTokens" under "smoke" in config.json to a positive whole number/
            : /defina "maxTokens" dentro de "smoke" em config.json como um número inteiro positivo/);
          assert.doesNotMatch(cli.text, /USD/);
        } else {
          assert.match(cli.text, locale === 'en'
            ? /new work stops at the money ceiling/
            : /novos trabalhos param ao atingir o teto em dinheiro/);
          assert.ok(cli.text.includes(`${locale === 'en' ? 'Total ceiling' : 'Teto total'}: USD ${deps.config.smoke.maxUsd}`));
        }
        assert.equal(cli.confirmed, false);
      }
    }
  }
});
