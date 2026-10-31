import { spawn } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import { configOf } from '../profiles.js';
import { readJson, writeJsonAtomic } from '../state.js';
import { paths, stateRoot as defaultRoot, SELFCHECK_ENV } from '../store.js';

/** The file the person records the quota in (`quota set claude-code`); the collector never writes it. */
export const READING_FILE = 'claude-code.json';

/** The file the collector writes under the state root: the client's JSON as it came; the core reads it. */
export const STATUSLINE_FILE = 'claude-code-statusline.json';

const plain = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Kills the command and the tree it leads: the whole group of the command on
 * POSIX, the tree of the process on Windows. Only what the collector started is
 * touched, and a kill that fails never throws to the caller.
 *
 * @param {object} child the child process of the collector
 * @param {{platform?: string, spawnFn?: Function}} [options] the platform and
 *   the spawn function, injectable for the test
 */
export function killTree(child, { platform = process.platform, spawnFn = spawn } = {}) {
  if (!Number.isInteger(child?.pid)) return;
  if (platform === 'win32') {
    // Windows has no group of our own: the tree of the command is killed by
    // name, and the child itself dies with it.
    try {
      spawnFn('taskkill', ['/pid', String(child.pid), '/T', '/F'],
        { stdio: 'ignore', windowsHide: true })
        .on('error', () => { /* the tree is gone */ })
        .unref();
    } catch { /* the tree is gone: the child alone is left */ }
    try { child.kill('SIGKILL'); } catch { /* the child is already gone */ }
    return;
  }
  // The whole group of the child dies with it, so a descendant that inherited
  // the output dies too; only the group of this command is touched.
  try { process.kill(-child.pid, 'SIGKILL'); return; }
  catch { /* the group is gone: the child alone is left */ }
  try { child.kill('SIGKILL'); } catch { /* the child is already gone */ }
}

/**
 * Runs the previous command of the status bar and answers its bytes.
 *
 * The command is a plain program (no shell) and it has one deadline. Whatever
 * it does, the answer comes before the deadline passes and nothing of ours
 * stays behind: the pipes are closed, the child is unreferenced and the tree
 * of the child is killed, so a descendant that inherited the output cannot keep
 * the status bar of the client waiting.
 *
 * The answer is the bytes the command wrote, unchanged and binary, when it ended
 * well; an empty buffer when the deadline passed before the command finished
 * (the pipe did not close) and nothing when it failed or spoke too much. A
 * command that did not finish has not answered in time, whatever the exit code
 * of its parent was.
 *
 * @param {{command: string, args?: string[], input: Buffer, timeoutMs: number,
 *   maxOutputBytes: number}} call
 * @returns {Promise<Buffer|undefined>} the bytes of the command
 */
export function runPrevious({ command, args, input, timeoutMs, maxOutputBytes }) {
  return new Promise((resolve) => {
    let child, timer, size = 0, settled = false;
    const chunks = [];
    // The pipes and the handle of the child must not hold the collector alive
    // once the run is over: they are released exactly once, here.
    const release = () => {
      clearTimeout(timer);
      for (const pipe of [child?.stdout, child?.stdin]) {
        try { pipe?.destroy(); } catch { /* the pipe is already gone */ }
      }
      try { child?.unref?.(); } catch { /* the child is already gone */ }
    };
    // The one way out of the run: the first answer is the answer, and a late
    // event of the child (more bytes, the end of the pipe) changes nothing.
    const finish = (output) => {
      if (settled) return;
      settled = true;
      release();
      resolve(output);
    };
    // The whole tree of the child dies with it, so a descendant that inherited
    // the output dies too; only what the collector started is touched.
    const kill = () => killTree(child);
    try {
      // On POSIX the child leads a group of its own, so the group can be killed
      // as a whole; on Windows there is no group and the tree is killed by name.
      child = spawn(command, args, { shell: false, stdio: ['pipe', 'pipe', 'ignore'],
        detached: process.platform !== 'win32' });
      timer = setTimeout(() => {
        kill();
        // A command that did not finish before the deadline has not answered
        // in time and answers nothing, even when its parent already exited well.
        finish(Buffer.alloc(0));
      }, timeoutMs);
      child.on('error', () => { kill(); finish(undefined); });
      child.stdin.on('error', () => {});
      child.stdout.on('error', () => {});
      child.stdout.on('data', (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > maxOutputBytes) { kill(); finish(undefined); }
        else chunks.push(chunk);
      });
      child.on('close', (code) => finish(code === 0 && size <= maxOutputBytes
        ? Buffer.concat(chunks) : undefined));
      child.stdin.end(input);
    } catch { kill(); finish(undefined); }
  });
}

/** Collection must never prevent the user's bar from running. Output stays binary. */
export async function collectStatusline({ input, previous, stateRoot, run = runPrevious,
  now = Date.now, config } = {}) {
  previous ??= Array.isArray(config?.statuslineCollector?.previous)
    ? config.statuslineCollector.previous : undefined;
  let settings;
  try { settings = configOf(config).statuslineCollector; }
  catch { settings = configOf().statuslineCollector; }
  try {
    if (Buffer.byteLength(input) <= settings.maxInputBytes) {
      const value = JSON.parse(input.toString());
      // The collector stores what the client sent and nothing more: the percentages are read by the core.
      if (plain(value) && plain(value[settings.fields.rateLimits])) {
        await writeJsonAtomic(join(paths(stateRoot).quota, STATUSLINE_FILE),
          { receivedAt: new Date(now()).toISOString(), input: value });
      }
    }
  } catch { /* An optional reading must not break the bar. */ }
  try {
    const [command, ...args] = previous ?? settings.previous;
    if (!command) return Buffer.alloc(0);
    return await run({ command, args, input, timeoutMs: settings.timeoutMs,
      maxOutputBytes: settings.maxOutputBytes }) ?? Buffer.alloc(0);
  } catch { return Buffer.alloc(0); }
}

/** The collector runs bare or as `--previous <command> [args...]`; anything else exits before collecting. */
export function collectorArgsValid(argv) {
  return !argv.length || (argv[0] === '--previous' && argv.length >= 2);
}

/** Bounded stdin; oversized input is drained but never retained or forwarded partially. */
export async function statuslineCommand(argv, io = {}) {
  try {
    const root = io.root ?? defaultRoot(io.env);
    const config = await readJson(paths(root).config, {}).catch(() => ({}));
    let settings;
    try { settings = configOf(config).statuslineCollector; }
    catch { settings = configOf().statuslineCollector; }
    if (!collectorArgsValid(argv)) return 0;
    // A run of the post-install check records its reading and never starts a command that is not ours.
    const verifying = Boolean((io.env ?? process.env)[SELFCHECK_ENV]);
    const previous = verifying ? [] : argv.length ? argv.slice(1)
      : Array.isArray(config?.statuslineCollector?.previous)
        ? config.statuslineCollector.previous : settings.previous;
    const chunks = [];
    let size = 0;
    for await (const chunk of io.stdin ?? process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size <= settings.maxInputBytes) chunks.push(bytes);
      else chunks.length = 0;
    }
    if (size > settings.maxInputBytes) return 0;
    const output = await collectStatusline({ input: Buffer.concat(chunks), previous,
      stateRoot: root, run: io.run, now: io.now, config });
    (io.stdout ?? ((bytes) => process.stdout.write(bytes)))(output);
  } catch { /* No diagnostics on a status bar. */ }
  return 0;
}
