import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli.js';
import { flagsOf } from '../src/install/flags.js';
import { EventEmitter } from 'node:events';

const url = 'http://127.0.0.1:32123/?token=abcd1234';
const root = `/tmp/okit-wizard-cli-${process.pid}`;
// Must pass: explicit UI/headless/terminal. Must refuse: terminal+UI/headless, unsupported UI choices.
test('UI flag parsing and mutual exclusion are localized before starting a listener', async () => {
  assert.equal(flagsOf('install', ['--ui']).ui, true);
  assert.equal(flagsOf('install', ['--headless']).headless, true);
  for (const locale of ['en', 'pt-BR']) for (const flags of [['--ui', '--terminal'], ['--headless', '--terminal']]) {
    const errors = [];
    assert.equal(await main(['install', ...flags, '--locale', locale], { root, env: {}, stdout() {},
      stderr: (line) => errors.push(line), startConfigServer: () => assert.fail('conflicting flags must not listen') }), 2);
    assert.match(errors.join('\n'), locale === 'en' ? /cannot be combined/ : /não podem ser combinadas/); // locale:pt-BR
  }
});

test('headless prints the private URL once and never starts an opener', async () => {
  const output = [], controller = new AbortController(); let options, closes = 0, finish;
  const closed = new Promise((resolve) => { finish = resolve; });
  const code = await main(['install', '--headless', '--from', '.', '--client', 'codex'], { root, env: {},
    signal: controller.signal, stdout: (line) => { output.push(line); if (line === url) controller.abort(); },
    spawn: () => assert.fail('headless must not open'),
    startConfigServer: async (value) => { options = value; return { url, closed, close() { closes++; finish(); } }; } });
  assert.equal(code, 0); assert.equal(closes, 1); assert.deepEqual(output, [url]);
  assert.deepEqual(options.firstRun, { operation: 'install', clients: ['codex'], options: { from: '.' } });
});

test('opener failure keeps the UI alive and URL usable until explicit close', async () => {
  const output = [], controller = new AbortController(); let closes = 0, finish, opened = 0;
  const closed = new Promise((resolve) => { finish = resolve; });
  const pending = main(['install', '--ui'], { root, env: {}, signal: controller.signal,
    stdout: (line) => output.push(line),
    startConfigServer: async () => ({ url, closed, close() { closes++; finish(); } }),
    spawn: () => { opened++; throw new Error('opener unavailable'); } });
  while (output.length === 0 || opened === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(output, [url]); assert.equal(opened, 1); assert.equal(closes, 0);
  controller.abort(); assert.equal(await pending, 0); assert.equal(closes, 1);
});

test('async opener errors keep the server alive and no-UI paths never call it', async () => {
  let finish;
  const child = new EventEmitter(); child.unref = () => {};
  const pending = main(['install', '--ui'], { root, env: {}, stdout() {},
    startConfigServer: async () => ({ url, closed: new Promise((resolve) => { finish = resolve; }), close: () => finish() }),
    spawn: () => child });
  await new Promise(setImmediate); child.emit('error', new Error('not installed')); finish();
  assert.equal(await pending, 0);
  for (const flags of [[], ['--terminal'], ['--yes']]) {
    await main(['install', ...flags, '--unknown'], { root, env: {}, stdout() {}, stderr() {},
      startConfigServer: () => assert.fail('released defaults must not start a server'), spawn: () => assert.fail('no browser') });
  }
});
