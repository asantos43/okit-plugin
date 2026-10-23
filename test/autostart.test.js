import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  AUTOSTART_KINDS, applyAutostart, autostartPlan, cronPlan, detectAutostart,
  launchdPlan, schtasksPlan, systemdPlan,
} from '../src/autostart.js';

// A machine that is not this one: the plans are pure, so every path in them is
// the one these options ask for.
const OPTIONS = {
  node: '/usr/bin/node',
  script: '/repo/src/cli.js',
  root: '/home/u/.okwork',
  home: '/home/u',
};
const WINDOWS = { node: 'C:\\tools\\node.exe', script: 'C:\\repo\\src\\cli.js' };

const command = (plan, action) => plan[action].map(({ command, args }) => [command, ...args].join(' '));

// Every plan builds its path with `join`, so the expectation is spelled with
// `join` too: the fake home is posix-shaped on purpose (it is a string, not a
// real machine), but `join` still separates with `\` on Windows.
const SERVICE = 'okit-daemon.service';
const PLIST = 'com.okit.daemon.plist';
const CRON = 'okit-daemon.cron';
const unitPath = join('/home/u', '.config', 'systemd', 'user', SERVICE);
const cronPath = join('/home/u', '.okwork', 'autostart', CRON);
const plistPath = join('/home/u', 'Library', 'LaunchAgents', PLIST);
const daemonOut = join('/home/u', '.okwork', 'logs', 'daemon.out');

test('the systemd plan writes a user unit and enables it', () => {
  const plan = systemdPlan(OPTIONS);
  assert.equal(plan.kind, 'systemd');
  assert.equal(plan.path, unitPath);
  assert.match(plan.content, /^ExecStart="\/usr\/bin\/node" "\/repo\/src\/cli\.js" daemon start$/m);
  assert.match(plan.content, /^WorkingDirectory=\/home\/u\/\.okwork$/m);
  assert.match(plan.content, /^WantedBy=default\.target$/m);
  assert.ok(plan.content.endsWith('\n'));
  assert.ok(!plan.content.includes('\r'), 'one newline style only');
  assert.deepEqual(command(plan, 'install'), [
    'systemctl --user daemon-reload',
    'systemctl --user enable --now okit-daemon.service',
  ]);
  assert.deepEqual(command(plan, 'uninstall'), [
    'systemctl --user disable --now okit-daemon.service',
    `rm -f ${unitPath}`,
  ]);
});

test('the cron plan is one @reboot line inside the state root', () => {
  const plan = cronPlan(OPTIONS);
  assert.equal(plan.path, cronPath);
  assert.equal(plan.content, '@reboot "/usr/bin/node" "/repo/src/cli.js" daemon start'
    + ` >> "${daemonOut}" 2>&1 # okit-daemon\n`);
  assert.deepEqual(command(plan, 'install'), [`crontab ${cronPath}`]);
  assert.deepEqual(command(plan, 'uninstall'), ['crontab -r']);
});

test('the launchd plan is a com.okit.daemon agent with arguments, not a command string', () => {
  const plan = launchdPlan(OPTIONS);
  assert.equal(plan.path, plistPath);
  assert.match(plan.content, /<key>Label<\/key>\n  <string>com\.okit\.daemon<\/string>/);
  assert.match(plan.content, /<key>ProgramArguments<\/key>\n  <array>\n    <string>\/usr\/bin\/node<\/string>\n    <string>\/repo\/src\/cli\.js<\/string>\n    <string>daemon<\/string>\n    <string>start<\/string>\n  <\/array>/);
  assert.match(plan.content, /<key>RunAtLoad<\/key>\n  <true\/>/);
  assert.ok(plan.content.endsWith('</plist>\n'));
  assert.deepEqual(command(plan, 'install'),
    [`launchctl load -w ${plistPath}`]);
  assert.deepEqual(command(plan, 'uninstall'), [
    `launchctl unload -w ${plistPath}`,
    `rm -f ${plistPath}`,
  ]);
});

test('a path with XML characters cannot break the plist', () => {
  const plan = launchdPlan({ ...OPTIONS, script: '/repo/a&b/<cli>.js' });
  assert.ok(plan.content.includes('<string>/repo/a&amp;b/&lt;cli&gt;.js</string>'));
  assert.ok(!plan.content.includes('a&b/<'));
});

test('the schtasks plan keeps Windows paths with forward slashes and writes no file', () => {
  const plan = schtasksPlan(WINDOWS);
  assert.equal(plan.path, null);
  assert.equal(plan.content, '"C:/tools/node.exe" "C:/repo/src/cli.js" daemon start');
  assert.deepEqual(plan.install, [{
    command: 'schtasks',
    args: ['/Create', '/SC', 'ONLOGON', '/TN', 'okit-daemon', '/TR', plan.content, '/F'],
  }]);
  assert.deepEqual(plan.uninstall,
    [{ command: 'schtasks', args: ['/Delete', '/TN', 'okit-daemon', '/F'] }]);
});

test('detectAutostart picks the plan of the platform and refuses nothing else', () => {
  assert.equal(detectAutostart('linux'), 'systemd');
  assert.equal(detectAutostart('darwin'), 'launchd');
  assert.equal(detectAutostart('win32'), 'schtasks');
  assert.equal(detectAutostart('freebsd'), 'cron');
  for (const kind of AUTOSTART_KINDS) assert.equal(typeof detectAutostart(kind), 'string');
});

test('autostartPlan returns each kind and refuses an unknown one', () => {
  for (const kind of AUTOSTART_KINDS) {
    const plan = autostartPlan(kind, OPTIONS);
    assert.equal(plan.kind, kind);
    assert.equal(typeof plan.content, 'string');
    assert.ok(Array.isArray(plan.install) && plan.install.length > 0);
    assert.ok(Array.isArray(plan.uninstall) && plan.uninstall.length > 0);
  }
  assert.throws(() => autostartPlan('upstart', OPTIONS),
    { name: 'TypeError', message: /Unknown autostart kind "upstart"/ });
  assert.throws(() => autostartPlan(undefined, OPTIONS), { name: 'TypeError' });
});

test('applyAutostart writes the file and runs the commands through the injected run', async () => {
  const events = [];
  const plan = systemdPlan(OPTIONS);
  const result = await applyAutostart(plan, {
    action: 'install',
    write: async (path, content) => {
      events.push(['write', path, content]);
      return path;
    },
    run: async (command) => {
      events.push(['run', command.command, command.args]);
      return { ok: true };
    },
  });

  assert.equal(result.action, 'install');
  assert.equal(result.wrote, plan.path);
  assert.deepEqual(events.map(([kind]) => kind), ['write', 'run', 'run']);
  assert.equal(events[0][1], plan.path);
  assert.equal(events[0][2], plan.content);
  assert.equal(result.ran.length, 2);
});

test('uninstalling runs the removal commands and writes nothing', async () => {
  const events = [];
  const result = await applyAutostart(launchdPlan(OPTIONS), {
    action: 'uninstall',
    write: async (path) => events.push(['write', path]),
    run: async ({ command, args }) => events.push(['run', command, args]),
  });
  assert.equal(result.wrote, null);
  assert.deepEqual(events.map(([kind]) => kind), ['run', 'run']);
});

test('a plan with no file, such as a scheduled task, only runs its commands', async () => {
  const events = [];
  const result = await applyAutostart(schtasksPlan(WINDOWS), {
    action: 'install',
    write: async (path) => events.push(['write', path]),
    run: async ({ command }) => events.push(['run', command]),
  });
  assert.equal(result.wrote, null);
  assert.deepEqual(events, [['run', 'schtasks']]);
});

test('applyAutostart needs a run and a known action', async () => {
  const plan = cronPlan(OPTIONS);
  await assert.rejects(() => applyAutostart(plan, {}), { name: 'TypeError', message: /run function/ });
  await assert.rejects(() => applyAutostart(plan, { run: async () => ({}), action: 'enable' }),
    { name: 'TypeError', message: /Unknown action "enable"/ });
});