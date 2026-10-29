// The optional Windows step: let the current user run PowerShell scripts. It asks only when the
// effective execution policy blocks scripts, never when a group policy decides, and never changes
// anything without an explicit yes (the question, or --set-execution-policy).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const SCOPES = ['MachinePolicy', 'UserPolicy', 'Process', 'CurrentUser', 'LocalMachine'];
const GROUP = ['MachinePolicy', 'UserPolicy'];
const BLOCKING = new Set(['Restricted', 'AllSigned', 'Undefined']);
const LIST = "Get-ExecutionPolicy -List | ForEach-Object { '{0}={1}' -f $_.Scope, $_.ExecutionPolicy }";

/** `Scope=Policy` lines to [[scope, policy]]. */
export function parsePolicies(stdout) {
  return String(stdout).split(/\r?\n/).map((line) => /^(\w+)=(\w+)$/.exec(line.trim())).filter(Boolean).map((match) => [match[1], match[2]]);
}

/** The effective policy is the first scope, in PowerShell's order, that is not Undefined. */
export function judgePolicy(list) {
  const by = Object.fromEntries(list);
  const set = (scope) => by[scope] && by[scope] !== 'Undefined';
  const effective = SCOPES.find(set);
  const policy = effective ? by[effective] : 'Undefined';
  return { effective: policy, blocked: BLOCKING.has(policy), group: GROUP.some(set) };
}

/**
 * @param {object} ui the presenter
 * @param {object} flags the flags of the run
 * @param {object} deps `platform`, `tty`, `read`, `env`, `config` and, for tests, `policyExecute`
 */
export async function executionPolicyStep(ui, flags, deps) {
  const { config } = deps;
  if (deps.platform !== config.windowsPlatform || deps.dryRun || flags['no-execution-policy']) return;
  const shell = (args) => (deps.policyExecute ?? execute)(config.path.windowsExecutable, ['-NoProfile', '-NonInteractive', '-Command', ...args], { env: deps.env });
  const label = ui.text('policy');
  let judged;
  try { judged = judgePolicy(parsePolicies((await shell([LIST])).stdout)); }
  catch (error) { ui.detail(`${label}: ${error.message}`); return; }
  if (!judged.blocked) return;
  if (judged.group) return ui.row(label, 'skipped', ui.text('policyGroup'));
  const set = 'Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned';
  const undo = 'Set-ExecutionPolicy -Scope CurrentUser Undefined';
  if (!flags['set-execution-policy']) {
    if (!deps.tty) return ui.row(label, 'skipped', ui.text('policyHow', { command: set }));
    const accepted = await ui.confirm(deps.read, { explain: [ui.text('policyExplain'), ui.text('policyUndo', { command: undo })],
      question: ui.text('policyAsk'), defaultYes: false });
    if (!accepted) return ui.row(label, 'skipped', ui.text('policyDeclined', { command: set }));
  }
  ui.detail(set);
  try {
    await shell([`${set} -Force`]);
    return ui.row(label, 'ok', ui.text('policySet'));
  } catch (error) {
    return ui.row(label, 'skipped', ui.text('policyFailed', { reason: error.message }));
  }
}
