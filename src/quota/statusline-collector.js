import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { configOf } from '../profiles.js';
import { readJson, writeJsonAtomic } from '../state.js';
import { paths, stateRoot as defaultRoot, SELFCHECK_ENV } from '../store.js';

/** The file the person records the quota in (`quota set claude-code`); the collector never writes it. */
export const READING_FILE = 'claude-code.json';

/** The file the collector writes under the state root: the client's JSON as it came; the core reads it. */
export const STATUSLINE_FILE = 'claude-code-statusline.json';

const plain = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

export function runPrevious({ command, args, input, timeoutMs, maxOutputBytes }) {
  return new Promise((resolve) => {
    let child, timer, size = 0;
    const chunks = [];
    const finish = (output = Buffer.alloc(0)) => {
      clearTimeout(timer);
      resolve(output);
    };
    try {
      child = spawn(command, args, { shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
      timer = setTimeout(() => { child.kill('SIGKILL'); finish(); }, timeoutMs);
      child.on('error', () => finish());
      child.stdin.on('error', () => {});
      child.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxOutputBytes) { child.kill('SIGKILL'); finish(); }
        else chunks.push(chunk);
      });
      child.on('close', (code) => finish(code === 0 && size <= maxOutputBytes
        ? Buffer.concat(chunks) : undefined));
      child.stdin.end(input);
    } catch { child?.kill('SIGKILL'); finish(); }
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
