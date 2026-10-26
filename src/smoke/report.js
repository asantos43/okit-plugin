// The result record of a smoke run and the two artifacts it leaves: one JSON
// object per line for a machine, one human text for an issue. Every value comes
// from `deps`, so a test writes the same records on any host without touching
// its own machine.

import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
import { DEFAULT_CONFIG } from '../profiles.js';

// How many lines of the deciding file a record carries: enough to see the
// failure, short enough that the record stays a line in the jsonl.
const LOG_TAIL_LINES = 20;

const LOG_FOLDER = ['logs', 'smoke'];

/**
 * The folder the two artifacts of a run land in, under the state root. The
 * runner prints it, so a reader knows where to look even when the output of
 * the run was lost.
 *
 * @param {string} stateRoot the root of the state
 * @returns {string} the folder of the artifacts
 */
export function artifactsFolder(stateRoot) {
  return join(stateRoot, ...LOG_FOLDER);
}

// The environment a run reports, from the same names the runner takes as
// parameters: `stateRoot` and `okitHome` are the same folder under a scratch
// home, and `OKWORK_HOME` is what names it when neither is given.
export function environmentOf(deps = {}) {
  const env = deps.env ?? {};
  const stateRoot = deps.stateRoot ?? deps.okitHome ?? env.OKWORK_HOME;
  return {
    os: { platform: deps.platform, release: deps.release, arch: deps.arch },
    node: deps.nodeVersion,
    cwd: deps.cwd,
    pluginRoot: deps.pluginRoot,
    stateRoot,
    configRoot: deps.configRoot ?? env.CLAUDE_CONFIG_DIR,
    okitHome: deps.okitHome ?? stateRoot,
    pid: deps.pid,
  };
}

// The message plus the first stack frame, which is the frame that named the
// failure; the rest of the stack is in the tail of the log the check decided.
function describeError(error) {
  if (error === undefined || error === null || error === '') return '';
  if (typeof error === 'string') return error;
  const message = typeof error.message === 'string' && error.message !== '' ? error.message : String(error);
  const frames = typeof error.stack === 'string' ? error.stack.split('\n').map((line) => line.trim()) : [];
  const frame = frames.find((line) => line.startsWith('at '));
  return frame ? `${message} (${frame})` : message;
}

// The last lines of the file that decided the check, as an array: text is
// split, a list is taken as it is, and an empty answer is an empty list.
function logTailOf(value) {
  if (Array.isArray(value)) return value.slice(-LOG_TAIL_LINES).map((line) => String(line));
  if (typeof value !== 'string' || value === '') return [];
  const lines = value.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return lines.slice(-LOG_TAIL_LINES);
}

// The argv that ran as a child, or `''` for a check that stayed in process.
function commandOf(value) {
  return Array.isArray(value) && value.length > 0 ? value.map((part) => String(part)) : '';
}

/**
 * One result record: the check, what happened to it and the environment it
 * ran in. The fields are the ones `docs/maintainers/SMOKE.md` lists, in that order.
 */
export function recordOf(check, outcome = {}, deps = {}) {
  return {
    id: check.id,
    name: check.name,
    group: check.group,
    status: outcome.status ?? 'skip',
    durationMs: outcome.durationMs ?? 0,
    timeoutMs: check.timeoutMs,
    error: describeError(outcome.error),
    command: commandOf(outcome.command),
    environment: environmentOf(deps),
    logTail: logTailOf(outcome.logTail),
  };
}

/**
 * The run id: the UTC instant and the pid (`20261023T091530Z-4242`), which keeps
 * two runs apart and orders them, since the stamp is fixed width and UTC.
 */
export function runIdOf(now, pid) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${pid}`;
}

// A sibling temporary file is synced and then renamed over the target, the same
// order `writeJsonAtomic` of `src/state.js` uses: a reader sees the old bytes or
// the whole new ones, never half of them. The text is written raw, since the
// artifacts are lines, not one indented JSON value.
async function writeTextAtomic(file, text) {
  const folder = dirname(file);
  const temp = join(folder, `${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  await mkdir(folder, { recursive: true });

  try {
    const handle = await open(temp, 'w');
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw new Error(`Cannot write ${file}: ${error.message}`, { cause: error });
  }
}

// The environment block of the human log, one `key: value` per line, in the
// order the record lists them.
function environmentLines(environment) {
  return [
    `os: ${environment.os.platform} ${environment.os.release} ${environment.os.arch}`,
    `node: ${environment.node}`,
    `cwd: ${environment.cwd}`,
    `pluginRoot: ${environment.pluginRoot}`,
    `stateRoot: ${environment.stateRoot}`,
    `configRoot: ${environment.configRoot}`,
    `okitHome: ${environment.okitHome}`,
    `pid: ${environment.pid}`,
  ];
}

// One line per check (`pass E7 state.locks 120ms`), and under a check that did
// not pass its error, its argv and its tail, since that is what a reader pastes
// into an issue.
function recordLines(record) {
  const lines = [`${record.status} ${record.id} ${record.name} ${record.durationMs}ms`];
  if (record.status === 'pass') return lines;
  if (record.error !== '') lines.push(`error: ${record.error}`);
  if (record.command !== '') lines.push(`command: ${record.command.join(' ')}`);
  if (record.logTail.length > 0) {
    lines.push('logTail:');
    for (const line of record.logTail) lines.push(`  ${line}`);
  }
  return lines;
}

function humanText(header, records, environment, summary) {
  const block = header.environment ?? records.find((record) => record.environment)?.environment ?? environment;
  const lines = [`${header.command ?? DEFAULT_CONFIG.install.command} smoke`, `run: ${header.runId}`, ...environmentLines(block), ''];
  if (header.reason) lines.push(`refused: ${header.reason}`);
  for (const record of records) {
    lines.push(...recordLines(record));
  }
  const count = (status) => records.filter((record) => record.status === status).length;
  lines.push(`passed: ${count('pass')} failed: ${count('fail') + count('timeout')} skipped: ${count('skip')}`);
  if (header.kind === 'smoke-in-client') {
    if (records.some((record) => record.error === 'config-missing')) lines.push('The installation is incomplete: config-missing');
    if (summary?.stopped) lines.push(`ceiling: ${summary.stopped}`);
    if (summary?.partial) lines.push('PARCIAL: some checks were skipped');
    if (summary) lines.push(`spent USD: ${summary.spentUsd}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Writes the two artifacts of a run under `<stateRoot>/logs/smoke/`: the jsonl,
 * the run header and then one record per line in execution order, and the human
 * log, whose environment block sits at the top. Both are UTF-8 with `\n` only,
 * so a Windows run pastes into an issue unchanged.
 *
 * @returns {Promise<{jsonl: string, log: string}>} the paths it wrote.
 */
export async function writeArtifacts(stateRoot, runId, header, records, deps = {}) {
  const folder = artifactsFolder(stateRoot);
  const jsonl = join(folder, `smoke-${runId}.jsonl`);
  const log = join(folder, `smoke-${runId}.log`);
  const lines = [header, ...records].map((value) => JSON.stringify(value));

  await writeTextAtomic(jsonl, `${lines.join('\n')}\n`);
  await writeTextAtomic(log, humanText(header, records, environmentOf(deps), deps.summary));
  return { jsonl, log };
}
