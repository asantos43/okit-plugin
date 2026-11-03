import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { diagnose } from '../src/doctor/diagnose.js';
import { installConfig } from '../src/install/config.js';
import { createPresenter } from '../src/install/present.js';
import { quotedWord, shown } from '../src/install/mcp-register.js';

// D111: the `Fix:` of a row of the doctor is the command the person runs. It is written for the shell of the platform,
// so a command or a path with a space, a quote or a `$` in it is runnable as it is shown.
//
// The proof is a real parser: the shell itself reads the rendered line and gives back the words it meant. The words
// of a line are read with `eval "set -- $1"`, so the shell parses the line exactly as it would parse it typed.

/** The words a POSIX shell reads from a command line: the shell is the parser. */
const argvOf = (line) => {
  const printed = execFileSync('sh', ['-c', 'eval "set -- $1"; printf "%s\\0" "$@"', 'sh', line], { encoding: 'utf8' });
  const words = printed.split('\0');
  words.pop();
  return words;
};

/**
 * The words a PowerShell line has: a single-quoted string (a quote in it is doubled) and a bare word. PowerShell is
 * not installed in every machine, so its own parser is the one of its rules, written here.
 */
const powershellWords = (line) => {
  const words = [];
  let index = 0;
  while (index < line.length) {
    if (line[index] === ' ') { index += 1; continue; }
    if (line[index] !== "'") {
      let word = '';
      while (index < line.length && line[index] !== ' ') { word += line[index]; index += 1; }
      words.push(word);
      continue;
    }
    index += 1;
    let word = '';
    for (;;) {
      assert.ok(index < line.length, `the string of ${line} is not closed`);
      if (line[index] === "'") {
        if (line[index + 1] === "'") { word += "'"; index += 2; continue; }
        index += 1;
        break;
      }
      word += line[index];
      index += 1;
    }
    words.push(word);
  }
  return words;
};

// The words the doctor has to write for a person: the ones a shell would read differently.
const VALUES = ['a folder with a space', "a 'quote'", 'a "quote"', 'a $dollar', ''];

test('every word a doctor row carries is read back by the shell exactly as it was written', () => {
  for (const value of VALUES) {
    const line = quotedWord(value, 'linux');
    assert.deepEqual(argvOf(line), [value], line);
    // The word of PowerShell is read back by its own rules.
    assert.deepEqual(powershellWords(quotedWord(value, 'win32')), [value], quotedWord(value, 'win32'));
  }
});

test('a word with no special character stays bare', () => {
  assert.equal(quotedWord('okit-plugin', 'linux'), 'okit-plugin');
  assert.equal(quotedWord('/usr/bin/node', 'linux'), '/usr/bin/node');
  assert.equal(quotedWord('okit-plugin', 'win32'), 'okit-plugin');
  // A path of Windows keeps its backslashes when it needs no quoting.
  assert.equal(quotedWord('C:\\Program Files\\node.exe', 'linux'), "'C:\\Program Files\\node.exe'");
  assert.equal(quotedWord('C:\\node\\node.exe', 'win32'), 'C:\\node\\node.exe');
});

test('the argv of a command is written word by word, and the program of PowerShell is called with the operator', () => {
  assert.equal(shown(['okit-plugin', 'install', '--client', 'claude-code'], 'linux'), 'okit-plugin install --client claude-code');
  assert.equal(shown(['my plugin', 'install'], 'linux'), "'my plugin' install");
  // On PowerShell a quoted program is a string: the call operator is what runs it.
  assert.equal(shown(['my plugin', 'install'], 'win32'), "& 'my plugin' install");
  assert.equal(shown(['okit-plugin', 'install'], 'win32'), 'okit-plugin install');
});

/**
 * The world of a run of the doctor: the input of the diagnosis, with the readers that answer.
 *
 * @param {object} options the records, the files, the readers and the command of the run
 */
async function world({ records = [], files = {}, readers = {}, command = 'okit-plugin', root = '/state', onPath = true } = {}) {
  const lines = [];
  const ui = createPresenter({ locale: 'en', write: (line) => lines.push(line) });
  const all = new Map(Object.entries(files));
  const missing = (file) => Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: 'ENOENT' });
  const fake = {
    nodeVersion: () => 'v22.0.0',
    readText: async (file) => { if (all.has(file)) return all.get(file); throw missing(file); },
    servers: async () => [],
    callRead: async () => ({ ok: true }),
    daemon: async () => ({ running: true }),
    autostartPresent: async () => true,
    selfCheck: async () => [],
    mcpEntry: async () => ({ state: 'registered' }),
  };
  return {
    input: {
      root, config: installConfig(), records, ui, command, platform: 'linux', env: { HOME: '/home', PATH: onPath ? '/proven-bin' : '' }, home: '/home',
      fs: { readFile: async (file, ...rest) => fs.readFile(file, ...rest), access: async (file, mode) => { if (onPath && file.startsWith('/proven-bin/')) return; return fs.access(file, mode); } },
      run: async () => ({ code: 0, stdout: '' }), now: () => Date.now(),
      readers: { ...fake, ...readers },
    },
    lines,
  };
}

const rowOf = (result, id) => result.rows.find((row) => row.id === id);

test('the command of the Fix of a row is read back by the shell exactly as it was written', async () => {
  for (const value of VALUES) {
    const { input } = await world({ command: value });
    const result = await diagnose(input);
    const row = rowOf(result, 'install');
    assert.equal(row.status, 'failed');
    // The Fix of the row names the command: the words after the colon are the command line.
    const line = row.fix.slice(row.fix.indexOf(': ') + 2);
    // An empty command cannot be found on the PATH: the running CLI is the program.
    assert.deepEqual(argvOf(line), value === '' ? [process.execPath, RUNNING_CLI, 'install'] : [join('/proven-bin', value), 'install'], line);
  }
});

test('the path of the Fix of a row is read back by the shell exactly as it was written', async () => {
  for (const value of VALUES) {
    const root = join('/state', value);
    const file = join(root, 'inbox.json');
    const { input } = await world({ root, files: { [file]: 'not json' } });
    const result = await diagnose(input);
    const row = rowOf(result, 'inbox');
    assert.equal(row.status, 'failed', JSON.stringify(row));
    // The Fix names the file of the row: the words between the parenthesis are the path.
    const found = /\((.*)\), then run:/.exec(row.fix);
    assert.ok(found, row.fix);
    assert.deepEqual(argvOf(found[1]), [file], row.fix);
  }
});

// Exercise every program position emitted by the doctor, including unreadable rows.
test('all doctor Fix programs use the PowerShell call operator', async () => {
  const record = { client: 'codex', path: '/payload', bin: 'src/cli.js', autostart: true };
  const scenarios = [
    {}, { client: 'a client' },
    { records: [record], invalid: [{ file: '/bad', client: 'a client' }, { file: '/bad' }] },
  ];
  const fixes = [];
  for (const scenario of scenarios) {
    for (const unreadable of [false, true]) {
      const { input } = await world({ command: 'my plugin', files: { '/state/config.json': '{', '/state/inbox.json': '{' },
        readers: {
          nodeVersion: () => 'v1.0.0', mcpEntry: async () => ({ state: 'absent' }),
          autostartPresent: async () => false, daemon: async () => ({ running: false }),
          servers: async () => { if (unreadable) throw new Error('unreadable'); return []; },
        } });
      const result = await diagnose({ ...input, ...scenario, platform: 'win32' });
      fixes.push(...result.rows.flatMap((row) => row.fix ? [row.fix] : []));
    }
  }
  assert.ok(fixes.length > 10);
  for (const fix of fixes) {
    for (const match of fix.matchAll(/'\/proven-bin\/my plugin.exe'/g)) {
      assert.equal(fix.slice(match.index - 2, match.index), '& ', fix);
      const line = fix.slice(match.index - 2);
      assert.deepEqual(powershellWords(line).slice(0, 2), ['&', '/proven-bin/my plugin.exe'], fix);
    }
  }
});

test('a bare registered node becomes the absolute executable in the doctor plan and Fix', async () => {
  const record = { client: 'codex', path: '/payload', bin: 'src/cli.js', settings: { node: 'node' }, autostart: true };
  const plans = [];
  const { input } = await world({ onPath: false, records: [record], files: { '/payload/src/cli.js': '// installed CLI' }, readers: { autostartPresent: async (plan) => { plans.push(plan); return false; } } });
  const row = rowOf(await diagnose(input), 'autostart');
  assert.ok(plans[0].content.includes('"' + process.execPath + '"'));
  assert.ok(row.fix.includes(shown([process.execPath, '/payload/src/cli.js', 'daemon', 'start'], 'linux')), row.fix);
});

test('an unidentified legacy script supplies neither a plan nor a false missing diagnosis', async () => {
  const plans = [];
  const { input } = await world({ records: [{ client: 'codex', path: '/payload', autostart: true }],
    readers: { autostartPresent: async (plan) => { plans.push(plan); return true; } } });
  const row = rowOf(await diagnose(input), 'autostart');
  assert.deepEqual(plans, []);
  assert.equal(row.status, 'skipped');
  assert.equal(row.fix.includes('daemon start'), false);
  assert.equal(row.detail.includes('not set up'), false);
});

for (const command of ['my=plugin', '%plugin']) {
  for (const platform of ['linux', 'win32']) {
    test(`Fix quotes the program ${command} on ${platform}`, async () => {
      const { input } = await world({ command });
      const result = await diagnose({ ...input, platform });
      const row = rowOf(result, 'install');
      const line = row.fix.slice(row.fix.indexOf(': ') + 2);
      const found = `/proven-bin/${command}${platform === 'win32' ? '.exe' : ''}`;
      assert.equal(line, shown([found, 'install'], platform));
      assert.deepEqual(platform === 'win32' ? powershellWords(line) : argvOf(line),
        platform === 'win32' && line.startsWith('& ') ? ['&', found, 'install'] : [found, 'install']);
      assert.equal(shown([command, '--dest=/x', '%argument'], platform),
        `${platform === 'win32' ? '& ' : ''}'${command}' --dest=/x %argument`);
      assert.equal(quotedWord(command, platform), command);
    });
  }
}

for (const command of ['my=plugin', 'if', 'then', 'elif', 'repeat', 'nocorrect', 'printf']) {
  test(`the Fix really executes the configured program ${command}`, async (t) => {
    const folder = await fs.mkdtemp(join(tmpdir(), 'reserved-'));
    t.after(() => fs.rm(folder, { recursive: true, force: true }));
    await fs.writeFile(join(folder, command), '#!/bin/sh\nprintf "external-marker:%s\\n" "$@"\n', { mode: 0o755 });
    await fs.chmod(join(folder, command), 0o755);
    const { input } = await world({ command, onPath: false });
    await fs.symlink(process.execPath, join(folder, 'node'));
    input.env.PATH = folder;
    input.fs = fs;
    const row = rowOf(await diagnose(input), 'install');
    const line = row.fix.slice(row.fix.indexOf(': ') + 2);
    assert.equal(line, shown([join(folder, command), 'install'], 'linux'));
    assert.equal(execFileSync('sh', ['-c', line], {
      encoding: 'utf8', env: { ...process.env, PATH: `${folder}:${process.env.PATH}` },
    }), 'external-marker:install\n');
    assert.equal(line, shown([join(folder, command), 'install'], 'linux'));
  });
}

for (const command of ['foreach', 'if']) {
  test(`PowerShell calls reserved program ${command}`, async () => {
    const { input } = await world({ command });
    const row = rowOf(await diagnose({ ...input, platform: 'win32' }), 'install');
    assert.ok(row.fix.endsWith(shown([`/proven-bin/${command}.exe`, 'install'], 'win32')), row.fix);
  });
}

test('reserved vocabulary is exact and only applies to the program on its platform', () => {
  assert.equal(shown(['IF', 'if'], 'linux'), 'IF if');
  assert.equal(shown(['try', 'if'], 'linux'), 'try if');
  assert.equal(shown(['then', 'if'], 'win32'), 'then if');
});

for (const platform of ['linux', 'win32']) {
  test(`all doctor repair programs use the running CLI without PATH on ${platform}`, async () => {
    const node = platform === 'win32' ? 'C:/Program Files/Node/node.exe' : '/opt/Node Dir/node';
    const record = { client: 'codex', path: '/payload', bin: 'src/cli.js', link: false, settings: { node }, autostart: true };
    const prefix = shown([process.execPath, RUNNING_CLI], platform);
    const seen = new Set();
    for (const unreadable of [false, true]) {
      const { input } = await world({ onPath: false, records: [record], files: { '/payload/src/cli.js': '// installed CLI', '/state/config.json': '{', '/state/inbox.json': '{' }, readers: {
        nodeVersion: () => { if (unreadable) throw new Error('node unavailable'); return 'v1.0.0'; },
        mcpEntry: async () => ({ state: 'absent' }), autostartPresent: async () => false,
        daemon: async () => { if (unreadable) throw new Error('unreadable'); return { running: false }; },
        servers: async () => { if (unreadable) throw new Error('unreadable'); return []; },
      } });
      const result = await diagnose({ ...input, platform, client: unreadable ? 'codex' : undefined,
        invalid: [{ file: '/bad', client: 'codex' }] });
      for (const row of result.rows.filter((row) => row.fix)) {
        seen.add(row.id);
        assert.ok(row.fix.includes(`${prefix} `), `${row.id}: ${row.fix}`);
        assert.ok(!row.fix.includes('okit-plugin '), row.fix);
      }
    }
    for (const id of ['node', 'record', 'registration', 'config', 'inbox', 'session', 'daemon', 'autostart']) assert.ok(seen.has(id), id);
    const { input } = await world({ onPath: false, records: [record], files: { '/payload/src/cli.js': '// installed CLI' } });
    const install = rowOf(await diagnose({ ...input, platform, client: 'missing' }), 'install');
    // Filtering rows does not change the running CLI fallback.
    assert.ok(install.fix.includes(`${prefix} install`), install.fix);
  });

  test(`records of every shape use the command proven on PATH on ${platform}`, async () => {
    for (const records of [[], [{ client: 'codex', link: true, path: '/payload', bin: 'cli.js' }],
      [{ client: 'codex', link: false, path: '/payload', bin: 'cli.js' }, { client: 'claude-code', link: true }]]) {
      const { input } = await world({ records, readers: { nodeVersion: () => { throw new Error('bad node'); } } });
      assert.ok(rowOf(await diagnose({ ...input, platform }), 'node').fix.includes('okit-plugin '));
    }
  });
}

for (const command of ['IF', 'Foreach', '123', '1e3', '-x', '.hidden', '+x', '@x', ':x']) {
  test(`positive program rule quotes ${command} in PowerShell`, () => {
    assert.equal(shown([command, command], 'win32'), `& '${command}' ${command}`);
  });
}

test('positive program rule preserves POSIX case and quotes numeric initials', () => {
  assert.equal(shown(['IF', '123'], 'linux'), 'IF 123');
  assert.equal(shown(['123', 'install'], 'linux'), "'123' install");
  assert.equal(shown(['/usr/bin/node', '-x'], 'linux'), '/usr/bin/node -x');
  assert.equal(shown(['C:\\Program Files\\node.exe', 'install'], 'win32'), "& 'C:\\Program Files\\node.exe' install");
});

const RUNNING_CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const unlinked = (path, client = 'codex') => ({ client, path, bin: 'src/cli.js', link: false, settings: { node: 'node' } });
const brokenNode = { nodeVersion: () => { throw new Error('bad node'); } };

function assertProgram(row, words, platform = 'linux') {
  const line = row.fix.slice(row.fix.indexOf(': ') + 2);
  assert.ok(line.startsWith(`${shown(words, platform)} `), row.fix);
}

test('client filter does not change the running CLI fallback', async () => {
  const record = { client: 'codex', version: '1.0', destination: '/custom', bin: 'src/cli.js', link: false };
  const script = '/custom/1.0-codex/src/cli.js';
  const { input } = await world({ onPath: false, records: [record], files: { [script]: '// CLI' }, readers: brokenNode });
  const result = await diagnose({ ...input, client: 'claude-code' });
  for (const row of result.rows.filter((row) => row.fix)) assertProgram(row, [process.execPath, RUNNING_CLI]);
  assert.ok(rowOf(result, 'install').fix.includes('--client claude-code'));
  assert.equal(result.rows.some((row) => row.client === 'codex'), false);
});

test('missing empty or unreadable installed scripts use the running package CLI', async () => {
  const folder = await fs.mkdtemp(join(tmpdir(), 'missing-fix-'));
  try {
    const script = join(folder, 'src/cli.js');
    await fs.mkdir(join(folder, 'src'));
    await fs.writeFile(script, '// CLI');
    await fs.unlink(script);
    for (const files of [{}, { [script]: '' }, { [script]: '   \n' }]) {
      const { input } = await world({ onPath: false, records: [unlinked(folder)], files, readers: brokenNode });
      const row = rowOf(await diagnose(input), 'node');
      assertProgram(row, [process.execPath, RUNNING_CLI]);
      assert.ok(!row.fix.includes(script), row.fix);
    }
    // The fallback is an existing CLI that actually runs.
    assert.ok((await fs.readFile(RUNNING_CLI, 'utf8')).trim());
    const { main } = await import(RUNNING_CLI);
    const output = [];
    await main(['--help'], { root: folder, stdout: (line) => output.push(line) });
    assert.match(output.join('\n'), /doctor/);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

for (const platform of ['linux', 'win32']) {
  for (const records of [[], [{ client: 'codex', link: true, path: '/deleted-shim' }],
    [{ ...unlinked('/payload'), settings: { node: '/deleted-node' } }]]) {
    test(`PATH alone proves the repair program on ${platform}: ${JSON.stringify(records)}`, async () => {
      const { input } = await world({ records, onPath: false, readers: brokenNode });
      for (const env of [{}, { PATH: '' }, { Path: '/missing' }]) {
        assertProgram(rowOf(await diagnose({ ...input, env, platform }), 'node'), [process.execPath, RUNNING_CLI], platform);
      }
      const probes = [];
      const config = { ...input.config, pathExtensions: ['.cmd'] };
      const env = platform === 'win32' ? { pAtH: '/missing;/proven-bin' } : { PATH: '/missing:/proven-bin' };
      const fs = { ...input.fs, access: async (file, mode) => {
        probes.push([file, mode]);
        if (['okit-plugin', 'node'].some((command) => file === `/proven-bin/${command}${platform === 'win32' ? '.cmd' : ''}`)) return;
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      } };
      assertProgram(rowOf(await diagnose({ ...input, config, env, fs, platform }), 'node'), ['okit-plugin'], platform);
      assert.equal(probes.filter(([file]) => file.startsWith('/missing/') || file.startsWith('/proven-bin/')).length, 4);
    });
  }
}

for (const command of ['elif', 'repeat', 'nocorrect']) {
  test(`POSIX quotes reserved program ${command} found on PATH`, async () => {
    const { input } = await world({ command });
    assert.equal(rowOf(await diagnose(input), 'install').fix, `Install it: ${shown([`/proven-bin/${command}`, 'install'], 'linux')}`);
    assert.equal(shown([command, command], 'linux'), `'${command}' ${command}`);
  });
}

for (const platform of ['linux', 'win32']) {
  test(`a deleted PATH shim cannot supply a repair program on ${platform}`, async (t) => {
    const folder = await fs.mkdtemp(join(tmpdir(), 'deleted-shim-'));
    t.after(() => fs.rm(folder, { recursive: true, force: true }));
    const shim = join(folder, `okit-plugin${platform === 'win32' ? '.cmd' : ''}`);
    await fs.symlink(process.execPath, join(folder, platform === 'win32' ? 'node.cmd' : 'node'));
    await fs.writeFile(shim, '#!/bin/sh\n');
    await fs.chmod(shim, 0o755);
    const { input } = await world({ onPath: false, readers: brokenNode });
    Object.assign(input, { platform, fs, env: platform === 'win32' ? { pAtH: folder } : { PATH: folder } });
    assertProgram(rowOf(await diagnose(input), 'node'), ['okit-plugin'], platform);
    await fs.unlink(shim);
    for (const records of [[], [{ client: 'codex', link: true, settings: { node: join(folder, 'deleted-node') } }]]) {
      assertProgram(rowOf(await diagnose({ ...input, records }), 'node'), [process.execPath, RUNNING_CLI], platform);
    }
  });
}

for (const command of ['foreach', 'end']) {
  test(`POSIX quotes the zsh reserved program ${command}`, () => {
    assert.equal(shown([command, 'install'], 'linux'), `'${command}' install`);
  });
}

test('a folder with the name of the command on the PATH is not the command, and a PATH that cannot be probed proves nothing', async (t) => {
  const folder = await fs.mkdtemp(join(tmpdir(), 'folder-command-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  await fs.mkdir(join(folder, 'okit-plugin'), { mode: 0o755 });
  const { input } = await world({ onPath: false, readers: brokenNode });
  Object.assign(input, { env: { PATH: folder }, fs });
  assertProgram(rowOf(await diagnose(input), 'node'), [process.execPath, RUNNING_CLI]);
  await fs.symlink(process.execPath, join(folder, 'node'));
  // A real file with the name does prove it.
  await fs.rm(join(folder, 'okit-plugin'), { recursive: true });
  await fs.writeFile(join(folder, 'okit-plugin'), '#!/bin/sh\n', { mode: 0o755 });
  assertProgram(rowOf(await diagnose(input), 'node'), ['okit-plugin']);
  // An error that is not "not found" while probing does not crash the doctor.
  const broken = { ...fs, access: async () => { throw Object.assign(new Error('loop'), { code: 'ELOOP' }); } };
  assertProgram(rowOf(await diagnose({ ...input, fs: broken }), 'node'), [process.execPath, RUNNING_CLI]);
});

for (const platform of ['linux', 'win32']) {
  test(`a PATH launcher needs Node on PATH on ${platform}`, async (t) => {
    const folder = await fs.mkdtemp(join(tmpdir(), 'launcher-node-'));
    t.after(() => fs.rm(folder, { recursive: true, force: true }));
    const extension = platform === 'win32' ? '.cmd' : '';
    await fs.writeFile(join(folder, `okit-plugin${extension}`), '#!/usr/bin/env node\n', { mode: 0o755 });
    const { input } = await world({ onPath: false, readers: brokenNode });
    Object.assign(input, { platform, fs, env: { PATH: folder } });
    assertProgram(rowOf(await diagnose(input), 'node'), [process.execPath, RUNNING_CLI], platform);
    const node = join(folder, `node${extension}`);
    await fs.symlink(process.execPath, node);
    assertProgram(rowOf(await diagnose(input), 'node'), [input.config.command], platform);
    const unreadable = { ...fs, access: async (file, mode) => {
      if (file === node) throw Object.assign(new Error('loop'), { code: 'ELOOP' });
      return fs.access(file, mode);
    } };
    assertProgram(rowOf(await diagnose({ ...input, fs: unreadable }), 'node'), [process.execPath, RUNNING_CLI], platform);
  });
}

test('only the package default stays bare; a builtin name uses the found file', async () => {
  const { input } = await world({ command: 'printf' });
  const row = rowOf(await diagnose(input), 'install');
  assert.equal(row.fix, `Install it: ${shown(['/proven-bin/printf', 'install'], 'linux')}`);
  const standard = await world({ command: installConfig().command });
  assert.equal(rowOf(await diagnose(standard.input), 'install').fix, `Install it: ${installConfig().command} install`);
});

test('a relative PATH entry yields an absolute Fix that runs the printf launcher', { skip: process.platform === 'win32' }, async (t) => {
  const folder = await fs.mkdtemp(join(tmpdir(), 'relative-launcher-'));
  const previous = process.cwd();
  t.after(async () => { process.chdir(previous); await fs.rm(folder, { recursive: true, force: true }); });
  await fs.writeFile(join(folder, 'printf'), '#!/bin/sh\n/usr/bin/printf "relative-launcher:%s" "$1"\n', { mode: 0o755 });
  await fs.symlink(process.execPath, join(folder, 'node'));
  process.chdir(folder);
  const { input } = await world({ command: 'printf' });
  const row = rowOf(await diagnose({ ...input, fs, env: { PATH: '.' } }), 'install');
  const line = row.fix.slice('Install it: '.length);
  assert.equal(line, shown([join(folder, 'printf'), 'install'], 'linux'));
  assert.deepEqual(argvOf(line), [join(folder, 'printf'), 'install']);
  assert.equal(execFileSync('sh', ['-c', line], { encoding: 'utf8' }), 'relative-launcher:install');
});


test('relative PATH repair programs are absolute even with an injected filesystem', async () => {
  const { input } = await world({ command: 'printf' });
  const fake = { access: async (file) => {
    if (!['printf', 'node'].includes(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  } };
  const row = rowOf(await diagnose({ ...input, fs: fake, env: { PATH: '.' } }), 'install');
  assert.equal(row.fix, `Install it: ${shown([join(process.cwd(), 'printf'), 'install'], 'linux')}`);
});
