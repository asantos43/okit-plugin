import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { main } from '../src/cli.js';
import { doctorCommand } from '../src/doctor/command.js';
import { diagnose } from '../src/doctor/diagnose.js';
import { exitCodeFor } from '../src/install/exit.js';
import { shown } from '../src/install/mcp-register.js';
import { createPresenter } from '../src/install/present.js';
import { writeRecord } from '../src/mcp/control-endpoint.js';
import { paths } from '../src/store.js';
import { fixture } from './helpers/install-fixture.js';

// The doctor of the command line: it looks at the whole installation and answers one row per thing it looked at.
//
// | case | must pass | must refuse |
// | an installation that works | exit 0, the summary, no Fix line | a failed row, a Fix line |
// | no installation | exit 1, a Fix line with the command that installs it | exit 0, a silent row |
// | a state file that is not JSON | exit 1, a Fix line that names the file | a file changed by the run |
// | warnings only | exit 0, the warn mark, the summary counting them | exit 1 |
// | the flags | the rows of the client, the language of the run | an unknown flag, an unknown client |
// | a whole run | the state root byte for byte the same | a file written, a record of a dead process removed |

const SERVER = 'src/mcp/server.js';
const LOCALES = ['en', 'pt-BR'];
const MARKS = { en: 'warn', 'pt-BR': 'aviso' };
// The line of the summary, in the language of the run: the failures and the warnings it counts.
const SUMMARIES = { en: /(\d+) failed, (\d+) to look at/, 'pt-BR': /(\d+) falharam, (\d+) para olhar/ };
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const unlinkedProgram = (f) => shown([process.execPath, fileURLToPath(new URL('../src/cli.js', import.meta.url))]);

/**
 * A made-up installation: the record of each client, the entry of the client registered as the installer registers it,
 * the state files and a fake runner that answers the shell and the probe of the self-check.
 */
async function world(t, { clients = ['claude-code'], inbox, orders } = {}) {
  const f = await fixture(t);
  for (const client of clients) {
    const path = join(f.destination, `1.0.0-${client}`);
    await fs.mkdir(join(path, 'src', 'mcp'), { recursive: true });
    await fs.writeFile(join(path, 'package.json'), JSON.stringify({ name: 'sample', version: '1.0.0' }));
    // The server the entry names has to be on this machine: an entry that names a file that is gone is broken.
    await fs.writeFile(join(path, SERVER), '// fake MCP server\n');
    await fs.writeFile(join(path, 'okit-plugin'), '// fake installed CLI\n');
    // The payload of an installation is whole: the probe of the check is one of the files of it.
    await fs.writeFile(join(path, 'src/mcp/selfcheck-probe.js'), '// fake probe of the check\n');
    const record = { client, version: '1.0.0', path, bin: 'okit-plugin', autostart: false, link: false,
      linkDirectory: null, settings: { node: process.execPath } };
    await fs.writeFile(join(f.destination, `install.${client}.json`), JSON.stringify(record));
    await f.io.run({ command: f.io.config.clients[client].executable,
      args: ['mcp', 'add', 'okit', '--', f.io.config.node, join(path, SERVER)] });
  }
  await fs.writeFile(paths(f.root).inbox, inbox ?? '{"version":1,"seq":0,"items":[]}');
  await fs.writeFile(paths(f.root).orders, orders ?? '{"version":1,"seq":0,"orders":[]}');
  f.clear();
  return f;
}

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

/** The line of the summary: the last line of the run. */
const summaryOf = (text) => text.split('\n').at(-1);

test('an installation that works: exit 0, the summary, and no Fix line', async (t) => {
  const f = await world(t);
  const code = await main(['doctor'], f.io);
  const text = f.output.join('\n');
  assert.equal(code, exitCodeFor('ok'), text);
  assert.match(text, /^okit-plugin doctor/m, text);
  // One row per thing it looked at, and the summary of the run at the end.
  assert.match(text, /Node version/, text);
  assert.match(text, /Installation/, text);
  assert.match(text, /MCP registration/, text);
  assert.match(text, /0 failed, [1-9]\d* to look at/, summaryOf(text));
  assert.doesNotMatch(text, /^ {6}Fix:/m, text);
});

test('no installation: exit 1 and a Fix line with the command that installs it', async (t) => {
  const f = await fixture(t);
  f.clear();
  const code = await main(['doctor'], f.io);
  const text = f.output.join('\n');
  assert.equal(code, exitCodeFor('operational'), text);
  assert.ok(text.includes(`Fix: Install it: ${unlinkedProgram(f)} install`), text);
  assert.match(text, /1 failed, [0-9]+ to look at/, summaryOf(text));
});

test('a state file that is not JSON: exit 1, a Fix line that names the file, and the file untouched', async (t) => {
  const f = await world(t, { inbox: 'not json' });
  const file = paths(f.root).inbox;
  const before = await fs.readFile(file);
  const code = await main(['doctor'], f.io);
  const text = f.output.join('\n');
  assert.equal(code, exitCodeFor('operational'), text);
  assert.match(text, new RegExp(`^ {6}Fix: .*${escape(file)}`, 'm'), text);
  assert.deepEqual(await fs.readFile(file), before, 'the doctor changed the file it read');
});

test('warnings only: exit 0, the mark of a warning, and the summary counting them', async (t) => {
  for (const locale of LOCALES) {
    const f = await world(t);
    const code = await main(['doctor', '--locale', locale], f.io);
    const text = f.output.join('\n');
    assert.equal(code, exitCodeFor('ok'), text);
    const mark = MARKS[locale];
    const lines = text.split('\n');
    const warned = lines.slice(0, -1).filter((line) => line.includes(mark));
    assert.ok(warned.length > 0, `no row of a warning in\n${text}`);
    const summary = SUMMARIES[locale].exec(summaryOf(text));
    assert.ok(summary, summaryOf(text));
    assert.equal(Number(summary[1]), 0, text);
    assert.equal(Number(summary[2]), warned.length, text);
  }
});

test('--client shows the rows of that client alone', async (t) => {
  const f = await world(t, { clients: ['claude-code', 'codex'] });
  const code = await main(['doctor', '--client', 'codex'], f.io);
  const text = f.output.join('\n');
  assert.equal(code, exitCodeFor('ok'), text);
  assert.match(text, /Codex: MCP registration/, text);
  assert.doesNotMatch(text, /Claude Code: MCP registration/, text);
  // The same client, in the other form of the flag.
  f.clear();
  assert.equal(await main(['doctor', '--client=codex'], f.io), exitCodeFor('ok'), f.output.join('\n'));
  assert.match(f.output.join('\n'), /Codex: MCP registration/, f.output.join('\n'));
});

test('an unknown client and an unknown flag are refused with exit 2, in the language of the run', async (t) => {
  for (const locale of LOCALES) {
    const f = await world(t);
    f.clear();
    assert.equal(await main(['doctor', '--client', 'nope', '--locale', locale], f.io), exitCodeFor('usage'), f.output.join('\n'));
    const refusal = f.output.join('\n');
    assert.match(refusal, locale === 'en' ? /Unknown flag: --client/ : /Opção desconhecida: --client/, refusal);
    f.clear();
    assert.equal(await main(['doctor', '--bogus', '--locale', locale], f.io), exitCodeFor('usage'), f.output.join('\n'));
    assert.match(f.output.join('\n'), locale === 'en' ? /Unknown flag: --bogus/ : /Opção desconhecida: --bogus/, f.output.join('\n'));
  }
});

test('--locale pt-BR prints the whole run in Portuguese', async (t) => {
  const f = await world(t);
  const code = await main(['doctor', '--locale', 'pt-BR'], f.io);
  const text = f.output.join('\n');
  assert.equal(code, exitCodeFor('ok'), text);
  assert.match(text, /doctor: o estado da instalação/, text);
  assert.match(text, /aviso/, text);
  assert.match(text, /falharam,/, text);
  assert.doesNotMatch(text, /to look at|Fix:/, text);
});

test('--verbose shows the quiet rows that the default hides', async (t) => {
  const f = await world(t);
  await main(['doctor'], f.io);
  const quiet = f.output.join('\n');
  f.clear();
  await main(['doctor', '--verbose'], f.io);
  const verbose = f.output.join('\n');
  // The rows the self-check skips quietly: the session hook of the client, for one.
  assert.doesNotMatch(quiet, /Session hook/, quiet);
  assert.match(verbose, /Session hook/, verbose);
  assert.ok(verbose.split('\n').length > quiet.split('\n').length, verbose);
});

test('a whole run leaves the state root byte for byte the same', async (t) => {
  const f = await world(t);
  // The record of a process that is gone: the doctor never prunes one.
  const pid = await deadPid();
  await writeRecord(f.root, { pid, endpoint: join(paths(f.root).control, `${pid}.sock`), token: 'tk', startedAt: 1 },
    { platform: 'linux' });
  const before = await listing(f.root);
  const code = await main(['doctor'], f.io);
  assert.deepEqual(await listing(f.root), before, 'the doctor wrote a file or removed a record');
  assert.equal(code, exitCodeFor('ok'), f.output.join('\n'));
});

test('doctor --help prints the usage with the doctor line', async (t) => {
  const f = await fixture(t);
  f.clear();
  const code = await main(['doctor', '--help'], f.io);
  const text = f.output.join('\n');
  assert.equal(code, exitCodeFor('ok'), text);
  assert.match(text, /^ {7}okit-plugin doctor \[--client <c>\] \[--verbose\] \[--locale en\|pt-BR\]/m, text);
});

test('the exit codes are the ones of the policy of the installer', async () => {
  assert.deepEqual([exitCodeFor('ok'), exitCodeFor('operational'), exitCodeFor('usage')], [0, 1, 2]);
});

test('a foreign MCP registration warns and prints its exact Fix on the next line', async (t) => {
  const f = await world(t);
  await f.io.run({ command: f.io.config.clients['claude-code'].executable,
    args: ['mcp', 'add', 'okit', '--', 'node', join(f.home, 'foreign-server.js')] });
  f.clear();
  assert.equal(await main(['doctor'], f.io), 0, f.output.join('\n'));
  const index = f.output.findIndex((line) => /Claude Code: MCP registration\s+warn\s/.test(line));
  assert.ok(index >= 0, f.output.join('\n'));
  assert.equal(f.output[index].trimEnd().split(/ {2,}/).at(-1),
    'the MCP server named okit in Claude Code is not ours, and the installer will not replace it');
  assert.equal(f.output[index + 1], '      Fix: Remove the entry by hand: claude mcp remove okit --scope user');
});

test('a record that cannot be read is a failed row, in both languages, and the other clients are still diagnosed', async (t) => {
  for (const locale of LOCALES) {
    const f = await world(t, { clients: ['claude-code', 'codex'] });
    const file = join(f.destination, 'install.codex.json');
    await fs.writeFile(file, '[]');
    f.clear();
    // The client whose record is broken is not diagnosed; the other one is.
    assert.equal(await main(['doctor', '--locale', locale], f.io), 1, f.output.join('\n'));
    const text = f.output.join('\n');
    const expected = locale === 'en'
      ? `installation record unreadable: ${file}`
      : `registro de instalação ilegível: ${file}`;
    assert.ok(text.includes(expected), text);
    const fix = locale === 'en'
      ? `Fix: Install it again: ${unlinkedProgram(f)} install --client codex`
      : `Correção: Instale de novo: ${unlinkedProgram(f)} install --client codex`;
    assert.ok(text.includes(fix), text);
    // The client whose record is whole is still diagnosed.
    assert.match(text, /Claude Code: /, text);
    assert.match(summaryOf(text), locale === 'en' ? /1 failed,/ : /1 falharam,/);
  }
});

test('the summary uses the failed mark for failures and the warn mark for warnings only', async (t) => {
  for (const locale of LOCALES) {
    for (const failed of [false, true]) {
      const f = await world(t, failed ? { inbox: 'not json' } : {});
      assert.equal(await main(['doctor', '--locale', locale], f.io), failed ? 1 : 0, f.output.join('\n'));
      const summary = summaryOf(f.output.join('\n'));
      const mark = locale === 'en' ? (failed ? 'failed' : 'warn') : (failed ? 'falhou' : 'aviso');
      const detail = locale === 'en'
        ? `${failed ? 1 : 0} failed, 3 to look at`
        : `${failed ? 1 : 0} falharam, 3 para olhar`;
      assert.match(summary, new RegExp(`^ +${mark} {${9 - mark.length}}${escape(detail)}$`), summary);
    }
  }
});

test('an all-ok summary counts every row including quiet rows, and ok/skipped fixes stay hidden even verbose', async (t) => {
  const f = await world(t);
  const file = join(f.destination, 'install.claude-code.json');
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  record.autostart = true;
  await fs.writeFile(file, JSON.stringify(record));
  const readers = {
    nodeVersion: () => 'v99.0.0',
    readText: (file) => fs.readFile(file, 'utf8'),
    servers: async () => [{ pid: 4242, startedAt: 1 }],
    callRead: async () => ({ ok: true }),
    daemon: async () => ({ running: true }),
    autostartPresent: async () => true,
    mcpEntry: async () => ({ state: 'registered' }),
    selfCheck: async () => [
      { id: 'version', status: 'pass', reason: 'version is right', fix: 'DO NOT PRINT OK FIX' },
      { id: 'hook', status: 'skip', reason: 'quiet hook', quiet: true, fix: 'DO NOT PRINT SKIPPED FIX' },
    ],
  };
  for (const locale of LOCALES) {
    const result = await diagnose({ ...f.io, records: [record], readers,
      ui: createPresenter({ locale, write: () => {} }) });
    assert.equal(result.failed, 0);
    assert.equal(result.warnings, 0);
    assert.equal(result.rows.length, 11);
    assert.equal(result.rows.filter((row) => row.quiet).length, 1);
    assert.equal(result.rows.find((row) => row.id === 'version').fix, 'DO NOT PRINT OK FIX');
    assert.equal(result.rows.find((row) => row.id === 'hook').fix, 'DO NOT PRINT SKIPPED FIX');
    for (const verbose of [false, true]) {
      f.clear();
      assert.equal(await doctorCommand(f.io, { locale, config: f.io.config, readers, verbose }), 0);
      const summary = summaryOf(f.output.join('\n'));
      const detail = locale === 'en' ? `everything looks right (${result.rows.length} checks)`
        : `tudo está certo (${result.rows.length} verificações)`;
      assert.match(summary, new RegExp(`^ +ok {7}${escape(detail)}$`), summary);
      const rows = f.output.slice(1, -1);
      assert.equal(rows.length, result.rows.length - (verbose ? 0 : 1));
      assert.equal(rows.some((line) => line.includes('quiet hook')), verbose);
      assert.doesNotMatch(f.output.join('\n'), /DO NOT PRINT|Fix:|Correção:/);
    }
  }
});

test('every verbose row and the summary align their marks across two clients', async (t) => {
  for (const locale of LOCALES) {
    const f = await world(t, { clients: ['claude-code', 'codex'] });
    assert.equal(await main(['doctor', '--verbose', '--locale', locale], f.io), 0);
    const rows = f.output.slice(1).filter((line) => !line.startsWith('      > '));
    assert.ok(rows.some((line) => line.includes('Claude Code:')), f.output.join('\n'));
    assert.ok(rows.some((line) => line.includes('Codex:')), f.output.join('\n'));
    const marks = locale === 'en' ? /\b(ok|skipped|warn|failed)\b/ : /\b(ok|pulado|aviso|falhou)\b/;
    const columns = rows.map((line) => {
      const match = marks.exec(line);
      assert.ok(match, `row has no mark: ${line}`);
      return match.index;
    });
    assert.ok(columns.length > 15, f.output.join('\n'));
    assert.ok(columns.every((column) => column === columns[0]), JSON.stringify(columns));
  }
});

test('help after other doctor flags prints usage and never diagnoses', async (t) => {
  for (const flags of [ ['--verbose', '--help'], ['--client', 'codex', '--help'], ['--help', '--locale', 'pt-BR'] ]) {
    const f = await fixture(t);
    f.clear();
    const reads = [];
    const readFile = f.io.fs.readFile.bind(f.io.fs);
    f.io.fs = { ...f.io.fs, readFile: async (file, ...args) => {
      reads.push(file);
      return readFile(file, ...args);
    } };
    assert.equal(await main(['doctor', ...flags], f.io), 0, f.output.join('\n'));
    const text = f.output.join('\n');
    assert.match(text, flags.includes('pt-BR')
      ? /^ {5}okit-plugin doctor \[--client <c>\] \[--verbose\] \[--locale en\|pt-BR\]/m
      : /^ {7}okit-plugin doctor \[--client <c>\] \[--verbose\] \[--locale en\|pt-BR\]/m);
    assert.match(text, flags.includes('pt-BR') ? /^uso: / : /^usage: /);
    assert.doesNotMatch(text, /doctor:|failed,|falharam,|everything looks right|tudo está certo/);
    assert.deepEqual(f.commands, []);
    assert.ok(!reads.includes(paths(f.root).inbox), `diagnosis read inbox: ${reads}`);
  }
});

// D109 step 5: the doctor tells the truth. A broken entry, a client that is not installed, a configuration that
// cannot be read: every one of them is a row of the diagnosis, never a silent success.

test('an entry that is broken is a failed row, with the fix that registers it again', async (t) => {
  for (const locale of LOCALES) {
    const f = await world(t);
    f.clear();
    const readers = { mcpEntry: async () => ({ state: 'broken', reason: 'disabled', command: '/other/node' }) };
    const code = await doctorCommand(f.io, { locale, config: f.io.config, readers });
    assert.equal(code, 1, f.output.join('\n'));
    const text = f.output.join('\n');
    assert.match(text, /MCP registration|Registro do MCP/, text);
    assert.match(text, locale === 'en' ? /the MCP entry of Claude Code is disabled in the client/
      : /a entrada MCP do Claude Code está desligada no cliente/, text);
    assert.ok(text.includes(`${locale === 'en' ? 'Fix: Register it:' : 'Correção: Registre:'} ${unlinkedProgram(f)} install --client claude-code`), text);
  }
});

test('a client that was named and is not installed is a failed row, with the command that installs it', async (t) => {
  for (const locale of LOCALES) {
    const f = await world(t, { clients: ['claude-code'] });
    f.clear();
    const code = await main(['doctor', '--client', 'codex', '--locale', locale], f.io);
    assert.equal(code, 1, f.output.join('\n'));
    const text = f.output.join('\n');
    assert.match(text, locale === 'en' ? /Installation\s+failed\s+Codex is not installed/
      : /Instalação\s+falhou\s+Codex não está instalado/, text);
    assert.ok(text.includes(`${locale === 'en' ? 'Fix: Install it:' : 'Correção: Instale:'} ${unlinkedProgram(f)} install --client codex`), text);
  }
});

test('a configuration that is not JSON does not stop the doctor: the row says what is wrong', async (t) => {
  const f = await world(t);
  await fs.writeFile(paths(f.root).config, '{not json at all');
  f.clear();
  const code = await main(['doctor'], f.io);
  const text = f.output.join('\n');
  assert.equal(code, 1, text);
  assert.match(text, /Configuration\s+failed/, text);
  assert.match(text, /^ {6}Fix: /m, text);
});

test('a setting of the installer that the runtime refuses does not stop the doctor: the row names the key', async (t) => {
  const f = await world(t);
  const file = paths(f.root).config;
  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  stored.install.kit = null;
  await fs.writeFile(file, JSON.stringify(stored));
  f.clear();
  const code = await main(['doctor'], f.io);
  const text = f.output.join('\n');
  assert.equal(code, 1, text);
  assert.match(text, /Configuration\s+failed\s+the configuration is not valid: Invalid install\.kit: /, text);
  assert.match(text, /^ {6}Fix: /m, text);
});

test('a setting of the whole configuration that the runtime refuses is a failed row too', async (t) => {
  const f = await world(t);
  const file = paths(f.root).config;
  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  stored.inbox = { gitTimeoutMs: 0 };
  await fs.writeFile(file, JSON.stringify(stored));
  f.clear();
  const code = await main(['doctor'], f.io);
  const text = f.output.join('\n');
  assert.equal(code, 1, text);
  assert.match(text, /Configuration\s+failed\s+the configuration is not valid: inbox\.gitTimeoutMs must be an integer >= 1$/m, text);
  assert.match(text, /^ {6}Fix: /m, text);
});

test('the installation row tells about the clients of the run alone: the version of another client is not in it', async (t) => {
  const f = await fixture(t);
  const records = [
    { client: 'claude-code', version: '1.0.0', path: join(f.destination, '1.0.0-claude-code'), bin: 'okit-plugin',
      autostart: false, settings: { node: process.execPath } },
    { client: 'codex', version: '2.0.0', path: join(f.destination, '2.0.0-codex'), bin: 'okit-plugin',
      autostart: false, settings: { node: process.execPath } },
  ];
  const readers = {
    nodeVersion: () => 'v99.0.0',
    readText: (file) => fs.readFile(file, 'utf8'),
    servers: async () => [],
    callRead: async () => ({ ok: false, error: 'no server of ours is running' }),
    daemon: async () => ({ running: true }),
    autostartPresent: async () => true,
    mcpEntry: async () => ({ state: 'registered' }),
    selfCheck: async () => [],
  };
  const result = await diagnose({ ...f.io, records, client: 'codex', readers,
    ui: createPresenter({ locale: 'en', write: () => {} }) });
  const row = result.rows.find((each) => each.id === 'install');
  assert.equal(row.status, 'ok', JSON.stringify(result.rows));
  // The version of the client that was chosen, and only it.
  assert.match(row.detail, /2\.0\.0/, row.detail);
  assert.doesNotMatch(row.detail, /1\.0\.0/, row.detail);
});

test('the doctor writes nothing outside the temporary folder of the caller: the state is byte for byte the same', async (t) => {
  const f = await world(t);
  const pid = await deadPid();
  await writeRecord(f.root, { pid, endpoint: join(paths(f.root).control, `${pid}.sock`), token: 'tk', startedAt: 1 },
    { platform: 'linux' });
  // Every write, every folder created and every removal is recorded, with the path it touched.
  const writes = [];
  const record = (path) => { writes.push(String(path)); };
  const fsSpy = {
    ...f.io.fs,
    writeFile: async (file, ...rest) => { record(file); return f.io.fs.writeFile(file, ...rest); },
    appendFile: async (file, ...rest) => { record(file); return f.io.fs.appendFile(file, ...rest); },
    mkdir: async (dir, ...rest) => { record(dir); return f.io.fs.mkdir(dir, ...rest); },
    rm: async (file, ...rest) => { record(file); return f.io.fs.rm(file, ...rest); },
    rename: async (from, to, ...rest) => { record(from); record(to); return f.io.fs.rename(from, to, ...rest); },
  };
  const before = await listing(f.root);
  const code = await main(['doctor'], { ...f.io, fs: fsSpy });
  assert.equal(code, 0, f.output.join('\n'));
  assert.deepEqual(await listing(f.root), before, 'the doctor wrote a file or removed a record');
  // Every path it touched is under the temporary folder of the caller (the folder of the check).
  assert.ok(writes.length > 0, 'the doctor touched nothing: the check did not run');
  for (const path of writes) {
    assert.ok(path.startsWith(f.scratch), `the doctor touched ${path}, outside the temporary folder`);
  }
  // And the folder of the check is gone.
  const left = await fs.readdir(f.scratch);
  assert.deepEqual(left, [], `the temporary folder holds ${left.join(', ')}`);
});

// D109 step 7: a state file that cannot be read is a row of the doctor, never a crash: the rows the doctor already
// has are still told, and the run ends with the failure of the row.

test('a daemon state file that is not JSON is a failed row, and the other rows are still told', async (t) => {
  for (const locale of LOCALES) {
    const f = await world(t);
    // The state file of the daemon is not JSON: the reader of the doctor refuses it.
    await fs.writeFile(join(f.root, 'daemon.pid.json'), 'not json');
    const before = await listing(f.root);
    f.clear();
    const code = await main(['doctor', '--locale', locale], f.io);
    const text = f.output.join('\n');
    assert.equal(code, exitCodeFor('operational'), text);
    // The row of the daemon failed, with the reason and the Fix that names the file.
    assert.match(text, locale === 'en'
      ? /Daemon\s+failed\s+the state file could not be read: /
      : /Daemon de fundo\s+falhou\s+o arquivo de estado não pôde ser lido: /, text);
    assert.match(text, locale === 'en' ? /^ {6}Fix: /m : /^ {6}Correção: /m, text);
    // The other rows are still there.
    assert.match(text, locale === 'en' ? /Node version\s+ok/ : /Versão do Node\s+ok/, text);
    assert.match(text, locale === 'en' ? /Installation\s+ok/ : /Instalação\s+ok/, text);
    assert.match(summaryOf(text), locale === 'en' ? /1 failed,/ : /1 falharam,/);
    // The state of the person is the same as it was: the doctor only reads.
    assert.deepEqual(await listing(f.root), before, 'the doctor wrote a file or removed one');
  }
});

test('a session reader that fails is a failed row, never a crash', async (t) => {
  const f = await world(t);
  f.clear();
  const code = await doctorCommand(f.io, { locale: 'en', config: f.io.config,
    readers: { servers: async () => { throw Object.assign(new Error('the control folder cannot be read'), { path: join(f.root, 'control') }); } } });
  const text = f.output.join('\n');
  assert.equal(code, exitCodeFor('operational'), text);
  assert.match(text, /Session\s+failed\s+the state file could not be read: the control folder cannot be read/, text);
  // The Fix names the file the failure names.
  assert.match(text, new RegExp(`^ {6}Fix: .*${escape(join(f.root, 'control'))}`, 'm'), text);
  // The other rows are still there.
  assert.match(text, /Installation\s+ok/, text);
});

test('the doctor of the command line works in Portuguese too, when a state file cannot be read', async (t) => {
  const f = await world(t);
  await fs.writeFile(join(f.root, 'daemon.pid.json'), 'not json');
  f.clear();
  const code = await doctorCommand(f.io, { locale: 'pt-BR', config: f.io.config,
    readers: { servers: async () => { throw new Error('the control folder cannot be read'); } } });
  const text = f.output.join('\n');
  assert.equal(code, exitCodeFor('operational'), text);
  assert.match(text, /Sessão\s+falhou\s+o arquivo de estado não pôde ser lido/, text);
  assert.doesNotMatch(text, /the state file could not be read/, text);
});

// D109 step 7: the doctor is the tool that diagnoses a broken stored state, so a saved language that is not a
// language is a row of it, never a stop. Only a `--locale` that is not a language is a refusal of usage.

test('a saved language that is not a language is a row of the doctor, not a refusal', async (t) => {
  const f = await world(t);
  const file = paths(f.root).config;
  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  stored.language = 'xx';
  await fs.writeFile(file, JSON.stringify(stored));
  f.clear();
  const code = await main(['doctor'], f.io);
  const text = f.output.join('\n');
  // The run happened: it failed because of that row, never with the refusal of a usage.
  assert.equal(code, exitCodeFor('operational'), text);
  assert.doesNotMatch(text, /Choose a language/, text);
  // The row of the configuration says what is wrong, and how to correct it.
  assert.match(text, /Configuration\s+failed\s+the saved language is not valid: xx/, text);
  // The Fix is a manual edit of the file (`config set` itself refuses while the saved language is not one): it names the file.
  assert.ok(text.includes(`Fix: Edit ${file}: set "language" to one of en, pt-BR (or remove the key), then run: ${unlinkedProgram(f)} doctor`), text);
  // The other rows are still told, in the language the run decided (English: the saved one is not a language).
  assert.match(text, /Node version\s+ok/, text);
  assert.match(text, /Installation\s+ok/, text);
  // Doing what the Fix says repairs the row.
  delete stored.language;
  await fs.writeFile(file, JSON.stringify(stored));
  f.clear();
  const again = await main(['doctor'], f.io);
  assert.doesNotMatch(f.output.join('\n'), /saved language is not valid/, f.output.join('\n'));
  assert.equal(again, exitCodeFor('ok'), f.output.join('\n'));
});

test('a saved language that is not a language does not stop the doctor in the language of the flag', async (t) => {
  const f = await world(t);
  const file = paths(f.root).config;
  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  stored.language = 'xx';
  await fs.writeFile(file, JSON.stringify(stored));
  f.clear();
  const code = await main(['doctor', '--locale', 'pt-BR'], f.io);
  const text = f.output.join('\n');
  assert.equal(code, exitCodeFor('operational'), text);
  // The whole run is in Portuguese, and the row of the configuration says so in Portuguese too.
  assert.match(text, /doctor: o estado da instalação/, text);
  assert.match(text, /Configuração\s+falhou\s+o idioma salvo não é válido: xx/, text);
  assert.doesNotMatch(text, /the saved language is not valid/, text);
});

test('a --locale that is not a language is still a refusal of usage', async (t) => {
  const f = await world(t);
  f.clear();
  // The flag is not a language: the run is refused, as it always was.
  assert.equal(await main(['doctor', '--locale', 'xx'], f.io), exitCodeFor('usage'), f.output.join('\n'));
  assert.match(f.output.join('\n'), /Choose a language: en, pt-BR\./);
});

test('the other commands still refuse a saved language that is not a language', async (t) => {
  const f = await world(t);
  const file = paths(f.root).config;
  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  stored.language = 'xx';
  await fs.writeFile(file, JSON.stringify(stored));
  for (const command of [['install', '--client', 'claude-code', '--dry-run'], ['update'], ['uninstall'], ['setup', '--defaults']]) {
    f.clear();
    assert.equal(await main(command, f.io), exitCodeFor('usage'), `${command[0]}: ${f.output.join('\n')}`);
  }
});



// D109 step 6a: the doctor finds the installation that is running, when the records are in the folder above the
// package directory (the installation is `<destination>/<version>-<client>` and keeps its records in `<destination>`).

test('the doctor finds the installation that is running, when the records are in the folder above it', async (t) => {
  const f = await fixture(t);
  const pkg = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, '');
  const above = dirname(pkg);
  // The version of the package that is running: the record of the installation that is running names it.
  const version = JSON.parse(await fs.readFile(join(pkg, 'package.json'), 'utf8')).version;
  const record = { client: 'claude-code', version, path: pkg, bin: 'src/cli.js', autostart: false,
    link: false, linkDirectory: null, settings: { node: process.execPath } };
  const extra = new Map([[join(above, 'install.claude-code.json'), JSON.stringify(record)]]);
  const read = f.io.fs.readFile.bind(f.io.fs);
  f.clear();
  await main(['doctor'], { ...f.io, fs: { ...f.io.fs,
    readFile: async (file, ...rest) => (extra.has(file) ? extra.get(file) : read(file, ...rest)) } });
  const text = f.output.join('\n');
  // The installation is found: the row of the installation is not the row of a machine with no installation.
  assert.match(text, new RegExp(`Installation\\s+ok\\s+installed ${version.replace(/\./g, '\\.')}`), text);
  assert.doesNotMatch(text, /no installation record was found/, text);
});

test('doctor client filter checks the shared autostart against both installed clients', async (t) => {
  const f = await world(t, { clients: ['claude-code', 'codex'] });
  const { autostartPlan } = await import('../src/autostart.js');
  for (const client of ['claude-code', 'codex']) {
    const file = join(f.destination, `install.${client}.json`);
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, JSON.stringify({ ...record, autostart: true }));
    if (client === 'codex') {
      const plan = autostartPlan('systemd', { root: f.root, home: f.home, node: process.execPath,
        script: join(record.path, record.bin), command: f.io.config.command });
      await fs.mkdir(dirname(plan.path), { recursive: true });
      await fs.writeFile(plan.path, plan.content);
    }
  }
  await fs.writeFile(join(f.root, 'daemon.pid.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  const originalRun = f.io.run;
  f.io.run = async (command) => command.command === 'systemctl'
    ? { stdout: 'enabled\n' } : originalRun(command);
  for (const args of [['doctor'], ['doctor', '--client', 'claude-code']]) {
    f.clear();
    assert.equal(await main(args, f.io), exitCodeFor('ok'), f.output.join('\n'));
    assert.match(f.output.join('\n'), /Autostart\s+ok\s/);
  }
});
