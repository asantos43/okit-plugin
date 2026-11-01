import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { diagnose } from '../src/doctor/diagnose.js';
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
  'doctorRegistration', 'doctorRegistrationOk', 'doctorRegistrationAbsent', 'doctorFixRegistration',
  'doctorRegistrationForeign', 'doctorFixForeign', 'doctorRegistrationUnreadable', 'doctorRegistrationNone',
  'doctorConfig', 'doctorInbox', 'doctorOrders', 'doctorStateOk', 'doctorStateAbsent', 'doctorStateBad', 'doctorFixState',
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
