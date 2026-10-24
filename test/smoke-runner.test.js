import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { environmentOf, recordOf, runIdOf, writeArtifacts } from '../src/smoke/report.js';
import { runSmoke } from '../src/smoke.js';

// Scratch state lives inside the repository, never in the system temp folder,
// the same scratch `test/cli.test.js` uses.
const TMP = fileURLToPath(new URL('../.delegate/tmp/', import.meta.url));

const DEPS = {
  platform: 'linux',
  release: '6.8.0',
  arch: 'x64',
  nodeVersion: 'v22.20.0',
  cwd: '/w/okit-plugin',
  pluginRoot: '/w/okit-plugin',
  stateRoot: '/scratch/home/.okwork',
  configRoot: '/scratch/home/.claude',
  pid: 4242,
};

const E7 = { id: 'E7', name: 'state.locks', group: 'E', timeoutMs: 20000 };
const E9 = { id: 'E9', name: 'spawn.process', group: 'E', timeoutMs: 15000 };

async function scratchRoot(t) {
  await mkdir(TMP, { recursive: true });
  const root = await mkdtemp(join(TMP, 'smoke-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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

// The `io` of one runner call: the scratch folder its own `os.tmpdir()` builds
// the home under, the lines it printed, and the injected clock. Everything else
// is the runner's own default, so a test exercises the real spawn and run stubs.
async function ioOf(t, overrides = {}) {
  const tmpdir = await scratchRoot(t);
  const out = [];
  const err = [];
  return {
    io: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      env: {},
      tmpdir,
      pid: 4242,
      platform: 'linux',
      release: '6.8.0',
      arch: 'x64',
      nodeVersion: 'v22.20.0',
      cwd: '/w/okit-plugin',
      ...overrides,
    },
    out,
    err,
    tmpdir,
  };
}

// One check that passes, and one that throws, for the failures below.
const PASSING = { id: 'X1', name: 'passes', group: 'X', timeoutMs: 5000, run: async () => {} };
const FAILING = { id: 'X2', name: 'fails', group: 'X', timeoutMs: 5000, run: async () => { throw new Error('the check refused'); } };

// Must pass / must refuse (the runner and the CLI):
// | case                                        | must pass                       | must refuse                  |
// | every check of the tables, scratch home     | code 0, 31 records, 2 files    | -                            |
// | a body that throws                          | -                               | code 1, `fail`, its error    |
// | a body that never settles                   | -                               | code 1, `timeout`, run ends  |
// | `--only I,E7`                               | 8 records, in table order      | -                            |
// | `--only nope`                               | -                               | code 2, no record            |
// | an unknown flag                             | -                               | code 2, no record            |
// | `OKWORK_HOME` without `--real`              | -                               | code 2, no record            |
// | no `--keep`                                 | the scratch folder is gone     | -                            |
// | `--keep`                                    | the folder stays, path printed | -                            |
// | `SIGINT`                                    | code 1, both artifacts written | -                            |

// One run: two checks, one passing and one that failed with a tail, the shape
// `writeArtifacts` is given by the runner of step 3.
async function writeRun(t, { now = 1_769_000_000_000, pid = 4242 } = {}) {
  const stateRoot = await scratchRoot(t);
  const runId = runIdOf(now, pid);
  const header = { kind: 'smoke', runId, startedAt: now, environment: environmentOf(DEPS) };
  const records = [
    recordOf(E7, { status: 'pass', durationMs: 120 }, DEPS),
    recordOf(E9, {
      status: 'fail',
      durationMs: 900,
      error: new Error('spawn: ENOENT'),
      command: ['node', 'runs/x.js'],
      logTail: 'ok 1\nbroken 2',
    }, DEPS),
  ];
  const artifacts = await writeArtifacts(stateRoot, runId, header, records, DEPS);
  return {
    stateRoot,
    runId,
    artifacts,
    jsonlText: await readFile(artifacts.jsonl, 'utf8'),
    logText: await readFile(artifacts.log, 'utf8'),
  };
}

test('a record carries exactly the fields docs/SMOKE.md lists', () => {
  const record = recordOf(E7, { status: 'pass', durationMs: 120 }, DEPS);
  assert.deepEqual(Object.keys(record), [
    'id', 'name', 'group', 'status', 'durationMs', 'timeoutMs', 'error', 'command', 'environment', 'logTail',
  ]);
  assert.deepEqual(Object.keys(record.environment), [
    'os', 'node', 'cwd', 'pluginRoot', 'stateRoot', 'configRoot', 'okitHome', 'pid',
  ]);
  assert.deepEqual(Object.keys(record.environment.os), ['platform', 'release', 'arch']);
});

test('the record reads the check and what happened to it', () => {
  const error = new Error('spawn: ENOENT');
  error.stack = 'Error: spawn: ENOENT\n    at spawnIt (/w/src/x.js:3:9)\n    at deeper (/w/src/y.js:9:1)';
  const record = recordOf(E9, { status: 'fail', durationMs: 900, error, command: ['node', 'x.js'] }, DEPS);
  assert.equal(record.id, 'E9');
  assert.equal(record.name, 'spawn.process');
  assert.equal(record.group, 'E');
  assert.equal(record.status, 'fail');
  assert.equal(record.durationMs, 900);
  assert.equal(record.timeoutMs, 15000);
  assert.equal(record.error, 'spawn: ENOENT (at spawnIt (/w/src/x.js:3:9))');
  assert.deepEqual(record.command, ['node', 'x.js']);
  assert.equal(record.environment.pid, 4242);
});

test('a check that stayed in process has no command, no error and an empty tail', () => {
  const record = recordOf(E7, { status: 'skip' }, DEPS);
  assert.equal(record.command, '');
  assert.equal(record.error, '');
  assert.deepEqual(record.logTail, []);
});

test('the log tail keeps the last 20 lines and no carriage return', () => {
  const many = Array.from({ length: 30 }, (_, index) => `line ${index}`);
  const record = recordOf(E9, { status: 'fail', logTail: `${many.join('\r\n')}\r\n` }, DEPS);
  assert.equal(record.logTail.length, 20);
  assert.equal(record.logTail[0], 'line 10');
  assert.equal(record.logTail.at(-1), 'line 29');
  assert.ok(record.logTail.every((line) => !line.includes('\r')));
});

test('the artifacts land in logs/smoke and the jsonl is the header plus one line per check', async (t) => {
  const run = await writeRun(t);
  assert.equal(run.artifacts.jsonl, join(run.stateRoot, 'logs', 'smoke', `smoke-${run.runId}.jsonl`));
  assert.equal(run.artifacts.log, join(run.stateRoot, 'logs', 'smoke', `smoke-${run.runId}.log`));

  const lines = run.jsonlText.split('\n');
  assert.equal(lines.at(-1), '');
  const values = lines.slice(0, -1).map((line) => JSON.parse(line));
  assert.equal(values.length, 3);
  assert.equal(values[0].runId, run.runId);
  assert.deepEqual(values.slice(1).map((record) => record.id), ['E7', 'E9']);
  assert.deepEqual(values[1].environment.os, { platform: 'linux', release: '6.8.0', arch: 'x64' });
});

test('the environment block is at the top of the human log, before the first check', async (t) => {
  const run = await writeRun(t);
  const lines = run.logText.split('\n');
  assert.equal(lines[0], 'okit-plugin smoke');
  assert.equal(lines[1], `run: ${run.runId}`);

  const firstCheck = lines.findIndex((line) => line.startsWith('pass E7'));
  assert.ok(firstCheck > 0);
  for (const key of ['os:', 'node:', 'cwd:', 'pluginRoot:', 'stateRoot:', 'configRoot:', 'okitHome:', 'pid:']) {
    const at = lines.findIndex((line) => line.startsWith(`${key} `));
    assert.ok(at > 0 && at < firstCheck, `${key} is above the first check`);
  }
  assert.match(lines[2], /^os: linux 6\.8\.0 x64$/);
  assert.ok(lines.includes('pass E7 state.locks 120ms'));
});

test('a failing check shows its error, its command and its tail under its line', async (t) => {
  const run = await writeRun(t);
  const lines = run.logText.split('\n');
  const at = lines.indexOf('fail E9 spawn.process 900ms');
  assert.ok(at > 0);
  assert.match(lines[at + 1], /^error: spawn: ENOENT \(at writeRun /);
  assert.equal(lines[at + 2], 'command: node runs/x.js');
  assert.equal(lines[at + 3], 'logTail:');
  assert.deepEqual(lines.slice(at + 4, at + 6), ['  ok 1', '  broken 2']);
  assert.equal(lines.at(-2), 'passed: 1 failed: 1 skipped: 0');
});

test('neither artifact holds a carriage return', async (t) => {
  const run = await writeRun(t);
  assert.ok(!run.jsonlText.includes('\r'), 'jsonl is LF only');
  assert.ok(!run.logText.includes('\r'), 'log is LF only');
  assert.ok(run.logText.endsWith('\n'));
});

test('the run id is the UTC instant and the pid, and two ids order', () => {
  const at = (second) => runIdOf(Date.UTC(2026, 9, 23, 9, 15, second), 4242);
  assert.equal(at(30), '20261023T091530Z-4242');
  assert.ok(at(31) > at(30));
  // The stamp is UTC to the second, so two runs of the same second are told
  // apart by the pid and order by it.
  assert.ok(runIdOf(Date.UTC(2026, 9, 23, 9, 15, 30), 99) > runIdOf(Date.UTC(2026, 9, 23, 9, 15, 30), 4242));
  assert.ok(at(30) === runIdOf(Date.UTC(2026, 9, 23, 9, 15, 30, 1), 4242));
  assert.ok(at(30) < runIdOf(Date.UTC(2026, 9, 23, 10, 0, 0), 1));
});

test('a passing smoke on a scratch root exits 0 and writes both artifacts', async (t) => {
  const { io, out, tmpdir } = await ioOf(t);
  const run = await runSmoke(['--keep'], io);

  assert.equal(run.code, 0, `${run.records.filter((r) => r.status !== 'pass').map((r) => `${r.id} ${r.error}`).join(' / ')}`);
  assert.equal(run.records.length, 31, 'the three tables hold 31 checks');
  assert.ok(run.records.every((record) => record.status === 'pass'));
  assert.deepEqual(run.records.map((record) => record.id), [
    'I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7',
    'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9', 'E10', 'E11', 'E12', 'E13', 'E14', 'E15', 'E16', 'E17', 'E18', 'E19',
    'U1', 'U2', 'U3', 'U4', 'U5',
  ], 'the order is the table order of docs/SMOKE.md');

  // The jsonl is the header plus one line per check, under the scratch state root.
  const scratch = join(tmpdir, (await readdir(tmpdir))[0]);
  const stateRoot = join(scratch, 'home', '.okwork');
  assert.equal(run.artifacts.jsonl, join(stateRoot, 'logs', 'smoke', `smoke-${run.runId}.jsonl`));
  assert.equal(run.artifacts.log, join(stateRoot, 'logs', 'smoke', `smoke-${run.runId}.log`));
  const lines = (await readFile(run.artifacts.jsonl, 'utf8')).split('\n');
  assert.equal(lines.at(-1), '');
  assert.equal(lines.length - 1, 32, 'the header and 31 records');

  // The stdout of the run, one fact per line.
  assert.equal(out[0], 'okit-plugin smoke');
  assert.equal(out[1], `run: ${run.runId}`);
  assert.match(out[2], /^pass I1 files\.placed \d+ms$/);
  assert.match(out[32], /^pass U5 idempotence\.run \d+ms$/);
  assert.equal(out[33], 'passed: 31 failed: 0 skipped: 0');
  assert.equal(out[34], run.artifacts.jsonl);
  assert.equal(out[35], run.artifacts.log);
  assert.equal(out[36], `scratch: ${scratch}`, '--keep prints the scratch path');
});

test('an injected failing check exits 1 with its id, error, command and environment', async (t) => {
  const { io, out } = await ioOf(t);
  const run = await runSmoke(['--keep'], { ...io, checks: [PASSING, FAILING] });

  assert.equal(run.code, 1, 'a failure is exit code 1');
  assert.deepEqual(run.records.map((record) => record.status), ['pass', 'fail']);
  const failed = run.records[1];
  assert.equal(failed.id, 'X2');
  assert.equal(failed.name, 'fails');
  assert.match(failed.error, /the check refused/);
  assert.deepEqual(failed.command, '', 'the check stayed in process');
  assert.deepEqual(Object.keys(failed.environment), [
    'os', 'node', 'cwd', 'pluginRoot', 'stateRoot', 'configRoot', 'okitHome', 'pid',
  ]);
  assert.equal(failed.environment.pid, 4242);
  // The state root is the jsonl's own grand-grand parent: the artifacts land in
  // `<stateRoot>/logs/smoke/<file>`, spelled with `dirname` so the expectation
  // follows the separators of the host, `/` on Linux and macOS, `\` on Windows.
  assert.equal(failed.environment.stateRoot, dirname(dirname(dirname(run.artifacts.jsonl))));
  assert.ok(out.includes(`fail X2 fails ${failed.durationMs}ms`));
  assert.equal(out.at(-4), 'passed: 1 failed: 1 skipped: 0');

  // The human log shows the error under its line.
  const log = await readFile(run.artifacts.log, 'utf8');
  assert.ok(log.includes('fail X2 fails'));
  assert.ok(log.includes('error: the check refused'));
});

test('a check that never settles is a timeout record and the run still ends', async (t) => {
  const { io } = await ioOf(t);
  const hanging = { id: 'X3', name: 'hangs', group: 'X', timeoutMs: 40, run: () => new Promise(() => {}) };
  const startedAt = Date.now();
  const run = await runSmoke(['--keep'], { ...io, checks: [hanging, PASSING] });

  assert.equal(run.code, 1);
  assert.ok(Date.now() - startedAt < 5000, 'the run ended on the timeout, not on the body');
  assert.deepEqual(run.records.map((record) => record.status), ['timeout', 'pass']);
  assert.equal(run.records[0].timeoutMs, 40, 'the record names the timeout it ran under');
  assert.match(run.records[0].error, /timed out after 40 ms/);
  assert.ok(await exists(run.artifacts.jsonl), 'a timeout still writes the artifacts');
});

test('--only I,E7 runs the install group and E7, in table order', async (t) => {
  const { io, out } = await ioOf(t);
  const run = await runSmoke(['--only', 'I,E7', '--keep'], io);

  assert.equal(run.code, 0);
  assert.equal(run.records.length, 8);
  assert.deepEqual(run.records.map((record) => record.id), ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'E7']);
  assert.ok(run.records.every((record) => record.status === 'pass'));
  assert.equal(out.at(-4), 'passed: 8 failed: 0 skipped: 0');
});

test('a run without --keep takes the scratch home away', async (t) => {
  const { io, out, tmpdir } = await ioOf(t);
  const run = await runSmoke([], { ...io, checks: [PASSING] });

  assert.equal(run.code, 0);
  assert.ok(out.at(-1).endsWith('.log'), 'without --keep the scratch path is not printed');
  assert.deepEqual(await readdir(tmpdir), [], 'the scratch home is gone and its own files with it');
  assert.ok(run.artifacts.jsonl.startsWith(tmpdir), 'the artifacts were written under it while it lived');
});

test('an unknown --only id, an unknown flag and an OKWORK_HOME are all refused', async (t) => {
  const { io, err } = await ioOf(t);
  const cases = [
    [['--only', 'nope'], {}, /unknown check "NOPE"/],
    [['--frobnicate'], {}, /unknown flag --frobnicate/],
    [['--timeout', 'soon'], {}, /--timeout needs a positive number/],
    [[], { env: { OKWORK_HOME: '/home/user/.okwork' } }, /OKWORK_HOME is set/],
  ];

  for (const [argv, extra, said] of cases) {
    const before = err.length;
    const run = await runSmoke(argv, { ...io, checks: [PASSING], ...extra });
    assert.equal(run.code, 2, `${argv.join(' ')} exits 2`);
    assert.equal(run.usage, extra.env === undefined, `${argv.join(' ')} carries the usage flag`);
    assert.deepEqual(run.records, [], `${argv.join(' ')} runs nothing`);
    assert.equal(run.artifacts, null);
    assert.equal(err.length - before, 1, `${argv.join(' ')} says one thing`);
    assert.match(err.at(before), said);
  }
});

test('--timeout raises the ceiling of a check and never lowers one', async (t) => {
  const { io } = await ioOf(t);
  const slow = { id: 'X4', name: 'slow', group: 'X', timeoutMs: 30_000, run: async () => {} };
  const raised = await runSmoke(['--timeout', '90000', '--keep'], { ...io, checks: [PASSING, slow] });
  assert.equal(raised.code, 0);
  assert.equal(raised.records[0].timeoutMs, 90_000, 'a check under the flag runs under the flag');
  assert.equal(raised.records[1].timeoutMs, 90_000, 'the flag raises every check under it');

  const kept = await runSmoke(['--timeout', '1000', '--keep'], { ...io, checks: [PASSING, slow] });
  assert.deepEqual(kept.records.map((record) => record.timeoutMs), [5000, 30_000], 'the flag never lowers a check');

  const plain = await runSmoke(['--keep'], { ...io, checks: [PASSING, slow] });
  assert.deepEqual(plain.records.map((record) => record.timeoutMs), [5000, 30_000], 'no flag, the table decides');
});

test('SIGINT ends the run with the artifacts it has and answers 1', async (t) => {
  const { io, out } = await ioOf(t);
  const signals = new EventEmitter();
  let after = false;
  const hanging = {
    id: 'X5',
    name: 'hangs',
    group: 'X',
    timeoutMs: 30_000,
    run: async () => { signals.emit('SIGINT'); await new Promise(() => {}); },
  };
  const never = { id: 'X6', name: 'never runs', group: 'X', timeoutMs: 30_000, run: async () => { after = true; } };

  const run = await runSmoke(['--keep'], { ...io, checks: [PASSING, hanging, never], signals });
  assert.equal(run.code, 1, 'an interrupted run is exit code 1');
  assert.equal(after, false, 'no check starts after the interrupt');
  assert.deepEqual(run.records.map((record) => record.status), ['pass', 'timeout']);
  assert.match(run.records[1].error, /interrupted by SIGINT/);
  assert.ok(out.includes('interrupted: SIGINT'));
  assert.ok(await exists(run.artifacts.jsonl), 'the artifacts of an interrupted run are written');
  assert.ok(await exists(run.artifacts.log));
  assert.ok(run.artifacts.jsonl.length > 0);
  assert.equal(signals.listenerCount('SIGINT'), 0, 'the runner removes the handler it installed');
});