import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LAUNCHERS, launch } from '../src/launchers.js';
import { main } from '../src/cli.js';
import { SELFCHECK_ENV, paths } from '../src/store.js';

const sample = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 25, resets_at: 1793003358 } } });

async function rootFor(t) {
  const root = await mkdtemp(join(tmpdir(), 'okit-launchers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('the launchers are exactly the three entry points the client launches', () => {
  assert.deepEqual([...LAUNCHERS], ['hook session-start', 'hook post-compact', 'statusline-collector']);
  assert.ok(Object.isFrozen(LAUNCHERS));
});

test('an argv that names no launcher is not a launcher', async () => {
  assert.equal(await launch(['config', 'show'], {}), undefined);
  assert.equal(await launch([], {}), undefined);
  assert.equal(await launch(['hook'], {}), undefined);
  assert.equal(await launch(['hook', 'other'], {}), undefined);
  assert.equal(await launch(['statusline'], {}), undefined);
});

test('each launcher runs and never throws into the client', async (t) => {
  const root = await rootFor(t);
  const written = [];
  const io = () => ({ root, stdin: Readable.from([sample]), stdout: (text) => written.push(text) });
  assert.equal(await launch(['statusline-collector'], io()), 0);
  assert.equal(await launch(['hook', 'post-compact'], io()), 0);
  assert.equal(await launch(['hook', 'session-start'],
    { ...io(), env: { [SELFCHECK_ENV]: '1' } }), 0);
  // A launcher that fails is a failure of the client: the exit code is zero and nothing is printed.
  const quiet = [];
  assert.equal(await launch(['statusline-collector'], { root: join(root, 'missing'),
    stdin: Readable.from([sample]), stdout: (text) => quiet.push(text) }), 0);
});

test('the launchers are hermetic: no daemon and no MCP server is loaded', async (t) => {
  const root = await rootFor(t);
  const loader = join(root, 'guard.mjs');
  await writeFile(loader, 'export async function resolve(s,c,n){if(s.includes("daemon.js")||s.includes("/mcp/"))throw Error("heavy import: "+s);return n(s,c)}');
  const script = join(root, 'child.mjs');
  await writeFile(script, [
    "import { pathToFileURL } from 'node:url';",
    "import { Readable } from 'node:stream';",
    'const module = await import(pathToFileURL(process.argv[2]).href);',
    'const sample = process.argv[4];',
    'const root = process.argv[3];',
    'const io = () => ({ root, stdin: Readable.from([sample]), stdout: () => {} });',
    "const codes = [await module.launch(['config', 'show'], {}),",
    "  await module.launch(['statusline-collector'], io()),",
    "  await module.launch(['hook', 'post-compact'], io()),",
    "  await module.launch(['hook', 'session-start'], { ...io(), env: { OKIT_SELFCHECK: '1' } })];",
    "process.stdout.write(JSON.stringify({ launchers: module.LAUNCHERS, codes }));",
  ].join('\n'));
  const child = spawn(process.execPath, ['--loader', loader, script,
    fileURLToPath(new URL('../src/launchers.js', import.meta.url)), root, sample], { stdio: ['ignore', 'pipe', 'pipe'] });
  const errors = [];
  child.stderr.on('data', (bytes) => errors.push(bytes));
  const [code, out] = await new Promise((resolve, reject) => {
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve([code, Buffer.concat(chunks).toString()]));
  });
  assert.equal(code, 0, Buffer.concat(errors).toString());
  const answer = JSON.parse(out);
  assert.deepEqual(answer.launchers, [...LAUNCHERS]);
  assert.deepEqual(answer.codes, [null, 0, 0, 0], 'the first argv is no launcher (JSON has no undefined)');
});

test('the user help lists none of the three internal entry points', async () => {
  const lines = [];
  assert.equal(await main(['--help'], { stdout: (line) => lines.push(line) }), 0);
  const usage = lines.join('\n');
  for (const name of LAUNCHERS) assert.ok(!usage.includes(name), `${name} is in the user help`);
  assert.ok(!usage.includes('session-start'), 'the session-start hook is in the user help');
});

test('the post-compact launcher reads the state root it is given', async (t) => {
  const root = await rootFor(t);
  const files = paths(root);
  await mkdir(join(files.inbox, '..'), { recursive: true });
  await writeFile(files.inbox, JSON.stringify({ items: [{ id: 'D77', title: 'Launcher root', status: 'pending' }] }));
  const written = [];
  assert.equal(await launch(['hook', 'post-compact'], { root, stdin: Readable.from([JSON.stringify({ cwd: root })]),
    stdout: (text) => written.push(text) }), 0);
  assert.match(written.join(''), /D77: Launcher root/);
});
