import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  evaluateDue,
  eventFires,
  isInWindow,
  nextRun,
  parseSchedule,
} from '../src/schedule.js';

const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());
const at = (text) => Date.parse(text);

test('parseSchedule reads every cron field form', () => {
  assert.deepEqual(parseSchedule('30 9 * * *').minute, [30]);
  assert.deepEqual(parseSchedule('30 9 * * *').hour, [9]);
  assert.deepEqual(parseSchedule('0,15,45 9 * * *').minute, [0, 15, 45]);
  assert.deepEqual(parseSchedule('0 9-11 * * *').hour, [9, 10, 11]);
  assert.deepEqual(parseSchedule('*/15 * * * *').minute, [0, 15, 30, 45]);
  assert.deepEqual(parseSchedule('1-30/5 * * * *').minute, [1, 6, 11, 16, 21, 26]);
  assert.deepEqual(parseSchedule('0 0 1 jan *').month, [1]);
  assert.deepEqual(parseSchedule('0 0 * dec *').month, [12]);
  assert.deepEqual(parseSchedule('0 0 1,15 * *').dayOfMonth, [1, 15]);
});

test('parseSchedule reads names and treats 0 and 7 as Sunday', () => {
  assert.deepEqual(parseSchedule('0 9 * jan-mar mon-fri').month, [1, 2, 3]);
  assert.deepEqual(parseSchedule('0 9 * * mon-fri').dayOfWeek, [1, 2, 3, 4, 5]);
  assert.deepEqual(parseSchedule('0 9 * * 0').dayOfWeek, [0]);
  assert.deepEqual(parseSchedule('0 9 * * 7').dayOfWeek, [0]);
  assert.deepEqual(parseSchedule('0 9 * * sun').dayOfWeek, [0]);
  assert.deepEqual(parseSchedule('0 9 * * SAT').dayOfWeek, [6]);
});

test('parseSchedule marks which day fields are restricted', () => {
  const free = parseSchedule('0 9 * * *');
  assert.equal(free.dayOfMonthRestricted, false);
  assert.equal(free.dayOfWeekRestricted, false);

  const both = parseSchedule('0 9 1 * 1');
  assert.equal(both.dayOfMonthRestricted, true);
  assert.equal(both.dayOfWeekRestricted, true);

  const one = parseSchedule('0 9 1 * *');
  assert.equal(one.dayOfMonthRestricted, true);
  assert.equal(one.dayOfWeekRestricted, false);
});

test('a day matches when either restricted day field matches', () => {
  const schedule = parseSchedule('0 9 1 * 1');
  const zone = { timeZone: 'UTC' };
  // 2024-06-03 is a Monday; 2024-06-10 is the next Monday.
  assert.equal(iso(nextRun(schedule, at('2024-06-03T08:00:00Z'), zone)), '2024-06-03T09:00:00.000Z');
  assert.equal(iso(nextRun(schedule, at('2024-06-03T10:00:00Z'), zone)), '2024-06-10T09:00:00.000Z');
  // 2024-06-07 is a Friday, so only the day-of-week half of the rule fires.
  assert.equal(iso(nextRun(parseSchedule('0 9 * * 1-5'), at('2024-06-07T10:00:00Z'), zone)), '2024-06-10T09:00:00.000Z');
});

test('a restricted day-of-month field decides on its own', () => {
  const zone = { timeZone: 'UTC' };
  const schedule = parseSchedule('0 9 15 * *');
  assert.equal(iso(nextRun(schedule, at('2024-06-01T00:00:00Z'), zone)), '2024-06-15T09:00:00.000Z');
  assert.equal(iso(nextRun(schedule, at('2024-06-15T09:00:00Z'), zone)), '2024-07-15T09:00:00.000Z');
});

test('parseSchedule reads the friendly forms', () => {
  assert.deepEqual(parseSchedule('daily 09:00'), { kind: 'daily', hour: 9, minute: 0 });
  assert.deepEqual(parseSchedule('weekly mon 18:00'), { kind: 'weekly', days: [1], hour: 18, minute: 0 });
  assert.deepEqual(parseSchedule('weekly sun 06:30'), { kind: 'weekly', days: [0], hour: 6, minute: 30 });
  assert.deepEqual(parseSchedule('monthly day 1 09:00'), { kind: 'monthly', day: 1, hour: 9, minute: 0 });
  assert.deepEqual(parseSchedule('monthly day 31 23:59'), { kind: 'monthly', day: 31, hour: 23, minute: 59 });
});

test('parseSchedule reads event forms and eventFires matches them', () => {
  assert.deepEqual(parseSchedule('after each merge'), { kind: 'event', event: 'merge' });
  assert.deepEqual(parseSchedule('after each release'), { kind: 'event', event: 'release' });
  assert.equal(eventFires(parseSchedule('after each merge'), 'merge'), true);
  assert.equal(eventFires(parseSchedule('after each merge'), 'MERGE'), true);
  assert.equal(eventFires(parseSchedule('after each merge'), 'release'), false);
  assert.equal(eventFires(parseSchedule('daily 09:00'), 'merge'), false);
});

test('parseSchedule rejects bad text and names the accepted forms', () => {
  const bad = [
    '',
    '   ',
    '0 9 * *',
    '0 9 * * * *',
    '60 * * * *',
    '* 24 * * *',
    '* * 32 * *',
    '* * * 13 *',
    '* * * * 8',
    '5-1 * * * *',
    '0 9 * * mon-fri,',
    'daily',
    'daily 24:00',
    'daily 9:00',
    'weekly',
    'weekly mon',
    'weekly mon 18:0',
    'monthly day 0 09:00',
    'monthly day 32 09:00',
    'monthly 1 09:00',
    'after',
    'after every merge',
    'after each',
  ];
  for (const text of bad) {
    assert.throws(() => parseSchedule(text), (error) => {
      assert.ok(error instanceof TypeError, `${text} should throw a TypeError`);
      assert.match(error.message, /Accepted forms/);
      assert.match(error.message, /5-field cron/);
      assert.match(error.message, /daily HH:MM/);
      assert.match(error.message, /weekly/);
      assert.match(error.message, /monthly day/);
      assert.match(error.message, /after each/);
      return true;
    });
  }
  assert.throws(() => parseSchedule(null), TypeError);
  assert.throws(() => parseSchedule(42), TypeError);
});

test('nextRun returns the first instant strictly after the reference', () => {
  const schedule = parseSchedule('daily 09:00');
  assert.equal(iso(nextRun(schedule, at('2024-06-03T08:59:59Z'))), '2024-06-03T09:00:00.000Z');
  assert.equal(iso(nextRun(schedule, at('2024-06-03T09:00:00Z'))), '2024-06-04T09:00:00.000Z');
  assert.equal(iso(nextRun(schedule, at('2024-06-03T23:59:59Z'))), '2024-06-04T09:00:00.000Z');
  assert.equal(nextRun(schedule, at('2024-06-03T09:00:00Z')) > at('2024-06-03T09:00:00Z'), true);
});

test('nextRun follows the wall clock of the zone', () => {
  assert.equal(
    iso(nextRun(parseSchedule('daily 09:00'), at('2024-06-01T00:00:00Z'), { timeZone: 'Asia/Kolkata' })),
    '2024-06-01T03:30:00.000Z',
  );
  assert.equal(
    iso(nextRun(parseSchedule('0 9 * * 1-5'), at('2024-06-07T12:00:00Z'), { timeZone: 'America/Sao_Paulo' })),
    '2024-06-10T12:00:00.000Z',
  );
  assert.equal(
    iso(nextRun(parseSchedule('daily 09:00'), at('2024-06-01T00:00:00Z'), { timeZone: 'UTC' })),
    '2024-06-01T09:00:00.000Z',
  );
});

test('a skipped hour moves to the next valid minute and runs once', () => {
  const zone = { timeZone: 'Europe/Berlin' };
  const schedule = parseSchedule('daily 02:30');
  // On 2024-03-31 Berlin jumps from 02:00 to 03:00, so 02:30 does not exist.
  assert.equal(iso(nextRun(schedule, at('2024-03-31T00:00:00Z'), zone)), '2024-03-31T01:00:00.000Z');
  assert.equal(iso(nextRun(schedule, at('2024-03-31T01:00:00Z'), zone)), '2024-04-01T00:30:00.000Z');
  // An hourly schedule sees the same gap without duplicating or losing a slot.
  const hourly = [];
  let cursor = at('2024-03-31T00:30:00Z');
  for (let step = 0; step < 4; step += 1) {
    cursor = nextRun(parseSchedule('0 * * * *'), cursor, zone);
    hourly.push(iso(cursor));
  }
  assert.deepEqual(hourly, [
    '2024-03-31T01:00:00.000Z',
    '2024-03-31T02:00:00.000Z',
    '2024-03-31T03:00:00.000Z',
    '2024-03-31T04:00:00.000Z',
  ]);
});

test('a repeated hour runs once, on its first pass', () => {
  const zone = { timeZone: 'Europe/Berlin' };
  const schedule = parseSchedule('daily 02:30');
  // On 2024-10-27 Berlin repeats 02:00 to 03:00, so 02:30 happens twice.
  assert.equal(iso(nextRun(schedule, at('2024-10-27T00:00:00Z'), zone)), '2024-10-27T00:30:00.000Z');
  assert.equal(iso(nextRun(schedule, at('2024-10-27T00:30:00Z'), zone)), '2024-10-28T01:30:00.000Z');
});

test('monthly day 31 uses the last day of a shorter month', () => {
  const zone = { timeZone: 'UTC' };
  const schedule = parseSchedule('monthly day 31 09:00');
  assert.equal(iso(nextRun(schedule, at('2024-01-01T00:00:00Z'), zone)), '2024-01-31T09:00:00.000Z');
  assert.equal(iso(nextRun(schedule, at('2024-01-31T09:00:00Z'), zone)), '2024-02-29T09:00:00.000Z');
  assert.equal(iso(nextRun(schedule, at('2024-02-29T09:00:00Z'), zone)), '2024-03-31T09:00:00.000Z');
  // 2027 February has no 31st, so it runs on its 28th.
  assert.equal(iso(nextRun(schedule, at('2027-01-31T09:00:00Z'), zone)), '2027-02-28T09:00:00.000Z');
});

test('nextRun gives up inside the search bound and never fires an event', () => {
  assert.equal(nextRun(parseSchedule('0 0 30 2 *'), at('2024-01-01T00:00:00Z')), null);
  assert.equal(nextRun(parseSchedule('after each merge'), at('2024-01-01T00:00:00Z')), null);
});

test('isInWindow accepts any window, edges and midnight crossing', () => {
  const zone = { timeZone: 'UTC' };
  assert.equal(isInWindow(undefined, at('2024-06-03T03:00:00Z'), zone), true);
  assert.equal(isInWindow(null, at('2024-06-03T03:00:00Z'), zone), true);
  assert.equal(isInWindow({ from: '09:00', to: '17:00' }, at('2024-06-03T08:59:00Z'), zone), false);
  assert.equal(isInWindow({ from: '09:00', to: '17:00' }, at('2024-06-03T09:00:00Z'), zone), true);
  assert.equal(isInWindow({ from: '09:00', to: '17:00' }, at('2024-06-03T16:59:00Z'), zone), true);
  assert.equal(isInWindow({ from: '09:00', to: '17:00' }, at('2024-06-03T17:00:00Z'), zone), false);
  assert.equal(isInWindow({ from: '09:00', to: '17:00' }, at('2024-06-04T08:00:00Z'), zone), false);
  // A window that crosses midnight keeps the night open.
  assert.equal(isInWindow({ from: '22:00', to: '06:00' }, at('2024-06-03T23:30:00Z'), zone), true);
  assert.equal(isInWindow({ from: '22:00', to: '06:00' }, at('2024-06-04T02:00:00Z'), zone), true);
  assert.equal(isInWindow({ from: '22:00', to: '06:00' }, at('2024-06-04T06:00:00Z'), zone), false);
  assert.equal(isInWindow({ from: '22:00', to: '06:00' }, at('2024-06-04T12:00:00Z'), zone), false);
  // The zone decides the wall clock, not the offset of the reference.
  assert.equal(
    isInWindow({ from: '09:00', to: '17:00' }, at('2024-06-03T03:30:00Z'), { timeZone: 'Asia/Kolkata' }),
    true,
  );
  assert.throws(() => isInWindow({ from: '9:00', to: '17:00' }, at('2024-06-03T03:00:00Z')), TypeError);
  assert.throws(() => isInWindow({ from: '09:00' }, at('2024-06-03T03:00:00Z')), TypeError);
});

const daily = { schedule: 'daily 09:00', timeZone: 'UTC' };
const morning = at('2024-06-03T09:30:00Z');

test('evaluateDue runs a fresh template in its current period', () => {
  const due = evaluateDue(daily, morning, {});
  assert.deepEqual(due, {
    due: true,
    action: 'run',
    reason: 'the slot is due and every guard allows it',
    period: '2024-06-03T09:00:00.000Z',
  });
});

test('evaluateDue skips a paused schedule', () => {
  const due = evaluateDue({ ...daily, paused: true }, morning, {});
  assert.equal(due.due, false);
  assert.equal(due.action, 'skip');
  assert.match(due.reason, /paused/);
});

test('evaluateDue defers while the next slot is in the future', () => {
  const before = evaluateDue(daily, at('2024-06-03T08:30:00Z'), {});
  assert.equal(before.due, false);
  assert.equal(before.action, 'defer');
  assert.equal(before.period, null);

  const already = evaluateDue({ ...daily, lastRun: at('2024-06-03T09:00:00Z') }, morning, {});
  assert.equal(already.due, false);
  assert.equal(already.action, 'defer');
  assert.equal(already.period, null);
  assert.match(already.reason, /already ran/);
});

test('evaluateDue defers outside the window', () => {
  const template = { ...daily, window: { from: '10:00', to: '18:00' } };
  const due = evaluateDue(template, morning, {});
  assert.equal(due.due, false);
  assert.equal(due.action, 'defer');
  assert.equal(due.period, '2024-06-03T09:00:00.000Z');
  assert.match(due.reason, /window/);
  assert.equal(evaluateDue(template, at('2024-06-03T11:00:00Z'), {}).action, 'run');
});

test('evaluateDue defers on a low quota but never on an unknown one', () => {
  const template = { ...daily, minQuotaPct: 40 };
  const low = evaluateDue(template, morning, { quotaPct: 10 });
  assert.equal(low.due, false);
  assert.equal(low.action, 'defer');
  assert.equal(low.period, '2024-06-03T09:00:00.000Z');
  assert.match(low.reason, /quota/);
  assert.equal(evaluateDue(template, morning, { quotaPct: 40 }).action, 'run');
  assert.equal(evaluateDue(template, morning, { quotaPct: 90 }).action, 'run');
  assert.equal(evaluateDue(template, morning, {}).action, 'run');
});

test('evaluateDue defers while the client is busy and onlyWhenIdle is set', () => {
  const template = { ...daily, onlyWhenIdle: true };
  const busy = evaluateDue(template, morning, { idle: false });
  assert.equal(busy.due, false);
  assert.equal(busy.action, 'defer');
  assert.equal(busy.period, '2024-06-03T09:00:00.000Z');
  assert.match(busy.reason, /idle/);
  assert.equal(evaluateDue(template, morning, { idle: true }).action, 'run');
  assert.equal(evaluateDue(template, morning, {}).action, 'run');
  assert.equal(evaluateDue(daily, morning, { idle: false }).action, 'run');
});

test('evaluateDue skips while a child of the template is open', () => {
  const open = evaluateDue(daily, morning, { openChild: { id: 'child-1' } });
  assert.equal(open.due, false);
  assert.equal(open.action, 'skip');
  assert.equal(open.period, '2024-06-03T09:00:00.000Z');
  assert.match(open.reason, /already open/);
  assert.equal(evaluateDue({ ...daily, skipIfOpen: false }, morning, { openChild: { id: 'x' } }).action, 'run');
});

test('evaluateDue skips once maxRunsPerPeriod is reached', () => {
  const template = { ...daily, maxRunsPerPeriod: 2 };
  const full = evaluateDue(template, morning, { runsThisPeriod: 2 });
  assert.equal(full.due, false);
  assert.equal(full.action, 'skip');
  assert.equal(full.period, '2024-06-03T09:00:00.000Z');
  assert.match(full.reason, /maximum number of runs/);
  assert.equal(evaluateDue(template, morning, { runsThisPeriod: 1 }).action, 'run');
  assert.equal(evaluateDue(template, morning, {}).action, 'run');
});

test('a long gap either catches up or skips the missed slots', () => {
  const lastRun = at('2024-06-01T09:00:00Z');
  const run = evaluateDue({ ...daily, lastRun }, morning, {});
  assert.equal(run.action, 'run');
  assert.equal(run.period, '2024-06-02T09:00:00.000Z');

  const skip = evaluateDue({ ...daily, lastRun, catchup: 'skip' }, morning, {});
  assert.equal(skip.action, 'run');
  assert.equal(skip.period, '2024-06-03T09:00:00.000Z');

  // A single missed slot is the current one either way.
  const single = evaluateDue({ ...daily, lastRun: at('2024-06-02T09:00:00Z') }, morning, {});
  assert.equal(single.action, 'run');
  assert.equal(single.period, '2024-06-03T09:00:00.000Z');
  const singleSkip = evaluateDue(
    { ...daily, lastRun: at('2024-06-02T09:00:00Z'), catchup: 'skip' },
    morning,
    {},
  );
  assert.equal(singleSkip.action, 'run');
  assert.equal(singleSkip.period, '2024-06-03T09:00:00.000Z');
});

test('the period is stable, so the same slot never runs twice', () => {
  const template = { ...daily, lastRun: at('2024-06-02T09:00:00Z') };
  const first = evaluateDue(template, morning, {});
  const second = evaluateDue(template, morning, {});
  assert.equal(first.period, second.period);
  assert.equal(first.period, '2024-06-03T09:00:00.000Z');

  // After the run, lastRun moves to that period and the slot is spent.
  const afterRun = evaluateDue({ ...daily, lastRun: at(first.period) }, morning, {});
  assert.equal(afterRun.due, false);
  assert.equal(afterRun.period, null);
  const next = evaluateDue({ ...daily, lastRun: at(first.period) }, at('2024-06-04T09:30:00Z'), {});
  assert.equal(next.action, 'run');
  assert.equal(next.period, '2024-06-04T09:00:00.000Z');
});

test('a clock that jumps back never yields a period before lastRun', () => {
  const lastRun = at('2024-06-05T09:00:00Z');
  // The clock slips back two days: there is no slot to run any more.
  const backwards = evaluateDue({ ...daily, lastRun }, at('2024-06-03T09:30:00Z'), {});
  assert.equal(backwards.due, false);
  assert.equal(backwards.period, null);

  // Back at the period it already ran, the slot stays spent.
  const samePeriod = evaluateDue({ ...daily, lastRun }, at('2024-06-05T09:30:00Z'), {});
  assert.equal(samePeriod.due, false);
  assert.equal(samePeriod.period, null);

  // Once the clock moves past lastRun again, the period moves with it.
  const forward = evaluateDue({ ...daily, lastRun }, at('2024-06-06T09:30:00Z'), {});
  assert.equal(forward.action, 'run');
  assert.equal(forward.period, '2024-06-06T09:00:00.000Z');
  assert.equal(forward.period >= new Date(lastRun).toISOString(), true);
});

test('evaluateDue waits for the event of an event schedule', () => {
  const schedule = { schedule: 'after each merge' };
  const fired = evaluateDue(schedule, morning, { eventName: 'merge' });
  assert.equal(fired.due, true);
  assert.equal(fired.action, 'run');
  assert.equal(fired.period, 'event:merge');
  assert.equal(evaluateDue(schedule, morning, { eventName: 'merge', eventId: 7 }).period, 'event:merge:7');

  const other = evaluateDue(schedule, morning, { eventName: 'release' });
  assert.equal(other.due, false);
  assert.equal(other.action, 'defer');
  assert.equal(evaluateDue(schedule, morning, {}).action, 'defer');
  assert.equal(nextRun(parseSchedule(schedule.schedule), morning), null);
});

test('evaluateDue reads a parsed schedule as well as a string', () => {
  const parsed = { schedule: parseSchedule('daily 09:00'), timeZone: 'UTC' };
  assert.equal(evaluateDue(parsed, morning, {}).period, '2024-06-03T09:00:00.000Z');
});

test('a schedule built by hand is refused with a clear error', () => {
  assert.throws(() => nextRun({ kind: 'cron' }, morning), TypeError);
  assert.throws(() => nextRun(null, morning), TypeError);
  assert.throws(() => evaluateDue({ schedule: { kind: 'weekly' } }, morning, {}), TypeError);
  assert.throws(() => evaluateDue({}, morning, {}), TypeError);
});