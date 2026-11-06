import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { main, openConfigBrowser } from '../src/cli.js';

const url = 'http://127.0.0.1:1234/?token=abcd1234';
test('config ui returns zero when the injected session closes normally', async () => {
  const output = [];
  let finish;
  const closed = new Promise((resolve) => { finish = resolve; });
  const pending = main(['config', 'ui', '--no-open'], {
    env: { OKIT_LANGUAGE: 'en' }, stdout: (line) => { output.push(line); if (line === url) finish(); },
    startConfigServer: async () => ({ url, closed, close: finish }),
  });
  assert.equal(await pending, 0);
  assert.equal(output.filter((line) => line === url).length, 1);
});

test('config ui prints its URL once and waits for abort to close the session', async () => {
  const output = [];
  const controller = new AbortController();
  let close, closes = 0;
  const closed = new Promise((resolve) => { close = () => { closes += 1; resolve(); }; });
  const code = await main(['config', 'ui', '--no-open', '--idle-minutes', '1'], {
    env: { OKIT_LANGUAGE: 'en' }, signal: controller.signal,
    stdout: (line) => { output.push(line); if (line === url) controller.abort(); },
    startConfigServer: async (options) => {
      assert.equal(options.idleMs, 60_000);
      return { url, closed, close };
    }, spawn: () => assert.fail('no browser with --no-open'),
  });
  assert.equal(code, 0);
  assert.equal(output.filter((line) => line === url).length, 1);
  assert.ok(closes >= 1);
});

test('main output door exposes only the first valid session URL and clears its exception', async () => {
  const candidates = [url, 'http://127.0.0.1:1234/?token=nonhex',
    'http://127.0.0.1:1234/?token=ab%63', 'http://example.com:1234/?token=abcd'];
  let ctx;
  Object.defineProperty(Object.prototype, 'sessionUrl', { configurable: true, set(value) {
    ctx = this;
    Object.defineProperty(this, 'sessionUrl', { value, writable: true, configurable: true });
  } });
  try {
    for (const candidate of candidates) {
      const output = [];
      assert.equal(await main(['config', 'ui', '--no-open'], {
        env: { OKIT_LANGUAGE: 'en' }, stdout: line => output.push(line),
        startConfigServer: async () => ({ url: candidate, close() {}, get closed() {
          assert.equal(ctx.sessionUrl, undefined);
          ctx.out(candidate);
          return Promise.resolve();
        } }),
      }), 0);
      assert.equal(output.filter(line => line === candidate).length, candidate === url ? 1 : 0);
      assert.equal(output.at(-1), candidate.split('?')[0]);
    }
  } finally { delete Object.prototype.sessionUrl; }
});

test('idle minutes and unknown flags must refuse with usage', async () => {
  for (const flags of [['--idle-minutes', '0'], ['--idle-minutes', 'abc'],
    ['--idle-minutes', '99999'], ['--unknown']]) {
    const errors = [];
    assert.equal(await main(['config', 'ui', ...flags], {
      env: { OKIT_LANGUAGE: 'en' }, stdout: () => {}, stderr: (line) => errors.push(line),
      startConfigServer: () => assert.fail('invalid flags must not start a server'),
    }), 2);
    assert.match(errors.join('\n'), /usage: .* install/);
  }
});

test('browser launch keeps the URL in one argv element without a shell', () => {
  for (const [platform, command, args] of [['linux', 'xdg-open', [url]],
    ['darwin', 'open', [url]], ['win32', 'cmd', ['/c', 'start', '', url]]]) {
    openConfigBrowser(url, platform, (actual, argv, options) => {
      assert.equal(actual, command);
      assert.deepEqual(argv, args);
      assert.equal(options.shell, false);
      const child = new EventEmitter();
      child.unref = () => {};
      return child;
    });
  }
  assert.doesNotThrow(() => openConfigBrowser(url, 'linux', () => { throw new Error('missing browser'); }));
});
