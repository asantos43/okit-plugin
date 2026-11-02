// The command line in a real process. The module of the command line decides at load time what it
// loads, so a test that calls `main` in this process cannot see that decision: it sees the imports
// the test itself already made. These cases run `node src/cli.js` as a child, which is the only
// way to see what a person sees.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('../', import.meta.url)));
const CLI = join(REPO, 'src', 'cli.js');
const SCRATCH = tmpdir();

/**
 * A state root and a temp folder of their own for one run.
 *
 * @param {object} t the test context
 * @returns {Promise<{root: string, tmp: string}>} the folders of the run
 */
async function scopeFor(t) {
  await mkdir(SCRATCH, { recursive: true });
  const root = await mkdtemp(join(SCRATCH, 'cli-process-'));
  const tmp = join(root, 'tmp');
  await mkdir(tmp, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, tmp };
}

/**
 * Runs the command line in a child process and answers what it said.
 *
 * @param {string[]} args the arguments of the command line
 * @param {object} scope the folders of the run
 * @param {object} [extra] the variables the environment of the child adds
 * @returns {{status: number|null, stdout: string, stderr: string}} what the run said
 */
function runCli(args, scope, extra = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    input: '',
    timeout: 20000,
    encoding: 'utf8',
    env: {
      ...process.env,
      OKWORK_HOME: scope.root,
      TMPDIR: scope.tmp,
      TEMP: scope.tmp,
      TMP: scope.tmp,
      ...extra,
    },
  });
  assert.ifError(result.error);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// The groups that answer the usage with the code of a refusal: the help flag of a group that is
// not a command of the person (the internal entry points, the removed ones and an unknown one).
const REFUSED = [
  ['statusline-collector', '--help'],
  ['statusline-collector', '-h'],
  ['hook', 'session-start', '--help'],
  ['hook', 'post-compact', '-h'],
  ['daemon', 'run-once', '--help'],
  ['daemon', 'stop', '--help'],
  ['status', '--help'],
  ['nope', '-h'],
];

// The ones that answer the usage with the code of a success: the help of the program and of the
// five commands of the person.
const ANSWERED = [['--help'], ['install', '-h'], ['doctor', '--help']];

test('a help flag of a group that is not a command of the person answers the usage and exits 2', async (t) => {
  const scope = await scopeFor(t);
  for (const args of REFUSED) {
    const run = runCli(args, scope);
    assert.equal(run.status, 2, `${args.join(' ')} exits 2`);
    assert.equal(run.stdout, '', `${args.join(' ')} prints nothing`);
    assert.ok(run.stderr.startsWith('usage: okit-plugin install'), `${args.join(' ')}: ${run.stderr}`);
  }
});

test('the help of the program and of the five commands answers the usage and exits 0', async (t) => {
  const scope = await scopeFor(t);
  for (const args of ANSWERED) {
    const run = runCli(args, scope);
    assert.equal(run.status, 0, `${args.join(' ')} exits 0`);
    assert.equal(run.stderr, '', `${args.join(' ')} says nothing`);
    assert.ok(run.stdout.startsWith('usage:'), `${args.join(' ')}: ${run.stdout}`);
  }
});

// The guard of the hermetic case: it refuses a forbidden import and records every attempt, so a
// refusal that the collector swallows is still seen.
const GUARD = [
  "import { appendFileSync } from 'node:fs';",
  'const log = process.env.OKIT_FORBIDDEN_LOG;',
  'export async function resolve(s, c, n) {',
  '  const r = await n(s, c);',
  '  const url = String(r.url ?? "");',
  '  if (s.includes("daemon.js") || s.includes("/mcp/") || url.includes("daemon.js") || url.includes("/mcp/")) {',
  '    if (log) appendFileSync(log, s + " -> " + url + "\\n");',
  '    throw Error("heavy import: " + s);',
  '  }',
  '  return r;',
  '}',
].join('\n');

test('the collector starts for real: no crash, no heavy import, no output of the program', async (t) => {
  const scope = await scopeFor(t);
  const loader = join(scope.root, 'guard.mjs');
  const log = join(scope.root, 'forbidden.log');
  await writeFile(loader, GUARD, 'utf8');
  const result = spawnSync(process.execPath, ['--no-warnings', '--loader', loader, CLI, 'statusline-collector'], {
    cwd: REPO,
    input: '',
    timeout: 20000,
    encoding: 'utf8',
    env: {
      ...process.env,
      OKWORK_HOME: scope.root,
      OKIT_FORBIDDEN_LOG: log,
      TMPDIR: scope.tmp,
      TEMP: scope.tmp,
      TMP: scope.tmp,
    },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '', 'the collector says nothing');
  assert.equal(await readFile(log, 'utf8').catch(() => ''), '', 'no daemon and no MCP server was loaded');
});
