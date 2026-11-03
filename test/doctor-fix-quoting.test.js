import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
async function world({ records = [], files = {}, readers = {}, command = 'okit-plugin', root = '/state' } = {}) {
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
      root, config: installConfig(), records, ui, command, platform: 'linux', env: { HOME: '/home' }, home: '/home',
      fs: { readFile: async (file, ...rest) => fs.readFile(file, ...rest), access: async (file) => fs.access(file) },
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
    assert.deepEqual(argvOf(line), [value, 'install'], line);
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
    for (const match of fix.matchAll(/'my plugin'/g)) {
      assert.equal(fix.slice(match.index - 2, match.index), '& ', fix);
      const line = fix.slice(match.index - 2);
      assert.deepEqual(powershellWords(line).slice(0, 2), ['&', 'my plugin'], fix);
    }
  }
});

test('a bare registered node becomes the absolute executable in the doctor plan and Fix', async () => {
  const record = { client: 'codex', path: '/payload', bin: 'src/cli.js', settings: { node: 'node' }, autostart: true };
  const plans = [];
  const { input } = await world({ records: [record], readers: { autostartPresent: async (plan) => { plans.push(plan); return false; } } });
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
      assert.equal(line, `${platform === 'win32' ? '& ' : ''}'${command}' install`);
      assert.deepEqual(platform === 'win32' ? powershellWords(line) : argvOf(line),
        platform === 'win32' ? ['&', command, 'install'] : [command, 'install']);
      assert.equal(shown([command, '--dest=/x', '%argument'], platform),
        `${platform === 'win32' ? '& ' : ''}'${command}' --dest=/x %argument`);
      assert.equal(quotedWord(command, platform), command);
    });
  }
}

for (const command of ['my=plugin', 'if', 'then']) {
  test(`the Fix really executes the configured program ${command}`, async (t) => {
    const folder = await fs.mkdtemp(join(tmpdir(), 'reserved-'));
    t.after(() => fs.rm(folder, { recursive: true, force: true }));
    await fs.writeFile(join(folder, command), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const { input } = await world({ command });
    const row = rowOf(await diagnose(input), 'install');
    const line = row.fix.slice(row.fix.indexOf(': ') + 2);
    assert.equal(execFileSync('sh', ['-c', line], {
      encoding: 'utf8', env: { ...process.env, PATH: `${folder}:${process.env.PATH}` },
    }), 'install\n');
    assert.equal(line, `'${command}' install`);
  });
}

for (const command of ['foreach', 'if']) {
  test(`PowerShell calls reserved program ${command}`, async () => {
    const { input } = await world({ command });
    const row = rowOf(await diagnose({ ...input, platform: 'win32' }), 'install');
    assert.ok(row.fix.endsWith(`& '${command}' install`), row.fix);
  });
}

test('reserved vocabulary is exact and only applies to the program on its platform', () => {
  assert.equal(shown(['IF', 'if'], 'linux'), 'IF if');
  assert.equal(shown(['foreach', 'if'], 'linux'), 'foreach if');
  assert.equal(shown(['then', 'if'], 'win32'), 'then if');
});

for (const platform of ['linux', 'win32']) {
  test(`all doctor repair programs use the unlinked payload on ${platform}`, async () => {
    const node = platform === 'win32' ? 'C:/Program Files/Node/node.exe' : '/opt/Node Dir/node';
    const record = { client: 'codex', path: '/payload', bin: 'src/cli.js', link: false, settings: { node }, autostart: true };
    const prefix = shown([node, '/payload/src/cli.js'], platform);
    const seen = new Set();
    for (const unreadable of [false, true]) {
      const { input } = await world({ records: [record], files: { '/state/config.json': '{', '/state/inbox.json': '{' }, readers: {
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
    const { input } = await world({ records: [record] });
    const install = rowOf(await diagnose({ ...input, platform, client: 'missing' }), 'install');
    // A client with no record retains the pre-install command.
    assert.ok(install.fix.includes('okit-plugin install'), install.fix);
  });

  test(`linked, absent and unresolved records retain the configured command on ${platform}`, async () => {
    for (const records of [[], [{ client: 'codex', link: true, path: '/payload', bin: 'cli.js' }],
      [{ client: 'codex', link: false, path: '/payload' }],
      [{ client: 'codex', link: false, path: '/payload', bin: 'cli.js' }, { client: 'claude-code', link: true }]]) {
      const { input } = await world({ records, readers: { nodeVersion: () => { throw new Error('bad node'); } } });
      assert.ok(rowOf(await diagnose({ ...input, platform }), 'node').fix.includes('okit-plugin '));
    }
  });
}
