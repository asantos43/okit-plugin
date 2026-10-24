import { spawn } from 'node:child_process';
import { arch, homedir, release } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { readQuota } from '../../adapters/claude-code/index.js';
import { loadConfig } from '../mcp/tools.js';
import { DEFAULT_CONFIG } from '../profiles.js';
import { readJson } from '../state.js';
import { paths, stateRoot } from '../store.js';
import { artifactsFolder, environmentOf, recordOf, runIdOf, writeArtifacts } from './report.js';
import { SCENARIO } from './scenario.js';
import { judge, prepare, cleanup, finish, skip } from './client-checks.js';

const MINUTE_MS = 60 * 1000;
const OVERRIDES = { '--max-usd': 'maxUsd', '--max-turns': 'maxTurns',
  '--max-minutes': 'maxMinutes', '--quota-floor': 'quotaFloorPct', '--timeout': 'checkTimeoutMs' };
const INSTALLATION = SCENARIO.slice(0, SCENARIO.findIndex((step) => step.kind === 'call'));

// The two lines the runner always prints: the start says what it is about to
// do, the end says how it ended and where the artifacts are.
const LINES = {
  start: (client, mode) => `smoke: start client=${client} mode=${mode}`,
  end: (code, artifacts) => `smoke: end exit=${code} artifacts=${artifacts}`,
};

// The flags of a run. The parse hands back the flags it understood and the
// first refusal, instead of throwing, so the runner still prints its start
// line before it reports the refusal.
function flagsOf(args) {
  const flags = { client: 'claude-code', only: [], overrides: {} };
  const switches = ['rehearsal', 'dry-run', 'headless', 'demo', 'keep', 'allow-unknown-quota'];
  for (let index = 0; index < args.length; index += 1) {
    const [key, ...values] = args[index].split('=');
    const inline = values.length ? values.join('=') : undefined;
    if (key.startsWith('--') && switches.includes(key.slice(2)) && inline === undefined) flags[key.slice(2)] = true;
    else if (key in OVERRIDES || ['--client', '--only'].includes(key)) {
      const value = inline ?? (args[index + 1]?.startsWith('--') ? undefined : args[index + 1]);
      if (inline === undefined && value !== undefined) index += 1;
      if (key in OVERRIDES) {
        if (value === undefined) continue;
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0 || (key !== '--quota-floor' && number === 0)
          || (key === '--max-turns' && !Number.isInteger(number))) return { flags, error: new Error(`Invalid ${key}`) };
        flags.overrides[OVERRIDES[key]] = number;
      } else if (!value) return { flags, error: new Error(`Missing ${key}`) };
      else if (key === '--only') flags.only.push(...value.toUpperCase().split(','));
      else flags.client = value;
    } else return { flags, error: new Error(`Unknown flag ${args[index]}`) };
  }
  if (flags.client !== 'claude-code') return { flags, error: new Error(`Unknown client ${flags.client}`) };
  if (flags.only.some((id) => id !== 'C' && !SCENARIO.some((step) => step.id === id))) {
    return { flags, error: new Error('Unknown --only check') };
  }
  return { flags };
}

// The mode the run was asked for: the offline walks first, then the two real
// modes, then the plain real run.
function modeOf(flags) {
  if (flags.rehearsal) return 'rehearsal';
  if (flags['dry-run']) return 'dry-run';
  if (flags.headless) return 'headless';
  if (flags.demo) return 'demo';
  return 'real';
}

// No shell; AbortSignal kills the child when a check or run deadline expires.
export function invokeClient({ command = 'claude', args, env, signal, onEvent, spawn: launch = spawn }) {
  return new Promise((resolve, reject) => {
    const child = launch(command, args, { env, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let stderr = ''; let pending = '';
    const events = [];
    const consume = (line) => {
      try { const event = JSON.parse(line); events.push(event); onEvent?.(event); }
      catch { /* Help is text; model prose is never evidence. */ }
    };
    child.stdout.on('data', (chunk) => {
      output += chunk;
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) consume(line);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (pending) consume(pending);
      if (code && !events.some((event) => event.type === 'result')) reject(new Error(stderr || 'Client failed'));
      else resolve({ events, stdout: output });
    });
  });
}

export function resolveRefs(value, context) {
  if (Array.isArray(value)) return value.map((entry) => resolveRefs(entry, context));
  if (!value || typeof value !== 'object') return value;
  if (value.$ref) {
    const resolved = value.$ref.split('.').reduce((current, key) => current?.[key], context);
    if (resolved === undefined) throw new Error(`Unresolved reference ${value.$ref}`);
    return resolved;
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveRefs(entry, context)]));
}

function toolAnswers(events) {
  const uses = new Map(); const answers = [];
  for (const event of events) {
    for (const block of event.message?.content ?? []) {
      if (block.type === 'tool_use') uses.set(block.id, block.name);
      if (block.type !== 'tool_result') continue;
      const text = typeof block.content === 'string' ? block.content
        : (block.content ?? []).map((entry) => entry.text ?? '').join('\n');
      try {
        let value = JSON.parse(text);
        if (value.content) value = JSON.parse(value.content.map((entry) => entry.text ?? '').join(''));
        answers.push({ tool: uses.get(block.tool_use_id), value, isError: block.is_error });
      } catch {
        if (block.is_error) answers.push({ tool: uses.get(block.tool_use_id), value: { error: text }, isError: true });
      }
    }
  }
  return answers;
}

async function bounded(work, ms, parent) {
  const controller = new AbortController();
  let cancel;
  const cancelled = new Promise((_, reject) => { cancel = reject; });
  const abort = () => { cancel(new Error('interrupted')); controller.abort(); };
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) { parent.removeEventListener('abort', abort); throw new Error('interrupted'); }
  let timer;
  try {
    return await Promise.race([cancelled, work(controller.signal), new Promise((_, reject) => {
      timer = setTimeout(() => { reject(new Error('timeout')); controller.abort(); }, ms);
    })]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
  }
}

/**
 * Runs the in-client smoke and always says how it ended: the start line comes
 * out before the run and the end line carries the exit code and the folder of
 * the artifacts, even when the run was refused or failed.
 *
 * @param {string[]} [argv] the flags of the run
 * @param {object} [io] the dependencies of the runner
 * @returns {Promise<object>} the result of the run
 */
export async function runClientSmoke(argv = [], io = {}) {
  const out = io.out ?? io.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const err = io.err ?? io.stderr ?? out;
  const sourceEnv = io.env ?? process.env;
  const root = io.root ?? stateRoot(sourceEnv);
  let code = 1;
  try {
    const result = await runScenario(argv, { ...io, out, err, env: sourceEnv, root });
    code = result.code;
    return result;
  } finally {
    out(LINES.end(code, artifactsFolder(root)));
  }
}

// The run itself: the flags, the quota, the client and the report.
async function runScenario(argv, io) {
  const out = io.out;
  const err = io.err;
  const root = io.root;
  const { flags, error } = flagsOf(argv);
  out(LINES.start(flags.client, modeOf(flags)));
  if (error) { err(error.message); return { code: 2, records: [] }; }
  const env = { ...io.env, OKWORK_HOME: root };
  const stored = await loadConfig(root);
  const budget = { ...DEFAULT_CONFIG.smoke, ...stored.smoke, ...flags.overrides };
  budget.maxTurns ??= SCENARIO.length;
  for (const [key, value] of Object.entries(budget)) {
    if (!Number.isFinite(value) || value < 0 || (key !== 'quotaFloorPct' && value === 0)
      || (key === 'maxTurns' && !Number.isInteger(value))) {
      err(`Invalid smoke.${key}`); return { code: 2, records: [] };
    }
  }
  const now = io.now ?? Date.now;
  const started = now();
  const runId = runIdOf(started, io.pid ?? process.pid);
  const selected = SCENARIO.filter((step) => !flags.only.length || flags.only.includes('C') || flags.only.includes(step.id));
  if (flags.rehearsal || flags['dry-run']) {
    for (const step of selected) out(`${step.id} ${step.name}: ${JSON.stringify(step.call)} — ${step.behaviour}`);
    out(`rehearsal: no client; maximum USD ${budget.maxUsd}; steps ${budget.maxTurns}; minutes ${budget.maxMinutes}`);
    return { code: 0, records: [], budget };
  }
  let quota = await (io.readQuota ?? (() => readQuota({ stateRoot: root, env, now })))(flags.client);
  if (quota?.ageMinutes > budget.quotaMaxAgeMinutes) {
    out('quota-stale: refresh quota / cota antiga: atualize a cota (smoke.quotaMaxAgeMinutes)');
  }
  if (quota?.ageMinutes > budget.quotaExpireMinutes) quota = { source: 'user' };
  const refusal = typeof quota?.remainingPct !== 'number' || !Number.isFinite(quota.remainingPct)
    ? (!flags['allow-unknown-quota'] ? 'quota-unknown' : null)
    : quota.remainingPct < budget.quotaFloorPct ? 'quota-below-floor' : null;
  const deps = { env, stateRoot: root, configRoot: env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    platform: io.platform ?? process.platform, release: release(), arch: arch(),
    pid: io.pid ?? process.pid, nodeVersion: process.version, cwd: io.cwd ?? process.cwd() };
  const header = { runId, startedAt: started, finishedAt: now(), real: true, only: flags.only, interrupted: false,
    kind: 'smoke-in-client', client: flags.client, scenario: 'C1-C23',
    environment: environmentOf(deps), ...(refusal ? { reason: refusal } : {}) };
  if (refusal) {
    const artifacts = await writeArtifacts(root, runId, header, [], deps);
    out(`${refusal}\n${artifacts.jsonl}\n${artifacts.log}`);
    return { code: 2, records: [], artifacts, reason: refusal };
  }
  if (!Number.isFinite(quota?.remainingPct)) out('quota-unknown: explicitly allowed');
  // profile_pick accepts only these fields; adapter metadata stays local.
  const profileQuota = quota && { source: quota.source,
    ...(Number.isFinite(quota.remainingPct) ? { remainingPct: quota.remainingPct } : {}) };
  const context = { root, env, config: stored, client: flags.client, quota: profileQuota, run: io.run,
    owned: { inbox: new Set(), orders: new Set(), fillers: [] }, events: [], fixtures: {
      slot: { runId: `okit-smoke-${runId}` }, refused: { runId: `okit-smoke-${runId}-refused` },
      absent: { runId: `okit-smoke-${runId}-absent` }, inbox: { body: `okit-smoke ${runId}` },
      profile: { effort: 'hard', atFloor: { source: 'user', remainingPct: stored.lowQuotaPct },
        belowFloor: { source: 'user', remainingPct: stored.lowQuotaPct - Number.EPSILON * Math.max(1, stored.lowQuotaPct) } },
      dueTemplate: { name: `okit-smoke-${runId}`, schedule: '* * * * *',
        demand: { title: 'okit-smoke', body: `okit-smoke ${runId}` } },
    } };
  const client = io.client ?? invokeClient;
  try {
    const help = await bounded((signal) => client({ command: 'claude', args: ['--help'], env, signal }),
      Math.min(budget.checkTimeoutMs, budget.maxMinutes * MINUTE_MS), io.signal);
    for (const flag of ['--output-format', '--include-hook-events', '--verbose', '--max-budget-usd',
      '--permission-mode', '--no-session-persistence']) {
      if (!help.stdout?.includes(flag)) throw new Error(`Client lacks ${flag}`);
    }
  } catch (error) {
    header.reason = 'client-refused';
    const artifacts = await writeArtifacts(root, runId, header, [], deps);
    err(error.message); out(`${artifacts.jsonl}\n${artifacts.log}`);
    return { code: 2, records: [], artifacts, reason: header.reason };
  }
  const records = [];
  let spent = 0; let turns = 0; let stopped;
  const ceiling = () => spent >= budget.maxUsd ? 'smoke.maxUsd'
    : turns >= budget.maxTurns ? 'smoke.maxTurns'
      : now() - started >= budget.maxMinutes * MINUTE_MS ? 'smoke.maxMinutes' : null;
  const request = async (step, signal) => {
    if (spent >= budget.maxUsd) { stopped = 'smoke.maxUsd'; return { outcome: skip('budget-exhausted') }; }
    const resolved = resolveRefs(step.call, context);
    const operation = resolved?.tool ? { tool: resolved.tool, arguments: resolved.arguments,
      ...(resolved.then ? { then: resolved.then } : {}) } : null;
    const briefing = operation?.tool
      ? `Call exactly these MCP operations, preserve their arguments. Never judge success or modify other records. ${JSON.stringify(operation)}`
      : 'Initialize this session with the installed okit plugin. Do not call tools or change files. Reply ready.';
    const args = ['-p', briefing, '--output-format', 'stream-json', '--include-hook-events', '--verbose',
      '--max-budget-usd', String(budget.maxUsd - spent), '--permission-mode', 'default', '--no-session-persistence'];
    context.command = ['claude', ...args];
    const response = await client({ command: 'claude', args, env, signal, step, operation,
      onEvent: flags.demo ? (event) => {
        for (const block of event.message?.content ?? []) if (block.type === 'text') out(block.text);
      } : undefined });
    const events = response.events ?? [];
    context.events.push(...events);
    context.init ??= events.find((event) => event.subtype === 'init');
    context.pluginRoot ??= context.init?.plugins?.find((plugin) => plugin.name?.includes('okit'))?.path;
    deps.pluginRoot = context.pluginRoot;
    const result = events.findLast((event) => event.type === 'result');
    // Keep client metadata, never the model's result prose or session history.
    context.result = result && Object.fromEntries(['type', 'subtype', 'is_error', 'num_turns',
      'total_cost_usd', 'permission_denials', 'terminal_reason'].filter((key) => key in result)
      .map((key) => [key, result[key]]));
    if (!result) return { outcome: { status: 'fail', error: 'Missing client result event' } };
    if (result?.total_cost_usd != null) spent += result.total_cost_usd;
    if (result?.terminal_reason === 'budget_exhausted' || result?.subtype === 'error_max_budget_usd') {
      stopped = 'smoke.maxUsd'; return { outcome: skip('budget-exhausted') };
    }
    if (result?.permission_denials?.length) return { outcome: skip('permission-denied') };
    if (['permission_denied', 'client_refused'].includes(result?.terminal_reason)) return { outcome: skip('client-refused') };
    if (result?.is_error) return { outcome: { status: 'fail', error: result.subtype ?? 'client error', logTail: JSON.stringify(context.result) } };
    return { answers: toolAnswers(events) };
  };
  for (const step of selected) {
    const at = now();
    let outcome;
    context.command = '';
    context.result = null;
    stopped ??= ceiling();
    const timeoutMs = Math.min(budget.checkTimeoutMs, Math.max(0, budget.maxMinutes * MINUTE_MS - (at - started)));
    if (stopped) outcome = { ...skip(stopped === 'timeout' ? 'timeout' : 'budget-exhausted'), logTail: stopped };
    else {
      turns += 1;
      if (flags.demo) out(`${step.id} ${step.behaviour}`);
      try {
        outcome = await bounded(async (signal) => {
          if (step.id === 'C14' && await readJson(paths(root).config, null) === null) return skip('config-missing');
          if (step.id === 'C23') return { status: 'pass' }; // Verified after the first artifact write below.
          const preparation = await prepare(step, context, signal);
          if (preparation) return preparation;
          let answers = [];
          if (step.kind === 'call' || !context.init) {
            const response = await request(step, signal);
            if (response.outcome) return response.outcome;
            answers = response.answers;
          }
          const result = await judge(step, context, answers);
          if (step.id === 'C14' && result.status === 'pass') {
            for (const quota of [context.fixtures.profile.atFloor, context.fixtures.profile.belowFloor]) {
              context.profileQuota = quota;
              const variant = { ...step, call: { ...step.call, arguments: { ...step.call.arguments, quota } } };
              const response = await request(variant, signal);
              if (response.outcome) return response.outcome;
              const verdict = await judge(step, context, response.answers);
              if (verdict.status !== 'pass') return verdict;
            }
          }
          return result;
        }, timeoutMs, io.signal);
      } catch (error) {
        if (error.message === 'timeout') {
          outcome = { status: 'fail', error: 'timeout' };
          stopped = now() - started >= budget.maxMinutes * MINUTE_MS ? 'smoke.maxMinutes' : 'timeout';
        } else if (error.message === 'interrupted') {
          outcome = skip('client-refused'); stopped = 'interrupted'; header.interrupted = true;
        } else outcome = { status: 'fail', error };
      } finally { if (step.id === 'C8') await cleanup(context); }
    }
    records.push(recordOf({ ...step, group: 'C', timeoutMs: budget.checkTimeoutMs },
      { ...outcome, command: context.command, durationMs: Math.max(0, now() - at),
        logTail: [outcome.logTail ?? '', ...(context.result ? [JSON.stringify(context.result)] : [])] }, deps));
  }
  await cleanup(context);
  header.environment = environmentOf(deps);
  const report = records.find((record) => record.id === 'C23' && record.status === 'pass');
  let artifacts = await writeArtifacts(root, runId, header, records, deps);
  if (report) {
    const { access } = await import('node:fs/promises');
    try { await access(artifacts.jsonl); await access(artifacts.log); report.logTail = [artifacts.jsonl, artifacts.log]; }
    catch (error) { report.status = 'fail'; report.error = error.message; }
  }
  const partial = records.some((record) => record.status === 'skip');
  deps.summary = { spentUsd: spent, steps: turns, stopped: stopped ?? null, partial };
  header.finishedAt = now();
  artifacts = await writeArtifacts(root, runId, header, records, deps);
  for (const record of records) out(`${record.status} ${record.id} ${record.name} ${record.durationMs}ms${record.error ? ` ${record.error}` : ''}`);
  if (records.some((record) => record.error === 'config-missing')) out('The installation is incomplete: config-missing');
  if (stopped) out(`ceiling: ${stopped}`);
  if (partial) out('PARCIAL: some checks were skipped');
  const count = (status) => records.filter((record) => record.status === status).length;
  out(`passed: ${count('pass')} failed: ${count('fail')} skipped: ${count('skip')}; spent USD ${spent}`);
  out(`${artifacts.jsonl}\n${artifacts.log}`);
  const failed = records.some((record) => record.status === 'fail');
  const installed = INSTALLATION.every((step) => records.some((record) => record.id === step.id && record.status === 'pass'));
  await finish(context, flags.keep);
  return { code: failed || !installed ? 1 : 0, records, artifacts, budget, stopped };
}
