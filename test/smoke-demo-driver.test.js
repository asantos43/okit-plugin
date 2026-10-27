import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { realDrivers } from '../src/smoke/demo/driver.js';
import { clientRequest } from '../src/smoke/client.js';

const clients = ['claude-code', 'codex', 'opencode'];
const TEST_CONFIG = { smoke: { maxTokens: 1000 } };
function eventsFor(client, text = 'Files are ready. / Os arquivos estão prontos.') {
  if (client === 'claude-code') return [{ type: 'result', result: text,
    total_cost_usd: 0.02, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } }];
  if (client === 'codex') return [
    { type: 'item.completed', item: { type: 'agent_message', text } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
  ];
  return [{ type: 'text', part: { text } },
    { type: 'step_finish', part: { reason: 'stop', cost: 0.02, tokens: { input: 10, output: 5 } } }];
}

for (const client of clients) {
  for (const stop of ['timeout', 'abort']) {
    test(`${client}: ${stop} throws and retains measured usage`, async (t) => {
      const briefing = await fixture(t);
      const controller = new AbortController();
      briefing.signal = controller.signal;
      briefing.limits.timeoutMs = stop === 'timeout' ? 5 : 1000;
      let signal;
      const { actor } = realDrivers({ client, config: TEST_CONFIG, spawn: fakeSpawn(eventsFor(client), { hang: true,
        capture: (value) => { signal = value.signal; },
        afterEmit: stop === 'abort' ? () => setImmediate(() => controller.abort()) : undefined,
      }) });
      const pending = actor.run(briefing);
      await assert.rejects(pending, (error) => {
        assert.match(error.message, stop === 'timeout' ? /too long.*demorou/ : /interrupted.*interrompido/);
        assert.equal(error.usage.tokens, 15);
        assert.equal(error.usage.turns, 1);
        assert.equal(error.usage.costUsd, client === 'codex' ? 0 : 0.02);
        assert.ok(error.events.some((event) => event.type === 'result'));
        return true;
      });
      assert.equal(signal.aborted, true);
    });
  }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'okit-demo-driver-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'work/task');
  await mkdir(cwd, { recursive: true });
  return { root, cwd, env: { HOME: join(root, 'home'), DEMO: 'isolated' },
    signal: new AbortController().signal, allowedOutputPaths: ['work/task/result.txt', 'work/task/missing.txt'],
    limits: { timeoutMs: 1000, maxTurns: 3, maxUsd: 0.1 }, text: 'Write the requested file.',
    acceptance: [{ path: 'result.txt', text: 'done' }], failedCriteria: ['Fix the missing line.'],
    actor: { model: 'example-model', effort: 'medium' }, profile: { maxTurns: 3 } };
}

// | Must pass | Must refuse |
// | reported money and tokens; Codex tokens without money | absent, negative or partly unknown usage |
for (const client of clients) {
  test(`${client}: unknown usage is never reported as free`, async (t) => {
    const briefing = await fixture(t);
    const missing = eventsFor(client);
    const last = missing.at(-1);
    if (client === 'opencode') delete last.part.tokens;
    else delete last.usage;
    const invalid = eventsFor(client);
    if (client === 'opencode') invalid.at(-1).part.tokens.input = -1;
    else invalid.at(-1).usage.input_tokens = -1;
    for (const lines of [missing, invalid]) {
      const { actor } = realDrivers({ client, config: TEST_CONFIG, spawn: fakeSpawn(lines) });
      const response = await actor.run(briefing);
      assert.equal(response.usage.costUsd, null);
      assert.equal(response.usage.tokens, null);
    }
    if (client === 'codex') return;
    for (const cost of [undefined, null, -1]) {
      const lines = eventsFor(client);
      if (client === 'opencode') lines.at(-1).part.cost = cost;
      else lines.at(-1).total_cost_usd = cost;
      const response = await realDrivers({ client, config: TEST_CONFIG, spawn: fakeSpawn(lines) }).actor.run(briefing);
      assert.equal(response.usage.costUsd, null);
      assert.equal(response.usage.tokens, 15);
    }
  });
}

function fakeSpawn(lines, { capture = () => {}, write, afterEmit, hang = false, fail, exit = 0 } = {}) {
  return (command, args, options) => {
    capture({ command, args, ...options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    const abort = () => child.emit('error', new Error('fake abort'));
    options.signal.addEventListener('abort', abort, { once: true });
    queueMicrotask(async () => {
      try { await write?.(); } catch (error) { child.emit('error', error); return; }
      for (const line of lines) child.stdout.emit('data', `${JSON.stringify(line)}\n`);
      afterEmit?.();
      if (hang) return;
      options.signal.removeEventListener('abort', abort);
      if (fail) child.emit('error', fail);
      else child.emit('close', exit);
    });
    return child;
  };
}

for (const client of ['codex', 'opencode']) {
  test(`${client}: adds steps and refuses partly unknown totals`, async (t) => {
    const briefing = await fixture(t);
    const lines = eventsFor(client);
    const earlier = client === 'codex' ? { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2 } }
      : { type: 'step_finish', part: { reason: 'tool-calls', cost: 0.01, tokens: { input: 3, output: 2 } } };
    lines.unshift(earlier);
    const response = await realDrivers({ client, config: TEST_CONFIG, spawn: fakeSpawn(lines) }).actor.run(briefing);
    assert.deepEqual(response.usage, { costUsd: client === 'codex' ? 0 : 0.03, tokens: 20, turns: 2 });
    if (client === 'codex') earlier.usage.input_tokens = -1;
    else delete earlier.part.cost;
    const unknown = await realDrivers({ client, config: TEST_CONFIG, spawn: fakeSpawn(lines) }).actor.run(briefing);
    assert.equal(unknown.usage.costUsd, null);
    if (client === 'codex') delete earlier.usage;
    else { earlier.part.cost = 0.01; delete earlier.part.tokens; }
    const missing = await realDrivers({ client, config: TEST_CONFIG, spawn: fakeSpawn(lines) }).actor.run(briefing);
    assert.equal(missing.usage.costUsd, null);
    assert.equal(missing.usage.tokens, null);
    if (client === 'opencode') {
      earlier.part.tokens = { input: 3, output: 2 };
      earlier.part.cost = 0;
      const zero = await realDrivers({ client, config: TEST_CONFIG, spawn: fakeSpawn(lines) }).actor.run(briefing);
      assert.equal(zero.usage.costUsd, null);
    }
  });
}

test('requires injected spawn and never launches a pre-aborted briefing', async (t) => {
  assert.throws(() => realDrivers({ client: 'codex' }), /Provide a helper launcher/);
  const briefing = await fixture(t), controller = new AbortController();
  controller.abort(); briefing.signal = controller.signal;
  const { actor } = realDrivers({ client: 'codex', config: TEST_CONFIG, spawn: () => assert.fail('must not launch') });
  await assert.rejects(actor.run(briefing), (error) => error.usage.costUsd === null && /interrupted/.test(error.message));
});

test('uses the shorter configured deadline and keeps partial OpenCode usage', async (t) => {
  const briefing = await fixture(t);
  briefing.limits.timeoutMs = 60000;
  const { actor } = realDrivers({ client: 'opencode', config: { smoke: { checkTimeoutMs: 5 } },
    spawn: fakeSpawn([{ type: 'step_finish', part: {
      reason: 'tool-calls', cost: 0.01, tokens: { input: 3, output: 2 } } }], { hang: true }) });
  const started = Date.now();
  await assert.rejects(actor.run(briefing), (error) => {
    assert.match(error.message, /too long/);
    assert.deepEqual(error.usage, { costUsd: 0.01, tokens: 5, turns: 1 });
    return true;
  });
  assert.ok(Date.now() - started < 5000, 'configured deadline must reject in less than 5000 ms');
});

test('unsafe allowed paths and symbolic links cannot become artifacts', async (t) => {
  const briefing = await fixture(t);
  const actor = realDrivers({ client: 'codex', config: TEST_CONFIG, spawn: fakeSpawn(eventsFor('codex')) }).actor;
  for (const path of ['../outside.txt', join(briefing.root, 'outside.txt')]) {
    await assert.rejects(actor.run({ ...briefing, allowedOutputPaths: [path] }),
      (error) => /unsafe path/.test(error.message) && error.usage.tokens === 15);
  }
  await writeFile(join(briefing.root, 'private.txt'), 'private');
  await symlink(join(briefing.root, 'private.txt'), join(briefing.cwd, 'result.txt'));
  await assert.rejects(actor.run(briefing), /unsafe symlink/);
});

for (const client of clients) {
  test(`${client}: reuses configured client arguments and refuses error-result approval`, async (t) => {
    const briefing = await fixture(t);
    const lines = eventsFor(client, '{"verdict":"approved","criteria":[],"feedback":"ok"}');
    lines.push(client === 'claude-code' ? { ...lines.at(-1), is_error: true }
      : client === 'codex' ? { type: 'turn.failed', usage: { input_tokens: 0, output_tokens: 0 } }
        : { type: 'error' });
    const { critic } = realDrivers({ client, config: TEST_CONFIG, spawn: fakeSpawn(lines, { capture: ({ command, args }) => {
      const request = clientRequest(client, {}, { briefing: args.find((arg) => arg.includes('Reply with')),
        maxUsd: client === 'codex' ? 0 : briefing.limits.maxUsd, cwd: briefing.cwd });
      assert.equal(command, request.command);
      assert.deepEqual(args, request.args);
    } }) });
    assert.equal((await critic.review({ briefing, result: {}, artifacts: [], checks: [] })).verdict, 'rejected');
  });
}

async function mutant(from, to) {
  const url = new URL('../src/smoke/demo/driver.js', import.meta.url);
  const original = await readFile(url, 'utf8');
  assert.ok(original.includes(from), 'mutation must match the real implementation');
  const source = original.replace(from, to).replace(/from '(\.[^']+)'/g,
    (match, path) => `from '${new URL(path, url).href}'`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('clients without money measurement require a positive token allowance before launch', () => {
  const spawn = () => assert.fail('an invalid allowance must never launch');
  for (const maxTokens of [undefined, null, 0, -1, 1.5]) {
    assert.throws(() => realDrivers({ client: 'codex', spawn, config: { smoke: { maxTokens } } }),
      /smoke.maxTokens.*positive whole number.*inteiro positivo/);
  }
  assert.throws(() => realDrivers({ client: 'codex', spawn }), /smoke.maxTokens/);
  assert.throws(() => realDrivers({ client: 'opencode', spawn, config: {
    smokeDrivers: { opencode: { reportsCost: false } },
  } }), /smoke.maxTokens/);
});

// | Must pass | Must refuse |
// | allowed files and client/work folders | created, changed or removed files in another demand |
for (const client of clients) {
  test(`${client}: writes to another demand reject with measured usage`, async (t) => {
    const briefing = await fixture(t);
    const target = join(briefing.root, 'work/other/x');
    let writes = 0;
    const drivers = realDrivers({ client, config: TEST_CONFIG, spawn: fakeSpawn(eventsFor(client), {
      write: async () => {
        await mkdir(join(briefing.root, 'work/other'), { recursive: true });
        await writeFile(target, `changed-${'x'.repeat(++writes)}`);
      },
    }) });
    for (const run of [() => drivers.actor.run(briefing),
      () => drivers.critic.review({ briefing, result: {}, artifacts: [], checks: [] })]) {
      await assert.rejects(run(), (error) => {
        assert.match(error.message, /wrote outside the allowed files.*escreveu fora dos arquivos permitidos/);
        assert.equal(error.usage.tokens, 15);
        assert.equal(error.usage.costUsd, client === 'codex' ? 0 : 0.02);
        assert.ok(error.events.length > 0);
        return true;
      });
    }
  });
}

test('Codex enforces the token allowance per call for both roles and retains usage', async (t) => {
  const briefing = await fixture(t);
  for (const maxTokens of [15, 14]) {
    const drivers = realDrivers({ client: 'codex', config: { smoke: { maxTokens } },
      spawn: fakeSpawn(eventsFor('codex', '{"verdict":"approved","criteria":[],"feedback":"ok"}')) });
    for (const run of [() => drivers.actor.run(briefing),
      () => drivers.critic.review({ briefing, result: {}, artifacts: [], checks: [] })]) {
      if (maxTokens === 15) assert.equal((await run()).usage.tokens, 15);
      else await assert.rejects(run(), (error) => {
        assert.match(error.message, /exceeded the text allowance.*ultrapassou o limite de texto/);
        assert.deepEqual(error.usage, { costUsd: 0, tokens: 15, turns: 1 });
        assert.ok(error.events.length > 0);
        return true;
      });
    }
  }
});

test('allowed outputs, the demand folder and client settings may change', async (t) => {
  const briefing = await fixture(t);
  briefing.env.CODEX_HOME = join(briefing.root, 'codex-settings');
  briefing.allowedOutputPaths.push('outputs/approved.txt');
  const { actor } = realDrivers({ client: 'codex', config: TEST_CONFIG,
    spawn: fakeSpawn(eventsFor('codex'), { write: async () => {
      for (const folder of [briefing.env.HOME, briefing.env.CODEX_HOME, join(briefing.root, 'outputs')]) {
        await mkdir(folder, { recursive: true });
      }
      await writeFile(join(briefing.cwd, 'result.txt'), 'done');
      await writeFile(join(briefing.cwd, 'notes.txt'), 'scratch');
      await writeFile(join(briefing.env.HOME, 'session'), 'client session');
      await writeFile(join(briefing.env.CODEX_HOME, 'config'), 'client config');
      await writeFile(join(briefing.root, 'outputs/approved.txt'), 'approved');
    } }) });
  assert.deepEqual((await actor.run(briefing)).artifacts, [
    { path: 'work/task/result.txt', content: 'done' }, { path: 'outputs/approved.txt', content: 'approved' },
  ]);
});

test('changes and deletions to the shared state are detected', async (t) => {
  const briefing = await fixture(t);
  await mkdir(join(briefing.root, 'state'));
  const target = join(briefing.root, 'state/config.json');
  for (const change of [() => writeFile(target, '{"changed":true}'), () => rm(target)]) {
    await writeFile(target, '{}');
    const { actor } = realDrivers({ client: 'claude-code', spawn: fakeSpawn(eventsFor('claude-code'), { write: change }) });
    await assert.rejects(actor.run(briefing), /wrote outside the allowed files/);
  }
});

test('directory scans translate access errors and treat disappearing entries as changes', async (t) => {
  for (const method of ['lstat', 'readdir']) {
    for (const code of ['ENOENT', 'EACCES']) {
      await t.test(`${method}: ${code} after the helper finishes`, async (t) => {
        const briefing = await fixture(t);
        const target = join(briefing.root, 'checked-entry');
        if (method === 'readdir') await mkdir(target);
        else await writeFile(target, 'original');
        let after = false;
        const original = fs[method];
        t.mock.method(fs, method, async (path, ...args) => {
          if (after && path === target) {
            if (code === 'ENOENT') await rm(target, { recursive: true, force: true });
            throw Object.assign(new Error('simulated scan failure'), { code });
          }
          return original(path, ...args);
        });
        syncBuiltinESMExports();
        t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
        const { actor } = realDrivers({ client: 'claude-code', spawn: fakeSpawn(eventsFor('claude-code'), {
          capture: () => { after = true; },
        }) });
        await assert.rejects(actor.run(briefing), (error) => {
          assert.match(error.message, code === 'ENOENT'
            ? /wrote outside the allowed files.*escreveu fora dos arquivos permitidos/
            : /Could not check the files.*Não foi possível conferir os arquivos/);
          if (code === 'EACCES') assert.equal(error.cause.code, code);
          assert.deepEqual(error.usage, { costUsd: 0.02, tokens: 15, turns: 1 });
          assert.ok(error.events.length > 0);
          return true;
        });
      });
    }
  }
});

test('artifacts must be regular files no larger than 128 KiB', async (t) => {
  for (const kind of ['directory', 'large', 'boundary']) {
    const briefing = await fixture(t);
    const target = join(briefing.cwd, 'result.txt');
    const { actor } = realDrivers({ client: 'claude-code', spawn: fakeSpawn(eventsFor('claude-code'), {
      write: () => kind === 'directory' ? mkdir(target) : writeFile(target, Buffer.alloc(128 * 1024 + (kind === 'large' ? 1 : 0))),
    }) });
    if (kind === 'boundary') assert.equal((await actor.run(briefing)).artifacts[0].content.length, 128 * 1024);
    else await assert.rejects(actor.run(briefing), (error) => {
      assert.match(error.message, /regular file.*128 KiB.*arquivo comum/);
      assert.deepEqual(error.usage, { costUsd: 0.02, tokens: 15, turns: 1 });
      assert.ok(error.events.length > 0);
      return true;
    });
  }
});

test('mutation guard kills approval of an unparseable critic answer', async (t) => {
  const briefing = await fixture(t);
  const check = async (factory) => {
    const { critic } = factory({ client: 'codex', config: TEST_CONFIG, spawn: fakeSpawn(eventsFor('codex', 'garbage approved')) });
    const response = await critic.review({ briefing, result: {}, artifacts: [], checks: [] });
    assert.equal(response.verdict, 'rejected');
  };
  await check(realDrivers);
  const changed = await mutant("verdict: valid ? answer.verdict : 'rejected'",
    "verdict: valid ? answer.verdict : 'approved'");
  await assert.rejects(check(changed.realDrivers), { code: 'ERR_ASSERTION' });
});

test('mutation guard kills reporting unknown usage as free', async (t) => {
  const briefing = await fixture(t);
  const check = async (factory) => {
    const lines = eventsFor('codex'); delete lines.at(-1).usage;
    const response = await factory({ client: 'codex', config: TEST_CONFIG, spawn: fakeSpawn(lines) }).actor.run(briefing);
    assert.equal(response.usage.costUsd, null);
  };
  await check(realDrivers);
  const changed = await mutant('tokens === null || state.unknownCost ? null',
    'tokens === null || state.unknownCost ? 0');
  await assert.rejects(check(changed.realDrivers), { code: 'ERR_ASSERTION' });
});

for (const client of clients) {
  test(`${client}: executor reads allowed artifacts and preserves launch settings`, async (t) => {
    const briefing = await fixture(t);
    let launch;
    const lines = eventsFor(client, '{"artifacts":[{"path":"work/task/extra.txt","content":"ignore"}]}');
    const config = { smoke: { maxTokens: 1000, demoDemandMaxUsd: 0.1 }, smokeDrivers: { [client]: {
      command: 'fake-helper', args: ['{briefing}', '{maxUsd}', '{cwd}', '{model}', '{effort}', '{maxTurns}'],
    } } };
    const drivers = realDrivers({ client, config, spawn: fakeSpawn(lines, {
      capture: (value) => { launch = value; }, write: async () => {
        await writeFile(join(briefing.cwd, 'result.txt'), 'done');
        await writeFile(join(briefing.cwd, 'extra.txt'), 'ignore');
      },
    }) });
    const result = await drivers.actor.run(briefing);
    assert.deepEqual(result.artifacts, [{ path: 'work/task/result.txt', content: 'done' }]);
    assert.deepEqual(result.usage, { costUsd: client === 'codex' ? 0 : 0.02, tokens: 15, turns: 1 });
    assert.equal(drivers.actor.maxCostUsd, client === 'codex' ? 0 : 0.1);
    assert.equal(drivers.critic.maxCostUsd, drivers.actor.maxCostUsd);
    assert.equal(result.status, 'completed');
    assert.match(result.transcript, /result|turn.completed|step_finish/);
    assert.equal(launch.command, 'fake-helper');
    assert.equal(launch.cwd, briefing.cwd);
    assert.equal(launch.env, briefing.env);
    assert.match(launch.args[0], /Write the requested file/);
    assert.match(launch.args[0], /Fix the missing line/);
    assert.match(launch.args[0], /work\/task\/result.txt/);
    assert.equal(launch.args[1], client === 'codex' ? '0' : '0.1');
    assert.deepEqual(launch.args.slice(2), [briefing.cwd, 'example-model', 'medium', '3']);
  });

  // | Must pass | Must refuse |
  // | whole valid JSON with approved | garbage, prose, missing/other verdict, wrong shape |
  const corpus = [
    ['{"verdict":"approved","criteria":[],"feedback":"Ready / Pronto"}', 'approved'],
    ['{"verdict":"rejected","criteria":["missing"],"feedback":"Fix it / Corrija"}', 'rejected'],
    ['garbage approved', 'rejected'], ['{"criteria":[],"feedback":"approved"}', 'rejected'],
    ['{"verdict":"APPROVED","criteria":[],"feedback":"ok"}', 'rejected'],
    ['{"verdict":"approve","criteria":[],"feedback":"ok"}', 'rejected'],
    ['{"verdict":"approved"}', 'rejected'], ['null', 'rejected'], ['[]', 'rejected'],
    ['{"verdict":"approved","criteria":{},"feedback":"ok"}', 'rejected'],
    ['{"verdict":"approved","criteria":[],"feedback":true}', 'rejected'],
    ['prose {"verdict":"approved","criteria":[],"feedback":"ok"}', 'rejected'],
    ['```json\n{"verdict":"approved","criteria":[],"feedback":"ok"}\n```', 'rejected'],
    ['{"verdict":"approved","criteria":[],"feedback":"ok"}\n{}', 'rejected'],
  ];
  test(`${client}: critic approval requires exact valid JSON`, async (t) => {
    const briefing = await fixture(t);
    for (const [text, verdict] of corpus) {
      const { critic } = realDrivers({ client, config: TEST_CONFIG, spawn: fakeSpawn(eventsFor(client, text), {
        capture: ({ args }) => {
          assert.ok(args.some((arg) => arg.includes('Reply with one JSON object only')));
          assert.ok(args.some((arg) => arg.includes('disk-check')));
        },
      }) });
      const response = await critic.review({ briefing, result: { summary: 'ready' },
        artifacts: [], checks: ['disk-check'] });
      assert.equal(response.verdict, verdict, text);
      assert.equal(response.usage.tokens, 15);
      assert.equal(response.usage.costUsd, client === 'codex' ? 0 : 0.02);
      if (text === 'garbage approved') assert.match(response.feedback, /could not be read.*Não foi possível/);
      if (text.includes('Fix it')) assert.equal(response.feedback, 'Fix it / Corrija');
    }
  });

  test(`${client}: no final result throws with partial events and usage`, async (t) => {
    const briefing = await fixture(t);
    const lines = client === 'opencode' ? [{ type: 'step_finish', part: {
      reason: 'tool-calls', cost: 0.01, tokens: { input: 3, output: 2 } } }]
      : eventsFor(client).slice(0, client === 'codex' ? 1 : 0);
    const { actor } = realDrivers({ client, config: TEST_CONFIG, spawn: fakeSpawn(lines, { exit: 1 }) });
    await assert.rejects(actor.run(briefing), (error) => {
      assert.match(error.message, /stopped before finishing/);
      assert.ok(Array.isArray(error.events));
      assert.equal(error.usage.costUsd, client === 'opencode' ? 0.01 : null);
      assert.equal(error.usage.tokens, client === 'opencode' ? 5 : null);
      return true;
    });
  });
}
