import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { inboxAdd, inboxList, inboxSetStatus } from '../src/inbox.js';
import { orderList } from '../src/orders.js';
import { paths } from '../src/store.js';
import {
  due, openDue, plan, templateAdd, templateList, templateRemove, templateSet,
} from '../src/templates.js';

// Fixed instants: the slot of every case is 2030-03-05T09:00:00.000Z.
const SLOT = Date.parse('2030-03-05T09:00:00.000Z');
const SLOT_DAY = Date.parse('2030-03-05T12:00:00.000Z');
const NEXT_DAY = Date.parse('2030-03-06T09:00:00.000Z');
const BEFORE_SLOT = Date.parse('2030-03-05T08:00:00.000Z');
const OUTSIDE_WINDOW = Date.parse('2030-03-05T19:00:00.000Z');

const DAILY = 'daily 09:00';

const DEMAND = { title: 'check the inbox', kind: 'review', accept: ['no pending demand'] };

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'templates-test-'));
}

// A fresh root with one daily template, ready for the slot.
async function seeded(input = {}) {
  const root = await tempRoot();
  await templateAdd(root, { name: 'sweep', schedule: DAILY, demand: DEMAND, ...input });
  return root;
}

const files = async (root) => Promise.all([
  readFile(paths(root).templates),
  readFile(paths(root).inbox).catch(() => null),
]);

// The inbox only moves pending -> delegated -> criticised -> consolidated.
async function consolidate(root, id) {
  for (const status of ['delegated', 'criticised', 'consolidated']) {
    await inboxSetStatus(root, id, status);
  }
}

// Must pass / must refuse table:
// | case                          | must pass                       | must refuse                  |
// | templateAdd defaults          | catchup run, zone UTC, idle off | -                            |
// | templateAdd twice on one name | -                              | TypeError on the name        |
// | templateAdd bad schedule      | -                              | TypeError from parseSchedule |
// | templateAdd no demand.title   | -                              | TypeError on the title       |
// | templateAdd                    | active order, origin template: | -                            |
// | templateRemove                | order revoked with a reason    | unknown name is a TypeError  |
// | templateSet paused            | decision skip                  | -                            |
// | templateSet unknown field     | -                              | TypeError                    |
// | due at the slot               | due true, action run           | -                            |
// | due before the slot           | due false, action defer        | -                            |
// | due with a quota floor        | defer below the floor          | -                            |
// | due with an open child        | skip, not due                  | -                            |
// | due with runs at the cap      | skip, not due                  | -                            |
// | plan                          | one demand, no file changes    | -                            |
// | openDue twice in a period     | one child, one id              | -                            |
// | event without ctx.eventId     | skip, period null, opens none  | -                            |
// | event with ids 41 then 42     | one child per id                | -                            |
// | rename with a child open      | ext.template moved, guard kept | -                            |

test('templateAdd stores the template and the standing order that allows it', async () => {
  const root = await tempRoot();

  const { template, order } = await templateAdd(root, {
    name: 'sweep', schedule: DAILY, demand: DEMAND,
  });

  assert.equal(template.name, 'sweep');
  assert.equal(template.schedule, DAILY);
  assert.equal(template.timeZone, 'UTC');
  assert.equal(template.catchup, 'run');
  assert.equal(template.skipIfOpen, true);
  assert.equal(template.onlyWhenIdle, false);
  assert.equal(template.paused, false);
  assert.deepEqual(template.demand, DEMAND);

  assert.equal(order.origin, 'template:sweep');
  assert.equal(order.active, true);
  const orders = await orderList(root);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].text, order.text);

  const listed = await templateList(root);
  assert.equal(listed.length, 1);
  assert.equal((await templateList(root, { name: 'sweep' })).name, 'sweep');

  await rm(root, { recursive: true, force: true });
});

test('templateAdd refuses a repeated name and an invalid field', async () => {
  const root = await seeded();

  await assert.rejects(() => templateAdd(root, { name: 'sweep', schedule: DAILY, demand: DEMAND }),
    /already exists/);
  await assert.rejects(() => templateAdd(root, { name: '', schedule: DAILY, demand: DEMAND }), /name/);
  await assert.rejects(() => templateAdd(root, { name: 'x', schedule: 'sometimes', demand: DEMAND }),
    /Cannot parse schedule/);
  await assert.rejects(() => templateAdd(root, { name: 'x', schedule: DAILY }), /demand/);
  await assert.rejects(() => templateAdd(root, { name: 'x', schedule: DAILY, demand: { kind: 'code' } }),
    /demand.title/);
  await assert.rejects(() => templateAdd(root, { name: 'x', schedule: DAILY, demand: DEMAND, catchup: 'later' }),
    /catchup/);
  await assert.rejects(() => templateAdd(root, { name: 'x', schedule: DAILY, demand: DEMAND, maxRunsPerPeriod: 1.5 }),
    /maxRunsPerPeriod/);
  await assert.rejects(() => templateAdd(root, { name: 'x', schedule: DAILY, demand: DEMAND, timeZone: 'Mars/Base' }),
    /timeZone/);
  await assert.rejects(() => templateAdd(root, { name: 'x', schedule: DAILY, demand: DEMAND, window: { from: '9' } }),
    /window.to/);

  await rm(root, { recursive: true, force: true });
});

test('templateRemove drops the template and revokes its order with a reason', async () => {
  const root = await seeded();

  const { template, revoked } = await templateRemove(root, 'sweep');

  assert.equal(template.name, 'sweep');
  assert.equal(revoked.length, 1);
  assert.deepEqual(await templateList(root), []);
  assert.deepEqual(await orderList(root), []);
  const [history] = await orderList(root, { activeOnly: false });
  assert.equal(history.active, false);
  assert.match(history.revokedReason, /sweep/);

  await assert.rejects(() => templateRemove(root, 'sweep'), /unknown template/);
  await rm(root, { recursive: true, force: true });
});

test('templateSet pauses and resumes and refuses an unknown field', async () => {
  const root = await seeded();

  const paused = (await templateSet(root, 'sweep', { paused: true })).template;
  assert.equal(paused.paused, true);
  assert.equal((await due(root, SLOT_DAY, {}))[0].action, 'skip');

  assert.equal((await templateSet(root, 'sweep', { paused: false })).template.paused, false);
  assert.equal((await due(root, SLOT_DAY, {}))[0].due, true);

  await assert.rejects(() => templateSet(root, 'sweep', { nope: 1 }), /unknown template field nope/);
  await assert.rejects(() => templateSet(root, 'ghost', { paused: true }), /unknown template ghost/);
  await rm(root, { recursive: true, force: true });
});

test('due is due at the slot, not before it and not after it ran', async () => {
  const root = await seeded();

  const before = await due(root, BEFORE_SLOT, {});
  assert.equal(before[0].due, false);
  assert.equal(before[0].action, 'defer');
  assert.equal(before[0].name, 'sweep');

  const onSlot = await due(root, SLOT, {});
  assert.equal(onSlot[0].due, true);
  assert.equal(onSlot[0].action, 'run');
  assert.equal(onSlot[0].period, new Date(SLOT).toISOString());

  await openDue(root, SLOT, {});
  const after = await due(root, SLOT_DAY, {});
  assert.equal(after[0].due, false);
  assert.equal(after[0].action, 'defer');

  await rm(root, { recursive: true, force: true });
});

test('due defers inside a window and skips while a child is open', async () => {
  const root = await seeded({ window: { from: '10:00', to: '18:00' } });

  const outside = await due(root, OUTSIDE_WINDOW, {});
  assert.equal(outside[0].due, false);
  assert.match(outside[0].reason, /outside the window/);
  assert.equal(outside[0].period, new Date(SLOT).toISOString());
  assert.equal((await due(root, SLOT_DAY, {}))[0].due, true);

  await templateSet(root, 'sweep', { window: null });
  await openDue(root, SLOT, {});
  // The next day brings a new period, but the child of the first is still open.
  const open = await due(root, NEXT_DAY, {});
  assert.equal(open[0].due, false);
  assert.equal(open[0].action, 'skip');
  assert.match(open[0].reason, /already open/);
  assert.equal(open[0].period, new Date(NEXT_DAY).toISOString());

  // Once consolidated it stops blocking, and the skipped period is still owed.
  await consolidate(root, (await inboxList(root))[0].id);
  assert.equal((await due(root, NEXT_DAY, {}))[0].due, true);

  await rm(root, { recursive: true, force: true });
});

test('due skips at the per-period cap and defers below the quota floor', async () => {
  // One child for this period already exists, so the cap is what holds it back.
  const capped = await seeded({ maxRunsPerPeriod: 1, skipIfOpen: false });
  await inboxAdd(capped, {
    title: DEMAND.title,
    ext: { template: 'sweep', period: new Date(SLOT).toISOString() },
  });
  const cappedDecision = (await due(capped, SLOT, {}))[0];
  assert.equal(cappedDecision.due, false);
  assert.equal(cappedDecision.action, 'skip');
  assert.match(cappedDecision.reason, /maximum number of runs/);
  assert.deepEqual((await openDue(capped, SLOT, {})).ids, []);
  await rm(capped, { recursive: true, force: true });

  const quota = await seeded({ minQuotaPct: 40 });
  const low = (await due(quota, SLOT, { quotaPct: 10 }))[0];
  assert.equal(low.due, false);
  assert.match(low.reason, /quota is below/);
  assert.equal((await due(quota, SLOT, { quotaPct: 80 }))[0].due, true);
  await rm(quota, { recursive: true, force: true });
});

test('plan reports the demands it would open and writes nothing', async () => {
  const root = await seeded({ demand: { ...DEMAND, ext: { board: 'inbox' } } });
  const before = await files(root);

  const { decisions, demands } = await plan(root, SLOT, {});

  assert.equal(decisions[0].due, true);
  assert.deepEqual(demands, [{
    ...DEMAND,
    ext: { board: 'inbox', template: 'sweep', period: new Date(SLOT).toISOString() },
  }]);
  assert.deepEqual(await files(root), before);

  await rm(root, { recursive: true, force: true });
});

test('openDue opens one child per period and stamps the template', async () => {
  const root = await seeded();

  const first = await openDue(root, SLOT, {});
  assert.equal(first.ids.length, 1);
  assert.equal(first.decisions[0].due, true);

  const items = await inboxList(root);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, DEMAND.title);
  assert.equal(items[0].kind, DEMAND.kind);
  assert.deepEqual(items[0].accept, DEMAND.accept);
  assert.equal(items[0].ext.template, 'sweep');
  assert.equal(items[0].ext.period, new Date(SLOT).toISOString());
  assert.equal(items[0].status, 'pending');
  assert.equal((await templateList(root, { name: 'sweep' })).lastRun, SLOT);

  const second = await openDue(root, SLOT_DAY, {});
  assert.deepEqual(second.ids, []);
  assert.equal((await inboxList(root)).length, 1);

  await consolidate(root, items[0].id);
  const next = await openDue(root, NEXT_DAY, {});
  assert.equal(next.ids.length, 1);
  assert.equal((await inboxList(root)).length, 2);

  await rm(root, { recursive: true, force: true });
});

test('eight parallel openDue calls open a single child', async () => {
  const root = await seeded();

  const results = await Promise.all(Array.from({ length: 8 }, () => openDue(root, SLOT, {})));
  const ids = results.flatMap((result) => result.ids);

  assert.equal(ids.length, 1);
  assert.equal((await inboxList(root)).length, 1);

  await rm(root, { recursive: true, force: true });
});

test('openDue catches up the slot of a missed day and skip ignores it', async () => {
  const root = await seeded({ catchup: 'run' });
  await consolidate(root, (await openDue(root, SLOT, {})).ids[0]);
  // Two days later the 06th never ran, so it is still owed.
  const late = Date.parse('2030-03-07T07:00:00.000Z');
  const missed = new Date(Date.parse('2030-03-06T09:00:00.000Z')).toISOString();

  const caught = await openDue(root, late, {});
  assert.equal(caught.ids.length, 1);
  assert.equal(caught.decisions[0].period, missed);
  assert.equal((await inboxList(root))[0].ext.period, missed);
  assert.deepEqual((await openDue(root, late, {})).ids, []);

  await consolidate(root, caught.ids[0]);
  // Two more days went by, so skipping the missed slots runs the current
  // period, which is the last slot already past: the 08th, not the 09th.
  await templateSet(root, 'sweep', { catchup: 'skip' });
  const skipped = await openDue(root, Date.parse('2030-03-09T07:00:00.000Z'), {});
  assert.equal(skipped.ids.length, 1);
  assert.equal(skipped.decisions[0].period, new Date(Date.parse('2030-03-08T09:00:00.000Z')).toISOString());

  await rm(root, { recursive: true, force: true });
});

test('a template without history waits for the slot of the current day', async () => {
  const root = await seeded();

  const decision = (await due(root, Date.parse('2030-03-06T07:00:00.000Z'), {}))[0];

  assert.equal(decision.due, false);
  assert.match(decision.reason, /first slot of this period has not arrived yet/);

  await rm(root, { recursive: true, force: true });
});

test('openDue refuses to open while the template is paused', async () => {
  const root = await seeded({ paused: true });

  const result = await openDue(root, SLOT, {});

  assert.deepEqual(result.ids, []);
  assert.equal(result.decisions[0].action, 'skip');
  assert.equal((await inboxList(root)).length, 0);

  await rm(root, { recursive: true, force: true });
});

test('an event template opens one child per event id, and none without one', async () => {
  const root = await seeded({ schedule: 'after each deploy', skipIfOpen: false });

  const idle = (await due(root, SLOT, {}))[0];
  assert.equal(idle.due, false);
  assert.equal(idle.action, 'defer');
  assert.match(idle.reason, /waits for its event/);

  // The event fired but nothing says which firing it is, so nothing opens.
  const blind = await due(root, SLOT, { eventName: 'deploy' });
  assert.equal(blind[0].due, false);
  assert.equal(blind[0].action, 'skip');
  assert.equal(blind[0].period, null);
  assert.match(blind[0].reason, /an event needs an id/);
  assert.deepEqual((await openDue(root, SLOT, { eventName: 'deploy' })).ids, []);
  assert.equal((await inboxList(root)).length, 0);

  const first = await openDue(root, SLOT, { eventName: 'deploy', eventId: 41 });
  assert.equal(first.ids.length, 1);
  assert.equal(first.decisions[0].period, 'event:deploy:41');
  assert.equal((await inboxList(root))[0].ext.period, 'event:deploy:41');

  // The same id twice, an hour later and a day later, still opens nothing.
  assert.deepEqual((await openDue(root, SLOT_DAY, { eventName: 'deploy', eventId: 41 })).ids, []);

  const second = await openDue(root, NEXT_DAY, { eventName: 'deploy', eventId: 42 });
  assert.equal(second.ids.length, 1);
  assert.equal(second.decisions[0].period, 'event:deploy:42');
  assert.deepEqual((await openDue(root, NEXT_DAY, { eventName: 'deploy', eventId: 42 })).ids, []);
  assert.equal((await inboxList(root)).length, 2);

  await rm(root, { recursive: true, force: true });
});

test('templateSet renames the template and moves its order with it', async () => {
  const root = await seeded();
  const before = (await orderList(root))[0];

  const { template, order } = await templateSet(root, 'sweep', { name: 'nightly' });

  assert.equal(template.name, 'nightly');
  assert.match(order.origin, /nightly$/);
  const live = await orderList(root);
  assert.equal(live.length, 1);
  assert.notEqual(live[0].id, before.id);
  const history = await orderList(root, { activeOnly: false });
  assert.equal(history.filter((row) => row.origin === 'template:sweep')[0].active, false);
  assert.equal((await due(root, SLOT, {}))[0].name, 'nightly');
  assert.equal((await openDue(root, SLOT, {})).ids.length, 1);

  await assert.rejects(() => templateSet(root, 'sweep', { paused: true }), /unknown template/);
  await rm(root, { recursive: true, force: true });
});

test('a rename moves the open children, so the open-child guard still holds', async () => {
  const root = await seeded();
  const opened = await openDue(root, SLOT, {});
  assert.equal(opened.ids.length, 1);

  const { template, children } = await templateSet(root, 'sweep', { name: 'nightly' });

  assert.equal(template.name, 'nightly');
  assert.equal(children.length, 1);
  const [moved] = await inboxList(root);
  assert.equal(moved.ext.template, 'nightly');
  assert.equal(moved.status, 'pending');

  // The next day brings a new period, and the still-open child still blocks it.
  const decision = (await due(root, NEXT_DAY, {}))[0];
  assert.equal(decision.due, false);
  assert.equal(decision.action, 'skip');
  assert.match(decision.reason, /already open/);
  assert.deepEqual((await openDue(root, NEXT_DAY, {})).ids, []);

  // Consolidating it frees the template under its new name.
  await consolidate(root, moved.id);
  assert.equal((await due(root, NEXT_DAY, {}))[0].due, true);

  await rm(root, { recursive: true, force: true });
});