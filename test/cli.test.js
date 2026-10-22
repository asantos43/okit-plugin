import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { main } from '../src/cli.js';
import { inboxAdd } from '../src/inbox.js';

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

// Scratch state lives inside the repository, never in the system temp folder.
const TMP = fileURLToPath(new URL('../.delegate/tmp/', import.meta.url));

const T0 = 1_760_000_000_000;

const CONFIG = {
  limits: { global: 4, perClient: 3 },
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
  await writeFile(join(root, 'config.json'), JSON.stringify(CONFIG), 'utf8');
  return root;
}

/** Runs `okit` with injected IO and returns the code, the output and the runs. */
async function cli(argv, io = {}) {
  const out = [];
  const err = [];
  const ran = [];
  const wrote = [];
  const code = await main(argv, {
    ...io,
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

test('an unknown command prints the usage and exits 2', async () => {
  for (const argv of [[], ['nope'], ['daemon'], ['daemon', 'frobnicate'], ['daemon', 'status', 'extra']]) {
    const run = await cli(argv);
    assert.equal(run.code, 2, `${argv.join(' ')} exits 2`);
    assert.ok(run.err.join('\n').startsWith('usage: okit daemon start|stop|status|pause|resume|run-once'));
  }
  assert.equal((await cli(['autostart', 'show', '--kind', 'upstart'])).code, 2);
  assert.equal((await cli(['autostart', 'show', '--wat'])).code, 2);
});

test('daemon status of an idle root reports nothing running', async (t) => {
  const root = await tempRoot(t);
  const run = await cli(['daemon', 'status'], { root });
  assert.equal(run.code, 0);
  assert.deepEqual(run.out, [
    'running: false', 'pid: -', 'started: -', 'paused: false', 'last pass: -',
  ]);
});

// Must pass / must refuse table (`okit daemon status`):
// | case                    | must pass                              | must refuse                     |
// | `--table`               | the table under the daemon lines       | -                               |
// | `--table --locale pt-BR`| Portuguese words in the same table      | -                               |
// | no flag                 | the five daemon lines, unchanged       | -                               |
// | `--locale` alone        | -                                      | exit 2                          |
// | `--locale fr`           | -                                      | exit 2                          |
// | `--nope`, stray arg     | -                                      | exit 2                          |
// | `daemon pause --table`  | -                                      | exit 2                          |

test('daemon status --table prints the quota table under the daemon lines', async (t) => {
  const root = await tempRoot(t);
  const readings = { 'claude-code': { source: 'api', remainingPct: 64, windowMinutes: 300 } };
  const calls = [];
  const io = {
    root,
    now: () => T0,
    quotaCache: new Map(),
    readQuota: async (client) => {
      calls.push(client);
      return readings[client] ?? { source: 'off' };
    },
  };

  const run = await cli(['daemon', 'status', '--table'], io);
  assert.equal(run.code, 0);
  assert.deepEqual(run.out.slice(0, 5), [
    'running: false', 'pid: -', 'started: -', 'paused: false', 'last pass: -',
  ]);
  assert.equal(run.out[5], '', 'a blank line separates the two halves');
  assert.equal(run.out[6], '| Subscription | 5h remaining | Week remaining | Resets in | Status | Source (age) |');
  assert.equal(run.out[8], '| claude-code | 64% | - | - | green | api (0s) |');
  assert.equal(run.out[9], 'executors that can launch now: 3 per client, 4 in total; quota floor 15%');
  assert.equal(run.out.length, 10, 'nothing else is printed');
  assert.deepEqual(calls, ['claude-code']);

  const pt = await cli(['daemon', 'status', '--table', '--locale', 'pt-BR'], io);
  assert.equal(pt.code, 0);
  assert.equal(pt.out[6], '| Assinatura | Restante 5h | Restante semana | Reseta em | Situação | Origem (idade) |');
  assert.equal(pt.out[8], '| claude-code | 64% | - | - | verde | api (0s) |');
  assert.equal(pt.out[9], 'executores que podem iniciar agora: 3 por cliente, 4 no total; piso de cota 15%');

  // Without the flag nothing changes and no quota is read: the second table came
  // from the shared cache, since both calls fall inside the TTL.
  const plain = await cli(['daemon', 'status'], io);
  assert.deepEqual(plain.out, [
    'running: false', 'pid: -', 'started: -', 'paused: false', 'last pass: -',
  ]);
  assert.deepEqual(calls, ['claude-code'], 'two tables inside the TTL read once');
});

test('daemon status refuses a locale without the table and a flag on another action', async (t) => {
  const root = await tempRoot(t);
  const calls = [];
  const io = {
    root,
    now: () => T0,
    quotaCache: new Map(),
    readQuota: async (client) => {
      calls.push(client);
      return { source: 'off' };
    },
  };

  for (const argv of [
    ['daemon', 'status', '--locale', 'pt-BR'],
    ['daemon', 'status', '--locale=pt-BR'],
    ['daemon', 'status', '--table', '--locale', 'fr'],
    ['daemon', 'status', '--nope'],
    ['daemon', 'status', '--table=true'],
    ['daemon', 'status', '--table', 'extra'],
    ['daemon', 'pause', '--table'],
    ['daemon', 'run-once', '--table'],
  ]) {
    const run = await cli(argv, io);
    assert.equal(run.code, 2, `${argv.join(' ')} exits 2`);
    assert.deepEqual(run.out, [], `${argv.join(' ')} prints nothing`);
    assert.ok(run.err.join('\n').startsWith('usage: okit daemon start|stop|status|pause|resume|run-once'), run.err.join('\n'));
  }
  assert.deepEqual(calls, [], 'a refused command reads no quota');
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

test('daemon pause and resume are reported by the next status', async (t) => {
  const root = await tempRoot(t);
  assert.equal((await cli(['daemon', 'pause'], { root })).out[0], 'paused: true');
  assert.equal((await cli(['daemon', 'status'], { root })).out[3], 'paused: true');
  assert.equal((await cli(['daemon', 'resume'], { root })).out[0], 'paused: false');
  assert.equal((await cli(['daemon', 'status'], { root })).out[3], 'paused: false');
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

  const status = await cli(['daemon', 'status'], { root });
  assert.match(status.out[4], /last pass: .* spawned 1/);
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
  await cli(['daemon', 'pause'], { root });

  const run = await onePass({ root, spawn: async (demand, opts) => ({ runId: opts.runId }) });
  assert.deepEqual(run.out, ['passes: 1']);
  assert.equal(await exists(join(root, 'daemon.paused')), true);
  const status = await cli(['daemon', 'status'], { root });
  assert.equal(status.out[3], 'paused: true');
});

test('autostart show prints the whole plan without running anything', async (t) => {
  const root = await tempRoot(t);
  const run = await cli(['autostart', 'show', '--kind', 'cron'], { root });
  assert.equal(run.code, 0);
  assert.deepEqual(run.ran, []);
  assert.equal(run.out[0], 'kind: cron');
  assert.equal(run.out[1], `path: ${join(root, 'autostart', 'okit-daemon.cron')}`);
  assert.ok(run.out.some((line) => line.startsWith('@reboot ')));
  assert.ok(run.out.includes(`install: crontab ${join(root, 'autostart', 'okit-daemon.cron')}`));
  assert.ok(run.out.includes('uninstall: crontab -r'));
});

test('autostart show without a kind follows the platform', async (t) => {
  const root = await tempRoot(t);
  const run = await cli(['autostart', 'show'], { root, platform: 'darwin' });
  assert.equal(run.out[0], 'kind: launchd');
  assert.ok(run.out.some((line) => line.startsWith('install: launchctl load -w ')));
});

test('autostart install writes the file and runs the plan, uninstall removes it', async (t) => {
  const root = await tempRoot(t);
  const install = await cli(['autostart', 'install', '--kind=systemd'], { root });
  assert.equal(install.code, 0);
  assert.equal(install.wrote.length, 1);
  assert.ok(install.wrote[0].path.endsWith('systemd/user/okit-daemon.service'));
  assert.deepEqual(install.ran.map(({ command, args }) => [command, ...args]), [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', '--now', 'okit-daemon.service'],
  ]);

  const uninstall = await cli(['autostart', 'uninstall', '--kind', 'systemd'], { root });
  assert.equal(uninstall.wrote.length, 0);
  assert.equal(uninstall.ran[0].command, 'systemctl');
  assert.deepEqual(uninstall.ran[0].args, ['--user', 'disable', '--now', 'okit-daemon.service']);
});

test('the state root comes from OKWORK_HOME when no root is given', async (t) => {
  const root = await tempRoot(t);
  const run = await cli(['daemon', 'stop'], { env: { OKWORK_HOME: root } });
  assert.equal(run.code, 0);
  assert.equal(run.out[0], `kill switch: ${join(root, 'daemon.stop')}`);
  assert.ok(JSON.parse(await readFile(join(root, 'daemon.stop'), 'utf8')).at);
});

test('a command that fails exits 1 and says why', async (t) => {
  const root = await tempRoot(t);
  const run = await cli(['autostart', 'install', '--kind', 'launchd'], {
    root,
    run: async ({ command }) => {
      throw new Error(`${command} is not here`);
    },
  });
  assert.equal(run.code, 1);
  assert.equal(run.err[0], 'okit: launchctl is not here');
});