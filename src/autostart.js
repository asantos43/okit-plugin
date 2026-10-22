// Autostart plans: the ways an OS starts a program at login. A plan is a pure
// value — the file it writes, its content and the commands that install or
// remove it — so `okit autostart show` can print the whole plan before a single
// command runs, and a test can assert it without touching the machine.

import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { stateRoot } from './store.js';

export const AUTOSTART_KINDS = ['systemd', 'cron', 'launchd', 'schtasks'];

const SERVICE_NAME = 'okit-daemon.service';
const LABEL = 'com.okit.daemon';
const TASK_NAME = 'okit-daemon';
const MARKER = '# okit-daemon';

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
  };
}

// Windows paths are stored with forward slashes, the form the clients
// substitute (`docs/ARCHITECTURE.md` section 6).
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
  const { node, script, root, home } = settings(options);
  const path = join(home, '.config', 'systemd', 'user', SERVICE_NAME);
  const content = [
    '[Unit]',
    'Description=okit daemon',
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
 * crontab of that user and `okit autostart show` prints it before anything runs.
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