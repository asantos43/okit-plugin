import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import adapter, { capabilities, configRoot, installHooks, installSkill, readQuota, spawn }
  from '../adapters/codex/index.js';
import { adapterQuotaReader } from '../src/status.js';
import { readCodexSessionQuota } from '../adapters/codex/session-quota.js';
import { configOf } from '../src/profiles.js';
import { runCli } from '../src/cli.js';
import { statusTable } from '../src/status.js';

const temps = [];
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), 'okit-codex-'));
  temps.push(dir);
  return dir;
}
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

const QUOTA_TIME = Date.parse('2026-10-26T06:00:00Z');
// | must pass | must refuse |
// | HOME/USERPROFILE resolve inside scratch home | any ambient session directory |
test('default session discovery only visits the injected HOME or USERPROFILE', async (t) => {
  await mkdir('.delegate/tmp', { recursive: true });
  const home = resolve(await mkdtemp('.delegate/tmp/quota-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sessions = join(home, '.codex', 'sessions');
  await mkdir(sessions, { recursive: true });
  const visited = [];
  const readdir = fsPromises.readdir;
  t.mock.method(fsPromises, 'readdir', async (path, options) => {
    visited.push(path);
    return path === sessions ? readdir(path, options) : [];
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const env of [{ HOME: home }, { USERPROFILE: home }]) {
    assert.equal(await readCodexSessionQuota({ env }), null);
  }
  assert.deepEqual(visited, [sessions, sessions]);
});

const quotaEvent = (used, at = QUOTA_TIME) => JSON.stringify({
  timestamp: new Date(at).toISOString(), type: 'event_msg',
  payload: { type: 'token_count', info: null, rate_limits: {
    primary: { used_percent: used, window_minutes: 300, resets_at: 1793003358 },
    secondary: { used_percent: 39, window_minutes: 10080, resets_at: 1793513484 },
  } },
});
async function quotaFixture() {
  const root = await temp();
  const directory = join(root, 'sessions', '2026', '10', '26');
  await mkdir(directory, { recursive: true });
  return { root, directory, opts: { stateRoot: root,
    env: { CODEX_SESSIONS_DIR: join(root, 'sessions') }, now: () => QUOTA_TIME + 60_000 } };
}

// | must pass | must refuse |
// | valid sibling window; no reading if none remain | invalid percent, duration or missing reset |
const invalidQuotaWindows = [
  ['used_percent above 100', { used_percent: 140 }],
  ['negative used_percent', { used_percent: -1 }],
  ['string used_percent', { used_percent: '42' }],
  ['null used_percent', { used_percent: null }],
  ['zero window_minutes', { window_minutes: 0 }],
  ['negative window_minutes', { window_minutes: -300 }],
  ['missing resets_at', { resets_at: undefined }],
];
for (const [label, invalid] of invalidQuotaWindows) {
  test(`session quota discards windows with ${label}`, async () => {
    const { directory, opts } = await quotaFixture();
    const file = join(directory, 'rollout-invalid.jsonl');
    for (const key of ['primary', 'secondary']) {
      const event = JSON.parse(quotaEvent(42));
      const limits = event.payload.rate_limits;
      Object.assign(limits[key], invalid);
      const sibling = limits[key === 'primary' ? 'secondary' : 'primary'];
      await writeFile(file, JSON.stringify(event));
      const reading = await readCodexSessionQuota(opts);
      const expected = { windowMinutes: sibling.window_minutes,
        remainingPct: 100 - sibling.used_percent,
        resetsAt: new Date(sibling.resets_at * 1000).toISOString() };
      assert.ok(reading, `${key}: valid sibling supplies a reading`);
      assert.deepEqual(reading.windows, [expected], `${key}: invalid window is discarded`);
      assert.equal(reading.remainingPct, expected.remainingPct);
      for (const percent of [reading.remainingPct, ...reading.windows.map((w) => w.remainingPct)]) {
        assert.ok(Number.isFinite(percent) && percent >= 0 && percent <= 100);
      }
      delete limits[key === 'primary' ? 'secondary' : 'primary'];
      await writeFile(file, JSON.stringify(event));
      assert.equal(await readCodexSessionQuota(opts), null, `${key}: invalid sole window gives no reading`);
    }
  });
}

// | must pass | must refuse / ignore |
// | newest file and last valid event; bounded read; unchanged bytes/mtime | old event, malformed/unknown lines, stale data |
test('status displays automatic source, real windows and age in both languages', async () => {
  const { root, directory, opts } = await quotaFixture();
  await writeFile(join(directory, 'rollout-status.jsonl'), quotaEvent(42));
  const read = adapterQuotaReader(opts);
  for (const [locale, words] of [['en', 'automatic (1 minute ago)'], ['pt-BR', 'automática (há 1 minuto)']]) {
    const table = await statusTable(root, { clients: ['codex'], readQuota: read,
      now: opts.now, locale, cache: new Map() });
    assert.equal(table.rows[0].fiveHour, 58);
    assert.equal(table.rows[0].week, 61);
    assert.ok(table.markdown.includes(words));
  }
});
test('config commands persist quota settings and refuse invalid values without changing them', async () => {
  const { root, opts } = await quotaFixture();
  const io = { root, env: opts.env, stdout() {}, stderr() {} };
  assert.equal(await runCli(['config', 'set', 'codexQuota.tailBytes', '32768'], io), 0);
  const file = join(root, 'config.json');
  const before = await readFile(file, 'utf8');
  assert.equal(JSON.parse(before).codexQuota.tailBytes, 32768);
  for (const [key, value] of [['recentFiles', '0'], ['maxTailBytes', '1'], ['fields.usedPercent', '']]) {
    assert.equal(await runCli(['config', 'set', `codexQuota.${key}`, value], io), 1);
    assert.equal(await readFile(file, 'utf8'), before);
  }
});
test('session settings validate and field names, paths and candidate count are configurable', async () => {
  const { directory, opts } = await quotaFixture();
  for (const codexQuota of [{ recentFiles: 0 }, { maxAgeMinutes: -1 }, { tailBytes: 0 },
    { maxTailBytes: 1 }, { sessionsDirectory: '' }, { fields: { usedPercent: '' } }]) {
    assert.throws(() => configOf({ codexQuota }), TypeError);
    assert.equal(await readCodexSessionQuota({ ...opts, config: { codexQuota } }), null);
  }
  await writeFile(join(directory, 'rollout-old.jsonl'), quotaEvent(42));
  await utimes(join(directory, 'rollout-old.jsonl'), new Date(QUOTA_TIME - 1000), new Date(QUOTA_TIME - 1000));
  await writeFile(join(directory, 'rollout-new.jsonl'), 'malformed');
  await utimes(join(directory, 'rollout-new.jsonl'), new Date(QUOTA_TIME), new Date(QUOTA_TIME));
  const settings = { sessionsDirectory: directory, sessionsEnv: 'TEST_SESSIONS', recentFiles: 1 };
  assert.equal(await readCodexSessionQuota({ ...opts, env: {}, config: { codexQuota: settings } }), null);
  settings.recentFiles = 2;
  assert.equal((await readCodexSessionQuota({ ...opts, env: {}, config: { codexQuota: settings } })).remainingPct, 58);
  await writeFile(join(directory, 'rollout-new.jsonl'), quotaEvent(43).replaceAll('used_percent', 'spent'));
  settings.fields = { usedPercent: 'spent' };
  assert.equal((await readCodexSessionQuota({ ...opts, env: { TEST_SESSIONS: directory },
    config: { codexQuota: settings } })).remainingPct, 57);
  assert.equal(await readCodexSessionQuota({ ...opts, openFile: () => { throw new Error('unreadable'); } }), null);
});
test('huge session uses bounded tail reads and expands only to configured limit', async () => {
  const { directory, opts } = await quotaFixture();
  const file = join(directory, 'rollout-huge.jsonl');
  await writeFile(file, `${'ignored\n'.repeat(300000)}${quotaEvent(42)}\n`);
  let bytes = 0;
  const openFile = async (...args) => {
    assert.equal(args[1], 'r');
    const handle = await open(...args);
    return { stat: () => handle.stat(), close: () => handle.close(),
      read: async (...readArgs) => { const result = await handle.read(...readArgs); bytes += result.bytesRead; return result; } };
  };
  const config = { codexQuota: { tailBytes: 128, maxTailBytes: 2048 } };
  assert.equal((await readCodexSessionQuota({ ...opts, config, openFile })).remainingPct, 58);
  assert.ok(bytes <= 128 + 256 + 512 + 1024 + 2048);
  assert.ok(bytes < (await stat(file)).size / 100);
  await writeFile(file, `${quotaEvent(99)}\n${'ignored\n'.repeat(300000)}`);
  bytes = 0;
  assert.equal(await readCodexSessionQuota({ ...opts, config, openFile }), null);
  assert.equal(bytes, 128 + 256 + 512 + 1024 + 2048);
});
test('empty sessions fall back to manual; newer manual and equal timestamps win', async () => {
  const { root, directory, opts } = await quotaFixture();
  assert.equal(await readCodexSessionQuota(opts), null);
  await mkdir(join(root, 'quota'));
  const file = join(root, 'quota', 'codex.json');
  const sample = { remainingPct: 77, recordedAt: new Date(QUOTA_TIME).toISOString() };
  await writeFile(file, JSON.stringify(sample));
  assert.deepEqual(await readQuota(opts), { source: 'manual', ...sample, ageMinutes: 1 });
  for (const [locale, words] of [['en', 'manual (1 minute ago)'], ['pt-BR', 'manual (há 1 minuto)']]) {
    const table = await statusTable(root, { clients: ['codex'], readQuota: adapterQuotaReader(opts),
      now: opts.now, locale, cache: new Map() });
    assert.ok(table.markdown.includes(words));
  }
  await writeFile(join(directory, 'rollout-test.jsonl'), quotaEvent(42, QUOTA_TIME - 1000));
  assert.equal((await readQuota(opts)).source, 'manual');
  await writeFile(join(directory, 'rollout-test.jsonl'), quotaEvent(42));
  assert.equal((await readQuota(opts)).source, 'manual');
  await writeFile(join(directory, 'rollout-test.jsonl'), quotaEvent(42, QUOTA_TIME + 1000));
  assert.equal((await readQuota(opts)).source, 'automatic');
  assert.equal(await readCodexSessionQuota({ ...opts, now: () => QUOTA_TIME + 121 * 60_000 }), null);
  const out = [];
  await runCli(['quota', 'show', 'codex'], { root, env: opts.env,
    now: () => QUOTA_TIME + 121 * 60_000, stdout: (line) => out.push(line) });
  assert.match(out.join('\n'), /manual \(121 minutes ago\).*manual \(há 121 minutos\)/);
});
test('session quota selects newest mtime and last valid event without writes', async () => {
  const { directory, opts } = await quotaFixture();
  const old = join(directory, 'rollout-old.jsonl'), latest = join(directory, 'rollout-new.jsonl');
  await writeFile(old, quotaEvent(95));
  const bytes = [quotaEvent(90, QUOTA_TIME - 60_000), 'broken JSON', '{}', quotaEvent(42),
    '{"type":"event_msg","payload":{"type":"other"}}', 'bad trailing line'].join('\n');
  await writeFile(latest, bytes);
  await utimes(old, new Date(QUOTA_TIME - 1000), new Date(QUOTA_TIME - 1000));
  await utimes(latest, new Date(QUOTA_TIME), new Date(QUOTA_TIME));
  const before = await stat(latest), oldBefore = await stat(old);
  const reading = await readQuota(opts);
  assert.equal(reading.source, 'automatic');
  assert.equal(reading.remainingPct, 58); // Selecting the oldest event must fail.
  assert.equal(reading.ageMinutes, 1);
  assert.deepEqual(reading.windows.map((w) => [w.windowMinutes, w.remainingPct]), [[300, 58], [10080, 61]]);
  assert.equal(reading.windows[0].resetsAt, new Date(1793003358000).toISOString());
  assert.equal(await readFile(latest, 'utf8'), bytes);
  assert.equal((await stat(latest)).mtimeMs, before.mtimeMs);
  assert.equal(await readFile(old, 'utf8'), quotaEvent(95));
  assert.equal((await stat(old)).mtimeMs, oldBefore.mtimeMs);
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
  const opts = { stateRoot: root, env: { CODEX_SESSIONS_DIR: join(root, 'sessions') } };
  assert.deepEqual(await readQuota(opts), { source: 'manual' });
  await mkdir(join(root, 'quota'));
  const file = join(root, 'quota', 'codex.json');
  const sample = '{"remainingPct":61,"windowMinutes":300,"client":"codex"}\n';
  await writeFile(file, sample);
  const before = await stat(file);
  const expected = { source: 'manual', remainingPct: 61, windowMinutes: 300 };
  assert.deepEqual(await readQuota(opts), expected);
  assert.deepEqual(await adapterQuotaReader(opts)('codex'), expected);
  assert.deepEqual(await adapterQuotaReader(opts)('claude-code'), { source: 'user' });
  assert.equal(await readFile(file, 'utf8'), sample);
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  for (const [sample, expected] of [[{ remainingPct: 0 }, { source: 'manual', remainingPct: 0 }],
    [{ remainingPct: '61' }, { source: 'manual' }],
    [{ remainingPct: 61, windowMinutes: '300' }, { source: 'manual', remainingPct: 61 }]]) {
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
