import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { inboxAdd, inboxClaim, inboxRelease, inboxList, inboxSetExt, inboxSetStatus } from '../src/inbox.js';
import { configOf } from '../src/profiles.js';

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'inbox-test-'));
}

const add = (root, extra = {}) => inboxAdd(root, {
  title: 'write the report',
  accept: ['the file exists'],
  ...extra,
});

// | case | must pass | must refuse |
// | concurrent claims | one winner; same owner repeats | other active session |
// | release | owner or stale | other active owner |
// | terminal status | clears hold, records history | foreign delegated holder |
test('atomic holds identify the winner and protect release and delegation', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const item = await add(root);
  assert.equal((await inboxList(root))[0].hold, undefined);
  const owners = [{ client: 'codex', session: 'one', worktree: 'a' }, { client: 'codex', session: 'two', worktree: 'b' }];
  const outcomes = await Promise.allSettled(owners.map((owner) => inboxClaim(root, item.id, owner)));
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
  const hold = (await inboxList(root))[0].hold;
  assert.match(outcomes.find((r) => r.status === 'rejected').reason.message, /held by codex .* since/);
  assert.deepEqual((await inboxClaim(root, item.id, hold)).hold, hold);
  const other = owners.find((o) => o.session !== hold.session);
  await assert.rejects(inboxRelease(root, item.id, other), /held by/);
  await assert.rejects(inboxSetStatus(root, item.id, 'delegated', { holder: other }), /held by/);
  await inboxSetStatus(root, item.id, 'delegated', { holder: hold });
  assert.equal((await inboxRelease(root, item.id, hold)).hold, undefined);
});

test('stale configured holds transfer and release with previous ownership history', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const item = await add(root);
  await writeFile(join(root, 'config.json'), JSON.stringify({ inbox: { holdStaleMinutes: 1 } }));
  const old = { client: 'claude-code', session: 'old', worktree: 'wt', takenAt: new Date(Date.now() - 61_000).toISOString(), via: 'claim' };
  const save = () => writeFile(join(root, 'inbox.json'), JSON.stringify({ seq: 1, items: [{ ...item, hold: old }] }));
  await save();
  const claimed = await inboxClaim(root, item.id, { client: 'opencode' });
  assert.equal(claimed.stale, true);
  assert.equal(claimed.heldBefore[0].reason, 'stale');
  assert.equal(claimed.heldBefore[0].session, 'old');
  assert.ok(claimed.heldBefore[0].releasedAt);
  await save();
  assert.equal((await inboxRelease(root, item.id, { client: 'codex' })).hold, undefined);
  for (const value of [0, -1, 1.5, '120']) assert.throws(() => configOf({ inbox: { holdStaleMinutes: value } }), /integer >= 1/);
});

test('consolidated and failed clear hold and retain history', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const final of ['consolidated', 'failed']) {
    const item = await add(root);
    await inboxClaim(root, item.id, { client: 'codex' });
    if (final === 'consolidated') for (const status of ['delegated', 'criticised']) await inboxSetStatus(root, item.id, status);
    const done = await inboxSetStatus(root, item.id, final);
    assert.equal(done.hold, undefined);
    assert.equal(done.heldBefore[0].reason, final);
  }
});

// Must pass / must refuse table:
// | case | must pass | must refuse |
// | add good            | I1, pending, stepIds [] | -                     |
// | add bad title       | -                         | TypeError             |
// | add bad accept      | -                         | TypeError             |
// | add bad effort      | -                         | TypeError             |
// | add bad kind        | -                         | TypeError             |
// | move forward        | pending->delegated        | pending->consolidated |
// | fail any            | any->failed               | failed->failed        |
// | recover             | failed->pending           | delegated->pending    |
// | appliesTo project   | appliesTo 'proj'          | -                     |
// | appliesTo array     | ['a','b'] deduped         | ['a','']               |
// | appliesTo global    | field left out            | ['global','a']         |
// | filter proj         | project + global items    | -                     |
// | filter global       | only the global items     | '' filter              |

test('inboxAdd stores an item with an id, a status and a date', async () => {
  const root = await tempRoot();

  const item = await add(root, { body: 'two paragraphs', kind: 'writing', client: 'desk' });

  assert.match(item.id, /^I\d+$/);
  assert.equal(item.status, 'pending');
  assert.deepEqual(item.stepIds, []);
  assert.equal(item.title, 'write the report');
  assert.equal(item.kind, 'writing');
  assert.equal(item.client, 'desk');
  assert.deepEqual(item.accept, ['the file exists']);
  assert.equal(item.effort, undefined);
  assert.equal(item.createdAt, new Date(item.createdAt).toISOString());

  await rm(root, { recursive: true, force: true });
});

test('inboxAdd defaults kind to task and accept to an empty list', async () => {
  const root = await tempRoot();

  const item = await inboxAdd(root, { title: 'just a title' });

  assert.equal(item.kind, 'task');
  assert.deepEqual(item.accept, []);
  assert.equal(item.body, '');

  await rm(root, { recursive: true, force: true });
});

test('inboxAdd keeps ids monotonic and skips nothing after a failed add', async () => {
  const root = await tempRoot();

  const first = await add(root);
  await assert.rejects(() => inboxAdd(root, { title: '   ' }), TypeError);
  const second = await add(root);

  assert.notEqual(first.id, second.id);
  assert.equal(Number(second.id.slice(1)), Number(first.id.slice(1)) + 1);

  await rm(root, { recursive: true, force: true });
});

test('inboxAdd refuses every invalid field', async () => {
  const root = await tempRoot();

  await assert.rejects(() => inboxAdd(root, { title: '' }), /title/);
  await assert.rejects(() => inboxAdd(root, { title: 42 }), /title/);
  await assert.rejects(() => inboxAdd(root, {}), /title/);
  await assert.rejects(() => inboxAdd(root, { title: 'x', body: 7 }), /body/);
  await assert.rejects(() => inboxAdd(root, { title: 'x', kind: '' }), /kind/);
  await assert.rejects(() => inboxAdd(root, { title: 'x', kind: 3 }), /kind/);
  await assert.rejects(() => inboxAdd(root, { title: 'x', accept: 'one check' }), /accept/);
  await assert.rejects(() => inboxAdd(root, { title: 'x', accept: ['ok', 5] }), /accept/);
  await assert.rejects(() => inboxAdd(root, { title: 'x', accept: [''] }), /accept/);
  await assert.rejects(() => inboxAdd(root, { title: 'x', effort: 'easy' }), /effort/);
  await assert.rejects(() => inboxAdd(root, { title: 'x', ext: 'text' }), /ext/);

  await rm(root, { recursive: true, force: true });
});

test('inboxAdd accepts every known effort and keeps ext', async () => {
  const root = await tempRoot();

  for (const effort of ['simple', 'normal', 'hard']) {
    const item = await add(root, { effort });
    assert.equal(item.effort, effort);
  }
  const coded = await add(root, { kind: 'code', ext: { code: { branch: 'wt' } } });
  assert.deepEqual(coded.ext, { code: { branch: 'wt' } });

  await rm(root, { recursive: true, force: true });
});

test('ten concurrent adds give ten distinct ids', async () => {
  const root = await tempRoot();

  const items = await Promise.all(Array.from({ length: 10 }, () => add(root)));

  const ids = items.map((item) => item.id);
  assert.equal(new Set(ids).size, 10);
  assert.equal((await inboxList(root)).length, 10);

  await rm(root, { recursive: true, force: true });
});

test('inboxList returns every item newest first', async () => {
  const root = await tempRoot();

  await add(root, { title: 'first' });
  await add(root, { title: 'second' });
  const items = await inboxList(root);

  assert.deepEqual(items.map((item) => item.title), ['second', 'first']);

  await rm(root, { recursive: true, force: true });
});

test('inboxList filters by status and by client and honours limit', async () => {
  const root = await tempRoot();

  const mine = await add(root, { title: 'mine', client: 'desk' });
  await add(root, { title: 'theirs', client: 'phone' });
  await add(root, { title: 'last', client: 'desk' });
  await inboxSetStatus(root, mine.id, 'delegated');

  assert.deepEqual((await inboxList(root, { status: 'pending' })).map((i) => i.title), ['last', 'theirs']);
  assert.deepEqual((await inboxList(root, { client: 'desk' })).map((i) => i.title), ['last', 'mine']);
  assert.deepEqual((await inboxList(root, { status: 'delegated' })).map((i) => i.title), ['mine']);
  assert.deepEqual((await inboxList(root, { client: 'desk', status: 'pending' })).map((i) => i.title), ['last']);
  assert.deepEqual((await inboxList(root, { limit: 2 })).map((i) => i.title), ['last', 'theirs']);
  assert.deepEqual(await inboxList(root, { client: 'nobody' }), []);
  assert.deepEqual(await inboxList(root, { limit: 0 }), []);

  await rm(root, { recursive: true, force: true });
});

test('inboxList refuses a filter it cannot honour', async () => {
  const root = await tempRoot();

  await assert.rejects(() => inboxList(root, { status: 'done' }), /status/);
  await assert.rejects(() => inboxList(root, { limit: -1 }), /limit/);
  await assert.rejects(() => inboxList(root, { limit: 1.5 }), /limit/);

  await rm(root, { recursive: true, force: true });
});

test('inboxSetStatus walks the allowed sequence', async () => {
  const root = await tempRoot();
  const item = await add(root);

  for (const status of ['delegated', 'criticised', 'consolidated']) {
    const moved = await inboxSetStatus(root, item.id, status);
    assert.equal(moved.status, status);
  }
  assert.equal((await inboxList(root))[0].status, 'consolidated');

  await rm(root, { recursive: true, force: true });
});

test('inboxSetStatus fails any item and recovers it', async () => {
  const root = await tempRoot();

  for (const start of ['pending', 'delegated', 'criticised']) {
    const item = await add(root);
    if (start !== 'pending') await inboxSetStatus(root, item.id, 'delegated');
    if (start === 'criticised') await inboxSetStatus(root, item.id, 'criticised');

    const failed = await inboxSetStatus(root, item.id, 'failed');
    assert.equal(failed.status, 'failed');
    const back = await inboxSetStatus(root, item.id, 'pending');
    assert.equal(back.status, 'pending');
  }

  await rm(root, { recursive: true, force: true });
});

test('inboxSetStatus refuses unknown ids, unknown statuses and skipped steps', async () => {
  const root = await tempRoot();
  const item = await add(root);
  const final = await add(root);
  for (const status of ['delegated', 'criticised', 'consolidated']) {
    await inboxSetStatus(root, final.id, status);
  }

  await assert.rejects(() => inboxSetStatus(root, 'I999999', 'delegated'), /unknown inbox item/);
  await assert.rejects(() => inboxSetStatus(root, '', 'delegated'), /id/);
  await assert.rejects(() => inboxSetStatus(root, item.id, 'done'), /status/);
  await assert.rejects(() => inboxSetStatus(root, item.id, 'consolidated'), /cannot move/);
  await assert.rejects(() => inboxSetStatus(root, item.id, 'pending'), /cannot move/);
  await assert.rejects(() => inboxSetStatus(root, final.id, 'delegated'), /cannot move/);

  const failed = await inboxSetStatus(root, final.id, 'failed');
  assert.equal(failed.status, 'failed');
  await assert.rejects(() => inboxSetStatus(root, final.id, 'failed'), /cannot move/);

  await rm(root, { recursive: true, force: true });
});

test('inboxSetExt merges into ext, keeps the other keys and refuses bad input', async () => {
  const root = await tempRoot();
  const tagged = await inboxAdd(root, {
    title: 'a run',
    ext: { template: 'sweep', period: '2030-03-05T09:00:00.000Z' },
  });
  const bare = await add(root);

  const merged = await inboxSetExt(root, tagged.id, { template: 'nightly' });
  assert.equal(merged.ext.template, 'nightly');
  assert.equal(merged.ext.period, '2030-03-05T09:00:00.000Z');
  assert.equal(merged.status, tagged.status);
  assert.equal(merged.updatedAt !== undefined, true);

  const gained = await inboxSetExt(root, bare.id, { template: 'nightly' });
  assert.deepEqual(gained.ext, { template: 'nightly' });

  await assert.rejects(() => inboxSetExt(root, 'I999999', { a: 1 }), /unknown inbox item/);
  await assert.rejects(() => inboxSetExt(root, '', { a: 1 }), /id/);
  await assert.rejects(() => inboxSetExt(root, bare.id, 'nope'), /ext values/);
  await assert.rejects(() => inboxSetExt(root, bare.id, ['nope']), /ext values/);

  await rm(root, { recursive: true, force: true });
});
test('inboxAdd stores appliesTo and leaves the global default out', async () => {
  const root = await tempRoot();

  const scoped = await add(root, { appliesTo: 'proj' });
  assert.equal(scoped.appliesTo, 'proj');

  const bare = await add(root);
  assert.equal('appliesTo' in bare, false);

  const explicitGlobal = await add(root, { appliesTo: 'global' });
  assert.equal('appliesTo' in explicitGlobal, false);

  const listed = await add(root, { appliesTo: ['a', 'b'] });
  assert.deepEqual(listed.appliesTo, ['a', 'b']);

  await rm(root, { recursive: true, force: true });
});

test('inboxList filters by appliesTo, keeping the global demands', async () => {
  const root = await tempRoot();

  const bare = await add(root, { title: 'shared' });
  const alpha = await add(root, { title: 'alpha', appliesTo: 'alpha' });
  const multi = await add(root, { title: 'both', appliesTo: ['alpha', 'beta'] });
  await add(root, { title: 'beta only', appliesTo: 'beta' });

  const forAlpha = await inboxList(root, { appliesTo: 'alpha' });
  assert.deepEqual(forAlpha.map((item) => item.title), [multi.title, alpha.title, bare.title]);

  const forBeta = await inboxList(root, { appliesTo: 'beta' });
  assert.deepEqual(forBeta.map((item) => item.title), ['beta only', multi.title, bare.title]);

  const globals = await inboxList(root, { appliesTo: 'global' });
  assert.deepEqual(globals.map((item) => item.title), [bare.title]);

  const unknown = await inboxList(root, { appliesTo: 'nowhere' });
  assert.deepEqual(unknown.map((item) => item.title), [bare.title]);

  const all = await inboxList(root);
  assert.equal(all.length, 4);

  await rm(root, { recursive: true, force: true });
});
