import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { main } from '../src/cli.js';
import { doctorCommand } from '../src/doctor/command.js';
import { diagnose } from '../src/doctor/diagnose.js';
import { exitCodeFor } from '../src/install/exit.js';
import { installConfig } from '../src/install/config.js';
import { createPresenter } from '../src/install/present.js';
import { shown } from '../src/install/mcp-register.js';
import { payloadComplete } from '../src/install/place.js';
import { fixture } from './helpers/install-fixture.js';

// D111: the doctor and the self-check diagnose the installation that is really there.
//
// | finding | must pass | must refuse |
// | the autostart of a machine | the Fix names the daemon with the absolute node of the plan | a bare `node` |
// | an installation with its own folder | the self-check reads the records of that folder | the folder of the settings |
// | a legacy record with an existing payload | the installation is whole | a row that says the install is broken |
// | the payload of an installation | every file it lists is there | a payload with a file missing, unnamed |

const CLIENT = 'claude-code';
const SERVER = 'src/mcp/server.js';
const PROBE = 'src/mcp/selfcheck-probe.js';
const CLI = 'src/cli.js';

/** The words a POSIX shell reads from a command line: the shell is the parser. */
const argvOf = (line) => {
  const printed = execFileSync('sh', ['-c', 'eval "set -- $1"; printf "%s\\0" "$@"', 'sh', line], { encoding: 'utf8' });
  const words = printed.split('\0');
  words.pop();
  return words;
};

/**
 * An installation with a whole payload, as the installer places it: the folder of the installation, the files the
 * package lists and the record of the client.
 *
 * @param {object} f the world of the fixture
 * @param {object} [options] the version of the installation
 * @returns {Promise<object>} the folder of the installation and its record
 */
async function installation(f, { version = '1.0.0', client = CLIENT, bin = { 'okit-plugin': CLI } } = {}) {
  const path = join(f.destination, `${version}-${client}`);
  await fs.mkdir(join(path, 'src', 'mcp'), { recursive: true });
  await fs.writeFile(join(path, 'package.json'), JSON.stringify({ name: 'sample', version, bin }));
  await fs.writeFile(join(path, CLI), '// the command of the plugin\n');
  await fs.writeFile(join(path, SERVER), '// fake MCP server\n');
  await fs.writeFile(join(path, PROBE), '// fake probe of the check\n');
  const module = f.io.config.clients[client].module;
  if (module) {
    await fs.mkdir(join(path, 'src/install'), { recursive: true });
    await fs.writeFile(join(path, module), '// native client plugin\n');
  }
  const record = { client, version, path, bin: CLI, autostart: false, link: false, linkDirectory: null,
    settings: { node: process.execPath } };
  await fs.writeFile(join(f.destination, `install.${client}.json`), JSON.stringify(record));
  await f.io.run({ command: f.io.config.clients[client].executable,
    args: ['mcp', 'add', 'okit', '--', f.io.config.node, join(path, SERVER)] });
  return { path, record };
}

// ---------------------------------------------------------------------------------------------------------------
// The Fix of the autostart names the daemon with the node the plan of the machine writes.

test('the Fix of the autostart names the daemon with the absolute node of the plan', async () => {
  const lines = [];
  const ui = createPresenter({ locale: 'en', write: (line) => lines.push(line) });
  const record = { client: CLIENT, version: '1.0.0', path: '/opt/okit-plugin/1.0.0-claude-code', bin: CLI, autostart: true };
  const result = await diagnose({
    root: '/state', config: installConfig(), records: [record], ui, command: 'okit-plugin', platform: 'linux',
    env: { HOME: '/home' }, home: '/home', run: async () => ({ code: 0, stdout: '' }), now: () => Date.now(),
    readers: {
      nodeVersion: () => 'v22.0.0', readText: async (file) => { if (file.endsWith('/' + CLI)) return '// installed CLI'; throw Object.assign(new Error('no file'), { code: 'ENOENT' }); },
      servers: async () => [], callRead: async () => ({ ok: true }), daemon: async () => ({ running: true }),
      autostartPresent: async () => false, selfCheck: async () => [], mcpEntry: async () => ({ state: 'registered' }),
    },
  });
  const row = result.rows.find((each) => each.id === 'autostart');
  assert.equal(row.status, 'failed', JSON.stringify(result.rows));
  // The command that starts the daemon: the node is the absolute one of this process (the plan knows it), never a
  // bare `node` that the PATH of an unknown shell would have to resolve.
  const found = /the daemon starts with (.*);/.exec(row.fix);
  assert.ok(found, row.fix);
  assert.deepEqual(argvOf(found[1]), [process.execPath, join(record.path, CLI), 'daemon', 'start'], row.fix);
  assert.ok(row.fix.includes(process.execPath), row.fix);
});

test('the autostart is there when the service holds the command of any record, not only the first', async () => {
  const ui = createPresenter({ locale: 'en', write: () => {} });
  const first = { client: CLIENT, version: '1.0.0', path: '/opt/okit-plugin/1.0.0-claude-code', bin: CLI, autostart: true };
  const second = { client: 'codex', version: '1.0.0', path: '/opt/okit-plugin/1.0.0-codex', bin: CLI, autostart: true };
  const asked = [];
  const result = await diagnose({
    root: '/state', config: installConfig(), records: [first, second], ui, command: 'okit-plugin', platform: 'linux',
    env: { HOME: '/home' }, home: '/home', run: async () => ({ code: 0, stdout: '' }), now: () => Date.now(),
    readers: {
      nodeVersion: () => 'v22.0.0', readText: async (file) => { if (file.endsWith('/' + CLI)) return '// installed CLI'; throw Object.assign(new Error('no file'), { code: 'ENOENT' }); },
      servers: async () => [], callRead: async () => ({ ok: true }), daemon: async () => ({ running: true }),
      // Only the service of the second record's payload is installed.
      autostartPresent: async (plan) => { asked.push(plan.content); return plan.content.includes('1.0.0-codex'); },
      selfCheck: async () => [], mcpEntry: async () => ({ state: 'registered' }),
    },
  });
  assert.equal(result.rows.find((each) => each.id === 'autostart').status, 'ok', JSON.stringify(result.rows));
  assert.equal(asked.length, 2);
});

// ---------------------------------------------------------------------------------------------------------------
// The self-check reads the records of the folder the record names.

test('the self-check reads the records of the folder the record names', async (t) => {
  const f = await fixture(t);
  const custom = join(f.home, 'custom destination');
  await fs.mkdir(custom, { recursive: true });
  const { path } = await installation(f);
  // The record of the client names the folder of the installation: a custom `--dest` or a moved installation.
  const record = JSON.parse(await fs.readFile(join(f.destination, `install.${CLIENT}.json`), 'utf8'));
  record.destination = custom;
  await fs.writeFile(join(f.destination, `install.${CLIENT}.json`), JSON.stringify(record));
  await fs.writeFile(join(custom, `install.${CLIENT}.json`), JSON.stringify(record));
  let seen;
  const readers = { selfCheck: async (one, expected, deps) => { seen = deps.destination; return []; } };
  await doctorCommand(f.io, { locale: 'en', config: f.io.config, readers });
  assert.equal(seen, custom, 'the self-check read the records of another folder');
  // And the version of the installation is read from the folder of the record: the row passes.
  f.clear();
  await doctorCommand(f.io, { locale: 'en', config: f.io.config });
  const text = f.output.join('\n');
  assert.match(text, /Claude Code: Version\s+ok\s+1\.0\.0/, text);
  assert.ok(path);
});

// ---------------------------------------------------------------------------------------------------------------
// A legacy record (the old shape) with an existing payload: the installation is whole.

test('a legacy record of the old shape with an existing payload is an installation that works', async (t) => {
  const f = await fixture(t);
  const { path } = await installation(f);
  // The legacy record: the old shape names the client and the version, and no folder.
  await fs.rm(join(f.destination, `install.${CLIENT}.json`));
  await fs.writeFile(join(f.destination, 'install.json'), JSON.stringify({ client: CLIENT, version: '1.0.0', previous: null }));
  f.clear();
  const code = await main(['doctor'], f.io);
  const text = f.output.join('\n');
  assert.equal(code, exitCodeFor('ok'), text);
  // The installation is there: no row says it is broken.
  assert.match(text, /0 failed, \d+ to look at/, text);
  assert.match(text, /Claude Code: Version\s+ok\s+1\.0\.0/, text);
  assert.match(text, /Claude Code: Payload\s+ok/, text);
  assert.ok(path);
});

test('a legacy record that cannot be read says why, in plain words', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.destination, { recursive: true });
  await fs.writeFile(join(f.destination, 'install.json'), 'not json');
  f.clear();
  const code = await main(['doctor', '--locale', 'en'], f.io);
  const text = f.output.join('\n');
  assert.equal(code, exitCodeFor('operational'), text);
  // The row says what is wrong and which file it is.
  assert.match(text, /Installation record\s+failed\s+installation record unreadable: /, text);
  assert.ok(text.includes(join(f.destination, 'install.json')), text);
  // The Fix repairs it: the install of every client (the record belongs to no client).
  assert.ok(text.includes(`Fix: Install it again: ${shown([process.execPath, fileURLToPath(new URL('../src/cli.js', import.meta.url))])} install`), text);
});

// ---------------------------------------------------------------------------------------------------------------
// The payload of an installation: every file the installed package lists is there.

test('the payload of an installation is whole when every file it lists is there', async (t) => {
  const f = await fixture(t);
  await installation(f);
  f.clear();
  const code = await main(['doctor'], f.io);
  const text = f.output.join('\n');
  assert.equal(code, exitCodeFor('ok'), text);
  assert.match(text, /Claude Code: Payload\s+ok\s+every file of the installation is there/, text);
});

for (const damage of ['remove', 'empty']) {
  test(`every required payload file damaged by ${damage} fails completeness and the doctor names it`, async (t) => {
    // Keep the expected list explicit: omitting a bin or client module from production must fail this test.
    for (const bin of [CLI, { 'okit-plugin': CLI, other: 'src/other.js' }]) {
      for (const file of ['package.json', CLI, ...(typeof bin === 'object' ? ['src/other.js'] : []), SERVER, PROBE, 'src/install/client-plugin.js']) {
        const f = await fixture(t);
        const { path, record } = await installation(f, { client: 'opencode', bin });
        if (typeof bin === 'object') await fs.writeFile(join(path, 'src/other.js'), '// another bin\n');
        assert.equal(await payloadComplete(record, f.io.config, fs), true);
        if (damage === 'remove') await fs.rm(join(path, file));
        else await fs.writeFile(join(path, file), '  \n');
        assert.equal(await payloadComplete(record, f.io.config, fs), false, `${damage}: ${file}`);
        f.clear();
        const code = await main(['doctor'], f.io);
        const text = f.output.join('\n');
        assert.equal(code, exitCodeFor('operational'), `${file}: ${text}`);
        const row = text.split('\n').find((line) => /Opencode: Payload\s+failed/.test(line));
        assert.ok(row?.includes(join(path, file)), `${file}: ${text}`);
        const script = fileURLToPath(new URL('../src/cli.js', import.meta.url));
        assert.ok(text.includes(`Fix: Install again: ${shown([process.execPath, script, 'install', '--client', 'opencode'])}`), text);
      }
    }
  });
}

test('unreadable or malformed installed metadata makes the payload incomplete', async (t) => {
  const f = await fixture(t);
  const { path, record } = await installation(f);
  assert.equal(await payloadComplete({}, f.io.config, fs), false);
  const injected = { ...fs, readFile: async (file, ...args) => {
    if (file === join(path, 'package.json')) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
    return fs.readFile(file, ...args);
  } };
  assert.equal(await payloadComplete(record, f.io.config, injected), false);
  for (const text of ['{', 'null', '[]', '42']) {
    await fs.writeFile(join(path, 'package.json'), text);
    assert.equal(await payloadComplete(record, f.io.config, fs), false, text);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The self-check writes what it advertises for the shell: a path or a command with a space is runnable as it is shown.

test('the Fix and the detail of a self-check row quote the path and the command the shell would split', async (t) => {
  const spaced = await fs.mkdtemp(join(tmpdir(), 'a folder with space-'));
  const before = process.env.TMPDIR;
  process.env.TMPDIR = spaced;
  t.after(() => { if (before === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = before; return fs.rm(spaced, { recursive: true, force: true }); });
  const f = await fixture(t);
  const { path } = await installation(f);
  assert.ok(path.includes(' '), path);
  await fs.rm(join(path, PROBE));
  f.clear();
  await doctorCommand(f.io, { locale: 'en', config: { ...f.io.config, command: 'my plugin' } });
  const text = f.output.join('\n');
  // The detail names the file as one shell word.
  assert.ok(text.includes(`'${join(path, PROBE)}'`), text);
  // The Fix is the command as the shell reads it: the program in one word.
  const fix = /^ +Fix: Install again: (.*)$/m.exec(text);
  assert.ok(fix, text);
  assert.deepEqual(argvOf(fix[1]), [process.execPath, fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'install', '--client', CLIENT], fix[1]);
});

test('the Fix of a row that names the state folder quotes a path with a space', async () => {
  const lines = [];
  const ui = createPresenter({ locale: 'en', write: (line) => lines.push(line) });
  const file = '/state with space/daemon.json';
  const result = await diagnose({
    root: '/state with space', config: installConfig(), records: [], ui, command: 'okit-plugin', platform: 'linux',
    env: { HOME: '/home' }, home: '/home', run: async () => ({ code: 0, stdout: '' }), now: () => Date.now(),
    readers: {
      nodeVersion: () => 'v22.0.0', readText: async () => { throw Object.assign(new Error('no file'), { code: 'ENOENT' }); },
      servers: async () => [], callRead: async () => ({ ok: true }), autostartPresent: async () => true,
      daemon: async () => { throw Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { code: 'EACCES', path: file }); },
      selfCheck: async () => [], mcpEntry: async () => ({ state: 'registered' }),
    },
  });
  const row = result.rows.find((each) => each.id === 'daemon');
  assert.equal(row.status, 'failed', JSON.stringify(result.rows));
  assert.ok(row.fix.includes(`'${file}'`), row.fix);
});

test('the Fix of an installation without a link names the running node, never a bare `node` of the record', async (t) => {
  const f = await fixture(t);
  const { path, record } = await installation(f);
  await fs.writeFile(join(f.destination, `install.${CLIENT}.json`), JSON.stringify({ ...record, settings: { node: 'node' } }));
  await fs.rm(join(path, PROBE));
  f.clear();
  await main(['doctor'], f.io);
  const fix = /^ +Fix: Install again: (.*)$/m.exec(f.output.join('\n'));
  assert.ok(fix, f.output.join('\n'));
  assert.deepEqual(argvOf(fix[1]).slice(0, 2), [process.execPath, fileURLToPath(new URL('../src/cli.js', import.meta.url))], fix[1]);
});
