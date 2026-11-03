import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  AUTOSTART_KINDS, autostartPresent, autostartExists, taskPresent, cronPresent, applyAutostart, autostartPlan, autostartQuery, cronPlan, detectAutostart,
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

// The query that asks the machine whether the autostart of the kind is enabled: a read-only command
// of the tool of the kind, with an argv and never a shell string.

test('the query of each kind asks the tool of the kind, with an argv of its own', () => {
  assert.deepEqual(autostartQuery(systemdPlan(OPTIONS)),
    { command: 'systemctl', args: ['--user', 'is-enabled', 'okit-daemon.service'] });
  assert.deepEqual(autostartQuery(cronPlan(OPTIONS)), { command: 'crontab', args: ['-l'] });
  assert.deepEqual(autostartQuery(launchdPlan(OPTIONS)), { command: 'launchctl', args: ['list', 'com.okit.daemon'] });
  // The scheduled task of Windows is asked with its own query (the task of the scheduler).
  assert.equal(autostartQuery(schtasksPlan(WINDOWS)), null);
  assert.equal(autostartQuery({ kind: 'upstart' }), null);
  assert.equal(autostartQuery(undefined), null);
});

test('the query of the kind never names a shell and never holds a path of the plan', () => {
  for (const kind of AUTOSTART_KINDS) {
    const query = autostartQuery(autostartPlan(kind, OPTIONS));
    if (!query) continue;
    assert.equal(typeof query.command, 'string');
    assert.ok(Array.isArray(query.args), `${kind}: the argv is a list`);
    for (const word of query.args) assert.equal(typeof word, 'string', `${kind}: every word is text`);
    assert.doesNotMatch(query.args.join(' '), /[;&|`]/, `${kind}: no shell syntax`);
  }
});
// Query output fixtures: successful process execution alone does not establish login readiness.
const TASK_READY = '<?xml version="1.0" encoding="UTF-16"?>\n<Task><Settings><Enabled>true</Enabled></Settings></Task>\n';
const TASK_DISABLED = TASK_READY.replace('<Enabled>true</Enabled>', '<Enabled>false</Enabled>');
const TASK_PORTUGUESE = TASK_READY.replace('<Settings>', '<RegistrationInfo><Description>Inicialização automática: Pronto / Em execução</Description></RegistrationInfo><Settings>');
const LAUNCHD_LOADED = '{\n "Label" = "com.okit.daemon";\n "PID" = 123;\n};\n';
const LAUNCHD_DISABLED = '{\n "com.okit.daemon" => true\n}\n';
const LAUNCHD_ENABLED = '{\n "com.okit.daemon" => false\n}\n';

for (const [name, stdout, present] of [
  ['enabled XML', TASK_READY, true],
  ['disabled XML', TASK_DISABLED, false],
  ['disabled XML with mixed case and whitespace', TASK_READY.replace('<Enabled>true</Enabled>', '<eNaBlEd > \n FaLsE \n </EnAbLeD >'), false],
  ['Portuguese output', TASK_PORTUGUESE, true],
  ['implicit enablement', '<Task><Settings/></Task>', true],
]) {
  test(`Windows readiness parses ${name} independently of language`, async () => {
    for (const code of [0, undefined]) {
      const calls = [];
      const run = async (query) => { calls.push(query); return { code, stdout }; };
      assert.equal(await taskPresent(run, 123), present);
      assert.deepEqual(calls, [{ command: 'schtasks', args: ['/Query', '/TN', 'okit-daemon', '/XML'], timeoutMs: 123 }]);
      assert.equal(await autostartPresent(schtasksPlan(WINDOWS), { run }), present);
      assert.equal(await autostartExists(schtasksPlan(WINDOWS), { run }), true);
      assert.deepEqual(calls.slice(1), [
        { command: 'schtasks', args: ['/Query', '/TN', 'okit-daemon', '/XML'], timeoutMs: undefined },
        { command: 'schtasks', args: ['/Query', '/TN', 'okit-daemon'], timeoutMs: undefined },
      ]);
    }
  });
}

test('Windows readiness and existence require a successful XML query', async () => {
  for (const run of [undefined, async () => ({ code: 1, stdout: TASK_READY }), async () => { throw new Error('query failed'); }]) {
    assert.equal(await taskPresent(run), false);
    assert.equal(await autostartExists(schtasksPlan(WINDOWS), { run }), false);
  }
});

for (const stdout of ['disabled\n', 'static\n', 'enabled-runtime\n', 'masked\n', '']) {
  test(`systemd ${JSON.stringify(stdout)} is not login readiness even with exit zero`, async () => {
    const plan = systemdPlan(OPTIONS);
    assert.equal(await autostartPresent(plan, { fs: { readFile: async () => plan.content }, run: async () => ({ code: 0, stdout }) }), false);
  });
}

test('systemd requires persistent enablement; a machine without the tool of the query lets the file decide', async () => {
  const plan = systemdPlan(OPTIONS), fs = { readFile: async () => plan.content };
  assert.equal(await autostartPresent(plan, { fs, run: async () => ({ stdout: 'enabled\n' }) }), true);
  assert.equal(await autostartPresent(plan, { fs }), true);
  assert.equal(await autostartPresent(plan, { fs, run: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } }), true);
  assert.equal(await autostartPresent(plan, { fs, run: async () => { throw Object.assign(new Error('no'), { code: 1 }); } }), false);
  assert.equal(await autostartExists(plan, { fs }), true);
});

test('launchd requires a loaded current agent without a disabled login override', { skip: typeof process.getuid !== 'function' }, async () => {
  const plan = launchdPlan(OPTIONS), fs = { readFile: async () => plan.content };
  for (const [override, expected] of [
    [LAUNCHD_DISABLED, false], [LAUNCHD_DISABLED.replace('true', 'disabled'), false],
    [LAUNCHD_ENABLED, true], [LAUNCHD_ENABLED.replace('false', 'enabled'), true],
    ['{\n "another.agent" => disabled\n}\n', true],
  ]) {
    const calls = [];
    assert.equal(await autostartPresent(plan, { fs, run: async (query) => {
      calls.push(query);
      return { code: 0, stdout: query.args[0] === 'list' ? LAUNCHD_LOADED : override };
    } }), expected, override);
    assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [
      { command: 'launchctl', args: ['list', 'com.okit.daemon'] },
      { command: 'launchctl', args: ['print-disabled', `gui/${process.getuid()}`] },
    ]);
  }
  assert.equal(await autostartPresent(plan, { fs, run: async () => ({ code: 1, stdout: 'Could not find service' }) }), false);
  assert.equal(await autostartPresent(plan, { fs }), true);
  assert.equal(await autostartExists(plan, { fs }), true);
});

test('cron readiness matches the whole current line without relying on a spool file', async () => {
  const plan = cronPlan(OPTIONS);
  const missingFile = { readFile: async () => { throw new Error('no spool file'); } };
  for (const stdout of ['# okit-daemon\n', plan.content.replace('/usr/bin/node', '/old/node'),
    plan.content.replace('/repo/src/cli.js', '/old/cli.js'), `# ${plan.content}`, '']) {
    assert.equal(await autostartPresent(plan, { fs: missingFile, run: async () => ({ stdout }) }), false, stdout);
  }
  const calls = [];
  const run = async (query) => { calls.push(query); return { code: 0, stdout: `0 * * * * /other/job\n${plan.content}` }; };
  assert.equal(await cronPresent(plan, run, 456), true);
  assert.deepEqual(calls, [{ command: 'crontab', args: ['-l'], timeoutMs: 456 }]);
  assert.equal(await autostartPresent(plan, { fs: missingFile, run }), true);
  assert.equal(await autostartPresent({ ...plan, path: null }, { run }), true);
  assert.equal(await cronPresent(plan, async () => ({ code: 1, stdout: plan.content })), false);
  assert.equal(await cronPresent(plan, async () => { throw new Error('missing tool'); }), false);
  assert.equal(await cronPresent(plan), false);
});

test('absoluteNode accepts platform paths and replaces PATH-dependent node names', async () => {
  const { absoluteNode } = await import('../src/autostart.js');
  for (const node of [undefined, 'node', './node', 'bin/node']) assert.equal(absoluteNode(node, 'linux'), process.execPath);
  assert.equal(absoluteNode('/opt/node', 'linux'), '/opt/node');
  assert.equal(absoluteNode('C:\\Program Files\\node.exe', 'win32'), 'C:\\Program Files\\node.exe');
  assert.equal(absoluteNode('C:node.exe', 'win32'), process.execPath);
});

test('legacy script recovery uses only the installed metadata', async () => {
  const { installationScript } = await import('../src/autostart.js');
  for (const metadata of [undefined, '{', '{}', '{"bin":{"okit-plugin":""}}', '{"bin":{"okit-plugin":true}}']) {
    const reads = [];
    const script = await installationScript({ path: '/payload' }, { command: 'okit-plugin', readText: async (path) => {
      reads.push(path);
      if (path !== '/payload/package.json') return JSON.stringify({ bin: { 'okit-plugin': 'src/cli.js' } });
      if (metadata === undefined) throw new Error('unreadable');
      return metadata;
    } });
    assert.equal(script, null);
    assert.deepEqual(reads, ['/payload/package.json']);
  }
});

test('usableNode passes platform access modes and checks the file through its seams', async () => {
  const { constants } = await import('node:fs');
  const { usableNode } = await import('../src/autostart.js');
  for (const [platform, node, mode] of [['linux', '/saved/node', constants.X_OK], ['win32', 'C:/saved/node.exe', constants.F_OK]]) {
    const calls = [];
    assert.equal(await usableNode(node, platform, async (...args) => { calls.push(args); }, async (path) => {
      assert.equal(path, node);
      return { isFile: () => true };
    }), node);
    assert.deepEqual(calls, [[node, mode]]);
  }
});

test('an installed script that is missing, empty or only whitespace is not a script', async () => {
  const { installationScript } = await import('../src/autostart.js');
  for (const content of ['', '  \n\t', undefined]) {
    const script = await installationScript({ path: '/payload', bin: 'src/cli.js' }, { command: 'okit-plugin', readText: async () => {
      if (content === undefined) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return content;
    } });
    assert.equal(script, null, JSON.stringify(content));
  }
  assert.equal(await installationScript({ path: '/payload', bin: 'src/cli.js' }, { command: 'okit-plugin', readText: async () => '// cli' }), join('/payload', 'src/cli.js'));
});
