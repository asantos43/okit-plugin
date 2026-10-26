import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, rm, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { collectStatusline, statuslineCommand } from '../src/quota/statusline-collector.js';
import { readQuota } from '../adapters/claude-code/index.js';
import { configOf } from '../src/profiles.js';
import { main } from '../src/cli.js';

const input = Buffer.from('{"rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1793003358},"seven_day":{"used_percentage":41.2,"resets_at":1793513484}},"extra":true}\n');
const now = () => Date.UTC(2026, 9, 26);
async function rootFor(t) {
  const root = await mkdtemp(join(tmpdir(), 'okit-collector-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const quotaFile = (root) => join(root, 'quota', 'claude-code.json');
const echoInput = 'const fs=require("node:fs");fs.writeSync(1,fs.readFileSync(0));';
test('executable is hermetic with empty HOME and never imports daemon or MCP', async (t) => {
  const root = await rootFor(t);
  const loader = join(root, 'guard.mjs');
  await writeFile(loader, 'export async function resolve(s,c,n){if(s.includes("daemon.js")||s.includes("/mcp/"))throw Error("heavy import: "+s);return n(s,c)}');
  const previous = [process.execPath, '-e', echoInput];
  await writeFile(join(root, 'config.json'), JSON.stringify({ statuslineCollector: { previous } }));
  const started = performance.now();
  await writeFile(join(root, 'input'), input);
  const stdin = await open(join(root, 'input'), 'r');
  const stdout = await open(join(root, 'output'), 'w');
  t.after(async () => { await stdin.close(); await stdout.close(); });
  const child = spawn(process.execPath, ['--loader', loader, 'src/cli.js', 'statusline-collector'], {
    env: { ...process.env, HOME: '', USERPROFILE: '', OKWORK_HOME: root }, stdio: [stdin.fd, stdout.fd, 'pipe'],
  });
  const errors = [];
  child.stderr.on('data', (bytes) => errors.push(bytes));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', resolve);
  });
  assert.equal(code, 0, Buffer.concat(errors).toString());
  assert.deepEqual(await readFile(join(root, 'output')), input);
  assert.ok(performance.now() - started < 2000);
  assert.equal(JSON.parse(await readFile(quotaFile(root))).source, 'automatic');
});
test('invalid or absent quota preserves old bytes and still chains', async (t) => {
  const root = await rootFor(t);
  await collectStatusline({ input: '{}', stateRoot: root });
  await assert.rejects(readFile(quotaFile(root)), { code: 'ENOENT' });
  await collectStatusline({ input, stateRoot: root, now });
  const old = await readFile(quotaFile(root));
  for (const text of ['{', '{}', '{"rate_limits":null}', '{"rate_limits":{"five_hour":{"used_percentage":101,"resets_at":1}}}']) {
    let called = false;
    const output = await collectStatusline({ input: Buffer.from(text), stateRoot: root,
      previous: ['fake', 'arg'], run: async (request) => {
        called = true;
        assert.equal(request.input.toString(), text);
        assert.deepEqual(request.args, ['arg']);
        return Buffer.from('old bar\n');
      } });
    assert.ok(called);
    assert.equal(output.toString(), 'old bar\n');
    assert.deepEqual(await readFile(quotaFile(root)), old);
  }
});

test('oversized valid input skips quota and still chains; exact limit writes', async (t) => {
  for (const oversized of [true, false]) {
    const root = await rootFor(t);
    const config = { statuslineCollector: {
      maxInputBytes: Buffer.byteLength(input) - (oversized ? 1 : 0), previous: ['fake'],
    } };
    let calls = 0;
    const output = await collectStatusline({ input, stateRoot: root, config, now,
      run: async (request) => {
        calls++;
        assert.equal(request.command, 'fake');
        assert.deepEqual(request.input, input);
        return Buffer.from('previous bar\n');
      } });
    assert.equal(calls, 1);
    assert.deepEqual(output, Buffer.from('previous bar\n'));
    if (oversized) await assert.rejects(readFile(quotaFile(root)), { code: 'ENOENT' });
    else assert.equal(JSON.parse(await readFile(quotaFile(root))).remainingPct, 58.8);
  }
});

test('write failure still chains', async (t) => {
  const root = await rootFor(t);
  await writeFile(join(root, 'quota'), 'blocked');
  const output = await collectStatusline({ input, stateRoot: root, previous: ['fake'],
    run: async () => Buffer.from('bar') });
  assert.equal(output.toString(), 'bar');
});
// Input                         | Must pass                  | Must refuse
// valid configured windows      | atomic sample + chaining   | partial file
// absent/invalid quota          | preserve sample + chaining | invented quota
// missing/failing/slow previous | empty output, exit zero    | broken bar
test('concurrent readers only observe whole old or new samples', async (t) => {
  const root = await rootFor(t);
  await collectStatusline({ input, stateRoot: root, now });
  let active = true, reads = 0;
  const reader = (async () => {
    while (active) {
      const value = JSON.parse(await readFile(quotaFile(root)));
      assert.equal(value.windows.length, 2);
      assert.ok([58.8, 90].includes(value.remainingPct));
      reads++;
    }
  })();
  try {
    for (let i = 0; i < 15; i++) {
      await collectStatusline({ input: i % 2 ? input : input.toString().replace('41.2', '10').replace('23.5', '10'),
        stateRoot: root, now });
    }
  } finally { active = false; await reader; }
  assert.ok(reads > 0);
  assert.deepEqual(await readdir(join(root, 'quota')), ['claude-code.json']);
});

test('CLI bounded stdin and raw stdout; quota show has bilingual origin and age', async (t) => {
  const root = await rootFor(t);
  const output = [];
  await writeFile(join(root, 'config.json'), JSON.stringify({ statuslineCollector: {
    previous: ['fake'], maxInputBytes: 500, timeoutMs: 150 } }));
  const io = { root, now, stdin: Readable.from([input.subarray(0, 5), input.subarray(5)]),
    stdout: (bytes) => output.push(bytes), run: async ({ input }) => input };
  assert.equal(await main(['statusline-collector'], io), 0);
  assert.deepEqual(Buffer.concat(output), input);
  const lines = [];
  assert.equal(await main(['quota', 'show', 'claude-code'], { root, now,
    env: { HOME: root }, stdout: (line) => lines.push(line) }), 0);
  assert.match(lines.join('\n'), /automatic.*automática/);
  assert.match(lines.join('\n'), /0 min/);
  const manualIo = { root, now, env: { HOME: root }, stdout: (line) => lines.push(line) };
  assert.equal(await main(['quota', 'set', 'claude-code', '80'], manualIo), 0);
  assert.equal((await readQuota({ stateRoot: root, now })).source, 'user');
  assert.equal(await main(['quota', 'show', 'claude-code'], manualIo), 0);
  assert.match(lines.at(-1), /manual.*manual/);
  assert.equal(await statuslineCommand([], { ...io, stdin: Readable.from(['x'.repeat(501)]),
    run: () => assert.fail('must not forward truncated stdin') }), 0);
  const previous = [process.execPath, '-e', 'process.exit(1)'];
  const started = performance.now();
  for (const argv of [['--previous', ...previous], ['--previous', join(root, 'missing')],
    ['--previous', process.execPath, '-e', 'setInterval(()=>{},1000)']]) {
    const bytes = [];
    assert.equal(await statuslineCommand(argv, { root, stdin: Readable.from([input]),
      stdout: (chunk) => bytes.push(chunk) }), 0);
    assert.equal(Buffer.concat(bytes).length, 0);
  }
  assert.ok(performance.now() - started < 2000, 'CLI respects configured previous-command budget');
  await writeFile(join(root, 'config.json'), '{');
  output.length = 0;
  assert.equal(await statuslineCommand(['--previous', 'fake'], {
    ...io, stdin: Readable.from([input]) }), 0);
  assert.deepEqual(Buffer.concat(output), input, 'unreadable configuration must not stop explicit previous command');
});
test('previous failure, absence, timeout and output overflow stay silent', async (t) => {
  const root = await rootFor(t);
  const config = { statuslineCollector: { timeoutMs: 150, maxOutputBytes: 10 } };
  const started = performance.now();
  for (const previous of [[], [join(root, 'missing')],
    [process.execPath, '-e', 'require("node:fs").writeSync(1,"partial");process.exit(1)'],
    [process.execPath, '-e', 'setInterval(()=>{},1000)'],
    [process.execPath, '-e', 'require("node:fs").writeSync(1,"x".repeat(100))']]) {
    const output = await collectStatusline({ input, stateRoot: root, previous, config });
    assert.equal(output.length, 0);
  }
  assert.ok(performance.now() - started < 2000, 'configured previous-command budget');
});

test('configuration controls field names, windows and previous command', async (t) => {
  const root = await rootFor(t);
  const config = { statuslineCollector: { fields: { rateLimits: 'limits', usedPercentage: 'used', resetsAt: 'reset' },
    windows: { custom: 17 }, previous: ['fake'] } };
  const output = await collectStatusline({ input: '{"limits":{"custom":{"used":25,"reset":1}}}',
    stateRoot: root, config, run: async ({ command }) => Buffer.from(command) });
  assert.equal(output.toString(), 'fake');
  assert.equal(JSON.parse(await readFile(quotaFile(root))).windowMinutes, 17);
  for (const change of [{ timeoutMs: 0 }, { maxInputBytes: -1 }, { maxOutputBytes: 0 },
    { previous: 'shell text' }, { windows: {} }, { windows: { bad: 0 } }, { fields: { rateLimits: '' } }]) {
    assert.throws(() => configOf({ statuslineCollector: change }));
  }
});

test('sample writes all windows, tightest quota, automatic source and age', async (t) => {
  const root = await rootFor(t);
  await collectStatusline({ input, stateRoot: root, now });
  const stored = JSON.parse(await readFile(quotaFile(root)));
  assert.equal(stored.remainingPct, 58.8);
  assert.equal(stored.windowMinutes, 10080);
  assert.deepEqual(stored.windows, [
    { windowMinutes: 300, remainingPct: 76.5, resetsAt: new Date(1793003358000).toISOString() },
    { windowMinutes: 10080, remainingPct: 58.8, resetsAt: new Date(1793513484000).toISOString() },
  ]);
  const reading = await readQuota({ stateRoot: root, now: () => now() + 120000 });
  assert.equal(reading.source, 'automatic');
  assert.equal(reading.ageMinutes, 2);
  assert.deepEqual(reading.windows, stored.windows);
  await writeFile(quotaFile(root), JSON.stringify({ remainingPct: 80, recordedAt: stored.recordedAt }));
  assert.equal((await readQuota({ stateRoot: root, now })).source, 'user');
});

test('real previous command receives exact input and returns exact binary bytes', async (t) => {
  const root = await rootFor(t);
  const output = await collectStatusline({ input, stateRoot: root,
    previous: [process.execPath, '-e', echoInput + 'fs.writeSync(1,Buffer.from([0,255,13,10]));'] });
  assert.deepEqual(output, Buffer.concat([input, Buffer.from([0, 255, 13, 10])]));
});
