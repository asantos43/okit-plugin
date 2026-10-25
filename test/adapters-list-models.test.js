// D61 step 2: the model listing of every adapter. The commands are fake (an
// injected `run` and, once, a fake executable in a temporary home), so no real
// client is started and nothing leaves the scratch folder.
//
// | Case | Must pass | Must refuse |
// | listing | the models the command printed, `source: 'listing'` | a command of the plugin's own |
// | missing | `installed: false`, the catalog, a reason | an exception |
// | timeout | the deadline of the configuration, the catalog | a wait longer than the deadline |
// | unknown output | the catalog, a reason | a guess of the models |
// | no command | the catalog, a reason | a command of the plugin's own |
// | empty listing | `source: 'listing'` and no model | the catalog |
// | exit code | zero, or no code at all | a numeric string |
// | user configuration | the command, the arguments and the interpreter of the user | a value fixed in the logic |
// | disk | nothing written, nothing read from the user's home | a write of any kind |

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import * as claudeCode from '../adapters/claude-code/index.js';
import * as codex from '../adapters/codex/index.js';
import * as opencode from '../adapters/opencode/index.js';
import { DEFAULT_CONFIG, configOf } from '../src/profiles.js';

const ADAPTERS = [claudeCode, codex, opencode];

/** A scratch home that no test shares with another. */
async function tempHome(t) {
  const root = await mkdtemp(join(tmpdir(), 'okit-list-models-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  return root;
}

/** The names of the files of a folder, to prove that nothing was written. */
async function tree(root) {
  const entries = [];
  const walk = async (folder) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      entries.push(`${relative(root, path)}:${entry.isDirectory() ? 'dir' : 'file'}`);
      if (entry.isDirectory()) await walk(path);
    }
  };
  await walk(root);
  return entries.sort();
}

/** A fake command runner that answers what the test says it answers. */
function fakeRun(answer) {
  const calls = [];
  const run = async (call) => {
    calls.push(call);
    return typeof answer === 'function' ? answer(call) : answer;
  };
  run.calls = calls;
  return run;
}

/** The user configuration of one client of the detection table. */
const detectConfig = (client, settings) => ({ setup: { detect: { [client]: settings } } });

test('the listing answers the models the command printed', async () => {
  const run = fakeRun({ code: 0, stdout: 'provider/one\nprovider/two\n', stderr: '' });
  const result = await opencode.listModels({
    run, config: detectConfig('opencode', { command: 'opencode', args: ['models'], timeoutMs: 1000, parse: 'lines' }),
  });
  assert.deepEqual(result, {
    client: 'opencode',
    installed: true,
    models: ['provider/one', 'provider/two'],
    hidden: [],
    source: 'listing',
    reason: result.reason,
  });
  assert.match(result.reason, /model list came from the client command/);
  assert.match(result.reason, /lista de modelos veio do comando do cliente/);
  assert.equal(run.calls.length, 1);
  assert.equal(run.calls[0].command, 'opencode');
  assert.deepEqual(run.calls[0].args, ['models']);
  assert.equal(run.calls[0].timeoutMs, 1000);
});

test('the json interpreter reads the catalog of a client as json', async () => {
  const shape = { models: [
    { slug: 'gpt-6-astra', visibility: 'list' },
    { slug: 'gpt-6-sol', visibility: 'list' },
  ] };
  const run = fakeRun({ code: 0, stdout: JSON.stringify(shape), stderr: '' });
  const result = await codex.listModels({
    run, config: detectConfig('codex', { command: 'codex', args: ['debug', 'models'], timeoutMs: 1000, parse: 'json-array' }),
  });
  assert.deepEqual(result.models, ['gpt-6-astra', 'gpt-6-sol']);
  assert.equal(result.source, 'listing');
  const plain = fakeRun({ code: 0, stdout: JSON.stringify(['one', 'two']), stderr: '' });
  const listed = await codex.listModels({
    run: plain,
    config: detectConfig('codex', {
      command: 'codex', args: [], timeoutMs: 1000, parse: 'json-array', activeField: null,
    }),
  });
  assert.deepEqual(listed.models, ['one', 'two']);
});

test('the listing keeps only active models and reports the excluded ones', async () => {
  const shape = { models: [
    { slug: 'visible', visibility: 'list' },
    { slug: 'hidden', visibility: 'hide' },
  ] };
  const run = fakeRun({ code: 0, stdout: JSON.stringify(shape), stderr: '' });
  const result = await codex.listModels({
    run,
    config: detectConfig('codex', {
      command: 'codex', args: [], timeoutMs: 1000, parse: 'json-array',
    }),
  });
  assert.deepEqual(result.models, ['visible']);
  assert.deepEqual(result.hidden, ['hidden']);
  assert.equal(result.source, 'listing');
  assert.match(result.reason, /2 models listed, 1 active, 1 hidden/);
  assert.match(result.reason, /2 modelos listados, 1 ativos, 1 ocultos/);
});

test('the activity field and values come from the user configuration', async () => {
  const shape = { models: [
    { slug: 'enabled', enabled: true },
    { slug: 'disabled', enabled: false },
  ] };
  const run = fakeRun({ code: 0, stdout: JSON.stringify(shape), stderr: '' });
  const result = await codex.listModels({
    run,
    config: detectConfig('codex', {
      command: 'codex', args: [], timeoutMs: 1000, parse: 'json-array',
      activeField: 'enabled', activeValues: [true],
    }),
  });
  assert.deepEqual(result.models, ['enabled']);
  assert.deepEqual(result.hidden, ['disabled']);
});

test('a missing executable is an answer, never an exception', async () => {
  const run = fakeRun(() => {
    throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
  });
  const result = await codex.listModels({
    run, config: detectConfig('codex', { command: 'codex', args: [], timeoutMs: 1000, parse: 'json-array' }),
  });
  assert.equal(result.installed, false);
  assert.equal(result.source, 'catalog');
  assert.deepEqual(result.models, []);
  assert.match(result.reason, /Codex was not found on this machine/);
  assert.match(result.reason, /O Codex não foi encontrado nesta máquina/);
});

test('a command that does not answer in time stops at the configured deadline', async () => {
  const run = fakeRun(() => new Promise(() => {}));
  const started = Date.now();
  const result = await codex.listModels({
    run, config: detectConfig('codex', { command: 'codex', args: [], timeoutMs: 150, parse: 'json-array' }),
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `the listing waited ${elapsed} ms for a deadline of 150 ms`);
  assert.equal(result.source, 'catalog');
  assert.equal(result.installed, true);
  assert.match(result.reason, /did not answer within 150 ms/);
  assert.match(result.reason, /não respondeu em 150 ms/);
});

test('a command that fails is an answer with its exit code', async () => {
  const run = fakeRun({ code: 3, stdout: '', stderr: 'boom' });
  const result = await codex.listModels({
    run, config: detectConfig('codex', { command: 'codex', args: [], timeoutMs: 1000, parse: 'json-array' }),
  });
  assert.equal(result.source, 'catalog');
  assert.deepEqual(result.models, []);
  assert.match(result.reason, /exit code 3/);
  assert.match(result.reason, /código de saída 3/);
});

test('a client that answered with no model is a listing, not the catalog', async () => {
  const empty = fakeRun({ code: 0, stdout: '', stderr: '' });
  const lines = await opencode.listModels({
    run: empty,
    config: detectConfig('opencode', { command: 'opencode', args: ['models'], timeoutMs: 1000, parse: 'lines' }),
  });
  assert.equal(lines.source, 'listing');
  assert.equal(lines.installed, true);
  assert.deepEqual(lines.models, []);
  assert.deepEqual(lines.hidden, []);
  assert.match(lines.reason, /answered and listed no model/);
  assert.match(lines.reason, /respondeu e não listou nenhum modelo/);
  const json = fakeRun({ code: 0, stdout: JSON.stringify({ models: [] }), stderr: '' });
  const array = await codex.listModels({
    run: json,
    config: detectConfig('codex', { command: 'codex', args: [], timeoutMs: 1000, parse: 'json-array' }),
  });
  assert.equal(array.source, 'listing');
  assert.deepEqual(array.models, []);
});

test('a client that answered with no active model is a listing with no model', async () => {
  const run = fakeRun({
    code: 0,
    stdout: JSON.stringify({ models: [{ slug: 'gpt-6-sol', visibility: 'hide' }] }),
    stderr: '',
  });
  const result = await codex.listModels({
    run, config: detectConfig('codex', { command: 'codex', args: [], timeoutMs: 1000, parse: 'json-array' }),
  });
  assert.equal(result.source, 'listing');
  assert.deepEqual(result.models, []);
  assert.deepEqual(result.hidden, ['gpt-6-sol']);
  assert.match(result.reason, /none of them is active/);
  assert.match(result.reason, /nenhum deles está ativo/);
});

test('only a plain zero is a success and any other code is a failure', async () => {
  const models = { models: [{ slug: 'gpt-6-sol', visibility: 'list' }] };
  const string = fakeRun({ code: '7', stdout: JSON.stringify(models), stderr: '' });
  const failed = await codex.listModels({
    run: string,
    config: detectConfig('codex', { command: 'codex', args: [], timeoutMs: 1000, parse: 'json-array' }),
  });
  assert.equal(failed.source, 'catalog');
  assert.deepEqual(failed.models, []);
  assert.match(failed.reason, /exit code 7/);
  assert.match(failed.reason, /código de saída 7/);
  const zero = fakeRun({ code: '0', stdout: JSON.stringify(models), stderr: '' });
  const stringZero = await codex.listModels({
    run: zero,
    config: detectConfig('codex', { command: 'codex', args: [], timeoutMs: 1000, parse: 'json-array' }),
  });
  assert.equal(stringZero.source, 'catalog');
  assert.deepEqual(stringZero.models, []);
  const absent = fakeRun({ stdout: JSON.stringify(models), stderr: '' });
  const without = await codex.listModels({
    run: absent,
    config: detectConfig('codex', { command: 'codex', args: [], timeoutMs: 1000, parse: 'json-array' }),
  });
  assert.equal(without.source, 'listing');
  assert.deepEqual(without.models, ['gpt-6-sol']);
});

test('an output the plugin does not understand falls back to the catalog', async () => {
  const run = fakeRun({ code: 0, stdout: 'the catalog, in prose', stderr: '' });
  const result = await codex.listModels({
    run, config: detectConfig('codex', { command: 'codex', args: [], timeoutMs: 1000, parse: 'json-array' }),
  });
  assert.equal(result.source, 'catalog');
  assert.deepEqual(result.models, []);
  assert.match(result.reason, /output was not understood/);
  assert.match(result.reason, /não foi entendida/);
});

test('a client without a listing command answers with the catalog and says so', async () => {
  const run = fakeRun({ code: 0, stdout: 'anything\n', stderr: '' });
  const result = await claudeCode.listModels({
    run, config: detectConfig('claude-code', { command: null, args: [], timeoutMs: 1000, parse: 'lines' }),
  });
  assert.equal(run.calls.length, 0);
  assert.equal(result.source, 'catalog');
  assert.equal(result.installed, null);
  assert.deepEqual(result.models, []);
  assert.match(result.reason, /No model-listing command is configured for claude-code/);
  assert.match(result.reason, /Nenhum comando de listagem de modelos está configurado/);
});

test('the default configuration of claude-code names no listing command', async () => {
  assert.equal(DEFAULT_CONFIG.setup.detect['claude-code'].command, null);
  assert.equal(DEFAULT_CONFIG.setup.detect['claude-code'].activeField, null);
  assert.equal(DEFAULT_CONFIG.setup.detect.codex.activeField, 'visibility');
  assert.deepEqual(DEFAULT_CONFIG.setup.detect.codex.activeValues, ['list']);
  const result = await claudeCode.listModels({ run: fakeRun({ code: 0, stdout: '', stderr: '' }) });
  assert.equal(result.source, 'catalog');
  assert.equal(result.installed, null);
});

test('the user configuration replaces the command, the arguments and the interpreter', async () => {
  const run = fakeRun({ code: 0, stdout: JSON.stringify(['own-model']), stderr: '' });
  const config = detectConfig('codex', {
    command: 'my-codex', args: ['--list-models'], timeoutMs: 1234, parse: 'json-array',
    activeField: null,
  });
  const result = await codex.listModels({ run, config });
  assert.deepEqual(result.models, ['own-model']);
  assert.equal(run.calls[0].command, 'my-codex');
  assert.deepEqual(run.calls[0].args, ['--list-models']);
  assert.equal(run.calls[0].timeoutMs, 1234);
  // The clients the user did not name keep their own defaults.
  assert.equal(configOf(config).setup.detect.opencode.command, DEFAULT_CONFIG.setup.detect.opencode.command);
  assert.deepEqual(configOf(config).setup.detect.opencode.args, DEFAULT_CONFIG.setup.detect.opencode.args);
  assert.equal(configOf(config).setup.detect.codex.command, 'my-codex');
  // A broken value in the configuration never erases the defaults.
  const broken = configOf({ setup: { detect: 'not an object' } });
  assert.deepEqual(broken.setup.detect.opencode, DEFAULT_CONFIG.setup.detect.opencode);
  assert.deepEqual(broken.setup.detect.codex, DEFAULT_CONFIG.setup.detect.codex);
});

test('the listing writes nothing and reads no folder of the user', async (t) => {
  const home = await tempHome(t);
  const before = await tree(home);
  const run = fakeRun({ code: 0, stdout: 'provider/one\n', stderr: '' });
  const result = await opencode.listModels({
    run, env: { HOME: home }, config: detectConfig('opencode', { command: 'opencode', args: ['models'], timeoutMs: 1000, parse: 'lines' }),
  });
  assert.equal(result.source, 'listing');
  assert.deepEqual(await tree(home), before);
});

test('a fake executable in a temporary home lists the models of the client', { skip: process.platform === 'win32' ? 'POSIX only' : false }, async (t) => {
  const home = await tempHome(t);
  const bin = join(home, 'bin');
  await mkdir(bin);
  const fake = join(bin, 'codex');
  await writeFile(fake, '#!/bin/sh\necho \'{"models":[{"slug":"fake-astra","visibility":"list"}]}\'\n');
  await chmod(fake, 0o755);
  const result = await codex.listModels({
    env: { PATH: bin, HOME: home },
    config: detectConfig('codex', { command: 'codex', args: ['debug', 'models'], timeoutMs: 5000, parse: 'json-array' }),
  });
  assert.deepEqual(result.models, ['fake-astra']);
  assert.equal(result.source, 'listing');
  assert.equal(result.installed, true);
  // The listing of the fake executable wrote nothing either.
  assert.deepEqual((await tree(home)).filter((entry) => entry.startsWith('bin/')), ['bin/codex:file']);
});

test('every adapter answers with a reason and no demand or order id', async () => {
  const reasons = [];
  for (const adapter of ADAPTERS) {
    const client = adapter.CLIENT;
    const cases = [
      fakeRun({ code: 0, stdout: 'a\nb\n', stderr: '' }),
      fakeRun({ code: 0, stdout: 'not json', stderr: '' }),
      fakeRun({ code: 7, stdout: '', stderr: '' }),
      fakeRun(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }),
    ];
    for (const run of cases) {
      const result = await adapter.listModels({
        run,
        config: detectConfig(client, { command: 'client', args: [], timeoutMs: 500, parse: 'lines' }),
      });
      reasons.push(result.reason);
      assert.equal(result.client, client);
      assert.ok(['listing', 'catalog'].includes(result.source));
      assert.ok(Array.isArray(result.models));
    }
  }
  for (const reason of reasons) {
    assert.doesNotMatch(reason, /\b[IDOG]\d+\b/);
    const [english, portuguese] = reason.split(' / ');
    assert.ok(english.trim() !== '' && portuguese.trim() !== '', `not bilingual: ${reason}`);
  }
});

test('the default export of every adapter offers the listing', () => {
  for (const adapter of ADAPTERS) {
    assert.equal(typeof adapter.listModels, 'function');
    assert.equal(typeof adapter.default.listModels, 'function');
  }
});

// The corpus of the interpreters: what must be read, and what must be refused.
const CORPUS = [
  { parse: 'lines', stdout: 'a\nb\n', models: ['a', 'b'] },
  { parse: 'lines', stdout: 'a\r\nb\r\n', models: ['a', 'b'] },
  { parse: 'lines', stdout: '  a  \n\n', models: ['a'] },
  { parse: 'lines', stdout: '', models: [] },
  { parse: 'json-array', stdout: '["a","b"]', models: ['a', 'b'] },
  { parse: 'json-array', stdout: '{"models":[{"slug":"a"},{"id":"b"}]}', models: ['a', 'b'] },
  { parse: 'json-array', stdout: '{"models":["a"]}', models: ['a'] },
  { parse: 'json-array', stdout: '{"models":[]}', models: [] },
  { parse: 'json-array', stdout: 'not json', models: null },
  { parse: 'json-array', stdout: '{"other":1}', models: null },
];

test('the interpreters read the corpus and refuse what they cannot', async () => {
  for (const entry of CORPUS) {
    const run = fakeRun({ code: 0, stdout: entry.stdout, stderr: '' });
    const result = await codex.listModels({
      run, config: detectConfig('codex', {
        command: 'codex', args: [], timeoutMs: 500, parse: entry.parse, activeField: null,
      }),
    });
    if (entry.models === null) {
      assert.equal(result.source, 'catalog', `refused: ${entry.stdout}`);
      assert.match(result.reason, /not understood/);
      continue;
    }
    assert.deepEqual(result.models, entry.models, `read: ${entry.stdout}`);
    // An answered command is a listing, even when it listed no model at all.
    assert.equal(result.source, 'listing');
  }
});
