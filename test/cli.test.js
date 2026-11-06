import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { COMMANDS, main } from '../src/cli.js';
import { inboxAdd } from '../src/inbox.js';
import { runSmoke } from '../src/smoke.js';
import { callTool } from './helpers/tools.js';
import { quotaEnv } from './helpers/env.js';

// The command line of D99: the five commands of the person (install, update, uninstall, setup and doctor), the
// entry points the machine starts (the two hooks, the status line collector and the daemon loop) and nothing else.
// Every other command of the plugin is a tool of the MCP server, the assistant's side of the work.

// The commands the person may run, and the groups the program answers with the usage.
const USER_COMMANDS = ['account', 'config', 'doctor', 'install', 'panel-state', 'setup', 'uninstall', 'update'];
// The groups that were commands of the program and are tools of the server now.
const REMOVED = ['status', 'env', 'actors', 'config', 'quota', 'telemetry', 'trajectory', 'inbox', 'todo', 'kit',
  'autostart', 'smoke', 'smoke-demo', 'client-smoke'];
// The entry points the machine starts: they work, but they are not in the usage.
const INTERNAL = [['hook', 'session-start'], ['hook', 'post-compact'], ['statusline-collector'], ['daemon', 'run-once']];

test('the usage text lists exactly the user commands and none of the internal ones', async (t) => {
  const root = await tempRoot(t);
  const run = await cli(['--help'], { root });
  assert.equal(run.code, 0, run.err.join('\n'));
  const text = run.out.join('\n');
  assert.deepEqual(COMMANDS.map((entry) => entry.group).sort(), USER_COMMANDS);
  for (const group of USER_COMMANDS) assert.match(text, new RegExp(`^.*okit-plugin ${group}\\b`, 'm'), group);
  for (const group of [...REMOVED.filter((name) => name !== 'config'), 'daemon', 'hook', 'statusline-collector']) {
    assert.doesNotMatch(text, new RegExp(`okit-plugin ${group}\\b`), group);
  }
  const printed = [...text.matchAll(/^(?:usage:|\s+)\s*okit-plugin ([a-z-]+)\b/gm)].map((match) => match[1]);
  assert.deepEqual([...new Set(printed)].sort(), USER_COMMANDS);
  // The table of the commands and the text that is printed are the same table.
  assert.deepEqual(COMMANDS.map((entry) => entry.group), ['install', 'update', 'uninstall', 'setup', 'doctor', 'panel-state', 'config', 'account']);
});

test('every removed command answers the usage with exit 2 and writes nothing', async (t) => {
  const root = await tempRoot(t);
  const absentRoot = join(root, 'absent-state');
  const before = (await readdir(root)).sort();
  for (const group of REMOVED) {
    for (const argv of [[group], [group, 'show'], [group, 'report']]) {
      const run = await cli(argv, { root: absentRoot });
      await assert.rejects(stat(absentRoot), { code: 'ENOENT' });
      assert.equal(run.code, 2, `${argv.join(' ')} exits 2`);
      assert.match(run.err.join('\n'), /^usage: okit-plugin install/, argv.join(' '));
      assert.deepEqual(run.out, [], `${argv.join(' ')} prints nothing`);
    }
  }
  assert.deepEqual((await readdir(root)).sort(), before, 'no command of the removed ones wrote anything');
});

test('help is available only first or after a user command', { timeout: 30000 }, async (t) => {
  const root = await tempRoot(t);
  for (const group of [...REMOVED, 'nope', 'daemon', 'hook', 'statusline-collector']) {
    for (const flag of ['--help', '-h']) {
      for (const argv of [[group, flag], [group, 'show', flag]]) {
        const run = await cli(argv, { root });
        assert.equal(run.code, 2, argv.join(' '));
        assert.deepEqual(run.out, [], argv.join(' '));
        assert.match(run.err.join('\n'), /^usage: okit-plugin install/, argv.join(' '));
      }
    }
  }
  // The real internal entries must not run when a help flag rides along.
  for (const entry of [['hook', 'session-start'], ['hook', 'post-compact'], ['daemon', 'run-once'], ['daemon', 'stop']]) {
    for (const flag of ['--help', '-h']) {
      const run = await cli([...entry, flag], { root, stdin: Readable.from([]) });
      assert.equal(run.code, 2, [...entry, flag].join(' '));
      assert.deepEqual(run.out, [], [...entry, flag].join(' '));
      assert.match(run.err.join('\n'), /^usage: okit-plugin install/, [...entry, flag].join(' '));
    }
  }
  for (const group of USER_COMMANDS) {
    for (const flag of ['--help', '-h']) {
      for (const argv of [[group, flag], [group, 'show', flag]]) {
        const run = await cli(group === 'config' ? ['config', 'ui', ...argv.slice(1)] : argv, { root });
        assert.equal(run.code, 0, argv.join(' '));
        assert.deepEqual(run.err, [], argv.join(' '));
        assert.match(run.out.join('\n'), /^usage: okit-plugin install/, argv.join(' '));
      }
    }
  }
  for (const flag of ['--help', '-h']) {
    const run = await cli([flag], { root });
    assert.equal(run.code, 0);
    assert.deepEqual(run.err, []);
    assert.match(run.out.join('\n'), /^usage: okit-plugin install/);
  }
});

test('the entry points the machine starts still run', async (t) => {
  const root = await tempRoot(t);
  const stdin = JSON.stringify({ cwd: root });
  for (const argv of INTERNAL) {
    const run = await cli(argv, { root, stdin });
    assert.equal(run.code, 0, `${argv.join(' ')}: ${run.err.join(' / ')}`);
  }
});

test('an unknown command prints the usage and exits 2', async () => {
  for (const argv of [[], ['nope'], ['daemon'], ['daemon', 'frobnicate'], ['daemon', 'status'], ['daemon', 'pause']]) {
    const run = await cli(argv);
    assert.equal(run.code, 2, `${argv.join(' ')} exits 2`);
    assert.ok(run.err.join('\n').startsWith('usage: okit-plugin install'), run.err.join('\n'));
  }
});

test('the help uses the configured or the executed command', async (t) => {
  const root = await tempRoot(t);
  await writeFile(join(root, 'config.json'), JSON.stringify({ install: { command: 'custom-plugin' } }));
  for (const command of [undefined, 'executed-plugin']) {
    const output = [];
    const io = { root, command, stdout: (line) => output.push(line), stderr: (line) => output.push(line) };
    assert.equal(await main(['--help'], io), 0);
    assert.ok(output[0].includes(`${command ?? 'custom-plugin'} install`));
  }
});

test('daemon stop writes the kill switch the loop leaves on', async (t) => {
  const root = await tempRoot(t);
  const run = await cli(['daemon', 'stop'], { root });
  assert.equal(run.code, 0);
  assert.equal(run.out[0], `kill switch: ${join(root, 'daemon.stop')}`);
  const stop = JSON.parse(await readFile(join(root, 'daemon.stop'), 'utf8'));
  assert.ok(Number.isFinite(Date.parse(stop.at)));

  const after = await cli(['daemon', 'run-once'], { root, spawn: async () => ({}) });
  assert.ok(after.out.some((line) => line.startsWith('skipped daemon: kill switch')), after.out.join('|'));
});

test('daemon run-once delegates a pending demand through the injected spawner', async (t) => {
  const root = await tempRoot(t);
  await inboxAdd(root, { title: 'review the inbox', client: 'claude-code' });

  const spawned = [];
  const run = await cli(['daemon', 'run-once'], {
    root,
    spawn: async (demand, opts) => {
      spawned.push({ id: demand.id, ...opts });
      return { runId: opts.runId, mode: 'PROCESS' };
    },
  });

  assert.equal(run.code, 0);
  assert.deepEqual(run.out.slice(0, 3), ['opened: 0', 'spawned: 1', 'skipped: 0']);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].client, 'claude-code');
  assert.equal(spawned[0].profile.model, 'sonnet');
});

test('daemon start runs the loop and leaves when the signal aborts', async (t) => {
  const root = await tempRoot(t);
  const controller = new AbortController();
  let passes = 0;

  const run = await cli(['daemon', 'start'], {
    root,
    signal: controller.signal,
    sleep: async () => {
      passes += 1;
      controller.abort();
    },
    spawn: async (demand, opts) => ({ runId: opts.runId }),
  });

  assert.equal(run.code, 0);
  assert.equal(passes, 1, 'the injected sleep ends the loop');
  assert.deepEqual(run.out, ['passes: 1']);
});

/** A loop that leaves on its injected sleep, after exactly one pass. */
async function onePass(io) {
  const controller = new AbortController();
  return cli(['daemon', 'start'], {
    ...io,
    signal: controller.signal,
    sleep: async () => controller.abort(),
  });
}

test('daemon start clears a kill switch an earlier stop left behind', async (t) => {
  const root = await tempRoot(t);
  await cli(['daemon', 'stop'], { root });
  await inboxAdd(root, { title: 'review the inbox', client: 'claude-code' });

  const spawned = [];
  const run = await onePass({
    root,
    spawn: async (demand, opts) => {
      spawned.push(opts.runId);
      return { runId: opts.runId };
    },
  });

  assert.equal(run.code, 0);
  assert.deepEqual(run.out, ['cleared kill switch', 'passes: 1']);
  // The pass delegated: the loop did not stop at the switch it just cleared.
  assert.equal(spawned.length, 1);
  assert.equal(await exists(join(root, 'daemon.stop')), false);
});

test('daemon start without a stale kill switch says nothing extra', async (t) => {
  const root = await tempRoot(t);
  const run = await onePass({ root, spawn: async (demand, opts) => ({ runId: opts.runId }) });

  assert.deepEqual(run.out, ['passes: 1']);
  assert.equal(await exists(join(root, 'daemon.stop')), false);
});

test('a pause survives a start, because pausing is a decision', async (t) => {
  const root = await tempRoot(t);
  await callTool('daemon', { action: 'pause' }, { root });

  const run = await onePass({ root, spawn: async (demand, opts) => ({ runId: opts.runId }) });
  assert.deepEqual(run.out, ['passes: 1']);
  assert.equal(await exists(join(root, 'daemon.paused')), true);
  const status = await callTool('daemon', { action: 'status' }, { root });
  assert.equal(status.paused, true);
});

test('the daemon of the server reports the pause and the resume of a root', async (t) => {
  const root = await tempRoot(t);
  assert.equal((await callTool('daemon', { action: 'pause' }, { root })).paused, true);
  assert.equal((await callTool('daemon', { action: 'status' }, { root })).paused, true);
  assert.equal((await callTool('daemon', { action: 'resume' }, { root })).paused, false);
  assert.equal((await callTool('daemon', { action: 'status' }, { root })).paused, false);
});

// Must pass / must refuse (the smoke runner, internal test code and not a command of the person):
// | case                                          | must pass                        | must refuse                  |
// | `--only I1`                                   | code 0, one `pass`, scratch gone | -                            |
// | `--real --only I4` over a config root that is a file | -                          | code 1, the `fail I4` record |
// | `--only nope`                                 | -                                | code 2, the usage with it    |
// | an `OKWORK_HOME` without `--real`             | -                                | code 2, one line, no usage   |

test('the smoke runner refuses an unknown --only id and an OKWORK_HOME it was not given', async (t) => {
  const scope = await smokeScope(t);

  const unknown = await runSmoke(['--only', 'nope'], { env: childEnv(scope), tmpdir: scope.tmp });
  assert.equal(unknown.code, 2, '--only nope exits 2');
  assert.deepEqual(unknown.records, [], 'a refused run runs no check');
  await assert.rejects(access(join(scope.tmp, 'okit-smoke-')), 'a refused run builds no scratch home');

  const chosen = await runSmoke([], { env: childEnv(scope, { OKWORK_HOME: scope.state }), tmpdir: scope.tmp });
  assert.equal(chosen.code, 2, 'a state root the user chose is refused without --real');
  assert.deepEqual(chosen.records, []);
});

test('smoke --only I1 runs one check of the install group and exits 0', async (t) => {
  const scope = await smokeScope(t);
  const out = [];
  const run = await runSmoke(['--only', 'I1'], { env: childEnv(scope), tmpdir: scope.tmp, out: (line) => out.push(line) });

  assert.equal(run.code, 0, run.records.map((record) => record.error?.message).join(' / '));
  assert.equal(out[0], 'smoke');
  assert.match(out[1], /^run: \d{8}T\d{6}Z-\d+$/);
  assert.match(out[2], /^pass I1 files\.placed \d+ms$/);
  assert.equal(out[3], 'passed: 1 failed: 0 skipped: 0');
  assert.equal(out.length, 6, 'the two artifact paths close the output');
  const runId = out[1].slice('run: '.length);
  assert.ok(out[4].endsWith(join('logs', 'smoke', `smoke-${runId}.jsonl`)), out[4]);
  assert.ok(out[5].endsWith(join('logs', 'smoke', `smoke-${runId}.log`)), out[5]);
  assert.deepEqual(await readdir(scope.tmp), [], 'without --keep the scratch home is taken away');
});

test('a check that cannot pass answers 1 and the record names it', async (t) => {
  const scope = await smokeScope(t);
  // The config root of `--real` is `CLAUDE_CONFIG_DIR`, so a file where a
  // folder belongs is a failure a check cannot swallow: `I4` writes the skill
  // there, and the run has to answer 1 with the record that says why.
  const notAFolder = join(scope.home, 'claude-config-dir');
  await writeFile(notAFolder, 'not a folder\n', 'utf8');

  const out = [];
  const run = await runSmoke(['--real', '--only', 'I4'], {
    env: childEnv(scope, { OKWORK_HOME: scope.state, CLAUDE_CONFIG_DIR: notAFolder }),
    tmpdir: scope.tmp, out: (line) => out.push(line),
  });

  assert.equal(run.code, 1, 'a failed check is exit code 1');
  assert.match(out[2], /^fail I4 skills\.installed \d+ms$/);
  assert.equal(out[3], 'passed: 0 failed: 1 skipped: 0');
});

// Scratch state lives inside the repository, never in the system temp folder.
const TMP = fileURLToPath(new URL('../.delegate/tmp/', import.meta.url));

const CONFIG = {
  limits: { global: 3, clients: {} },
  profiles: {
    'claude-code': {
      simple: { model: 'haiku', effort: 'low', maxTurns: 4 },
      normal: { model: 'sonnet', effort: 'medium', maxTurns: 12 },
      hard: { model: 'opus', effort: 'high', maxTurns: 30 },
    },
  },
};

async function tempRoot(t) {
  await mkdir(TMP, { recursive: true });
  const root = await mkdtemp(join(TMP, 'cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'sessions'));
  await writeFile(join(root, 'config.json'), JSON.stringify(CONFIG), 'utf8');
  return root;
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Runs `okit` with injected IO and returns the code, the output and the runs. */
async function cli(argv, io = {}) {
  const out = [];
  const err = [];
  const ran = [];
  const wrote = [];
  const code = await main(argv, {
    ...io,
    env: quotaEnv(io.root ?? io.env?.OKWORK_HOME, io.env),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    run: io.run ?? (async (command) => {
      ran.push(command);
      return { ok: true };
    }),
    write: io.write ?? (async (path, content) => {
      wrote.push({ path, content });
      return path;
    }),
  });
  return { code, out, err, ran, wrote };
}

/**
 * A home, a temp folder and a state root of their own for a smoke run.
 * The scratch home of a run is built under the temp folder, so the whole run
 * stays inside the repository scratch `test/cli.test.js` already uses.
 */
async function smokeScope(t) {
  await mkdir(TMP, { recursive: true });
  const scope = await mkdtemp(join(TMP, 'cli-smoke-'));
  t.after(() => rm(scope, { recursive: true, force: true }));
  const folders = {
    home: join(scope, 'home'), tmp: join(scope, 'tmp'), state: join(scope, 'state'),
  };
  for (const folder of Object.values(folders)) await mkdir(folder, { recursive: true });
  return folders;
}

/** The environment of one run: its own home, its own temp, and what a case adds. */
function childEnv(scope, extra = {}) {
  return {
    HOME: scope.home,
    USERPROFILE: scope.home,
    TMPDIR: scope.tmp,
    TEMP: scope.tmp,
    TMP: scope.tmp,
    ...extra,
  };
}
