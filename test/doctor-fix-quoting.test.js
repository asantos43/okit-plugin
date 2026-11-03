import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
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
