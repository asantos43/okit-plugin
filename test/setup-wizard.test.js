import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { main } from '../src/cli.js';
import { configCommand } from '../src/config.js';
import { configOf } from '../src/profiles.js';
import { runSetup, SetupSaveError } from '../src/setup/setup.js';
import codex from '../adapters/codex/index.js';
import { detectClients } from '../src/setup/detect.js';

for (const locale of ['en', 'pt-BR']) {
  test(`every setup question explains its recommendation in ${locale}`, async (t) => {
    const { home, root } = await temporaryHome(t);
    const questions = [];
    const result = await runSetup({ root, env: { HOME: home }, locale,
      run: falseRun(), adapters: [fakeClient('claude-code', ['other/model'])],
      ask: async (question, recommended) => {
        questions.push(question);
        return recommended ? '' : 'yes';
      } });
    assert.equal(result.cancelled, false);
    assert.equal(questions.length, 4);
    for (const question of questions) {
      assert.match(question, locale === 'en' ? /Recommend(?:ed|ation):/ : /Recomend(?:ado|ação):/);
      assert.match(question, locale === 'en' ? /available assistant|future work/ : /assistente disponível|próximos trabalhos/);
    }
    assert.match(questions[0], locale === 'en' ? /small, straightforward tasks/ : /tarefas pequenas e diretas/);
    assert.match(questions[1], locale === 'en' ? /everyday work/ : /trabalhos do dia a dia/);
    assert.match(questions[2], locale === 'en' ? /complex work/ : /trabalhos complexos/);
  });
}

async function temporaryHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'okit-setup-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, root: join(home, '.okwork') };
}

async function writeConfig(root, text) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'config.json'), text, 'utf8');
}

function fakeClient(client, models, installed = true, source = 'listing') {
  return {
    CLIENT: client,
    async listModels() {
      return { client, installed, models, hidden: [], source };
    },
  };
}

function defaultClientAdapters(installed) {
  return [
    fakeClient('claude-code', [], installed, 'catalog'),
    fakeClient('codex', [], false, 'catalog'),
    fakeClient('opencode', [], false, 'catalog'),
  ];
}

function falseRun() {
  return async () => false;
}

function terminal(text) {
  return {
    stdin: Readable.from([text]),
    output: new Writable({
      write(_chunk, _encoding, done) { done(); },
    }),
  };
}

/** An input that already ended: no line will ever arrive again. */
async function endedInput() {
  const stdin = Readable.from([]);
  stdin.resume();
  await new Promise((resolve) => stdin.once('end', resolve));
  return stdin;
}

/**
 * Runs a setup command once in each language, over the same state, and gives the first run's exit code: the lines
 * of both runs reach the collectors of `io`, English first. A run says one language only (the entry-point matrix
 * of test/install-entrypoints.test.js checks that), so a test that wants both sentences reads both runs.
 */
async function mainBothLanguages(args, io) {
  const first = await main([...args, '--locale', 'en'], io);
  const second = await main([...args, '--locale', 'pt-BR'], io);
  assert.equal(second, first, 'the exit code does not depend on the language');
  return first;
}

function silentOutput() {
  return new Writable({
    write(_chunk, _encoding, done) { done(); },
  });
}

test('setup --defaults writes a valid profile for an installed client', async (t) => {
  const { home, root } = await temporaryHome(t);
  const output = [];
  const errors = [];
  const code = await main(['setup', '--defaults'], {
    root,
    env: { HOME: home, OKWORK_HOME: root },
    run: falseRun(),
    adapters: [fakeClient('claude-code', ['haiku', 'sonnet', 'opus'])],
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  });
  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  const raw = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  const config = configOf(raw);
  assert.equal(config.profiles['claude-code'].simple.model, 'haiku');
  assert.equal(config.profiles['claude-code'].normal.model, 'sonnet');
  assert.equal(config.profiles['claude-code'].hard.model, 'opus');
  assert.match(raw.setup.done.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(output.join('\n'), /Saved 3 model settings/);
});

test('interactive setup keeps every answer until the final confirmation', { timeout: 2000 }, async (t) => {
  const { home, root } = await temporaryHome(t);
  const output = [];
  const errors = [];
  const code = await main(['setup'], {
    root,
    env: { HOME: home, OKWORK_HOME: root },
    run: falseRun(),
    adapters: [fakeClient('claude-code', ['other/model'])],
    ...terminal('\n\n\nyes\n'),
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  });
  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  const raw = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  assert.equal(raw.profiles['claude-code'].simple.model, 'other/model');
  assert.equal(raw.profiles['claude-code'].normal.model, 'other/model');
  assert.equal(raw.profiles['claude-code'].hard.model, 'other/model');
});

test('interactive setup treats EOF without an answer as cancellation', { timeout: 2000 }, async (t) => {
  const { home, root } = await temporaryHome(t);
  const errors = [];
  const code = await main(['setup'], {
    root,
    env: { HOME: home, OKWORK_HOME: root },
    run: falseRun(),
    adapters: [fakeClient('claude-code', ['other/model'])],
    ...terminal('\n'),
    stdout: () => {},
    stderr: (line) => errors.push(line),
  });
  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  await assert.rejects(readFile(join(root, 'config.json'), 'utf8'), { code: 'ENOENT' });
});

test('interactive setup asks for an omitted class and accepts its recommendation', async (t) => {
  const { home, root } = await temporaryHome(t);
  const questions = [];
  const ask = async (question, recommended) => {
    questions.push({ question, recommended });
    if (question.startsWith('Choose a model')) return '';
    return 'yes';
  };
  const result = await runSetup({
    root,
    config: {},
    env: { HOME: home, OKWORK_HOME: root },
    run: falseRun(),
    ask,
    locale: 'en',
    adapters: [fakeClient('claude-code', ['other/model'])],
  });
  assert.equal(result.cancelled, false);
  assert.equal(result.changes.length, 3);
  const modelQuestion = questions.find((entry) => entry.question.startsWith('Choose a model'));
  assert.match(modelQuestion.question, /other\/model/);
  assert.equal(modelQuestion.recommended, 'other/model');
  const raw = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  assert.equal(raw.profiles['claude-code'].simple.model, 'other/model');
  assert.equal(raw.profiles['claude-code'].simple.effort, 'low');
});

test('an invalid interactive answer is asked again', async (t) => {
  const { home, root } = await temporaryHome(t);
  const questions = [];
  let invalidSent = false;
  const ask = async (question) => {
    questions.push(question);
    if (question.includes('Choose a model') && !invalidSent) {
      invalidSent = true;
      return 'not-active';
    }
    if (question.includes('Choose a model')) return '';
    return 'yes';
  };
  const result = await runSetup({
    root,
    config: {},
    env: { HOME: home, OKWORK_HOME: root },
    run: falseRun(),
    ask,
    locale: 'en',
    adapters: [fakeClient('claude-code', ['other/model'])],
  });
  assert.equal(result.cancelled, false);
  assert.ok(questions.some((question) => question.includes('Choose one of the listed models.')));
  const raw = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  assert.equal(raw.profiles['claude-code'].simple.model, 'other/model');
});

test('cancelling the confirmation writes nothing', async (t) => {
  const { home, root } = await temporaryHome(t);
  const ask = async (question) => (question.startsWith('Choose a model') ? '' : '');
  const result = await runSetup({
    root,
    config: {},
    env: { HOME: home, OKWORK_HOME: root },
    run: falseRun(),
    ask,
    locale: 'en',
    adapters: [fakeClient('claude-code', ['other/model'])],
  });
  assert.equal(result.cancelled, true);
  await assert.rejects(readFile(join(root, 'config.json'), 'utf8'), { code: 'ENOENT' });
});

test('a repeated setup does not ask again for configured active models', async (t) => {
  const { home, root } = await temporaryHome(t);
  const adapters = [fakeClient('claude-code', ['other/model'])];
  const firstAsk = async (question) => (question.startsWith('Choose a model') ? '' : 'yes');
  await runSetup({
    root,
    config: {},
    env: { HOME: home, OKWORK_HOME: root },
    run: falseRun(),
    ask: firstAsk,
    locale: 'en',
    adapters,
  });
  let asked = false;
  const second = await runSetup({
    root,
    config: {},
    env: { HOME: home, OKWORK_HOME: root },
    run: falseRun(),
    ask: async () => { asked = true; },
    locale: 'en',
    adapters,
  });
  assert.equal(asked, false);
  assert.equal(second.changes.length, 0);
  assert.equal(second.skipped.length, 3);
  // The record of the setup stays: the classes are already configured.
  const raw = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  assert.match(raw.setup.done.at, /^\d{4}-\d{2}-\d{2}T/);
});

test('defaults refuses an invalid effort without writing', async (t) => {
  const { home, root } = await temporaryHome(t);
  const config = { profiles: { 'claude-code': { simple: { effort: 'wrong' } } } };
  await assert.rejects(() => runSetup({
    root,
    config,
    env: { HOME: home, OKWORK_HOME: root },
    run: falseRun(),
    defaults: true,
    locale: 'en',
    adapters: [fakeClient('claude-code', ['haiku', 'sonnet', 'opus'])],
  }), /not valid/);
  await assert.rejects(readFile(join(root, 'config.json'), 'utf8'), { code: 'ENOENT' });
});

test('setup --again writes the detected profiles again', async (t) => {
  const { home, root } = await temporaryHome(t);
  const io = {
    root,
    env: { HOME: home, OKWORK_HOME: root },
    run: falseRun(),
    adapters: [fakeClient('claude-code', ['haiku', 'sonnet', 'opus'])],
    stdout: () => {},
    stderr: () => {},
  };
  assert.equal(await main(['setup', '--defaults'], io), 0);
  let writes = 0;
  assert.equal(await main(['setup', '--again', '--defaults'], {
    ...io,
    writeConfig: async () => { writes += 1; },
  }), 0);
  assert.equal(writes, 1);
});

// | case | must pass | must refuse |
// | change during the confirmation | the other classes are saved | the changed class is not overwritten |
// | root changed during the confirmation | the unreadable sentence | a write of the broken root |
// | class outside the schema | - | exit 1, nothing written |
// | no client with an active model | one simple sentence, exit 0 | a `setup.done` record |
// | an unexpected shape of profiles | the unreadable sentence, exit 1 | a technical error |

test('a change made during the confirmation is kept and the other classes are saved', async (t) => {
  const { home, root } = await temporaryHome(t);
  const ctx = { root, out: () => {}, err: () => {}, unknown: () => 2 };
  const ask = async (question) => {
    if (question.startsWith('Save these model settings')) {
      const code = await configCommand(ctx, 'set', [
        'profiles.claude-code.simple.model', 'opus',
      ]);
      assert.equal(code, 0);
      return 'yes';
    }
    return '';
  };
  const result = await runSetup({
    root,
    config: {},
    env: { HOME: home, OKWORK_HOME: root },
    run: falseRun(),
    ask,
    locale: 'en',
    adapters: [fakeClient('claude-code', ['haiku', 'sonnet', 'opus'])],
  });
  const raw = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  const config = configOf(raw);
  assert.equal(config.profiles['claude-code'].simple.model, 'opus');
  assert.equal(config.profiles['claude-code'].normal.model, 'sonnet');
  assert.equal(config.profiles['claude-code'].hard.model, 'opus');
  assert.equal(result.kept.length, 1);
  assert.deepEqual(result.kept[0], { client: 'claude-code', class: 'simple' });
  assert.match(result.messages.join('\n'), /Kept the newer values for claude-code \(simple\)/);
});

test('a configuration changed during the confirmation is not written', async (t) => {
  const { home, root } = await temporaryHome(t);
  const ask = async (question) => {
    if (question.startsWith('Save these model settings')) {
      await writeConfig(root, '[]');
      return 'yes';
    }
    return '';
  };
  await assert.rejects(() => runSetup({
    root,
    config: {},
    env: { HOME: home, OKWORK_HOME: root },
    run: falseRun(),
    ask,
    locale: 'both',
    adapters: [fakeClient('claude-code', ['haiku', 'sonnet', 'opus'])],
  }), /Could not check the configuration.*não está legível/);
  assert.equal(await readFile(join(root, 'config.json'), 'utf8'), '[]');
});

test('setup --defaults refuses an unsafe raw profile name as a usage error (2) without writing', async (t) => {
  const { home, root } = await temporaryHome(t);
  const original = '{"profiles":{"claude-code":{"__proto__":{"model":"haiku","effort":"low"}}}}';
  await writeConfig(root, original);
  const errors = [];
  const code = await mainBothLanguages(['setup', '--defaults'], {
    root,
    env: { HOME: home, OKWORK_HOME: root },
    run: falseRun(),
    adapters: [fakeClient('claude-code', ['haiku', 'sonnet', 'opus'])],
    stdout: () => {},
    stderr: (line) => errors.push(line),
  });
  assert.equal(code, 2);
  assert.match(errors.join('\n'), /name that is not allowed/);
  assert.match(errors.join('\n'), /nome que não é permitido/);
  assert.equal(await readFile(join(root, 'config.json'), 'utf8'), original);
});

test('setup --defaults refuses a class outside the configuration schema', async (t) => {
  const { home, root } = await temporaryHome(t);
  const config = {
    profiles: { 'claude-code': { imaginary: { model: 'haiku', effort: 'low' } } },
  };
  await assert.rejects(() => runSetup({
    root,
    config,
    env: { HOME: home, OKWORK_HOME: root },
    run: falseRun(),
    defaults: true,
    locale: 'both',
    adapters: [fakeClient('claude-code', ['haiku', 'sonnet', 'opus'])],
  }), /name that is not allowed.*não é permitido/);
  await assert.rejects(readFile(join(root, 'config.json'), 'utf8'), { code: 'ENOENT' });
});

// | case | must pass | must refuse |
// | an input that already ended | the setup ends by itself | a question that waits forever |
// | a configuration that is not JSON | the simple sentence, exit 1 | the parser error |
// | a configuration whose root is not an object | the simple sentence, exit 1 | a write of the broken root |
// | a configuration that cannot be read | the simple sentence, exit 1 | the reader error |

test('an input that already ended cancels the setup without writing', { timeout: 2000 }, async (t) => {
  const { home, root } = await temporaryHome(t);
  const output = [];
  const errors = [];
  const code = await main(['setup'], {
    root,
    env: { HOME: home, OKWORK_HOME: root },
    run: falseRun(),
    adapters: [fakeClient('claude-code', ['other/model'])],
    stdin: await endedInput(),
    output: silentOutput(),
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  });
  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.match(output.join('\n'), /Setup was cancelled and nothing was saved\./);
  await assert.rejects(readFile(join(root, 'config.json'), 'utf8'), { code: 'ENOENT' });
});

test('setup --defaults refuses a configuration whose root is not an object', async (t) => {
  const { home, root } = await temporaryHome(t);
  const original = '[]';
  await writeConfig(root, original);
  const output = [];
  const errors = [];
  const code = await mainBothLanguages(['setup', '--defaults'], {
    root,
    env: { HOME: home, OKWORK_HOME: root },
    run: falseRun(),
    adapters: [fakeClient('claude-code', ['haiku', 'sonnet', 'opus'])],
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  });
  assert.equal(code, 1);
  assert.deepEqual(output, []);
  assert.match(errors.join('\n'), /Could not check the configuration/);
  assert.match(errors.join('\n'), /não está legível/);
  assert.doesNotMatch(errors.join('\n'), /Invalid JSON|Cannot read/);
  assert.equal(await readFile(join(root, 'config.json'), 'utf8'), original);
});

test('setup --defaults refuses a configuration whose root is null', async (t) => {
  const { home, root } = await temporaryHome(t);
  const original = 'null';
  await writeConfig(root, original);
  const output = [];
  const errors = [];
  const code = await mainBothLanguages(['setup', '--defaults'], {
    root,
    env: { HOME: home, OKWORK_HOME: root },
    run: falseRun(),
    adapters: [fakeClient('claude-code', ['haiku', 'sonnet', 'opus'])],
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  });
  assert.equal(code, 1);
  assert.deepEqual(output, []);
  assert.match(errors.join('\n'), /Could not check the configuration/);
  assert.match(errors.join('\n'), /não está legível/);
  assert.doesNotMatch(errors.join('\n'), /Cannot read properties/);
  assert.equal(await readFile(join(root, 'config.json'), 'utf8'), original);
});

test('setup refuses a configuration that is not JSON with the same sentence', async (t) => {
  const { home, root } = await temporaryHome(t);
  const original = '{ broken';
  await writeConfig(root, original);
  const output = [];
  const errors = [];
  const code = await mainBothLanguages(['setup', '--defaults'], {
    root,
    env: { HOME: home, OKWORK_HOME: root },
    run: falseRun(),
    adapters: [fakeClient('claude-code', ['haiku', 'sonnet', 'opus'])],
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  });
  assert.equal(code, 1);
  assert.deepEqual(output, []);
  assert.match(errors.join('\n'), /Could not check the configuration/);
  assert.match(errors.join('\n'), /não está legível/);
  assert.doesNotMatch(errors.join('\n'), /Invalid JSON|Expected property name/);
  assert.equal(await readFile(join(root, 'config.json'), 'utf8'), original);
});

test('the setup module refuses an unreadable configuration before any write', async (t) => {
  const { home, root } = await temporaryHome(t);
  const original = '{ broken';
  await writeConfig(root, original);
  await assert.rejects(() => runSetup({
    root,
    config: {},
    env: { HOME: home, OKWORK_HOME: root },
    run: falseRun(),
    defaults: true,
    locale: 'both',
    adapters: [fakeClient('claude-code', ['haiku', 'sonnet', 'opus'])],
  }), /Could not check the configuration.*não está legível/);
  assert.equal(await readFile(join(root, 'config.json'), 'utf8'), original);
});

test('the setup module refuses a configuration whose root is not an object', async (t) => {
  const { home, root } = await temporaryHome(t);
  const original = '[]';
  await writeConfig(root, original);
  await assert.rejects(() => runSetup({
    root,
    config: {},
    env: { HOME: home, OKWORK_HOME: root },
    run: falseRun(),
    defaults: true,
    locale: 'both',
    adapters: [fakeClient('claude-code', ['haiku', 'sonnet', 'opus'])],
  }), /Could not check the configuration.*não está legível/);
  assert.equal(await readFile(join(root, 'config.json'), 'utf8'), original);
});

test('setup --defaults uses the catalog when the only client installation is unknown', async (t) => {
  const { home, root } = await temporaryHome(t);
  const output = [];
  const errors = [];
  const code = await main(['setup', '--defaults'], {
    root,
    env: { HOME: home, OKWORK_HOME: root },
    run: falseRun(),
    adapters: defaultClientAdapters(null),
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  });
  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  const raw = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  const config = configOf(raw);
  assert.equal(config.profiles['claude-code'].simple.model, 'haiku');
  assert.equal(config.profiles['claude-code'].normal.model, 'sonnet');
  assert.equal(config.profiles['claude-code'].hard.model, 'opus');
  assert.deepEqual(Object.keys(raw.profiles), ['claude-code']);
});

test('setup --defaults without a detected client says one simple sentence and writes nothing', async (t) => {
  const { home, root } = await temporaryHome(t);
  const output = [];
  const errors = [];
  const code = await mainBothLanguages(['setup', '--defaults'], {
    root,
    env: { HOME: home, OKWORK_HOME: root },
    run: falseRun(),
    adapters: [],
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  });
  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.equal(output.length, 2, output.join(' | '));
  assert.match(output[0], /No client with an active model was found/);
  assert.match(output[1], /Nenhum cliente com modelo ativo foi encontrado/);
  assert.doesNotMatch(output[0], /Nenhum cliente/);
  assert.doesNotMatch(output[1], /No client/);
  // No `setup.done`: the configuration is still pending.
  await assert.rejects(readFile(join(root, 'config.json'), 'utf8'), { code: 'ENOENT' });
});

test('setup --defaults with no installed client says one simple sentence and writes nothing', async (t) => {
  const { home, root } = await temporaryHome(t);
  const output = [];
  const errors = [];
  const code = await mainBothLanguages(['setup', '--defaults'], {
    root,
    env: { HOME: home, OKWORK_HOME: root },
    run: falseRun(),
    adapters: defaultClientAdapters(false),
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  });
  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.equal(output.length, 2, output.join(' | '));
  assert.match(output[0], /No client with an active model was found/);
  assert.match(output[1], /Nenhum cliente com modelo ativo foi encontrado/);
  assert.doesNotMatch(output[0], /Nenhum cliente/);
  assert.doesNotMatch(output[1], /No client/);
  await assert.rejects(readFile(join(root, 'config.json'), 'utf8'), { code: 'ENOENT' });
});

test('setup --defaults with a client that lists no active model says one simple sentence and writes nothing', async (t) => {
  const { home, root } = await temporaryHome(t);
  const output = [];
  const errors = [];
  const code = await mainBothLanguages(['setup', '--defaults'], {
    root,
    env: { HOME: home, OKWORK_HOME: root },
    run: falseRun(),
    adapters: [fakeClient('claude-code', [])],
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  });
  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.equal(output.length, 2, output.join(' | '));
  assert.match(output[0], /No client with an active model was found/);
  assert.match(output[1], /Nenhum cliente com modelo ativo foi encontrado/);
  assert.doesNotMatch(output[0], /Nenhum cliente/);
  assert.doesNotMatch(output[1], /No client/);
  await assert.rejects(readFile(join(root, 'config.json'), 'utf8'), { code: 'ENOENT' });
});

// | case | must pass | must refuse |
// | invalid limits on either read | bilingual refusal, exit 2, intact bytes | technical error, write, setup.done |
for (const global of [0, 'abc']) {
  for (const changedDuringDetection of [false, true]) {
    test(`setup --defaults refuses invalid limits ${global} on ${changedDuringDetection ? 'locked' : 'initial'} read`, async (t) => {
      const { home, root } = await temporaryHome(t);
      const original = `{"limits":{"global":${JSON.stringify(global)}}}\n`;
      await writeConfig(root, changedDuringDetection ? '{}' : original);
      const adapter = fakeClient('claude-code', ['haiku', 'sonnet', 'opus']);
      const listModels = adapter.listModels;
      adapter.listModels = async () => {
        if (changedDuringDetection) await writeConfig(root, original);
        return listModels();
      };
      const output = [];
      const errors = [];
      let writes = 0;
      const code = await mainBothLanguages(['setup', '--defaults'], {
        root, command: 'custom-okit', env: { HOME: home, OKWORK_HOME: root },
        run: falseRun(), adapters: [adapter],
        stdout: (line) => output.push(line), stderr: (line) => errors.push(line),
        writeConfig: async () => { writes += 1; },
      });
      assert.equal(code, 2); // usage, as install (single policy in src/install/exit.js)
      assert.equal(writes, 0);
      assert.deepEqual(output, []);
      const message = errors.join('\n');
      assert.match(message, /The configuration file has a value that is not accepted/);
      assert.match(message, /O arquivo de configuração tem um valor que não é aceito/);
      assert.match(message, /custom-okit config show/);
      assert.match(message, /custom-okit setup/);
      assert.doesNotMatch(message, /integer|Could not save|okit-plugin/);
      const after = await readFile(join(root, 'config.json'));
      assert.deepEqual(after, Buffer.from(original));
      assert.equal(JSON.parse(after).setup?.done, undefined);
    });
  }
}

test('setup --defaults refuses an unexpected shape of profiles with the unreadable sentence', async (t) => {
  const { home, root } = await temporaryHome(t);
  const shapes = ['{"profiles":null}', '{"profiles":{"claude-code":"bad"}}'];
  const clients = [
    [fakeClient('claude-code', ['haiku'], false)],
    [fakeClient('claude-code', ['haiku', 'sonnet', 'opus'])],
  ];
  for (const original of shapes) {
    for (const adapters of clients) {
      await writeConfig(root, original);
      const output = [];
      const errors = [];
      const code = await mainBothLanguages(['setup', '--defaults'], {
        root,
        env: { HOME: home, OKWORK_HOME: root },
        run: falseRun(),
        adapters,
        stdout: (line) => output.push(line),
        stderr: (line) => errors.push(line),
      });
      assert.equal(code, 1, `${original} ${JSON.stringify(adapters.map((client) => client.CLIENT))}`);
      assert.deepEqual(output, [], original);
      assert.match(errors.join('\n'), /Could not check the configuration/);
      assert.match(errors.join('\n'), /não está legível/);
      assert.doesNotMatch(errors.join('\n'), /invalid object at|Cannot read|TypeError/);
      assert.equal(await readFile(join(root, 'config.json'), 'utf8'), original);
    }
  }
});

// | case | must pass | must refuse |
// | a configuration folder that refuses the write | the simple sentence in both languages, exit 1 | the technical text of the system (EACCES, mkdir) |
// | a configuration that cannot be read | the unreadable sentence | the sentence of a failed write |
// | a name outside the schema | the refusal sentence | the sentence of a failed write |

test('setup --defaults says one simple sentence when the configuration folder refuses the write', async (t) => {
  // As root the mode of a folder refuses nothing: the write would succeed and
  // the sentence would never be the answer.
  if (process.getuid?.() === 0) {
    t.skip('the process is root: the mode of a folder does not refuse a write');
    return;
  }
  const { home, root } = await temporaryHome(t);
  await mkdir(root, { recursive: true });
  await chmod(root, 0o555);
  try {
    // The system has to apply the mode: without it the folder still takes a
    // write and there is no refusal to report.
    const writable = await writeFile(join(root, 'probe'), 'x').then(() => true, () => false);
    if (writable) {
      t.skip('the system did not apply the mode to the folder');
      return;
    }
    const output = [];
    const errors = [];
    const code = await mainBothLanguages(['setup', '--defaults'], {
      root,
      env: { HOME: home, OKWORK_HOME: root },
      run: falseRun(),
      adapters: [fakeClient('claude-code', ['haiku', 'sonnet', 'opus'])],
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    });
    assert.equal(code, 1);
    assert.deepEqual(output, []);
    const said = errors.join('\n');
    assert.match(said, /Could not save the configuration/);
    assert.match(said, /Não foi possível salvar a configuração/);
    assert.ok(said.includes(resolve(root)), said);
    assert.match(said, /okit-plugin setup/);
    assert.doesNotMatch(said, /EACCES|permission denied|mkdir|errno|EEXIST|Cannot write/);
    // Nothing was written: no configuration file and no `setup.done`.
    assert.deepEqual(await readdir(root), []);
  } finally {
    await chmod(root, 0o755);
  }
});

test('setup --defaults says no technical code when a client cannot be read', async (t) => {
  // The listing of the client cannot be read: the run of the adapter refuses
  // with a technical code. The plan the user reads names the client and the
  // model, never the code of the failure.
  const refusal = async () => {
    throw Object.assign(new Error('spawn codex EACCES'), { code: 'EACCES' });
  };
  const expected = {
    en: /The model list could not be read, so the built-in catalog is used\./,
    'pt-BR': /A lista de modelos não pôde ser lida, então o catálogo interno é usado\./,
  };
  // | case | must pass | must refuse |
  // | real adapter failure/exit/timeout | catalog and diagnostic error | technical detail in reason or setup |
  const detectionConfig = { setup: { detect: { codex: { timeoutMs: 23 } } } };
  for (const [run, detail, forbidden, timeout] of [
    [refusal, 'EACCES', /EACCES|spawn codex/, false],
    [async () => ({ code: 2 }), '2', /\b2\b|exit code|código de saída/, false],
    [() => new Promise(() => {}), '23', /\b23\b|\bms\b/, true],
  ]) {
    const { clients: [client] } = await detectClients({ config: detectionConfig, run, adapters: [codex] });
    assert.equal(client.source, 'catalog');
    assert.equal(client.error, detail);
    assert.deepEqual(client.models, []);
    assert.doesNotMatch(client.reason, forbidden);
    for (const locale of ['en', 'pt-BR']) {
      const { home, root } = await temporaryHome(t);
      await writeConfig(root, JSON.stringify(detectionConfig));
      const output = [];
      const errors = [];
      const code = await main(['setup', '--defaults', '--locale', locale], {
        root,
        env: { HOME: home, OKWORK_HOME: root },
        run,
        adapters: [codex],
        stdout: (line) => output.push(line),
        stderr: (line) => errors.push(line),
      });
      assert.equal(code, 0);
      assert.deepEqual(errors, []);
      const said = output.join('\n');
      assert.doesNotMatch(said, forbidden);
      const reason = timeout ? (locale === 'en'
        ? /The model list did not answer in time/
        : /A lista de modelos não respondeu a tempo/) : expected[locale];
      for (const className of ['simple', 'normal', 'hard']) {
        const proposal = output.find((line) => line.includes(`codex (${className})`));
        assert.match(proposal, reason);
      }
      // The client keeps the catalog: the model of the catalog is saved.
      const raw = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
      const config = configOf(raw);
      assert.equal(config.profiles.codex.simple.model, 'gpt-5-codex');
      assert.equal(config.profiles.codex.normal.model, 'gpt-5-codex');
      assert.equal(config.profiles.codex.hard.model, 'gpt-5-codex');
    }
  }
});

// | case | must pass | must refuse |
// | a client whose model list cannot be read | the catalog model and a plain reason | the technical code of the failure |
// | a write that the folder refuses | the simple sentence in both languages | the technical text of the system (EACCES) |
// | an unexpected error inside the lock | the same simple sentence | the error that came out of the lock |
// | the command line that cannot save | the sentence, without the command before it | `okit-plugin: ` before the sentence |

test('a write that the folder refuses is reported as the simple sentence', async (t) => {
  const { home, root } = await temporaryHome(t);
  let writes = 0;
  const failure = await runSetup({
    root,
    config: {},
    env: { HOME: home, OKWORK_HOME: root },
    run: falseRun(),
    defaults: true,
    locale: 'both',
    adapters: [fakeClient('claude-code', ['haiku', 'sonnet', 'opus'])],
    write: async () => {
      writes += 1;
      throw new Error('EACCES: permission denied, write');
    },
  }).then(() => null, (error) => error);
  assert.ok(failure, 'the setup must fail');
  assert.equal(writes, 1);
  assert.ok(failure instanceof SetupSaveError, failure.name);
  assert.match(failure.message, /^Could not save the configuration: check the permissions of the folder/);
  assert.match(failure.message, /Não foi possível salvar a configuração: verifique as permissões da pasta/);
  assert.ok(failure.message.includes(resolve(root)), failure.message);
  assert.match(failure.message, /okit-plugin setup/);
  assert.doesNotMatch(failure.message, /EACCES|permission denied|errno/);
  // The sentence comes from the branch that writes the file: the stack keeps
  // the frame of the lock, which the catch around the lock does not have.
  assert.match(failure.stack, /withLock/);
  // Nothing was written: the file of the configuration is not there.
  await assert.rejects(readFile(join(root, 'config.json'), 'utf8'), { code: 'ENOENT' });
});

test('the sentence of a failed write never carries the error of the write', async (t) => {
  const { home, root } = await temporaryHome(t);
  // A write that fails with the error of the setup itself: the sentence of
  // the setup is the one that comes out, never the text of the failure.
  const failure = await runSetup({
    root,
    config: {},
    env: { HOME: home, OKWORK_HOME: root },
    run: falseRun(),
    defaults: true,
    locale: 'both',
    adapters: [fakeClient('claude-code', ['haiku', 'sonnet', 'opus'])],
    write: async () => {
      throw new SetupSaveError('EACCES: permission denied, write');
    },
  }).then(() => null, (error) => error);
  assert.ok(failure, 'the setup must fail');
  assert.ok(failure instanceof SetupSaveError, failure.name);
  assert.match(failure.message, /^Could not save the configuration/);
  assert.match(failure.message, /Não foi possível salvar a configuração/);
  assert.doesNotMatch(failure.message, /EACCES|permission denied/);
});

test('an unexpected error inside the lock is reported as the simple sentence', { timeout: 15000 }, async (t) => {
  const { home, root } = await temporaryHome(t);
  // The lock cannot be taken: the path that should hold it is a file that is
  // older than the lock itself. The error that comes out of it is technical,
  // and the setup must not let it out.
  const lock = join(root, 'locks', 'config.lock');
  await mkdir(join(root, 'locks'), { recursive: true });
  await writeFile(lock, 'x');
  const old = new Date(Date.now() - 120000);
  await utimes(lock, old, old);
  const failure = await runSetup({
    root,
    config: {},
    env: { HOME: home, OKWORK_HOME: root },
    run: falseRun(),
    defaults: true,
    locale: 'both',
    adapters: [fakeClient('claude-code', ['haiku', 'sonnet', 'opus'])],
  }).then(() => null, (error) => error);
  assert.ok(failure, 'the setup must fail');
  assert.ok(failure instanceof SetupSaveError, failure.name);
  assert.match(failure.message, /^Could not save the configuration/);
  assert.match(failure.message, /Não foi possível salvar a configuração/);
  assert.doesNotMatch(failure.message, /ENOTDIR|not a directory|is held by|ENOTEMPTY/);
  // Nothing was written: the file of the configuration is not there.
  await assert.rejects(readFile(join(root, 'config.json'), 'utf8'), { code: 'ENOENT' });
});

test('the command line that cannot save says the sentence without the command before it', async (t) => {
  // As root the mode of a folder refuses nothing: the write would succeed and
  // the sentence would never be the answer.
  if (process.getuid?.() === 0) {
    t.skip('the process is root: the mode of a folder does not refuse a write');
    return;
  }
  const { home, root } = await temporaryHome(t);
  await mkdir(root, { recursive: true });
  await chmod(root, 0o555);
  try {
    // The system has to apply the mode: without it the folder still takes a
    // write and there is no refusal to report.
    const writable = await writeFile(join(root, 'probe'), 'x').then(() => true, () => false);
    if (writable) {
      t.skip('the system did not apply the mode to the folder');
      return;
    }
    const output = [];
    const errors = [];
    const code = await mainBothLanguages(['setup', '--defaults'], {
      root,
      env: { HOME: home, OKWORK_HOME: root },
      run: falseRun(),
      adapters: [fakeClient('claude-code', ['haiku', 'sonnet', 'opus'])],
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    });
    assert.equal(code, 1);
    assert.deepEqual(output, []);
    const said = errors.join('\n');
    // The sentence opens the line: the command does not come before it.
    assert.ok(said.startsWith('Could not save the configuration'), said);
    assert.match(said, /Não foi possível salvar a configuração/);
    assert.doesNotMatch(said, /^okit-plugin:/m);
  } finally {
    await chmod(root, 0o755);
  }
});
