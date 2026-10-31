import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

import adapter, { capabilities, configRoot, installHooks, installSkill, readQuota, spawn } from '../adapters/claude-code/index.js';
import { rolePrompt } from '../src/roles.js';
const brief = (text) => `Role: Executor\n${text}`;
const prompt = (text) => rolePrompt({ client: 'claude-code', briefing: brief(text) });

const roots = [];
const temps = [];

// | Must pass | Must refuse |
// | native main Director, briefed roles, preserved user settings | ambiguous role, unsupported schema |
test('native role hook and Agent briefing preserve user settings and actor', async () => {
  const root = await temp('roles');
  const file = join(root, 'settings.json');
  const user = { model: 'user-model', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'user-hook' }] }] } };
  await writeFile(file, JSON.stringify(user));
  for (let n = 0; n < 2; n++) assert.equal((await adapter.installRole({ root })).status, 'ready');
  const installed = JSON.parse(await readFile(file));
  assert.equal(installed.hooks.SessionStart.length, 2);
  assert.match(installed.hooks.SessionStart[1].hooks[0].command, /hook session-start/);
  assert.equal(installed.model, 'user-model');
  const main = adapter.deliverRole();
  assert.match(main.native.hookSpecificOutput.additionalContext, /Role: Director/);
  for (const role of ['Executor', 'Critic']) {
    const delivery = adapter.deliverRole({ briefing: `Role: ${role}\nInspect changes`, actor: { model: 'sonnet', effort: 'high' } });
    assert.equal(delivery.context.role, role);
    assert.equal(delivery.native.agentCall.model, 'sonnet');
    assert.equal(delivery.native.agentCall.effort, 'high');
    const launched = await spawn({ model: 'sonnet', effort: 'high' }, `Role: ${role}\nInspect changes`);
    assert.equal(launched.agentCall.model, 'sonnet');
    assert.match(launched.agentCall.prompt, new RegExp(`Role: ${role}`));
    for (const field of ['Orders:', 'Limits:', 'Work in hand:', 'Available actors:', 'Unknown facts:', 'Ordens:', 'Fatos desconhecidos:']) assert.ok(delivery.native.agentCall.prompt.includes(field));
  }
  for (let n = 0; n < 2; n++) await adapter.removeRole({ root });
  assert.deepEqual(JSON.parse(await readFile(file)), user);
  assert.equal((await adapter.installRole({ root, briefing: 'do something' })).status, 'clarification');
  assert.equal((await adapter.installRole({ root, nativeSupported: false })).status, 'unsupported');
  await assert.rejects(spawn({ model: 'sonnet' }, 'do something'), /Clarify/);
  assert.deepEqual(JSON.parse(await readFile(file)), user);
  await writeFile(file, '{"hooks":{"SessionStart":"unknown-format"}}');
  assert.equal((await adapter.installRole({ root })).status, 'unsupported');
  assert.equal(await readFile(file, 'utf8'), '{"hooks":{"SessionStart":"unknown-format"}}');
});

/** A folder under `os.tmpdir()` nothing outside this file can see. */
async function temp(prefix) {
  const dir = await mkdtemp(join(tmpdir(), `okit-${prefix}-`));
  temps.push(dir);
  return dir;
}

async function root(prefix) {
  const dir = await temp(prefix);
  roots.push(dir);
  return dir;
}

/** A skill folder with a `SKILL.md` and one reference beside it. */
async function skillFolder(name, body = 'body') {
  const dir = await temp(name);
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\n${body}\n`, 'utf8');
  await mkdir(join(dir, 'refs'), { recursive: true });
  await writeFile(join(dir, 'refs', 'notes.md'), `${body} notes\n`, 'utf8');
  return dir;
}

/** A child process stand-in: the arguments it was started with, and no child. */
function fakeSpawn() {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { pid: 4242, on() {}, kill() {}, unref() {} };
  };
  return { calls, spawn };
}

/**
 * Every folder this file made, once each.
 *
 * `root` pushes into both `roots` and `temps`, so the two lists overlap on
 * purpose: a root is also a temp. Removing the union as it stands runs two
 * concurrent recursive removals over the same tree, and on Windows the second
 * one gets `EPERM` from `rmdir` on a folder the first is still emptying
 * (`...\okit-keep-XXXX\skills\okit-critic\refs`). `force` hides the missing
 * folder but not the refused one. Deduplicating is what makes the cleanup
 * platform-correct; `maxRetries` only covers a handle that a virus scanner
 * still holds for a moment.
 */
function madeDirs() {
  return [...new Set([...roots, ...temps])];
}

async function removeAll(dirs) {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
}

after(() => removeAll(madeDirs()));

// | case                          | must pass                       | must refuse                    |
// | :-                            | :-                             | :-                             |
// | spawn, interactive            | NATIVE + agentCall, no process  | empty briefing, no model, mode |
// | spawn, headless               | PROCESS through makeSpawner     | `opts.headless` not a boolean  |
// | readQuota                     | source user, stored numbers only | -                             |
// | installSkill                  | copy, idempotent, skip differs  | `a/b`, `..`, `a\\b`, empty, no SKILL.md |
// | installHooks                  | merge keeps the user's entries   | non-object, unreadable JSON    |

test('spawn returns the Agent tool call and starts no process by default', async () => {
  const { calls, spawn: fake } = fakeSpawn();
  const given = await spawn({ model: 'sonnet', effort: 'high' }, brief('write the tests'), { spawn: fake });

  assert.equal(given.mode, 'NATIVE');
  assert.equal(given.pid, undefined);
  assert.deepEqual(given.agentCall, { model: 'sonnet', effort: 'high', prompt: prompt('write the tests') });
  assert.match(given.runId, /^cc-[0-9a-f]{8}$/);
  assert.deepEqual(calls, [], 'no process is started in NATIVE');
});

test('spawn keeps a run id the core already made and reports no effort of its own', async () => {
  const given = await spawn({ model: 'opus' }, brief('body'), { runId: 'd-1234abcd' });
  assert.equal(given.runId, 'd-1234abcd');
  assert.equal(given.agentCall.effort, null);
});

test('spawn in headless goes through makeSpawner with the claude-code command', async () => {
  const logDir = await temp('runs');
  const { calls, spawn: fake } = fakeSpawn();
  const cwd = await root('cwd');

  const given = await spawn(
    { model: 'sonnet', effort: 'low' },
    brief('fix the bug'),
    { headless: true, spawn: fake, logDir, cwd, appliesTo: cwd, runId: 'd-feedface' },
  );

  assert.equal(given.mode, 'PROCESS');
  assert.equal(given.runId, 'd-feedface');
  assert.equal(given.pid, 4242);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'claude');
  assert.deepEqual(calls[0].args, [
    '-p', prompt('fix the bug'), '--model', 'sonnet', '--effort', 'low',
    '--output-format', 'json', '--permission-mode', 'acceptEdits', '--add-dir', cwd,
  ]);
  assert.equal(calls[0].options.env.OKWORK_NO_DAEMON, '1');

  const run = JSON.parse(await readFile(join(logDir, 'd-feedface.json'), 'utf8'));
  assert.equal(run.client, 'claude-code');
  assert.equal(run.status, 'live');
});

test('spawn refuses what the Agent tool could not be given', async () => {
  await assert.rejects(() => spawn({ model: 'sonnet' }, '  ', {}), /briefing must be a non-empty string/);
  await assert.rejects(() => spawn({}, 'body'), /actor\.model must be a non-empty string/);
  await assert.rejects(() => spawn('sonnet', 'body'), /actor must be an object/);
  await assert.rejects(
    () => spawn({ model: 'sonnet', effort: 'turbo' }, 'body'),
    /actor\.effort must be one of low, medium, high, xhigh, max/,
  );
  await assert.rejects(() => spawn({ model: 'sonnet' }, 'body', { mode: 'remote' }), /mode must be one of NATIVE, PROCESS/);
  await assert.rejects(() => spawn({ model: 'sonnet' }, 'body', { headless: 'yes' }), /headless must be a boolean/);
});

test('readQuota says the number came from the user and never invents one', async () => {
  const base = await root('quota');

  assert.deepEqual(await readQuota({ stateRoot: base }), { source: 'user' });

  await mkdir(join(base, 'quota'), { recursive: true });
  await writeFile(join(base, 'quota', 'claude-code.json'), '{"remainingPct":42,"windowMinutes":300}', 'utf8');
  assert.deepEqual(await readQuota({ stateRoot: base }), { source: 'user', remainingPct: 42, windowMinutes: 300 });

  await writeFile(join(base, 'quota', 'claude-code.json'), '{"remainingPct":"half"}', 'utf8');
  assert.deepEqual(await readQuota({ stateRoot: base }), { source: 'user' });

  await writeFile(join(base, 'quota', 'claude-code.json'), '{"remainingPct":42}', 'utf8');
  assert.deepEqual(await readQuota({ stateRoot: base }), { source: 'user', remainingPct: 42 });
});

// The sample of the collector and the record of the person live in two files; the later instant is the reading.
const sample = (used, receivedAt) => JSON.stringify({ receivedAt, input: { rate_limits: {
  five_hour: { used_percentage: used, resets_at: 1793003358 } } } });

test('readQuota chooses the newer of the manual record and the sample of the collector, in both orders', async () => {
  const base = await root('quota-both');
  await mkdir(join(base, 'quota'), { recursive: true });
  const manual = join(base, 'quota', 'claude-code.json');
  const collected = join(base, 'quota', 'claude-code-statusline.json');
  const now = () => Date.UTC(2026, 9, 26);

  await writeFile(manual, JSON.stringify({ remainingPct: 42, recordedAt: '2026-10-26T00:00:00.000Z' }));
  await writeFile(collected, sample(25, '2026-10-26T00:01:00.000Z'));
  const newer = await readQuota({ stateRoot: base, now });
  assert.equal(newer.source, 'automatic');
  assert.equal(newer.remainingPct, 75);
  assert.equal(newer.recordedAt, '2026-10-26T00:01:00.000Z');

  await writeFile(manual, JSON.stringify({ remainingPct: 42, recordedAt: '2026-10-26T00:02:00.000Z' }));
  const older = await readQuota({ stateRoot: base, now });
  assert.equal(older.source, 'user');
  assert.equal(older.remainingPct, 42);
  assert.equal(older.recordedAt, '2026-10-26T00:02:00.000Z');
});

test('a configuration that cannot be read is no reading of its own: the record and the sample still read', async () => {
  const base = await root('quota-config');
  await mkdir(join(base, 'quota'), { recursive: true });
  const manual = join(base, 'quota', 'claude-code.json');
  const collected = join(base, 'quota', 'claude-code-statusline.json');
  const config = join(base, 'config.json');
  const now = () => Date.UTC(2026, 9, 26);

  // A configuration that is not JSON, and one that cannot be read at all.
  for (const broken of ['{ not json', '']) {
    await writeFile(config, broken, 'utf8');
    await rm(collected, { force: true });
    await writeFile(manual, JSON.stringify({ remainingPct: 42, recordedAt: '2026-10-26T00:00:00.000Z' }));
    const reading = await readQuota({ stateRoot: base, now });
    assert.equal(reading.source, 'user', broken);
    assert.equal(reading.remainingPct, 42, broken);
    // The sample of the collector is read with the default settings of the collector.
    await writeFile(collected, sample(25, '2026-10-26T00:01:00.000Z'));
    const automatic = await readQuota({ stateRoot: base, now });
    assert.equal(automatic.source, 'automatic', broken);
    assert.equal(automatic.remainingPct, 75, broken);
    assert.equal(automatic.windowMinutes, 300, broken);
  }
  // A folder where the configuration should be: the reader still reads.
  await rm(config, { force: true });
  await mkdir(config);
  assert.equal((await readQuota({ stateRoot: base, now })).source, 'automatic');
});

test('the sample of the collector is read defensively: an invalid one falls back to the record of the person', async () => {
  const base = await root('quota-sample');
  await mkdir(join(base, 'quota'), { recursive: true });
  const manual = join(base, 'quota', 'claude-code.json');
  const collected = join(base, 'quota', 'claude-code-statusline.json');
  await writeFile(manual, JSON.stringify({ remainingPct: 42, recordedAt: '2026-10-26T00:00:00.000Z' }));
  const now = () => Date.UTC(2026, 9, 26);
  const fallback = { source: 'user', remainingPct: 42, recordedAt: '2026-10-26T00:00:00.000Z', ageMinutes: 0 };

  // A percentage that is not one, an instant that is not a date, a file that is not JSON: no automatic reading.
  for (const body of [sample(101, '2026-10-26T00:01:00.000Z'), sample(25, 'not a date'),
    '{"receivedAt":"2026-10-26T00:01:00.000Z","input":{}}', 'not json', '']) {
    await writeFile(collected, body);
    assert.deepEqual(await readQuota({ stateRoot: base, now }), fallback, body);
  }
  // A sample with no reading at all and no record either: no value, as before.
  await rm(manual);
  await writeFile(collected, sample(101, '2026-10-26T00:01:00.000Z'));
  assert.deepEqual(await readQuota({ stateRoot: base, now }), { source: 'user' });
});

test('capabilities are the values of section 4.1 and cannot be edited by a caller', () => {
  assert.deepEqual(capabilities(), {
    models: ['sonnet', 'opus', 'haiku', 'fable'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    skills: true,
    hooks: true,
    mcp: true,
    desktop: true,
    windows: true,
  });

  const first = capabilities();
  first.models.push('made-up');
  first.skills = false;
  assert.deepEqual(capabilities().models, ['sonnet', 'opus', 'haiku', 'fable']);
  assert.equal(capabilities().skills, true);
});

test('configRoot prefers the argument, then the environment, then the home', () => {
  // `configRoot` resolves what it is given, so the expectation is spelled the
  // way the host spells a resolved path: `/tmp/somewhere` on Linux, macOS and
  // `C:\tmp\somewhere` on Windows. Hard-coding the posix text fails there.
  assert.equal(configRoot({ root: '/tmp/somewhere', env: { CLAUDE_CONFIG_DIR: '/tmp/other' } }), resolve('/tmp/somewhere'));
  assert.equal(configRoot({ env: { CLAUDE_CONFIG_DIR: '/tmp/other' } }), resolve('/tmp/other'));
  assert.match(configRoot({ env: {} }), /[/\\]\.claude$/);
});

test('installSkill copies the folder and a second install writes nothing', async () => {
  const dest = await root('skills');
  const source = await skillFolder('okit-executor');

  const first = await installSkill('okit-executor', source, { root: dest });
  assert.equal(first.path, join(dest, 'skills', 'okit-executor'));
  assert.deepEqual(first.written.sort(), ['SKILL.md', 'refs/notes.md']);
  assert.deepEqual(first.skipped, []);

  const second = await installSkill('okit-executor', source, { root: dest });
  assert.deepEqual(second.written, []);
  assert.deepEqual(second.skipped, [
    { path: 'SKILL.md', reason: 'identical' },
    { path: 'refs/notes.md', reason: 'identical' },
  ]);
});

test('installSkill never overwrites a file that differs', async () => {
  const dest = await root('keep');
  const source = await skillFolder('okit-critic', 'ours');
  const target = join(dest, 'skills', 'okit-critic');

  await installSkill('okit-critic', source, { root: dest });
  await writeFile(join(target, 'refs', 'notes.md'), 'the user wrote this\n', 'utf8');

  const again = await installSkill('okit-critic', source, { root: dest });
  assert.deepEqual(again.written, []);
  assert.deepEqual(again.skipped, [
    { path: 'SKILL.md', reason: 'identical' },
    { path: 'refs/notes.md', reason: 'differs' },
  ]);
  assert.equal(await readFile(join(target, 'refs', 'notes.md'), 'utf8'), 'the user wrote this\n');
});

test('installSkill refuses a name that is not one folder name', async () => {
  const dest = await root('refuse');
  const source = await skillFolder('okit-director');
  const bare = await temp('bare');

  // 'a..b' passes the folder-name regex and is still refused: a name is one
  // name, never a walk up and back down.
  for (const name of ['../escape', 'a/b', 'a\\b', '..', '.', 'a..b', '', '   ', null, 7]) {
    await assert.rejects(() => installSkill(name, source, { root: dest }), /name must be/);
  }
  await assert.rejects(
    () => installSkill('okit-director', bare, { root: dest }),
    /is not a skill folder: no readable SKILL\.md/,
  );
  await assert.rejects(() => installSkill('okit-director', 7, { root: dest }), /files must be a non-empty string/);
});

test('installHooks writes the file and a second install over it changes nothing', async () => {
  const dest = await root('hooks');
  const hooks = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'okit gate' }] }] } };

  const first = await installHooks(hooks, { root: dest });
  assert.equal(first.path, join(dest, 'hooks', 'hooks.json'));
  assert.equal(first.written, true);
  assert.deepEqual(JSON.parse(await readFile(first.path, 'utf8')), hooks);

  const second = await installHooks(hooks, { root: dest });
  assert.equal(second.written, false);
  assert.deepEqual(JSON.parse(await readFile(first.path, 'utf8')), hooks);
});

test('installHooks merges and keeps the entries the user wrote', async () => {
  const dest = await root('merge');
  const mine = { hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'okit report' }] }] } };
  await installHooks({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }] } }, { root: dest });

  const file = join(dest, 'hooks', 'hooks.json');
  // `timeout` is a number on both sides with different values, and `disabled`
  // is a scalar of one kind on one side and an object on the other: in both
  // keys what the user already has is what stays.
  await writeFile(file, `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'theirs' }] }] }, extra: { keep: true }, timeout: 5, disabled: false }, null, 2)}\n`, 'utf8');

  const merged = await installHooks({ ...mine, timeout: 99, disabled: { since: 'today' } }, { root: dest });
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(merged.written, true);
  assert.deepEqual(after.extra, { keep: true });
  assert.deepEqual(after.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'theirs' }] }]);
  assert.deepEqual(after.hooks.PostToolUse, mine.hooks.PostToolUse);
  assert.equal(after.timeout, 5, 'the user number wins over ours');
  assert.equal(after.disabled, false, 'the user scalar wins over our object');
});

test('installHooks refuses a config that is not an object and a file it cannot read', async () => {
  const dest = await root('bad-hooks');
  for (const files of [null, [], 'hooks', 7]) {
    await assert.rejects(() => installHooks(files, { root: dest }), /files must be the hook config as an object/);
  }

  const file = join(dest, 'hooks', 'hooks.json');
  await mkdir(join(dest, 'hooks'), { recursive: true });
  await writeFile(file, '{ not json', 'utf8');
  await assert.rejects(() => installHooks({ hooks: {} }, { root: dest }), /Invalid JSON/);
  assert.equal(await readFile(file, 'utf8'), '{ not json', 'the unreadable file is left alone');

  await writeFile(file, '[]', 'utf8');
  await assert.rejects(() => installHooks({ hooks: {} }, { root: dest }), /is not a hook config: expected a JSON object/);
  assert.equal(await readFile(file, 'utf8'), '[]');
});

test('the cleanup list holds one entry per folder, and a listed folder is gone', async () => {
  // The regression guard for the Windows `EPERM`: what made the removal fail was
  // never a read-only file, it was a folder removed twice at the same time.
  const dir = await temp('twice');
  await mkdir(join(dir, 'refs'), { recursive: true });
  await writeFile(join(dir, 'refs', 'notes.md'), 'notes\n', 'utf8');

  const listed = madeDirs();
  assert.equal(listed.filter((made) => made === dir).length, 1, 'a folder is listed once');
  assert.equal(new Set(listed).size, listed.length, 'no folder is listed twice');
  assert.ok(roots.every((made) => temps.includes(made)), 'every root is also a temp, so the union is what matters');

  await removeAll([dir, dir]);
  await assert.rejects(() => readdir(dir), { code: 'ENOENT' }, 'the folder is really gone');
});

test('the default export is the five functions of section 4', () => {
  for (const name of ['spawn', 'readQuota', 'capabilities', 'installSkill', 'installHooks']) {
    assert.equal(typeof adapter[name], 'function', name);
  }
  assert.equal(adapter.CLIENT, 'claude-code');
  assert.equal(adapter.spawn, spawn);
  assert.equal(adapter.installHooks, installHooks);
});
