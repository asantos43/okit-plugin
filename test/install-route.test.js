import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { chooseRoute, routeReason, ROUTE_TEXT } from '../src/install/route.js';
import { installUiCommand, UI_FALLBACK } from '../src/config-ui/wizard-cli.js';
import { launchConfigBrowser } from '../src/cli.js';
import { labels } from '../src/config-ui/labels.js';

// Every row: the facts of a run and the route with its reason. `check` returns the rows a version of the function gets wrong.
const DISPLAY = { DISPLAY: ':0' };
const ROWS = [
  ['linux desktop with an opener', { platform: 'linux', env: DISPLAY, hasOpener: true }, 'ui', null],
  ['wayland desktop with an opener', { platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, hasOpener: true }, 'ui', null],
  ['SSH_CONNECTION wins over a display', { platform: 'linux', env: { ...DISPLAY, SSH_CONNECTION: '1 2 3 4' }, hasOpener: true }, 'terminal', 'ssh'],
  ['SSH_TTY wins over a display', { platform: 'linux', env: { ...DISPLAY, SSH_TTY: '/dev/pts/1' }, hasOpener: true }, 'terminal', 'ssh'],
  ['linux without DISPLAY and WAYLAND_DISPLAY', { platform: 'linux', env: {}, hasOpener: true }, 'terminal', 'display'],
  ['container without a graphical session', { platform: 'linux', env: {}, container: true, hasOpener: true }, 'terminal', 'container'],
  ['container with a forwarded display', { platform: 'linux', env: DISPLAY, container: true, hasOpener: true }, 'ui', null],
  ['missing opener', { platform: 'linux', env: DISPLAY, hasOpener: false }, 'terminal', 'opener'],
  ['macOS needs no DISPLAY', { platform: 'darwin', env: {}, hasOpener: true }, 'ui', null],
  ['macOS over SSH', { platform: 'darwin', env: { SSH_CONNECTION: 'x' }, hasOpener: true }, 'terminal', 'ssh'],
  ['macOS without open', { platform: 'darwin', env: {}, hasOpener: false }, 'terminal', 'opener'],
  ['options only the terminal supports', { platform: 'linux', env: DISPLAY, hasOpener: true, unattended: true }, 'terminal', 'options'],
  ['--terminal forced on a desktop', { platform: 'linux', env: DISPLAY, hasOpener: true, flags: { terminal: true } }, 'terminal', null],
  ['--ui never falls back (SSH, no opener)', { platform: 'linux', env: { SSH_CONNECTION: 'x' }, hasOpener: false, flags: { ui: true } }, 'ui', null],
  ['--headless is the browser route without a display', { platform: 'linux', env: {}, hasOpener: false, flags: { headless: true } }, 'ui', null],
  ['--ui with --yes style options still the browser', { platform: 'linux', env: DISPLAY, hasOpener: true, unattended: true, flags: { ui: true } }, 'ui', null],
];
const check = (choose) => ROWS.filter(([, facts, route, reason]) => {
  const got = choose(facts);
  return got.route !== route || got.reason !== reason;
}).map(([name]) => name);

test('the route is decided from the environment, and an explicit flag is never overridden', () => {
  assert.deepEqual(check(chooseRoute), []);
});

test('mutation proof: the table fails for a routing function with one rule broken', async () => {
  const source = await readFile(new URL('../src/install/route.js', import.meta.url), 'utf8');
  const mutants = {
    'ignores SSH': ["if (env.SSH_CONNECTION || env.SSH_TTY) return", "if (false) return"],
    'checks DISPLAY on macOS': ["platform !== 'darwin' && !env.DISPLAY", "!env.DISPLAY"],
    'ignores a missing opener': ["if (!hasOpener) return", "if (false) return"],
    'never says container': ["container ? 'container' : 'display'", "'display'"],
    '--ui falls back': ["if (flags.ui || flags.headless) return { route: 'ui', reason: null };", ""],
    '--terminal is overridden': ["if (flags.terminal) return { route: 'terminal', reason: null };", ""],
    'unattended ignored': ["if (unattended) return", "if (false) return"],
  };
  for (const [name, [from, to]] of Object.entries(mutants)) {
    assert.ok(source.includes(from), `${name}: the mutation does not apply`);
    const mutated = await import(`data:text/javascript,${encodeURIComponent(source.replace(from, to))}`);
    assert.notDeepEqual(check(mutated.chooseRoute), [], `${name}: the table must fail`);
  }
});

test('every reason is said in English and in Brazilian Portuguese, and the labels carry the same texts', () => {
  const reasons = ['ssh', 'container', 'display', 'opener', 'opener-failed', 'options', 'no-terminal'];
  assert.deepEqual(Object.keys(ROUTE_TEXT.en), reasons);
  assert.deepEqual(Object.keys(ROUTE_TEXT['pt-BR']), reasons);
  for (const reason of reasons) {
    assert.notEqual(routeReason('en', reason), routeReason('pt-BR', reason), reason);
    assert.equal(labels.en.route[reason], routeReason('en', reason));
    assert.equal(labels['pt-BR'].route[reason], routeReason('pt-BR', reason));
  }
  assert.match(routeReason('en', 'ssh'), /^No graphical session detected \(SSH\); using the terminal installer\. Use --ui --headless/);
  assert.match(routeReason('pt-BR', 'ssh'), /^Nenhuma sessão gráfica detectada \(SSH\)/); // locale:pt-BR
  assert.equal(routeReason('fr', 'ssh'), routeReason('en', 'ssh'));
});

test('launchConfigBrowser says whether the opener started', async () => {
  const spawned = new EventEmitter(); spawned.unref = () => {};
  assert.equal(await launchConfigBrowser('http://x', 'linux', () => { queueMicrotask(() => spawned.emit('spawn')); return spawned; }), true);
  const failing = new EventEmitter(); failing.unref = () => {};
  assert.equal(await launchConfigBrowser('http://x', 'linux', () => { queueMicrotask(() => failing.emit('error', new Error('ENOENT'))); return failing; }), false);
  assert.equal(await launchConfigBrowser('http://x', 'linux', () => { throw new Error('boom'); }), false);
});

function session() {
  let finish; const closed = new Promise((resolve) => { finish = resolve; }); const state = { closes: 0 };
  return { state, value: { url: 'http://127.0.0.1:1/?token=t', closed, close() { state.closes += 1; finish(); } } };
}

test('--auto falls back to the terminal installer when the browser cannot be opened, before any URL or job', async () => {
  for (const locale of ['en', 'pt-BR']) {
    const { state, value } = session(); const out = [];
    const code = await installUiCommand({ root: '/r', env: {}, locale, platform: 'linux', out: (line) => out.push(line) },
      { ui: true, auto: true, asset: 'a.tar.gz', fallback: true, repo: 'o/r' }, { startConfigServer: async () => value },
      () => assert.fail('the plain opener is not used by --auto'), async () => false);
    assert.equal(code, UI_FALLBACK);
    assert.equal(state.closes, 1, 'the server is closed: no web job stays active');
    assert.deepEqual(out, [routeReason(locale, 'opener-failed')]);
  }
});

test('--auto keeps the browser route when the opener starts; --ui alone never falls back and refuses script-only options', async () => {
  const { state, value } = session(); const out = []; const controller = new AbortController();
  const pending = installUiCommand({ root: '/r', env: {}, locale: 'en', platform: 'linux', signal: controller.signal, out: (line) => out.push(line) },
    { ui: true, auto: true, asset: 'a.tar.gz' }, { startConfigServer: async () => value }, () => assert.fail('no'), async () => true);
  while (out.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(out, [value.url]); controller.abort();
  assert.equal(await pending, 0); assert.equal(state.closes, 1);
  await assert.rejects(installUiCommand({ root: '/r', env: {}, locale: 'en', platform: 'linux', out() {} }, { ui: true, asset: 'a.tar.gz' },
    { startConfigServer: () => assert.fail('no listener') }, () => {}), /Unknown flag: --asset/);
});
