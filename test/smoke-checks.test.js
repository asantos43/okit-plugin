// The three check tables of `docs/maintainers/SMOKE.md`: their ids, names, groups and
// timeouts, and every check passing on a scratch home with an injected spawner,
// command runner, clock and sleep. The last test mutates one seam and proves the
// runner still reports a failure, so a table that stopped asserting anything
// cannot pass this file.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FEATURE_CHECKS } from '../src/smoke/checks-features.js';
import { INSTALL_CHECKS } from '../src/smoke/checks-install.js';
import { UNINSTALL_CHECKS } from '../src/smoke/checks-uninstall.js';

// The checkout the run is about, the one the checks read the packaged files from.
const ROOT = fileURLToPath(new URL('../', import.meta.url));

// The same instant the tables' own checks use: in the past, so a pid file this
// clock writes is never stale. Each fixture controls Date and setTimeout;
// filesystem work cannot exhaust a deadline because the host is busy.
const SLOT = Date.UTC(2026, 8, 23, 9, 15, 0);

const ALL = [...INSTALL_CHECKS, ...FEATURE_CHECKS, ...UNINSTALL_CHECKS];

// The three tables of `docs/maintainers/SMOKE.md`, transcribed: id, name, group, timeout.
const DOC = [
  ['I1', 'files.placed', 'I', 5000],
  ['I2', 'commands.registered', 'I', 15000],
  ['I3', 'mcp.registered', 'I', 15000],
  ['I4', 'skills.installed', 'I', 10000],
  ['I5', 'hooks.merged', 'I', 10000],
  ['I6', 'permissions.readable', 'I', 5000],
  ['I7', 'version.matches', 'I', 10000],
  ['E1', 'daemon.run-once', 'E', 20000],
  ['E2', 'daemon.pause', 'E', 15000],
  ['E3', 'daemon.killswitch', 'E', 15000],
  ['E4', 'daemon.lifecycle', 'E', 25000],
  ['E5', 'daemon.status', 'E', 15000],
  ['E6', 'state.atomic', 'E', 10000],
  ['E7', 'state.locks', 'E', 20000],
  ['E8', 'spawn.command', 'E', 10000],
  ['E9', 'spawn.process', 'E', 15000],
  ['E10', 'limits.slots', 'E', 15000],
  ['E11', 'autostart.plan', 'E', 10000],
  ['E12', 'autostart.apply', 'E', 15000],
  ['E13', 'skills.packaged', 'E', 10000],
  ['E14', 'mcp.tools', 'E', 30000],
  ['E15', 'inbox.flow', 'E', 15000],
  ['E16', 'orders.flow', 'E', 15000],
  ['E17', 'templates.flow', 'E', 20000],
  ['E18', 'status.table', 'E', 15000],
  ['E19', 'commands.every', 'E', 30000],
  ['E20', 'quota.below-launch-floor', 'E', 15000],
  ['U1', 'uninstall.skills', 'U', 10000],
  ['U2', 'uninstall.autostart', 'U', 15000],
  ['U3', 'uninstall.state', 'U', 15000],
  ['U4', 'idempotence.install', 'U', 30000],
  ['U5', 'idempotence.run', 'U', 30000],
];
// The child of the injected spawn: a pid, the two events `makeSpawner` listens
// for, and the `kill` a `maxMinutes` timer calls. Nothing is ever started.
function child(pid, calls, clock) {
  return {
    pid,
    kill: (signal) => { calls.push({ event: 'kill', signal }); return true; },
    // makeSpawner registers maxMinutes before unref. Advance its 60 ms
    // deadline explicitly, after registration, without waiting on the host.
    unref: () => {
      const kills = calls.filter((call) => call.event === 'kill').length;
      clock.tick(59);
      assert.equal(calls.filter((call) => call.event === 'kill').length, kills,
        'maxMinutes must not kill before its virtual deadline');
      clock.tick(1);
    },
    on: (event) => { calls.push({ event }); return this; },
  };
}

/**
 * One scratch home per check: the `home`, `stateRoot`, `configRoot`, `project`
 * and `tmp` of `docs/maintainers/SMOKE.md`, an environment that names them and an injected
 * spawn, run, clock, sleep and `runChecks`. Removed with the test that owns it.
 */
async function depsOf(t, overrides = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: SLOT });
  const base = await mkdtemp(join(tmpdir(), 'smoke-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const scope = {
    home,
    stateRoot: join(home, '.okwork'),
    configRoot: join(home, '.claude'),
    projectRoot: join(base, 'project'),
    tmp: join(base, 'tmp'),
  };
  for (const folder of Object.values(scope)) await mkdir(folder, { recursive: true });

  const calls = [];
  return {
    root: ROOT,
    ...scope,
    env: {
      HOME: home,
      USERPROFILE: home,
      OKWORK_HOME: scope.stateRoot,
      CLAUDE_CONFIG_DIR: scope.configRoot,
      XDG_CONFIG_HOME: home,
      TMPDIR: scope.tmp,
      TEMP: scope.tmp,
      TMP: scope.tmp,
    },
    now: Date.now,
    platform: 'linux',
    spawn: () => child(4242, calls, t.mock.timers),
    run: async (command) => {
      calls.push({ event: 'run', command });
      return { ...command, stdout: '', stderr: '' };
    },
    sleep: async () => {},
    runChecks: (checks, scopeOfRun) => runChecks(checks, scopeOfRun),
    calls,
    ...overrides,
  };
}

// The tiny runner of this file, and what step 3 replaces with the real one: it
// runs one body under the timeout of its check and reports what happened.
async function runOne(check, deps) {
  const startedAt = Date.now();
  let expired = false;
  let timer = null;
  const over = new Promise((_, refuse) => {
    timer = setTimeout(() => {
      expired = true;
      refuse(new Error(`timed out after ${check.timeoutMs} ms`));
    }, check.timeoutMs);
  });
  const record = (status, error) => ({
    id: check.id, name: check.name, group: check.group, status,
    timeoutMs: check.timeoutMs, durationMs: Date.now() - startedAt, error,
  });

  try {
    await Promise.race([Promise.resolve().then(() => check.run(deps)), over]);
    return record('pass', '');
  } catch (error) {
    return record(expired ? 'timeout' : 'fail', error.message);
  } finally {
    clearTimeout(timer);
  }
}

// The group runner the two idempotence checks call: in order, one at a time.
async function runChecks(checks, deps) {
  const records = [];
  for (const check of checks) records.push(await runOne(check, deps));
  return records;
}

// Must pass / must refuse (the tiny runner and the tables):
// | case                                        | must pass                       | must refuse                  |
// | a body that resolves                        | status pass, empty error        | -                            |
// | a module call that throws                   | -                               | status fail, its message      |
// | a body that never settles                   | -                               | status timeout               |
// | an id repeated in the three tables          | -                               | 32 ids, one each             |
// | a timeout that differs from the table       | -                               | refused                      |
// | a scratch home left behind after a test     | -                               | removed with the test        |

test('the three tables carry the 32 ids of docs/maintainers/SMOKE.md, once each', () => {
  assert.equal(ALL.length, 32, 'the tables hold 32 checks');
  assert.deepEqual(INSTALL_CHECKS.length, 7);
  assert.deepEqual(FEATURE_CHECKS.length, 20);
  assert.deepEqual(UNINSTALL_CHECKS.length, 5);

  const ids = ALL.map((check) => check.id);
  assert.equal(new Set(ids).size, ids.length, 'no id may repeat across the three tables');
  assert.deepEqual(ids, DOC.map(([id]) => id), 'the ids and their order are the documented ones');
});

test('every check has the documented name, group and timeout', () => {
  for (const check of ALL) {
    const documented = DOC.find(([id]) => id === check.id);
    assert.ok(documented !== undefined, `${check.id} is documented`);
    assert.equal(check.name, documented[1], `${check.id} name`);
    assert.equal(check.group, documented[2], `${check.id} group`);
    assert.equal(check.timeoutMs, documented[3], `${check.id} timeout`);
    assert.ok(Number.isInteger(check.timeoutMs) && check.timeoutMs > 0, `${check.id} needs a positive timeout`);
    assert.equal(typeof check.run, 'function', `${check.id} needs a body`);
  }
});

test('every check passes on a scratch home with the injected spawn and run', async (t) => {
  for (const check of ALL) {
    await t.test(check.id, async (inner) => {
      const record = await runOne(check, await depsOf(inner));
      assert.equal(record.status, 'pass', `${check.id} ${check.name}: ${record.error}`);
      assert.equal(record.error, '');
    });
  }
});

test('the injected spawn and command runner were called without starting a real client', async (t) => {
  const deps = await depsOf(t);
  const records = [];
  for (const check of [FEATURE_CHECKS[8], FEATURE_CHECKS[13], FEATURE_CHECKS[18]]) records.push(await runOne(check, deps));
  for (const record of records) assert.equal(record.status, 'pass', `${record.id}: ${record.error}`);
  assert.ok(deps.calls.some((call) => call.event === 'kill'), 'the injected child was the one killed');
  assert.ok(deps.calls.some((call) => call.event === 'run' && call.command.args.includes('--version')),
    'MCP environment reporting must use the injected command runner');
});

test('a check whose module call throws is reported as a failure', async (t) => {
  const check = FEATURE_CHECKS.find((entry) => entry.id === 'E12');
  const deps = await depsOf(t, {
    run: async () => { throw new Error('the command runner is broken'); },
  });

  const record = await runOne(check, deps);
  assert.equal(record.status, 'fail', 'the mutated check must fail');
  assert.equal(record.id, 'E12');
  assert.match(record.error, /the command runner is broken/);
});

test('a body that never settles is reported as a timeout', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: SLOT });
  const hanging = { id: 'X1', name: 'hangs', group: 'E', timeoutMs: 20, run: () => new Promise(() => {}) };
  const pending = runOne(hanging, {});
  t.mock.timers.tick(hanging.timeoutMs);
  const record = await pending;
  assert.equal(record.status, 'timeout');
  assert.equal(record.durationMs, 20);
  assert.match(record.error, /timed out after 20 ms/);
});
