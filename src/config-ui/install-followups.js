import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readJson } from '../state.js';
import { configOf } from '../profiles.js';
import { configMtime, configSetMany } from '../core/config.js';
import { confirmedModels, detectClients, profileEfforts } from '../env/models.js';
import { installConfig, installPaths, homeOf, renderName } from '../install/config.js';
import { discoverRecords } from '../install/place.js';
import { panelProposal, panelCommand } from '../install/panel.js';
import { executionPolicyStep, judgePolicy, parsePolicies, POLICY_LIST } from '../install/policy.js';

/** Server-owned proposals. The browser supplies choices, never paths/argv/file bodies.
 * Setup uses the same locked batch writer/mtime and confirmed-model rule as config UI.
 * It deliberately leaves setup.done to runSetup, which owns completion evidence.
 */
export async function prepareFollowup(input, ctx, io, fail) {
  const nativeRun = ctx.run;
  const run = async (request) => {
    const result = await nativeRun(request);
    if (result?.code !== undefined && result.code !== 0) {
      io.ui.detail([result.stdout, result.stderr].filter(Boolean).join('\n'));
      throw fail(409, 'Install preview is incomplete; review again.');
    }
    return result;
  };
  ctx = { ...ctx, run };
  const raw = await readJson(join(ctx.root, 'config.json'), {});
  const config = configOf(raw);
  const expectedMtime = await configMtime(ctx.root);
  if (input.kind === 'setup') {
    return setupProposal(input, ctx, io, fail, config, expectedMtime);
  }
  const installed = installConfig(raw.install);
  if (input.kind === 'policy') return policyFollowup({ ...io, ...ctx, ui: io.ui, config: installed }, fail);
  const paths = installPaths(installed, { ...ctx, home: homeOf(ctx.env, ctx.platform) });
  const found = await discoverRecords(paths.destination, { fs: ctx.fs, config: installed });
  const record = found.records[input.client];
  if (!record) throw fail(409, 'stale-plan');
  const deps = { ...io, ...ctx, ui: io.ui, config: installed, destination: found.destination };
  return panelFollowup(input, record, deps, fail);
}

async function setupProposal(input, ctx, io, fail, config, expectedMtime) {
  if (input.expectedMtime !== expectedMtime) throw fail(409, 'stale-plan');
  const observed = await (io.detectClients ?? detectClients)({ config, env: ctx.env,
    run: ctx.run, adapters: io.setupAdapters ?? io.adapters, onlyClient: input.client });
  const reading = observed.clients.find((entry) => entry.client === input.client);
  const models = confirmedModels(config, input.client, reading, reading?.installed);
  const changes = input.profiles.flatMap((profile) => {
    if (!config.profiles[input.client]?.[profile.class] || !profileEfforts(input.client).includes(profile.effort)) {
      throw fail(400, 'Invalid install request.');
    }
    if (!models.includes(profile.model) && profile.confirm !== true) {
      throw fail(422, 'Model is not confirmed by the client; confirm this change explicitly.');
    }
    return ['model', 'effort'].map((key) => ({ path: `profiles.${input.client}.${profile.class}.${key}`,
      value: profile[key], ...(profile.confirm ? { confirm: true } : {}) }));
  });
  const preview = { kind: 'setup', client: input.client, path: join(ctx.root, 'config.json'), expectedMtime,
    changes: changes.map((change) => ({ ...change,
      before: config.profiles[input.client][change.path.split('.')[2]][change.path.split('.')[3]] })) };
  return { preview, fingerprint: { expectedMtime, models },
    execute: async (checkpoint) => {
      checkpoint('setup-save');
      const result = await (io.saveSetup ?? configSetMany)(ctx.root, changes, { expectedMtime });
      if (result.conflict) throw fail(409, 'stale-plan');
      checkpoint(null);
      return result;
    } };
}

function panelFollowup(input, record, deps, fail) {
  if (input.client !== 'claude-code' || record.defaultRegistered === false) throw fail(400, 'Invalid install request.');
  const proposal = panelProposal(record, {}, deps);
  const recordPath = join(deps.destination, renderName({ template: deps.config.recordName,
    values: { client: input.client } }));
  return { preview: { kind: 'panel', client: input.client, scope: 'user',
    command: proposal?.command ?? deps.config.clients['claude-code'].executable,
    args: proposal?.args ?? [], skipped: !proposal,
    writes: [{ kind: 'client-plugin-registration', scope: 'user' },
      { kind: 'installation-record', path: recordPath }, { kind: 'record-temporary', path: `${recordPath}.tmp` }],
    observation: { command: deps.config.clients['claude-code'].executable,
      args: ['plugin', 'list', '--json'], decision: { present: 'skip', absent: 'install', invalid: 'refuse' } } },
  fingerprint: structuredClone(record),
  execute: async (checkpoint) => {
    checkpoint('panel');
    const code = await panelCommand('install', record, deps);
    if (code !== 0) throw fail(409, 'Install preview is incomplete; review again.');
    checkpoint(null);
    return { state: proposal ? 'ok' : 'skipped' };
  } };
}

export const sameFollowup = (left, right) => isDeepStrictEqual(left.preview, right.preview)
  && isDeepStrictEqual(left.fingerprint, right.fingerprint);

async function policyFollowup(deps, fail) {
  if (deps.platform !== deps.config.windowsPlatform) throw fail(400, 'Invalid install request.');
  const command = deps.config.path.windowsExecutable;
  const args = ['-NoProfile', '-NonInteractive', '-Command', POLICY_LIST];
  const policyExecute = deps.policyExecute ?? (async (program, argv) => deps.run({ command: program, args: argv }));
  const before = parsePolicies((await policyExecute(command, args, { env: deps.env })).stdout);
  if (!before.length) throw fail(409, 'Install preview is incomplete; review again.');
  const judged = judgePolicy(before);
  return { preview: { kind: 'policy', scope: 'CurrentUser', before,
    after: 'RemoteSigned', skipped: !judged.blocked || judged.group, command,
    args: ['-NoProfile', '-NonInteractive', '-Command',
      'Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force'] },
  fingerprint: before,
  execute: async (checkpoint) => {
    checkpoint('policy');
    let failure;
    const checkedExecute = async (...args) => {
      try { return await policyExecute(...args); }
      catch (error) { failure = error; throw error; }
    };
    await executionPolicyStep(deps.ui, { 'set-execution-policy': true }, { ...deps, policyExecute: checkedExecute });
    if (failure) throw failure;
    checkpoint(null);
    return { state: !judged.blocked || judged.group ? 'skipped' : 'ok' };
  } };
}
