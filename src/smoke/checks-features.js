// Group B of `docs/maintainers/SMOKE.md`: every feature, end to end. Each check drives the
// real module of `src/` with the roots of the scratch home, so a pass here is a
// fact about this checkout and not about the machine it ran on. Nothing is
// started: the spawner, the command runner, the clock and the sleep all come in
// through `deps`.

import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';

import { AUTOSTART_KINDS, applyAutostart, autostartPlan, detectAutostart } from '../autostart.js';
import { main } from '../cli.js';
import { daemonPause, daemonResume, daemonRun, daemonStatus, tick } from '../daemon.js';
import { inboxAdd, inboxList, inboxSetStatus } from '../inbox.js';
import { acquireSlot, releaseSlot } from '../limits.js';
import { createServer, serverVersion } from '../mcp/server.js';
import { TOOLS, TOOL_NAMES } from '../mcp/tools.js';
import { orderAdd, orderList, orderRemove } from '../orders.js';
import { DEFAULT_CONFIG } from '../profiles.js';
import { installSkillFiles } from '../skills.js';
import { buildCommand, makeSpawner } from '../spawn-process.js';
import { withLock, writeJsonAtomic } from '../state.js';
import { statusTable } from '../status.js';
import { paths } from '../store.js';
import { listActors } from '../actors.js';
import { capture } from '../trajectory/capture.js';
import { openDue, templateAdd, templateList, templateRemove, templateSet } from '../templates.js';

// The profiles the daemon and the `profile_pick` tool need; without them a
// demand is skipped with "No profile for client" and a check would prove less
// than the table asks.
const PROFILES = {
  'claude-code': {
    simple: { model: 'haiku', effort: 'low', maxTurns: 4 },
    normal: { model: 'sonnet', effort: 'medium', maxTurns: 12 },
    hard: { model: 'opus', effort: 'high', maxTurns: 30 },
  },
};

// A cron slot at 09:15:00 UTC, the instant the template checks of this group use.
const SLOT = Date.UTC(2026, 8, 23, 9, 15, 0);

// The one byte a table must never hold: a colour code would survive the paste
// into an issue and hide the words it sits between.
const ESC = '\u001b';

function need(ok, message) {
  if (!ok) throw new Error(message);
}

// One JSON-RPC line, so a check reads as the message it sent.
const frame = (id, method, params = undefined) => JSON.stringify(
  params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params },
);

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

// The pid of a process nobody is running: what a lock owner and a pid file left
// behind look like after a crash, and what `isProcessAlive` answers ESRCH for.
async function deadPid() {
  for (const pid of [2147483646, 4194303, 999_999, process.pid + 1_000_000]) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return pid;
    }
  }
  throw new Error('no dead pid to write a stale lock with');
}

// Polls a condition of the disk or of a running loop, so a check waits for what
// it needs instead of guessing a pause.
const POLL_MS = 2;
const POLL_ATTEMPTS = 400;

async function waitFor(cond, attempts = POLL_ATTEMPTS) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await cond()) return true;
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
  }
  return false;
}

// `daemon start` loops until it is stopped, so a check hands it a sleep that
// aborts the loop it was given: one pass happens, then the loop leaves.
function onePass() {
  const controller = new AbortController();
  return { signal: controller.signal, sleep: async () => { controller.abort(); } };
}

/**
 * One `okit` invocation with every side effect injected. `write` only records,
 * so an `autostart install` that plans a path outside the scratch home still
 * proves the exit code without touching the machine.
 */
async function cli(deps, argv, options = {}) {
  const out = [];
  const err = [];
  const wrote = [];
  const code = await main(argv, {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    root: deps.stateRoot,
    env: deps.env,
    now: deps.now,
    platform: deps.platform,
    run: deps.run,
    write: async (path, content) => {
      wrote.push({ path, content });
      return path;
    },
    readQuota: async () => ({ source: 'off' }),
    quotaCache: new Map(),
    ...options,
  });
  return { code, out, err, wrote };
}

const writeConfig = async (deps, extra = {}) => writeJsonAtomic(
  paths(deps.stateRoot).config, { profiles: PROFILES, ...extra },
);

// The `runs/` folder of one spawner built over the injected spawn of the run.
function spawnerOf(deps, spawn) {
  return makeSpawner({ spawn, now: deps.now, logDir: paths(deps.stateRoot).runs, env: deps.env, cwd: deps.projectRoot });
}

// E1: one pass opens the due child, hands it to the injected spawner and appends
// one decision line with the three lists the daemon reports.
async function daemonRunOnce(deps) {
  await writeConfig(deps);
  await templateAdd(deps.stateRoot, {
    name: 'smoke-e1',
    schedule: '*/5 * * * *',
    demand: { title: 'the smoke child' },
  }, { now: SLOT });
  // A demand of its own, because a template child carries no client: the pass
  // can only spawn one it knows the profile of.
  await inboxAdd(deps.stateRoot, { title: 'the smoke demand', client: 'claude-code' });

  const record = await tick(deps.stateRoot, { now: () => SLOT, spawn: deps.spawn });
  need(record.opened.length === 1, `one pass must open the due child, opened ${record.opened.length}`);
  need(record.spawned.length === 1, `the pending demand must reach the spawner, spawned ${record.spawned.length}`);
  need(record.spawned[0].client === 'claude-code', 'the pass must name the client it spawned for');

  const file = join(paths(deps.stateRoot).logs, `${new Date(SLOT).toISOString().slice(0, 10)}.jsonl`);
  const lines = (await readFile(file, 'utf8')).split('\n').filter((line) => line.trim() !== '');
  need(lines.length === 1, `one pass must append one decision line, the file holds ${lines.length}`);
  const decision = JSON.parse(lines[0]);
  for (const field of ['opened', 'spawned', 'skipped']) {
    need(Array.isArray(decision[field]), `the decision line must carry ${field}`);
  }
}

// E2: a paused pass records `paused` and opens nothing, and resuming clears it.
async function daemonPauseCheck(deps) {
  const paused = await daemonPause(deps.stateRoot);
  need(paused.paused === true, 'daemonPause must report paused');

  const record = await tick(deps.stateRoot, { now: () => SLOT, spawn: deps.spawn });
  need(record.paused === true, 'the decision line must record the pause');
  need(record.opened.length === 0 && record.spawned.length === 0, 'a paused pass must open nothing');
  need(record.skipped.some((skip) => skip.reason === 'paused'), 'the pass must say why it skipped');

  const resumed = await daemonResume(deps.stateRoot);
  need(resumed.paused === false, 'daemonResume must report not paused');
  const status = await daemonStatus(deps.stateRoot, { now: SLOT });
  need(status.paused === false, 'the status must no longer report paused');
}

// E3: `daemon stop` writes the kill switch and the pass stops on it; `daemon
// start` clears it before the loop.
async function daemonKillswitch(deps) {
  const stop = await cli(deps, ['daemon', 'stop']);
  need(stop.code === 0 && stop.out[0]?.startsWith('kill switch:'), `daemon stop must write the file, got ${stop.out.join(' / ')}`);

  const stopped = await tick(deps.stateRoot, { now: () => SLOT, spawn: deps.spawn });
  need(stopped.stopped === 'kill switch', `the pass must stop on the kill switch, got ${stopped.stopped}`);
  need(stopped.opened.length === 0 && stopped.spawned.length === 0, 'a stopped pass must open nothing');

  const started = await cli(deps, ['daemon', 'start'], onePass());
  need(started.code === 0 && started.out.includes('cleared kill switch'), 'daemon start must clear the kill switch');
  need(await exists(stop) === false, 'the kill switch must be gone after daemon start');
}

// E4: the loop writes its pid file and takes it away on exit, and a second loop
// on the same root is refused by the `daemon` lock. The kill switch this check
// writes is taken away again: a run shares one root with every other check, and
// a switch left behind would stop the loop of `E5` before it began.
async function daemonLifecycle(deps) {
  const root = deps.stateRoot;
  const pidFile = join(root, 'daemon.pid.json');
  const stopFile = join(root, 'daemon.stop');
  await writeJsonAtomic(stopFile, { at: new Date(SLOT).toISOString() });

  try {
    const { passes } = await daemonRun(root, { now: () => SLOT, spawn: deps.spawn }, onePass());
    need(passes === 1, `the kill switch must end the loop after one pass, got ${passes}`);
    need(await exists(pidFile) === false, 'the pid file must be gone on exit');

    let refused = null;
    await withLock(join(root, 'daemon'), async () => {
      refused = await daemonRun(root, { now: () => SLOT, spawn: deps.spawn }, onePass())
        .then(() => null, (error) => error);
    });
    need(refused instanceof Error && /held by pid/.test(refused.message), `a second daemon must be refused, got ${refused}`);
  } finally {
    await rm(stopFile, { force: true });
  }
}

// E5: a pid file whose pid is gone reads as not running, and the loop that is
// really in this process reads as running until it leaves.
async function daemonStatusCheck(deps) {
  const root = deps.stateRoot;
  const pidFile = join(root, 'daemon.pid.json');
  await writeJsonAtomic(pidFile, { pid: await deadPid(), startedAt: deps.now() });

  const dead = await daemonStatus(root, { now: deps.now() });
  need(dead.running === false, `a dead pid must read as not running, got ${dead.running}`);

  const controller = new AbortController();
  let release = () => {};
  const held = new Promise((resolve) => { release = resolve; });
  let ready;
  const firstPass = new Promise((resolve) => { ready = resolve; });
  const loop = daemonRun(root, { now: () => SLOT, spawn: deps.spawn }, {
    signal: controller.signal,
    sleep: async () => { ready(); await held; },
  });
  try {
    // The pid is written before tick finishes. Reaching sleep acknowledges
    // both writes; reading the pid alone races the first decision record.
    await Promise.race([firstPass, loop]);
    const live = await daemonStatus(root, { now: deps.now() });
    need(live.running === true && live.pid === process.pid, `the live loop must read as running, got ${live.running}`);
    need(live.lastTick !== null, 'the live loop must have left its decision line');
  } finally {
    controller.abort();
    release();
    await loop;
  }
  need(await exists(pidFile) === false, 'the pid file must be gone when the loop leaves');
}

// E6: `inboxAdd` writes through the atomic helper, leaves no sibling `.tmp` and
// reads back whole.
async function stateAtomic(deps) {
  const file = paths(deps.stateRoot).inbox;
  const added = await inboxAdd(deps.stateRoot, { title: 'the smoke demand' });
  const stored = JSON.parse(await readFile(file, 'utf8'));
  const found = stored.items.find((item) => item.id === added.id);
  need(found !== undefined, 'inbox.json must read back what was added');
  need(typeof found.createdAt === 'string' && !found.createdAt.includes('.tmp'), 'the stored item must be whole');

  const litter = (await readdir(deps.stateRoot)).filter((name) => name.endsWith('.tmp'));
  need(litter.length === 0, `an atomic write must leave no .tmp behind, found ${litter.join(',')}`);
}

// E7: a second holder is refused, the lock is released, and a lock whose owner
// pid is dead is taken over.
async function stateLocks(deps) {
  const folder = paths(deps.stateRoot).locks;
  const base = join(folder, 'demo');
  await mkdir(folder, { recursive: true });

  let inner = null;
  await withLock(base, async () => {
    inner = await withLock(base, () => 'taken', { timeoutMs: 0 }).then(() => null, (error) => error);
  });
  need(inner instanceof Error && /held by pid/.test(inner.message), `a second holder must be refused, got ${inner}`);
  need(await exists(`${base}.lock`) === false, 'the lock must be released on the way out');

  const lockDir = `${base}.lock`;
  await mkdir(lockDir, { recursive: true });
  await writeJsonAtomic(join(lockDir, 'owner.json'), { pid: await deadPid(), startedAt: deps.now() - 60_000 });
  const took = await withLock(base, () => 'taken over', { timeoutMs: 200, staleMs: 1000 });
  need(took === 'taken over', 'withLock must take over a lock whose pid is dead');
  need(await exists(lockDir) === false, 'the lock must be released again after the takeover');
}

// E8: the documented argument array of each client: the briefing is one whole
// argument, never part of a shell string, and the two clients that take it
// positionally take it last.
async function spawnCommand(deps) {
  const briefing = 'the smoke briefing';
  const wanted = {
    'claude-code': {
      command: 'claude',
      args: ['-p', briefing, '--model', 'sonnet', '--effort', 'high', '--output-format', 'json', '--permission-mode', 'acceptEdits'],
    },
    codex: {
      command: 'codex',
      args: ['exec', '--model', 'sonnet', '--sandbox', 'workspace-write', '--json', '--skip-git-repo-check', '-c', 'model_reasoning_effort=high', briefing],
    },
    opencode: {
      command: 'opencode',
      args: ['run', '--model', 'sonnet', '--variant', 'high', '--format', 'json', briefing],
    },
  };

  const positional = new Set(['codex', 'opencode']);
  for (const [client, expected] of Object.entries(wanted)) {
    const built = buildCommand(client, { briefing, profile: { model: 'sonnet', effort: 'high' } });
    need(built.command === expected.command, `${client} must run ${expected.command}, got ${built.command}`);
    need(JSON.stringify(built.args) === JSON.stringify(expected.args),
      `${client} arguments are ${built.args.join(' ')}, expected ${expected.args.join(' ')}`);
    need(built.args.filter((arg) => arg === briefing).length === 1,
      `${client} must pass the briefing once, as an argument of its own`);
    if (positional.has(client)) {
      need(built.args.at(-1) === briefing, `${client} must end with the briefing`);
    } else {
      need(built.args.at(-1) === 'acceptEdits', 'claude-code must end with its permission mode');
    }
    need(built.env.OKWORK_NO_DAEMON === '1', `${client} must not start a daemon of its own`);
  }
}

// E9: the spawner writes the run file as `live` and the output file, and
// `maxMinutes` ends the child. The spawn is the one of the run; the check only
// wraps `kill` so it can see the call.
async function spawnProcess(deps) {
  const runs = paths(deps.stateRoot).runs;
  const killed = [];
  const spawn = (command, args, options) => {
    const child = deps.spawn(command, args, options);
    const kill = child.kill.bind(child);
    child.kill = (...rest) => { killed.push(rest); return kill(...rest); };
    return child;
  };

  const outcome = await spawnerOf(deps, spawn)(
    { title: 'the smoke run' },
    { runId: 'smoke-e9', client: 'claude-code', profile: { model: 'sonnet', effort: 'low' } },
  );
  need(outcome.pid !== null && outcome.mode === 'PROCESS', `the spawner must report a process, got ${JSON.stringify(outcome)}`);
  const run = JSON.parse(await readFile(join(runs, 'smoke-e9.json'), 'utf8'));
  need(run.status === 'live' && run.client === 'claude-code', `the run file must be live, got ${run.status}`);
  need(await exists(join(runs, 'smoke-e9.out')), 'the spawner must leave the output file');

  // 0.001 minutes is 60 ms: long enough to write the run file, short enough for
  // a check to see the kill.
  await spawnerOf(deps, spawn)(
    { title: 'the bounded run' },
    { runId: 'smoke-e9-bounded', client: 'claude-code', profile: { model: 'sonnet' }, maxMinutes: 0.001 },
  );
  await waitFor(() => killed.length > 0);
  need(killed.length > 0, 'maxMinutes must kill the child');
}

// E10: the cap takes the client's configured slots, then answers `ok: false` with the
// reason, and a release frees one. The client is one no other check of this
// group spawns for, so the live runs an earlier check left cannot eat the cap
// this check is about to prove.
async function limitsSlots(deps) {
  const config = { limits: { global: 4, clients: { codex: 1 } }, staleMinutes: 30 };
  const taken = await acquireSlot(deps.stateRoot, 'smoke-e10-a', { client: 'codex', config });
  need(taken.ok === true, `the first slot must be taken, got ${JSON.stringify(taken)}`);

  const refused = await acquireSlot(deps.stateRoot, 'smoke-e10-b', { client: 'codex', config });
  need(refused.ok === false && refused.reason === 'client limit', `the cap must answer ok: false, got ${JSON.stringify(refused)}`);
  need(refused.perClient === 1, `the refusal must carry the count it hit, got ${refused.perClient}`);

  const released = await releaseSlot(deps.stateRoot, 'smoke-e10-a');
  need(released.ok === true, 'releaseSlot must free the slot');
  const again = await acquireSlot(deps.stateRoot, 'smoke-e10-b', { client: 'codex', config });
  need(again.ok === true, 'the freed slot must be usable again');
  await releaseSlot(deps.stateRoot, 'smoke-e10-b');
}

// E11: the kind each platform autostarts with, a plan for each kind, and the
// forward slashes a `win32` path is stored with.
async function autostartPlanCheck(deps) {
  const byPlatform = { linux: 'systemd', darwin: 'launchd', win32: 'schtasks', freebsd: 'cron' };
  for (const [platform, kind] of Object.entries(byPlatform)) {
    need(detectAutostart(platform) === kind, `detectAutostart(${platform}) must be ${kind}`);
  }

  const options = { root: deps.stateRoot, home: deps.home, node: 'C:\\nodejs\\node.exe', script: 'C:\\okit\\src\\cli.js' };
  for (const kind of AUTOSTART_KINDS) {
    const plan = autostartPlan(kind, options);
    need(plan.kind === kind, `the plan must be the ${kind} one`);
    need(plan.install.length > 0 && plan.uninstall.length > 0, `${kind} must have both command lists`);
    for (const step of [...plan.install, ...plan.uninstall]) {
      need(typeof step.command === 'string' && Array.isArray(step.args),
        `${kind} must pass an argument array, never a shell string`);
    }
  }

  const task = autostartPlan('schtasks', options);
  need(task.content.includes('C:/nodejs/node.exe') && !task.content.includes('\\'),
    `a win32 path must keep forward slashes, got ${task.content}`);
}

// E12: an install writes the plan's file and runs its commands, a second install
// writes the same bytes, and an uninstall writes nothing.
async function autostartApply(deps) {
  const wrote = [];
  const write = async (path, content) => {
    need(path.startsWith(deps.home), `applyAutostart wants ${path}, outside the scratch home`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
    wrote.push(path);
    return path;
  };
  const plan = autostartPlan('systemd', { root: deps.stateRoot, home: deps.home });

  const first = await applyAutostart(plan, { action: 'install', run: deps.run, write });
  need(first.wrote === plan.path && wrote.length === 1, `install must report the file it wrote, got ${first.wrote}`);
  need(first.ran.length === plan.install.length, `install must run every command, ran ${first.ran.length}`);
  const bytes = await readFile(plan.path, 'utf8');

  const second = await applyAutostart(plan, { action: 'install', run: deps.run, write });
  need(await readFile(plan.path, 'utf8') === bytes, 'a second install must leave the same bytes');

  const removed = await applyAutostart(plan, { action: 'uninstall', run: deps.run, write });
  need(removed.wrote === null, 'an uninstall must report no file');
  need(removed.ran.length === plan.uninstall.length, `an uninstall must run every command, ran ${removed.ran.length}`);
  need(wrote.length === 2, `only the two installs may write, wrote ${wrote.length} times`);
}

// E13: every packaged skill carries the frontmatter a client needs, and a file
// that differs is never overwritten.
async function skillsPackaged(deps) {
  const folder = join(deps.root, 'skills');
  const folders = (await readdir(folder, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  for (const name of ['okit-director', 'okit-executor', 'okit-critic', 'okit-smoke', 'okit-setup']) {
    need(folders.some((entry) => entry.name === name), `the package must ship ${name}`);
  }

  for (const entry of folders) {
    const text = await readFile(join(folder, entry.name, 'SKILL.md'), 'utf8');
    const front = /^---\n([\s\S]*?)\n---/.exec(text);
    need(front !== null, `skills/${entry.name}/SKILL.md has no frontmatter`);
    need(/^name: \S/m.test(front[1]), `skills/${entry.name}/SKILL.md has no name`);
    need(/^description: \S/m.test(front[1]), `skills/${entry.name}/SKILL.md has no description`);
  }

  const dest = join(deps.configRoot, 'skills', 'okit-critic');
  await installSkillFiles(join(folder, 'okit-critic'), dest);
  need(await exists(join(dest, 'SKILL.md')), 'the install must leave SKILL.md at the destination');

  // The user's own copy, and then the install that must not take it away.
  await writeFile(join(dest, 'SKILL.md'), 'the user\'s own copy\n', 'utf8');
  const second = await installSkillFiles(join(folder, 'okit-critic'), dest);
  need(second.written.length === 0, 'a second install must write nothing');
  need(second.skipped.some((file) => file.reason === 'differs'), 'the file that differs must be skipped as differs');
  need(await readFile(join(dest, 'SKILL.md'), 'utf8') === 'the user\'s own copy\n',
    "the user's file must survive the install");
}

// The arguments of each tool, in the order `TOOLS` lists them: a later one uses
// what an earlier one returned, which is what a client does.
const TOOL_ARGS = {
  telemetry_status: () => ({}),
  telemetry_export: () => ({}),
  trajectory_show: (state) => ({ run: state.trajectory }),
  todo_sync: () => ({ dryRun: true }),
  todo_status: () => ({}),
  acquire_slot: () => ({ runId: 'smoke-e14', client: 'claude-code' }),
  release_slot: () => ({ runId: 'smoke-e14' }),
  limits_status: () => ({}),
  status: () => ({}),
  quota_notice: () => ({ event: { type: 'quota.released', client: 'codex' }, locale: 'pt-BR' }),
  env_report: () => ({}),
  smoke_demo: () => ({ dryRun: true }),
  actors_list: () => ({}),
  classify: () => ({ title: 'the smoke demand' }),
  profile_pick: () => ({ client: 'claude-code', effort: 'simple' }),
  inbox_add: () => ({ title: 'the smoke demand', client: 'claude-code' }),
  inbox_list: () => ({}),
  inbox_claim: (state) => ({ id: state.demand, client: 'claude-code', session: 'smoke' }),
  inbox_release: (state) => ({ id: state.demand, client: 'claude-code', session: 'smoke' }),
  inbox_set_status: (state) => ({ id: state.demand, status: 'delegated' }),
  order_add: () => ({ text: 'the smoke order' }),
  order_list: () => ({}),
  order_remove: (state) => ({ id: state.order, reason: 'the smoke run is over' }),
};

// E14: every tool answers `tools/call`, an unknown tool and a bad line are
// protocol errors, and the loop keeps reading after both.
async function mcpTools(deps) {
  await writeConfig(deps, { trajectory: { enabled: true } });
  const state = { trajectory: 'smoke-e14-trajectory' };
  await capture(deps.stateRoot, { session_id: state.trajectory, client: 'codex', model: 'smoke-model',
    effort: 'low', role: 'executor' }, { transcript: JSON.stringify({ type: 'turn_context',
    payload: { model: 'smoke-model', effort: 'low' } }), message: 'smoke trajectory' });
  for (const name of TOOL_NAMES) need(TOOL_ARGS[name] !== undefined, `${name} has no arguments in this check`);
  const server = createServer({ tools: TOOLS, ctx: { ...deps, root: deps.stateRoot }, version: await serverVersion() });

  let asked = 0;
  for (const tool of TOOLS) {
    asked += 1;
    const line = frame(asked, 'tools/call', { name: tool.name, arguments: TOOL_ARGS[tool.name](state) });
    const answer = await server.handle(line);
    const text = answer?.result?.content?.[0]?.text;
    need(typeof text === 'string' && text !== '', `${tool.name} answered nothing`);
    need(answer.result.isError !== true, `${tool.name} refused: ${text}`);
    const parsed = JSON.parse(text);
    if (tool.name === 'quota_notice') {
      need(parsed.available === true && parsed.released === true,
        'the simulated quota-back event must release the notice');
      need(parsed.text.includes('cota da sua assinatura do Codex voltou'),
        'the quota-back notice must use plain words in the requested language');
    }
    if (tool.name === 'inbox_add') state.demand = parsed.id;
    if (tool.name === 'order_add') state.order = parsed.id;
  }

  const unknown = await server.handle(frame(99, 'tools/call', { name: 'nope', arguments: {} }));
  need(unknown?.error?.code === -32602, `an unknown tool must be -32602, got ${JSON.stringify(unknown)}`);
  const broken = await server.handle('{ not json');
  need(broken?.error?.code === -32700, `a bad line must be -32700, got ${JSON.stringify(broken)}`);
  const after = await server.handle(frame(100, 'tools/list'));
  need(after?.result?.tools?.length === TOOLS.length, 'the loop must keep reading after a bad line');
}

// E15: add, list and the whole status sequence, each one persisted. The
// demands other checks left are on the same root, so every assertion is about
// the one this check added.
async function inboxFlow(deps) {
  const root = deps.stateRoot;
  const added = await inboxAdd(root, { title: 'the smoke demand', kind: 'task', client: 'claude-code' });
  const listed = await inboxList(root);
  need(listed.some((item) => item.id === added.id), 'the list must hold the demand just added');
  need(added.status === 'pending', 'a new demand must be pending');

  for (const status of ['delegated', 'criticised', 'consolidated']) {
    const moved = await inboxSetStatus(root, added.id, status);
    need(moved.status === status, `${added.id} must reach ${status}, got ${moved.status}`);
  }
  const stored = JSON.parse(await readFile(paths(root).inbox, 'utf8'));
  const row = stored.items.find((item) => item.id === added.id);
  need(row?.status === 'consolidated', 'the end of the sequence must be persisted');
}

// E16: a revoked order survives with its reason, and a second revoke is refused.
async function ordersFlow(deps) {
  const root = deps.stateRoot;
  const added = await orderAdd(root, { text: 'the smoke order' });
  const listed = await orderList(root);
  need(listed.some((order) => order.id === added.id && order.status === 'active'),
    'a new order must be listed as active');

  const revoked = await orderRemove(root, added.id, { reason: 'the smoke run is over' });
  need(revoked.active === false && revoked.revokedReason === 'the smoke run is over',
    'the revoke must keep its reason');
  const after = await orderList(root, { activeOnly: false });
  const row = after.find((order) => order.id === added.id);
  need(row?.status === 'revoked', 'the revoked row must survive');

  const again = await orderRemove(root, added.id, { reason: 'again' }).then(() => null, (error) => error);
  need(again instanceof TypeError, `a second revoke must be refused, got ${again}`);
}

// E17: add, list, pause, resume, remove, and one period that opens one child.
async function templatesFlow(deps) {
  const root = deps.stateRoot;
  await templateAdd(root, {
    name: 'smoke-e17',
    schedule: '*/5 * * * *',
    demand: { title: 'the smoke child' },
  }, { now: SLOT });
  const listed = await templateList(root, { name: 'smoke-e17' });
  need(listed.name === 'smoke-e17', 'the template must be listed');

  await templateSet(root, 'smoke-e17', { paused: true });
  const paused = await openDue(root, SLOT);
  need(paused.decisions.find((decision) => decision.name === 'smoke-e17')?.due === false,
    'a paused template must open nothing');
  need(paused.decisions.find((decision) => decision.name === 'smoke-e17')?.reason === 'the schedule is paused',
    'the decision must say the schedule is paused');

  await templateSet(root, 'smoke-e17', { paused: false });
  const first = await openDue(root, SLOT);
  const second = await openDue(root, SLOT);
  const children = (await inboxList(root)).filter((item) => item.ext?.template === 'smoke-e17');
  need(first.ids.includes(children[0]?.id), `the first pass must open the child, opened ${first.ids.length}`);
  need(children.length === 1, `one period must open one child, opened ${children.length}`);
  need(!second.ids.includes(children[0].id), 'a second pass in the same period must open none of its own');

  const removed = await templateRemove(root, 'smoke-e17');
  need(removed.revoked.length === 1, 'the template must revoke its standing order');
  need((await templateList(root)).every((template) => template.name !== 'smoke-e17'), 'the template must be gone');
}

// E18: six columns, a capacity line, no ANSI, and another word per locale.
async function statusTableCheck(deps) {
  const reading = { source: 'api', remainingPct: 64, windowMinutes: 300 };
  const base = {
    config: DEFAULT_CONFIG,
    clients: ['claude-code'],
    readQuota: async () => reading,
    now: deps.now,
    orders: [],
    limits: { limits: { global: 3, clients: {} }, live: 0, byClient: {} },
  };

  const table = await statusTable(deps.stateRoot, { ...base, cache: new Map(), locale: 'en' });
  const header = table.markdown.split('\n')[0];
  need(header.split('|').length === 8, `the table must have six columns, got ${header}`);
  need(!table.markdown.includes(ESC) && !table.capacityLine.includes(ESC), 'the table must carry no ANSI');
  need(table.capacityLine.includes('executors that can launch now'), 'the capacity line must be under the table');

  const pt = await statusTable(deps.stateRoot, { ...base, cache: new Map(), locale: 'pt-BR' });
  need(pt.markdown.includes('Assinatura'), 'pt-BR must be another word per column');
  need(!pt.markdown.includes('Subscription'), 'pt-BR must not keep the English header');
  need(pt.capacityLine.includes('executores'), 'pt-BR must be another word on the capacity line');
  need(pt.markdown.split('\n')[2].includes('64%'), 'the reading must reach the row');
}

// E19: every listed CLI action exits 0 with the injected run,
// spawn and write.
async function commandsEvery(deps) {
  const actions = [
    ['daemon', 'start'], ['daemon', 'stop'], ['daemon', 'status'],
    ['daemon', 'pause'], ['daemon', 'resume'], ['daemon', 'run-once'],
    ['autostart', 'show'], ['autostart', 'install'], ['autostart', 'uninstall'],
    ['status'], ['actors'],
  ];
  for (const argv of actions) {
    const run = await cli(deps, argv, { ...onePass(), spawn: deps.spawn });
    need(run.code === 0, `${deps.command ?? DEFAULT_CONFIG.install.command} ${argv.join(' ')} must exit 0, got ${run.code}: ${run.err.join(' / ')}`);
    if (argv[1] === 'install') need(run.wrote.length === 1, 'autostart install must report the file it wrote');
  }
}

// E20: the kit reads only quota samples in a disposable registry. Its launch
// floor comes from its existing configuration. Local command meters and their
// caches simulate quota; no client is launched or real user home consulted.
async function quotaBelowLaunchFloor(deps) {
  const base = await mkdtemp(join(tmpdir(), 'okit-smoke-quota-'));
  const home = join(base, 'home');
  const registry = join(base, 'registry');
  await Promise.all([mkdir(home), mkdir(registry)]);
  const env = { PATH: deps.env?.PATH ?? process.env.PATH, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'), OKWORK_HOME: join(home, '.okwork'),
    KIT_REGISTRY: registry, NO_COLOR: '1' };
  Object.assign(env, { KIT_CONFIG_USER: join(base, 'config.json'),
    KIT_CONFIG_PROJECT: join(base, 'empty.json'), KIT_CONFIG: home,
    KIT_EXECUTORS_DEFAULT: join(base, 'executors.json'),
    KIT_EXECUTORS_USER: join(base, 'empty.json'), KIT_EXECUTORS_PROJECT: join(base, 'empty.json'),
    KIT_LOG_DIR: join(base, 'logs'), KIT_SKIP_HEALTH: '1', KIT_RUN_ALLOW_DETACHED: '1',
    KIT_WAIT_DEBT: '0', KIT_TZ: 'UTC', XDG_STATE_HOME: join(home, 'state') });
  const run = async (args) => {
    const result = await deps.run({ command: 'kit', args, env, cwd: base });
    return { ...result, code: Object.hasOwn(result, 'code') ? result.code : result.exitCode };
  };
  try {
    await writeFile(env.KIT_CONFIG_USER, JSON.stringify({ parallel: deps.config?.parallel ?? {} }));
    await writeFile(env.KIT_CONFIG_PROJECT, '{}');
    const configured = await run(['config', 'get', 'parallel.minQuotaPercent', '--json']);
    // The in-process runner has a no-op command seam. Without a process result
    // there is no kit evidence to assert; process-backed runners verify below.
    if (configured.code === undefined) return;
    need(configured.code === 0, `kit must read its configured launch floor: ${configured.stderr}`);
    let floor;
    try {
      const value = JSON.parse(configured.stdout);
      floor = typeof value === 'number' ? value : value.value ?? value.parallel?.minQuotaPercent;
    } catch { floor = Number(configured.stdout.trim()); }
    need(Number.isFinite(floor) && floor > 0, 'parallel.minQuotaPercent must allow a below-floor quota sample');
    const names = ['smoke-first', 'smoke-later'];
    const checked = Math.floor(deps.now() / 1000);
    const providers = names.map((name, index) => {
      const resetsAt = new Date((checked + (index + 1) * 3600) * 1000).toISOString();
      return { name, remaining_percent: floor - 1, resets_at: resetsAt,
        windows: [{ name: 'window', remaining_percent: floor - 1, resets_at: resetsAt }] };
    });
    await writeFile(env.KIT_EXECUTORS_DEFAULT, JSON.stringify({
      executors: names.map((name) => ({ id: name, alias: name, model: `smoke/${name}`,
        client: 'smoke-no-client', class: 'normal', quota: name, subscription: name, enabled: true })),
      quotas: Object.fromEntries(names.map((name) => [name,
        { cmd: `cat "$KIT_REGISTRY/${name}-reading.json"` }])),
    }));
    for (const provider of providers) {
      await writeFile(join(registry, `${provider.name}-reading.json`), JSON.stringify(provider));
      await writeFile(join(registry, `${provider.name}-quota.json`), JSON.stringify({ checked, reading: provider }));
    }
    await writeFile(join(registry, 'quotas.json'), JSON.stringify({ checked, providers }));
    await writeFile(join(base, 'briefing.md'), 'Check that no executor can launch.\n');
    const quota = await run(['quota', '--cached', '--json']);
    need(quota.code === 0, `kit quota must read the simulated registry: ${quota.stderr}`);
    const readings = JSON.parse(quota.stdout).providers;
    need(names.every((name) => readings.some((reading) => reading.name === name
      && reading.remaining_percent === floor - 1)), 'kit quota must report every simulated reading');
    const capacity = await run(['capacity', '--cached', '--json']);
    need(capacity.code === 0, `kit capacity must read the simulated quota: ${capacity.stderr}`);
    const available = JSON.parse(capacity.stdout);
    need(available.total === 0 && available.subscriptions.length === names.length
      && available.subscriptions.every((entry) => entry.can_launch === 0 && entry.threshold === floor),
    'kit capacity must report zero launchable executors at the configured threshold');
    const refusal = await run(['run', join(base, 'briefing.md'), '--class', 'normal', '--strict']);
    need(refusal.code === 6, `kit run must refuse with quota code 6, got ${refusal.code}`);
    for (const name of names) {
      need(new RegExp(`- ${name}: subscription ${name} below launch threshold .*resets in`).test(refusal.stderr),
        `kit run must list ${name} and its quota/reset reason: ${refusal.stderr}`);
    }
    const earliest = providers[0].resets_at.slice(11, 16);
    need(refusal.stderr.includes(`first available at ${earliest} (${names[0]})`),
      `kit run must print the nearest quota return time: ${refusal.stderr}`);
    // The same sample must become launchable when the configured floor drops
    // to its percentage. Probe only the gate, never start a client as a control.
    await writeFile(env.KIT_CONFIG_USER, JSON.stringify({ parallel: { minQuotaPercent: floor - 1 } }));
    const control = await run(['executor', 'gate', names[0], '--cached']);
    const gate = JSON.parse(control.stdout);
    need(control.code === 0 && gate.status === 'ok' && gate.threshold === floor - 1,
      `changing the configured floor must change the launch gate: ${control.stdout} ${control.stderr}`);
    const actorFloor = deps.config?.lowQuotaPct ?? DEFAULT_CONFIG.lowQuotaPct;
    const simulated = async (locale) => listActors({ root: deps.stateRoot, home,
      config: { ...DEFAULT_CONFIG, lowQuotaPct: actorFloor, profiles: PROFILES }, locale,
      client: 'claude-code', now: deps.now, env: { HOME: home, USERPROFILE: home }, orders: [],
      cache: new Map(),
      plugin: { path: deps.projectRoot, onPath: true }, versions: { 'claude-code': { installed: true } },
      detectClients: async () => ({ clients: [{ client: 'claude-code', installed: true,
        source: 'listing', models: ['haiku', 'sonnet', 'opus'], hidden: [] }] }),
      readQuota: async (client) => ({ source: 'manual', remainingPct: Math.min(floor - 1, actorFloor - 1),
        recordedAt: deps.now(), client }), limits: { global: 3, clients: {} } });
    for (const [locale, words] of [['en', ['below the floor', 'Wait for quota reset']],
      ['pt-BR', ['Cota abaixo do piso', 'Aguarde a renovação']]]) {
      const actors = await simulated(locale);
      need(actors.actors.length > 0 && actors.actors.every((actor) => !actor.canLaunch),
        `${locale} actors must all be refused below the configured floor`);
      need(actors.markdown.includes(words[0]) && actors.markdown.includes(words[1]),
        `${locale} actor output must explain the quota refusal in plain words: ${actors.markdown}`);
      need(!/\b(?:[DECO][0-9]+|quota-below-floor|lowQuotaPct|KIT_[A-Z_]+|[a-f0-9]{8}-[a-f0-9-]{27})\b/i.test(actors.markdown),
        `${locale} actor output must not expose check codes or ids`);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

/**
 * The feature group, in the order of the table in `docs/maintainers/SMOKE.md`. Every check
 * drives a real module of `src/` and writes only inside the scratch root.
 */
export const FEATURE_CHECKS = [
  { id: 'E1', name: 'daemon.run-once', group: 'E', timeoutMs: 20000, run: daemonRunOnce },
  { id: 'E2', name: 'daemon.pause', group: 'E', timeoutMs: 15000, run: daemonPauseCheck },
  { id: 'E3', name: 'daemon.killswitch', group: 'E', timeoutMs: 15000, run: daemonKillswitch },
  { id: 'E4', name: 'daemon.lifecycle', group: 'E', timeoutMs: 25000, run: daemonLifecycle },
  { id: 'E5', name: 'daemon.status', group: 'E', timeoutMs: 15000, run: daemonStatusCheck },
  { id: 'E6', name: 'state.atomic', group: 'E', timeoutMs: 10000, run: stateAtomic },
  { id: 'E7', name: 'state.locks', group: 'E', timeoutMs: 20000, run: stateLocks },
  { id: 'E8', name: 'spawn.command', group: 'E', timeoutMs: 10000, run: spawnCommand },
  { id: 'E9', name: 'spawn.process', group: 'E', timeoutMs: 15000, run: spawnProcess },
  { id: 'E10', name: 'limits.slots', group: 'E', timeoutMs: 15000, run: limitsSlots },
  { id: 'E11', name: 'autostart.plan', group: 'E', timeoutMs: 10000, run: autostartPlanCheck },
  { id: 'E12', name: 'autostart.apply', group: 'E', timeoutMs: 15000, run: autostartApply },
  { id: 'E13', name: 'skills.packaged', group: 'E', timeoutMs: 10000, run: skillsPackaged },
  { id: 'E14', name: 'mcp.tools', group: 'E', timeoutMs: 30000, run: mcpTools },
  { id: 'E15', name: 'inbox.flow', group: 'E', timeoutMs: 15000, run: inboxFlow },
  { id: 'E16', name: 'orders.flow', group: 'E', timeoutMs: 15000, run: ordersFlow },
  { id: 'E17', name: 'templates.flow', group: 'E', timeoutMs: 20000, run: templatesFlow },
  { id: 'E18', name: 'status.table', group: 'E', timeoutMs: 15000, run: statusTableCheck },
  { id: 'E19', name: 'commands.every', group: 'E', timeoutMs: 30000, run: commandsEvery },
  { id: 'E20', name: 'quota.below-launch-floor', group: 'E', timeoutMs: 15000, run: quotaBelowLaunchFloor },
];

export default FEATURE_CHECKS;
