import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { main } from '../src/cli.js';
import { inboxAdd, inboxClaim, inboxList } from '../src/inbox.js';

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

const execFileAsync = promisify(execFile);

test('TTY approval transfers, but a concurrent holder change requires fresh inspection', async (t) => {
  const root = await tempRoot(t);
  const item = await inboxAdd(root, { title: 'confirm' });
  await inboxClaim(root, item.id, { client: 'first' });
  const args = ['inbox', 'take', item.id, '--producer-takeover'];
  const io = { root, stdin: { isTTY: true }, confirm: async () => true };
  assert.equal((await cli(args, io)).code, 0);
  const changed = await cli(args, { ...io, confirm: async () => {
    await cli([...args, '--client', 'other', '--yes'], { root });
    return true;
  } });
  assert.equal(changed.code, 1);
  assert.match(changed.err.join('\n'), /hold changed/);
  assert.equal((await inboxList(root))[0].hold.client, 'other');
});

// | case | must pass | must refuse |
// | takeover | awareness flag + yes / TTY approval | no flag / no TTY / declined |
// | situation | dirty worktree before confirmation | ownership changed during prompt |
test('inbox CLI requires awareness and confirmation, shows dirty worktree and records history', async (t) => {
  const root = await tempRoot(t);
  const item = await inboxAdd(root, { title: 'owned' });
  await inboxClaim(root, item.id, { client: 'claude-code', session: 's1', worktree: root });
  const take = ['inbox', 'take', item.id];
  assert.equal((await cli(take, { root })).code, 1);
  const run = async (command) => {
    assert.deepEqual(command.args, ['status', '--porcelain']);
    assert.equal(command.cwd, root);
    assert.equal(command.timeout, 5000);
    return { stdout: ' M dirty.js\n' };
  };
  const declined = await cli([...take, '--producer-takeover'], { root, run, stdin: { isTTY: false } });
  assert.equal(declined.code, 1);
  assert.match(declined.err.join('\n'), /TTY or --yes/);
  assert.match(declined.out.join('\n'), /claude-code.*session \/ sessão: s1/);
  assert.match(declined.out.join('\n'), /mudanças não commitadas: yes \/ sim/);
  assert.equal((await cli([...take, '--producer-takeover'], { root, run, stdin: { isTTY: true }, confirm: async () => false })).code, 1);
  assert.equal((await inboxList(root))[0].hold.client, 'claude-code');
  const yes = await cli([...take, '--producer-takeover', '--client', 'codex', '--yes'], { root, run });
  assert.equal(yes.code, 0);
  const held = (await inboxList(root))[0];
  assert.equal(held.hold.via, 'producer');
  assert.equal(held.heldBefore[0].reason, 'producer takeover');
  assert.equal(held.heldBefore[0].session, 's1');
  assert.match((await cli(['inbox', 'list'], { root })).out.join('\n'), /taken by codex/);
  assert.equal((await cli(['inbox', 'release', item.id, '--client', 'codex'], { root })).code, 0);
});

// | case | must pass | must refuse |
// | stale hold | preserve the other client's hold | take without producer takeover |
test('inbox CLI refuses a stale hold without producer takeover', async (t) => {
  const root = await tempRoot(t);
  const holdStaleMinutes = 1;
  await writeFile(join(root, 'config.json'), JSON.stringify({ ...CONFIG, inbox: { holdStaleMinutes } }));
  const item = await inboxAdd(root, { title: 'stale owned' });
  const hold = {
    client: 'claude-code', session: 'old-session', worktree: root, via: 'claim',
    takenAt: new Date(Date.now() - 2 * holdStaleMinutes * 60_000).toISOString(),
  };
  await writeFile(join(root, 'inbox.json'), JSON.stringify({ seq: 1, items: [{ ...item, hold }] }));

  const result = await cli(['inbox', 'take', item.id, '--client', 'codex'], { root });

  assert.notEqual(result.code, 0);
  assert.match(result.err.join('\n'), /held by/);
  assert.deepEqual((await inboxList(root))[0].hold, hold);
});

// The `okit` this test drives as a child, and the platform a child needs to
// start at all: nothing that names the state of the machine running the suite.
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const PLATFORM_ENV = Object.fromEntries(
  ['PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'LANG']
    .map((name) => [name, process.env[name]])
    .filter(([, value]) => value !== undefined),
);

/**
 * A home, a temp folder and a state root of their own for a child `okit smoke`.
 * The scratch home of a run is built under the temp folder, so the whole child
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

/** The environment of one child: its own home, its own temp, and what a case adds. */
function childEnv(scope, extra = {}) {
  return {
    ...PLATFORM_ENV,
    HOME: scope.home,
    USERPROFILE: scope.home,
    TMPDIR: scope.tmp,
    TEMP: scope.tmp,
    TMP: scope.tmp,
    ...extra,
  };
}

/**
 * One `okit` as a child process. The exit code, the stdout and the stderr come
 * back even when the code is not 0, since every code of `okit smoke` is a fact
 * under test and a refusal is a line on stderr.
 */
async function childCli(argv, env) {
  const done = await execFileAsync(process.execPath, [CLI, ...argv], { env, windowsHide: true })
    .then((answer) => ({ ...answer, code: 0 }), (error) => ({ ...error, code: error.code }));
  const lines = (text) => `${text ?? ''}`.split('\n').filter((line) => line !== '');
  return { code: done.code, out: lines(done.stdout), err: lines(done.stderr) };
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
  assert.equal(run.out[9], 'executors that can launch now: claude-code: 0/3 (default), 3 available; quota floor 15%');
  assert.equal(run.out.length, 10, 'nothing else is printed');
  assert.deepEqual(calls, ['claude-code']);

  const pt = await cli(['daemon', 'status', '--table', '--locale', 'pt-BR'], io);
  assert.equal(pt.code, 0);
  assert.equal(pt.out[6], '| Assinatura | Restante 5h | Restante semana | Reseta em | Situação | Origem (idade) |');
  assert.equal(pt.out[8], '| claude-code | 64% | - | - | verde | api (0s) |');
  assert.equal(pt.out[9], 'executores que podem iniciar agora: claude-code: 0/3 (padrão), 3 disponíveis; piso de cota 15%');

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
  // The written path is joined with the separators of the host, so the
  // expectation is spelled the same way: `/` on Linux and macOS, `\` on Windows.
  assert.ok(install.wrote[0].path.endsWith(join('systemd', 'user', 'okit-daemon.service')));
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

// Must pass / must refuse (`okit smoke`, as a child process):
// | case                                          | must pass                        | must refuse                  |
// | `--only I1`                                   | code 0, one `pass`, scratch gone | -                            |
// | `--real --only I4` over a config root that is a file | -                          | code 1, the `fail I4` record |
// | `--only nope`                                 | -                                | code 2, the usage with it    |
// | an `OKWORK_HOME` without `--real`             | -                                | code 2, one line, no usage   |

test('the smoke group refuses an unknown --only id and an OKWORK_HOME it was not given', async (t) => {
  const scope = await smokeScope(t);

  const unknown = await childCli(['smoke', '--only', 'nope'], childEnv(scope));
  assert.equal(unknown.code, 2, '--only nope exits 2');
  assert.deepEqual(unknown.out, [], 'a refused run runs no check');
  assert.match(unknown.err[0], /okit smoke: unknown check "NOPE"/);
  // The refusal is a usage error, so the usage goes with it exactly as it goes
  // with an unknown group: this line is what a `smoke.code` mapping would lose.
  assert.ok(unknown.err[1]?.startsWith('usage: okit daemon start|stop|status|pause|resume|run-once'),
    `the usage follows the refusal, got ${unknown.err.slice(1).join(' / ') || 'nothing'}`);

  const chosen = await childCli(['smoke'], childEnv(scope, { OKWORK_HOME: scope.state }));
  assert.equal(chosen.code, 2, 'a state root the user chose is refused without --real');
  assert.deepEqual(chosen.out, []);
  assert.equal(chosen.err.length, 1, 'this refusal says why and nothing else');
  assert.match(chosen.err[0], /OKWORK_HOME is set; okit smoke uses a scratch home unless --real is given/);
  assert.deepEqual(await readdir(scope.tmp), [], 'a refused run builds no scratch home');
});

test('smoke --only I1 runs one check of the install group and exits 0', async (t) => {
  const scope = await smokeScope(t);
  const run = await childCli(['smoke', '--only', 'I1'], childEnv(scope));

  assert.equal(run.code, 0, run.err.join(' / '));
  assert.equal(run.out[0], 'okit smoke');
  assert.match(run.out[1], /^run: \d{8}T\d{6}Z-\d+$/);
  assert.match(run.out[2], /^pass I1 files\.placed \d+ms$/);
  assert.equal(run.out[3], 'passed: 1 failed: 0 skipped: 0');
  assert.equal(run.out.length, 6, 'the two artifact paths close the output');
  const runId = run.out[1].slice('run: '.length);
  assert.ok(run.out[4].endsWith(join('logs', 'smoke', `smoke-${runId}.jsonl`)), run.out[4]);
  assert.ok(run.out[5].endsWith(join('logs', 'smoke', `smoke-${runId}.log`)), run.out[5]);
  assert.deepEqual(run.err, [], 'a passing run says nothing on stderr');
  assert.deepEqual(await readdir(scope.tmp), [], 'without --keep the scratch home is taken away');
});

test('a check that cannot pass answers 1 and the record names it', async (t) => {
  const scope = await smokeScope(t);
  // The config root of `--real` is `CLAUDE_CONFIG_DIR`, so a file where a
  // folder belongs is a failure a check cannot swallow: `I4` writes the skill
  // there, and the run has to answer 1 with the record that says why.
  const notAFolder = join(scope.home, 'claude-config-dir');
  await writeFile(notAFolder, 'not a folder\n', 'utf8');

  const run = await childCli(['smoke', '--real', '--only', 'I4'], childEnv(scope, {
    OKWORK_HOME: scope.state,
    CLAUDE_CONFIG_DIR: notAFolder,
  }));

  assert.equal(run.code, 1, 'a failed check is exit code 1');
  assert.match(run.out[2], /^fail I4 skills\.installed \d+ms$/);
  assert.equal(run.out[3], 'passed: 0 failed: 1 skipped: 0');
  assert.deepEqual(run.err, [], 'a failed check is not an error of the CLI');

  const log = await readFile(run.out.at(-1), 'utf8');
  assert.match(log, /^fail I4 skills\.installed \d+ms$/m);
  assert.match(log, /^error: \S.*$/m, 'the artifact carries the message of the failure');
});
