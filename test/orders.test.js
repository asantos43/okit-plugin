import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { orderAdd, orderLint, orderList, orderRemove, orderRender } from '../src/orders.js';
import { projectOrdersPath } from '../src/store.js';
import { writeJsonAtomic } from '../src/state.js';

const NOW = '2030-01-01T00:00:00.000Z';
const LATER = '2030-06-01T00:00:00.000Z';

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'orders-test-'));
}

// Must pass / must refuse table:
// | case                        | must pass                     | must refuse                  |
// | orderAdd default            | G1, scope all, active true   | -                            |
// | orderAdd bad text           | -                            | TypeError                    |
// | orderAdd until in the past  | -                            | TypeError                    |
// | orderAdd layer project      | O1 in the project file       | projectRoot missing          |
// | orderRemove without reason  | -                            | TypeError                    |
// | expiry at the injected now  | inactive after until         | listed before until          |

test('orderAdd defaults scope, layer, origin and active', async () => {
  const root = await tempRoot();

  const order = await orderAdd(root, { text: 'keep the docs in step with the code' });

  assert.match(order.id, /^G\d+$/);
  assert.equal(order.scope, 'all');
  assert.equal(order.layer, 'global');
  assert.equal(order.origin, 'maintainer');
  assert.equal(order.active, true);
  assert.equal(order.until, undefined);
  assert.equal(order.revokedAt, undefined);
  assert.equal(order.createdAt, new Date(order.createdAt).toISOString());

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

test('orderAdd refuses empty text, unknown scope, bad layer and a past until', async () => {
  const root = await tempRoot();

  await assert.rejects(() => orderAdd(root, { text: '' }), /text/);
  await assert.rejects(() => orderAdd(root, { text: '   ' }), /text/);
  await assert.rejects(() => orderAdd(root, {}), /text/);
  await assert.rejects(() => orderAdd(root, { text: 'x', scope: 'effort:giant' }), /scope/);
  await assert.rejects(() => orderAdd(root, { text: 'x', layer: 'team' }), /layer/);
  await assert.rejects(() => orderAdd(root, { text: 'x', layer: 'project' }), /projectRoot/);
  await assert.rejects(() => orderAdd(root, { text: 'x', until: 'tomorrow' }), /until must be a date/);
  await assert.rejects(() => orderAdd(root, { text: 'x', until: '2020-01-01T00:00:00.000Z' }), /until must be in the future/);
  await assert.rejects(() => orderAdd(root, { text: 'x', origin: 3 }), /origin/);

  await rm(root, { recursive: true, force: true });
});

test('orderAdd takes until in the future and keeps it', async () => {
  const root = await tempRoot();

  const order = await orderAdd(root, { text: 'x', until: LATER });

  assert.equal(order.until, LATER);
  await rm(root, { recursive: true, force: true });
});

test('orderAdd puts a project order in the project folder', async () => {
  const root = await tempRoot();
  const projectRoot = await tempRoot();

  const order = await orderAdd(root, { text: 'only here' }, { projectRoot });

  assert.match(order.id, /^O\d+$/);
  assert.equal(order.layer, 'project');
  assert.deepEqual(await orderList(root, {}, { projectRoot }), [order]);

  await rm(root, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
});

test('orderList merges both layers and the project order wins on the same text', async () => {
  const root = await tempRoot();
  const projectRoot = await tempRoot();

  const sharedGlobal = await orderAdd(root, { text: 'Shared text' });
  await orderAdd(root, { text: 'global only' });
  const sharedProject = await orderAdd(root, { text: 'shared text' }, { projectRoot });
  await orderAdd(root, { text: 'project only' }, { projectRoot });

  const merged = await orderList(root, {}, { projectRoot });

  // The global order keeps its place; the project one supplies the content.
  assert.deepEqual(merged.map((order) => order.text), [
    'shared text',
    'global only',
    'project only',
  ]);
  assert.equal(merged.filter((order) => order.text.toLowerCase() === 'shared text').length, 1);
  assert.equal(merged.find((order) => order.id === sharedProject.id).layer, 'project');
  assert.ok(!merged.some((order) => order.id === sharedGlobal.id));

  await rm(root, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
});

test('orderList lists project orders after the global ones', async () => {
  const root = await tempRoot();
  const projectRoot = await tempRoot();

  await orderAdd(root, { text: 'g1' });
  await orderAdd(root, { text: 'g2' });
  await orderAdd(root, { text: 'p1' }, { projectRoot });

  const merged = await orderList(root, {}, { projectRoot });

  assert.deepEqual(merged.map((order) => order.text), ['g1', 'g2', 'p1']);
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

test('orderRemove revokes a project order and refuses an unknown id', async () => {
  const root = await tempRoot();
  const projectRoot = await tempRoot();
  const order = await orderAdd(root, { text: 'project order' }, { projectRoot });

  await assert.rejects(() => orderRemove(root, 'O999999', { reason: 'nope' }), /unknown standing order/);

  const revoked = await orderRemove(root, order.id, { reason: 'moved' }, { projectRoot });
  assert.equal(revoked.active, false);
  assert.deepEqual(await orderList(root, {}, { projectRoot }), []);

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
  assert.equal(problems[0].layer, 'global');

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

test('orderLint finds a duplicate id across the layers', async () => {
  const root = await tempRoot();
  const projectRoot = await tempRoot();

  const global = await orderAdd(root, { text: 'one' });
  const project = await orderAdd(root, { text: 'two' }, { projectRoot });
  await writeJsonAtomic(projectOrdersPath(projectRoot), {
    version: 1,
    seq: Number(project.id.slice(1)),
    orders: [{ ...project, id: global.id }],
  });

  const problems = await orderLint(root, { projectRoot, now: NOW });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].code, 'duplicate-id');

  await rm(root, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
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
      id: 'O000002',
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
  assert.match(lines[3], /^- \*\*O000002\*\* \(2030-01-01T00:00:00.000Z\) second order — scope `effort:hard` — until 2030-06-01T00:00:00.000Z — revoked$/);
  assert.equal(lines.at(-1), '');
});

test('orderRender says so when there is nothing and refuses other input', () => {
  assert.match(orderRender([]), /^# Standing orders\n\nNone\.\n$/);
  assert.throws(() => orderRender('orders'), TypeError);
});