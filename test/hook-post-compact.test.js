import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { main } from '../src/cli.js';
import { buildPostCompactText, postCompactConfig, runPostCompact } from '../src/hook-post-compact.js';
import { installPostCompactHook, postCompactHooks } from '../adapters/claude-code/index.js';
import { DEFAULT_CONFIG } from '../src/profiles.js';

const cwd = resolve('.');
const full = {
  cwd,
  items: [{ id: 'I1', title: 'Work\nin progress', status: 'delegated', body: 'SECRET' },
    { id: 'I2', title: 'Open', status: 'pending', appliesTo: cwd },
    { id: 'I3', title: 'Other project', status: 'pending', appliesTo: `${cwd}/other` },
    { id: 'I4', title: 'Finished', status: 'consolidated' }],
  orders: [{ id: 'G1', text: 'Order title\nSECRET', active: true },
    { id: 'G2', text: 'Revoked', active: false },
    { id: 'G3', text: 'Expired', active: true, until: '2000-01-01' }],
};

async function scratch(t) {
  await mkdir('.delegate/tmp', { recursive: true });
  const root = await mkdtemp('.delegate/tmp/post-compact-');
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('builder: empty state is silent', () => {
  assert.equal(buildPostCompactText(), '');
});

test('builder: full state includes only open project work and active order titles', () => {
  const text = buildPostCompactText(full);
  assert.match(text, /Inbox \[delegated\] I1: Work in progress/);
  assert.match(text, /Inbox \[pending\] I2: Open/);
  assert.match(text, /Standing orders G1: Order title/);
  assert.match(text, /Status: 2 open inbox items; 1 active standing orders/);
  assert.doesNotMatch(text, /SECRET|Other project|Finished|Revoked|Expired/);
});

test('builder: line cap and disabled sections are configurable', () => {
  assert.equal(buildPostCompactText({ ...full, config: { postCompact: { maxLines: 3 } } }).split('\n').length, 3);
  const text = buildPostCompactText({ ...full, config: { postCompact: { sections: { inbox: false } } } });
  assert.doesNotMatch(text, /Inbox \[/);
  assert.match(text, /Standing orders/);
});

test('CLI: invalid JSON, missing state, off switch and corrupt state stay silent', async (t) => {
  const root = await scratch(t);
  const invoke = async (stdin) => {
    const out = [], err = [];
    const code = await main(['hook', 'post-compact'], {
      root, stdin, stdout: (text) => out.push(text), stderr: (text) => err.push(text),
    });
    assert.deepEqual({ code, out, err }, { code: 0, out: [], err: [] });
  };
  await invoke('{broken');
  await invoke(JSON.stringify({ cwd }));
  await writeFile(join(root, 'inbox.json'), 'broken');
  await invoke(JSON.stringify({ cwd }));
  await writeFile(join(root, 'config.json'), JSON.stringify({ postCompact: { enabled: false } }));
  await invoke(JSON.stringify({ cwd }));
  await writeFile(join(root, 'config.json'), '{broken');
  await invoke(JSON.stringify({ cwd }));
});

test('hook: errors and deadline discard all output', async () => {
  for (const load of [async () => { throw new Error('SECRET'); }, () => new Promise(() => {})]) {
    const out = [];
    assert.equal(await runPostCompact({ root: '.', stdin: JSON.stringify({ cwd }),
      stdout: (text) => out.push(text), load,
      read: async () => ({ postCompact: { timeoutSec: 0.02 } }),
    }), 0);
    assert.deepEqual(out, []);
  }
});

test('hook: stalled stdin is paused on timeout; successful CLI prints once', async (t) => {
  const stream = new Readable({ read() {} });
  assert.equal(await runPostCompact({ root: '.', stdin: stream,
    read: async () => ({ postCompact: { timeoutSec: 0.02 } }),
  }), 0);
  assert.equal(stream.listenerCount('data'), 0);
  assert.equal(stream.isPaused(), true);
  stream.destroy();
  const root = await scratch(t);
  await writeFile(join(root, 'inbox.json'), JSON.stringify({ items: full.items }));
  await writeFile(join(root, 'orders.json'), JSON.stringify({ orders: full.orders }));
  const out = [], err = [];
  const code = await main(['hook', 'post-compact'], {
    root, stdin: Readable.from([JSON.stringify({ cwd })]),
    stdout: (text) => out.push(text), stderr: (text) => err.push(text),
  });
  assert.equal(code, 0);
  assert.deepEqual(err, []);
  assert.deepEqual(out, [buildPostCompactText(full)]);
});

test('configuration fallback and generated registration share DEFAULT_CONFIG', () => {
  assert.equal(postCompactConfig({ postCompact: { timeoutSec: -1 } }).timeoutSec, DEFAULT_CONFIG.postCompact.timeoutSec);
  assert.equal(postCompactHooks().SessionStart[0].hooks[0].timeout, DEFAULT_CONFIG.postCompact.timeoutSec);
  assert.deepEqual(postCompactHooks({ config: { postCompact: { timeoutSec: 9 } } }), {
    SessionStart: [{ matcher: 'compact', hooks: [{ type: 'command', command: 'okit hook post-compact', timeout: 9 }] }],
  });
});

test('installation preserves user entries and second install does not write', async (t) => {
  const root = await scratch(t);
  const file = join(root, 'hooks', 'hooks.json');
  const user = { matcher: 'startup', hooks: [{ type: 'command', command: 'user-hook' }] };
  await mkdir(join(root, 'hooks'));
  await writeFile(file, JSON.stringify({ SessionStart: [user], UserPromptSubmit: [{ hooks: [] }] }));
  assert.equal((await installPostCompactHook({ root })).written, true);
  const first = await readFile(file, 'utf8');
  const parsed = JSON.parse(first);
  assert.deepEqual(parsed.SessionStart, [user, ...postCompactHooks().SessionStart]);
  assert.deepEqual(parsed.UserPromptSubmit, [{ hooks: [] }]);
  assert.equal((await installPostCompactHook({ root })).written, false);
  assert.equal(await readFile(file, 'utf8'), first);
});
