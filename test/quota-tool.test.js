import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { readQuota as claudeQuota } from '../adapters/claude-code/index.js';
import { readQuota as codexQuota } from '../adapters/codex/index.js';
import { readQuota as opencodeQuota } from '../adapters/opencode/index.js';
import { callTool } from './helpers/tools.js';
import { quotaEnv } from './helpers/env.js';

// The quota of a client is recorded and read through the tool of the server (the assistant's side): the command line
// has no quota command of its own any more.

// Must pass / must refuse:
// | pass: known clients, 0/80.5/100, positive window, show |
// | refuse: unknown client, pct <0/>100/nonfinite/empty, invalid window/flags |
test('the quota tool records timestamped samples read by every adapter', async (t) => {
  const root = await quotaRoot(t);
  for (const [client, readQuota] of [['claude-code', claudeQuota], ['codex', codexQuota], ['opencode', opencodeQuota]]) {
    for (const pct of [0, 80.5, 100]) {
      const recorded = await callTool('quota_set', { client, pct, windowMinutes: 300 }, { root, env: quotaEnv(root), now: () => T0 });
      assert.equal(recorded.pct, pct);
      const stored = JSON.parse(await readFile(join(root, 'quota', `${client}.json`), 'utf8'));
      assert.deepEqual(stored, { remainingPct: pct, windowMinutes: 300, recordedAt: new Date(T0).toISOString() });
      assert.deepEqual(await readQuota({ stateRoot: root, env: quotaEnv(root), now: () => T0 + 60_000 }),
        { source: client === 'codex' ? 'manual' : 'user', ...stored, ageMinutes: 1 });
    }
  }
  const shown = await callTool('quota_show', {}, { root, env: quotaEnv(root), now: () => T0 });
  assert.equal(shown.clients.length, 3);
  const one = await callTool('quota_show', { client: 'codex' }, { root, env: quotaEnv(root), now: () => T0 });
  assert.equal(one.clients[0].reading.remainingPct, 100);
  for (const [client, readQuota] of [['claude-code', claudeQuota], ['codex', codexQuota], ['opencode', opencodeQuota]]) {
    await writeFile(join(root, 'quota', `${client}.json`), JSON.stringify({ remainingPct: 80 }));
    assert.deepEqual(await readQuota({ stateRoot: root, env: quotaEnv(root) }), { source: client === 'codex' ? 'manual' : 'user', remainingPct: 80 });
  }
});

test('the quota tool refuses invalid values without replacing a valid sample', async (t) => {
  const root = await quotaRoot(t);
  await callTool('quota_set', { client: 'claude-code', pct: 80 }, { root, env: quotaEnv(root) });
  const file = join(root, 'quota/claude-code.json');
  const original = await readFile(file, 'utf8');
  for (const pct of [-1, 101, 'NaN', 'Infinity', '']) {
    await assert.rejects(callTool('quota_set', { client: 'claude-code', pct }, { root, env: quotaEnv(root) }), /pct/);
  }
  for (const args of [{ client: 'unknown', pct: 80 }, { client: '../escape', pct: 80 },
    { client: 'codex' }, { client: 'codex', pct: 80, other: 1 }]) {
    await assert.rejects(callTool('quota_set', args, { root, env: quotaEnv(root) }), /quota_set/);
  }
  await assert.rejects(callTool('quota_set', { client: 'codex', pct: 80, windowMinutes: 0 }, { root, env: quotaEnv(root) }), /quota_set/);
  assert.equal(await readFile(file, 'utf8'), original);
  assert.deepEqual(await readdir(join(root, 'quota')), ['claude-code.json']);
});

// The clients of a root are the ones its configuration names: a client outside
// that list has no reading, so it is refused instead of stored.
test('the quota tool refuses a client outside the list of the root', async (t) => {
  const root = await claudeRoot(t);
  await callTool('quota_set', { client: 'claude-code', pct: 80 }, { root, env: quotaEnv(root) });
  await assert.rejects(callTool('quota_set', { client: 'codex', pct: 80 }, { root, env: quotaEnv(root) }), /unknown client/);
  await assert.rejects(callTool('quota_show', { client: 'codex' }, { root, env: quotaEnv(root) }), /unknown client/);
  assert.deepEqual(await readdir(join(root, 'quota')), ['claude-code.json']);
  const shown = await callTool('quota_show', {}, { root, env: quotaEnv(root) });
  assert.equal(shown.clients.length, 1);
  assert.equal(shown.clients[0].client, 'claude-code');
});

test('the quota tool replaces only complete JSON and leaves no temporary files', async (t) => {
  const root = await quotaRoot(t);
  await callTool('quota_set', { client: 'codex', pct: 80, windowMinutes: 300 }, { root, env: quotaEnv(root), now: () => T0 });
  const file = join(root, 'quota/codex.json');
  let writing = true;
  const observer = (async () => {
    while (writing) {
      const value = JSON.parse(await readFile(file, 'utf8'));
      assert.ok([80, 50].includes(value.remainingPct));
      assert.ok(Number.isFinite(Date.parse(value.recordedAt)));
    }
  })();
  try { await callTool('quota_set', { client: 'codex', pct: 50 }, { root, env: quotaEnv(root), now: () => T0 }); }
  finally { writing = false; await observer; }
  assert.equal(JSON.parse(await readFile(file, 'utf8')).windowMinutes, undefined);
  assert.deepEqual(await readdir(join(root, 'quota')), ['codex.json']);
});

// Scratch state lives inside the repository, never in the system temp folder.
const TMP = fileURLToPath(new URL('../.delegate/tmp/', import.meta.url));

const T0 = 1_760_000_000_000;

const CONFIG = {
  limits: { global: 3, clients: {} },
  profiles: {
    'claude-code': {
      simple: { model: 'haiku', effort: 'low', maxTurns: 4 },
      normal: { model: 'sonnet', effort: 'medium', maxTurns: 12 },
      hard: { model: 'opus', effort: 'high', maxTurns: 30 },
    },
  },
};

/** A root that names one client: the others are outside the list of the root. */
async function claudeRoot(t) {
  await mkdir(TMP, { recursive: true });
  const root = await mkdtemp(join(TMP, 'cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'sessions'));
  await writeFile(join(root, 'config.json'), JSON.stringify(CONFIG), 'utf8');
  return root;
}

/**
 * A root whose configuration names every client, so the quota tool knows
 * them all: the clients of a root are the ones its configuration names.
 */
async function quotaRoot(t) {
  await mkdir(TMP, { recursive: true });
  const root = await mkdtemp(join(TMP, 'cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'sessions'));
  const profiles = Object.fromEntries(['claude-code', 'codex', 'opencode']
    .map((client) => [client, CONFIG.profiles['claude-code']]));
  await writeFile(join(root, 'config.json'), JSON.stringify({ ...CONFIG, profiles }), 'utf8');
  return root;
}
