import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { chmod } from 'node:fs/promises';
import { panelState } from '../src/panel-state.js';
import { readJson } from '../src/state.js';
import { main } from '../src/cli.js';

const now = Date.parse('2026-11-06T12:00:00Z');
test('panel state carries the auto-open setting read from config.json', async t => {
  const ctx = await world(t);
  for (const [panel, expected] of [[undefined, true], [{ autoOpen: true }, true], [{ autoOpen: false }, false]]) {
    await put(ctx.root, 'config.json', { panel });
    assert.deepEqual((await panelState(ctx, 'claude')).panel, { autoOpen: expected, color: true });
  }
  await put(ctx.root, 'config.json', { panel: { color: false } });
  assert.deepEqual((await panelState(ctx, 'claude')).panel, { autoOpen: true, color: false });
});
async function world(t) {
  const home = await mkdtemp(join(tmpdir(), 'panel-state-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, '.okwork');
  // Existing snapshot invariants use an injected worker that never starts a client.
  return { root, home, now: () => now, env: { HOME: home, PATH: '' },
    spawn: () => ({ on() {}, unref() {} }) };
}
async function put(root, file, value) {
  const path = join(root, file);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}
async function invoke(ctx, flags = ['--json', '--client', 'claude']) {
  const output = [], errors = [];
  const code = await main(['panel-state', ...flags], { ...ctx,
    stdout: (line) => output.push(line), stderr: (line) => errors.push(line) });
  return { code, output, errors, document: output.length ? JSON.parse(output.join('\n')) : null };
}

test('empty state matches the versioned golden and creates nothing', async (t) => {
  const ctx = await world(t);
  const before = await readdir(ctx.home);
  const result = await invoke(ctx);
  assert.equal(result.code, 0);
  assert.equal(result.output.length, 1);
  assert.deepEqual(result.document, JSON.parse(await readFile(new URL('./fixtures/panel-state-v1.json', import.meta.url))));
  assert.deepEqual(await readdir(ctx.home), before);
});

test('populated state matches the documented versioned golden', async (t) => {
  const ctx = await world(t);
  await put(ctx.root, 'config.json', { accounts: {
    'claude-code': [{ id: 'default', label: 'Personal' },
      { id: 'work', label: 'Work', configDir: join(ctx.home, 'work') }] } });
  await put(ctx.root, 'quota/claude-code.json', { source: 'automatic', remainingPct: 80,
    recordedAt: new Date(now - 60_000).toISOString(), windows: [
      { remainingPct: 80, windowMinutes: 300, resetsAt: '2026-11-06T17:00:00Z' }] });
  await put(ctx.root, 'runs/one.json', { runId: 'one', client: 'claude-code', status: 'live', account: 'default',
    actor: 'hard', model: 'opus', effort: 'high', demand: 'sample-demand', startedAt: now - 2000, lastProgress: 'Running checks' });
  const result = await invoke(ctx);
  assert.equal(result.code, 0);
  const expected = JSON.parse(await readFile(new URL('./fixtures/panel-state-v1-populated.json', import.meta.url)));
  for (const account of expected.accounts) {
    account.quota_state = null;
    account.rotation = { eligible: false, known: false, readAt: account.id === 'default' ? now - 60_000 : null,
      reason: 'login', text: 'The account is not logged in.' };
  }
  assert.deepEqual(result.document, expected);
});

test('run demand is bounded and finish reasons require saved error evidence', async (t) => {
  const ctx = await world(t);
  for (const [id, extra] of [['failed', { status: 'failed', error: 'Process missing' }],
    ['exit', { status: 'done', exitCode: 2 }], ['done', { status: 'done', exitCode: 0 }]]) {
    await put(ctx.root, `runs/${id}.json`, { runId: id, client: 'claude-code', demand: '😀'.repeat(200), ...extra });
  }
  const { runs } = await panelState(ctx, 'claude');
  for (const run of runs) {
    assert.equal(Array.from(run.demand).length, 120);
    assert.equal(run.finish_reason, run.id === 'done' ? undefined : 'error');
    assert.equal(run.step, undefined);
  }
});

// | Input | Must pass | Must refuse |
// | CLI | one supported client and --json | missing client, unknown client, unknown flag |
test('usage errors return 2 without JSON', async (t) => {
  const ctx = await world(t);
  for (const flags of [[], ['--json'], ['--json', '--client'], ['--json', '--client', 'opencode'],
    ['--client', 'claude'], ['--json', '--client', 'codex', '--bad']]) {
    const result = await invoke(ctx, flags);
    assert.equal(result.code, 2);
    assert.equal(result.document, null);
    assert.ok(result.errors.length);
  }
  assert.equal((await invoke(ctx, ['--json', '--client', 'codex'])).document.client, 'codex');
});

test('accounts keep both windows, provenance and unknown values; runs are isolated', async (t) => {
  const ctx = await world(t);
  await put(ctx.root, 'config.json', { accounts: {
    'claude-code': [{ id: 'default', label: 'Personal' }, { id: 'work', label: 'Work', configDir: join(ctx.home, 'work') }],
    codex: [{ id: 'default', label: 'Other client' }] } });
  await put(ctx.root, 'quota/claude-code.json', { source: 'automatic', remainingPct: 45,
    recordedAt: new Date(now - 60_000).toISOString(), windows: [
      { remainingPct: 80, windowMinutes: 300, resetsAt: '2026-11-06T17:00:00Z' },
      { remainingPct: 45, windowMinutes: 10080, resetsAt: '2026-11-13T12:00:00Z' }] });
  await put(ctx.root, 'quota/claude-code.work.json', { remainingPct: 9, windowMinutes: 300 });
  await put(ctx.root, 'runs/one.json', { runId: 'one', client: 'claude-code', status: 'live', account: 'work',
    actor: 'hard', model: 'opus', effort: 'high', startedAt: now - 2000, lastProgress: 'First\nLatest' });
  await put(ctx.root, 'runs/other.json', { runId: 'other', client: 'codex', status: 'live' });
  await put(ctx.root, 'runs/critic.json', { runId: 'critic', client: 'claude-code', role: 'critic' });
  await writeFile(join(ctx.root, 'runs/partial.json'), '{"status":');
  const { code, document: doc } = await invoke(ctx);
  assert.equal(code, 0);
  assert.deepEqual(doc.accounts.map((account) => account.id), ['default', 'work']);
  assert.deepEqual(doc.accounts[0].quota.session, { remaining_pct: 80, resets_at: '2026-11-06T17:00:00.000Z', source: 'automatic', age_seconds: 60 });
  assert.equal(doc.accounts[0].quota.weekly.remaining_pct, 45);
  assert.equal(doc.accounts[1].quota.session.remaining_pct, 9);
  assert.equal(doc.accounts[1].quota.weekly, null);
  assert.equal(doc.accounts[1].quota.session.age_seconds, null);
  assert.deepEqual(doc.runs, [{ id: 'one', status: 'live', stale: false, account: 'work', actor: 'hard', model: 'opus', effort: 'high',
    started_at: '2026-11-06T11:59:58.000Z', elapsed_seconds: 2, last_progress: 'Latest' }]);
  const other = await invoke(ctx, ['--json', '--client', 'codex']);
  assert.deepEqual(other.document.accounts.map((account) => account.label), ['Other client']);
  assert.deepEqual(other.document.runs.map((run) => run.id), ['other']);
});

async function treeHash(directory) {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  const hash = createHash('sha256');
  for (const entry of entries.sort((a, b) => join(a.parentPath, a.name).localeCompare(join(b.parentPath, b.name)))) {
    const path = join(entry.parentPath, entry.name);
    const info = await stat(path);
    hash.update(JSON.stringify([path, info.mode, info.size, info.mtimeMs]));
    if (entry.isFile()) hash.update(await readFile(path));
  }
  return hash.digest('hex');
}

test('the command preserves files and never opens credential files or prints secrets', async (t) => {
  const ctx = await world(t);
  await put(ctx.root, 'config.json', { profiles: { codex: {} }, telemetry: { enabled: true }, quotaPoll: { enabled: false } });
  const secret = 'sk-ant-api03-panel-state-secret';
  await put(ctx.home, '.claude/.credentials.json', { token: secret });
  await put(ctx.home, '.codex/auth.json', { token: secret });
  await put(ctx.root, 'runs/secret.json', { runId: 'safe', client: 'codex', token: secret });
  const before = await treeHash(ctx.home);
  const result = await invoke(ctx, ['--json', '--client', 'codex']);
  assert.equal(result.code, 0);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(await treeHash(ctx.home), before);
});

test('launchability reuses quota thresholds and account slot counts', async (t) => {
  const ctx = await world(t);
  const bin = join(ctx.home, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'claude'), '');
  await chmod(join(bin, 'claude'), 0o755);
  ctx.env.PATH = bin;
  await put(ctx.root, 'config.json', { setup: { done: true }, limits: { global: 1 }, accounts: {
    'claude-code': [{ id: 'default', label: 'Personal' }, { id: 'work', label: 'Work', configDir: join(ctx.home, 'work') }] } });
  await put(ctx.home, '.claude/.credentials.json', {});
  await put(ctx.home, 'work/.credentials.json', {});
  await put(ctx.root, 'quota/claude-code.json', { remainingPct: 80, windowMinutes: 300 });
  await put(ctx.root, 'quota/claude-code.work.json', { remainingPct: 1, windowMinutes: 300 });
  let doc = (await invoke(ctx)).document;
  assert.ok(doc.launchable.some((actor) => actor.account === 'default' && actor.can_launch));
  assert.ok(doc.launchable.some((actor) => actor.actor_classes.includes('hard')));
  assert.ok(doc.launchable.filter((actor) => actor.account === 'work').every((actor) => !actor.can_launch && actor.reasons.includes('low')));
  await put(ctx.root, 'runs/live.json', { client: 'claude-code', status: 'live', startedAt: now });
  doc = (await invoke(ctx)).document;
  assert.ok(doc.launchable.filter((actor) => actor.account === 'default').every((actor) => !actor.can_launch && actor.reasons.includes('busy')));
  await put(ctx.root, 'runs/live.json', { client: 'claude-code', status: 'live', startedAt: now - 86_400_000 });
  doc = (await invoke(ctx)).document;
  assert.equal(doc.runs[0].stale, true);
  assert.ok(doc.launchable.some((actor) => actor.account === 'default' && actor.can_launch));
});

for (const fresh of [false, true]) test(`1000 ${fresh ? 'fresh' : 'historical'} runs: best of five within budget and bounded content reads`, async (t) => {
  const ctx = await world(t);
  await mkdir(join(ctx.root, 'runs'), { recursive: true });
  await put(ctx.root, 'config.json', { staleMinutes: 30 });
  await Promise.all(Array.from({ length: 1000 }, async (_, index) => {
    const path = join(ctx.root, 'runs', `${index}.json`);
    await writeFile(path, JSON.stringify({ runId: `${index}`, client: 'claude-code', status: 'done',
      startedAt: now - 86_400_000, endedAt: now - 86_399_000 }));
    const modified = new Date(now - (fresh ? 60_000 : 86_400_000));
    await utimes(path, modified, modified);
  }));
  const timings = [], counts = [];
  for (let trial = 0; trial < 5; trial += 1) {
    let reads = 0;
    const start = performance.now();
    const document = await panelState(ctx, 'claude', { readRunJson: (...args) => { reads += 1; return readJson(...args); } });
    timings.push(performance.now() - start);
    counts.push(reads);
    const bound = fresh ? 1000 : 100;
    assert.ok(reads <= bound, `${reads} content reads exceed ${bound}`);
    assert.equal(reads, bound, 'counter observes every expected content read');
    assert.equal(document.runs.length, bound);
  }
  // The best of five runs measures the code, not the load of a busy machine (the full suite runs files in parallel).
  const best = Math.min(...timings), median = [...timings].sort((a, b) => a - b)[2];
  t.diagnostic(`${fresh ? 'fresh' : 'historical'}: ${timings.map((ms) => ms.toFixed(1)).join(', ')} ms; median ${median.toFixed(1)} ms; best ${best.toFixed(1)} ms; content reads ${counts.join(', ')}`);
  // 200 ms is the budget for the usual case (a few live runs among old files). All 1000 files fresh is the worst case:
  // about 100 ms alone, and the suite runs many files at once, so it gets a ceiling that only a real regression crosses.
  const budget = fresh ? 500 : 200;
  assert.ok(best < budget, `Panel state best of five took ${best.toFixed(1)} ms (median ${median.toFixed(1)} ms), budget ${budget} ms`);
});

for (const file of ['config.json', 'quota/claude-code.json']) {
  for (const body of ['{bad', 'null', '[]']) test(`${file} ${body} is absent with a warning`, async (t) => {
    const ctx = await world(t);
    await put(ctx.root, 'config.json', { configuredClients: ['claude-code'] });
    await mkdir(join(ctx.root, 'quota'), { recursive: true });
    await writeFile(join(ctx.root, file), body);
    const result = await invoke(ctx);
    assert.equal(result.code, 0);
    assert.deepEqual(result.document.warnings, [file === 'config.json' ? 'config file unreadable' : 'quota file unreadable']);
    for (const account of result.document.accounts) assert.deepEqual(account.quota, { session: null, weekly: null });
  });
}

for (const body of ['{"configuredClients":5}', '{"accounts":{"claude-code":"x"}}']) {
  test(`wrongly typed config ${body} falls back to empty state`, async (t) => {
    const ctx = await world(t);
    await mkdir(ctx.root, { recursive: true });
    await writeFile(join(ctx.root, 'config.json'), body);
    const result = await invoke(ctx);
    assert.equal(result.code, 0);
    assert.equal(result.output.length, 1);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.document, {
      ...JSON.parse(await readFile(new URL('./fixtures/panel-state-v1.json', import.meta.url))),
      warnings: ['config file unreadable'],
    });
  });
}

test('corrupt extra-account quota has null windows and a fixed warning', async (t) => {
  const ctx = await world(t);
  await put(ctx.root, 'config.json', { accounts: {
    'claude-code': [{ id: 'default', label: 'Personal' },
      { id: 'work', label: 'Work', configDir: join(ctx.home, 'work') }] } });
  await put(ctx.root, 'quota/claude-code.json', { remainingPct: 80, windowMinutes: 300 });
  await writeFile(join(ctx.root, 'quota/claude-code.work.json'), '{bad');
  const result = await invoke(ctx);
  assert.equal(result.code, 0);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.document.accounts.map((account) => account.id), ['default', 'work']);
  assert.equal(result.document.accounts[0].quota.session.remaining_pct, 80);
  assert.deepEqual(result.document.accounts[1].quota, { session: null, weekly: null });
  assert.deepEqual(result.document.warnings, ['quota file unreadable']);
});

test('progress is capped at 500 characters and oversized runs are skipped before content reads', async (t) => {
  const ctx = await world(t);
  for (const length of [500, 501]) await put(ctx.root, `runs/${length}.json`, {
    runId: `${length}`, client: 'claude-code', lastProgress: 'Old\n' + '😀'.repeat(length) });
  await put(ctx.root, 'runs/oversized.json', { client: 'claude-code', lastProgress: 'x'.repeat(256 * 1024) });
  const paths = [];
  const doc = await panelState(ctx, 'claude', { readRunJson: (path, ...args) => { paths.push(path); return readJson(path, ...args); } });
  assert.equal(paths.length, 2);
  assert.ok(paths.every((path) => !path.endsWith('oversized.json')));
  assert.equal(doc.runs.length, 2);
  assert.equal(doc.runs.find((run) => run.id === '500').last_progress, '😀'.repeat(500));
  assert.equal(doc.runs.find((run) => run.id === '501').last_progress, '😀'.repeat(499) + '…');
});

test('stale live runs are marked and release slots; finished and fresh runs are not stale', async (t) => {
  const ctx = await world(t);
  await put(ctx.root, 'config.json', { staleMinutes: 30 });
  for (const [id, status, age] of [['old', 'live', 31], ['edge', 'live', 30], ['done', 'done', 31]]) {
    await put(ctx.root, `runs/${id}.json`, { runId: id, client: 'claude-code', status, startedAt: now - age * 60_000 });
  }
  const doc = (await invoke(ctx)).document;
  assert.deepEqual(Object.fromEntries(doc.runs.map((run) => [run.id, run.stale])), { old: true, edge: false, done: false });
});

for (const minutes of [301, 330, 360]) test(`${minutes} minute windows are session windows`, async (t) => {
  const ctx = await world(t);
  await put(ctx.root, 'quota/claude-code.json', { remainingPct: 80, windowMinutes: minutes });
  const doc = (await invoke(ctx)).document;
  assert.equal(doc.accounts[0].quota.session.remaining_pct, 80);
  assert.equal(doc.accounts[0].quota.weekly, null);
});

test('unreadable credentials and Codex config do not fail or reveal secrets', {
  skip: process.getuid?.() === 0 ? 'root bypasses file permissions' : false,
}, async (t) => {
  const ctx = await world(t);
  await put(ctx.root, 'config.json', { configuredClients: ['claude-code', 'codex'], quotaPoll: { enabled: false } });
  const files = ['.claude/.credentials.json', '.codex/auth.json', '.codex/config.toml'];
  const secret = 'panel-secret-never-print';
  for (const file of files) await put(ctx.home, file, { token: secret });
  const before = await treeHash(ctx.home);
  try {
    for (const file of files) await chmod(join(ctx.home, file), 0o000);
    for (const client of ['claude', 'codex']) {
      const result = await invoke(ctx, ['--json', '--client', client]);
      assert.equal(result.code, 0);
      assert.ok(!JSON.stringify(result).includes(secret));
    }
    for (const file of files) assert.equal((await stat(join(ctx.home, file))).mode & 0o777, 0);
  } finally {
    for (const file of files) await chmod(join(ctx.home, file), 0o644);
  }
  assert.equal(await treeHash(ctx.home), before);
});
