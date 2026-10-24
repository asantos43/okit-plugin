import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import adapter, { capabilities, configRoot, installHooks, installSkill, readQuota, spawn }
  from '../adapters/codex/index.js';
import { adapterQuotaReader } from '../src/status.js';

const temps = [];
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), 'okit-codex-'));
  temps.push(dir);
  return dir;
}
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

// | case | must pass | must refuse |
// | :- | :- | :- |
// | spawn | native descriptor; exact process argv via fake | no model/prompt, invalid effort/mode |
// | skills | copy, repeat no-op, preserve differing bytes | traversal, missing SKILL.md |
// | hooks | preserve every user entry, repeat no-op | unverified schema always |
// | quota | finite user sample; absent means unknown | malformed JSON |

test('default export and capabilities expose independent contract values', () => {
  for (const name of ['spawn', 'readQuota', 'capabilities', 'installSkill', 'installHooks', 'configRoot']) {
    assert.equal(typeof adapter[name], 'function');
  }
  const first = capabilities();
  assert.ok(first.models.includes('gpt-6.1-sol'));
  assert.deepEqual(first.efforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual([first.skills, first.hooks, first.mcp, first.desktop, first.windows],
    [true, false, true, false, false]);
  first.models.length = 0;
  first.efforts.push('invented');
  assert.ok(capabilities().models.length > 0);
  assert.ok(!capabilities().efforts.includes('invented'));
});

test('configRoot uses explicit option, CODEX_HOME, then runtime home', async () => {
  const root = await temp();
  const env = { CODEX_HOME: join(root, 'environment') };
  assert.equal(configRoot({ root, env }), root);
  assert.equal(configRoot({ env }), env.CODEX_HOME);
  assert.equal(configRoot({ root: ' ', env }), env.CODEX_HOME);
  assert.equal(configRoot({ env: {} }), join(homedir(), '.codex'));
  assert.equal(configRoot({ env: { CODEX_HOME: ' ' } }), join(homedir(), '.codex'));
  assert.equal(configRoot({ root: 'relative', env }), resolve('relative'));
});

test('spawn native returns a descriptor without starting a process', async () => {
  const result = await spawn({ model: 'chosen-model', effort: 'high' }, 'brief', {
    spawn() { assert.fail('native must not start a process'); }, runId: 'native-test',
  });
  assert.deepEqual(result, { mode: 'NATIVE', runId: 'native-test',
    agentCall: { model: 'chosen-model', effort: 'high', prompt: 'brief' } });
  assert.equal((await spawn({ model: 'custom' }, 'brief')).agentCall.effort, null);
});

test('spawn PROCESS builds exact Codex argv and preserves injected environment', async () => {
  const root = await temp();
  const calls = [];
  const fake = (command, args, options) => {
    calls.push({ command, args, options });
    return { pid: 4242, on() {}, unref() {} };
  };
  const prompt = 'literal $(never-execute); with spaces';
  const result = await spawn({ model: 'chosen-model', effort: 'high' }, prompt, {
    headless: true, spawn: fake, logDir: join(root, 'runs'), cwd: root,
    root, env: { CUSTOM: 'kept', CODEX_HOME: 'ignored' }, runId: 'codex-test', sandbox: 'read-only',
  });
  assert.deepEqual(result, { mode: 'PROCESS', runId: 'codex-test', pid: 4242 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'codex');
  assert.deepEqual(calls[0].args, ['exec', '--cd', root, '--model', 'chosen-model',
    '--sandbox', 'read-only', '--json', '--skip-git-repo-check',
    '-c', 'model_reasoning_effort=high', prompt]);
  assert.deepEqual(calls[0].options.env, { CUSTOM: 'kept', CODEX_HOME: root, OKWORK_NO_DAEMON: '1' });
  assert.equal(calls[0].options.cwd, root);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.shell, undefined);
  const run = JSON.parse(await readFile(join(root, 'runs', 'codex-test.json'), 'utf8'));
  assert.equal(run.client, 'codex');
});

test('spawn refuses invalid input before any process starts', async () => {
  const cases = [[{}, 'brief', {}], [{ model: 'm' }, '', {}],
    [{ model: 'm', effort: 'invented' }, 'brief', {}],
    [{ model: 'm' }, 'brief', { mode: 'other' }],
    [{ model: 'm' }, 'brief', { headless: 'yes' }]];
  for (const [actor, prompt, opts] of cases) {
    await assert.rejects(spawn(actor, prompt, { ...opts,
      spawn() { assert.fail('invalid input must not start a process'); } }), TypeError);
  }
});

test('readQuota parses a recorded user sample read-only and is registered in core', async () => {
  const root = await temp();
  const opts = { stateRoot: root };
  assert.deepEqual(await readQuota(opts), { source: 'user' });
  await mkdir(join(root, 'quota'));
  const file = join(root, 'quota', 'codex.json');
  const sample = '{"remainingPct":61,"windowMinutes":300,"client":"codex"}\n';
  await writeFile(file, sample);
  const before = await stat(file);
  const expected = { source: 'user', remainingPct: 61, windowMinutes: 300 };
  assert.deepEqual(await readQuota(opts), expected);
  assert.deepEqual(await adapterQuotaReader(opts)('codex'), expected);
  assert.deepEqual(await adapterQuotaReader(opts)('claude-code'), { source: 'user' });
  assert.equal(await readFile(file, 'utf8'), sample);
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  for (const [sample, expected] of [[{ remainingPct: 0 }, { source: 'user', remainingPct: 0 }],
    [{ remainingPct: '61' }, { source: 'user' }],
    [{ remainingPct: 61, windowMinutes: '300' }, { source: 'user', remainingPct: 61 }]]) {
    await writeFile(file, JSON.stringify(sample));
    assert.deepEqual(await readQuota(opts), expected);
  }
  await writeFile(file, 'not JSON');
  await assert.rejects(readQuota(opts));
});

test('installSkill preserves differing files and repeat installation changes nothing', async () => {
  const root = await temp();
  const source = await temp();
  await writeFile(join(source, 'SKILL.md'), '# original skill\n');
  await writeFile(join(source, 'notes.md'), 'original notes\n');
  const opts = { env: { CODEX_HOME: root } };
  const installed = await installSkill('chosen-skill', source, opts);
  assert.equal(installed.path, join(root, 'skills', 'chosen-skill'));
  assert.deepEqual(installed.written, ['SKILL.md', 'notes.md']);
  const target = join(installed.path, 'SKILL.md');
  await writeFile(target, '# user version\n');
  await writeFile(join(installed.path, 'user.md'), 'keep me');
  const before = await stat(target);
  for (let n = 0; n < 2; n += 1) {
    const repeated = await installSkill('chosen-skill', source, opts);
    assert.deepEqual(repeated.written, []);
    assert.deepEqual(repeated.skipped, [{ path: 'SKILL.md', reason: 'differs' },
      { path: 'notes.md', reason: 'identical' }]);
  }
  assert.equal(await readFile(target, 'utf8'), '# user version\n');
  assert.equal((await stat(target)).mtimeMs, before.mtimeMs);
  assert.equal(await readFile(join(installed.path, 'user.md'), 'utf8'), 'keep me');
});

test('installSkill refuses unsafe names and folders without SKILL.md', async () => {
  const root = await temp();
  const source = await temp();
  await writeFile(join(source, 'SKILL.md'), '# valid source skill\n');
  for (const name of ['', '..', '../escape', 'a/b', 'a\\b', '.hidden', 'a..b']) {
    await assert.rejects(installSkill(name, source, { root }), TypeError);
    assert.deepEqual(await readdir(root), [], `no destination writes for ${JSON.stringify(name)}`);
  }
  await assert.rejects(installSkill('valid', root, { root }), /SKILL.md/);
  assert.deepEqual(await readdir(root), []);
});

test('installHooks refuses twice without changing any user entries or creating files', async () => {
  const root = await temp();
  const file = join(root, 'config.toml');
  const bytes = '# user settings\n[hooks]\nuser_entry = "keep"\n';
  await writeFile(file, bytes);
  const before = await stat(file);
  for (let n = 0; n < 2; n += 1) {
    await assert.rejects(installHooks({ hooks: [] }, { root }),
      /unsupported.*no verified configuration schema.*not changed/);
  }
  assert.equal(await readFile(file, 'utf8'), bytes);
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await readdir(root), ['config.toml']);
});
