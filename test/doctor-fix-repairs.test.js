import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { autostartPlan, detectAutostart } from '../src/autostart.js';
import { shown } from '../src/install/mcp-register.js';
import { main } from '../src/cli.js';
import { exitCodeFor } from '../src/install/exit.js';
import { paths } from '../src/store.js';
import { fixture } from './helpers/install-fixture.js';

// D109 step 6a: a `Fix:` the doctor advertises is a `Fix:` that repairs the row. Every scenario below breaks one
// thing, runs the doctor, runs the command of the `Fix:` line of the row that failed, and asks the doctor again: the
// row that failed is gone and the summary has no failures.
//
// | scenario | the row that failed | the Fix |
// | the client holds no entry | MCP registration | the install of the client |
// | the client has the entry off | MCP registration | the install of the client |
// | the entry launches another program | MCP registration | the install of the client |
// | the server of the entry is gone | MCP registration | the install of the client |
// | the record of the client cannot be read | Installation record | the install of the client |
// | the legacy record cannot be read | Installation record | the install (of every client) |
// | the payload of the installation is gone | MCP registration | the install of the client |
// | the service of the machine is gone | Autostart | the autostart of the machine |
//
// The rows whose Fix is MANUAL by design are listed at the end: the doctor cannot repair them, and it says so.

const PACKAGE = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, '');
const SERVER = 'src/mcp/server.js';
const PROBE = 'src/mcp/selfcheck-probe.js';
const CLIENT = 'claude-code';

/** The row of the doctor that failed: its label, and the line of its Fix. */
const failedRow = (lines, label) => {
  if (!/^Needs attention: [1-9]\d* failed check/.test(lines[1] ?? '')) return null;
  const displayed = label.replace(': MCP registration', ' connection').replace('MCP registration', 'connection').replace('Daemon', 'Background service');
  const line = lines.find((line) => line.startsWith('| ') && line.includes(displayed));
  const fixes = lines.filter((line) => line.startsWith('Fix: '));
  const fix = label === 'Autostart' ? fixes.find((line) => / setup$/.test(line))
    : /record/i.test(label) ? fixes.find((line) => line.startsWith('Fix: Install it again:'))
      : fixes.find((line) => !/Remove the entry by hand|Automatic start is optional/.test(line));
  return line ? { line, fix } : null;
};

/** The command of a Fix line: the words after the name of the command, as the argv of the command line. */
const commandOf = (fix, name) => {
  const escapedNode = shown([process.execPath]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const installed = new RegExp(`${escapedNode} [^ \n]+/src/cli\\.js ((?:install|update|uninstall|autostart|daemon|doctor|setup)(?: [A-Za-z0-9_./=-]+)*)$`).exec(fix);
  if (installed) return installed[1].split(' ');
  const found = new RegExp(`(${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `
    + '(?:install|update|uninstall|autostart|daemon|doctor|setup)(?: [^\\n]*)?)$').exec(fix);
  return found ? found[1].split(' ').slice(1) : null;
};

/**
 * The world of a scenario: an installation that works (the record of a client, the server of ours, the entry of the
 * client registered, the state files readable and the daemon running).
 *
 * @param {object} t the test
 * @param {object} options the shape of the world
 * @returns {Promise<object>} the world: the fixture, the installation and the record
 */
async function world(t, { installation = true, record: given, legacy = null, autostart = false, entry = 'current', previous = false } = {}) {
  const f = await fixture(t);
  const path = join(f.destination, '1.0.0-claude-code');
  const record = given ?? { client: CLIENT, version: '1.0.0', path, bin: 'src/cli.js', autostart, link: false,
    linkDirectory: null, settings: { node: process.execPath },
    ...(previous ? { previous: { client: CLIENT, version: '0.9.0', path: join(f.destination, '0.9.0-claude-code'),
      bin: 'src/cli.js', settings: { node: process.execPath } } } : {}) };
  await fs.mkdir(f.destination, { recursive: true });
  if (installation) {
    await fs.mkdir(join(path, 'src', 'mcp'), { recursive: true });
    await fs.writeFile(join(path, 'package.json'), JSON.stringify({ name: 'sample', version: '1.0.0' }));
    await fs.writeFile(join(path, SERVER), '// fake MCP server\n');
    await fs.writeFile(join(path, PROBE), '// fake probe of the check\n');
    await fs.writeFile(join(f.destination, `install.${CLIENT}.json`), JSON.stringify(record));
    // The entry of the client, as the installer registered it: the server of this installation, or the one of the
    // installation it replaces.
    const server = entry === 'previous' ? join(record.previous.path, SERVER) : join(path, SERVER);
    await f.io.run({ command: f.io.config.clients[CLIENT].executable,
      args: ['mcp', 'add', 'okit', '--', f.io.config.node, server] });
  }
  if (legacy !== null) await fs.writeFile(join(f.destination, 'install.json'), legacy);
  // The daemon of the state root is running: its row is not a failure of the doctor.
  await fs.writeFile(join(f.root, 'daemon.pid.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  // The state files of the person: they are readable.
  await fs.writeFile(paths(f.root).inbox, '{"version":1,"seq":0,"items":[]}');
  await fs.writeFile(paths(f.root).orders, '{"version":1,"seq":0,"orders":[]}');
  return { f, path, record };
}

/**
 * The class of the fix: the doctor says what is wrong, the command of the `Fix:` line of the row that failed is
 * run, and the doctor is asked again: the row that failed is gone and the summary has no failures.
 *
 * @param {object} t the test
 * @param {Function} breakIt what breaks the world
 * @param {string} label the label of the row that has to fail
 * @param {object} [options] the shape of the world
 */
async function repaired(t, breakIt, label, options = {}) {
  const { f, path } = await world(t, options);
  const io = { ...f.io, detect: async (executable) => executable === f.io.config.clients[CLIENT].executable };
  await breakIt(f, io, path);
  f.clear();
  assert.equal(await main(['doctor'], io), exitCodeFor('operational'), `the doctor did not fail:\n${f.output.join('\n')}`);
  const row = failedRow(f.output, label);
  assert.ok(row, `the row ${label} did not fail:\n${f.output.join('\n')}`);
  assert.match(row.fix, /^Fix: /, `the row ${label} has no Fix:\n${f.output.join('\n')}`);
  const command = commandOf(row.fix, f.io.config.command);
  assert.ok(command, `the Fix of ${label} names no command: ${row.fix}`);
  // The command of the Fix, exactly as the doctor named it.
  f.clear();
  assert.equal(await main(command, io), exitCodeFor('ok'), `the Fix failed:\n${f.output.join('\n')}`);
  // The doctor again: the row that failed is gone and the summary has no failures.
  f.clear();
  assert.equal(await main(['doctor'], io), exitCodeFor('ok'), `the doctor still fails:\n${f.output.join('\n')}`);
  assert.ok(!failedRow(f.output, label), `the row ${label} is still there:\n${f.output.join('\n')}`);
  assert.match(f.output[1], /^Ready\.|^Needs attention: \d+ warnings?;/, f.output[1]);
}

/** The entry the client prints: ours, and broken in the way the scenario says. */
const entryOf = (node, server, status = null) => `okit:\n  Scope: User config (available in all your projects)\n`
  + `  Type: stdio\n${status === null ? '' : `  Status: ${status}\n`}  Command: ${node}\n  Args: ${server}\n`;

test('the Fix of a client that holds no MCP entry registers it again', async (t) => {
  await repaired(t, async (f) => {
    // The client holds no entry: the entry of the world is taken out.
    await f.io.run({ command: f.io.config.clients[CLIENT].executable, args: ['mcp', 'remove', 'okit', '--scope', 'user'] });
  }, 'MCP registration');
});

test('the Fix of an MCP entry the client has off registers it again', async (t) => {
  await repaired(t, async (f, io, path) => {
    // The client prints the entry with the status of an entry that is off. The entry is ours until the
    // installer writes it again: after that, the client prints the entry it holds.
    let broken = true;
    const off = entryOf(f.io.config.node, join(path, SERVER), '✘ Disabled');
    io.run = async (call) => {
      if (call.args?.[0] !== 'mcp') return f.io.run(call);
      if (call.args[1] === 'get' && broken) return { stdout: off };
      if (call.args[1] === 'add' || call.args[1] === 'remove') broken = false;
      return f.io.run(call);
    };
  }, 'MCP registration');
});

test('the Fix of an MCP entry that launches another program registers it again', async (t) => {
  await repaired(t, async (f, io, path) => {
    let broken = true;
    const other = entryOf('/other/node', join(path, SERVER));
    io.run = async (call) => {
      if (call.args?.[0] !== 'mcp') return f.io.run(call);
      if (call.args[1] === 'get' && broken) return { stdout: other };
      if (call.args[1] === 'add' || call.args[1] === 'remove') broken = false;
      return f.io.run(call);
    };
  }, 'MCP registration');
});

test('the Fix of an MCP entry whose server is gone registers it again', async (t) => {
  // The entry names the server of the installation it replaces, and that file is not on this machine: the entry
  // cannot work, and the install takes it out and writes it again.
  await repaired(t, async () => {}, 'MCP registration', { entry: 'previous', previous: true });
});

test('the Fix of a record that cannot be read installs that client again', async (t) => {
  await repaired(t, async (f) => {
    // The record of the client is not JSON: the doctor says it cannot be read.
    await fs.writeFile(join(f.destination, `install.${CLIENT}.json`), 'not json');
  }, 'Installation record');
});

test('the Fix of a legacy record that cannot be read installs again, without a client', async (t) => {
  await repaired(t, async (f) => {
    // The legacy record is not JSON: it belongs to no client, so the Fix names no client.
    await fs.writeFile(join(f.destination, 'install.json'), 'not json');
  }, 'Installation record', { installation: false });
});

test('the Fix of an installation whose payload is gone installs it again', async (t) => {
  await repaired(t, async (f, io, path) => {
    // The server of the installation is gone: the payload is not whole.
    await fs.rm(join(path, SERVER));
  }, 'MCP registration');
});

test('the Fix of a damaged legacy installation that names no folder installs it again', async (t) => {
  await repaired(t, async (f, io, path) => {
    // The record names neither the folder of the installation nor the folder of the records, and the server is gone.
    const file = join(f.destination, `install.${CLIENT}.json`);
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    delete record.path;
    delete record.destination;
    await fs.writeFile(file, JSON.stringify(record));
    await fs.rm(join(path, SERVER));
  }, 'MCP registration');
});

test('the Fix of an autostart that is not set up installs it again', async (t) => {
  // The installation that is running: the doctor and the `setup` of the command line build the same plan of the
  // autostart, so the file the Fix writes is the one the doctor looks for.
  const { f, io, files } = await autostartWorld(t);
  f.clear();
  assert.equal(await main(['doctor'], io), exitCodeFor('operational'), f.output.join('\n'));
  const row = failedRow(f.output, 'Autostart');
  assert.ok(row, `the autostart did not fail:\n${f.output.join('\n')}`);
  assert.match(row.fix, /the setup offers the autostart step/, row.fix);
  // The command of the Fix is the setup: it is the one that installs the autostart.
  assert.deepEqual(commandOf(row.fix, f.io.config.command), ['setup']);
  const before = f.commands.length;
  f.clear();
  assert.equal(await main(['setup'], io), exitCodeFor('ok'), f.output.join('\n'));
  // The machine was asked to enable the unit, and the file of the unit is there.
  assert.ok(f.commands.length > before, 'the setup did not run any command');
  assert.ok([...files.keys()].some((file) => file.endsWith('okit-daemon.service')), [...files.keys()].join(', '));
  f.clear();
  assert.equal(await main(['doctor'], io), exitCodeFor('ok'), `the doctor still fails:\n${f.output.join('\n')}`);
  assert.ok(!failedRow(f.output, 'Autostart'), f.output.join('\n'));
});

// The rows whose Fix is MANUAL by design: the doctor cannot repair them, and it says so.
// | row | why the Fix is manual |
const MANUAL = [
  ['MCP registration', 'the entry of that name is not ours: the installer never replaces the entry of somebody else'],
  ['Inbox', 'the state of the person is not ours to change: a person fixes the file or moves it aside'],
  ['Configuration', 'the settings are the person\'s: the doctor works with the defaults and says which key is wrong'],
  ['Daemon', 'the state file of the daemon is the person\'s: the doctor only reads it, so a person fixes it or moves it aside; the daemon itself starts with the machine'],
];

test('the row of a daemon that is down says that the daemon starts with the machine', async (t) => {
  const home = process.env.HOME;
  const version = JSON.parse(await fs.readFile(join(PACKAGE, 'package.json'), 'utf8')).version;
  const record = { client: CLIENT, version, path: PACKAGE, bin: 'src/cli.js', autostart: true, link: false,
    linkDirectory: null, settings: { node: process.execPath } };
  const { f } = await world(t, { autostart: true, record });
  t.after(() => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; });
  process.env.HOME = f.home;
  // The machine has the service of the autostart: the row of the autostart is ok, so the row of the daemon is the one
  // that fails.
  const plan = autostartPlan(detectAutostart('linux'), {
    root: f.root, home: f.home, node: record.settings.node, script: join(record.path, record.bin),
    command: f.io.config.command });
  await fs.mkdir(dirname(plan.path), { recursive: true });
  await fs.writeFile(plan.path, plan.content);
  const base = f.io.run;
  f.io.run = async (call) => ((call.args ?? []).includes('is-enabled') ? { code: 0, stdout: 'enabled\n' } : base(call));
  // The daemon is not running: the file of its state is gone.
  await fs.rm(join(f.root, 'daemon.pid.json'));
  f.clear();
  assert.equal(await main(['doctor'], f.io), exitCodeFor('operational'), f.output.join('\n'));
  const index = f.output.findIndex((line) => line.includes('Background service'));
  assert.ok(index >= 0, f.output.join('\n'));
  assert.match(f.output[1], /failed check/, f.output[1]);
  // The Fix is honest: no command of the kit starts the daemon, so it says the machine does.
  const fix = f.output.find((line) => line.startsWith('Fix: Start it:'));
  assert.match(fix, /^Fix: Start it: the daemon starts with the machine/, fix);
  assert.doesNotMatch(fix, /okit-plugin (?!doctor\b)[a-z]/, fix);
  assert.ok(MANUAL[3][1].length > 0);
});

// The plan of the autostart of this machine, as the doctor and the setup build it.
function planOf(f, record) {
  return autostartPlan(detectAutostart('linux'), {
    root: f.root, home: f.home, node: record.settings.node, script: join(record.path, record.bin),
    command: f.io.config.command });
}

/** The world of the autostart: the record says the autostart is on and the installation is the one that runs. */
async function autostartWorld(t) {
  const home = process.env.HOME;
  const version = JSON.parse(await fs.readFile(join(PACKAGE, 'package.json'), 'utf8')).version;
  const record = { client: CLIENT, version, path: PACKAGE, bin: 'src/cli.js', autostart: true, link: false,
    linkDirectory: null, settings: { node: process.execPath } };
  const { f } = await world(t, { autostart: true, record });
  t.after(() => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; });
  process.env.HOME = f.home;
  const files = new Map();
  const real = f.io.fs.readFile.bind(f.io.fs);
  const io = {
    ...f.io,
    detect: async (executable) => executable === f.io.config.clients[CLIENT].executable,
    // The files of the world: the one the setup writes is there after the Fix.
    fs: { ...f.io.fs, readFile: async (file, ...rest) => (files.has(file) ? files.get(file) : real(file, ...rest)) },
    write: async (file, content) => { files.set(file, content); },
    // The setup asks whether the autostart is installed: the answer is yes.
    ask: async () => 'yes',
    // The machine says what systemctl says of an enabled unit.
    run: async (call) => ((call.args ?? []).includes('is-enabled') ? { code: 0, stdout: 'enabled\n' } : f.io.run(call)),
  };
  return { f, io, files, plan: planOf(f, record) };
}

test('the Fix of a corrupt autostart installs it again', async (t) => {
  const { f, io, files, plan } = await autostartWorld(t);
  // The service of the machine is there, but it is corrupt: it does not hold the content of the plan.
  await fs.mkdir(dirname(plan.path), { recursive: true });
  await fs.writeFile(plan.path, 'not the unit of this installation\n');
  f.clear();
  assert.equal(await main(['doctor'], io), exitCodeFor('operational'), f.output.join('\n'));
  const row = failedRow(f.output, 'Autostart');
  assert.ok(row, `the autostart did not fail:\n${f.output.join('\n')}`);
  assert.deepEqual(commandOf(row.fix, f.io.config.command), ['setup']);
  f.clear();
  assert.equal(await main(['setup'], io), exitCodeFor('ok'), f.output.join('\n'));
  // The unit of the plan is written again, with the content of the plan.
  assert.equal(files.get(plan.path), plan.content);
  f.clear();
  assert.equal(await main(['doctor'], io), exitCodeFor('ok'), `the doctor still fails:\n${f.output.join('\n')}`);
  assert.ok(!failedRow(f.output, 'Autostart'), f.output.join('\n'));
});

test('the Fix of a disabled autostart enables it again', async (t) => {
  const { f, io, plan } = await autostartWorld(t);
  // The service of the machine is there, but the machine says it is not enabled.
  await fs.mkdir(dirname(plan.path), { recursive: true });
  await fs.writeFile(plan.path, plan.content);
  let enabled = false;
  io.run = async (call) => {
    const args = call.args ?? [];
    if (args.includes('is-enabled')) return { code: enabled ? 0 : 1, stdout: enabled ? 'enabled\n' : 'disabled\n' };
    if (args.includes('enable')) enabled = true;
    return f.io.run(call);
  };
  f.clear();
  assert.equal(await main(['doctor'], io), exitCodeFor('operational'), f.output.join('\n'));
  const row = failedRow(f.output, 'Autostart');
  assert.ok(row, `the autostart did not fail:\n${f.output.join('\n')}`);
  assert.deepEqual(commandOf(row.fix, f.io.config.command), ['setup']);
  f.clear();
  assert.equal(await main(['setup'], io), exitCodeFor('ok'), f.output.join('\n'));
  assert.ok(enabled, 'the setup enabled the unit of the machine');
  f.clear();
  assert.equal(await main(['doctor'], io), exitCodeFor('ok'), `the doctor still fails:\n${f.output.join('\n')}`);
  assert.ok(!failedRow(f.output, 'Autostart'), f.output.join('\n'));
});

test('the row of a foreign MCP entry says that a person takes it out by hand', async (t) => {
  const { f } = await world(t);
  // The entry of the client is of somebody else.
  await f.io.run({ command: f.io.config.clients[CLIENT].executable,
    args: ['mcp', 'add', 'okit', '--', 'node', join(f.home, 'foreign-server.js')] });
  f.clear();
  assert.equal(await main(['doctor'], f.io), exitCodeFor('ok'), f.output.join('\n'));
  const index = f.output.findIndex((line) => line.includes('Claude Code connection'));
  assert.ok(index >= 0, f.output.join('\n'));
  assert.match(f.output[1], /warnings;/, f.output[1]);
  assert.equal(f.output.find((line) => line.startsWith('Fix: ')), 'Fix: Remove the entry by hand: claude mcp remove okit --scope user');
  assert.ok(MANUAL[0][1].length > 0);
});

test('the row of a state file that is not valid says that a person fixes it', async (t) => {
  const { f } = await world(t);
  await fs.writeFile(paths(f.root).inbox, 'not json');
  f.clear();
  assert.equal(await main(['doctor'], f.io), exitCodeFor('operational'), f.output.join('\n'));
  const index = f.output.findIndex((line) => line.includes('Inbox'));
  assert.ok(index >= 0, f.output.join('\n'));
  assert.match(f.output[1], /failed check/, f.output[1]);
  assert.match(f.output.find((line) => line.startsWith('Fix: Fix it or move it aside')), /^Fix: Fix it or move it aside \(.*inbox\.json.*\), then run: .*\/src\/cli\.js doctor$/,
    f.output.find((line) => line.startsWith('Fix: Fix it or move it aside')));
  assert.ok(MANUAL[1][1].length > 0);
});

test('the row of a configuration the runtime refuses says that a person fixes it', async (t) => {
  const { f } = await world(t);
  const stored = JSON.parse(await fs.readFile(paths(f.root).config, 'utf8'));
  stored.install.kit = null;
  await fs.writeFile(paths(f.root).config, JSON.stringify(stored));
  f.clear();
  assert.equal(await main(['doctor'], f.io), exitCodeFor('operational'), f.output.join('\n'));
  const index = f.output.findIndex((line) => line.includes('Configuration'));
  assert.ok(index >= 0, f.output.join('\n'));
  assert.match(f.output[1], /failed check/, f.output[1]);
  assert.match(f.output.find((line) => line.startsWith('Fix: Fix it or move it aside')), /^Fix: Fix it or move it aside \(.*config\.json.*\), then run: .*src\/cli\.js doctor$/,
    f.output.find((line) => line.startsWith('Fix: Fix it or move it aside')));
  assert.ok(MANUAL[2][1].length > 0);
});

// D109 step 7: the state file of the daemon that is not valid is a failed row, and its Fix is manual: the doctor
// only reads the state of the person, so a person fixes the file or moves it aside.

test('the row of a state file of the daemon that is not valid says that a person fixes it', async (t) => {
  const { f } = await world(t);
  await fs.writeFile(join(f.root, 'daemon.pid.json'), 'not json');
  f.clear();
  assert.equal(await main(['doctor'], f.io), exitCodeFor('operational'), f.output.join('\n'));
  const index = f.output.findIndex((line) => line.includes('Background service'));
  assert.ok(index >= 0, f.output.join('\n'));
  assert.match(f.output[1], /failed check/, f.output[1]);
  assert.match(f.output[index], /the state file could not be read/, f.output[index]);
  assert.match(f.output.find((line) => line.startsWith('Fix: Fix it or move it aside')), /^Fix: Fix it or move it aside \(.*\), then run: .*\/src\/cli\.js doctor$/,
    f.output.find((line) => line.startsWith('Fix: Fix it or move it aside')));
  assert.ok(MANUAL[3][1].length > 0);
});
