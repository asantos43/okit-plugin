import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  daemonPause, daemonResume, daemonRun, daemonStatus, rotateLogs, tick,
} from '../src/daemon.js';
import { inboxAdd, inboxList, inboxSetStatus } from '../src/inbox.js';
import { countLive } from '../src/limits.js';
import { readJson, writeJsonAtomic } from '../src/state.js';
import { paths } from '../src/store.js';
import { templateAdd } from '../src/templates.js';

// Fixed instants: the daily slot of every case is 2030-03-05T09:00:00.000Z.
const SLOT = Date.parse('2030-03-05T09:00:00.000Z');
const DAY_MS = 86_400_000;
const DAILY = 'daily 09:00';
const DEMAND = { title: 'review the inbox', kind: 'review', accept: ['no pending demand'] };

const PROFILES = {
  simple: { model: 'haiku', effort: 'low', maxTurns: 4 },
  normal: { model: 'sonnet', effort: 'medium', maxTurns: 12 },
  hard: { model: 'opus', effort: 'high', maxTurns: 30 },
};

const CONFIG = {
  limits: { global: 4, perClient: 3 },
  // A template child carries no client, so a demand without one lands here.
  profiles: { alpha: PROFILES, beta: PROFILES, unknown: PROFILES },
};

// Every case owns its root and removes it when the test ends.
const tempRoot = async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'daemon-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

// A fake spawner: it never starts a process, it only hands a run id back and
// remembers what it was asked for.
function fakeSpawner() {
  const calls = [];
  return {
    calls,
    spawn(demand, opts) {
      const runId = `run-${calls.length + 1}`;
      calls.push({ id: demand.id, title: demand.title, ...opts });
      return { runId };
    },
  };
}

function fakeDeps(overrides = {}) {
  const spawner = fakeSpawner();
  return {
    spawner,
    deps: {
      now: () => SLOT,
      quota: () => ({ remainingPct: 80 }),
      idle: () => true,
      spawn: spawner.spawn,
      ...overrides,
    },
  };
}

// A root with the config the profile choice needs and one daily template.
async function seeded(t, overrides = {}) {
  const root = await tempRoot(t);
  await writeJsonAtomic(paths(root).config, CONFIG);
  await templateAdd(root, { name: 'sweep', schedule: DAILY, demand: DEMAND, ...overrides });
  return root;
}

// The decision log of one pass, one line per tick. A day with no pass has no
// file at all, which is what the aborted loop asserts.
async function decisions(root, at = SLOT) {
  const file = join(paths(root).logs, `${new Date(at).toISOString().slice(0, 10)}.jsonl`);
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null) return [];
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

const pendingTitles = async (root) => (await inboxList(root, { status: 'pending' })).map((i) => i.title);

// Must pass / must refuse table:
// | case                        | must pass                          | must refuse                    |
// | tick at the slot            | one child opened, spawned          | -                              |
// | tick twice in one period    | one child, one pass does nothing   | -                              |
// | cap of 1 and 2 demands      | 1 delegated, 1 pending with reason | -                            |
// | paused tick                 | record paused, no work             | -                              |
// | kill switch tick            | record stopped, no work            | -                              |
// | quota below the floor       | record stopped, no work            | -                              |
// | quota on one of two clients | -                                  | no stop, work goes on           |
// | every tick                  | one line per tick                  | -                              |
// | second daemonRun            | -                                  | Error, the lock is held         |
// | status with a dead pid      | running false                      | -                              |
// | rotateLogs keepDays 14      | -                                  | old jsonl removed, new kept     |
// | live child on the period    | waiter skipped, no slot taken    | -                              |
// | spawner throws              | demand pending, slot given back  | -                              |
// | spawner returns its own id  | slot held under the returned id  | -                              |
// | pid file 60s in the future  | running false, pid kept          | -                              |
// | pid file fresh, live pid    | running true                     | -                              |
// | abort on the 5th wait       | 5 passes, 5 log lines            | -                              |
// | signal aborted before start | -                                | 0 passes, no log line          |
// | tick over a spent retention | purged 1, row gone, purge logged | -                              |
// | tick inside the retention   | purged 0, row kept               | -                              |
// | paused or stopped tick      | -                                | no purge at all                 |

test('tick opens a due child once per period and hands it to the spawner', async (t) => {
  const root = await seeded(t);
  await writeJsonAtomic(paths(root).project, { name: 'registered' });
  const { deps, spawner } = fakeDeps();

  const record = await tick(root, deps);

  assert.equal(record.opened.length, 1);
  assert.equal(record.spawned.length, 1);
  assert.equal(spawner.calls.length, 1);
  assert.equal(spawner.calls[0].title, DEMAND.title);
  assert.equal(spawner.calls[0].client, 'unknown');
  const items = await inboxList(root);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'delegated');
  assert.equal(items[0].ext.runId, 'run-1');
  assert.equal(record.spawned[0].id, items[0].id);
  assert.equal(record.spawned[0].ref, `${items[0].id} (registered)`);
  assert.deepEqual(record.opened, [items[0].id]);
  assert.deepEqual(record.openedRefs, [`${items[0].id} (registered)`]);
  assert.deepEqual(await decisions(root), [record]);
});

test('a second tick in the same period opens nothing and spawns nothing', async (t) => {
  const root = await seeded(t);
  const { deps, spawner } = fakeDeps();

  await tick(root, deps);
  const second = await tick(root, deps);

  assert.deepEqual(second.opened, []);
  assert.deepEqual(second.spawned, []);
  assert.equal(spawner.calls.length, 1);
  assert.equal((await inboxList(root)).length, 1);
});

test('tick spawns up to the cap and leaves the rest pending with a reason', async (t) => {
  const root = await tempRoot(t);
  await writeJsonAtomic(paths(root).config, { ...CONFIG, limits: { global: 1, perClient: 3 } });
  await inboxAdd(root, { title: 'first demand', client: 'alpha' });
  await inboxAdd(root, { title: 'second demand', client: 'alpha' });
  const { deps, spawner } = fakeDeps();

  const record = await tick(root, deps);

  assert.equal(spawner.calls.length, 1);
  assert.equal(record.spawned.length, 1);
  assert.equal(record.spawned[0].id, 'I000001');
  assert.equal(record.skipped.length, 1);
  assert.equal(record.skipped[0].id, 'I000002');
  assert.equal(record.skipped[0].reason, 'global limit');
  assert.deepEqual(await pendingTitles(root), ['second demand']);
});

test('a paused tick records why and does nothing', async (t) => {
  const root = await seeded(t);
  const { deps, spawner } = fakeDeps();
  await daemonPause(root);

  const record = await tick(root, deps);

  assert.equal(record.paused, true);
  assert.equal(record.stopped, undefined);
  assert.deepEqual(record.opened, []);
  assert.deepEqual(record.spawned, []);
  assert.equal(record.skipped[0].reason, 'paused');
  assert.equal(spawner.calls.length, 0);
  assert.deepEqual(await inboxList(root), []);

  await daemonResume(root);
  const resumed = await tick(root, deps);
  assert.equal(resumed.paused, undefined);
  assert.equal(resumed.spawned.length, 1);
});

test('the kill switch stops the pass and says so', async (t) => {
  const root = await seeded(t);
  const { deps, spawner } = fakeDeps();
  await writeFile(join(root, 'daemon.stop'), '');

  const record = await tick(root, deps);

  assert.equal(record.stopped, 'kill switch');
  assert.deepEqual(record.opened, []);
  assert.equal(spawner.calls.length, 0);
  assert.match(record.skipped[0].reason, /kill switch/);
  assert.deepEqual(await inboxList(root), []);
});

test('quota below the minimum on every client skips the pass', async (t) => {
  const root = await tempRoot(t);
  await writeJsonAtomic(paths(root).config, CONFIG);
  await inboxAdd(root, { title: 'first demand', client: 'alpha' });
  await inboxAdd(root, { title: 'second demand', client: 'beta' });
  const { deps, spawner } = fakeDeps({ quota: () => ({ remainingPct: 3 }) });

  const record = await tick(root, deps);

  assert.match(record.stopped, /quota below the minimum of 10%/);
  assert.match(record.stopped, /alpha at 3%/);
  assert.match(record.stopped, /beta at 3%/);
  assert.deepEqual(record.spawned, []);
  assert.equal(spawner.calls.length, 0);
  assert.equal((await inboxList(root, { status: 'pending' })).length, 2);
});

test('quota below the minimum on one client only still runs the pass', async (t) => {
  const root = await tempRoot(t);
  await writeJsonAtomic(paths(root).config, CONFIG);
  await inboxAdd(root, { title: 'thin demand', client: 'alpha' });
  await inboxAdd(root, { title: 'full demand', client: 'beta' });
  const { deps, spawner } = fakeDeps({ quota: (client) => ({ remainingPct: client === 'alpha' ? 3 : 80 }) });

  const record = await tick(root, deps);

  assert.equal(record.stopped, undefined);
  assert.equal(record.spawned.length, 2);
  assert.equal(spawner.calls.length, 2);
});

test('every tick appends exactly one decision line', async (t) => {
  const root = await seeded(t);
  const { deps } = fakeDeps();

  await tick(root, deps);
  await tick(root, deps);
  await tick(root, deps);

  const lines = await decisions(root);
  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.equal(line.at, new Date(SLOT).toISOString());
    assert.ok(Array.isArray(line.skipped));
  }
  assert.equal(lines[0].spawned.length, 1);
  assert.equal(lines[1].spawned.length, 0);
});

// Three demands that share one period through ext, which is what a template
// child carries: two waiting on it and one already running.
const PERIOD = {
  template: 'sweep',
  period: '2030-03-05T09:00:00.000Z',
};

test('a live child holds its period and the waiters are skipped', async (t) => {
  const root = await tempRoot(t);
  await writeJsonAtomic(paths(root).config, CONFIG);
  const holder = await inboxAdd(root, { title: 'running demand', ext: PERIOD });
  const waiter = await inboxAdd(root, { title: 'waiting demand', ext: PERIOD });
  await inboxSetStatus(root, holder.id, 'delegated');
  const { deps, spawner } = fakeDeps();

  const record = await tick(root, deps);

  assert.deepEqual(record.spawned, []);
  assert.equal(record.skipped.length, 1);
  assert.equal(record.skipped[0].id, waiter.id);
  assert.equal(record.skipped[0].reason, 'a live child already holds this period');
  assert.equal(spawner.calls.length, 0);
  assert.equal(await countLive(root), 0);
  assert.deepEqual(await pendingTitles(root), ['waiting demand']);
});

test('a demand of another period or of no template still spawns', async (t) => {
  const root = await tempRoot(t);
  await writeJsonAtomic(paths(root).config, CONFIG);
  const holder = await inboxAdd(root, { title: 'running demand', ext: PERIOD });
  const other = await inboxAdd(root, { title: 'next period demand', ext: { ...PERIOD, period: '2030-03-06T09:00:00.000Z' } });
  const bare = await inboxAdd(root, { title: 'loose demand' });
  await inboxSetStatus(root, holder.id, 'delegated');
  const { deps, spawner } = fakeDeps();

  const record = await tick(root, deps);

  assert.deepEqual(record.spawned.map((entry) => entry.id), [other.id, bare.id]);
  assert.deepEqual(record.skipped, []);
  assert.equal(spawner.calls.length, 2);
});

test('a spawner that throws leaves the demand pending and gives its slot back', async (t) => {
  const root = await tempRoot(t);
  await writeJsonAtomic(paths(root).config, { ...CONFIG, limits: { global: 1, perClient: 1 } });
  await inboxAdd(root, { title: 'first demand', client: 'alpha' });
  const broken = fakeDeps({ spawn: () => {
    throw new Error('the client is gone');
  } });

  const failed = await tick(root, broken.deps);

  assert.deepEqual(failed.spawned, []);
  assert.equal(failed.skipped.length, 1);
  assert.match(failed.skipped[0].reason, /^the spawner failed: the client is gone$/);
  assert.deepEqual(await pendingTitles(root), ['first demand']);
  // The slot of the failed run is free again, so the cap is whole.
  assert.equal(await countLive(root), 0);

  const { deps, spawner } = fakeDeps();
  const recovered = await tick(root, deps);

  assert.equal(recovered.spawned.length, 1);
  assert.equal(spawner.calls.length, 1);
  assert.equal(await countLive(root), 1);
});

test('a spawner run id of its own becomes the id the slot is held under', async (t) => {
  const root = await tempRoot(t);
  await writeJsonAtomic(paths(root).config, { ...CONFIG, limits: { global: 1, perClient: 1 } });
  await inboxAdd(root, { title: 'first demand', client: 'alpha' });
  // The cap is exactly one, so a slot that is not moved fails here.
  let given = null;
  const { deps } = fakeDeps({
    spawn: (demand, opts) => {
      given = opts.runId;
      return { runId: 'client-run-7' };
    },
  });

  const record = await tick(root, deps);

  assert.deepEqual(record.skipped, []);
  assert.equal(record.spawned[0].runId, 'client-run-7');
  const [item] = await inboxList(root);
  assert.equal(item.ext.runId, 'client-run-7');
  assert.ok(given && given !== 'client-run-7', 'the spawner was given a run id of its own');
  // Exactly one slot is held, and it is the id the run actually uses: the id
  // the daemon invented was given back, which leaves a done file, not a live one.
  assert.equal(await countLive(root), 1);
  const runs = paths(root).runs;
  assert.equal((await readJson(join(runs, 'client-run-7.json'), null)).status, 'live');
  assert.equal((await readJson(join(runs, `${given}.json`), null)).status, 'done');
});

test('a spawner that keeps the given run id is the cheap path', async (t) => {
  const root = await tempRoot(t);
  await writeJsonAtomic(paths(root).config, CONFIG);
  await inboxAdd(root, { title: 'first demand', client: 'alpha' });
  const { deps } = fakeDeps({ spawn: (demand, opts) => ({ runId: opts.runId }) });

  const record = await tick(root, deps);

  assert.match(record.spawned[0].runId, /^d-[0-9a-f]{8}$/);
  assert.deepEqual((await readdir(paths(root).runs)).sort(), [`${record.spawned[0].runId}.json`]);
});

// A sleep that never waits: it moves the injected clock back a day and aborts,
// which is a wall-clock jump of the worst kind for a naive interval.
function jumpySleep(onTick) {
  return async () => {
    onTick();
  };
}

// The loop runs in the background of these tests, so a gate the test opens
// keeps it inside one pass until the case is ready to look at it.
function gate() {
  let open;
  const held = new Promise((resolve) => {
    open = resolve;
  });
  return { sleep: () => held, open };
}

// Polls `check` until it returns something truthy, so a background loop is not
// raced by a single read.
async function waitFor(check, tries = 100) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error('the daemon never reached the expected state');
}

const running = async (root) => {
  const status = await daemonStatus(root);
  return status.running ? status : false;
};

test('daemonRun writes its pid file, stops on the abort and removes the pid file', async (t) => {
  const root = await seeded(t);
  const { deps, spawner } = fakeDeps();
  const controller = new AbortController();
  const waits = [];
  const held = gate();

  const run = daemonRun(root, deps, {
    signal: controller.signal,
    sleep: async (ms) => {
      waits.push(ms);
      await held.sleep();
    },
  });
  const status = await waitFor(async () => {
    const found = await daemonStatus(root);
    return found.running ? found : false;
  });
  assert.equal(status.pid, process.pid);
  assert.ok(status.startedAt);

  // The first pass is over once the loop asks to wait, and only then is the
  // abort a test of the loop rather than of the first pass.
  await waitFor(() => waits.length === 1);
  controller.abort();
  held.open();
  const { passes } = await run;

  assert.equal(passes, 1);
  assert.equal(waits.length, 1);
  // The interval is paced on the monotonic clock, so the wait is the interval
  // minus the pass that came before it, never more.
  assert.ok(waits[0] <= 60_000, `waited ${waits[0]} ms, longer than the interval`);
  assert.ok(waits[0] > 30_000, `waited ${waits[0]} ms, far shorter than the interval`);
  assert.equal(spawner.calls.length, 1);
  const after = await daemonStatus(root, { now: SLOT });
  assert.equal(after.running, false);
  assert.equal(after.pid, null);
  assert.equal(after.lastTick.spawned.length, 1);
});

test('a second daemonRun on the same root refuses the lock at once', async (t) => {
  const root = await seeded(t);
  const { deps } = fakeDeps();
  const controller = new AbortController();
  const held = gate();
  const first = daemonRun(root, deps, { signal: controller.signal, sleep: held.sleep });

  await waitFor(async () => {
    const found = await daemonStatus(root);
    return found.running ? found : false;
  });

  const started = Date.now();
  // `after 0 ms` is the try-once contract: the loser asks once and says who holds
  // the lock. On the old 300 ms budget the refusal arrived only after a dozen
  // polls, and every poll is two filesystem calls, so a Windows disk turned a
  // 300 ms budget into the 2274 ms the Producer measured.
  await assert.rejects(daemonRun(root, deps, { sleep: async () => {} }), /is held by pid \d+ since .+ after 0 ms/);
  const waited = Date.now() - started;

  // The refusal is prompt: the loser of the lock never waits out a full interval.
  assert.ok(waited < 2000, `the second daemon waited ${waited} ms before refusing`);
  // The winner is untouched: same pid, same pid file, still in its pass.
  assert.equal((await daemonStatus(root)).pid, process.pid);

  controller.abort();
  held.open();
  await first;
  assert.equal((await daemonStatus(root)).running, false);
});

test('a backwards clock jump does not open or spawn the same period twice', async (t) => {
  const root = await seeded(t);
  const clock = { at: SLOT };
  const { deps, spawner } = fakeDeps({ now: () => clock.at });
  const controller = new AbortController();
  let sleeps = 0;

  const { passes } = await daemonRun(root, deps, {
    signal: controller.signal,
    sleep: jumpySleep(() => {
      sleeps += 1;
      clock.at = SLOT - DAY_MS;
      if (sleeps === 2) controller.abort();
    }),
  });

  assert.ok(passes >= 2);
  assert.equal(spawner.calls.length, 1);
  assert.equal((await inboxList(root)).length, 1);
  assert.equal((await inboxList(root))[0].status, 'delegated');
});

test('the loop stops on the abort signal after the pass it was given', async (t) => {
  const root = await tempRoot(t);
  await writeJsonAtomic(paths(root).config, CONFIG);
  const controller = new AbortController();
  const { deps } = fakeDeps();
  let sleeps = 0;

  // The loop asks to wait once per pass, so that is where the signal is raised.
  const { passes } = await daemonRun(root, deps, {
    signal: controller.signal,
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 5) controller.abort();
    },
  });

  // The abort on the fifth wait ends the fifth pass, and the sixth never runs.
  assert.equal(passes, 5);
  assert.equal(sleeps, 5);
  assert.deepEqual(await decisions(root).then((lines) => lines.map((line) => line.at)),
    Array.from({ length: 5 }, () => new Date(SLOT).toISOString()));
});

test('a signal already aborted runs no pass and writes no log line', async (t) => {
  const root = await seeded(t);
  const { deps, spawner } = fakeDeps();
  const controller = new AbortController();
  controller.abort();

  const { passes } = await daemonRun(root, deps, {
    signal: controller.signal,
    sleep: async () => {},
  });

  assert.equal(passes, 0);
  assert.equal(spawner.calls.length, 0);
  assert.deepEqual(await inboxList(root), []);
  assert.deepEqual(await decisions(root), []);
});

test('daemonStatus reports a stopped daemon after a crash', async (t) => {
  const root = await seeded(t);
  // Above every pid_max, so no process can answer to it.
  await writeJsonAtomic(join(root, 'daemon.pid.json'), { pid: 2_147_483_646, startedAt: Date.now() });

  const status = await daemonStatus(root);

  assert.equal(status.running, false);
  assert.equal(status.pid, 2_147_483_646);
  assert.equal(status.paused, false);
  assert.equal(status.lastTick, null);
});

test('daemonStatus reads a fresh live pid as running', async (t) => {
  const root = await seeded(t);
  await writeJsonAtomic(join(root, 'daemon.pid.json'), { pid: process.pid, startedAt: Date.now() });

  const status = await daemonStatus(root);

  assert.equal(status.running, true);
  assert.equal(status.pid, process.pid);
});

test('daemonStatus reads a pid file from the future as stale', async (t) => {
  const root = await seeded(t);
  // A live pid and a start instant no clock can vouch for: the pid file says
  // nothing about a process it claims started in the future.
  await writeJsonAtomic(join(root, 'daemon.pid.json'), { pid: process.pid, startedAt: Date.now() + 600_001 });

  const status = await daemonStatus(root);

  assert.equal(status.running, false);
  assert.equal(status.pid, process.pid);
});

test('daemonStatus reports the paused flag and the last tick', async (t) => {
  const root = await seeded(t);
  const { deps } = fakeDeps();
  await tick(root, deps);
  await daemonPause(root);

  const status = await daemonStatus(root, { now: SLOT });

  assert.equal(status.running, false);
  assert.equal(status.paused, true);
  assert.equal(status.lastTick.spawned.length, 1);
});

/** A `readQuota` that answers from a map and counts every client it was asked. */
function readerOf(readings) {
  const calls = [];
  const readQuota = async (client) => {
    calls.push(client);
    return readings[client] ?? { source: 'off' };
  };
  return { readQuota, calls };
}

// Must pass / must refuse table (options.table of `daemonStatus`):
// | case                          | must pass                          | must refuse                |
// | no `table` in the options     | the five daemon fields only        | -                          |
// | `table` with fake readings    | a `table` of markdown + capacity   | -                          |
// | two calls inside the TTL      | one reading per client             | -                          |

test('daemonStatus without options.table reads no quota and gains no table', async (t) => {
  const root = await seeded(t);
  const { readQuota, calls } = readerOf({ alpha: { source: 'api', remainingPct: 80, windowMinutes: 300 } });
  // The deps a caller hands over when it does want the table under its lines.
  const table = { clients: ['alpha'], readQuota, now: () => SLOT, cache: new Map() };

  const status = await daemonStatus(root, { now: SLOT });

  assert.equal('table' in status, false, 'the result is the one of any other day');
  assert.deepEqual(Object.keys(status), ['running', 'pid', 'startedAt', 'paused', 'lastTick']);
  assert.deepEqual(calls, [], 'a reading is taken only when a table is asked for');
  assert.ok(table, 'the same deps with options.table print the table');
});

test('daemonStatus with options.table answers the markdown and the capacity line', async (t) => {
  const root = await seeded(t);
  const { readQuota, calls } = readerOf({
    alpha: { source: 'api', windows: [{ minutes: 300, remainingPct: 72, resetsInMinutes: 30 }] },
    beta: { source: 'off' },
  });
  const table = { clients: ['alpha', 'beta'], readQuota, now: () => SLOT, cache: new Map() };

  const status = await daemonStatus(root, { now: SLOT, table });

  assert.equal(status.running, false, 'the daemon fields do not change');
  assert.equal(status.paused, false);
  assert.deepEqual(Object.keys(status.table), ['markdown', 'capacityLine']);
  const lines = status.table.markdown.split('\n');
  assert.equal(lines[0], '| Subscription | 5h remaining | Week remaining | Resets in | Status | Source (age) |');
  assert.equal(lines[2], '| alpha | 72% | - | 30m | green | api (0s) |');
  assert.equal(lines[3], '| beta | - | - | - | off | off (0s) |');
  assert.equal(status.table.capacityLine, 'executors that can launch now: 3 per client, 4 in total; quota floor 15%');
  assert.deepEqual(calls, ['alpha', 'beta']);
});

test('daemonStatus reads once per client while two tables fall inside the TTL', async (t) => {
  const root = await seeded(t);
  const { readQuota, calls } = readerOf({ alpha: { source: 'api', remainingPct: 72, windowMinutes: 300 } });
  const table = { clients: ['alpha'], readQuota, now: () => SLOT, cache: new Map() };

  const first = await daemonStatus(root, { now: SLOT, table });
  const second = await daemonStatus(root, { now: SLOT, table });

  assert.deepEqual(calls, ['alpha'], 'the second table costs no extra reading');
  assert.equal(second.table.markdown, first.table.markdown);
  assert.equal(second.table.capacityLine, first.table.capacityLine);
});

test('rotateLogs removes only the logs older than keepDays', async (t) => {
  const root = await seeded(t);
  const folder = paths(root).logs;
  await mkdir(folder, { recursive: true });
  const now = Date.parse('2026-03-05T09:00:00.000Z');
  const old = join(folder, '2026-01-01.jsonl');
  const recent = join(folder, '2026-03-04.jsonl');
  const other = join(folder, 'notes.txt');
  for (const file of [old, recent, other]) await writeFile(file, '{}\n', 'utf8');
  const aged = (ms) => new Date(now - ms);
  await utimes(old, aged(20 * DAY_MS), aged(20 * DAY_MS));
  await utimes(recent, aged(2 * DAY_MS), aged(2 * DAY_MS));
  await utimes(other, aged(20 * DAY_MS), aged(20 * DAY_MS));

  const removed = await rotateLogs(root, 14, now);

  assert.deepEqual(removed, ['2026-01-01.jsonl']);
  assert.deepEqual((await readdir(folder)).sort(), ['2026-03-04.jsonl', 'notes.txt']);
});
test('a tick purges the standing orders whose retention is over and logs it', async (t) => {
  const root = await tempRoot(t);
  await writeJsonAtomic(paths(root).config, CONFIG);
  const old = '2030-01-01T00:00:00.000Z';
  const write = () => writeJsonAtomic(paths(root).orders, {
    version: 1,
    seq: 2,
    orders: [
      { id: 'G000001', text: 'live', scope: 'all', active: true, createdAt: old },
      { id: 'G000002', text: 'gone', scope: 'all', active: false, createdAt: old, revokedAt: old, revokedReason: 'obsolete' },
    ],
  });
  // 10 day retention: on 2030-03-05 the 63 day old row is well past it.
  await writeJsonAtomic(paths(root).config, { ...CONFIG, orders: { retentionDays: 10 } });
  await write();

  const record = await tick(root, fakeDeps().deps);

  assert.equal(record.purged, 1);
  const store = JSON.parse(await readFile(paths(root).orders, 'utf8'));
  assert.deepEqual(store.orders.map((order) => order.id), ['G000001']);

  const lines = await decisions(root);
  assert.equal(lines.at(-1).purged, 1);
  const purge = lines.find((line) => Array.isArray(line.purged));
  assert.deepEqual(purge.purged, ['G000002']);
  assert.equal(purge.at, new Date(SLOT).toISOString());

  // A second pass has nothing left to purge, so it writes no purge line.
  const again = await tick(root, fakeDeps().deps);
  assert.equal(again.purged, 0);
  assert.equal((await decisions(root)).filter((line) => Array.isArray(line.purged)).length, 1);
});

test('a tick keeps an order whose retention is still running and never purges while stopped', async (t) => {
  const root = await tempRoot(t);
  await writeJsonAtomic(paths(root).config, { ...CONFIG, orders: { retentionDays: 3650 } });
  await writeJsonAtomic(paths(root).orders, {
    version: 1,
    seq: 1,
    orders: [{ id: 'G000001', text: 'gone', scope: 'all', active: false, createdAt: '2029-01-01T00:00:00.000Z', revokedAt: '2029-01-01T00:00:00.000Z', revokedReason: 'obsolete' }],
  });
  const { deps } = fakeDeps();

  const record = await tick(root, deps);
  assert.equal(record.purged, 0);
  assert.equal(JSON.parse(await readFile(paths(root).orders, 'utf8')).orders.length, 1);

  await daemonPause(root);
  const paused = await tick(root, deps);
  assert.equal(paused.purged, undefined);
  assert.equal(JSON.parse(await readFile(paths(root).orders, 'utf8')).orders.length, 1);

  await daemonResume(root);
  await writeFile(join(root, 'daemon.stop'), '', 'utf8');
  const stopped = await tick(root, deps);
  assert.equal(stopped.stopped, 'kill switch');
  assert.equal(stopped.purged, undefined);
  assert.equal(JSON.parse(await readFile(paths(root).orders, 'utf8')).orders.length, 1);
});
