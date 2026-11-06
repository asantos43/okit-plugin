import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { launchLogin } from '../src/accounts-login-launch.js';

function fixture(overrides = {}) {
  const calls = [], searched = [];
  let unrefs = 0;
  const env = { PATH: '/test/bin', CODEX_HOME: '/inherited', CLAUDE_CONFIG_DIR: '/inherited' };
  const input = { client: 'codex', account: { id: 'default' }, platform: 'linux', env,
    which: async name => { searched.push(name); return `/test/bin/${name}`; },
    spawn: (...args) => { calls.push(args); return { unref: () => { unrefs++; } }; }, ...overrides };
  return { input, calls, searched, unrefs: () => unrefs };
}

const terminals = [['gnome-terminal', '--'], ['konsole', '-e'], ['xfce4-terminal', '-x'],
  ['xterm', '-e'], ['x-terminal-emulator', '-e']];

for (const [client, executable, variable] of [['codex', 'codex login', 'CODEX_HOME'],
  ['claude-code', 'claude', 'CLAUDE_CONFIG_DIR']]) {
  for (const [kind, account, saved, mac, win] of [
    ['extra', { configDir: 'C:\\Jo Silva\\work' }, true,
      `${variable}='C:\\Jo Silva\\work' ${executable}`, `$env:${variable}='C:\\Jo Silva\\work'; ${executable}`],
    ['saved default', {}, true, `env -u ${variable} ${executable}`,
      `Remove-Item Env:${variable} -ErrorAction SilentlyContinue; ${executable}`],
    ['alone', {}, false, executable, executable],
  ]) test(`native terminals ${client} ${kind} preserve the whole command`, async () => {
    const f = fixture({ client, account, saved, platform: 'darwin' });
    assert.deepEqual(await launchLogin(f.input), { launched: true, terminal: 'Terminal' });
    assert.deepEqual(f.calls[0], ['osascript', ['-e', 'tell application "Terminal" to activate', '-e',
      `tell application "Terminal" to do script "${mac.replaceAll('\\', '\\\\')}"`],
    { detached: true, stdio: 'ignore', env: f.input.env }]);
    f.input.platform = 'win32';
    assert.deepEqual(await launchLogin(f.input), { launched: true, terminal: 'powershell' });
    assert.deepEqual(f.calls[1], ['cmd.exe', ['/d', '/c', 'start', '', 'powershell.exe', '-NoExit', '-Command', win],
      { detached: true, stdio: 'ignore', env: f.input.env }]);
    assert.equal(f.calls[1][1].length, 8);
    assert.deepEqual(f.searched, []);
    assert.equal(f.unrefs(), 2);
  });
}

// | Corpus | Must pass | Must refuse |
// | folders | letters, spaces, path separators | quotes, controls, shell substitutions/operators |
// | launches | supported client, available terminal | unknown client, missing terminal, spawn error |
test('unsafe folder corpus refuses every platform before spawn or PATH lookup', async () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    for (const configDir of ["/bad'folder", '/bad"folder', '/bad\n', '/$(x)', '/`x`', '/bad;',
      '/bad&', '/bad|', '/bad<', '/bad>', '/bad\t', '/bad\0', '', 12, {}]) {
      const f = fixture({ platform, account: { configDir } });
      assert.deepEqual(await launchLogin(f.input), { launched: false, reason: 'unsafe-folder' });
      assert.deepEqual(f.calls, []);
      assert.deepEqual(f.searched, []);
    }
  }
});

test('unsupported client and missing terminals never spawn', async () => {
  const f = fixture({ client: 'opencode' });
  assert.deepEqual(await launchLogin(f.input), { launched: false, reason: 'unsupported-client' });
  assert.deepEqual(f.searched, []);
  f.input.client = 'codex';
  f.input.which = async name => { f.searched.push(name); return null; };
  assert.deepEqual(await launchLogin(f.input), { launched: false, reason: 'no-terminal' });
  assert.deepEqual(f.searched, terminals.map(([name]) => name));
  assert.deepEqual(f.calls, []);
});

test('spawn and PATH environment errors become no-terminal', async () => {
  for (const overrides of [
    { spawn: () => { throw new Error('ENOENT'); } },
    { which: async () => { throw new Error('EACCES'); } },
    { spawn: () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('error', new Error('ENOENT')));
      return child;
    } },
  ]) assert.deepEqual(await launchLogin(fixture(overrides).input), { launched: false, reason: 'no-terminal' });
});

test('successful asynchronous spawn detaches without waiting for exit', async () => {
  let unrefs = 0;
  const child = new EventEmitter();
  child.unref = () => { unrefs++; };
  const f = fixture({ spawn: () => { queueMicrotask(() => child.emit('spawn')); return child; } });
  assert.deepEqual(await launchLogin(f.input), { launched: true, terminal: 'gnome-terminal' });
  assert.equal(unrefs, 1);
});
for (const [index, [terminal, prefix]] of terminals.entries()) {
  test(`linux selects ${terminal} after earlier terminals are unavailable`, async () => {
    const f = fixture();
    f.input.which = async name => {
      f.searched.push(name);
      return terminals.findIndex(([candidate]) => candidate === name) >= index ? `/test/bin/${name}` : null;
    };
    assert.deepEqual(await launchLogin(f.input), { launched: true, terminal });
    assert.deepEqual(f.searched, terminals.slice(0, index + 1).map(([name]) => name));
    assert.deepEqual(f.calls, [[`/test/bin/${terminal}`, [prefix, 'codex', 'login'],
      { detached: true, stdio: 'ignore', env: f.input.env }]]);
    assert.strictEqual(f.calls[0][2].env, f.input.env);
    assert.equal(Object.hasOwn(f.calls[0][2], 'shell'), false);
    assert.equal(f.unrefs(), 1);
  });
}

for (const [client, variable, command] of [['codex', 'CODEX_HOME', ['codex', 'login']],
  ['claude-code', 'CLAUDE_CONFIG_DIR', ['claude']]]) {
  for (const [kind, account, saved, prefix] of [
    ['extra', { configDir: '/home/Jo Silva/@work+~' }, true, ['env', `${variable}=/home/Jo Silva/@work+~`]],
    ['saved default', {}, true, ['env', '-u', variable]], ['alone', {}, false, []],
  ]) test(`linux ${client} ${kind} uses exact environment argv`, async () => {
    const f = fixture({ client, account, saved });
    assert.equal((await launchLogin(f.input)).launched, true);
    assert.deepEqual(f.calls[0][1], ['--', ...prefix, ...command]);
  });
}
