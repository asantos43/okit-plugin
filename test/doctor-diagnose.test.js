import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { diagnose } from '../src/doctor/diagnose.js';
import { autostartPlan } from '../src/autostart.js';
import { installConfig } from '../src/install/config.js';
import { createPresenter, TEXTS } from '../src/install/present.js';
import { writeRecord } from '../src/mcp/control-endpoint.js';
import { paths } from '../src/store.js';

// The doctor: it looks at the whole installation and answers a list of rows. It only reads.
//
// | case | must pass | must refuse |
// | an installation that works | no row fails, no row warns | a row without a label or a detail |
// | a failure | the row says how to fix it, with the exact command | a failure without a fix |
// | no session | a warning | a failure |
// | two languages | the same rows, the same statuses | a row of one language only |
// | the state of the person | the same bytes before and after | a file written, a record removed |

const REPO = fileURLToPath(new URL('../', import.meta.url));
const SERVER = join(REPO, 'src/mcp/server.js');
const PACKAGE_FILE = join(REPO, 'package.json');
const POSIX = process.platform !== 'win32';
const skip = POSIX ? false : 'posix only';

const RECORD = {
  client: 'claude-code', version: '1.0.0', path: '/opt/okit-plugin/1.0.0-claude-code',
  bin: 'okit-plugin', autostart: true, settings: { node: '/usr/bin/node' },
};
const CODEX = { ...RECORD, client: 'codex', path: '/opt/okit-plugin/1.0.0-codex' };

const missing = (file) => Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: 'ENOENT' });
/** A file the disk refuses to read: the reader gives back an error of its own. */
const denied = (file) => Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { code: 'EACCES' });
/** A path as a pattern of a regular expression. */
const pattern = (value) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

/**
 * The world of a run: the input of the doctor, with every reader replaced by one that answers.
 *
 * @param {object} options the records, the files of the state root, the readers and the language of the run
 */
async function world({ records = [RECORD], files = {}, readers = {}, locale = 'en', defaults = false } = {}) {
  const lines = [];
  const ui = createPresenter({ locale, write: (line) => lines.push(line) });
  const all = new Map(Object.entries(files));
  if (!all.has(PACKAGE_FILE)) all.set(PACKAGE_FILE, await fs.readFile(PACKAGE_FILE, 'utf8'));
  const readText = async (file) => {
    if (all.has(file)) return all.get(file);
    throw missing(file);
  };
  const fake = {
    nodeVersion: () => 'v22.0.0',
    readText,
    servers: async () => [{ pid: 4242, startedAt: 10 }],
    callRead: async () => ({ ok: true, text: 'ok' }),
    daemon: async () => ({ running: true }),
    autostartPresent: async () => true,
    selfCheck: async () => [{ id: 'version', status: 'pass', reason: '1.0.0' }],
    mcpEntry: async () => ({ state: 'registered' }),
  };
  const input = {
    root: '/state',
    config: installConfig(),
    records,
    ui,
    command: 'okit-plugin',
    platform: 'linux',
    env: { HOME: '/home' },
    home: '/home',
    fs: { readFile: async (file, ...rest) => fs.readFile(file, ...rest), access: async (file) => fs.access(file) },
    run: async () => ({ code: 0, stdout: '' }),
    now: () => Date.now(),
    readers: defaults ? { ...readers } : { ...fake, ...readers },
  };
  return { input, lines, files: all };
}

const rowOf = (result, id) => result.rows.find((row) => row.id === id);

// ---------------------------------------------------------------------------------------------------------------
// D109 step 6a: the doctor proves the autostart, it does not guess it. The file of the plan has to hold the content
// of the plan, and the machine itself has to say that the autostart is enabled.

/** The plan the doctor builds for the record of the world: the same pure value, with the same options. */
const planOf = (kind) => autostartPlan(kind, {
  root: '/state', home: '/home', command: 'okit-plugin', node: '/usr/bin/node',
  script: join(RECORD.path, RECORD.bin),
});

/** A file system that answers with the files of the map and with the real disk for everything else. */
const fsOf = (files) => ({
  readFile: async (file, ...rest) => (files.has(file) ? files.get(file) : fs.readFile(file, ...rest)),
  access: async (file) => (files.has(file) ? undefined : fs.access(file)),
});

/** The readers of the world, except the one of the autostart: the real one is the one under test. */
const WITHOUT_AUTOSTART = {
  selfCheck: async () => [],
  mcpEntry: async () => ({ state: 'registered' }),
  servers: async () => [],
  callRead: async () => ({ ok: true }),
  daemon: async () => ({ running: true }),
};

test('the scheduled task of Windows is there when the query answers with no code or with zero', async () => {
  const calls = [];
  for (const answer of [{ code: 0 }, {}]) {
    const { input } = await world({ defaults: true, readers: WITHOUT_AUTOSTART });
    const result = await diagnose({ ...input, platform: 'win32', run: async (call) => { calls.push(call); return answer; } });
    assert.equal(rowOf(result, 'autostart').status, 'ok', JSON.stringify(answer));
  }
  assert.deepEqual(calls, [
    { command: 'schtasks', args: ['/Query', '/TN', 'okit-daemon'], timeoutMs: 15000 },
    { command: 'schtasks', args: ['/Query', '/TN', 'okit-daemon'], timeoutMs: 15000 },
  ]);
});

test('the scheduled task of Windows is not there when the query fails or the task is not there', async () => {
  for (const answer of [{ code: 1 }, { code: 2 }]) {
    const { input } = await world({ defaults: true, readers: WITHOUT_AUTOSTART });
    const result = await diagnose({ ...input, platform: 'win32', run: async () => answer });
    assert.equal(rowOf(result, 'autostart').status, 'failed', JSON.stringify(answer));
  }
  for (const error of [Object.assign(new Error('the task is not there'), { code: 1 }),
    Object.assign(new Error('no schtasks here'), { code: 'ENOENT' })]) {
    const { input } = await world({ defaults: true, readers: WITHOUT_AUTOSTART });
    const result = await diagnose({ ...input, platform: 'win32', run: async () => { throw error; } });
    assert.equal(rowOf(result, 'autostart').status, 'failed', error.message);
  }
});

test('the autostart of a POSIX machine is there when the file holds the content of the plan and the query says so', async () => {
  const plan = planOf('systemd');
  const calls = [];
  const { input } = await world({ defaults: true, readers: WITHOUT_AUTOSTART });
  const files = new Map([[plan.path, plan.content]]);
  const result = await diagnose({ ...input, fs: fsOf(files), run: async (call) => { calls.push(call); return { stdout: 'enabled\n' }; } });
  assert.equal(rowOf(result, 'autostart').status, 'ok', JSON.stringify(result.rows));
  // The query of the kind, with its own argv and never a shell.
  assert.deepEqual(calls, [{ command: 'systemctl', args: ['--user', 'is-enabled', 'okit-daemon.service'], timeoutMs: 15000 }]);
});

test('a file of the autostart that is empty, stale or missing is not an autostart', async () => {
  const plan = planOf('systemd');
  for (const content of ['', 'a stale unit\n', ' [Unit]\nDescription=another daemon\n']) {
    const calls = [];
    const { input } = await world({ defaults: true, readers: WITHOUT_AUTOSTART });
    const files = new Map([[plan.path, content]]);
    const result = await diagnose({ ...input, fs: fsOf(files), run: async (call) => { calls.push(call); return { stdout: 'enabled\n' }; } });
    assert.equal(rowOf(result, 'autostart').status, 'failed', JSON.stringify(content));
    // The file alone decides: the machine is not even asked.
    assert.deepEqual(calls, []);
  }
  // The file is not there at all.
  const { input } = await world({ defaults: true, readers: WITHOUT_AUTOSTART });
  const result = await diagnose({ ...input, fs: fsOf(new Map()), run: async () => ({ stdout: 'enabled\n' }) });
  assert.equal(rowOf(result, 'autostart').status, 'failed');
});

test('the autostart of a POSIX machine is not there when the machine says it is not enabled', async () => {
  const plan = planOf('systemd');
  const files = new Map([[plan.path, plan.content]]);
  // The query answers that it is not enabled.
  const { input } = await world({ defaults: true, readers: WITHOUT_AUTOSTART });
  const answered = await diagnose({ ...input, fs: fsOf(files), run: async () => ({ code: 1, stdout: 'disabled\n' }) });
  assert.equal(rowOf(answered, 'autostart').status, 'failed');
  // The query fails: the unit is not enabled.
  const { input: failing } = await world({ defaults: true, readers: WITHOUT_AUTOSTART });
  const thrown = await diagnose({ ...failing, fs: fsOf(files),
    run: async () => { throw Object.assign(new Error('unit not found'), { code: 1 }); } });
  assert.equal(rowOf(thrown, 'autostart').status, 'failed');
});

test('a machine without the tool of the query is not a machine without an autostart', async () => {
  const plan = planOf('systemd');
  const files = new Map([[plan.path, plan.content]]);
  // The tool is not on this machine: the query is unknown and the file decides.
  const { input } = await world({ defaults: true, readers: WITHOUT_AUTOSTART });
  const result = await diagnose({ ...input, fs: fsOf(files),
    run: async () => { throw Object.assign(new Error('no systemctl here'), { code: 'ENOENT' }); } });
  assert.equal(rowOf(result, 'autostart').status, 'ok', JSON.stringify(result.rows));
  // The file is not whole either: the autostart is not there.
  const { input: stale } = await world({ defaults: true, readers: WITHOUT_AUTOSTART });
  const other = await diagnose({ ...stale, fs: fsOf(new Map([[plan.path, 'stale\n']])),
    run: async () => { throw Object.assign(new Error('no systemctl here'), { code: 'ENOENT' }); } });
  assert.equal(rowOf(other, 'autostart').status, 'failed');
  // The query says nothing about whether the autostart is enabled (the tool did not answer in time):
  // the query is unknown and the file decides.
  const { input: slow } = await world({ defaults: true, readers: WITHOUT_AUTOSTART });
  const timed = await diagnose({ ...slow, fs: fsOf(files),
    run: async () => { throw Object.assign(new Error('no answer within 15000 ms'), { code: 'ETIMEDOUT' }); } });
  assert.equal(rowOf(timed, 'autostart').status, 'ok');
});

test('the crontab of the user is the autostart when it holds the line of the plan', async () => {
  const plan = planOf('cron');
  const calls = [];
  const files = new Map([[plan.path, plan.content]]);
  const { input } = await world({ defaults: true, readers: WITHOUT_AUTOSTART });
  const marked = await diagnose({ ...input, platform: 'freebsd', fs: fsOf(files),
    run: async (call) => { calls.push(call); return { stdout: `${plan.content}\n` }; } });
  assert.equal(rowOf(marked, 'autostart').status, 'ok', JSON.stringify(marked.rows));
  assert.deepEqual(calls, [{ command: 'crontab', args: ['-l'], timeoutMs: 15000 }]);
  // A crontab without the line of ours is not our autostart.
  const { input: other } = await world({ defaults: true, readers: WITHOUT_AUTOSTART });
  const empty = await diagnose({ ...other, platform: 'freebsd', fs: fsOf(files), run: async () => ({ stdout: '0 * * * * other\n' }) });
  assert.equal(rowOf(empty, 'autostart').status, 'failed');
});

test('the label of launchd is the autostart when the machine holds it', async () => {
  const plan = planOf('launchd');
  const calls = [];
  const files = new Map([[plan.path, plan.content]]);
  const { input } = await world({ defaults: true, readers: WITHOUT_AUTOSTART });
  const result = await diagnose({ ...input, platform: 'darwin', fs: fsOf(files),
    run: async (call) => { calls.push(call); return { stdout: '{\n}\n' }; } });
  assert.equal(rowOf(result, 'autostart').status, 'ok', JSON.stringify(result.rows));
  assert.deepEqual(calls, [{ command: 'launchctl', args: ['list', 'com.okit.daemon'], timeoutMs: 15000 }]);
});

// ---------------------------------------------------------------------------------------------------------------
// The rows of a run that works.

test('an installation that works has no failed row and no warning', async () => {
  const { input } = await world();
  const result = await diagnose(input);
  assert.equal(result.failed, 0, JSON.stringify(result.rows));
  assert.equal(result.warnings, 0, JSON.stringify(result.rows));
  for (const row of result.rows) {
    assert.ok(row.label.length > 0, `${row.id}: no label`);
    assert.ok(row.detail.length > 0, `${row.id}: no detail`);
  }
  assert.deepEqual(result.rows.map((row) => row.id),
    ['node', 'install', 'registration', 'version', 'config', 'inbox', 'orders', 'session', 'autostart', 'daemon']);
});

// ---------------------------------------------------------------------------------------------------------------
// Every failure says how to fix it, with the exact command.

test('a Node older than the minimum is a failed row with the command to fix it', async () => {
  const { input } = await world({ readers: { nodeVersion: () => 'v18.20.0' } });
  const result = await diagnose(input);
  const row = rowOf(result, 'node');
  assert.equal(row.status, 'failed');
  assert.match(row.fix, /okit-plugin install/);
  assert.match(row.detail, /20/);
});

test('a Node that cannot be compared is a skipped row, never a failure', async () => {
  const { input } = await world({ files: { [PACKAGE_FILE]: '{"engines":{}}' } });
  const result = await diagnose(input);
  const row = rowOf(result, 'node');
  assert.equal(row.status, 'skipped');
  assert.equal(result.failed, 0);
});

test('no installation record is one failed row, and no row of a client follows', async () => {
  const { input } = await world({ records: [] });
  const result = await diagnose(input);
  const row = rowOf(result, 'install');
  assert.equal(row.status, 'failed');
  assert.match(row.fix, /okit-plugin install/);
  assert.deepEqual(result.rows.filter((each) => each.client), []);
  assert.deepEqual(result.rows.map((each) => each.id), ['node', 'install', 'config', 'inbox', 'orders', 'session', 'daemon']);
});

test('an MCP server that is not registered is a failed row with the command to register it', async () => {
  const { input } = await world({ readers: { mcpEntry: async () => ({ state: 'absent' }) } });
  const result = await diagnose(input);
  const row = rowOf(result, 'registration');
  assert.equal(row.status, 'failed');
  assert.match(row.fix, /okit-plugin install --client claude-code/);
});

test('an MCP entry that is not ours is a warning that says to take it out by hand', async () => {
  const { input } = await world({ readers: { mcpEntry: async () => ({ state: 'foreign' }) } });
  const result = await diagnose(input);
  const row = rowOf(result, 'registration');
  assert.equal(row.status, 'warn');
  assert.match(row.fix, /claude mcp remove okit --scope user/);
  assert.equal(result.failed, 0);
});

test('an MCP entry that cannot be read is a warning with its reason', async () => {
  const { input } = await world({ readers: { mcpEntry: async () => ({ state: 'unreadable', reason: 'exit code 1' }) } });
  const result = await diagnose(input);
  const row = rowOf(result, 'registration');
  assert.equal(row.status, 'warn');
  assert.match(row.detail, /exit code 1/);
});

test('a client with no MCP server of ours is a skipped row', async () => {
  const { input } = await world({ readers: { mcpEntry: async () => ({ state: 'none' }) } });
  const result = await diagnose(input);
  const row = rowOf(result, 'registration');
  assert.equal(row.status, 'skipped');
  assert.equal(result.failed, 0);
});

test('a failed check of the self-check passes its own fix through', async () => {
  const fix = 'Install again: okit-plugin install --client claude-code';
  const { input } = await world({ readers: { selfCheck: async () => [
    { id: 'version', status: 'fail', reason: 'the record says 0.9.0', fix },
    { id: 'command', status: 'skip', reason: 'sh is not installed', quiet: true },
  ] } });
  const result = await diagnose(input);
  const failed = rowOf(result, 'version');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.fix, fix);
  assert.match(failed.detail, /0\.9\.0/);
  const skipped = rowOf(result, 'command');
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.quiet, true);
});

test('each state file that is not valid is a failed row that names it', async () => {
  const cases = [
    ['config', '/state/config.json', 'not json', '[]'],
    ['inbox', '/state/inbox.json', 'not json', '{}'],
    ['orders', '/state/orders.json', 'not json', '{}'],
  ];
  for (const [id, file, broken, wrong] of cases) {
    for (const body of [broken, wrong]) {
      const { input } = await world({ files: { [file]: body } });
      const result = await diagnose(input);
      const row = rowOf(result, id);
      assert.equal(row.status, 'failed', `${id} ${body}`);
      assert.match(row.detail, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(row.fix, /okit-plugin doctor/);
    }
  }
});

test('a state file the disk refuses to read is a failed row that names it', async () => {
  const cases = [
    ['config', paths('/state').config],
    ['inbox', paths('/state').inbox],
    ['orders', paths('/state').orders],
  ];
  for (const [id, file] of cases) {
    // The disk refuses the file: the reader gives back an error of its own.
    const { input } = await world();
    const read = input.readers.readText;
    input.readers.readText = async (asked) => {
      if (asked === file) throw denied(asked);
      return read(asked);
    };
    const refused = await diagnose(input);
    const row = rowOf(refused, id);
    assert.equal(row.status, 'failed', `${id}: a file the disk refuses is a failure`);
    assert.match(row.detail, pattern(file));
    assert.match(row.fix, pattern(file));
    assert.match(row.fix, /okit-plugin doctor/);
    assert.equal(refused.failed, 1, `${id}: only that file fails`);

    // The same file with a text that is not JSON: the same failed row.
    const { input: broken } = await world({ files: { [file]: 'not json' } });
    const result = await diagnose(broken);
    const bad = rowOf(result, id);
    assert.equal(bad.status, 'failed', `${id}: a text that is not JSON is a failure`);
    assert.match(bad.detail, pattern(file));
    assert.match(bad.fix, /okit-plugin doctor/);
  }
});

test('a state file of the right shape is a row that is ok', async () => {
  const { input } = await world({ files: {
    '/state/config.json': '{"language":"en"}',
    '/state/inbox.json': '{"version":1,"seq":0,"items":[]}',
    '/state/orders.json': '{"version":1,"seq":0,"orders":[]}',
  } });
  const result = await diagnose(input);
  for (const id of ['config', 'inbox', 'orders']) assert.equal(rowOf(result, id).status, 'ok', id);
  assert.equal(result.failed, 0);
});

test('a session that does not answer is a failed row with the way out', async () => {
  const { input } = await world({ readers: { callRead: async () => ({ ok: false, error: 'the okit server did not answer' }) } });
  const result = await diagnose(input);
  const row = rowOf(result, 'session');
  assert.equal(row.status, 'failed');
  assert.match(row.detail, /did not answer/);
  assert.match(row.fix, /okit-plugin doctor/);
});

test('no session is a warning, never a failure', async () => {
  const { input } = await world({ readers: { servers: async () => [] } });
  const result = await diagnose(input);
  const row = rowOf(result, 'session');
  assert.equal(row.status, 'warn');
  assert.equal(result.failed, 0);
  assert.equal(result.warnings, 1);
});

test('an autostart that was set up but is not there is a failed row', async () => {
  const { input } = await world({ readers: { autostartPresent: async () => false } });
  const result = await diagnose(input);
  const row = rowOf(result, 'autostart');
  assert.equal(row.status, 'failed');
  assert.match(row.fix, /okit-plugin autostart install/);
});

test('an autostart that was never asked for is a warning that offers it', async () => {
  const { input } = await world({ records: [{ ...RECORD, autostart: false }], readers: { autostartPresent: async () => false } });
  const result = await diagnose(input);
  const row = rowOf(result, 'autostart');
  assert.equal(row.status, 'warn');
  assert.match(row.detail, /okit-plugin setup/);
  assert.equal(result.failed, 0);
});

test('an autostart that is there but that the record does not say is a warning, never a failure', async () => {
  const absent = { ...RECORD };
  delete absent.autostart;
  for (const record of [{ ...RECORD, autostart: false }, absent]) {
    const { input } = await world({ records: [record], readers: { autostartPresent: async () => true } });
    const result = await diagnose(input);
    const row = rowOf(result, 'autostart');
    assert.equal(row.status, 'warn');
    assert.equal(row.detail, TEXTS.doctorAutostartExtra.en);
    assert.equal(result.failed, 0);
    assert.equal(result.warnings, 1);
  }
});

test('a daemon that is down while the autostart is there is a failed row', async () => {
  const { input } = await world({ readers: { daemon: async () => ({ running: false }) } });
  const result = await diagnose(input);
  const row = rowOf(result, 'daemon');
  assert.equal(row.status, 'failed');
  assert.match(row.fix, /okit-plugin daemon start/);
});

test('a daemon that is down without an autostart is a warning', async () => {
  const { input } = await world({ records: [{ ...RECORD, autostart: false }],
    readers: { daemon: async () => ({ running: false }), autostartPresent: async () => false } });
  const result = await diagnose(input);
  const row = rowOf(result, 'daemon');
  assert.equal(row.status, 'warn');
  assert.equal(result.failed, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// D109 step 7: a reader that throws is a row of the diagnosis, never an exception out of it.

test('a reader that throws is a failed row, in both languages, and the other rows are still there', async () => {
  for (const locale of ['en', 'pt-BR']) {
    const { input } = await world({ locale, readers: {
      servers: async () => { throw new Error('the control folder cannot be read'); },
      daemon: async () => { throw new Error('the pid file cannot be read'); },
    } });
    const result = await diagnose(input);
    // The session and the daemon failed: the doctor did not crash.
    const session = rowOf(result, 'session');
    assert.equal(session.status, 'failed', JSON.stringify(result.rows));
    assert.match(session.detail, locale === 'en' ? /the state file could not be read: the control folder cannot be read/
      : /o arquivo de estado não pôde ser lido: the control folder cannot be read/, session.detail);
    assert.match(session.fix, /okit-plugin doctor/);
    const daemon = rowOf(result, 'daemon');
    assert.equal(daemon.status, 'failed', JSON.stringify(result.rows));
    assert.match(daemon.fix, /okit-plugin doctor/);
    assert.equal(result.failed, 2, JSON.stringify(result.rows));
    // The rows the doctor had are still told.
    assert.equal(rowOf(result, 'node').status, 'ok');
    assert.equal(rowOf(result, 'install').status, 'ok');
    assert.equal(rowOf(result, 'config').status, 'ok');
  }
});

test('a reader of the client that throws is a failed row, never a crash', async () => {
  const { input } = await world({ readers: {
    mcpEntry: async () => { throw new Error('the entry of the client cannot be read'); },
    selfCheck: async () => { throw new Error('the check cannot run'); },
  } });
  const result = await diagnose(input);
  const registration = rowOf(result, 'registration');
  assert.equal(registration.status, 'failed', JSON.stringify(result.rows));
  assert.match(registration.detail, /the state file could not be read: the entry of the client cannot be read/);
  const check = result.rows.find((row) => row.id === 'selfcheck');
  assert.equal(check.status, 'failed', JSON.stringify(result.rows));
  assert.match(check.detail, /the state file could not be read: the check cannot run/);
  assert.equal(result.failed, 2, JSON.stringify(result.rows));
});

test('every other reader that throws is a failed row too, with its reason redacted', async () => {
  const secret = 'https://example.test/path?token=hunter2&x=1';
  const { input } = await world({ readers: {
    nodeVersion: () => { throw new Error('no node here'); },
    callRead: async () => { throw new Error(`the call failed at ${secret}`); },
    autostartPresent: async () => { throw new Error('the unit cannot be read'); },
  } });
  const result = await diagnose(input);
  const node = rowOf(result, 'node');
  assert.equal(node.status, 'failed', JSON.stringify(result.rows));
  assert.match(node.detail, /the state file could not be read: no node here/);
  const session = rowOf(result, 'session');
  assert.equal(session.status, 'failed', JSON.stringify(result.rows));
  assert.match(session.detail, /the state file could not be read: the call failed at https:\/\/example\.test\/path/);
  assert.doesNotMatch(session.detail, /hunter2|token=/, session.detail);
  const autostart = rowOf(result, 'autostart');
  assert.equal(autostart.status, 'failed', JSON.stringify(result.rows));
  assert.match(autostart.detail, /the state file could not be read: the unit cannot be read/);
  assert.equal(result.failed, 3, JSON.stringify(result.rows));
});

test('a saved language of any shape is a failed row, never a crash', async () => {
  for (const [saved, shown] of [[{ toString: null }, '{"toString":null}'], [42, '42'], [['en'], '["en"]'], [null, 'null']]) {
    const { input } = await world({ files: { '/state/config.json': JSON.stringify({ language: saved }) } });
    const row = rowOf(await diagnose(input), 'config');
    assert.equal(row.status, 'failed', JSON.stringify(row));
    assert.ok(row.detail.includes(shown), row.detail);
  }
});

test('a saved language that carries a secret does not print it', async () => {
  const { input } = await world({ files: { '/state/config.json': JSON.stringify({ language: 'https://example.test/x?token=hunter2' }) } });
  const row = rowOf(await diagnose(input), 'config');
  assert.equal(row.status, 'failed');
  assert.doesNotMatch(row.detail, /hunter2|token=/, row.detail);
});

test('a reader that throws a value that cannot be turned into text is still a row', async () => {
  const { input } = await world({ readers: { nodeVersion: () => { throw Object.create(null); } } });
  const row = rowOf(await diagnose(input), 'node');
  assert.equal(row.status, 'failed', JSON.stringify(row));
  assert.match(row.detail, /the state file could not be read: object/, row.detail);
});

test('a state file the disk refuses to read says the reason of the refusal', async () => {
  const file = paths('/state').inbox;
  const { input } = await world();
  const read = input.readers.readText;
  input.readers.readText = async (asked) => {
    if (asked === file) throw denied(asked);
    return read(asked);
  };
  const row = rowOf(await diagnose(input), 'inbox');
  assert.equal(row.status, 'failed');
  assert.match(row.detail, /the state file could not be read: /, row.detail);
  assert.match(row.detail, pattern(file), row.detail);
});

// ---------------------------------------------------------------------------------------------------------------
// The order of the rows and the choice of the client.

test('the rows of the clients follow the order of the records', async () => {
  const { input } = await world({ records: [RECORD, CODEX] });
  const result = await diagnose(input);
  const clients = result.rows.filter((row) => row.client).map((row) => row.client);
  assert.deepEqual(clients, ['claude-code', 'claude-code', 'codex', 'codex']);
});

test('the client of the input is the only one that is looked at', async () => {
  const { input } = await world({ records: [RECORD, CODEX] });
  const result = await diagnose({ ...input, client: 'codex' });
  const clients = [...new Set(result.rows.filter((row) => row.client).map((row) => row.client))];
  assert.deepEqual(clients, ['codex']);
});

// ---------------------------------------------------------------------------------------------------------------
// One language per run.

const DOCTOR_KEYS = ['doctorNode', 'doctorNodeOk', 'doctorNodeOld', 'doctorNodeUnknown', 'doctorFixNode',
  'doctorInstall', 'doctorInstallOk', 'doctorInstallNone', 'doctorFixInstall',
  'doctorRecord', 'doctorRecordUnreadable', 'doctorFixRecord', 'doctorFixRecordAll',
  'doctorRegistration', 'doctorRegistrationOk', 'doctorRegistrationAbsent', 'doctorFixRegistration',
  'doctorRegistrationForeign', 'doctorFixForeign', 'doctorRegistrationUnreadable', 'doctorRegistrationNone',
  'doctorRegistrationDisabled', 'doctorRegistrationOther', 'doctorRegistrationMissing', 'doctorRegistrationServerMissing',
  'doctorConfig', 'doctorInbox', 'doctorOrders', 'doctorStateOk', 'doctorStateAbsent', 'doctorStateBad',
  'doctorStateUnreadable', 'doctorFixState',
  'doctorSession', 'doctorSessionNone', 'doctorSessionOk', 'doctorSessionFail', 'doctorFixSession',
  'doctorAutostart', 'doctorAutostartOk', 'doctorAutostartMissing', 'doctorFixAutostart', 'doctorAutostartOptional',
  'doctorAutostartExtra', 'doctorDaemon', 'doctorDaemonOk', 'doctorDaemonDown', 'doctorFixDaemon'];

test('the rows are the same in both languages, with the same statuses', async () => {
  const english = await diagnose((await world({ locale: 'en' })).input);
  const portuguese = await diagnose((await world({ locale: 'pt-BR' })).input);
  assert.deepEqual(portuguese.rows.map((row) => row.id), english.rows.map((row) => row.id));
  assert.deepEqual(portuguese.rows.map((row) => row.status), english.rows.map((row) => row.status));
  // The sentences are not the same ones: the run speaks one language.
  assert.notEqual(portuguese.rows[0].detail, english.rows[0].detail);
});

test('every text of the doctor is written in both languages', () => {
  for (const key of DOCTOR_KEYS) {
    assert.ok(TEXTS[key]?.en, `${key}: no English text`);
    assert.ok(TEXTS[key]?.['pt-BR'], `${key}: no pt-BR text`);
    assert.notEqual(TEXTS[key].en, TEXTS[key]['pt-BR'], `${key}: the pt-BR text is the English one`);
  }
  // The mark of a warning is a mark of its own.
  assert.equal(TEXTS.status.warn.en, 'warn');
  assert.equal(TEXTS.status.warn['pt-BR'], 'aviso');
});

// ---------------------------------------------------------------------------------------------------------------
// The doctor only reads.

/** Everything under a folder: the path, the size, the instant and the bytes of every file. */
async function listing(root) {
  const found = [];
  const walk = async (folder) => {
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      const info = await fs.lstat(path);
      const bytes = await fs.readFile(path).catch(() => Buffer.alloc(0));
      found.push(`${path} ${info.size} ${info.mtimeMs} ${createHash('sha256').update(bytes).digest('hex')}`);
    }
  };
  await walk(root);
  return found;
}

/** A pid of a process that is gone. */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise((resolve) => child.on('exit', resolve));
  return pid;
}

test('a record of a dead process stays on disk: the doctor never prunes one', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'okit-doctor-root-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pid = await deadPid();
  const file = await writeRecord(root, {
    pid, endpoint: join(paths(root).control, `${pid}.sock`), token: 'tk', startedAt: 1,
  }, { platform: 'linux' });

  const { input } = await world({ records: [], defaults: true });
  const result = await diagnose({ ...input, root, fs });
  assert.equal(rowOf(result, 'session').status, 'warn');
  assert.ok((await fs.stat(file)).isFile(), 'the record of the dead process was removed');
});

test('the call of the doctor to a server that is not there prunes nothing', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'okit-doctor-call-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pid = await deadPid();
  const file = await writeRecord(root, {
    pid, endpoint: join(paths(root).control, `${pid}.sock`), token: 'tk', startedAt: 1,
  }, { platform: 'linux' });

  // The real readers, with only the list of the servers replaced: the call to
  // the server is the one of the doctor, and it must not remove a record.
  const { input } = await world({ records: [], defaults: true });
  const result = await diagnose({ ...input, root, fs, readers: { servers: async () => [{ pid }] } });
  const row = rowOf(result, 'session');
  assert.equal(row.status, 'failed');
  assert.match(row.detail, /no okit server is running for this state folder/);
  assert.ok((await fs.stat(file)).isFile(), 'the record of the dead server was removed');
});

test('a whole run leaves the state root byte for byte the same', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'okit-doctor-root-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(paths(root).control, { recursive: true });
  await fs.writeFile(paths(root).config, '{"language":"en"}\n');
  await fs.writeFile(paths(root).inbox, '{"version":1,"seq":0,"items":[]}\n');
  await fs.writeFile(paths(root).orders, '{"version":1,"seq":0,"orders":[]}\n');
  await fs.writeFile(join(paths(root).control, '9999.json'), JSON.stringify({ pid: 9999, endpoint: 'x', token: 'y' }));
  const before = await listing(root);

  const { input } = await world({ records: [], defaults: true });
  await diagnose({ ...input, root, fs });

  assert.deepEqual(await listing(root), before);
});

test('the registration is read with the get command of the client, and nothing is written', async () => {
  const calls = [];
  const { input } = await world({ readers: {
    selfCheck: async () => [],
    mcpEntry: async (record, deps) => {
      const { mcpStatus } = await import('../src/install/mcp-register.js');
      return mcpStatus(record, deps);
    },
  } });
  const result = await diagnose({ ...input, run: async (call) => {
    calls.push(call);
    return { code: 1, stdout: 'No MCP server named "okit" found.\n', stderr: '' };
  } });
  assert.equal(rowOf(result, 'registration').status, 'failed');
  assert.deepEqual(calls.map((call) => call.args), [['mcp', 'get', 'okit']]);
  assert.equal(calls.filter((call) => call.args[1] === 'add' || call.args[1] === 'remove').length, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// The real server: the session answers while it runs, and the doctor leaves the root alone.

test('the real MCP server answers the session, and the doctor writes nothing', { skip }, async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'okit-doctor-live-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, OKWORK_HOME: root } });
  t.after(() => { server.kill('SIGKILL'); });
  const record = join(paths(root).control, `${server.pid}.json`);
  const until = Date.now() + 10000;
  while (Date.now() < until && !(await fs.stat(record).then(() => true, () => false))) {
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  assert.ok(await fs.stat(record).then(() => true, () => false), 'the server wrote no record');

  const { input } = await world({ records: [], defaults: true });
  const running = await diagnose({ ...input, root, fs });
  assert.equal(rowOf(running, 'session').status, 'ok');

  server.kill('SIGTERM');
  await new Promise((resolve) => server.on('exit', resolve));
  const before = await listing(root);
  const stopped = await diagnose({ ...input, root, fs });
  assert.equal(rowOf(stopped, 'session').status, 'warn');
  assert.deepEqual(await listing(root), before, 'the doctor wrote a file');
});


for (const [code, error, portuguese] of [
  ['closed', 'the okit server closed the connection', 'o servidor do okit fechou a conexão'],
  ['not-accepted', 'the okit server did not accept the connection', 'o servidor do okit não aceitou a conexão'],
  ['no-server', 'no okit server is running for this state folder', 'nenhum servidor do okit está rodando para esta pasta de estado'],
  ['no-answer', 'no okit server answers on this state folder', 'nenhum servidor do okit responde nesta pasta de estado'],
  ['not-understood', 'the okit server sent an answer that is not understood', 'o servidor do okit enviou uma resposta não compreendida'],
  ['timeout', 'the okit server did not answer in 123 ms', 'o servidor do okit não respondeu em 123 ms'],
  ['arguments', 'the arguments cannot be sent: DATA', 'os argumentos não podem ser enviados (detalhe: DATA)'],
  ['failed', 'DATA', 'a chamada ao servidor do okit falhou (detalhe: DATA)'],
  [undefined, 'DATA', 'a chamada ao servidor do okit falhou (detalhe: DATA)'],
  ['future-code', 'DATA', 'a chamada ao servidor do okit falhou (detalhe: DATA)'],
  ['constructor', 'DATA', 'a chamada ao servidor do okit falhou (detalhe: DATA)'],
]) {
  for (const locale of ['en', 'pt-BR']) {
    test(`session control error ${code} is localized in ${locale}`, async () => {
      const { input } = await world({ locale, readers: { callRead: async () => ({ ok: false, code, error }) } });
      const row = rowOf(await diagnose(input), 'session');
      assert.equal(row.status, 'failed');
      assert.ok(row.detail.includes(locale === 'en' ? (code === 'arguments' ? 'the arguments cannot be sent (detail: DATA)' : error) : portuguese), row.detail);
      if (locale === 'pt-BR') {
        for (const sentence of ['the okit server closed the connection', 'the okit server did not accept the connection',
          'the okit server sent an answer that is not understood', 'the okit server did not answer in', 'the arguments cannot be sent:']) {
          assert.equal(row.detail.includes(sentence), false, row.detail);
        }
      }
    });
  }
}

test('a timeout answer that does not say how long still reads as a sentence', async () => {
  const { input } = await world({ locale: 'en', readers: { callRead: async () => ({ ok: false, code: 'timeout', error: 'gone' }) } });
  const row = rowOf(await diagnose(input), 'session');
  assert.ok(row.detail.includes('the okit server did not answer in ? ms'), row.detail);
});
