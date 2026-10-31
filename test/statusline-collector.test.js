import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, rm, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { collectStatusline, killTree, runPrevious, statuslineCommand, STATUSLINE_FILE } from '../src/quota/statusline-collector.js';
import { readQuota } from '../adapters/claude-code/index.js';
import { configOf } from '../src/profiles.js';
import { main } from '../src/cli.js';
import { readingOf } from '../src/core/statusline-reading.js';

const input = Buffer.from('{"rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1793003358},"seven_day":{"used_percentage":41.2,"resets_at":1793513484}},"extra":true}\n');
const now = () => Date.UTC(2026, 9, 26);
// `setsid` is not everywhere (stock macOS has none): the test that needs it
// skips itself when the tool is absent.
const HAS_SETSID = process.platform !== 'win32'
  && spawnSync('sh', ['-c', 'command -v setsid'], { stdio: 'ignore' }).status === 0;
async function rootFor(t) {
  const root = await mkdtemp(join(tmpdir(), 'okit-collector-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const statusFile = (root) => join(root, 'quota', STATUSLINE_FILE);
const manualFile = (root) => join(root, 'quota', 'claude-code.json');
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
  const stored = JSON.parse(await readFile(statusFile(root)));
  assert.deepEqual(stored.input, JSON.parse(input.toString()), 'the client JSON is stored as it came');
});

// A previous command that leaves a descendant behind must not keep the client
// waiting: the collector ends at its deadline and takes the group with it.
test('the collector ends at its deadline and leaves no descendant of the previous command alive',
  { skip: process.platform === 'win32' }, async (t) => {
    const root = await rootFor(t);
    const pidFile = join(root, 'descendant.pid');
    // The `sleep` in the background inherits the output of the shell: it keeps
    // the pipe open long after the shell itself is gone.
    const previous = ['sh', '-c', `sleep 5 & echo $! > ${pidFile}; echo bar; sleep 5`];
    await writeFile(join(root, 'config.json'), JSON.stringify({ statuslineCollector: { previous, timeoutMs: 300 } }));
    await writeFile(join(root, 'input'), input);
    const stdin = await open(join(root, 'input'), 'r');
    const stdout = await open(join(root, 'output'), 'w');
    t.after(async () => { await stdin.close(); await stdout.close(); });
    const started = performance.now();
    const child = spawn(process.execPath, ['src/cli.js', 'statusline-collector'], {
      env: { ...process.env, HOME: '', USERPROFILE: '', OKWORK_HOME: root }, stdio: [stdin.fd, stdout.fd, 'pipe'],
    });
    const errors = [];
    child.stderr.on('data', (bytes) => errors.push(bytes));
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
    });
    const elapsed = performance.now() - started;
    assert.equal(code, 0, Buffer.concat(errors).toString());
    assert.ok(elapsed < 2000, `the collector exited in ${Math.round(elapsed)} ms`);
    // The descendant of the previous command is dead with it: the group died.
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    let alive = true;
    for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
      try { process.kill(pid, 0); } catch { alive = false; }
      if (alive) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(alive, false, 'the descendant of the previous command is dead');
  });

// A descendant that left the group of the previous command (its own session)
// cannot be killed with it, but it must not keep the collector waiting either:
// the pipes of the collector are closed when the deadline passes.
test('a descendant that left the group does not keep the collector waiting',
  { skip: !HAS_SETSID }, async (t) => {
    const root = await rootFor(t);
    const pidFile = join(root, 'descendant.pid');
    // The descendant of the previous command opens a session of its own and
    // holds the output open; only the pipes of the collector can free it.
    const previous = ['sh', '-c', `setsid sh -c 'echo $$ > ${pidFile}; sleep 30' & sleep 30`];
    await writeFile(join(root, 'config.json'), JSON.stringify({ statuslineCollector: { previous, timeoutMs: 300 } }));
    await writeFile(join(root, 'input'), input);
    const stdin = await open(join(root, 'input'), 'r');
    const stdout = await open(join(root, 'output'), 'w');
    t.after(async () => { await stdin.close(); await stdout.close(); });
    const started = performance.now();
    const child = spawn(process.execPath, ['src/cli.js', 'statusline-collector'], {
      env: { ...process.env, HOME: '', USERPROFILE: '', OKWORK_HOME: root }, stdio: [stdin.fd, stdout.fd, 'pipe'],
    });
    const errors = [];
    child.stderr.on('data', (bytes) => errors.push(bytes));
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
    });
    const elapsed = performance.now() - started;
    assert.equal(code, 0, Buffer.concat(errors).toString());
    assert.ok(elapsed < 2000, `the collector exited in ${Math.round(elapsed)} ms`);
    // The descendant left the group, so it is still there; the collector is not.
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* it is already gone */ } });
    assert.doesNotThrow(() => process.kill(pid, 0));
  });

test('the previous command: the output limit, the deadline and the exact bytes', async () => {
  // More than the limit is no answer at all, and the answer comes at once.
  const loud = await runPrevious({ command: process.execPath,
    args: ['-e', 'process.stdout.write("x".repeat(1000))'], input: Buffer.alloc(0),
    timeoutMs: 5000, maxOutputBytes: 10 });
  assert.equal(loud, undefined);
  // A command that ignores the signal and sleeps answers empty at the deadline.
  const started = performance.now();
  const stubborn = await runPrevious({ command: process.execPath,
    args: ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], input: Buffer.alloc(0),
    timeoutMs: 300, maxOutputBytes: 1024 });
  assert.deepEqual(stubborn, Buffer.alloc(0));
  assert.ok(performance.now() - started < 2000, 'the deadline is the answer');
  // A command that ends well answers with its exact bytes.
  const exact = await runPrevious({ command: process.execPath,
    args: ['-e', 'process.stdout.write(Buffer.from([0,255,13,10]))'], input: Buffer.alloc(0),
    timeoutMs: 5000, maxOutputBytes: 1024 });
  assert.deepEqual(exact, Buffer.from([0, 255, 13, 10]));
});

// A command that did not finish before the deadline has not answered in time:
// the bytes it printed on the way are not an answer, even when its parent
// exited well and a descendant of it holds the pipe open.
test('the deadline answers empty when the command did not finish',
  { skip: process.platform === 'win32' }, async () => {
    const started = performance.now();
    const answer = await runPrevious({ command: 'sh', args: ['-c', 'sleep 5 & echo bar'],
      input: Buffer.alloc(0), timeoutMs: 300, maxOutputBytes: 1024 });
    assert.equal(answer.length, 0, 'the deadline answers an empty buffer');
    assert.notEqual(answer.toString(), 'bar\n');
    assert.ok(performance.now() - started < 2000, 'the deadline is the answer');
  });

// The kill of the tree reaches the whole tree of the command: on Windows the
// tree is killed by name and the child itself dies with it.
test('the kill of the tree on Windows kills the tree of the command and the child', async () => {
  const calls = [];
  const spawnFn = (command, args, options) => {
    const killer = { handlers: {}, on: (event, handler) => { killer.handlers[event] = handler; return killer; },
      unref: () => { killer.unrefed = true; } };
    calls.push({ command, args, options, killer });
    return killer;
  };
  const killed = [];
  const child = { pid: 4242, kill: (signal) => killed.push(signal) };
  killTree(child, { platform: 'win32', spawnFn });
  assert.equal(calls.length, 1, 'taskkill runs once');
  assert.equal(calls[0].command, 'taskkill');
  assert.deepEqual(calls[0].args, ['/pid', '4242', '/T', '/F']);
  assert.deepEqual(calls[0].options, { stdio: 'ignore', windowsHide: true });
  assert.deepEqual(killed, ['SIGKILL'], 'the child dies with the tree');
  assert.equal(calls[0].killer.unrefed, true, 'the kill of the tree does not hold the collector');
  assert.doesNotThrow(() => calls[0].killer.handlers.error(new Error('taskkill is gone')));
  // A taskkill that cannot even start is swallowed: the child still dies.
  const other = { pid: 4343, kill: (signal) => killed.push(signal) };
  assert.doesNotThrow(() => killTree(other, { platform: 'win32',
    spawnFn: () => { throw new Error('no taskkill'); } }));
  assert.deepEqual(killed, ['SIGKILL', 'SIGKILL']);
});

// On POSIX the kill of the tree reaches the whole group of the command: the
// descendant that inherited the output dies with it.
test('the kill of the tree on POSIX reaches the whole group of the command',
  { skip: process.platform === 'win32' }, async (t) => {
    // The command leads a group of its own: the child is detached.
    const command = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    t.after(() => { try { process.kill(-command.pid, 'SIGKILL'); } catch { /* it is already gone */ } });
    const ended = new Promise((resolve) => command.once('exit', (code, signal) => resolve({ code, signal })));
    await new Promise((resolve) => setTimeout(resolve, 150));
    killTree(command);
    const result = await ended;
    assert.equal(result.signal, 'SIGKILL', 'the command dies with the kill of the tree');
    // The group of the command is gone with it: a descendant of it dies too.
    const root = await rootFor(t);
    const pidFile = join(root, 'descendant.pid');
    const leader = spawn('sh', ['-c', `sleep 30 & echo $! > ${pidFile}; wait`],
      { detached: true, stdio: 'ignore' });
    t.after(() => { try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* it is already gone */ } });
    const gone = new Promise((resolve) => leader.once('exit', resolve));
    await new Promise((resolve) => setTimeout(resolve, 150));
    killTree(leader);
    await gone;
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    let alive = true;
    for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
      try { process.kill(pid, 0); } catch { alive = false; }
      if (alive) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(alive, false, 'the descendant of the group is dead');
  });

test('the collector stores the client JSON unchanged and never reads the percentages', async (t) => {
  const root = await rootFor(t);
  await collectStatusline({ input, stateRoot: root, now });
  const stored = JSON.parse(await readFile(statusFile(root)));
  assert.deepEqual(stored.input, JSON.parse(input.toString()), 'the unknown fields of the client come along');
  assert.equal(stored.receivedAt, new Date(now()).toISOString(), 'the instant is the one of the clock');
  assert.deepEqual(Object.keys(stored).sort(), ['input', 'receivedAt']);
  // A percentage that is not one is stored all the same: the core is the one that reads them.
  const odd = Buffer.from('{"rate_limits":{"five_hour":{"used_percentage":101,"resets_at":1}}}');
  await collectStatusline({ input: odd, stateRoot: root, now });
  assert.deepEqual(JSON.parse(await readFile(statusFile(root))).input, JSON.parse(odd.toString()));
});

test('invalid or absent rate limits preserve old bytes and still chain', async (t) => {
  const root = await rootFor(t);
  await collectStatusline({ input: '{}', stateRoot: root });
  await assert.rejects(readFile(statusFile(root)), { code: 'ENOENT' });
  await collectStatusline({ input, stateRoot: root, now });
  const old = await readFile(statusFile(root));
  for (const text of ['{', '{}', '{"rate_limits":null}', '{"rate_limits":[]}']) {
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
    assert.deepEqual(await readFile(statusFile(root)), old);
  }
});

test('oversized valid input skips the sample and still chains; exact limit writes', async (t) => {
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
    if (oversized) await assert.rejects(readFile(statusFile(root)), { code: 'ENOENT' });
    else assert.deepEqual(JSON.parse(await readFile(statusFile(root))).input, JSON.parse(input.toString()));
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
      const value = JSON.parse(await readFile(statusFile(root)));
      assert.ok([23.5, 10].includes(value.input.rate_limits.five_hour.used_percentage));
      assert.ok(Number.isFinite(Date.parse(value.receivedAt)));
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
  assert.deepEqual(await readdir(join(root, 'quota')), [STATUSLINE_FILE]);
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
  await writeFile(join(root, 'config.json'), JSON.stringify(config));
  const output = await collectStatusline({ input: '{"limits":{"custom":{"used":25,"reset":1}}}',
    stateRoot: root, config, run: async ({ command }) => Buffer.from(command) });
  assert.equal(output.toString(), 'fake');
  const stored = JSON.parse(await readFile(statusFile(root)));
  assert.deepEqual(stored.input, { limits: { custom: { used: 25, reset: 1 } } });
  const reading = await readQuota({ stateRoot: root, now });
  assert.equal(reading.windowMinutes, 17, 'the core reads the sample with the settings of the root');
  assert.equal(reading.remainingPct, 75);
  for (const change of [{ timeoutMs: 0 }, { maxInputBytes: -1 }, { maxOutputBytes: 0 },
    { previous: 'shell text' }, { windows: {} }, { windows: { bad: 0 } }, { fields: { rateLimits: '' } }]) {
    assert.throws(() => configOf({ statuslineCollector: change }));
  }
});

test('the core reads the sample: every window, the tightest quota, automatic source and age', async (t) => {
  const root = await rootFor(t);
  await collectStatusline({ input, stateRoot: root, now });
  const stored = JSON.parse(await readFile(statusFile(root)));
  assert.equal(stored.receivedAt, new Date(now()).toISOString());
  const reading = await readQuota({ stateRoot: root, now: () => now() + 120000 });
  assert.equal(reading.source, 'automatic');
  assert.equal(reading.remainingPct, 58.8);
  assert.equal(reading.windowMinutes, 10080);
  assert.equal(reading.ageMinutes, 2);
  assert.deepEqual(reading.windows, [
    { windowMinutes: 300, remainingPct: 76.5, resetsAt: new Date(1793003358000).toISOString() },
    { windowMinutes: 10080, remainingPct: 58.8, resetsAt: new Date(1793513484000).toISOString() },
  ]);
  await writeFile(manualFile(root), JSON.stringify({ remainingPct: 80, recordedAt: stored.receivedAt }));
  assert.equal((await readQuota({ stateRoot: root, now })).source, 'user');
});

test('real previous command receives exact input and returns exact binary bytes', async (t) => {
  const root = await rootFor(t);
  const output = await collectStatusline({ input, stateRoot: root,
    previous: [process.execPath, '-e', echoInput + 'fs.writeSync(1,Buffer.from([0,255,13,10]));'] });
  assert.deepEqual(output, Buffer.concat([input, Buffer.from([0, 255, 13, 10])]));
});

test('a stored sample with a receivedAt that is not a date is no reading', async () => {
  const settings = configOf().statuslineCollector;
  const stored = { receivedAt: '2026-10-26T00:00:00.000Z', input: JSON.parse(input.toString()) };
  assert.equal(readingOf(stored, settings).recordedAt, stored.receivedAt);
  for (const receivedAt of ['garbage', '', 7, null, undefined]) {
    assert.equal(readingOf({ ...stored, receivedAt }, settings), null, String(receivedAt));
  }
});
