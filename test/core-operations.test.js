// The registry of the operations: every operation runs without the command
// line and without the MCP server, on a state root of its own, and returns
// data. Nothing here prints and nothing here reads the machine.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { inboxAdd, inboxClaim } from '../src/inbox.js';
import { OPERATIONS, operation, run } from '../src/core/operations.js';
import { todoRun } from '../src/todo/index.js';

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

// The tools that came from the table of the server and kept the description
// they always had: the one in English alone.
const MOVED = [
  'inbox_add', 'inbox_list', 'inbox_claim', 'inbox_release', 'inbox_set_status', 'order_add', 'order_list', 'order_remove',
  'acquire_slot', 'release_slot', 'limits_status', 'status', 'actors_list', 'classify',
];

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
    'acquire_slot', 'actors_list', 'classify', 'config_get', 'config_set', 'daemon', 'env_report', 'inbox_add',
    'inbox_claim', 'inbox_list', 'inbox_release', 'inbox_set_status', 'kit_detect', 'limits_status', 'order_add',
    'order_list', 'order_remove', 'profile_pick', 'quota_notice', 'quota_set', 'quota_show', 'release_slot', 'status',
    'todo_check',
  ]);
  assert.equal(new Set(OPERATIONS.map((entry) => entry.name)).size, OPERATIONS.length, 'no name is twice');
});

test('every entry has a description in both languages and the schema of an object', () => {
  for (const entry of OPERATIONS) {
    assert.equal(typeof entry.name, 'string');
    assert.ok(entry.name.trim().length > 0, entry.name);
    assert.equal(typeof entry.description.en, 'string');
    assert.ok(entry.description.en.trim().length > 0, `${entry.name}: the English description`);
    // The tools that came from the table of the server keep the description they always had, in English alone.
    if (!MOVED.includes(entry.name)) {
      assert.equal(typeof entry.description['pt-BR'], 'string');
      assert.ok(entry.description['pt-BR'].trim().length > 0, `${entry.name}: the Portuguese description`);
    }
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

test('daemon refuses a table it cannot build and shows the one the caller brings', async (t) => {
  const root = await tempRoot(t);
  // The table is built from the dependencies of the caller: without them the
  // answer says so instead of showing a status with no table at all.
  await assert.rejects(run('daemon', root, { action: 'status', table: true }, deps()), (error) => {
    assert.equal(error.name, 'Refusal');
    assert.match(error.message, /daemon: table needs deps\.table/);
    return true;
  });
  const table = { clients: ['claude-code'], readQuota: async () => ({ source: 'off' }), now: () => T0,
    cache: new Map(), env: {}, home: root, demands: [], plugin: {}, versions: {},
    detectClients: async () => ({ clients: [] }) };
  const status = await run('daemon', root, { action: 'status', table: true }, deps({ table }));
  assert.equal(status.running, false);
  assert.deepEqual(Object.keys(status.table), ['markdown', 'capacityLine']);
  assert.match(status.table.markdown, /\| Subscription \|/);
  assert.match(status.table.capacityLine, /quota floor/);
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

test('todo_check reports the work without a task and the tasks without work', async (t) => {
  await mkdir(TMP, { recursive: true });
  const base = await mkdtemp(join(TMP, 'core-todo-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'state');
  const project = join(base, 'project');
  await mkdir(root);
  await mkdir(project);
  await writeFile(join(root, 'config.json'),
    JSON.stringify({ todo: { projects: { [project]: { enabled: true } } } }), 'utf8');
  await writeFile(join(project, 'TODO.md'), '# Tasks\n\n## Inbox\n- [ ] Add search\n- [ ] Export report\n');
  await inboxAdd(root, { title: 'Missing work', appliesTo: project });

  const checked = await run('todo_check', root, {}, deps());
  assert.equal(checked.reports.length, 1);
  const report = checked.reports[0];
  assert.equal(report.project, project);
  assert.equal(report.enabled, true);
  assert.deepEqual(report.demandsWithoutItem.map((item) => item.title), ['Missing work']);
  assert.deepEqual(report.itemsWithoutDemand.map((item) => item.text), ['Add search', 'Export report']);
  assert.deepEqual(report.changes, []);

  // A project the root does not know is disabled, the way the command has
  // always answered for one: the report says so and nothing changes.
  const outside = join(base, 'outside');
  await mkdir(outside);
  const elsewhere = await run('todo_check', root, { project: outside }, deps());
  assert.equal(elsewhere.reports.length, 1);
  assert.equal(elsewhere.reports[0].project, outside);
  assert.equal(elsewhere.reports[0].enabled, false);
  assert.deepEqual(elsewhere.reports[0].demandsWithoutItem, []);
  assert.deepEqual(elsewhere.reports[0].itemsWithoutDemand, []);
  assert.deepEqual(elsewhere.reports[0].changes, []);
});

test('todo_check changes nothing while a plain run writes the list', async (t) => {
  await mkdir(TMP, { recursive: true });
  const base = await mkdtemp(join(TMP, 'core-todo-active-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'state');
  const project = join(base, 'project');
  const copy = join(base, 'copy');
  await mkdir(root);
  await mkdir(project);
  await mkdir(copy);
  const list = '# Tasks\n\n## Inbox\n- [ ] Add search\n';
  await writeFile(join(project, 'TODO.md'), list, 'utf8');
  await writeFile(join(copy, 'TODO.md'), list, 'utf8');
  // The lists start off: the work is registered and taken while nothing is
  // written to them, so the demand is active and the list still has no line
  // for it.
  const settings = (enabled) => JSON.stringify({ todo: { projects: {
    [project]: { enabled }, [copy]: { enabled },
  } } });
  await writeFile(join(root, 'config.json'), settings(false), 'utf8');
  const demand = await inboxAdd(root, { title: 'Active work', appliesTo: [project, copy] });
  await inboxClaim(root, demand.id, { client: 'codex', session: 'test' });
  await writeFile(join(root, 'config.json'), settings(true), 'utf8');
  const before = await readFile(join(project, 'TODO.md'));

  // The premise: a plain run writes the active work into the list.
  const written = await todoRun(root, { project: copy, check: false });
  assert.equal(written.reports[0].changes.length, 1);
  assert.match(await readFile(join(copy, 'TODO.md'), 'utf8'), /Active work/);

  // The check reads the same work and writes nothing at all.
  const checked = await run('todo_check', root, { project }, deps());
  assert.equal(checked.reports.length, 1);
  assert.equal(checked.reports[0].enabled, true);
  assert.deepEqual(checked.reports[0].demandsWithoutItem.map((item) => item.title), ['Active work']);
  assert.deepEqual(checked.reports[0].changes, []);
  assert.deepEqual(await readFile(join(project, 'TODO.md')), before);
});

test('quota_set refuses a client name that is a path and writes nothing outside the root', async (t) => {
  const root = await tempRoot(t, {
    limits: { global: 3, clients: {} },
    profiles: { '../../escape': { simple: { model: 'haiku', effort: 'low', maxTurns: 4 } } },
  });
  await assert.rejects(run('quota_set', root, { client: '../../escape', pct: 80 }, deps()), TypeError);
  await assert.rejects(run('quota_show', root, { client: '../../escape' }, deps()), TypeError);
  await assert.rejects(readFile(join(TMP, 'escape.json'), 'utf8'), { code: 'ENOENT' });
  assert.deepEqual(await readdir(join(root, 'quota')).catch(() => []), []);
});

test('a configured client name that is a path is never listed, read nor written', async (t) => {
  const root = await tempRoot(t, {
    limits: { global: 3, clients: {} },
    profiles: {
      '../../escape': { simple: { model: 'haiku', effort: 'low', maxTurns: 4 } },
      codex: { simple: { model: 'gpt-5-codex', effort: 'low', maxTurns: 4 } },
    },
  });
  const shown = await run('quota_show', root, {}, deps());
  assert.deepEqual(shown.clients.map((entry) => entry.client), ['codex']);
  await assert.rejects(run('quota_show', root, { client: '../../escape' }, deps()), TypeError);
  await assert.rejects(run('quota_set', root, { client: '../../escape', pct: 80 }, deps()), TypeError);
  assert.deepEqual(await readdir(join(root, 'quota')).catch(() => []), []);
});

test('an explicit null is refused instead of passing for an absent value', async (t) => {
  const root = await tempRoot(t);
  await assert.rejects(run('config_set', root, { key: 'limits.global', value: null }), TypeError);
  const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  assert.equal(saved.limits.global, 3, 'a refused set leaves the setting as it was');
  await assert.rejects(run('quota_set', root, { client: 'claude-code', pct: 80, windowMinutes: null }, deps()), TypeError);
  await assert.rejects(run('daemon', root, { action: 'status', table: null }, deps()), TypeError);
});

test('the arguments are a plain object and only their own keys are read', async (t) => {
  const root = await tempRoot(t);
  await assert.rejects(run('daemon', root, Object.create({ action: 'status', unexpected: 1 }), deps()), TypeError);
  class Call { constructor() { this.action = 'status'; } }
  await assert.rejects(run('daemon', root, new Call(), deps()), TypeError);
  await assert.rejects(run('config_get', root, null), TypeError);
  const all = await run('config_get', root, undefined);
  assert.ok(all.entries.length > 10, 'no arguments is the whole table');
});

test('an argument that hides is refused as well', async (t) => {
  const root = await tempRoot(t);
  // A key that is not enumerable is still a key the operation does not take.
  const hidden = {};
  Object.defineProperty(hidden, 'secret', { value: 1, enumerable: false });
  await assert.rejects(run('config_get', root, hidden, deps()), (error) => {
    assert.equal(error.name, 'Refusal');
    assert.match(error.message, /unknown argument secret/);
    return true;
  });
  // A symbol is a key as well, and the refusal says which one it is.
  const marked = { key: 'limits.global' };
  marked[Symbol('secret')] = 1;
  await assert.rejects(run('config_get', root, marked, deps()), (error) => {
    assert.equal(error.name, 'Refusal');
    assert.match(error.message, /unknown argument Symbol\(secret\)/);
    return true;
  });
});

test('a name with a space around it is refused by the four operations the same way', async (t) => {
  const root = await tempRoot(t);
  const calls = [
    () => run('config_get', root, { key: ' limits.global ' }, deps()),
    () => run('config_set', root, { key: ' limits.global ', value: '7' }, deps()),
    () => run('quota_show', root, { client: ' claude-code ' }, deps()),
    () => run('quota_set', root, { client: ' claude-code ', pct: 80 }, deps()),
  ];
  for (const call of calls) {
    await assert.rejects(call(), (error) => {
      assert.equal(error.name, 'Refusal');
      assert.match(error.message, /must not have leading or trailing spaces/);
      return true;
    });
  }
  const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  assert.equal(saved.limits.global, 3, 'a refused set writes nothing');
});

test('kit_detect probes a kit it finds with the runner of the command line', async (t) => {
  const root = await tempRoot(t);
  const folder = join(TMP, 'kit-probe');
  await mkdir(folder, { recursive: true });
  t.after(() => rm(folder, { recursive: true, force: true }));
  const executable = join(folder, 'kit');
  await writeFile(executable, `#!${process.execPath}\nconsole.log('kit v1.2.3');\n`, { mode: 0o755 });
  await writeFile(join(root, 'config.json'),
    JSON.stringify({ ...CONFIG, install: { kit: { path: executable } } }), 'utf8');
  const kit = await run('kit_detect', root, {});
  assert.doesNotMatch(kit.message, /deps\.run is not a function/);
  assert.equal(kit.state, 'installed');
  assert.equal(kit.path, executable);
  assert.equal(kit.version, 'kit v1.2.3');
});

test('the component index says what the registry holds today', async () => {
  const english = await readFile(new URL('../docs/components/README.md', import.meta.url), 'utf8');
  const portuguese = await readFile(new URL('../docs/components/README.pt-BR.md', import.meta.url), 'utf8');
  const names = OPERATIONS.map((entry) => entry.name);
  for (const text of [english, portuguese]) {
    for (const name of names) assert.ok(text.includes(name), name);
  }
  assert.match(english, /twenty-four operations/);
  assert.match(portuguese, /vinte e quatro operações/);
  assert.doesNotMatch(english, /MCP tools call the same entries/);
  assert.doesNotMatch(portuguese, /ferramentas MCP chamam as mesmas entradas/);
});
