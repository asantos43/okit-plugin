import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inboxAdd, inboxClaim, inboxList, inboxRelease, inboxSetStatus } from '../src/inbox.js';
import { syncProject, todoRun } from '../src/todo/index.js';
import { readSnapshot, writeSnapshot } from '../src/todo/safe.js';
import { writeJsonAtomic } from '../src/state.js';
import { main } from '../src/cli.js';
import { TOOLS } from '../src/mcp/tools.js';
import { configCommand } from '../src/config.js';

async function fixture(t, options = {}) {
  const base = await mkdtemp(join(tmpdir(), 'okit-todo-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'state'), project = join(base, 'project');
  await mkdir(root); await mkdir(project);
  const raw = { todo: { projects: { [project]: { enabled: true, ...options } } } };
  await writeJsonAtomic(join(root, 'config.json'), raw);
  await writeFile(join(project, 'TODO.md'), '# Tasks\n\n## Inbox\n- [ ] Add search\n- [ ] Export report\n');
  return { root, project, raw, file: join(project, 'TODO.md') };
}
const owner = { client: 'codex', session: 'test' };
const text = file => readFile(file, 'utf8');

// | Corpus | Must pass | Must refuse |
// | Exact text/anchor and confirmed suggestion | one line changed | guessing |
// | Duplicate text or task owned by another demand | explicit file disambiguation | ambiguous write |
// | Stale file, traversal, outside symlink | preserve user content | write |
test('matching refuses ambiguous or already owned items', async t => {
  const { project, raw, file } = await fixture(t);
  await writeFile(file, '## Inbox\n- [ ] Same\n- [ ] Same\n');
  const demand = { id: 'I1', status: 'delegated', title: 'Same', ext: { todo: { project, item: 'Same' } } };
  await assert.rejects(syncProject(project, [demand], raw), /Several tasks/);
  await writeFile(file, '## Inbox\n- [ ] Same\n');
  const other = { ...demand, id: 'I2' };
  await assert.rejects(syncProject(project, [demand, other], raw), /already belongs/);
  assert.equal(await text(file), '## Inbox\n- [ ] Same\n');
});

test('claim, delivery, reopen and abandonment preserve the exact original item', async t => {
  const { root, project, file } = await fixture(t);
  const before = await text(file);
  const demand = await inboxAdd(root, { title: 'Search feature', appliesTo: project,
    todoLink: { project, item: 'Add search' } });
  await inboxClaim(root, demand.id, owner);
  assert.match(await text(file), /- \[-\] Add search \(I000001\)/);
  await inboxSetStatus(root, demand.id, 'delegated');
  await inboxSetStatus(root, demand.id, 'criticised');
  await inboxSetStatus(root, demand.id, 'consolidated');
  assert.match(await text(file), /- \[x\] Add search \(I000001, \d{4}-\d{2}-\d{2}\)/);
  assert.match(await text(file), /\n- \[ \] Export report\n$/);
  await inboxSetStatus(root, demand.id, 'failed');
  assert.equal(await text(file), before);
  await inboxSetStatus(root, demand.id, 'pending');
  await inboxClaim(root, demand.id, owner);
  await inboxRelease(root, demand.id, owner);
  assert.equal(await text(file), before);
  await todoRun(root);
  assert.equal(await text(file), before);
});

test('registration suggests the closest task and requires confirmation', async t => {
  const { root, project, file } = await fixture(t);
  const before = await text(file);
  const item = await inboxAdd(root, { title: 'Add search quickly', appliesTo: project });
  assert.equal(item.todo.reports[0].suggestions[0].item, 'Add search');
  await inboxClaim(root, item.id, owner);
  assert.equal(await text(file), before);
  const link = { project, item: 'Add search' };
  await assert.rejects(todoRun(root, { id: item.id, link }), /Confirm|Confirme/);
  await todoRun(root, { id: item.id, link, confirm: true, dryRun: true });
  assert.equal((await inboxList(root))[0].ext, undefined);
  assert.equal(await text(file), before);
  await todoRun(root, { id: item.id, link, confirm: true });
  assert.match(await text(file), /\[-\] Add search/);
  assert.deepEqual((await inboxList(root))[0].ext.todo, link);
});

test('new work is inserted in the configured section and subsequent sync is idempotent', async t => {
  const { root, project, file } = await fixture(t, { section: '## Later', checkbox: { progress: '~', done: 'X' } });
  await writeFile(file, '# Tasks\n## Inbox\n- [ ] Keep\n## Later\n## End\nuntouched\n');
  const item = await inboxAdd(root, { title: 'Telemetry', appliesTo: project });
  await inboxClaim(root, item.id, owner);
  assert.match(await text(file), /## Later\n- \[~\] Telemetry.*\n## End\nuntouched\n$/);
  const before = await text(file);
  assert.equal((await todoRun(root)).reports[0].changes.length, 0);
  assert.equal(await text(file), before);
  await inboxSetStatus(root, item.id, 'delegated');
  await inboxSetStatus(root, item.id, 'criticised');
  await inboxSetStatus(root, item.id, 'consolidated');
  assert.match(await text(file), /\[X\] Telemetry/);
  await inboxSetStatus(root, item.id, 'failed');
  assert.match(await text(file), /\[ \] Telemetry <!-- okit-todo:/);
  await inboxSetStatus(root, item.id, 'pending');
  await inboxClaim(root, item.id, owner);
  assert.match(await text(file), /\[~\] Telemetry/);
});

test('index and area files: exact anchor updates only the matching line', async t => {
  const { project, raw, file } = await fixture(t, { areaDir: 'areas' });
  await writeFile(file, '# Tasks\nSee areas\n## Inbox\n');
  await mkdir(join(project, 'areas'));
  const area = join(project, 'areas', 'search.md');
  const original = '# Search\r\n- [ ] Find words {#find}\r\n- [ ] Keep this\r\n';
  await writeFile(area, original);
  const demand = { id: 'I1', title: 'Search', status: 'delegated', ext: { todo: { project, item: '#find' } } };
  const report = await syncProject(project, [demand], raw);
  assert.equal(report.changes.length, 1);
  assert.match(await text(area), /\[-\] Find words \{#find\}/);
  assert.match(await text(area), /\r\n- \[ \] Keep this\r\n$/);
  demand.status = 'failed';
  await syncProject(project, [demand], raw);
  assert.equal(await text(area), original);
  assert.equal(await text(file), '# Tasks\nSee areas\n## Inbox\n');
  await writeFile(area, '# Search\n## Inbox\n');
  await writeFile(file, '# Tasks\nSee areas\n');
  const fresh = { id: 'I2', title: 'Telemetry', status: 'consolidated', appliesTo: project };
  await syncProject(project, [fresh], raw);
  assert.match(await text(area), /## Inbox\n- \[x\] Telemetry/);
});

test('dry run shows a diff without changing content, timestamps or directory entries', async t => {
  const { project, raw, file } = await fixture(t);
  const before = await readSnapshot(project, 'TODO.md');
  const entries = await readdir(project);
  const result = await syncProject(project, [{ id: 'I1', title: 'Telemetry', status: 'consolidated', appliesTo: project }], raw, { dryRun: true });
  assert.match(result.changes[0].diff, /\+.*\[x\] Telemetry/);
  assert.equal(await text(file), before.text);
  assert.equal((await readSnapshot(project, 'TODO.md')).mtime, before.mtime);
  assert.deepEqual(await readdir(project), entries);
});

test('refuse a stale snapshot and changes immediately before rename', async t => {
  const { project, file } = await fixture(t);
  const before = await readSnapshot(project, 'TODO.md');
  await writeFile(file, 'changed by user\n');
  await assert.rejects(writeSnapshot(before, 'wrong\n'), /file changed|arquivo mudou/);
  const fresh = await readSnapshot(project, 'TODO.md');
  await assert.rejects(writeSnapshot(fresh, 'wrong\n', { beforeRename: () => writeFile(file, 'another edit\n') }), /file changed|arquivo mudou/);
  assert.equal(await text(file), 'another edit\n');
  assert.deepEqual(await readdir(project), ['TODO.md']);
});

test('refuse changed content with identical size, modification time and inode', async t => {
  const { project, file } = await fixture(t);
  const stamp = new Date('2000-01-01T00:00:00Z');
  await utimes(file, stamp, stamp);
  const before = await readSnapshot(project, 'TODO.md');
  const edited = before.text.replace('Add search', 'Add filter');
  await writeFile(file, edited);
  await utimes(file, stamp, stamp);
  const current = await readSnapshot(project, 'TODO.md');
  assert.equal(Buffer.byteLength(current.text), Buffer.byteLength(before.text));
  assert.equal(current.mtime, before.mtime);
  assert.equal(current.ino, before.ino);
  assert.notEqual(current.hash, before.hash);
  await assert.rejects(writeSnapshot(before, 'wrong\n'), /file changed|arquivo mudou/);
  assert.equal(await text(file), edited);
  assert.deepEqual(await readdir(project), ['TODO.md']);
});

test('refuse identical content when only modification time or only inode changes', async t => {
  const { project, file } = await fixture(t);
  const stamp = new Date('2000-01-01T00:00:00Z');
  await utimes(file, stamp, stamp);
  const before = await readSnapshot(project, 'TODO.md');
  await utimes(file, stamp, new Date('2000-01-02T00:00:00Z'));
  const retimed = await readSnapshot(project, 'TODO.md');
  assert.equal(retimed.hash, before.hash);
  assert.equal(retimed.ino, before.ino);
  assert.notEqual(retimed.mtime, before.mtime);
  await assert.rejects(writeSnapshot(before, 'wrong\n'), /file changed|arquivo mudou/);
  assert.equal(await text(file), before.text);

  const replacement = join(project, 'replacement.tmp');
  await writeFile(replacement, before.text);
  await utimes(replacement, stamp, stamp);
  await rename(replacement, file);
  const replaced = await readSnapshot(project, 'TODO.md');
  assert.equal(replaced.hash, before.hash);
  assert.equal(replaced.mtime, before.mtime);
  assert.notEqual(replaced.ino, before.ino);
  await assert.rejects(writeSnapshot(before, 'wrong\n'), /file changed|arquivo mudou/);
  assert.equal(await text(file), before.text);
  assert.deepEqual(await readdir(project), ['TODO.md']);
});

test('refuse traversal, absolute outside paths and symlink escapes', async t => {
  const { project, root } = await fixture(t);
  const outside = join(root, 'outside.md');
  await writeFile(outside, '- [ ] Private\n');
  await symlink(outside, join(project, 'escape.md'));
  for (const name of ['../state/outside.md', outside, 'escape.md']) {
    await assert.rejects(readSnapshot(project, name), /outside the project|fora do projeto/);
  }
  assert.equal(await text(outside), '- [ ] Private\n');
  await assert.rejects(todoRun(root, { project: '.' }), /full project folder/);
});

test('check reports both kinds of orphan and disabled projects are untouched', async t => {
  const { root, project, raw, file } = await fixture(t);
  assert.equal((await todoRun(root, { check: true })).reports[0].itemsWithoutDemand.length, 2);
  await inboxAdd(root, { title: 'Missing work', appliesTo: project });
  await inboxAdd(root, { title: 'Linked work', todoLink: { project, item: 'Add search' } });
  const result = (await todoRun(root, { check: true })).reports[0];
  assert.deepEqual(result.demandsWithoutItem.map(item => item.title), ['Missing work']);
  assert.deepEqual(result.itemsWithoutDemand.map(item => item.text), ['Export report']);
  raw.todo.projects[project].enabled = false;
  await writeJsonAtomic(join(root, 'config.json'), raw);
  await rm(file);
  const demand = (await inboxList(root))[0];
  const taken = await inboxClaim(root, demand.id, owner);
  assert.equal(taken.todoWarning, undefined);
  assert.equal((await todoRun(root)).reports[0].enabled, false);
  assert.deepEqual(await readdir(project), []);
});

test('TODO failure never rolls back an inbox transition', async t => {
  const { root, project, file } = await fixture(t);
  const demand = await inboxAdd(root, { title: 'Work', todoLink: { project, item: 'Add search' } });
  await rm(file);
  const result = await inboxSetStatus(root, demand.id, 'delegated');
  assert.match(result.todoWarning, /work was saved.*trabalho foi salvo/);
  assert.equal((await inboxList(root))[0].status, 'delegated');
});

test('CLI and MCP share synchronization and status; invalid flags and types refuse', async t => {
  const { root, project, file } = await fixture(t);
  await inboxAdd(root, { title: 'Telemetry', appliesTo: project });
  const output = [], errors = [];
  const io = { root, stdout: value => output.push(value), stderr: value => errors.push(value) };
  assert.equal(await main(['todo', 'check', '--project', project], io), 0);
  assert.match(output.join('\n'), /Telemetry/);
  assert.equal(await main(['todo', 'sync', '--dry-run'], io), 0);
  assert.equal(await main(['todo', 'check', '--dry-run'], io), 2);
  const tool = name => TOOLS.find(tool => tool.name === name);
  const status = JSON.parse(await tool('todo_status').handler({ project }, { root }));
  assert.equal(status.reports[0].demandsWithoutItem[0].title, 'Telemetry');
  const before = await text(file);
  await tool('todo_sync').handler({ project, dryRun: true }, { root });
  assert.equal(await text(file), before);
  await assert.rejects(tool('todo_sync').handler({ dryRun: 'yes' }, { root }), /boolean/);
  await assert.rejects(tool('todo_status').handler({ unknown: true }, { root }), /unknown argument/);
});

test('configuration accepts project settings and custom checkbox characters', async t => {
  const { root } = await fixture(t);
  const ctx = { root, out() {}, err() {}, unknown: () => 2 };
  assert.equal(await configCommand(ctx, 'set', ['todo.enabled', 'true']), 0);
  assert.equal(await configCommand(ctx, 'set', ['todo.checkbox.open', ' ']), 0);
  assert.equal(await configCommand(ctx, 'set', ['todo.checkbox.done', 'bad']), 2);
  assert.equal(await configCommand(ctx, 'set', ['todo.projects', '{"relative":{"enabled":true}}']), 2);
});
