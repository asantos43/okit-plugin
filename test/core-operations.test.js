// The registry of the operations: every operation runs without the command
// line and without the MCP server, on a state root of its own, and returns
// data. Nothing here prints and nothing here reads the machine.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { OPERATIONS, operation, run } from '../src/core/operations.js';

// Scratch state lives inside the repository, never in the system temp folder.
const TMP = fileURLToPath(new URL('../.delegate/tmp/', import.meta.url));

const T0 = 1_760_000_000_000;

const CONFIG = {
  limits: { global: 3, clients: {} },
  profiles: { 'claude-code': { simple: { model: 'haiku', effort: 'low', maxTurns: 4 } } },
};

async function tempRoot(t, config = CONFIG) {
  await mkdir(TMP, { recursive: true });
  const root = await mkdtemp(join(TMP, 'core-operations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'sessions'));
  await writeFile(join(root, 'config.json'), JSON.stringify(config), 'utf8');
  return root;
}

/** The dependencies of a call that reads the state root and nothing else. */
const deps = (extra = {}) => ({
  env: {}, fs: filesystem, home: undefined, now: () => T0,
  detectClients: async () => ({ clients: [] }), plugin: {}, versions: {},
  ...extra,
});

// | operation | must pass | must refuse |
// | config_get | the whole table and one entry | a wrong argument, an unknown argument, an unknown key |
// | config_set | the value written and the value removed | a wrong value, an unknown argument, an unknown key |
// | quota_show | the reading of the clients of the root | a wrong argument, an unknown argument, an unknown client |
// | quota_set | the reading recorded | a percentage out of range, an unknown argument, an unknown client |
// | daemon | the state of the daemon | an action it does not have, an unknown argument |
// | kit_detect | the probe of the kit | arguments it does not take |
// | todo_check | the report of the check | a wrong argument, an unknown argument |

test('the registry holds one entry per operation of the core', () => {
  assert.deepEqual(OPERATIONS.map((entry) => entry.name).sort(), [
    'config_get', 'config_set', 'daemon', 'kit_detect', 'quota_set', 'quota_show', 'todo_check',
  ]);
  assert.equal(new Set(OPERATIONS.map((entry) => entry.name)).size, OPERATIONS.length, 'no name is twice');
});

test('every entry has a description in both languages and the schema of an object', () => {
  for (const entry of OPERATIONS) {
    assert.equal(typeof entry.name, 'string');
    assert.ok(entry.name.trim().length > 0, entry.name);
    assert.equal(typeof entry.description.en, 'string');
    assert.ok(entry.description.en.trim().length > 0, `${entry.name}: the English description`);
    assert.equal(typeof entry.description['pt-BR'], 'string');
    assert.ok(entry.description['pt-BR'].trim().length > 0, `${entry.name}: the Portuguese description`);
    assert.equal(entry.schema.type, 'object');
    assert.equal(typeof entry.handler, 'function');
  }
});

test('the registry finds an entry by its name and refuses a name it does not have', async () => {
  assert.equal(operation('config_get').name, 'config_get');
  assert.equal(operation('no_such_operation'), undefined);
  await assert.rejects(run('no_such_operation', TMP, {}), TypeError);
});

test('config_get reads the whole table of a root and one entry of it', async (t) => {
  const root = await tempRoot(t);
  const all = await run('config_get', root, {});
  assert.ok(all.entries.length > 10, 'the whole table');
  const limits = all.entries.find((entry) => entry.path === 'limits.global');
  assert.equal(limits.value, 3);
  assert.equal(limits.origin, 'user');
  assert.ok(limits.description.en.length > 0);

  const one = await run('config_get', root, { key: 'limits.global' });
  assert.equal(one.entries.length, 1);
  assert.equal(one.entries[0].path, 'limits.global');
  assert.equal(one.entries[0].value, 3);
});

test('config_get refuses a wrong argument, an unknown argument and an unknown key', async (t) => {
  const root = await tempRoot(t);
  await assert.rejects(run('config_get', root, { key: 42 }), TypeError);
  await assert.rejects(run('config_get', root, { key: 'limits.global', other: 1 }), TypeError);
  await assert.rejects(run('config_get', root, { key: 'limits.unknown' }), TypeError);
});

test('config_set writes one value and removes it when no value is given', async (t) => {
  const root = await tempRoot(t);
  const set = await run('config_set', root, { key: 'limits.global', value: '7' });
  assert.equal(set.path, 'limits.global');
  assert.equal(set.previous.value, 3);
  assert.equal(set.after.value, 7);
  assert.equal(set.after.origin, 'user');
  assert.equal(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')).limits.global, 7);

  const unset = await run('config_set', root, { key: 'limits.global' });
  assert.equal(unset.after.value, 3);
  assert.equal(unset.after.origin, 'default');
  assert.equal(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')).limits.global, undefined);
});

test('config_set refuses a wrong value, an unknown argument and an unknown key', async (t) => {
  const root = await tempRoot(t);
  await assert.rejects(run('config_set', root, { key: 'limits.global', value: 7 }), TypeError);
  await assert.rejects(run('config_set', root, { key: 'limits.global', value: '7', other: 1 }), TypeError);
  await assert.rejects(run('config_set', root, { key: 'limits.unknown', value: '7' }), TypeError);
  await assert.rejects(run('config_set', root, { key: 'limits.global', value: '0' }), TypeError);
  const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  assert.equal(saved.limits.global, 3, 'a refused set writes nothing');
});

test('quota_show reads the reading of the clients of a root', async (t) => {
  const root = await tempRoot(t);
  const shown = await run('quota_show', root, {}, deps());
  assert.deepEqual(shown.clients.map((entry) => entry.client), ['claude-code']);
  const one = await run('quota_show', root, { client: 'claude-code' }, deps());
  assert.equal(one.clients.length, 1);
  assert.equal(one.clients[0].client, 'claude-code');
});

test('quota_show refuses a wrong argument, an unknown argument and an unknown client', async (t) => {
  const root = await tempRoot(t);
  await assert.rejects(run('quota_show', root, { client: 42 }, deps()), TypeError);
  await assert.rejects(run('quota_show', root, { client: 'claude-code', other: 1 }, deps()), TypeError);
  await assert.rejects(run('quota_show', root, { client: 'unknown' }, deps()), TypeError);
});

test('quota_set records the reading of a client', async (t) => {
  const root = await tempRoot(t);
  const recorded = await run('quota_set', root, { client: 'claude-code', pct: 80 }, deps());
  assert.equal(recorded.client, 'claude-code');
  assert.equal(recorded.pct, 80);
  const stored = JSON.parse(await readFile(join(root, 'quota', 'claude-code.json'), 'utf8'));
  assert.deepEqual(stored, { remainingPct: 80, recordedAt: new Date(T0).toISOString() });
});

test('quota_set refuses a percentage out of range, an unknown argument and an unknown client', async (t) => {
  const root = await tempRoot(t);
  await assert.rejects(run('quota_set', root, { client: 'claude-code', pct: 101 }, deps()), TypeError);
  await assert.rejects(run('quota_set', root, { client: 'claude-code', pct: '80' }, deps()), TypeError);
  await assert.rejects(run('quota_set', root, { client: 'claude-code', pct: 80, other: 1 }, deps()), TypeError);
  await assert.rejects(run('quota_set', root, { client: 'unknown', pct: 80 }, deps()), TypeError);
  await assert.rejects(run('quota_set', root, { client: 'claude-code', pct: 80, windowMinutes: 0 }, deps()), TypeError);
});

test('daemon reports the state of a root and refuses an action it does not have', async (t) => {
  const root = await tempRoot(t);
  const status = await run('daemon', root, { action: 'status' }, deps());
  assert.equal(status.running, false);
  assert.equal(status.paused, false);
  assert.equal(status.lastTick, null);
  const paused = await run('daemon', root, { action: 'pause' }, deps());
  assert.equal(paused.paused, true);
  const resumed = await run('daemon', root, { action: 'resume' }, deps());
  assert.equal(resumed.paused, false);
  await assert.rejects(run('daemon', root, { action: 'fly' }, deps()), TypeError);
  await assert.rejects(run('daemon', root, { action: 'status', table: 'yes' }, deps()), TypeError);
  await assert.rejects(run('daemon', root, { action: 'status', other: 1 }, deps()), TypeError);
});

test('kit_detect probes the kit of a root and refuses arguments it does not take', async (t) => {
  const root = await tempRoot(t);
  const kit = await run('kit_detect', root, {}, deps());
  assert.equal(kit.state, 'absent');
  assert.equal(kit.path, null);
  await assert.rejects(run('kit_detect', root, 'no-such-arguments', deps()), TypeError);
  await assert.rejects(run('kit_detect', root, { other: 1 }, deps()), TypeError);
});

test('todo_check compares the task lists of a root with the work it holds', async (t) => {
  const root = await tempRoot(t);
  const checked = await run('todo_check', root, {}, deps());
  assert.deepEqual(checked.reports, []);
  await assert.rejects(run('todo_check', root, { project: 42 }, deps()), TypeError);
  await assert.rejects(run('todo_check', root, { other: 1 }, deps()), TypeError);
});
