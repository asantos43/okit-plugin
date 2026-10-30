import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  config.limits.global = 1;
  config.profiles[client].critic = { ...config.profiles[client].hard };
  return { root: join(home, 'state'), home, env: { HOME: home, PATH: '/fake/bin' }, config,
    snapshot: { config, now, inUse: client, plugin: { missing: [] }, clients: [{ client,
      quota: { source: 'user', remainingPct: 80, status: 'green', readAt: now, ageMinutes: 0 },
      reading: { recordedAt: new Date(now).toISOString() }, slots: { available: 2 }, sizeCoverage: { gaps: [] },
      candidates: actorPairs(config, client).map((pair) => ({ ...pair, confirmed: true, canLaunch: true, restrictions: [] })),
    }] }, run() { throw new Error('model process forbidden'); } };
}

const tool = TOOLS.find((item) => item.name === 'smoke_demo');

function launcher(client, calls, costUsd = 0.01) {
  return (command, args, options) => {
    calls.push({ command, args, ...options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    queueMicrotask(async () => {
      try {
        const prompt = args.find((arg) => arg.includes('Checks to meet /'));
        const review = prompt.includes('Review this work /');
        const checks = JSON.parse(prompt.match(/Checks to meet[^:]*: ([^\n]+)/)[1]);
        if (!review) for (const check of checks) await writeFile(join(options.cwd, check.path), check.text);
        const approved = !review || JSON.parse(prompt.split('Review this work / Confira este trabalho:\n')[1]
          .split('\n')[0]).checks.every((check) => check.passed);
        const text = JSON.stringify({ verdict: approved ? 'approved' : 'rejected', criteria: [], feedback: 'checked' });
        emitUsage(child, client, text, costUsd);
        child.emit('close', 0);
      } catch (error) { child.emit('error', error); }
    });
    return child;
  };
}

function emitUsage(child, client, text, costUsd) {
  const events = client === 'claude-code' ? [{ type: 'result', result: text,
    total_cost_usd: costUsd, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } }]
    : client === 'codex' ? [{ type: 'item.completed', item: { type: 'agent_message', text } },
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }]
      : [{ type: 'text', part: { text } }, { type: 'step_finish', part: {
        reason: 'stop', cost: costUsd, tokens: { input: 10, output: 5 } } }];
  child.stdout.emit('data', events.map((event) => JSON.stringify(event)).join('\n') + '\n');
}

// | Input | Must pass | Must refuse |
// | confirmed real plan | measured work, bounded calls, isolated env | injected helpers replacing real drivers |
// | no money reporting | positive token ceiling | absent token ceiling, without launching |
// | new work | below shared ceilings | exhausted money or tokens |
test('CLI confirmation runs all five demands and reports measured usage for every client', async (t) => {
  for (const client of ['claude-code', 'codex', 'opencode']) {
    const deps = await fixture(t, client), calls = [];
    deps.config.smoke.maxTokens = 1000;
    deps.spawn = launcher(client, calls);
    deps.actor = { run: () => assert.fail('real mode must use realDrivers') };
    deps.critic = { review: () => assert.fail('real mode must use realDrivers') };
    const preview = await smokeDemo({ dryRun: true }, deps), output = [];
    const code = await main(['smoke-demo', '--locale', 'en', '--confirm', preview.planHash, '--json'],
      { ...deps, stdout: (line) => output.push(line), stderr: assert.fail });
    const result = JSON.parse(output.join(''));
    assert.equal(code, 0, result.reasons.join('; '));
    assert.equal(result.status, 'pass'); assert.equal(result.confirmed, true);
    assert.equal(result.demands.length, 5);
    assert.ok(result.demands.every((row) => row.verdict === 'approved'));
    assert.equal(result.demands.find((row) => row.key === 'tickets').reworkRounds, 1);
    assert.equal(calls.length, 12); assert.equal(result.turns, 12); assert.equal(result.tokens, 180);
    assert.equal(result.reportsCost, client !== 'codex');
    assert.equal(result.reservedUsd, 0);
    if (client === 'codex') assert.equal(result.costUsd, null);
    else assert.ok(Math.abs(result.costUsd - 0.12) < 1e-10);
    assert.match(result.text, /This work uses your allowance/);
    assert.match(result.text, /tokens: 180 \/ max 1000/);
    assert.doesNotMatch(result.text, /This test uses injected helpers/);
    assert.equal(result.planHash, preview.planHash); assert.deepEqual(result.plan, JSON.parse(JSON.stringify(preview.plan)));
  }
});

test('MCP confirmation runs real drivers and localizes the final report', async (t) => {
  for (const client of ['claude-code', 'codex']) {
    const deps = await fixture(t, client), calls = [];
    deps.config.smoke.maxTokens = 1000; deps.spawn = launcher(client, calls);
    const preview = JSON.parse(await tool.handler({ dryRun: true, locale: 'pt-BR' }, deps));
    const result = JSON.parse(await tool.handler({ confirm: preview.planHash, locale: 'pt-BR' }, deps));
    assert.equal(result.exitCode, 0, result.reasons.join('; '));
    assert.equal(calls.length, 12); assert.equal(result.tokens, 180);
    assert.match(result.text, /Este trabalho usa sua cota/);
    assert.match(result.text, /tokens: 180 \/ máximo 1000/);
    assert.match(result.text, client === 'codex' ? /Este cliente não informa custo em dinheiro/
      : /Custo total medido: USD/);
  }
});

test('no-cost client without tokens and absent or wrong confirmation never launch', async (t) => {
  const deps = await fixture(t), calls = [];
  deps.spawn = launcher('codex', calls);
  const preview = await smokeDemo({ dryRun: true }, deps);
  for (const confirm of [undefined, 'wrong', preview.planHash]) {
    const result = await smokeDemo({ confirm }, deps);
    assert.equal(result.exitCode, 2); assert.equal(result.status, 'refused');
    assert.match(result.text, confirm === preview.planHash ? /smoke.maxTokens/ : /Confirm the current preview/);
  }
  assert.equal(calls.length, 0);
});

const previewBaselines = {
  'claude-code/en': ['971a2aa94b8cadd8515328d103de410194bb9b0817047d1ee8c2e647b4aee439',
    '1cf99ad4c76186b5bee0fec56f578a11f1a687a191322456786c7f96a47352e3'],
  'claude-code/pt-BR': ['45f361d7a9937da360a133ddf75419a5bbbcef273eed981cca66735ea4c2f5c0',
    '6d6707128ce3371f4a077ce349d167d46aa2ce9d90978386a53f0b4c43e902ad'],
  'codex/en': ['949aa1e5d20e4bd011951eef5d76c1687e75fa32c7fe7ab740f382a540108f3c',
    '1c582c29c3ee7725e802c44c318a22a15cbf35545688b9e55c6096abb6aca265'],
  'codex/pt-BR': ['a841ea20ac301285a6a8eec920a745770e30d7ff8400e217a344683b566472cf',
    '6a2b20d5da03b3b26593e1040d6944c95960b3566c3015f96b2f9c6c29ab4fe7'],
  'opencode/en': ['c5281a25e321345dcd1e0c2c634f4c1fcf678684c5942f07f7b70b80aa4fd972',
    '5283f1e03cd4b0107dce473db5c159502bd6bba7b5fd0d42c9f962bc2372baf4'],
  'opencode/pt-BR': ['9d1f7614890021566c6d6125cdc2c2a136af19feff9f8f6bf0865f3542a7a499',
    'a669aa1edf1fcd28201f78a933ed3b03b800b91d42724d6be8c88e78d41a3b52'],
};

test('dry-run hash and text match the committed entry without launching', async (t) => {
  // SHA-256 of plan (it embeds the whole config, so it moves when a default does: D98 step 1 changed release.architectures) and exact preview text from the pre-D84 entry,
  // with the confirmed fixture and a fixed quota timestamp. No git subprocess.
  const baseline = previewBaselines;
  for (const client of ['claude-code', 'codex', 'opencode']) {
    const deps = await fixture(t, client);
    deps.spawn = () => assert.fail('preview must never launch');
    deps.snapshot.now = 1800000000000;
    deps.snapshot.clients[0].quota.readAt = deps.snapshot.now;
    deps.snapshot.clients[0].reading.recordedAt = new Date(deps.snapshot.now).toISOString();
    for (const locale of ['en', 'pt-BR']) {
      const args = { dryRun: true, locale };
      const result = await smokeDemo(args, deps), [hash, textHash] = baseline[`${client}/${locale}`];
      assert.equal(result.planHash, hash);
      assert.equal(createHash('sha256').update(result.text).digest('hex'), textHash);
      assert.equal(result.status, 'preview'); assert.equal(result.exitCode, 0);
    }
  }
});

test('real execution stops new calls at money and token ceilings', async (t) => {
  for (const ceiling of ['money', 'tokens']) {
    const client = ceiling === 'money' ? 'claude-code' : 'codex';
    const deps = await fixture(t, client), calls = [];
    deps.config.limits.global = 1;
    Object.assign(deps.config.smoke, ceiling === 'money' ? { maxUsd: 0.05, demoDemandMaxUsd: 0.05 }
      : { maxTokens: 15 });
    deps.spawn = launcher(client, calls, 0.05);
    const preview = await smokeDemo({ dryRun: true }, deps);
    const result = await smokeDemo({ confirm: preview.planHash }, deps);
    assert.equal(result.status, 'partial'); assert.equal(result.exitCode, 1);
    assert.equal(calls.length, 1); assert.equal(result.tokens, 15);
    assert.equal(result.costUsd, ceiling === 'money' ? 0.05 : null);
    assert.equal(result.reservedUsd, 0);
    assert.match(result.reasons.join('; '), /ceiling/);
    assert.ok(result.demands.some((row) => row.verdict === 'skipped' && row.attempts.length === 0));
  }
});

test('spawn receives only scratch paths, PATH and the selected client credentials', async (t) => {
  const permissions = { 'claude-code': ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL'], codex: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'], opencode: [] };
  for (const client of Object.keys(permissions)) {
    const deps = await fixture(t, client), calls = [];
    Object.assign(deps.env, { PATH: '/fake/bin', UNRELATED_SECRET: 'must-not-leak',
      OPENCODE_CONFIG: 'must-not-pass', OPENCODE_CONFIG_DIR: '/private/config' },
    Object.fromEntries(Object.values(permissions).flat().map((key) => [key, `fake-${key}`])));
    deps.config.smoke.maxTokens = 15; deps.config.limits.global = 1;
    deps.spawn = launcher(client, calls);
    const preview = await smokeDemo({ dryRun: true }, deps);
    await smokeDemo({ confirm: preview.planHash }, deps);
    assert.equal(calls.length, 1);
    const env = calls[0].env;
    const paths = ['HOME', 'OKWORK_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME'];
    assert.deepEqual(Object.keys(env).sort(), [...paths, 'PATH', ...permissions[client]].sort());
    for (const key of permissions[client]) assert.equal(env[key], deps.env[key]);
    assert.equal(env.PATH, '/fake/bin');
    assert.ok(paths.every((key) => env[key].startsWith(env.HOME.replace(/home$/, ''))));
    assert.ok(!Object.values(env).includes('must-not-leak'));
  }
});

test('confirmation binds work, settings, helpers and allowance to the preview', async (t) => {
  const deps = await fixture(t);
  const preview = await smokeDemo({ dryRun: true }, deps);
  const args = { confirm: preview.planHash };
  const unchanged = await smokeDemo(args, deps);
  assert.equal(unchanged.confirmed, true);
  assert.equal(unchanged.status, 'refused');
  assert.match(unchanged.text, /smoke.maxTokens/);
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

test('a missing or empty PATH refuses before any helper is built, launched or paid', async (t) => {
  for (const client of ['claude-code', 'codex', 'opencode']) {
    for (const missing of ['absent', 'empty']) {
      for (const via of ['smokeDemo', 'main']) {
        const label = `${client} ${missing} via ${via}`;
        const deps = await fixture(t, client), calls = [];
        if (missing === 'absent') delete deps.env.PATH; else deps.env.PATH = '';
        deps.config.smoke.maxTokens = 15; deps.spawn = launcher(client, calls);
        const preview = await smokeDemo({ dryRun: true }, deps);
        let result, code;
        if (via === 'smokeDemo') { result = await smokeDemo({ confirm: preview.planHash }, deps); code = result.exitCode; }
        else {
          const output = [];
          code = await main(['smoke-demo', '--confirm', preview.planHash, '--json'],
            { ...deps, stdout: (line) => output.push(line), stderr: assert.fail });
          result = JSON.parse(output.join(''));
        }
        assert.equal(code, 2, label); assert.equal(result.status, 'refused', label);
        assert.equal(calls.length, 0, label);
        assert.match(result.reasons.join('; '), /PATH is missing from the environment, so the helper cannot be found\. \/ O PATH não está no ambiente, então o ajudante não pode ser encontrado\./, label);
        assert.equal(result.tokens, 0, label); assert.equal(result.reservedUsd, 0, label);
        assert.ok(result.demands.every((row) => row.attempts.length === 0), label);
        assert.equal(result.cleanup.removed, true, label);
        await assert.rejects(access(result.cleanup.root), label);
      }
    }
  }
});

test('spawn receives the same non-empty PATH as the caller', async (t) => {
  for (const client of ['claude-code', 'codex', 'opencode']) {
    for (const via of ['smokeDemo', 'main']) {
      const deps = await fixture(t, client), calls = [];
      deps.env.PATH = '/caller/bin:/usr/bin';
      deps.config.smoke.maxTokens = 15; deps.spawn = launcher(client, calls);
      const preview = await smokeDemo({ dryRun: true }, deps);
      if (via === 'smokeDemo') await smokeDemo({ confirm: preview.planHash }, deps);
      else await main(['smoke-demo', '--confirm', preview.planHash, '--json'],
        { ...deps, stdout: () => {}, stderr: assert.fail });
      assert.equal(calls.length, 1, `${client} via ${via}`);
      assert.equal(calls[0].env.PATH, '/caller/bin:/usr/bin', `${client} via ${via}`);
    }
  }
});

test('PATH is found whatever its letter case and reaches spawn as PATH', async (t) => {
  for (const key of ['Path', 'path']) {
    const deps = await fixture(t), calls = [];
    delete deps.env.PATH; deps.env[key] = '/mixed/bin';
    deps.config.smoke.maxTokens = 15; deps.spawn = launcher('codex', calls);
    const preview = await smokeDemo({ dryRun: true }, deps);
    const result = await smokeDemo({ confirm: preview.planHash }, deps);
    assert.doesNotMatch(result.reasons.join('; '), /PATH is missing/, key);
    assert.equal(calls.length, 1, key);
    assert.equal(calls[0].env.PATH, '/mixed/bin', key);
    assert.equal(Object.hasOwn(calls[0].env, key), false, key);
  }
});

test('real execution runs demands in sequence even when the limits allow several at once', async (t) => {
  const deps = await fixture(t), calls = [];
  deps.config.limits.global = 3; deps.config.smoke.maxTokens = 1000;
  const succeeds = launcher('codex', calls);
  let inFlight = 0, maxInFlight = 0;
  deps.spawn = (command, args, options) => {
    inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
    const child = succeeds(command, args, options), emit = child.emit.bind(child);
    child.emit = (name, ...rest) => {
      if (name !== 'close') return emit(name, ...rest);
      setTimeout(() => { inFlight -= 1; emit(name, ...rest); }, 5);
      return true;
    };
    return child;
  };
  const preview = await smokeDemo({ dryRun: true }, deps);
  const result = await smokeDemo({ confirm: preview.planHash }, deps);
  assert.equal(maxInFlight, 1);
  assert.equal(result.status, 'pass');
  assert.equal(result.demands.length, 5);
  assert.ok(result.demands.every((row) => row.verdict === 'approved'));
});

// Cancelling with Claude Code and no `result` event leaves the reservation visible on purpose (D89).
test('an aborted signal stops new helper calls, removes the practice folder and leaves nothing reserved', async (t) => {
  const deps = await fixture(t), calls = [], controller = new AbortController();
  deps.config.smoke.maxTokens = 1000; deps.signal = controller.signal;
  const succeeds = launcher('codex', calls);
  deps.spawn = (command, args, options) => {
    const child = succeeds(command, args, options);
    controller.abort(new Error('stop'));
    return child;
  };
  const preview = await smokeDemo({ dryRun: true }, deps);
  const result = await smokeDemo({ confirm: preview.planHash }, deps);
  assert.equal(calls.length, 1);
  assert.notEqual(result.status, 'pass');
  assert.equal(result.cleanup.removed, true);
  await assert.rejects(access(result.cleanup.root));
  assert.equal(result.reservedUsd, 0);
});

test('the MCP tool passes the process environment when its context has none', async (t) => {
  const permissions = { 'claude-code': ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL'], codex: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'], opencode: [] };
  const keys = ['PATH', 'UNRELATED_SECRET', ...Object.values(permissions).flat()];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  });
  process.env.PATH = '/process/bin'; process.env.UNRELATED_SECRET = 'must-not-leak';
  for (const key of Object.values(permissions).flat()) process.env[key] = `process-${key}`;
  for (const client of Object.keys(permissions)) {
    const { env, ...ctx } = await fixture(t, client), calls = [];
    assert.equal(Object.hasOwn(ctx, 'env'), false);
    ctx.config.smoke.maxTokens = 15; ctx.spawn = launcher(client, calls);
    const preview = JSON.parse(await tool.handler({ dryRun: true }, ctx));
    await tool.handler({ confirm: preview.planHash }, ctx);
    assert.equal(calls.length, 1, client);
    assert.equal(calls[0].env.PATH, '/process/bin', client);
    for (const key of permissions[client]) assert.equal(calls[0].env[key], `process-${key}`, `${client} ${key}`);
    assert.ok(!Object.values(calls[0].env).includes('must-not-leak'), client);
  }
});
