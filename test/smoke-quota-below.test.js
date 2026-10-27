import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FEATURE_CHECKS } from '../src/smoke/checks-features.js';
import { detectKit } from '../src/install/kit.js';
import { installConfig } from '../src/install/config.js';
import { DEFAULT_CONFIG } from '../src/profiles.js';

const check = FEATURE_CHECKS.find(({ id }) => id === 'E20');

// | Case | Must pass | Must refuse |
// | Same sample, configured floor changed | gate follows config | fixed floor |
// | No process result | no assertion about kit | fabricated command output |
// | Real installed kit, local quota meters | exit 6, each reason and first return | any client launch |
// | User guidance in both languages | plain quota remedy | technical codes / demand ids |

test('quota below the configured launch floor is refused and explained in both languages', async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), 'okit-quota-below-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const invocations = [];
  const floor = 37;
  const deps = {
    env: { HOME: home }, stateRoot: join(home, '.okwork'),
    projectRoot: home, now: () => Date.UTC(2026, 9, 27),
    config: { parallel: { minQuotaPercent: floor } },
  };
  deps.run = async (invocation) => {
    invocations.push(invocation);
    assert.equal(invocation.env.HOME.startsWith(home), false, 'kit must use its own disposable HOME');
    assert.equal(invocation.env.KIT_HOME, undefined, 'KIT_HOME belongs to kit code');
    assert.equal(invocation.env.KIT_LAUNCH_MIN, undefined, 'the floor must come from config');
    const config = JSON.parse(await fs.readFile(invocation.env.KIT_CONFIG_USER, 'utf8'));
    if (invocation.args[0] === 'config') {
      assert.deepEqual(invocation.args.slice(1), ['get', 'parallel.minQuotaPercent', '--json']);
      assert.equal(config.parallel.minQuotaPercent, floor);
      return { code: 0, stdout: JSON.stringify({ value: config.parallel.minQuotaPercent }), stderr: '' };
    }
    const snapshot = JSON.parse(await fs.readFile(join(invocation.env.KIT_REGISTRY, 'quotas.json'), 'utf8'));
    assert.equal(snapshot.providers.length, 2);
    if (invocation.args[0] === 'quota') {
      return { code: 0, stdout: JSON.stringify(snapshot), stderr: '' };
    }
    if (invocation.args[0] === 'capacity') {
      const subscriptions = snapshot.providers.map(({ name, remaining_percent: pct }) => ({
        name, can_launch: pct < config.parallel.minQuotaPercent ? 0 : 1,
        threshold: config.parallel.minQuotaPercent,
      }));
      return { code: 0, stdout: JSON.stringify({ total: subscriptions.reduce((n, s) => n + s.can_launch, 0), subscriptions }) };
    }
    if (invocation.args[0] === 'executor') {
      assert.equal(config.parallel.minQuotaPercent, floor - 1, 'control changes only the config floor');
      assert.equal(snapshot.providers[0].remaining_percent, floor - 1, 'control keeps the same quota');
      return { code: 0, stdout: JSON.stringify({ status: 'ok', threshold: config.parallel.minQuotaPercent }) };
    }
    const earliest = snapshot.providers[0].resets_at.slice(11, 16);
    return { code: 6, stdout: '', stderr: [
      'kit run: no executor in class \'normal\' is available:',
      ...snapshot.providers.map(({ name }) => `  - ${name}: subscription ${name} below launch threshold (${floor - 1}% remaining; threshold: ${floor}% remaining; resets in 1h)`),
      `  first available at ${earliest} (smoke-first)`,
    ].join('\n') };
  };
  await check.run(deps);
  assert.deepEqual(invocations.map(({ args }) => args[0]), ['config', 'quota', 'capacity', 'run', 'executor']);
  assert.ok(invocations.every(({ env }) => env.KIT_REGISTRY));
  for (const locale of ['en', 'pt-BR']) {
    const messages = DEFAULT_CONFIG.actors.messages[locale];
    const original = messages.low;
    try {
      messages.low = `${original} D76`;
      await assert.rejects(check.run(deps), /must not expose check codes or ids/);
    } finally { messages.low = original; }
  }
});

test('a runner without a process result makes no claim about kit output', async () => {
  const calls = [];
  await check.run({ env: {}, run: async ({ args }) => {
    calls.push(args[0]);
    return { stdout: '', stderr: '' };
  } });
  assert.deepEqual(calls, ['config']);
  await assert.rejects(check.run({ env: {}, run: async () => ({ code: null, stdout: '', stderr: 'spawn failed' }) }),
    /configured launch floor: spawn failed/);
});

function processRun(request) {
  const child = spawnSync('bash', [request.command, ...request.args], {
    env: request.env, cwd: request.cwd, encoding: 'utf8', timeout: request.timeoutMs ?? 30_000,
  });
  if (child.error) throw child.error;
  return { code: child.status, stdout: child.stdout, stderr: child.stderr };
}

test('the installed kit refuses every simulated executor and follows the configured floor', async (t) => {
  let denied;
  const probeRun = (request) => {
    try { return processRun(request); }
    catch (error) { if (error.code === 'EPERM') denied = error; throw error; }
  };
  const kit = await detectKit({ fs, config: installConfig(), env: { HOME: process.env.HOME, PATH: process.env.PATH },
    platform: process.platform, run: probeRun });
  if (kit.state !== 'installed') {
    const detail = denied ? `${kit.message}; process probe denied: ${denied.message}` : kit.message;
    t.skip(`Real kit integration skipped; detectKit found ${kit.state}: ${detail}`);
    return;
  }
  const home = await fs.mkdtemp(join(tmpdir(), 'okit-quota-real-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const results = [];
  try { await check.run({ env: { PATH: process.env.PATH }, stateRoot: join(home, 'state'),
    projectRoot: home, now: Date.now, config: { parallel: { minQuotaPercent: 37 } },
    run: async (request) => {
      assert.equal(request.env.KIT_HOME, undefined);
      const result = processRun({ ...request, command: kit.path });
      results.push({ args: request.args, ...result });
      return result;
    } }); } catch (error) {
    if (error.code === 'EPERM') { t.skip(`Real kit not run in sandbox: ${error.message}`); return; }
    throw error;
  }
  assert.ok(results.some(({ args }) => args[0] === 'run'),
    'when detectKit reports installed, the test runs kit run against the real kit');
  const refusal = results.find(({ args }) => args[0] === 'run');
  assert.equal(refusal.code, 6);
  assert.match(refusal.stderr, /threshold: 37% remaining/);
  const gate = JSON.parse(results.find(({ args }) => args[0] === 'executor').stdout);
  assert.equal(gate.threshold, 36);
  assert.equal(gate.status, 'ok');
  t.diagnostic(`Real kit refusal: ${refusal.stderr.trim()}`);
});
