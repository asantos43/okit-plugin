// Autostart plans: the ways an OS starts a program at login. A plan is a pure
// value — the file it writes, its content and the commands that install or
// remove it — so `okit-plugin autostart show` can print the whole plan before a single
// command runs, and a test can assert it without touching the machine.

import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { stateRoot } from './store.js';
import { DEFAULT_CONFIG } from './profiles.js';

export const AUTOSTART_KINDS = ['systemd', 'cron', 'launchd', 'schtasks'];

// The names the machine knows the autostart by: the unit file of systemd, the label of
// launchd and the marker the line of the crontab carries. They are exported because the
// doctor asks the machine about them (the query of `autostartQuery`).
export const SERVICE_NAME = 'okit-daemon.service';
export const LABEL = 'com.okit.daemon';
export const MARKER = '# okit-daemon';
const TASK_NAME = 'okit-daemon';

// The OS starts the CLI, so every plan points at this file.
const CLI_PATH = fileURLToPath(new URL('./cli.js', import.meta.url));

// Everything a plan needs is injectable, so a test can assert the exact output
// on a machine that is not the one the plan would be installed on.
function settings(options = {}) {
  return {
    node: options.node ?? process.execPath,
    script: options.script ?? CLI_PATH,
    root: options.root ?? stateRoot(),
    home: options.home ?? homedir(),
    command: options.command ?? DEFAULT_CONFIG.install.command,
  };
}

// Windows paths are stored with forward slashes, the form the clients
// substitute (`docs/maintainers/ARCHITECTURE.md` section 6).
const winPath = (value) => value.replaceAll('\\', '/');
const quoted = (value) => `"${value}"`;

/**
 * A user systemd unit: the daemon loop is the foreground process of the unit,
 * so the unit restarts it when it dies and starts it at the default target.
 *
 * @returns {{kind: string, path: string, content: string,
 *   install: object[], uninstall: object[]}}
 */
export function systemdPlan(options = {}) {
  const { node, script, root, home, command } = settings(options);
  const path = join(home, '.config', 'systemd', 'user', SERVICE_NAME);
  const content = [
    '[Unit]',
    `Description=${command} daemon`,
    'After=default.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${quoted(node)} ${quoted(script)} daemon start`,
    'Restart=on-failure',
    'RestartSec=10',
    `WorkingDirectory=${root}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');

  return {
    kind: 'systemd',
    path,
    content,
    install: [
      { command: 'systemctl', args: ['--user', 'daemon-reload'] },
      { command: 'systemctl', args: ['--user', 'enable', '--now', SERVICE_NAME] },
    ],
    uninstall: [
      { command: 'systemctl', args: ['--user', 'disable', '--now', SERVICE_NAME] },
      { command: 'rm', args: ['-f', path] },
    ],
  };
}

// launchd reads an XML property list; the arguments are elements, never a
// command string, so a path with a space or a quote cannot break the plist.
function escapeXml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * A launchd agent in `~/Library/LaunchAgents`, loaded at login and kept alive.
 *
 * @returns {{kind: string, path: string, content: string,
 *   install: object[], uninstall: object[]}}
 */
export function launchdPlan(options = {}) {
  const { node, script, root, home } = settings(options);
  const path = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const arg = (value, indent = '') => `${indent}  <string>${escapeXml(value)}</string>`;
  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    arg(LABEL),
    '  <key>ProgramArguments</key>',
    '  <array>',
    arg(node, '  '),
    arg(script, '  '),
    arg('daemon', '  '),
    arg('start', '  '),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    arg(root),
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');

  return {
    kind: 'launchd',
    path,
    content,
    install: [{ command: 'launchctl', args: ['load', '-w', path] }],
    uninstall: [
      { command: 'launchctl', args: ['unload', '-w', path] },
      { command: 'rm', args: ['-f', path] },
    ],
  };
}

/**
 * A `@reboot` crontab line, the fallback where there is no unit file. `crontab`
 * has no per-line removal without a shell pipeline, so the plan owns the whole
 * crontab of that user and `okit-plugin autostart show` prints it before anything runs.
 *
 * @returns {{kind: string, path: string, content: string,
 *   install: object[], uninstall: object[]}}
 */
export function cronPlan(options = {}) {
  const { node, script, root } = settings(options);
  const path = join(root, 'autostart', `${TASK_NAME}.cron`);
  const log = join(root, 'logs', 'daemon.out');
  const content = `@reboot ${quoted(node)} ${quoted(script)} daemon start >> ${quoted(log)} 2>&1 ${MARKER}\n`;

  return {
    kind: 'cron',
    path,
    content,
    install: [{ command: 'crontab', args: [path] }],
    uninstall: [{ command: 'crontab', args: ['-r'] }],
  };
}

/**
 * A Task Scheduler task that starts the daemon at every logon. The scheduler
 * keeps the task, so nothing is written to disk: `content` is the command line
 * the task runs, with forward-slash paths.
 *
 * @returns {{kind: string, path: null, content: string,
 *   install: object[], uninstall: object[]}}
 */
export function schtasksPlan(options = {}) {
  const { node, script } = settings(options);
  const task = `${quoted(winPath(node))} ${quoted(winPath(script))} daemon start`;

  return {
    kind: 'schtasks',
    path: null,
    content: task,
    install: [{ command: 'schtasks', args: ['/Create', '/SC', 'ONLOGON', '/TN', TASK_NAME, '/TR', task, '/F'] }],
    uninstall: [{ command: 'schtasks', args: ['/Delete', '/TN', TASK_NAME, '/F'] }],
  };
}

const PLANS = {
  systemd: systemdPlan,
  cron: cronPlan,
  launchd: launchdPlan,
  schtasks: schtasksPlan,
};

/**
 * The plan of one autostart kind. Pure: it decides, it never acts.
 *
 * @param {'systemd'|'cron'|'launchd'|'schtasks'} kind
 * @param {{node?: string, script?: string, root?: string, home?: string}} [options]
 * @returns {{kind: string, path: string|null, content: string,
 *   install: object[], uninstall: object[]}}
 * @throws {TypeError} on a kind with no plan
 */
export function autostartPlan(kind, options = {}) {
  const plan = typeof kind === 'string' ? PLANS[kind] : undefined;
  if (plan === undefined) {
    throw new TypeError(`Unknown autostart kind ${JSON.stringify(kind)}: expected ${AUTOSTART_KINDS.join(', ')}`);
  }
  return plan(options);
}

/**
 * The read-only query that asks the machine whether the autostart of this kind is enabled.
 *
 * Pure: it decides which command answers and with which words, it never runs it. The argv
 * is a list of words, never a shell string, so a path with a space cannot become syntax.
 *
 * @param {object} plan the value `autostartPlan` returned
 * @returns {{command: string, args: string[]}|null} the query of the kind, or null when the
 * kind has none (the scheduled task of Windows is asked with its own query)
 */
export function autostartQuery(plan) {
  if (plan?.kind === 'systemd') return { command: 'systemctl', args: ['--user', 'is-enabled', SERVICE_NAME] };
  if (plan?.kind === 'cron') return { command: 'crontab', args: ['-l'] };
  if (plan?.kind === 'launchd') return { command: 'launchctl', args: ['list', LABEL] };
  return null;
}

/**
 * Whether the scheduled task of Windows is there: the one query, asked with its own argv (never a shell).
 *
 * The runner of the installer answers without a code when the command worked and throws when it did not, so a
 * task that is there is the call that returned with no code, or with the code zero. Read-only.
 *
 * @param {Function} [run] the runner of a process
 * @param {number} [timeoutMs] the deadline of the query
 * @returns {Promise<boolean>}
 */
export async function taskPresent(run, timeoutMs) {
  if (typeof run !== 'function') return false;
  try {
    const answer = await run({ command: 'schtasks', args: ['/Query', '/TN', TASK_NAME], timeoutMs });
    const code = answer?.code;
    return code === undefined || code === 0;
  } catch {
    return false;
  }
}

/**
 * Whether the autostart of this machine is really there.
 *
 * It proves the thing works, not that a file exists:
 *
 * - the scheduled task of Windows is asked with its own argv (never a shell). The runner of the installer answers
 *   without a code when the command worked and throws when it did not: a task that is there is the call that returned
 *   with no code, or with the code zero.
 * - the other kinds are a file of the plan: it has to be there AND to hold the content of the plan (an empty, corrupt
 *   or stale file is not the autostart of this installation), and the query of the kind (the unit of systemd, the
 *   crontab of the user, the label of launchd) has to say that it is enabled. A machine without the tool of the
 *   query, or without a runner to ask it, is not a machine without an autostart: the file and its content decide
 *   then.
 *
 * The doctor and the last step of the setup ask the same question, so the answer is the same: a service that is
 * corrupt, stale or disabled is not there.
 *
 * @param {object} plan the plan of the autostart of this machine
 * @param {{fs: object, run?: Function, timeoutMs?: number}} deps the file system and the runner of a process
 * @returns {Promise<boolean>}
 */
export async function autostartPresent(plan, { fs, run, timeoutMs } = {}) {
  if (!plan) return false;
  if (plan.kind === 'schtasks') return taskPresent(run, timeoutMs);
  if (!plan.path) return false;
  // The file of the plan, with the content of the plan: an empty, corrupt or stale file is not the autostart of this
  // installation.
  const file = plan.path;
  const content = typeof fs?.readFile === 'function'
    ? await fs.readFile(file, 'utf8').catch(() => null)
    : null;
  if (content === null || content !== plan.content) return false;
  // The query of the kind: the machine itself says whether it is enabled.
  const query = autostartQuery(plan);
  if (!query || typeof run !== 'function') return true;
  try {
    const answer = await run({ command: query.command, args: query.args, timeoutMs });
    const code = answer?.code;
    if (code !== undefined && code !== null && code !== 0) return false;
    // The crontab of the user: the line of ours is the one that carries the marker of the plan.
    if (plan.kind === 'cron') return String(answer?.stdout ?? '').includes(MARKER);
    return true;
  } catch (error) {
    // The tool of the query is not on this machine (ENOENT), or the failure says nothing about whether the
    // autostart is enabled (no numeric code): the query is unknown and the file and its content decide.
    if (typeof error?.code !== 'number') return true;
    return false;
  }
}

/**
 * The kind this platform autostarts with: a user unit on Linux, a launchd agent
 * on macOS, a scheduled task on Windows and a crontab line anywhere else.
 *
 * @param {string} [platform] defaults to `process.platform`
 * @returns {'systemd'|'launchd'|'schtasks'|'cron'}
 */
export function detectAutostart(platform = process.platform) {
  if (platform === 'linux') return 'systemd';
  if (platform === 'darwin') return 'launchd';
  if (platform === 'win32') return 'schtasks';
  return 'cron';
}

// `\n` only, with an explicit encoding and no platform default, so a plan
// written on Windows reads the same on Linux.
async function writeContent(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
  return path;
}

/**
 * Acts on a plan: writes its file, then runs the commands of one action in
 * order through the injected `run`. Nothing is executed without it, and a plan
 * without a file (a scheduled task) only runs its commands.
 *
 * @param {object} plan the value `autostartPlan` returned
 * @param {{run: Function, write?: Function, action?: 'install'|'uninstall'}} options
 * @returns {Promise<{action: string, path: string|null, wrote: string|null, ran: object[]}>}
 * @throws {TypeError} without a `run`, or on an unknown action
 */
export async function applyAutostart(plan, { run, write = writeContent, action = 'install' } = {}) {
  if (typeof run !== 'function') throw new TypeError('applyAutostart needs a run function');
  if (action !== 'install' && action !== 'uninstall') {
    throw new TypeError(`Unknown action ${JSON.stringify(action)}: expected install, uninstall`);
  }

  // The file goes in first: systemd reloads and launchd loads need it there.
  const wrote = action === 'install' && plan.path !== null ? await write(plan.path, plan.content) : null;
  const commands = plan[action] ?? [];
  const ran = [];
  for (const command of commands) ran.push(await run(command));
  return { action, path: plan.path, wrote, ran };
}
