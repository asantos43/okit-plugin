import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildCommand, makeSpawner } from '../src/spawn-process.js';

// Scratch state lives inside the repository, never in the system temp folder.
const TMP = fileURLToPath(new URL('../.delegate/tmp/', import.meta.url));

const tempRuns = async (t) => {
  await mkdir(TMP, { recursive: true });
  const dir = await mkdtemp(join(TMP, 'spawn-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

/** Polls until `check` returns something, so a test never sleeps for a guess. */
async function until(check, deadlineMs = 2000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > deadlineMs) throw new Error('the condition never came true');
    await sleep(5);
  }
}

/** A child that never exists: an emitter with a pid, a kill and no process. */
function fakeSpawn() {
  const calls = [];
  const children = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 4242 + children.length;
    child.signals = [];
    child.kill = (signal) => {
      child.signals.push(signal ?? 'SIGTERM');
      return true;
    };
    child.unref = () => true;
    calls.push({ command, args, options, child });
    children.push(child);
    return child;
  };
  return { spawn, calls, children };
}

/** Collects what a run writes to stderr, so a warning can be asserted. */
async function captureStderr(action) {
  const lines = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    await action();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

const PROFILE = { model: 'sonnet', effort: 'high' };

test('buildCommand returns the exact headless command of each client', () => {
  const opts = { briefing: 'review the inbox', profile: PROFILE, cwd: '/srv/app' };
  assert.deepEqual(buildCommand('claude-code', opts), {
    command: 'claude',
    args: ['-p', 'review the inbox', '--model', 'sonnet', '--effort', 'high',
      '--output-format', 'json', '--permission-mode', 'acceptEdits', '--add-dir', '/srv/app'],
    env: { OKWORK_NO_DAEMON: '1' },
  });

  assert.deepEqual(buildCommand('codex', opts), {
    command: 'codex',
    args: ['exec', '--cd', '/srv/app', '--model', 'sonnet', '--sandbox', 'workspace-write',
      '--json', '--skip-git-repo-check', '-c', 'model_reasoning_effort=high', 'review the inbox'],
    env: { OKWORK_NO_DAEMON: '1' },
  });

  assert.deepEqual(buildCommand('opencode', opts), {
    command: 'opencode',
    args: ['run', '--dir', '/srv/app', '--model', 'sonnet', '--variant', 'high',
      '--format', 'json', 'review the inbox'],
    env: { OKWORK_NO_DAEMON: '1' },
  });
});

test('the permission mode and the sandbox are options, not defaults of the client', () => {
  const opts = { briefing: 'go', profile: PROFILE, cwd: '/srv/app' };
  assert.ok(buildCommand('claude-code', { ...opts, permissionMode: 'plan' }).args.includes('plan'));
  assert.ok(buildCommand('claude-code', opts).args.includes('acceptEdits'));
  // `--dangerously-skip-permissions` exists, but it is never what we pass.
  assert.ok(!buildCommand('claude-code', opts).args.includes('--dangerously-skip-permissions'));

  const codexArgs = buildCommand('codex', { ...opts, sandbox: 'read-only' }).args;
  assert.ok(codexArgs.includes('read-only'));
  assert.ok(!codexArgs.includes('danger-full-access'));
});

test('an unknown client, an empty briefing and a bad option are refused', () => {
  const opts = { briefing: 'go', profile: PROFILE, cwd: '/srv/app' };
  assert.throws(() => buildCommand('gemini', opts), {
    name: 'TypeError',
    message: /Unknown client "gemini".*claude-code, codex, opencode/,
  });
  assert.throws(() => buildCommand('codex', { ...opts, briefing: '  ' }), { name: 'TypeError' });
  assert.throws(() => buildCommand('codex', { ...opts, profile: {} }), { name: 'TypeError' });
  assert.throws(() => buildCommand('claude-code', { ...opts, permissionMode: 'yolo' }),
    { name: 'TypeError', message: /permissionMode/ });
  assert.throws(() => buildCommand('codex', { ...opts, sandbox: 'off' }),
    { name: 'TypeError', message: /sandbox/ });
});

test('the briefing is one argument and no command is a shell string', () => {
  const briefing = 'run `rm -rf /` && echo done | tee log.txt';
  const { args } = buildCommand('codex', { briefing, profile: PROFILE, cwd: '/srv/app' });
  assert.equal(args[args.length - 1], briefing);
  assert.equal(args.filter((arg) => arg === briefing).length, 1);
  for (const arg of args) assert.equal(typeof arg, 'string');
});

const DEMAND = { id: 'd-1', title: 'review the inbox', body: 'the pending demands' };
const OPTIONS = { client: 'claude-code', profile: PROFILE, runId: 'd-1', maxMinutes: 5 };

test('the spawner starts a detached child with an argument array and no shell', async (t) => {
  const runs = await tempRuns(t);
  const fake = fakeSpawn();
  const spawner = makeSpawner({ spawn: fake.spawn, now: () => 1_000, logDir: runs, env: { HOME: '/home/u' } });

  const result = await spawner(DEMAND, OPTIONS);
  assert.deepEqual(result, { runId: 'd-1', pid: 4242, mode: 'PROCESS' });

  const [call] = fake.calls;
  assert.equal(call.command, 'claude');
  assert.equal(call.options.shell, undefined, 'no shell string anywhere');
  assert.equal(call.options.detached, true);
  assert.equal(call.options.env.OKWORK_NO_DAEMON, '1');
  assert.equal(call.options.env.HOME, '/home/u');
  assert.deepEqual(call.options.stdio.slice(0, 1), ['ignore']);
  assert.deepEqual(call.args, [
    '-p', 'review the inbox\n\nthe pending demands', '--model', 'sonnet', '--effort', 'high',
    '--output-format', 'json', '--permission-mode', 'acceptEdits', '--add-dir', process.cwd(),
  ]);
  assert.equal(call.child.unref !== undefined, true);
});

test('the run file is written on start and completed on exit', async (t) => {
  const runs = await tempRuns(t);
  const fake = fakeSpawn();
  const clock = { value: 1_000 };
  const spawner = makeSpawner({ spawn: fake.spawn, now: () => clock.value, logDir: runs });

  await spawner(DEMAND, OPTIONS);
  const file = join(runs, 'd-1.json');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    runId: 'd-1', client: 'claude-code', pid: 4242, mode: 'PROCESS', status: 'live', startedAt: 1_000,
  });
  assert.ok((await readFile(join(runs, 'd-1.out'), 'utf8')) === '');

  clock.value = 9_000;
  fake.calls[0].child.emit('exit', 0, null);
  const ended = await until(async () => {
    const run = JSON.parse(await readFile(file, 'utf8'));
    return run.endedAt === null || run.endedAt === undefined ? null : run;
  });
  assert.deepEqual(ended, {
    runId: 'd-1', client: 'claude-code', pid: 4242, mode: 'PROCESS', status: 'done',
    startedAt: 1_000, endedAt: 9_000, exitCode: 0,
  });
});

test('maxMinutes sends SIGTERM through child.kill()', async (t) => {
  const runs = await tempRuns(t);
  const fake = fakeSpawn();
  const spawner = makeSpawner({ spawn: fake.spawn, logDir: runs });

  await spawner(DEMAND, { ...OPTIONS, maxMinutes: 0.002 });
  const [call] = fake.calls;
  assert.deepEqual(call.child.signals, []);
  const signals = await until(() => (call.child.signals.length > 0 ? call.child.signals : null));
  assert.deepEqual(signals, ['SIGTERM']);
});

test('without maxMinutes nothing kills the run', async (t) => {
  const runs = await tempRuns(t);
  const fake = fakeSpawn();
  const spawner = makeSpawner({ spawn: fake.spawn, logDir: runs });

  await spawner(DEMAND, { ...OPTIONS, maxMinutes: undefined });
  await sleep(30);
  assert.deepEqual(fake.calls[0].child.signals, []);
});

test('a client that cannot be started fails the run instead of the daemon', async (t) => {
  const runs = await tempRuns(t);
  const fake = fakeSpawn();
  const spawner = makeSpawner({ spawn: fake.spawn, now: () => 2_000, logDir: runs });
  await spawner(DEMAND, { ...OPTIONS, maxMinutes: 0.002 });

  const [call] = fake.calls;
  const file = join(runs, 'd-1.json');
  // An emitter with no listener throws, so this line is the crash the daemon
  // would have died of.
  call.child.emit('error', new Error('spawn claude ENOENT'));

  const run = await until(async () => {
    const value = JSON.parse(await readFile(file, 'utf8'));
    return value.status === 'failed' ? value : null;
  });
  assert.deepEqual(run, {
    runId: 'd-1', client: 'claude-code', pid: 4242, mode: 'PROCESS', status: 'failed',
    startedAt: 2_000, endedAt: 2_000, error: 'spawn claude ENOENT', exitCode: null,
  });

  // The timer is gone with the run: nothing kills a process that never began.
  await sleep(40);
  assert.deepEqual(call.child.signals, []);
});

test('a run file that cannot be written is one line on stderr, not a throw', async (t) => {
  const runs = await tempRuns(t);
  const fake = fakeSpawn();
  const spawner = makeSpawner({ spawn: fake.spawn, logDir: runs });
  await spawner(DEMAND, OPTIONS);

  // The run file becomes a folder, so every later write of it fails.
  const file = join(runs, 'd-1.json');
  await rm(file);
  await mkdir(file);

  const lines = await captureStderr(async () => {
    fake.calls[0].child.emit('exit', 0, null);
    await sleep(30);
  });
  assert.equal(lines.length, 1, lines.join(''));
  assert.match(lines[0], /^okit: could not record run d-1: Cannot (read|write) .*d-1\.json/);
});

test('the working directory is the demand project when it is a folder', async (t) => {
  const runs = await tempRuns(t);
  const project = await tempRuns(t);
  const fake = fakeSpawn();
  const spawner = makeSpawner({ spawn: fake.spawn, logDir: runs });

  await spawner({ ...DEMAND, appliesTo: project }, OPTIONS);
  assert.equal(fake.calls[0].options.cwd, project);
  assert.deepEqual(fake.calls[0].args.slice(-2), ['--add-dir', project]);

  // A project name, several projects or a folder that is gone all keep the run
  // where the daemon itself was started.
  for (const appliesTo of ['my-project', [project, project], join(project, 'gone'), 'global']) {
    fake.calls.length = 0;
    await spawner({ ...DEMAND, appliesTo }, OPTIONS);
    assert.equal(fake.calls[0].options.cwd, process.cwd(), `cwd for ${JSON.stringify(appliesTo)}`);
  }
});

test('a run without an id is refused rather than started untracked', async (t) => {
  const runs = await tempRuns(t);
  const fake = fakeSpawn();
  const spawner = makeSpawner({ spawn: fake.spawn, logDir: runs });

  await assert.rejects(() => spawner(DEMAND, { ...OPTIONS, runId: undefined }),
    { name: 'TypeError', message: /runId/ });
  assert.equal(fake.calls.length, 0);
});