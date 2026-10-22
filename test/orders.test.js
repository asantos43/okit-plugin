import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { orderAdd, orderLint, orderList, orderMigrateProjects, orderPurge, orderRemove, orderRender, orderStatus, purgeAfter } from '../src/orders.js';
import { paths } from '../src/store.js';
import { writeJsonAtomic } from '../src/state.js';

const NOW = '2030-01-01T00:00:00.000Z';
const LATER = '2030-06-01T00:00:00.000Z';
const DAY_MS = 86_400_000;

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'orders-test-'));
}

// The stored rows, read straight from the file, with no derived field added.
async function stored(root) {
  return JSON.parse(await readFile(paths(root).orders, 'utf8')).orders;
}

// One decision line of the purge log of a day, or null when there is none.
async function purgeLines(root, at) {
  const file = join(paths(root).logs, `${new Date(at).toISOString().slice(0, 10)}.jsonl`);
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null) return null;
  return text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
}

// The legacy project-side file of one project, as the old layout wrote it.
async function writeLegacyProjectFile(projectRoot, orders, seq = orders.length) {
  return writeJsonAtomic(join(projectRoot, '.okwork', 'orders.json'), { version: 1, seq, orders });
}

// Must pass / must refuse table:
// | case                        | must pass                     | must refuse                  |
// | orderAdd default            | G1, scope all, active true   | -                            |
// | orderAdd bad text           | -                            | TypeError                    |
// | orderAdd until in the past  | -                            | TypeError                    |
// | orderAdd layer              | -                            | layer is gone: use appliesTo |
// | orderAdd appliesTo          | appliesTo 'proj'             | 'global' with a project      |
// | orderList appliesTo 'proj'  | project + global orders      | -                            |
// | orderRender appliesTo       | "applies to: proj" on screen  | -                            |
// | orderRemove without reason  | -                            | TypeError                    |
// | expiry at the injected now  | inactive after until         | listed before until          |
// | orderStatus                 | active / revoked / expired   | -                            |
// | orderList statuses          | status on a copy, not stored | -                            |
// | second revoke               | -                            | TypeError, first reason kept |
// | render of an inactive order | "revoked: r" / "expired u"   | -                            |
// | orderLint on a revoked row  | no problems                  | -                            |
// | purgeAfter                  | revokedAt/until + retention  | undefined for an active one  |
// | purge inside retention      | row kept, no log line        | -                            |
// | purge at the purge date     | row removed, log line        | -                            |
// | retentionDays broken        | falls back to 90             | -                            |
// | orderMigrateProjects        | moved, file renamed          | skipped on a second run      |

test('orderAdd defaults scope, origin and active', async () => {
  const root = await tempRoot();

  const order = await orderAdd(root, { text: 'keep the docs in step with the code' });

  assert.match(order.id, /^G\d+$/);
  assert.equal(order.scope, 'all');
  assert.equal(order.origin, 'maintainer');
  assert.equal(order.active, true);
  assert.equal(order.until, undefined);
  assert.equal(order.revokedAt, undefined);
  assert.equal(order.createdAt, new Date(order.createdAt).toISOString());
  assert.equal('layer' in order, false);

  await rm(root, { recursive: true, force: true });
});

test('orderAdd keeps ids monotonic and accepts every scope', async () => {
  const root = await tempRoot();

  const first = await orderAdd(root, { text: 'one' });
  const second = await orderAdd(root, { text: 'two', scope: 'effort:hard' });

  assert.equal(Number(second.id.slice(1)), Number(first.id.slice(1)) + 1);
  for (const scope of ['all', 'effort:simple', 'effort:normal', 'effort:hard']) {
    assert.equal((await orderAdd(root, { text: `s ${scope}`, scope })).scope, scope);
  }

  await rm(root, { recursive: true, force: true });
});

test('orderAdd refuses empty text, unknown scope, a layer and a past until', async () => {
  const root = await tempRoot();

  await assert.rejects(() => orderAdd(root, { text: '' }), /text/);
  await assert.rejects(() => orderAdd(root, { text: '   ' }), /text/);
  await assert.rejects(() => orderAdd(root, {}), /text/);
  await assert.rejects(() => orderAdd(root, { text: 'x', scope: 'effort:giant' }), /scope/);
  await assert.rejects(() => orderAdd(root, { text: 'x', until: 'tomorrow' }), /until must be a date/);
  await assert.rejects(() => orderAdd(root, { text: 'x', until: '2020-01-01T00:00:00.000Z' }), /until must be in the future/);
  await assert.rejects(() => orderAdd(root, { text: 'x', origin: 3 }), /origin/);

  // The layer is gone whatever it said, and the caller is told what replaces it.
  for (const layer of ['global', 'project', 'team', '', 3]) {
    await assert.rejects(() => orderAdd(root, { text: 'x', layer }), /layer is gone: use appliesTo/);
  }
  assert.deepEqual(await orderList(root), []);

  await rm(root, { recursive: true, force: true });
});

test('orderAdd takes until in the future and keeps it', async () => {
  const root = await tempRoot();

  const order = await orderAdd(root, { text: 'x', until: LATER });

  assert.equal(order.until, LATER);
  await rm(root, { recursive: true, force: true });
});

test('orderMigrateProjects copies the project rows and parks the old file', async () => {
  const root = await tempRoot();
  const projectRoot = await tempRoot();
  await writeLegacyProjectFile(projectRoot, [
    { id: 'O000001', text: 'only here', scope: 'effort:hard', layer: 'project', active: true, createdAt: NOW, until: LATER },
    { id: 'O000002', text: 'gone', scope: 'all', layer: 'project', active: false, createdAt: NOW, revokedAt: NOW, revokedReason: 'obsolete' },
  ]);

  const result = await orderMigrateProjects(root, projectRoot);

  assert.deepEqual(result, { moved: 2, skipped: 0 });
  const rows = await stored(root);
  assert.deepEqual(rows.map((order) => order.id), ['G000001', 'G000002']);
  assert.equal(rows[0].appliesTo, projectRoot);
  assert.equal(rows[0].origin, 'migrated:project');
  assert.equal(rows[0].scope, 'effort:hard');
  assert.equal(rows[0].until, LATER);
  assert.equal(rows[0].active, true);
  assert.equal(rows[0].createdAt, NOW);
  assert.equal(rows[1].active, false);
  assert.equal(rows[1].revokedAt, NOW);
  assert.equal(rows[1].revokedReason, 'obsolete');
  assert.equal('layer' in rows[0], false);

  // The old file is renamed, never deleted, so the copy is in the global store
  // before the project file moves aside.
  const legacy = join(projectRoot, '.okwork', 'orders.json');
  assert.equal(existsSync(legacy), false);
  const parked = await readFile(`${legacy}.migrated`, 'utf8');
  assert.equal(JSON.parse(parked).orders.length, 2);

  // A second run finds nothing to read and moves nothing.
  assert.deepEqual(await orderMigrateProjects(root, projectRoot), { moved: 0, skipped: 0 });
  assert.deepEqual((await stored(root)).map((order) => order.id), ['G000001', 'G000002']);

  await rm(root, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
});

test('orderMigrateProjects skips a row already there and keeps both stores apart', async () => {
  const root = await tempRoot();
  const first = await tempRoot();
  const second = await tempRoot();
  await orderAdd(root, { text: 'shared words', appliesTo: first });
  await orderAdd(root, { text: 'global only' });
  await writeLegacyProjectFile(first, [
    // Already in the store with this appliesTo: skipped.
    { id: 'O000001', text: 'Shared Words', scope: 'all', layer: 'project', active: true, createdAt: NOW },
    { id: 'O000002', text: 'new here', scope: 'all', layer: 'project', active: true, createdAt: NOW },
  ]);
  await writeLegacyProjectFile(second, [{ id: 'O000001', text: 'same words elsewhere', scope: 'all', layer: 'project', active: true, createdAt: NOW }]);

  const result = await orderMigrateProjects(root, [first, second]);

  assert.deepEqual(result, { moved: 2, skipped: 1 });
  const rows = await stored(root);
  assert.equal(rows.length, 4);
  const copied = rows.filter((order) => order.origin === 'migrated:project');
  assert.deepEqual(copied.map((order) => [order.text, order.appliesTo]), [
    ['new here', first],
    ['same words elsewhere', second],
  ]);
  assert.deepEqual(copied.map((order) => order.id), ['G000003', 'G000004']);

  // The migrated row reads as the project it came from, and a project filter
  // still brings the shared orders along.
  const forFirst = await orderList(root, { appliesTo: first });
  assert.deepEqual(forFirst.map((order) => order.text), ['shared words', 'global only', 'new here']);
  const onlyFirst = await orderList(root, { appliesTo: 'global' });
  assert.deepEqual(onlyFirst.map((order) => order.text), ['global only']);

  await rm(root, { recursive: true, force: true });
  await rm(first, { recursive: true, force: true });
  await rm(second, { recursive: true, force: true });
});

test('orderMigrateProjects without a file moves nothing and creates nothing', async () => {
  const root = await tempRoot();
  const projectRoot = await tempRoot();

  assert.deepEqual(await orderMigrateProjects(root, projectRoot), { moved: 0, skipped: 0 });
  assert.deepEqual(await orderMigrateProjects(root, undefined), { moved: 0, skipped: 0 });
  assert.equal(existsSync(paths(root).orders), false);

  // An old caller whose project has no file is still answered, and nothing is
  // written on either side.
  await orderAdd(root, { text: 'plain' });
  assert.deepEqual((await orderList(root, {}, { projectRoot })).map((order) => order.text), ['plain']);
  assert.deepEqual(await orderMigrateProjects(root, projectRoot), { moved: 0, skipped: 0 });
  assert.equal(existsSync(join(projectRoot, '.okwork')), false);

  await rm(root, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
});

test('orderList migrates the old project file when a projectRoot is given', async () => {
  const root = await tempRoot();
  const projectRoot = await tempRoot();
  await orderAdd(root, { text: 'global one' });
  await writeLegacyProjectFile(projectRoot, [{ id: 'O000001', text: 'project one', scope: 'all', layer: 'project', active: true, createdAt: NOW }]);

  const listed = await orderList(root, {}, { projectRoot });

  assert.deepEqual(listed.map((order) => order.text), ['global one', 'project one']);
  assert.deepEqual(listed.map((order) => order.status), ['active', 'active']);

  await rm(root, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
});

test('orderAdd with a projectRoot migrates first and then writes one global store', async () => {
  const root = await tempRoot();
  const projectRoot = await tempRoot();
  await writeLegacyProjectFile(projectRoot, [{ id: 'O000001', text: 'old project order', scope: 'all', layer: 'project', active: true, createdAt: NOW }]);

  const added = await orderAdd(root, { text: 'fresh order' }, { projectRoot });

  assert.match(added.id, /^G\d+$/);
  assert.equal(added.appliesTo, undefined);
  assert.deepEqual((await stored(root)).map((order) => order.text), ['old project order', 'fresh order']);
  assert.equal(existsSync(join(projectRoot, '.okwork', 'orders.json')), false);

  await rm(root, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
});

test('orderList hides an order past its until and honours activeOnly false', async () => {
  const root = await tempRoot();

  const lasting = await orderAdd(root, { text: 'lasting', until: LATER });
  await orderAdd(root, { text: 'expiring', until: '2030-03-01T00:00:00.000Z' });
  const gone = await orderAdd(root, { text: 'gone' });
  await orderRemove(root, gone.id, { reason: 'not wanted' });

  const before = await orderList(root, { now: NOW });
  assert.deepEqual(before.map((order) => order.text), ['lasting', 'expiring']);

  const after = await orderList(root, { now: '2030-04-01T00:00:00.000Z' });
  assert.deepEqual(after.map((order) => order.text), ['lasting']);
  assert.equal(after[0].id, lasting.id);

  const all = await orderList(root, { activeOnly: false, now: '2031-01-01T00:00:00.000Z' });
  assert.deepEqual(all.map((order) => order.text), ['lasting', 'expiring', 'gone']);

  await rm(root, { recursive: true, force: true });
});

test('orderList refuses an unreadable now or activeOnly', async () => {
  const root = await tempRoot();

  await assert.rejects(() => orderList(root, { now: 'soon' }), /now/);
  await assert.rejects(() => orderList(root, { activeOnly: 'yes' }), /activeOnly/);

  await rm(root, { recursive: true, force: true });
});

test('orderRemove needs a reason and keeps the history', async () => {
  const root = await tempRoot();
  const order = await orderAdd(root, { text: 'revoke me' });

  await assert.rejects(() => orderRemove(root, order.id), /reason/);
  await assert.rejects(() => orderRemove(root, order.id, { reason: '  ' }), /reason/);
  await assert.rejects(() => orderRemove(root, '', { reason: 'because' }), /id/);

  const revoked = await orderRemove(root, order.id, { reason: 'obsolete' });

  assert.equal(revoked.id, order.id);
  assert.equal(revoked.active, false);
  assert.equal(revoked.revokedReason, 'obsolete');
  assert.equal(revoked.revokedAt, new Date(revoked.revokedAt).toISOString());
  assert.deepEqual(await orderList(root), []);
  const history = await orderList(root, { activeOnly: false });
  assert.equal(history.length, 1);
  assert.equal(history[0].text, 'revoke me');

  await rm(root, { recursive: true, force: true });
});

test('orderRemove revokes a migrated order and refuses an unknown id', async () => {
  const root = await tempRoot();
  const projectRoot = await tempRoot();
  await writeLegacyProjectFile(projectRoot, [{ id: 'O000001', text: 'project order', scope: 'all', layer: 'project', active: true, createdAt: NOW }]);
  const [migrated] = await orderList(root, {}, { projectRoot });

  await assert.rejects(() => orderRemove(root, 'O000001', { reason: 'nope' }), /unknown standing order/);

  const revoked = await orderRemove(root, migrated.id, { reason: 'moved' });
  assert.equal(revoked.active, false);
  assert.deepEqual(await orderList(root, { activeOnly: false }).then((all) => all.filter((order) => order.status === 'active')), []);

  await rm(root, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
});

test('orderLint finds an active order past its until', async () => {
  const root = await tempRoot();

  await orderAdd(root, { text: 'expiring', until: '2030-03-01T00:00:00.000Z' });

  const clean = await orderLint(root, { now: NOW });
  assert.deepEqual(clean, []);

  const problems = await orderLint(root, { now: '2030-04-01T00:00:00.000Z' });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].code, 'expired-active');
  assert.equal(problems[0].id, 'G000001');

  await rm(root, { recursive: true, force: true });
});

test('orderLint finds two active orders with the same text', async () => {
  const root = await tempRoot();

  await orderAdd(root, { text: 'Same words' });
  await orderAdd(root, { text: 'same WORDS' });

  const problems = await orderLint(root, { now: NOW });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].code, 'duplicate-active-text');

  await rm(root, { recursive: true, force: true });
});

test('orderLint finds a repeated id in the store', async () => {
  const root = await tempRoot();

  const first = await orderAdd(root, { text: 'one' });
  await orderAdd(root, { text: 'two' });
  const rows = await stored(root);
  rows[1].id = first.id;
  await writeJsonAtomic(paths(root).orders, { version: 1, seq: 2, orders: rows });

  const problems = await orderLint(root, { now: NOW });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].code, 'duplicate-id');

  await rm(root, { recursive: true, force: true });
});

test('orderLint finds empty text, an unknown scope and a bad date', async () => {
  const root = await tempRoot();

  await writeJsonAtomic(join(root, 'orders.json'), {
    version: 1,
    seq: 1,
    orders: [
      { id: 'G000001', text: '', scope: 'all', active: true, createdAt: NOW },
      { id: 'G000002', text: 'scope', scope: 'effort:giant', active: true, createdAt: NOW },
      { id: 'G000003', text: 'until', scope: 'all', active: true, createdAt: NOW, until: 'soon' },
    ],
  });

  const problems = await orderLint(root, { now: NOW });

  assert.deepEqual(
    problems.map((problem) => problem.code).sort(),
    ['bad-date', 'empty-text', 'unknown-scope'],
  );
  await rm(root, { recursive: true, force: true });
});

test('orderRender lists id, date, text and expiry', () => {
  const rendered = orderRender([
    { id: 'G000001', text: 'first order', scope: 'all', active: true, createdAt: NOW },
    {
      id: 'G000002',
      text: 'second order',
      scope: 'effort:hard',
      active: false,
      createdAt: NOW,
      until: LATER,
      revokedReason: 'obsolete',
    },
  ]);

  const lines = rendered.split('\n');
  assert.equal(lines[0], '# Standing orders');
  assert.match(lines[2], /^- \*\*G000001\*\* \(2030-01-01T00:00:00.000Z\) first order$/);
  assert.match(lines[3], /^- \*\*G000002\*\* \(2030-01-01T00:00:00.000Z\) second order — scope `effort:hard` — until 2030-06-01T00:00:00.000Z — revoked: obsolete$/);
  assert.equal(lines.at(-1), '');
});

test('orderRender says so when there is nothing and refuses other input', () => {
  assert.match(orderRender([]), /^# Standing orders\n\nNone\.\n$/);
  assert.throws(() => orderRender('orders'), TypeError);
});
test('orderAdd stores appliesTo and leaves the global default out', async () => {
  const root = await tempRoot();

  const scoped = await orderAdd(root, { text: 'keep the api in step', appliesTo: 'proj' });
  assert.equal(scoped.appliesTo, 'proj');

  const bare = await orderAdd(root, { text: 'write the changelog' });
  assert.equal('appliesTo' in bare, false);

  const explicitGlobal = await orderAdd(root, { text: 'label the releases', appliesTo: 'global' });
  assert.equal('appliesTo' in explicitGlobal, false);

  const listed = await orderAdd(root, { text: 'watch both deploys', appliesTo: ['proj', 'docs'] });
  assert.deepEqual(listed.appliesTo, ['proj', 'docs']);

  await rm(root, { recursive: true, force: true });
});

test('orderList filters by appliesTo, keeping the global orders', async () => {
  const root = await tempRoot();

  await orderAdd(root, { text: 'shared one' });
  await orderAdd(root, { text: 'shared two', appliesTo: 'global' });
  await orderAdd(root, { text: 'alpha one', appliesTo: 'alpha' });
  await orderAdd(root, { text: 'alpha and beta', appliesTo: ['alpha', 'beta'] });
  await orderAdd(root, { text: 'beta one', appliesTo: 'beta' });

  const forAlpha = await orderList(root, { appliesTo: 'alpha' });
  assert.deepEqual(forAlpha.map((order) => order.text), ['shared one', 'shared two', 'alpha one', 'alpha and beta']);

  const globals = await orderList(root, { appliesTo: 'global' });
  assert.deepEqual(globals.map((order) => order.text), ['shared one', 'shared two']);

  const every = await orderList(root);
  assert.equal(every.length, 5);

  await rm(root, { recursive: true, force: true });
});

test('orderRender shows applies to only when the order names a project', () => {
  const scoped = orderRender([{ id: 'G000001', text: 'one', appliesTo: 'proj', active: true }]);
  assert.match(scoped, /^- \*\*G000001\*\* one — applies to: proj$/m);

  const many = orderRender([{ id: 'G000002', text: 'two', appliesTo: ['a', 'b'], active: true }]);
  assert.match(many, /^- \*\*G000002\*\* two — applies to: a, b$/m);

  const bare = orderRender([{ id: 'G000003', text: 'three', active: true }]);
  assert.match(bare, /^- \*\*G000003\*\* three$/m);
});

test('orderStatus derives active, revoked and expired from the row', () => {
  const lasting = { id: 'G000001', text: 'lasting', active: true, until: LATER };

  assert.equal(orderStatus({ id: 'G000002', text: 'plain', active: true }), 'active');
  assert.equal(orderStatus({ ...lasting }, '2030-05-31T23:59:59.999Z'), 'active');
  assert.equal(orderStatus({ ...lasting }, '2030-06-01T00:00:00.000Z'), 'expired');
  assert.equal(orderStatus({ id: 'G000003', text: 'gone', active: false, until: LATER }), 'revoked');
  // A row without until never expires, and a missing active flag is not active.
  assert.equal(orderStatus({ id: 'G000004', text: 'no until', active: true }), 'active');
  assert.equal(orderStatus({ id: 'G000005', text: 'hand written' }), 'revoked');

  assert.throws(() => orderStatus({ active: true }, 'soon'), TypeError);
});

test('orderList adds the status to a copy and never to the stored row', async () => {
  const root = await tempRoot();

  await orderAdd(root, { text: 'lasting', until: LATER });
  await orderAdd(root, { text: 'expiring', until: '2030-03-01T00:00:00.000Z' });
  const gone = await orderAdd(root, { text: 'gone' });
  await orderRemove(root, gone.id, { reason: 'not wanted' });

  const all = await orderList(root, { activeOnly: false, now: '2030-04-01T00:00:00.000Z' });

  assert.deepEqual(all.map((order) => order.status), ['active', 'expired', 'revoked']);
  // The active filter still means "the status is active".
  const live = await orderList(root, { now: '2030-04-01T00:00:00.000Z' });
  assert.deepEqual(live.map((order) => order.text), ['lasting']);

  const onDisk = await stored(root);
  for (const order of onDisk) {
    assert.equal('status' in order, false);
    assert.equal('purgeAfter' in order, false);
    assert.equal(order.active, onDisk.find((row) => row.id === order.id).active);
  }

  await rm(root, { recursive: true, force: true });
});

test('orderList gives an inactive row a purge date and an active row none', async () => {
  const root = await tempRoot();

  await orderAdd(root, { text: 'lasting', until: LATER });
  const gone = await orderAdd(root, { text: 'gone' });
  const revoked = await orderRemove(root, gone.id, { reason: 'not wanted' });

  const [active, inactive] = await orderList(root, { activeOnly: false });

  assert.equal(active.purgeAfter, undefined);
  assert.equal(inactive.purgeAfter, purgeAfter(revoked, 90));

  await rm(root, { recursive: true, force: true });
});

test('a second revoke is refused and the first reason survives', async () => {
  const root = await tempRoot();
  const order = await orderAdd(root, { text: 'revoke once' });

  const first = await orderRemove(root, order.id, { reason: 'obsolete' });

  await assert.rejects(
    () => orderRemove(root, order.id, { reason: 'changed my mind' }),
    /standing order G\d+ is already revoked/,
  );

  const [row] = await stored(root);
  assert.equal(row.revokedAt, first.revokedAt);
  assert.equal(row.revokedReason, 'obsolete');
  assert.equal(row.active, false);

  await rm(root, { recursive: true, force: true });
});

test('orderRender says revoked with the reason and expired with the until', () => {
  const revoked = orderRender([{ id: 'G000001', text: 'one', active: false, revokedReason: 'obsolete' }]);
  assert.match(revoked, /^- \*\*G000001\*\* one — revoked: obsolete$/m);

  const bare = orderRender([{ id: 'G000002', text: 'two', active: false }]);
  assert.match(bare, /^- \*\*G000002\*\* two — revoked$/m);

  const expired = orderRender([
    { id: 'G000003', text: 'three', active: true, until: '2020-01-01T00:00:00.000Z' },
  ]);
  assert.match(expired, /^- \*\*G000003\*\* three — until 2020-01-01T00:00:00.000Z — expired 2020-01-01T00:00:00.000Z$/m);

  // A listed order brings its status with it, so the clock of the caller does
  // not decide what the view says.
  const listed = orderRender([{ id: 'G000004', text: 'four', active: true, until: LATER, status: 'expired' }]);
  assert.match(listed, /— expired 2030-06-01T00:00:00.000Z$/m);
});

test('orderLint passes on revoked and expired rows', async () => {
  const root = await tempRoot();

  const gone = await orderAdd(root, { text: 'gone' });
  await orderRemove(root, gone.id, { reason: 'obsolete' });
  await orderAdd(root, { text: 'expiring', until: '2030-03-01T00:00:00.000Z' });

  assert.deepEqual(await orderLint(root, { now: NOW }), []);
  // An expired row that is still flagged active is the one lint reports.
  assert.deepEqual((await orderLint(root, { now: '2030-04-01T00:00:00.000Z' })).map((p) => p.code), ['expired-active']);

  await rm(root, { recursive: true, force: true });
});

test('purgeAfter counts the retention from the revocation or from the until', () => {
  const revoked = { id: 'G000001', text: 'gone', active: false, revokedAt: '2030-01-01T00:00:00.000Z' };
  const expired = { id: 'G000002', text: 'old', active: true, until: '2030-01-01T00:00:00.000Z' };

  assert.equal(purgeAfter(revoked, 10, '2030-01-01T00:00:00.000Z'), '2030-01-11T00:00:00.000Z');
  assert.equal(purgeAfter(expired, 10, '2030-01-01T00:00:00.000Z'), '2030-01-11T00:00:00.000Z');
  assert.equal(purgeAfter(revoked, 0, '2030-01-01T00:00:00.000Z'), '2030-01-01T00:00:00.000Z');
  assert.equal(purgeAfter({ ...revoked, revokedAt: 'whenever' }, 10, NOW), undefined);

  // An active order has nothing to purge, and the default is 90 days.
  assert.equal(purgeAfter({ id: 'G000003', text: 'live', active: true }, 10, NOW), undefined);
  assert.equal(purgeAfter(revoked, undefined, '2030-01-01T00:00:00.000Z'), '2030-04-01T00:00:00.000Z');
});

test('orderPurge removes only the inactive rows whose purge date arrived', async () => {
  const root = await tempRoot();

  const rows = [
    { id: 'G000001', text: 'live', scope: 'all', active: true, createdAt: NOW },
    { id: 'G000002', text: 'revoked', scope: 'all', active: false, createdAt: NOW, revokedAt: '2030-01-01T00:00:00.000Z', revokedReason: 'obsolete' },
    { id: 'G000003', text: 'expired', scope: 'all', active: true, createdAt: NOW, until: '2030-01-01T00:00:00.000Z' },
    { id: 'G000004', text: 'migrated gone', scope: 'all', origin: 'migrated:project', appliesTo: '/tmp/whatever', active: false, createdAt: NOW, revokedAt: '2030-01-01T00:00:00.000Z', revokedReason: 'moved' },
  ];
  await writeJsonAtomic(paths(root).orders, { version: 1, seq: 4, orders: rows });

  // One millisecond before the purge date nothing goes.
  const early = await orderPurge(root, { now: '2030-01-10T23:59:59.999Z', retentionDays: 10 });
  assert.deepEqual(early, []);
  assert.deepEqual((await stored(root)).map((row) => row.id), ['G000001', 'G000002', 'G000003', 'G000004']);
  assert.equal(await purgeLines(root, '2030-01-10T23:59:59.999Z'), null);

  // On the purge date every inactive row goes, migrated ones included, and the
  // live one stays.
  const at = '2030-01-11T00:00:00.000Z';
  const purged = await orderPurge(root, { now: at, retentionDays: 10 });

  assert.deepEqual(purged.map((row) => [row.id, row.status, row.text]).sort(), [
    ['G000002', 'revoked', 'revoked'],
    ['G000003', 'expired', 'expired'],
    ['G000004', 'revoked', 'migrated gone'],
  ]);
  assert.equal(purged[0].purgedAt, at);
  assert.deepEqual((await stored(root)).map((row) => row.id), ['G000001']);

  const lines = await purgeLines(root, at);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].at, at);
  assert.deepEqual(lines[0].purged, ['G000002', 'G000003', 'G000004']);

  // A second pass finds nothing left and writes no line.
  assert.deepEqual(await orderPurge(root, { now: at, retentionDays: 10 }), []);
  assert.equal((await purgeLines(root, at)).length, 1);

  await rm(root, { recursive: true, force: true });
});

test('orderPurge with retentionDays 0 removes an inactive row at once', async () => {
  const root = await tempRoot();

  await writeJsonAtomic(paths(root).orders, {
    version: 1,
    seq: 2,
    orders: [
      { id: 'G000001', text: 'live', scope: 'all', active: true, createdAt: NOW },
      { id: 'G000002', text: 'gone', scope: 'all', active: false, createdAt: NOW, revokedAt: '2030-01-01T00:00:00.000Z', revokedReason: 'obsolete' },
    ],
  });

  const at = '2030-01-01T00:00:00.000Z';
  const purged = await orderPurge(root, { now: at, retentionDays: 0 });

  assert.deepEqual(purged.map((row) => row.id), ['G000002']);
  assert.deepEqual((await stored(root)).map((row) => row.id), ['G000001']);

  await rm(root, { recursive: true, force: true });
});

test('orderPurge reads orders.retentionDays from the config and falls back on a broken value', async () => {
  const root = await tempRoot();
  const revokedAt = '2030-01-01T00:00:00.000Z';
  const row = (id) => ({ id, text: id, scope: 'all', active: false, createdAt: NOW, revokedAt, revokedReason: 'obsolete' });
  const seed = () => writeJsonAtomic(paths(root).orders, { version: 1, seq: 2, orders: [row('G000001'), row('G000002')] });

  await writeJsonAtomic(paths(root).config, { orders: { retentionDays: 30 } });
  await seed();
  // Both rows were revoked 31 days ago, so both are past a 30 day window.
  assert.deepEqual(
    (await orderPurge(root, { now: '2030-02-01T00:00:00.000Z' })).map((r) => r.id),
    ['G000001', 'G000002'],
  );

  // A broken value never stops the reader: the default of 90 days answers.
  for (const broken of ['90 days', -1, 4.5, null]) {
    await writeJsonAtomic(paths(root).config, { orders: { retentionDays: broken } });
    await seed();
    assert.deepEqual(await orderPurge(root, { now: '2030-02-01T00:00:00.000Z' }), []);
    assert.deepEqual((await orderList(root, { activeOnly: false }))[0].purgeAfter, '2030-04-01T00:00:00.000Z');
  }

  // A missing config answers the same way.
  await rm(paths(root).config, { force: true });
  await seed();
  assert.deepEqual((await orderList(root, { activeOnly: false }))[0].purgeAfter, '2030-04-01T00:00:00.000Z');

  await rm(root, { recursive: true, force: true });
});

test('orderPurge leaves a root without orders alone', async () => {
  const root = await tempRoot();

  assert.deepEqual(await orderPurge(root, { now: NOW }), []);
  assert.equal(await purgeLines(root, NOW), null);

  await rm(root, { recursive: true, force: true });
});
